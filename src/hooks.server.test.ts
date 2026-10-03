// hooks.server 统一拦截：门启用且未解锁 → 401 site_locked；白名单、非 API 路径、门未启用放行；
// CORS_ORIGINS 白名单命中 → OPTIONS 预检 204 / 响应（含门 401 拒绝）注入 Access-Control-* 头；
// 门凭证三源择一（cookie ?? x-hs-gate 头 ?? ?hs_gate= query，cookie 优先）
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestD1, type TestD1 } from './test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from './test/r2-memory';
import { handle } from './hooks.server';
import { withCorsHeaders } from './lib/server/cors';
import {
	GATE_COOKIE,
	issueUnlockValue,
	getGateState,
	setGatePassword
} from './lib/server/site-gate';

const INIT_PW = 'init-pass-1';
const CORS_ORIGIN = 'https://app.example.com';

let d1: TestD1;
let r2: MemoryR2;

beforeEach(() => {
	d1 = createTestD1();
	r2 = createMemoryR2();
});

interface CallOpts {
	cookie?: string;
	/** x-hs-gate 头（跨源 Web / 桌面 token 轨） */
	gateHeader?: string;
	/** 模拟环境变量 SITE_DEFAULT_PASSWORD；undefined = 未配置（门未启用） */
	defaultPw?: string;
	/** 模拟环境变量 CORS_ORIGINS（逗号分隔 origin 白名单）；undefined = 未配置（不启用 CORS） */
	corsOrigins?: string;
	/** 请求方法（默认 GET） */
	method?: string;
	/** 请求 Origin 头 */
	origin?: string;
	withBindings?: boolean; // 默认 true
}

async function call(path: string, opts: CallOpts = {}): Promise<Response> {
	const withBindings = opts.withBindings ?? true;
	const headers: Record<string, string> = {};
	if (opts.origin) headers.origin = opts.origin;
	if (opts.gateHeader) headers['x-hs-gate'] = opts.gateHeader;
	return handle({
		event: {
			url: new URL(`https://t.local${path}`),
			request: new Request(`https://t.local${path}`, {
				method: opts.method ?? 'GET',
				headers: Object.keys(headers).length ? headers : undefined
			}),
			platform: withBindings
				? ({
						env: {
							DB: d1.db,
							HITSOUND_FILES: r2.bucket,
							SITE_DEFAULT_PASSWORD: opts.defaultPw,
							CORS_ORIGINS: opts.corsOrigins
						}
					} as never)
				: undefined,
			cookies: { get: (n: string) => (n === GATE_COOKIE ? opts.cookie : undefined) } as never
		} as never,
		resolve: async () => new Response('ok')
	});
}

/** 用初始密码（环境变量形态）签发解锁值——cookie 值与 header/query token 同构 */
async function unlockToken(): Promise<string> {
	const state = await getGateState(d1.db, INIT_PW);
	return issueUnlockValue(state.hash!);
}

