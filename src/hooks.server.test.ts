// hooks.server 统一拦截：门启用且未解锁 → 401 site_locked；白名单、非 API 路径、门未启用放行
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestD1, type TestD1 } from './test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from './test/r2-memory';
import { handle } from './hooks.server';
import {
	GATE_COOKIE,
	issueUnlockValue,
	getGateState,
	setGatePassword
} from './lib/server/site-gate';

const INIT_PW = 'init-pass-1';

let d1: TestD1;
let r2: MemoryR2;

beforeEach(() => {
	d1 = createTestD1();
	r2 = createMemoryR2();
});

interface CallOpts {
	cookie?: string;
	/** 模拟环境变量 SITE_DEFAULT_PASSWORD；undefined = 未配置（门未启用） */
	defaultPw?: string;
	withBindings?: boolean; // 默认 true
}

async function call(path: string, opts: CallOpts = {}): Promise<Response> {
	const withBindings = opts.withBindings ?? true;
	return handle({
		event: {
			url: new URL(`https://t.local${path}`),
			platform: withBindings
				? ({
						env: {
							DB: d1.db,
							HITSOUND_FILES: r2.bucket,
							SITE_DEFAULT_PASSWORD: opts.defaultPw
						}
					} as never)
				: undefined,
			cookies: { get: (n: string) => (n === GATE_COOKIE ? opts.cookie : undefined) } as never
		} as never,
		resolve: async () => new Response('ok')
	});
}

/** 用初始密码（环境变量形态）签发解锁 cookie */
async function unlockCookie(): Promise<string> {
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
		const res = await call('/api/tree', { defaultPw: INIT_PW, cookie: await unlockCookie() });
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
		const old = await unlockCookie();
		expect((await call('/api/tree', { defaultPw: INIT_PW, cookie: old })).status).toBe(200);
		await setGatePassword(d1.db, 'rotated-pass');
		expect((await call('/api/tree', { defaultPw: INIT_PW, cookie: old })).status).toBe(401);
	});
});
