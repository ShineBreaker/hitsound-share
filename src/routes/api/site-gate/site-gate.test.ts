// POST /api/site-gate 端到端：环境变量初始密码解锁签发 cookie；错误密码 401；门未启用 404
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestD1, type TestD1 } from '../../../test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from '../../../test/r2-memory';
import { POST } from './+server';
import { GATE_COOKIE, getGateState, verifyUnlockValue } from '$lib/server/site-gate';

// 初始密码从环境变量注入（部署方在 Pages 配置；代码与测试不关心其值）
const INIT_PW = 'init-pass-1';

let d1: TestD1;
let r2: MemoryR2;
let setCookie = '';

function call(body: unknown, withGate = true, withBindings = true): Promise<Response> {
	return POST({
		request: new Request('https://t.local/api/site-gate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}),
		platform: withBindings
			? ({
					env: {
						DB: d1.db,
						HITSOUND_FILES: r2.bucket,
						SITE_DEFAULT_PASSWORD: withGate ? INIT_PW : undefined
					}
				} as never)
			: undefined,
		cookies: {
			get: () => undefined,
			set: (name: string, value: string) => {
				setCookie = `${name}=${value}`;
			}
		} as never
	} as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
	d1 = createTestD1();
	r2 = createMemoryR2();
	setCookie = '';
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

	it('错误密码 → 401 wrong_password，不签发 cookie', async () => {
		const res = await call({ password: 'let-me-in!' });
		expect(res.status).toBe(401);
		expect(((await res.json()) as { error: string }).error).toBe('wrong_password');
		expect(setCookie).toBe('');
	});

	it('门未启用（未配初始密码且无库记录）→ 404 gate_not_enabled', async () => {
		const res = await call({ password: 'whatever-1' }, false);
		expect(res.status).toBe(404);
		expect(((await res.json()) as { error: string }).error).toBe('gate_not_enabled');
	});

	it('坏请求体 → 400；无 bindings → 503', async () => {
		expect((await call({})).status).toBe(400);
		expect((await call({ password: 123 })).status).toBe(400);
		expect((await call({ password: INIT_PW }, true, false)).status).toBe(503);
	});
});
