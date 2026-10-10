// POST /api/site-gate 端到端：环境变量初始密码解锁签发 cookie + 响应体下发 token；
// Set-Cookie 的 SameSite 按跨源判定（白名单 Origin → None，其余 Lax）；
// 错误密码 401；连续失败达阈值 429（isolate 内存限速）；门未启用 404
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestD1, type TestD1 } from '../../../test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from '../../../test/r2-memory';
import { POST } from './+server';
import { GATE_COOKIE, GATE_MAX_ATTEMPTS, getGateState, verifyUnlockValue } from '$lib/server/site-gate';

// 初始密码从环境变量注入（部署方在 Pages 配置；代码与测试不关心其值）
const INIT_PW = 'init-pass-1';
const CORS_ORIGIN = 'https://app.example.com';

let d1: TestD1;
let r2: MemoryR2;
let setCookie = '';
let setOpts: Record<string, unknown> | undefined; // cookies.set 的属性参数
// 限速计数在模块级 Map：默认每个请求注入唯一 IP，避免用例间互相污染
let ipSeq = 0;

interface CallOpts {
	/** false = 不配 SITE_DEFAULT_PASSWORD（门未启用） */
	gate?: boolean;
	/** false = 模拟无 bindings */
	bindings?: boolean;
	/** 请求 Origin 头 */
	origin?: string;
	/** 模拟环境变量 CORS_ORIGINS */
	corsOrigins?: string;
	/** 注入 cf-connecting-ip（限速按 IP 维度；缺省每次唯一） */
	ip?: string;
}

function call(body: unknown, opts: CallOpts = {}): Promise<Response> {
	ipSeq += 1;
	return POST({
		request: new Request('https://t.local/api/site-gate', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'cf-connecting-ip': opts.ip ?? `test-ip-${ipSeq}`,
				...(opts.origin ? { origin: opts.origin } : {})
			},
			body: JSON.stringify(body)
		}),
		platform:
			opts.bindings === false
				? undefined
				: ({
						env: {
							DB: d1.db,
							HITSOUND_FILES: r2.bucket,
							SITE_DEFAULT_PASSWORD: opts.gate === false ? undefined : INIT_PW,
							CORS_ORIGINS: opts.corsOrigins
						}
					} as never),
		cookies: {
			get: () => undefined,
			set: (name: string, value: string, options?: Record<string, unknown>) => {
				setCookie = `${name}=${value}`;
				setOpts = options;
			}
		} as never
	} as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
	d1 = createTestD1();
	r2 = createMemoryR2();
	setCookie = '';
	setOpts = undefined;
});

describe('/api/site-gate 解锁', () => {
	it('初始密码 → 200 + 签发对当前 hash 有效的 hs_gate cookie', async () => {
		const res = await call({ password: INIT_PW });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

		expect(setCookie.startsWith(`${GATE_COOKIE}=`)).toBe(true);
		const value = setCookie.slice(`${GATE_COOKIE}=`.length);
		const state = await getGateState(d1.db, INIT_PW);
		expect(await verifyUnlockValue(value, state.hash!)).toBe(true);
	});

	it('响应体下发 token，与 cookie 值同构且对当前 hash 有效（可过门）', async () => {
		const res = await call({ password: INIT_PW });
		expect(res.status).toBe(200);
		const data = (await res.json()) as { ok: boolean; token: string };
		expect(data.ok).toBe(true);
		expect(typeof data.token).toBe('string');

		const state = await getGateState(d1.db, INIT_PW);
		expect(await verifyUnlockValue(data.token, state.hash!)).toBe(true);
		expect(setCookie).toBe(`${GATE_COOKIE}=${data.token}`);
	});

	it('Set-Cookie 按跨源判定：白名单 Origin → SameSite=None；无 Origin 维持 Lax', async () => {
		const cross = await call({ password: INIT_PW }, { origin: CORS_ORIGIN, corsOrigins: CORS_ORIGIN });
		expect(cross.status).toBe(200);
		expect(setOpts?.sameSite).toBe('none');
		expect(setOpts?.secure).toBe(true); // None 的 Secure 前置（Pages 全站 https）

		const sameOrigin = await call({ password: INIT_PW });
		expect(sameOrigin.status).toBe(200);
		expect(setOpts?.sameSite).toBe('lax');
	});

	it('Origin 不在白名单（未配 CORS_ORIGINS）→ 维持 Lax 现状', async () => {
		const res = await call({ password: INIT_PW }, { origin: CORS_ORIGIN });
		expect(res.status).toBe(200);
		expect(setOpts?.sameSite).toBe('lax');
	});

	it('错误密码 → 401 wrong_password，不签发 cookie', async () => {
		const res = await call({ password: 'let-me-in!' });
		expect(res.status).toBe(401);
		expect(((await res.json()) as { error: string }).error).toBe('wrong_password');
		expect(setCookie).toBe('');
	});

	it('门未启用（未配初始密码且无库记录）→ 404 gate_not_enabled', async () => {
		const res = await call({ password: 'whatever-1' }, { gate: false });
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error: string }).error).toBe('gate_not_enabled');
	});

	it('坏请求体 → 400；无 bindings → 503', async () => {
		expect((await call({})).status).toBe(400);
		expect((await call({ password: 123 })).status).toBe(400);
		expect((await call({ password: INIT_PW }, { bindings: false })).status).toBe(503);
	});
});

describe('/api/site-gate 解锁失败限速', () => {
	it('同 IP 连续错 GATE_MAX_ATTEMPTS 次后 → 429 too_many_attempts，且不再触达 D1', async () => {
		const ip = 'rate-e2e-1';
		for (let i = 0; i < GATE_MAX_ATTEMPTS; i++) {
			const r = await call({ password: 'wrong-pass-x' }, { ip });
			expect(r.status).toBe(401);
		}
		const before = d1.calls;
		const locked = await call({ password: 'wrong-pass-x' }, { ip });
		expect(locked.status).toBe(429);
		expect(((await locked.json()) as { error: string }).error).toBe('too_many_attempts');
		expect(d1.calls).toBe(before); // 限速判定先于一切查询
	});

	it('成功解锁清零计数；其他 IP 不受牵连', async () => {
		const ip = 'rate-e2e-2';
		for (let i = 0; i < GATE_MAX_ATTEMPTS - 1; i++) {
			await call({ password: 'wrong-pass-x' }, { ip });
		}
		expect((await call({ password: INIT_PW }, { ip })).status).toBe(200); // 清零
		expect((await call({ password: 'wrong-pass-x' }, { ip })).status).toBe(401); // 从 1 起算

		expect((await call({ password: 'wrong-pass-x' }, { ip: 'rate-e2e-3' })).status).toBe(401);
		expect((await call({ password: INIT_PW })).status).toBe(200); // 唯一默认 IP：正常解锁
	});
});
