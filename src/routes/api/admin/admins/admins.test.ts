// /api/admin/admins 端到端：仅超级管理员可维护名单（users.is_admin）
import { describe, it, expect, beforeEach } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestD1, type TestD1 } from '../../../../test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from '../../../../test/r2-memory';
import { signSession, SESSION_COOKIE } from '$lib/server/session';
import { GET, POST, DELETE } from './+server';

const SECRET = 'admins-test-secret';
const SUPER_UID = 42; // ADMIN_OSU_ID
const DBADMIN_UID = 7;
const UID = 4242;

let d1: TestD1;
let r2: MemoryR2;
let cookie: string;

function db(): D1Database {
	return d1.db;
}

async function addUser(osuId: number, username: string, admin = 0): Promise<void> {
	await db()
		.prepare('INSERT INTO users (osu_id, username, is_admin) VALUES (?1, ?2, ?3)')
		.bind(osuId, username, admin)
		.run();
}

async function loginAs(osuId: number): Promise<void> {
	cookie = await signSession({ osuId, username: `u${osuId}`, avatarUrl: null }, SECRET);
}

function ctx(method: string, body?: unknown) {
	return {
		request: new Request('https://t.local/api/admin/admins', {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		}),
		platform: {
			env: {
				DB: db(),
				HITSOUND_FILES: r2.bucket,
				SESSION_SECRET: SECRET,
				ADMIN_OSU_ID: String(SUPER_UID)
			}
		},
		cookies: { get: (n: string) => (n === SESSION_COOKIE ? cookie : undefined) },
		params: {},
		locals: {},
		url: new URL('https://t.local/api/admin/admins')
	};
}

const callGET = () => GET(ctx('GET') as unknown as Parameters<typeof GET>[0]);
const callPOST = (body: unknown) => POST(ctx('POST', body) as unknown as Parameters<typeof POST>[0]);
const callDELETE = (body: unknown) =>
	DELETE(ctx('DELETE', body) as unknown as Parameters<typeof DELETE>[0]);

beforeEach(async () => {
	d1 = createTestD1();
	r2 = createMemoryR2();
	await addUser(SUPER_UID, 'boss');
	await addUser(DBADMIN_UID, 'mod', 1);
	await addUser(UID, 'tester');
});

describe('/api/admin/admins 权限', () => {
	it('未登录 → 401；普通用户 → 403；DB 管理员（非超管）→ 403', async () => {
		cookie = 'bogus';
		expect((await callGET()).status).toBe(401);

		await loginAs(UID);
		expect((await callGET()).status).toBe(403);
		expect((await callPOST({ user: 'tester' })).status).toBe(403);
		expect((await callDELETE({ osu_id: DBADMIN_UID })).status).toBe(403);

		await loginAs(DBADMIN_UID); // 名单内管理员也不能动名单
		expect((await callGET()).status).toBe(403);
	});
});

describe('/api/admin/admins 名单操作（超管）', () => {
	beforeEach(() => loginAs(SUPER_UID));

	it('GET 列出名单内管理员（按用户名排序）', async () => {
		const res = await callGET();
		expect(res.status).toBe(200);
		const body = (await res.json()) as { admins: Array<{ osu_id: number; username: string }> };
		expect(body.admins.map((a) => a.username)).toEqual(['mod']);
	});

	it('POST 按用户名/ID 授管理员；已授幂等；不存在 → 404', async () => {
		const res1 = await callPOST({ user: 'tester' });
		expect(res1.status).toBe(200);
		expect(((await res1.json()) as { admin: { osu_id: number } }).admin.osu_id).toBe(UID);

		const res2 = await callPOST({ user: String(UID) }); // 按 ID，幂等
		expect(res2.status).toBe(200);

		expect((await callPOST({ user: 'ghost' })).status).toBe(404);
		expect((await callPOST({ user: '' })).status).toBe(400);
		expect((await callPOST({})).status).toBe(400);

		const list = (await (await callGET()).json()) as { admins: unknown[] };
		expect(list.admins.length).toBe(2);
	});

	it('POST 授完后用户即获管理员能力（is_admin 落库）', async () => {
		await callPOST({ user: 'tester' });
		const row = await db()
			.prepare('SELECT is_admin AS a FROM users WHERE osu_id = ?1')
			.bind(UID)
			.first<{ a: number }>();
		expect(row?.a).toBe(1);
	});

	it('DELETE 撤管理员（幂等）', async () => {
		expect((await callDELETE({ osu_id: DBADMIN_UID })).status).toBe(200);
		const row = await db()
			.prepare('SELECT is_admin AS a FROM users WHERE osu_id = ?1')
			.bind(DBADMIN_UID)
			.first<{ a: number }>();
		expect(row?.a).toBe(0);

		expect((await callDELETE({ osu_id: 999999 })).status).toBe(200); // 不存在也幂等
		expect((await callDELETE({ osu_id: 'x' })).status).toBe(400);
	});
});
