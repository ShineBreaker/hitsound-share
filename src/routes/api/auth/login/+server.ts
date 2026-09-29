// /api/auth/login：302 跳 osu! 授权页（identify scope），带随机 state 防 CSRF
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecrets } from '$lib/server/env';
import { OSU_ORIGIN } from '$lib/server/osu';
import { randomHex } from '$lib/server/session';

export const GET: RequestHandler = async ({ url, platform, cookies }) => {
	const secrets = getSecrets(platform);
	if (!secrets.OSU_CLIENT_ID || !secrets.OSU_CLIENT_SECRET || !secrets.SESSION_SECRET) {
		return new Response('OAuth not configured', { status: 503 });
	}

	// state 双提交：cookie 与授权请求各一份，callback 比对
	const state = randomHex(16);
	cookies.set('hs_oauth_state', state, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		maxAge: 600
	});

	const redirectUri = secrets.OSU_REDIRECT_URI ?? new URL('/api/auth/callback', url.origin).href;
	const authorize = new URL('/oauth/authorize', OSU_ORIGIN);
	authorize.searchParams.set('client_id', secrets.OSU_CLIENT_ID);
	authorize.searchParams.set('redirect_uri', redirectUri);
	authorize.searchParams.set('response_type', 'code');
	authorize.searchParams.set('scope', 'identify');
	authorize.searchParams.set('state', state);
	redirect(302, authorize.toString());
};