describe('站点密码门拦截', () => {
	it('门启用未解锁：/api/* 与 /f/* 一律 401 site_locked', async () => {
		for (const path of ['/api/tree', '/api/files?pkg=x', '/api/blob/ab/cd.wav', '/f/uuid/download']) {
			const res = await call(path, { defaultPw: INIT_PW });
			expect(res.status, path).toBe(401);
			expect(((await res.json()) as { error: string }).error).toBe('site_locked');
		}
	});

	it('解锁 cookie 有效 → 放行到端点', async () => {
		const res = await call('/api/tree', { defaultPw: INIT_PW, cookie: await unlockToken() });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
	});

	it('门未启用（未配初始密码且无库记录）→ 不拦，站点行为同旧版', async () => {
		for (const path of ['/api/tree', '/f/x/download']) {
			const res = await call(path);
			expect(res.status, path).toBe(200);
		}
	});

	it('管理员设过密码后，即使未配环境变量门也启用（库记录优先）', async () => {
		await setGatePassword(d1.db, 'rotated-pass');
		expect((await call('/api/tree')).status).toBe(401); // 无 env，但库里有记录
	});

	it('白名单（解锁端点自身 + config）无需解锁即可访问', async () => {
		for (const path of ['/api/site-gate', '/api/config']) {
			const res = await call(path, { defaultPw: INIT_PW });
			expect(res.status, path).toBe(200);
		}
	});

	it('非数据路径（页面 / 静态资产）不拦', async () => {
		for (const path of ['/', '/favicon.png', '/api', '/foo']) {
			const res = await call(path, { defaultPw: INIT_PW });
			expect(res.status, path).toBe(200);
		}
	});

	it('无 bindings（构建期/未部署）→ 放行交由端点自行 503', async () => {
		const res = await call('/api/tree', { defaultPw: INIT_PW, withBindings: false });
		expect(res.status).toBe(200);
	});

	it('改密后旧 cookie 失效（重新 401）', async () => {
		const old = await unlockToken();
		expect((await call('/api/tree', { defaultPw: INIT_PW, cookie: old })).status).toBe(200);
		await setGatePassword(d1.db, 'rotated-pass');
		expect((await call('/api/tree', { defaultPw: INIT_PW, cookie: old })).status).toBe(401);
	});
});

describe('门三源凭证（cookie ?? x-hs-gate ?? ?hs_gate=）', () => {
	it('x-hs-gate 有效 token → 过门（跨源 Web / 桌面 token 轨）', async () => {
		const res = await call('/api/tree', { defaultPw: INIT_PW, gateHeader: await unlockToken() });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
	});

	it('?hs_gate= 有效 token → /f/ 路径过门（Audio.src 无法带 header）', async () => {
		const token = await unlockToken();
		const res = await call(`/f/some-id?hs_gate=${encodeURIComponent(token)}`, {
			defaultPw: INIT_PW
		});
		expect(res.status).toBe(200);
	});

	it('cookie 优先：cookie 存在时 header 不参与（同源 Web 行为零回归）', async () => {
		const good = await unlockToken();
		// cookie 有效 + header 错值 → 过门（cookie 优先）
		expect(
			(await call('/api/tree', { defaultPw: INIT_PW, cookie: good, gateHeader: 'fp.bogus' }))
				.status
		).toBe(200);
		// cookie 错值 + header 有效 → 仍 401（header 不覆盖 cookie）
		expect(
			(await call('/api/tree', { defaultPw: INIT_PW, cookie: 'fp.bogus', gateHeader: good }))
				.status
		).toBe(401);
	});

	it('header 错值 → 401 site_locked 且带 CORS 头（跨源 fetch 错误码可读）', async () => {
		const res = await call('/api/tree', {
			defaultPw: INIT_PW,
			gateHeader: 'deadbeef.bogussig',
			corsOrigins: CORS_ORIGIN,
			origin: CORS_ORIGIN
		});
		expect(res.status).toBe(401);
		expect(((await res.json()) as { error: string }).error).toBe('site_locked');
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe(CORS_ORIGIN);
	});

	it('改密后旧 header token 失效（HMAC 密钥 = 当前密码 hash）', async () => {
		const old = await unlockToken();
		expect((await call('/api/tree', { defaultPw: INIT_PW, gateHeader: old })).status).toBe(200);
		await setGatePassword(d1.db, 'rotated-pass');
		expect((await call('/api/tree', { defaultPw: INIT_PW, gateHeader: old })).status).toBe(401);
	});

	it('门判定子请求数不增：三源凭证下仍只 1 条 settings 主键 SELECT', async () => {
		const token = await unlockToken(); // 签发侧 1 条查询，不计入门判定
		const before = d1.calls;
		await call('/api/tree', { defaultPw: INIT_PW, gateHeader: token });
		expect(d1.calls - before).toBe(1);
	});
});

