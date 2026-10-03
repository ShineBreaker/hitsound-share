// /api/admin/admins：管理员名单维护。仅超级管理员（ADMIN_OSU_ID 环境变量）。
// GET 列名单（users.is_admin = 1）；POST { user } 授——按 osu! ID（全数字）或用户名
// （大小写不敏感）匹配已登录过本站的用户；DELETE { osu_id } 撤（幂等）。
// 名单外用户拿管理员权限的唯一途径是被授予；超级管理员不可经此端点移除（其权限在 env）。
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireSuperAdmin } from '$lib/server/guard';
import { findUserByIdent, listAdmins, setAdmin } from '$lib/server/admin';

export const GET: RequestHandler = async ({ request, platform, cookies }) => {
	const g = await requireSuperAdmin(platform, cookies, request);
	if (g instanceof Response) return g;
	return json({ admins: await listAdmins(g.env.DB) });
};

export const POST: RequestHandler = async ({ request, platform, cookies }) => {
	const g = await requireSuperAdmin(platform, cookies, request);
	if (g instanceof Response) return g;

	const body = (await request.json().catch(() => null)) as { user?: unknown } | null;
	if (typeof body?.user !== 'string' || body.user.trim() === '' || body.user.length > 100) {
		return json({ error: 'bad_user' }, { status: 400 });
	}
	const u = await findUserByIdent(g.env.DB, body.user);
	if (!u) return json({ error: 'user_not_found' }, { status: 404 });

	if (u.is_admin !== 1) await setAdmin(g.env.DB, u.osu_id, true);
	return json({
		ok: true,
		admin: { osu_id: u.osu_id, username: u.username, avatar_url: u.avatar_url }
	});
};

export const DELETE: RequestHandler = async ({ request, platform, cookies }) => {
	const g = await requireSuperAdmin(platform, cookies, request);
	if (g instanceof Response) return g;

	const body = (await request.json().catch(() => null)) as { osu_id?: unknown } | null;
	if (typeof body?.osu_id !== 'number' || !Number.isInteger(body.osu_id) || body.osu_id <= 0) {
		return json({ error: 'bad_user' }, { status: 400 });
	}
	await setAdmin(g.env.DB, body.osu_id, false);
	return json({ ok: true });
};
