// PUT /api/admin/site-gate 端到端：仅管理员（超管或 users.is_admin）可改访问密码
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestD1, type TestD1 } from '../../../../test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from '../../../../test/r2-memory';
import { signSession, SESSION_COOKIE } from '$lib/server/session';
import { PUT } from './+server';
import {
	GATE_COOKIE,
	getGateState,
	verifyUnlockValue,
	checkGatePassword
} from '$lib/server/site-gate';

const SECRET = 'site-gate-admin-test-secret';
const SUPER_UID = 42; // ADMIN_OSU_ID
const DBADMIN_UID = 7;
const UID = 4242;

let d1: TestD1;
let r2: MemoryR2;
let cookie = '';
let setCookie = '';

function call(body: unknown): Promise<Response> {
	return PUT({
		request: new Request('https://t.local/api/admin/site-gate', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}),
		platform: {
			env: {
				DB: d1.db,
				HITSOUND_FILES: r2.bucket,
				SESSION_SECRET: SECRET,
				ADMIN_OSU_ID: String(SUPER_UID)
			}
		},
		cookies: {
			get: (n: string) => (n === SESSION_COOKIE ? cookie : undefined),
			set: (name: string, value: string) => {
				setCookie = `${name}=${value}`;
			}
		} as never,
		url: new URL('https://t.local/api/admin/site-gate')
	} as unknown as Parameters<typeof PUT>[0]);
}

async function loginAs(osuId: number): Promise<void> {
	cookie = await signSession({ osuId, username: `u${osuId}`, avatarUrl: null }, SECRET);
}

beforeEach(async () => {
	d1 = createTestD1();
	r2 = createMemoryR2();
	cookie = '';
	setCookie = '';
	for (const [id, name, admin] of [
		[SUPER_UID, 'boss', 0],
		[DBADMIN_UID, 'mod', 1],
		[UID, 'tester', 0]
	] as const) {
		await d1.db
			.prepare('INSERT INTO users (osu_id, username, is_admin) VALUES (?1, ?2, ?3)')
			.bind(id, name, admin)
			.run();
	}
});

describe('/api/admin/site-gate 权限', () => {
	it('未登录 → 401；普通用户 → 403', async () => {
		cookie = 'bogus';
		expect((await call({ password: 'new-pass-1' })).status).toBe(401);

		await loginAs(UID);
		expect((await call({ password: 'new-pass-1' })).status).toBe(403);
	});
});

describe('/api/admin/site-gate 改密', () => {
	it('超级管理员与名单管理员均可改：落库 + 即时获发新解锁 cookie', async () => {
		await loginAs(DBADMIN_UID); // 名单内管理员（非超管）
		let res = await call({ password: 'first-new-pw' });
		expect(res.status).toBe(200);
		expect(await checkGatePassword(d1.db, 'first-new-pw')).toBe(true);

		let value = setCookie.slice(`${GATE_COOKIE}=`.length);
		expect(setCookie.startsWith(`${GATE_COOKIE}=`)).toBe(true);
		expect(await verifyUnlockValue(value, (await getGateState(d1.db)).hash!)).toBe(true);

		await loginAs(SUPER_UID); // 超级管理员
		res = await call({ password: 'second-new-pw' });
		expect(res.status).toBe(200);
		expect(await checkGatePassword(d1.db, 'second-new-pw')).toBe(true);
		expect(await checkGatePassword(d1.db, 'first-new-pw')).toBe(false);
	});

	it('非法密码（过短 / 全空白 / 非字符串）→ 400，不落库', async () => {
		await loginAs(SUPER_UID);
		for (const bad of ['abc', '    ', 123, undefined]) {
			expect((await call({ password: bad })).status, String(bad)).toBe(400);
		}
		expect((await getGateState(d1.db)).enabled).toBe(false); // 未写入任何记录
	});
});
