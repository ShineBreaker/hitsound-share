// POST /api/upload/done：闭环核验后置 visible 并对齐 refcount。
// blob 清单从 D1（该包 files 行 join blobs 账本）自取，不信前端。
// 核验（子请求预算：免费计划单请求上限 50，大包 2400+ blob 必须批量）：
//   - 已核验在库（refcount > 0）的 blob 不打 R2：只比「声明大小 vs 账本大小」；
//   - 新 blob（refcount ≤ 0）走 verifyFreshBlobs：小集合逐 blob ranged GET，
//     大集合 list 前缀分页比大小 + 前 16 个魔数抽查（详见 lib/server/verify.ts）。
// refcount 落账用「绝对对齐」（= 全库 visible 包引用数）：全表单语句重算——
// 幂等、可自愈历史偏差；行写浪费（全库 blob 数）换子请求预算（分片 UPDATE 会各占一次）。
// 附加模式（append_to 非空的影子包）：核验通过后事务性合并进目标包——
// 去重三重复制行 → files 迁移 → 目标包计数重算 → 删影子包。合并批次失败可重放
// done 自愈（影子包已 visible 时跳过核验直接重试合并）；目标失效则就地回收影子包
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/guard';
import { settleAll, releasePackage } from '$lib/server/ledger';
import { verifyFreshBlobs } from '$lib/server/verify';
import { AUDIO_EXTS, type AudioExt } from '$lib/server/upload';

interface BlobAgg {
	hash: string;
	ext: AudioExt;
	size: number; // 期望字节数（同 hash 同内容同大小，取 MAX）
	ledger_size: number; // 账本登记大小
	refcount: number;
}

export const POST: RequestHandler = async ({ request, platform, cookies }) => {
	const g = await requireUser(platform, cookies);
	if (g instanceof Response) return g;
	const env = g.env;
	const session = g.session;

	const body = (await request.json().catch(() => null)) as { packageId?: unknown } | null;
	if (!body || typeof body.packageId !== 'string') {
		return json({ error: 'bad_body' }, { status: 400 });
	}

	// 包必须属于当前用户；pending 走核验，visible 允许重放（跳核验，幂等对齐/重试合并）
	const pkg = await env.DB.prepare(
		'SELECT id, uploader_osu_id, status, append_to FROM packages WHERE id = ?1'
	)
		.bind(body.packageId)
		.first<{ id: string; uploader_osu_id: number | null; status: string; append_to: string | null }>();
	if (!pkg || pkg.uploader_osu_id !== session.osuId || !['pending', 'visible'].includes(pkg.status)) {
		return json({ error: 'package_not_found' }, { status: 404 });
	}

	// 从 files 行 join 账本聚合 blob 清单（核验的 hash 列表 + 账本参照值）
	const { results: aggRows } = await env.DB.prepare(
		`SELECT f.blob_hash AS hash, MIN(f.format) AS ext, MAX(f.size_bytes) AS size,
		        b.size AS ledger_size, b.refcount AS refcount
		 FROM files f JOIN blobs b ON b.hash = f.blob_hash
		 WHERE f.package_id = ?1 GROUP BY f.blob_hash`
	)
		.bind(pkg.id)
		.all<{ hash: string; ext: string; size: number; ledger_size: number; refcount: number }>();
	const blobs = (aggRows ?? []).filter(
		(r): r is BlobAgg => /^[0-9a-f]{64}$/.test(r.hash) && AUDIO_EXTS.includes(r.ext as AudioExt)
	);

	if (pkg.status === 'pending') {
		const bad: string[] = [];
		// 已核验在库的（refcount > 0）：只对比账本登记大小，不打 R2
		for (const b of blobs) {
			if (b.refcount > 0 && b.size !== b.ledger_size) bad.push(b.hash);
		}
		// 新 blob（refcount ≤ 0）：R2 实侧核验（存在 + 大小 + 魔数）
		const fresh = blobs.filter((b) => b.refcount <= 0);
		bad.push(...(await verifyFreshBlobs(env.HITSOUND_FILES, fresh)));
		if (bad.length > 0) return json({ error: 'blob_mismatch', bad }, { status: 400 });

		// 置 visible（重放无害——条件限定 pending 抢占，防并发双翻转窗口）
		await env.DB.prepare(
			`UPDATE packages SET status = 'visible', size_bytes = 0
			 WHERE id = ?1 AND status = 'pending'`
		)
			.bind(pkg.id)
			.run();
	}

	// 合并段：影子包并入目标包（原子的单 batch；失败重放 done 时上面跳过核验直达此处）
	if (pkg.append_to !== null) {
		const target = await env.DB.prepare(`SELECT id, status, append_to FROM packages WHERE id = ?1`)
			.bind(pkg.append_to)
			.first<{ id: string; status: string; append_to: string | null }>();
		if (!target || target.status !== 'visible' || target.append_to !== null) {
			// 目标已失效（如上传期间被删）：就地回收影子包，不留不可见不可管理的孤儿
			// （懒清理对 append_to 残留另有 24h 兜底）
			await releasePackage(env, pkg.id);
			return json({ error: 'append_target_invalid' }, { status: 409 });
		}

		await env.DB.batch([
			// 与目标包三重复制（同路径同名同内容）的影子行直接丢弃（重复附加幂等）
			env.DB.prepare(
				`DELETE FROM files WHERE package_id = ?1 AND EXISTS (
				   SELECT 1 FROM files t
				   WHERE t.package_id = ?2
				     AND t.folder_path = files.folder_path
				     AND t.name = files.name
				     AND t.blob_hash = files.blob_hash)`
			).bind(pkg.id, target.id),
			// 余下条目整体迁移进目标包
			env.DB.prepare('UPDATE files SET package_id = ?1 WHERE package_id = ?2').bind(
				target.id,
				pkg.id
			),
			// 目标包计数按迁移后的 files 重算（不增量累加，天然幂等）
			env.DB.prepare(
				`UPDATE packages SET
				   file_count = (SELECT COUNT(*) FROM files WHERE package_id = ?1),
				   logical_size = (SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE package_id = ?1)
				 WHERE id = ?1`
			).bind(target.id),
			// 影子包行退出（files 已迁空，无级联损失）
			env.DB.prepare('DELETE FROM packages WHERE id = ?1').bind(pkg.id)
		]);
	}

	// refcount 全表绝对对齐（幂等：= 全库 visible 包引用数；单语句省子请求，行写浪费可接受）
	await settleAll(env.DB);

	return json({ ok: true });
};
