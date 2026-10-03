// /api/auth/callback：授权码换 token → GET api/v2/me → users upsert → 签 HMAC cookie。
// 服务端出网仅 https://osu.ppy.sh（osuFetch 白名单）；token 用完即弃不落日志。
// state 含白名单 origin 尾段（login 编入）时，会话签 SameSite=None 并 302 回前端域
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecrets } from '$lib/server/env';
import { parseCorsOrigins } from '$lib/server/cors';
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

const td = new TextDecoder();

/** state 尾段解出前端 origin（小写规范化）；无尾段 / 坏 b64url / 非白名单一律 null
 *  （按无尾段处理，走同源现状分支——攻击者伪造尾段拿不到 None 会话与外域跳转） */
function frontOriginFromState(state: string, origins: Set<string>): string | null {
	const dot = state.indexOf('.');
	if (dot === -1) return null;
	try {
		const b64 = state.slice(dot + 1).replace(/-/g, '+').replace(/_/g, '/');
		const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
		const origin = td
			.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
			.toLowerCase();
		return origins.has(origin) ? origin : null;
	} catch {
		return null;
	}
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
	let redirectTarget = '/'; // 同源现状：302 落 API 域根

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

		// 4. 签发 session cookie（HttpOnly，前端拿不到内容）；
		//    白名单前端来源（state 尾段，login 编入）→ SameSite=None 供跨源 fetch 携带
		const frontOrigin = frontOriginFromState(state, parseCorsOrigins(secrets.CORS_ORIGINS));
		const value = await signSession(
			{ osuId: me.id, username: me.username, avatarUrl: me.avatar_url ?? null },
			secrets.SESSION_SECRET
		);
		cookies.set(SESSION_COOKIE, value, {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: frontOrigin ? 'none' : 'lax',
			maxAge: SESSION_MAX_AGE_S
		});

		redirectTarget = frontOrigin ? `${frontOrigin}/` : '/';
	} catch {
		return new Response('OAuth callback failed', { status: 502 });
	}

	redirect(302, redirectTarget);
};
