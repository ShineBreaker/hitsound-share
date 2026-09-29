// POST /api/upload/done：闭环核验后置 visible 并对齐 refcount。
// blob 清单从 D1（该包 files 行）自取，不信前端。
// 核验（子请求预算：免费计划单请求上限 50，大包 2400+ blob 必须批量）：
//   1) R2 list 前缀分页（1000 对象/次）全量比对实际大小；
//   2) 首 16 字节魔数（RIFF/OggS/ID3|帧同步）仅抽查前 24 个新 blob（纵深防御的降级取舍）。
// refcount 落账用「绝对对齐」（= 全库 visible 包引用数）：全表单语句重算——
// 幂等、可自愈历史偏差；行写浪费（全库 blob 数）换子请求预算（分片 UPDATE 会各占一次）。
// 附加模式（append_to 非空的影子包）：核验通过后事务性合并进目标包——
// 去重三重复制行 → files 迁移 → 目标包计数重算 → 删影子包。合并批次失败可重放
// done 自愈（影子包已 visible 时跳过核验直接重试合并）；目标失效则就地回收影子包
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv, blobKey } from '$lib/server/media';
import { getSecrets } from '$lib/server/env';
import { verifySession, SESSION_COOKIE } from '$lib/server/session';
import { ALIGN_ALL_REFCOUNT_SQL, purgePackage } from '$lib/server/packages';
import { magicOk, type AudioExt } from '$lib/server/upload';

interface BlobAgg {
	hash: string;
	ext: AudioExt;
	size: number; // 期望字节数（同 hash 同内容同大小，取 MAX）
}

/** 魔数抽查额度：done 总子请求 ≈ 2 次查询 + list 分页 + 24 抽查 + 若干写，留足余量 */
const MAGIC_CHECK_N = 24;

/** 并发池：控制同时核验的 blob 数（IO 等待不占 CPU，但避免一次打满 R2 连接） */
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) await fn(items[next++]);
	});
	await Promise.all(workers);
}

export const POST: RequestHandler = async ({ request, platform, cookies }) => {
	const env = getEnv(platform);
	const secrets = getSecrets(platform);
	if (!env || !secrets.SESSION_SECRET) return json({ error: 'service_unavailable' }, { status: 503 });

	const session = await verifySession(cookies.get(SESSION_COOKIE), secrets.SESSION_SECRET);
	if (!session) return json({ error: 'not_logged_in' }, { status: 401 });

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

	// 从 files 行聚合 blob 清单（核验与对齐的 hash 列表）
	const { results: aggRows } = await env.DB.prepare(
		`SELECT blob_hash AS hash, MIN(format) AS ext, MAX(size_bytes) AS size
		 FROM files WHERE package_id = ?1 GROUP BY blob_hash`
	)
		.bind(pkg.id)
		.all<{ hash: string; ext: string; size: number }>();
	const blobs = (aggRows ?? []).filter(
		(r): r is BlobAgg => /^[0-9a-f]{64}$/.test(r.hash) && ['wav', 'ogg', 'mp3'].includes(r.ext)
	);

	if (pkg.status === 'pending') {
		// 1) R2 list 前缀分页（1000 对象/次子请求）：全量比对每个 blob 的实际大小
		const r2Sizes = new Map<string, number>();
		let cursor: string | undefined;
		do {
			const page = await env.HITSOUND_FILES.list({ prefix: 'blobs/', cursor, limit: 1000 });
			for (const obj of page.objects) {
				const m = obj.key.match(/^blobs\/[0-9a-f]{2}\/([0-9a-f]{64})\.(wav|ogg|mp3)$/);
				if (m) r2Sizes.set(m[1], obj.size); // 同 hash 多扩展名 key 同内容同大小，覆盖无害
			}
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
		const bad = blobs.filter((b) => r2Sizes.get(b.hash) !== b.size).map((b) => b.hash);
		if (bad.length > 0) return json({ error: 'blob_mismatch', bad }, { status: 400 });

		// 2) 魔数抽查：前 N 个 blob 读首 16 字节验证扩展名（预算内尽力而为）
		const magicBad: string[] = [];
		await mapPool(blobs.slice(0, MAGIC_CHECK_N), MAGIC_CHECK_N, async (b) => {
			const obj = await env.HITSOUND_FILES.get(blobKey(b.hash, b.ext), {
				range: { offset: 0, length: 16 }
			});
			if (!obj) {
				magicBad.push(b.hash);
				return;
			}
			// R2 body 是 ReadableStream：经 Response 聚合后读首字节
			const head16 = new Uint8Array(await new Response(obj.body).arrayBuffer());
			if (!magicOk(b.ext, head16)) magicBad.push(b.hash);
		});
		if (magicBad.length > 0) return json({ error: 'blob_mismatch', bad: magicBad }, { status: 400 });

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
			await purgePackage(env, pkg.id);
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
	await env.DB.prepare(ALIGN_ALL_REFCOUNT_SQL).run();

	return json({ ok: true });
};
