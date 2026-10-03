// /api/auth/me：当前登录态（顶栏显示用；不暴露 cookie 内容本身）。
// 凭证双轨：cookie 优先、x-hs-session 头兜底（桌面端无可靠 cookie，token 存 localStorage）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecrets } from '$lib/server/env';
import { isAdmin, isSuperAdmin } from '$lib/server/admin';
import { getEnv } from '$lib/server/media';
import { readSession, SESSION_COOKIE, SESSION_HEADER } from '$lib/server/session';

export const GET: RequestHandler = async ({ cookies, request, platform }) => {
	const secrets = getSecrets(platform);
	if (!secrets.SESSION_SECRET) return json({ loggedIn: false });

	const user = await readSession(
		cookies.get(SESSION_COOKIE),
		request.headers.get(SESSION_HEADER),
		secrets.SESSION_SECRET
	);
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