describe('CORS 跨源白名单', () => {
	it('未配白名单：带 Origin 头的请求也不注入任何 Access-Control 头（零行为变化）', async () => {
		for (const res of [
			await call('/api/tree', {
				defaultPw: INIT_PW,
				cookie: await unlockToken(),
				origin: CORS_ORIGIN
			}), // 放行路径
			await call('/api/tree', { defaultPw: INIT_PW, origin: CORS_ORIGIN }) // 门 401 路径
		]) {
			expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
		}
	});

	it('OPTIONS + 白名单 origin → 204 全套预检头（门启用未解锁也放行：预检先于门判定）', async () => {
		const res = await call('/api/tree', {
			method: 'OPTIONS',
			defaultPw: INIT_PW,
			corsOrigins: CORS_ORIGIN,
			origin: CORS_ORIGIN
		});
		expect(res.status).toBe(204);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe(CORS_ORIGIN);
		expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
		expect(res.headers.get('Access-Control-Allow-Methods')).toBe(
			'GET, POST, PUT, PATCH, DELETE, OPTIONS'
		);
		expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, x-hs-gate');
		expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
	});

	it('OPTIONS 预检在 GATE_ALLOWED 早退之前：/api/config 的 OPTIONS 同样 204（而非落到端点）', async () => {
		const res = await call('/api/config', {
			method: 'OPTIONS',
			defaultPw: INIT_PW,
			corsOrigins: CORS_ORIGIN,
			origin: CORS_ORIGIN
		});
		expect(res.status).toBe(204);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe(CORS_ORIGIN);
	});

	it('非白名单 origin 的 OPTIONS → 不放行：落门 401 site_locked 且无 CORS 头', async () => {
		const res = await call('/api/tree', {
			method: 'OPTIONS',
			defaultPw: INIT_PW,
			corsOrigins: CORS_ORIGIN,
			origin: 'https://evil.example.com'
		});
		expect(res.status).toBe(401);
		expect(((await res.json()) as { error: string }).error).toBe('site_locked');
		expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
	});

	it('GET 命中：Allow-Origin 回显请求值 + Allow-Credentials + Vary: Origin', async () => {
		const res = await call('/api/tree', {
			defaultPw: INIT_PW,
			cookie: await unlockToken(),
			corsOrigins: CORS_ORIGIN,
			origin: CORS_ORIGIN
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe(CORS_ORIGIN);
		expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
		expect(res.headers.get('Vary')).toBe('Origin');
	});

	it('门 401 拒绝响应同样带 CORS 头（跨源 fetch 错误码可读而非 TypeError）', async () => {
		const res = await call('/api/tree', {
			defaultPw: INIT_PW,
			corsOrigins: CORS_ORIGIN,
			origin: CORS_ORIGIN
		});
		expect(res.status).toBe(401);
		expect(((await res.json()) as { error: string }).error).toBe('site_locked');
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe(CORS_ORIGIN);
	});

	it('白名单比较大小写不敏感：配置大写、请求小写仍命中，回显请求原值', async () => {
		const res = await call('/api/tree', {
			defaultPw: INIT_PW,
			corsOrigins: 'https://APP.example.com',
			origin: CORS_ORIGIN
		});
		expect(res.status).toBe(401); // 门拒绝，借 Allow-Origin 断言命中
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe(CORS_ORIGIN);
	});

	it('withCorsHeaders：已有 Vary 则追加而非覆盖', () => {
		const res = new Response('ok', { headers: { vary: 'Accept-Encoding' } });
		expect(withCorsHeaders(res, CORS_ORIGIN).headers.get('vary')).toBe('Accept-Encoding, Origin');
	});

	it('无 Origin 头的请求不读 platform.env（prerender 场景：adapter-cloudflare 禁读 bindings）', async () => {
		// 复刻 adapter-cloudflare 对 prerenderable route 的行为：platform.env 任何属性读取即抛错
		const res = await handle({
			event: {
				url: new URL('https://t.local/'),
				request: new Request('https://t.local/'),
				platform: {
					env: new Proxy(
						{},
						{ get() { throw new Error('Cannot access platform.env in a prerenderable route'); } }
					)
				} as never,
				cookies: { get: () => undefined } as never
			} as never,
			resolve: async () => new Response('ok')
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
	});
});
