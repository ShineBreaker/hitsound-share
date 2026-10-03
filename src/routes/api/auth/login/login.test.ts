// /api/auth/login：state 携带前端来源尾段（白名单 origin）+ 授权请求参数推导。
// ?hs_origin= query 优先、Origin 头兜底，均须 ∈ CORS_ORIGINS；未命中 = 纯 hex 同源现状
import { describe, it, expect } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import { GET } from './+server';

const CLIENT_ID = 'cid-1';
const CORS_ORIGIN = 'https://app.example.com';

function b64urlEncode(text: string): string {
	let bin = '';
	for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text: string): string {
	const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
	return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

interface CookieSet {
	name: string;
	value: string;
	opts: Record<string, unknown>;
}

interface LoginResult {
	res: Response | null;
	location: URL | null;
	cookie: CookieSet | null;
}

interface LoginOpts {
	origin?: string;
	corsOrigins?: string;
	redirectUri?: string;
}

async function callLogin(path: string, opts: LoginOpts = {}): Promise<LoginResult> {
	const headers: Record<string, string> = {};
	if (opts.origin) headers.origin = opts.origin;
	const env: Record<string, string | undefined> = {
		OSU_CLIENT_ID: CLIENT_ID,
		OSU_CLIENT_SECRET: 'secret-1',
		SESSION_SECRET: 'session-secret',
		CORS_ORIGINS: opts.corsOrigins
	};
	if (opts.redirectUri) env.OSU_REDIRECT_URI = opts.redirectUri;
	const sets: CookieSet[] = [];
	let res: Response | null = null;
	try {
		res = await GET({
			url: new URL(`https://api.local${path}`),
			request: new Request(`https://api.local${path}`, { headers }),
			platform: { env },
			cookies: { set: (name, value, o) => sets.push({ name, value, opts: o }) }
		} as unknown as Parameters<typeof GET>[0]);
	} catch (e) {
		if (!isRedirect(e)) throw e;
		return { res: null, location: new URL(e.location), cookie: sets[0] ?? null };
	}
	return { res, location: null, cookie: sets[0] ?? null };
}

function stateOf(r: LoginResult): string {
	return r.location!.searchParams.get('state')!;
}

describe('state 携带前端来源（白名单 origin 命中）', () => {
	it('?hs_origin= 命中 → state = <hex32>.<b64url(origin)>，cookie 存完整值且 sameSite none', async () => {
		const r = await callLogin(`/api/auth/login?hs_origin=${encodeURIComponent(CORS_ORIGIN)}`, {
			corsOrigins: CORS_ORIGIN
		});
		const state = stateOf(r);
		const dot = state.indexOf('.');
		expect(dot).toBe(32); // 前段 = randomHex(16) → 32 个 hex 字符
		expect(b64urlDecode(state.slice(dot + 1))).toBe(CORS_ORIGIN);
		expect(r.cookie!.name).toBe('hs_oauth_state');
		expect(r.cookie!.value).toBe(state); // cookie 存完整 state，callback 比对逻辑不变
		expect(r.cookie!.opts.sameSite).toBe('none');
	});

	it('Origin 头命中白名单（无 query）→ 同效', async () => {
		const r = await callLogin('/api/auth/login', { corsOrigins: CORS_ORIGIN, origin: CORS_ORIGIN });
		const state = stateOf(r);
		expect(state.indexOf('.')).toBe(32);
		expect(b64urlDecode(state.slice(33))).toBe(CORS_ORIGIN);
		expect(r.cookie!.opts.sameSite).toBe('none');
	});

	it('query 非白名单 + Origin 头白名单 → 退化用 Origin 头（query 失效的兜底轨）', async () => {
		const r = await callLogin('/api/auth/login?hs_origin=https://evil.example.com', {
			corsOrigins: CORS_ORIGIN,
			origin: CORS_ORIGIN
		});
		const state = stateOf(r);
		expect(b64urlDecode(state.slice(33))).toBe(CORS_ORIGIN);
	});

	it('白名单比较小写化：配置大写、query 小写 → 命中且尾段为小写规范化值', async () => {
		const r = await callLogin(`/api/auth/login?hs_origin=${encodeURIComponent(CORS_ORIGIN)}`, {
			corsOrigins: 'https://APP.example.com'
		});
		const state = stateOf(r);
		expect(b64urlDecode(state.slice(33))).toBe(CORS_ORIGIN);
	});
});

describe('未命中 / 未配置 = 同源现状（纯 hex state + lax）', () => {
	it('无 query 无 Origin 头 → 纯 hex state、sameSite lax', async () => {
		const r = await callLogin('/api/auth/login', { corsOrigins: CORS_ORIGIN });
		const state = stateOf(r);
		expect(state).toMatch(/^[0-9a-f]{32}$/);
		expect(state).toBe(r.cookie!.value);
		expect(r.cookie!.opts.sameSite).toBe('lax');
	});

	it('非白名单 query 且无 Origin 头 → 纯 hex + lax', async () => {
		const r = await callLogin('/api/auth/login?hs_origin=https://evil.example.com', {
			corsOrigins: CORS_ORIGIN
		});
		expect(stateOf(r)).toMatch(/^[0-9a-f]{32}$/);
		expect(r.cookie!.opts.sameSite).toBe('lax');
	});

	it('未配 CORS_ORIGINS：带白名单样式的 hs_origin 也不采用（白名单空 = 不启用）', async () => {
		const r = await callLogin(`/api/auth/login?hs_origin=${encodeURIComponent(CORS_ORIGIN)}`);
		expect(stateOf(r)).toMatch(/^[0-9a-f]{32}$/);
		expect(r.cookie!.opts.sameSite).toBe('lax');
	});
});

describe('授权请求参数（redirect_uri 推导不变）', () => {
	it('默认按 API 域推导：请求打到 API 域，url.origin 即回调域', async () => {
		const r = await callLogin('/api/auth/login');
		expect(r.location!.origin).toBe('https://osu.ppy.sh');
		expect(r.location!.pathname).toBe('/oauth/authorize');
		expect(r.location!.searchParams.get('client_id')).toBe(CLIENT_ID);
		expect(r.location!.searchParams.get('response_type')).toBe('code');
		expect(r.location!.searchParams.get('scope')).toBe('identify');
		expect(r.location!.searchParams.get('redirect_uri')).toBe('https://api.local/api/auth/callback');
	});

	it('OSU_REDIRECT_URI 显式覆盖', async () => {
		const r = await callLogin('/api/auth/login', { redirectUri: 'https://custom.example.org/cb' });
		expect(r.location!.searchParams.get('redirect_uri')).toBe('https://custom.example.org/cb');
	});

	it('OAuth 未配置 → 503（现状锁定）', async () => {
		const res = await GET({
			url: new URL('https://api.local/api/auth/login'),
			request: new Request('https://api.local/api/auth/login'),
			platform: { env: {} },
			cookies: { set: () => {} }
		} as unknown as Parameters<typeof GET>[0]);
		expect(res.status).toBe(503);
	});
});
