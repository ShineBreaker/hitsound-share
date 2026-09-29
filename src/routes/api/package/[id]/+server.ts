// /api/package/<id>：包治理——PATCH 改名 / DELETE 删除（上传者本人的包 / 管理员任意，ADMIN_OSU_ID）。
// DELETE：D1：decrement refcount → 删包（级联 files）→ 清归零 blobs 行；R2：删归零 blob + zip
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePackageOwner, purgePackage } from '$lib/server/packages';

/** PATCH：包改名（大类改名）。影子 pending 包不可改名（其名称随合并丢弃） */
export const PATCH: RequestHandler = async ({ params, request, platform, cookies }) => {
	const guard = await requirePackageOwner(platform, cookies, params.id);
	if ('error' in guard) return json({ error: guard.error }, { status: guard.status });

	const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
	if (typeof body?.name !== 'string' || body.name.length < 1 || body.name.length > 100) {
		return json({ error: 'bad_name' }, { status: 400 });
	}
	if (guard.pkg.append_to !== null) return json({ error: 'appending_in_progress' }, { status: 400 });

	await guard.env.DB.prepare('UPDATE packages SET name = ?1 WHERE id = ?2')
		.bind(body.name, guard.pkg.id)
		.run();
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, platform, cookies }) => {
	const guard = await requirePackageOwner(platform, cookies, params.id);
	if ('error' in guard) return json({ error: guard.error }, { status: guard.status });

	const result = await purgePackage(guard.env, guard.pkg.id);
	if (!result.ok) return json({ error: result.error }, { status: 500 });
	return json({ ok: true });
};
