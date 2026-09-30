// /api/auth/me：当前登录态（顶栏显示用；不暴露 cookie 内容本身）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecrets } from '$lib/server/env';
import { isAdmin, isSuperAdmin } from '$lib/server/admin';
import { getEnv } from '$lib/server/media';
import { verifySession, SESSION_COOKIE } from '$lib/server/session';

export const GET: RequestHandler = async ({ cookies, platform }) => {
	const secrets = getSecrets(platform);
	if (!secrets.SESSION_SECRET) return json({ loggedIn: false });

	const user = await verifySession(cookies.get(SESSION_COOKIE), secrets.SESSION_SECRET);
	if (!user) return json({ loggedIn: false });

	// isAdmin 含 users.is_admin 库查询；无 bindings 时退回超管判定
	const env = getEnv(platform);
	const admin = env
		? await isAdmin(env.DB, secrets, user.osuId)
		: isSuperAdmin(secrets, user.osuId);

	return json({
		loggedIn: true,
		username: user.username,
		avatarUrl: user.avatarUrl,
		osuId: user.osuId,
		isAdmin: admin, // 树/包上操作钮的显示依据
		isSuperAdmin: isSuperAdmin(secrets, user.osuId) // 管理员名单入口的显示依据
	});
};
