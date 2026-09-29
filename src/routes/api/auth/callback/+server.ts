// /api/auth/callback：授权码换 token → GET api/v2/me → users upsert → 签 HMAC cookie。
// 服务端出网仅 https://osu.ppy.sh（osuFetch 白名单）；token 用完即弃不落日志
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecrets } from '$lib/server/env';
import { getEnv } from '$lib/server/media';
import { osuFetch } from '$lib/server/osu';
import { SESSION_COOKIE, SESSION_MAX_AGE_S, signSession } from '$lib/server/session';

interface OsuToken {
	access_token?: string;
}

interface OsuMe {
	id?: number;
	username?: string;
	avatar_url?: string | null;
}

export const GET: RequestHandler = async ({ url, platform, cookies }) => {
	const secrets = getSecrets(platform);
	const env = getEnv(platform);
	if (!secrets.OSU_CLIENT_ID || !secrets.OSU_CLIENT_SECRET || !secrets.SESSION_SECRET || !env) {
		return new Response('OAuth not configured', { status: 503 });
	}

	// CSRF：state 必须与 cookie 一致
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const cookieState = cookies.get('hs_oauth_state');
	cookies.delete('hs_oauth_state', { path: '/' });
	if (!code || !state || !cookieState || state !== cookieState) {
		return new Response('Bad state', { status: 400 });
	}

	const redirectUri = secrets.OSU_REDIRECT_URI ?? new URL('/api/auth/callback', url.origin).href;

	try {
		// 1. 授权码换 access token
		const tokenRes = await osuFetch('/oauth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_id: secrets.OSU_CLIENT_ID,
				client_secret: secrets.OSU_CLIENT_SECRET,
				code,
				grant_type: 'authorization_code',
				redirect_uri: redirectUri
			})
		});
		if (!tokenRes.ok) return new Response('Token exchange failed', { status: 502 });
		const token = (await tokenRes.json()) as OsuToken;
		if (!token.access_token) return new Response('Token exchange failed', { status: 502 });

		// 2. 取当前用户（identify）
		const meRes = await osuFetch('/api/v2/me', {
			headers: { Authorization: `Bearer ${token.access_token}` }
		});
		if (!meRes.ok) return new Response('Failed to fetch user', { status: 502 });
		const me = (await meRes.json()) as OsuMe;
		if (typeof me.id !== 'number' || typeof me.username !== 'string') {
			return new Response('Invalid user payload', { status: 502 });
		}

		// 3. users upsert（全部参数绑定）
		await env.DB.prepare(
			`INSERT INTO users (osu_id, username, avatar_url)
			 VALUES (?1, ?2, ?3)
			 ON CONFLICT(osu_id) DO UPDATE SET username = excluded.username, avatar_url = excluded.avatar_url`
		)
			.bind(me.id, me.username, me.avatar_url ?? null)
			.run();

		// 4. 签发 session cookie（HttpOnly，前端拿不到内容）
		const value = await signSession(
			{ osuId: me.id, username: me.username, avatarUrl: me.avatar_url ?? null },
			secrets.SESSION_SECRET
		);
		cookies.set(SESSION_COOKIE, value, {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			maxAge: SESSION_MAX_AGE_S
		});
	} catch {
		return new Response('OAuth callback failed', { status: 502 });
	}

	redirect(302, '/');
};
