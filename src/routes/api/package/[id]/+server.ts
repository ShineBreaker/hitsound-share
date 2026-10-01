// /api/package/<id>：包治理——PATCH 改名 / DELETE 删除（上传者本人的包 / 管理员任意，ADMIN_OSU_ID）。
// DELETE：单事务对齐 refcount → 级联删 files/package → RETURNING 归零 blobs；R2 批量删对象
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePackageOwner } from '$lib/server/guard';
import { releasePackage, settleAll } from '$lib/server/ledger';
import { isAdmin } from '$lib/server/admin';

/**
 * PATCH：包改名（大类改名）。影子 pending 包不可改名（其名称随合并丢弃）。
 * body 可选 merge=true：新名撞上其他 visible 包时不改名，而是把本包整体并入该包
 * （与 done 附加合并同构：三重去重 → files 迁移 → 目标计数重算 → 删被并包，末了补清
 * 被并包的 legacy original.zip）
 */
export const PATCH: RequestHandler = async ({ params, request, platform, cookies }) => {
	const g = await requirePackageOwner(platform, cookies, params.id);
	if (g instanceof Response) return g;

	const body = (await request.json().catch(() => null)) as { name?: unknown; merge?: unknown } | null;
	if (typeof body?.name !== 'string' || body.name.length < 1 || body.name.length > 100) {
		return json({ error: 'bad_name' }, { status: 400 });
	}
	if (g.pkg.append_to !== null) return json({ error: 'appending_in_progress' }, { status: 400 });

	// 同名目标：ORDER BY 不带 COLLATE = 字节序（大小写敏感）取最早创建者——有意口径，
	// 包名比较全程大小写敏感。改回原名且无他包同名时查不到行，走下方普通 UPDATE（无害 no-op）
	const target = await g.env.DB.prepare(
		`SELECT id, uploader_osu_id, append_to FROM packages
		 WHERE name = ?1 AND status = 'visible' AND id <> ?2
		 ORDER BY created_at, id LIMIT 1`
	)
		.bind(body.name, g.pkg.id)
		.first<{ id: string; uploader_osu_id: number | null; append_to: string | null }>();

	if (!target) {
		await g.env.DB.prepare('UPDATE packages SET name = ?1 WHERE id = ?2')
			.bind(body.name, g.pkg.id)
			.run();
		return json({ ok: true });
	}
	if (body.merge !== true) return json({ error: 'name_taken', targetId: target.id }, { status: 409 });

	// 目标包权限单独判（requirePackageOwner 只覆盖被改名包）；append_to 非空的 visible 行
	// 是 done 合并中断的孤儿，不可作合并目标
	if (
		target.uploader_osu_id !== g.session.osuId &&
		!(await isAdmin(g.env.DB, g.secrets, g.session.osuId))
	) {
		return json({ error: 'merge_target_forbidden' }, { status: 403 });
	}
	if (target.append_to !== null) return json({ error: 'merge_target_invalid' }, { status: 409 });

	let batchRes;
	try {
		batchRes = await g.env.DB.batch([
			// 与目标包三重复制（同路径同名同内容）的行直接丢弃
			g.env.DB.prepare(
				`DELETE FROM files WHERE package_id = ?1 AND EXISTS (
				   SELECT 1 FROM files t
				   WHERE t.package_id = ?2
				     AND t.folder_path = files.folder_path
				     AND t.name = files.name
				     AND t.blob_hash = files.blob_hash)
				 RETURNING id`
			).bind(g.pkg.id, target.id),
			// 余下条目整体迁移进目标包
			g.env.DB.prepare('UPDATE files SET package_id = ?1 WHERE package_id = ?2').bind(
				target.id,
				g.pkg.id
			),
			// 目标包计数按迁移后的 files 重算（不增量累加，天然幂等）
			g.env.DB.prepare(
				`UPDATE packages SET
				   file_count = (SELECT COUNT(*) FROM files WHERE package_id = ?1),
				   logical_size = (SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE package_id = ?1)
				 WHERE id = ?1`
			).bind(target.id),
			// 被并包行退出（files 已迁空，无级联损失）
			g.env.DB.prepare('DELETE FROM packages WHERE id = ?1').bind(g.pkg.id)
		]);
	} catch {
		// 目标包并发被删/被并：迁移 UPDATE 的 FK 违例令 batch 原子回滚（无中间态），
		// settleAll 尚未执行无需补偿，转确定性的 409
		return json({ error: 'merge_target_gone' }, { status: 409 });
	}

	// 去重只减引用不归零：被丢行必有同 hash 孪生行存活于目标包（EXISTS 命中即证明），
	// 构造上无 blob 可归零——只对齐 refcount，不跑 RECLAIM / R2 删除
	await settleAll(g.env.DB);

	// v4 前历史包可能残留 legacy original.zip（R2 key 与 releasePackage 同口径）：合并不走
	// releasePackage，purge-zips 又只清点现存包行——被并包行删除后该对象再无人认领，这里
	// 补清一次。R2 delete 对不存在的 key 是幂等 no-op，恒定 1 子请求
	await g.env.HITSOUND_FILES.delete(`packages/${g.pkg.id}/original.zip`);

	const deduped = ((batchRes[0]?.results ?? []) as Array<{ id: string }>).map((r) => r.id);
	return json({ ok: true, merged: true, targetId: target.id, deduped });
};

export const DELETE: RequestHandler = async ({ params, platform, cookies }) => {
	const g = await requirePackageOwner(platform, cookies, params.id);
	if (g instanceof Response) return g;

	await releasePackage(g.env, g.pkg.id);
	return json({ ok: true });
};
