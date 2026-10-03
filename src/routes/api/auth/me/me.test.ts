// GET /api/auth/me：登录态双轨凭证（cookie 优先 / x-hs-session 头兜底）。
// D1 adapter 供 is_admin 库查询；子请求预算：me 登录时 1 条 users 查询
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestD1, type TestD1 } from '../../../../test/d1-sqlite';
import { signSession, SESSION_COOKIE, SESSION_HEADER } from '$lib/server/session';
import { GET } from './+server';

const SECRET = 'me-test-secret';
const UID = 4242;

let d1: TestD1;

interface CallOpts {
	cookie?: string;
	header?: string | null;
}

function call(opts: CallOpts = {}): Promise<Response> {
	const headers: Record<string, string> = {};
	if (opts.header) headers[SESSION_HEADER] = opts.header;
	return GET({
		cookies: { get: (n: string) => (n === SESSION_COOKIE ? opts.cookie : undefined) },
		request: new Request('https://t.local/api/auth/me', { headers }),
		platform: { env: { DB: d1.db, SESSION_SECRET: SECRET } }
	} as unknown as Parameters<typeof GET>[0]);
}

beforeEach(async () => {
	d1 = createTestD1();
	await d1.db
		.prepare('INSERT INTO users (osu_id, username) VALUES (?1, ?2)')
		.bind(UID, 'tester')
		.run();
});

describe('GET /api/auth/me 双轨凭证', () => {
	it('cookie 有效 → loggedIn（同源现状）', async () => {
		const res = await call({ cookie: await signSession({ osuId: UID, username: 'tester', avatarUrl: null }, SECRET) });
		expect(res.status).toBe(200);
		const data = (await res.json()) as { loggedIn: boolean; username?: string };
		expect(data.loggedIn).toBe(true);
		expect(data.username).toBe('tester');
	});

	it('无 cookie + x-hs-session 有效 → loggedIn（桌面 token 轨）', async () => {
		const res = await call({ header: await signSession({ osuId: UID, username: 'tester', avatarUrl: null }, SECRET) });
		const data = (await res.json()) as { loggedIn: boolean; osuId?: number };
		expect(data.loggedIn).toBe(true);
		expect(data.osuId).toBe(UID);
	});

	it('无效 cookie 遮蔽有效 header → loggedIn:false（cookie 优先，同源零回归）', async () => {
		const res = await call({
			cookie: 'stale.badsig',
			header: await signSession({ osuId: UID, username: 'tester', avatarUrl: null }, SECRET)
		});
		expect(((await res.json()) as { loggedIn: boolean }).loggedIn).toBe(false);
	});

	it('无凭证 → loggedIn:false', async () => {
		expect(((await (await call()).json()) as { loggedIn: boolean }).loggedIn).toBe(false);
	});

	it('SESSION_SECRET 未配置 → loggedIn:false（不 500）', async () => {
		const res = await GET({
			cookies: { get: () => undefined },
			request: new Request('https://t.local/api/auth/me'),
			platform: { env: {} }
		} as unknown as Parameters<typeof GET>[0]);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { loggedIn: boolean }).loggedIn).toBe(false);
	});
});
