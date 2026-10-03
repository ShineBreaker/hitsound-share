// /api/auth/callback：state 尾段白名单 origin → hs_session SameSite=None + 302 前端域/；
// 无尾段 / 坏尾段 / 非白名单 → lax + '/' 同源现状。osu! 出网走全局 fetch stub
// （osuFetch 的 host 白名单校验照跑，只替换外部网络边界）；D1 用 node:sqlite adapter
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import { createTestD1, type TestD1 } from '../../../../test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from '../../../../test/r2-memory';
import { SESSION_COOKIE } from '$lib/server/session';
import { GET } from './+server';

const SECRET = 'callback-test-secret';
const CORS_ORIGIN = 'https://app.example.com';
const OSU_ID = 4242;
const OSU_USER = 'player-1';
const HEX = 'ab'.repeat(16); // randomHex(16) 同长的固定前段（callback 只比对全等）

function b64url(text: string): string {
	let bin = '';
	for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let d1: TestD1;
let r2: MemoryR2;
let tokenBodies: { redirect_uri: string }[];

beforeEach(() => {
	d1 = createTestD1();
	r2 = createMemoryR2();
	tokenBodies = [];
	vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input.toString();
		if (url === 'https://osu.ppy.sh/oauth/token') {
			tokenBodies.push(JSON.parse(init?.body as string));
			return new Response(JSON.stringify({ access_token: 'atk-1' }), { status: 200 });
		}
		if (url === 'https://osu.ppy.sh/api/v2/me') {
			return new Response(
				JSON.stringify({ id: OSU_ID, username: OSU_USER, avatar_url: null }),
				{ status: 200 }
			);
		}
		return new Response(`unexpected fetch: ${url}`, { status: 500 });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

interface CookieSet {
	name: string;
	value: string;
	opts: Record<string, unknown>;
}

interface CallbackResult {
	res: Response | null;
	status: number;
	location: string;
	sets: CookieSet[];
	deleted: string[];
}

interface CallbackOpts {
	corsOrigins?: string;
	redirectUri?: string;
	/** 覆盖 query 里的 state（默认与 cookie 一致）；测 CSRF 不一致用 */
	queryState?: string;
}

async function callCallback(
	cookieState: string,
	opts: CallbackOpts = {}
): Promise<CallbackResult> {
	const env: Record<string, unknown> = {
		OSU_CLIENT_ID: 'cid-1',
		OSU_CLIENT_SECRET: 'cs-1',
		SESSION_SECRET: SECRET,
		DB: d1.db,
		HITSOUND_FILES: r2.bucket
	};
	if (opts.corsOrigins !== undefined) env.CORS_ORIGINS = opts.corsOrigins;
	if (opts.redirectUri) env.OSU_REDIRECT_URI = opts.redirectUri;
	const queryState = opts.queryState ?? cookieState;
	const url = new URL(
		`https://api.local/api/auth/callback?code=auth-code&state=${encodeURIComponent(queryState)}`
	);
	const sets: CookieSet[] = [];
	const deleted: string[] = [];
	try {
		const res = await GET({
			url,
			platform: { env },
			cookies: {
				get: (n: string) => (n === 'hs_oauth_state' ? cookieState : undefined),
				set: (name: string, value: string, o: Record<string, unknown>) =>
					sets.push({ name, value, opts: o }),
				delete: (n: string) => deleted.push(n)
			}
		} as unknown as Parameters<typeof GET>[0]);
		return { res, status: res.status, location: '', sets, deleted };
	} catch (e) {
		if (!isRedirect(e)) throw e;
		return { res: null, status: e.status, location: e.location, sets, deleted };
	}
}

function sessionCookie(r: CallbackResult): CookieSet {
	return r.sets.find((c) => c.name === SESSION_COOKIE)!;
}

describe('跨源会话签发（state 尾段 = 白名单 origin）', () => {
	it('SameSite=None + 302 到 <前端域>/；users upsert 生效', async () => {
		const r = await callCallback(`${HEX}.${b64url(CORS_ORIGIN)}`, { corsOrigins: CORS_ORIGIN });
		expect(r.status).toBe(302);
		expect(r.location).toBe(`${CORS_ORIGIN}/`);
		expect(sessionCookie(r).opts.sameSite).toBe('none');
		const row = await d1.db
			.prepare('SELECT username FROM users WHERE osu_id = ?1')
			.bind(OSU_ID)
			.first<{ username: string }>();
		expect(row?.username).toBe(OSU_USER);
	});

	it('尾段大写 origin + 白名单小写配置 → 命中（小写规范化比较）', async () => {
		const r = await callCallback(`${HEX}.${b64url('https://APP.example.com')}`, {
			corsOrigins: CORS_ORIGIN
		});
		expect(r.status).toBe(302);
		expect(r.location).toBe(`${CORS_ORIGIN}/`);
	});

	it('白名单多值（逗号分隔）第二项同样命中', async () => {
		const other = 'https://alt.example.net';
		const r = await callCallback(`${HEX}.${b64url(other)}`, {
			corsOrigins: `${CORS_ORIGIN},${other}`
		});
		expect(r.location).toBe(`${other}/`);
		expect(sessionCookie(r).opts.sameSite).toBe('none');
	});
});

describe('同源现状分支（lax + 302 /）', () => {
	it('纯 hex state（无尾段）→ lax + /', async () => {
		const r = await callCallback(HEX, { corsOrigins: CORS_ORIGIN });
		expect(r.status).toBe(302);
		expect(r.location).toBe('/');
		expect(sessionCookie(r).opts.sameSite).toBe('lax');
	});

	it('尾段非白名单 origin → 按无尾段处理（不给 None 会话与外域跳转）', async () => {
		const r = await callCallback(`${HEX}.${b64url('https://evil.example.com')}`, {
			corsOrigins: CORS_ORIGIN
		});
		expect(r.status).toBe(302);
		expect(r.location).toBe('/');
		expect(sessionCookie(r).opts.sameSite).toBe('lax');
	});

	it('尾段坏 b64url → 按无尾段处理', async () => {
		const r = await callCallback(`${HEX}.!!!not-base64!!!`, { corsOrigins: CORS_ORIGIN });
		expect(r.status).toBe(302);
		expect(r.location).toBe('/');
		expect(sessionCookie(r).opts.sameSite).toBe('lax');
	});

	it('未配 CORS_ORIGINS：即使尾段是合法 origin 也不命中（白名单空 = 不启用）', async () => {
		const r = await callCallback(`${HEX}.${b64url(CORS_ORIGIN)}`);
		expect(r.location).toBe('/');
		expect(sessionCookie(r).opts.sameSite).toBe('lax');
	});
});

describe('CSRF 与 redirect_uri（现状锁定）', () => {
	it('state 与 cookie 不一致 → 400 Bad state，不触发出网', async () => {
		const r = await callCallback(HEX, { queryState: 'cd'.repeat(16), corsOrigins: CORS_ORIGIN });
		expect(r.res!.status).toBe(400);
		expect(tokenBodies.length).toBe(0);
		expect(r.deleted).toContain('hs_oauth_state'); // 一次性 cookie，比对前即删
	});

	it('redirect_uri 默认按 API 域推导（token 请求体断言）', async () => {
		await callCallback(HEX, { corsOrigins: CORS_ORIGIN });
		expect(tokenBodies[0].redirect_uri).toBe('https://api.local/api/auth/callback');
	});

	it('OSU_REDIRECT_URI 显式覆盖', async () => {
		await callCallback(HEX, { redirectUri: 'https://custom.example.org/cb' });
		expect(tokenBodies[0].redirect_uri).toBe('https://custom.example.org/cb');
	});
});
