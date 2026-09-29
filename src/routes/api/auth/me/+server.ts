// /api/auth/me：当前登录态（顶栏显示用；不暴露 cookie 内容本身）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecrets } from '$lib/server/env';
import { verifySession, SESSION_COOKIE } from '$lib/server/session';

export const GET: RequestHandler = async ({ cookies, platform }) => {
	const secrets = getSecrets(platform);
	if (!secrets.SESSION_SECRET) return json({ loggedIn: false });

	const user = await verifySession(cookies.get(SESSION_COOKIE), secrets.SESSION_SECRET);
	if (!user) return json({ loggedIn: false });

	return json({
		loggedIn: true,
		username: user.username,
		avatarUrl: user.avatarUrl,
		osuId: user.osuId
	});
};
