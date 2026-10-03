// /api/auth/login：302 跳 osu! 授权页（identify scope），带随机 state 防 CSRF。
// 跨源前端经 ?hs_origin= query 声明来源（loginUrl() 拼入，不依赖「跨源 GET 顶层导航
// 携带 Origin 头」这一非规范浏览器行为），请求 Origin 头兜底，均须命中 CORS 白名单；
// 命中时 state = <randomHex(16)>.<b64url(origin)>，callback 据此把会话签回前端域
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecrets } from '$lib/server/env';
import { isAllowedOrigin, parseCorsOrigins } from '$lib/server/cors';
import { OSU_ORIGIN } from '$lib/server/osu';
import { randomHex } from '$lib/server/session';

const te = new TextEncoder();

function b64url(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 前端来源 origin（小写规范化）：?hs_origin= query 优先（query 失效退化 Origin 头），
 *  两者都须 ∈ CORS 白名单；未配置白名单恒 null（纯 hex state 同源现状） */
function pickClientOrigin(origins: Set<string>, url: URL, request: Request): string | null {
	if (origins.size === 0) return null;
	const fromQuery = url.searchParams.get('hs_origin');
	if (fromQuery && origins.has(fromQuery.toLowerCase())) return fromQuery.toLowerCase();
	return isAllowedOrigin(origins, request)?.toLowerCase() ?? null;
}

export const GET: RequestHandler = async ({ url, request, platform, cookies }) => {
	const secrets = getSecrets(platform);
	if (!secrets.OSU_CLIENT_ID || !secrets.OSU_CLIENT_SECRET || !secrets.SESSION_SECRET) {
		return new Response('OAuth not configured', { status: 503 });
	}

	// state 双提交：cookie 与授权请求各一份（完整 state），callback 比对逻辑不变
	const clientOrigin = pickClientOrigin(parseCorsOrigins(secrets.CORS_ORIGINS), url, request);
	const state = clientOrigin
		? `${randomHex(16)}.${b64url(te.encode(clientOrigin))}`
		: randomHex(16);
	cookies.set('hs_oauth_state', state, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: clientOrigin ? 'none' : 'lax',
		maxAge: 600
	});

	// redirect_uri 推导不变：请求打到 API 域，url.origin 即 API 域（跨源调用下依然正确）
	const redirectUri = secrets.OSU_REDIRECT_URI ?? new URL('/api/auth/callback', url.origin).href;
	const authorize = new URL('/oauth/authorize', OSU_ORIGIN);
	authorize.searchParams.set('client_id', secrets.OSU_CLIENT_ID);
	authorize.searchParams.set('redirect_uri', redirectUri);
	authorize.searchParams.set('response_type', 'code');
	authorize.searchParams.set('scope', 'identify');
	authorize.searchParams.set('state', state);
	redirect(302, authorize.toString());
};
