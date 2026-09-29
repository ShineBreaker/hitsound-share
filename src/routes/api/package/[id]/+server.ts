// /api/package/<id>：包治理——PATCH 改名 / DELETE 删除（上传者本人的包 / 管理员任意，ADMIN_OSU_ID）。
// DELETE：单事务对齐 refcount → 级联删 files/package → RETURNING 归零 blobs；R2 批量删对象
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePackageOwner } from '$lib/server/guard';
import { releasePackage } from '$lib/server/ledger';

/** PATCH：包改名（大类改名）。影子 pending 包不可改名（其名称随合并丢弃） */
export const PATCH: RequestHandler = async ({ params, request, platform, cookies }) => {
	const g = await requirePackageOwner(platform, cookies, params.id);
	if (g instanceof Response) return g;

	const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
	if (typeof body?.name !== 'string' || body.name.length < 1 || body.name.length > 100) {
		return json({ error: 'bad_name' }, { status: 400 });
	}
	if (g.pkg.append_to !== null) return json({ error: 'appending_in_progress' }, { status: 400 });

	await g.env.DB.prepare('UPDATE packages SET name = ?1 WHERE id = ?2')
		.bind(body.name, g.pkg.id)
		.run();
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, platform, cookies }) => {
	const g = await requirePackageOwner(platform, cookies, params.id);
	if (g instanceof Response) return g;

	await releasePackage(g.env, g.pkg.id);
	return json({ ok: true });
};
