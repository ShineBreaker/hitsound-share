// DELETE /api/package/<id>/folder 端到端：级联删文件夹文件 + blob 回收
import { describe, it, expect, beforeEach } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestD1, type TestD1 } from '../../../../../test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from '../../../../../test/r2-memory';
import { signSession, SESSION_COOKIE } from '$lib/server/session';
import { blobKey } from '$lib/server/media';
import { DELETE } from './+server';

const SECRET = 'folder-test-secret';
const UID = 4242;
const SUPER_UID = 42; // ADMIN_OSU_ID
const h = (n: number) => n.toString(16).padStart(64, '0');

let d1: TestD1;
let r2: MemoryR2;
let cookie: string;

function db(): D1Database {
	return d1.db;
}

async function addUser(osuId: number, admin = 0): Promise<void> {
	await db()
		.prepare('INSERT INTO users (osu_id, username, is_admin) VALUES (?1, ?2, ?3)')
		.bind(osuId, `u${osuId}`, admin)
		.run();
}

async function addPackage(id: string, owner: number): Promise<void> {
	await db()
		.prepare(
			`INSERT INTO packages (id, name, uploader_osu_id, size_bytes, logical_size, file_count, status)
			 VALUES (?1, ?2, ?3, 0, 0, 0, 'visible')`
		)
		.bind(id, `pkg-${id}`, owner)
		.run();
}

async function addBlob(hash: string, size = 100, refcount = 0): Promise<void> {
	await db()
		.prepare('INSERT OR IGNORE INTO blobs (hash, size, mime, refcount) VALUES (?1, ?2, ?3, ?4)')
		.bind(hash, size, 'audio/wav', refcount)
		.run();
}

async function addFile(pkg: string, name: string, hash: string, folder = '', size = 100): Promise<void> {
	await db()
		.prepare(
			`INSERT INTO files (id, package_id, folder_path, name, format, size_bytes, blob_hash)
			 VALUES (?1, ?2, ?3, ?4, 'wav', ?5, ?6)`
		)
		.bind(crypto.randomUUID(), pkg, folder, name, size, hash)
		.run();
}

async function callDelete(pkgId: string, path: unknown): Promise<Response> {
	return await DELETE({
		request: new Request(`https://t.local/api/package/${pkgId}/folder`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path })
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
		params: { id: pkgId },
		locals: {},
		url: new URL(`https://t.local/api/package/${pkgId}/folder`)
	} as unknown as Parameters<typeof DELETE>[0]);
}

async function filesIn(pkg: string, folder: string): Promise<number> {
	const r = await db()
		.prepare('SELECT COUNT(*) AS c FROM files WHERE package_id = ?1 AND folder_path = ?2')
		.bind(pkg, folder)
		.first<{ c: number }>();
	return r?.c ?? -1;
}

async function refcountOf(hash: string): Promise<number> {
	const r = await db()
		.prepare('SELECT refcount AS r FROM blobs WHERE hash = ?1')
		.bind(hash)
		.first<{ r: number }>();
	return r?.r ?? -1;
}

async function blobExists(hash: string): Promise<boolean> {
	return (await db().prepare('SELECT hash FROM blobs WHERE hash = ?1').bind(hash).first()) !== null;
}

async function loginAs(osuId: number): Promise<void> {
	cookie = await signSession({ osuId, username: `u${osuId}`, avatarUrl: null }, SECRET);
}

beforeEach(async () => {
	d1 = createTestD1();
	r2 = createMemoryR2();
	await addUser(UID);
	await addUser(888);
	await addUser(SUPER_UID);
	await loginAs(UID);
});

describe('DELETE /api/package/<id>/folder', () => {
	it('未登录 → 401；坏 path → 400；不存在的文件夹 → 404；他人包 → 403', async () => {
		await addPackage('mine', UID);
		await addBlob(h(1), 100, 1);
		await addFile('mine', 'a.wav', h(1), 'a');

		cookie = 'bogus';
		expect((await callDelete('mine', 'a')).status).toBe(401);
		await loginAs(UID);

		expect((await callDelete('mine', '')).status).toBe(400); // 包根不是文件夹
		expect((await callDelete('mine', '../x')).status).toBe(400);
		expect((await callDelete('mine', 'nope')).status).toBe(404);
		await loginAs(888);
		expect((await callDelete('mine', 'a')).status).toBe(403); // 非包主非管理员
		expect(await filesIn('mine', 'a')).toBe(1); // 未被删
	});

	it('级联删除：a 与 a/b 全删，ab/c 不误伤（全值边界）；独占 blob 回收', async () => {
		await addPackage('mine', UID);
		await addBlob(h(1), 100, 2);
		await addBlob(h(2), 100, 1);
		await addBlob(h(3), 100, 1);
		await addFile('mine', 'a.wav', h(1), 'a');
		await addFile('mine', 'b.wav', h(2), 'a/b'); // 子文件夹
		await addFile('mine', 'c.wav', h(3), 'ab/c'); // 兄弟前缀路径，不应被删
		await addFile('mine', 'root.wav', h(1), ''); // 包根文件不动
		await r2.bucket.put(blobKey(h(1), 'wav'), new Uint8Array(100));
		await r2.bucket.put(blobKey(h(2), 'wav'), new Uint8Array(100));
		await r2.bucket.put(blobKey(h(3), 'wav'), new Uint8Array(100));

		const res = await callDelete('mine', 'a');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, deleted: 2 });

		expect(await filesIn('mine', 'a')).toBe(0);
		expect(await filesIn('mine', 'a/b')).toBe(0);
		expect(await filesIn('mine', 'ab/c')).toBe(1); // 精确边界
		expect(await filesIn('mine', '')).toBe(1);

		const pkg = await db()
			.prepare('SELECT file_count AS c FROM packages WHERE id = ?1')
			.bind('mine')
			.first<{ c: number }>();
		expect(pkg?.c).toBe(2); // root.wav + ab/c 的 c.wav

		// h1 仍被包根 root.wav 引用 → 保留（refcount 对齐 1）；h2 独占回收；h3 不动
		expect(await refcountOf(h(1))).toBe(1);
		expect(await blobExists(h(2))).toBe(false);
		expect(await refcountOf(h(3))).toBe(1);
		expect(r2.keys()).toContain(blobKey(h(1), 'wav'));
		expect(r2.keys()).not.toContain(blobKey(h(2), 'wav'));
		expect(r2.keys()).toContain(blobKey(h(3), 'wav'));
	});

	it('超级管理员删他人包的文件夹 → 200', async () => {
		await addPackage('theirs', 888);
		await addBlob(h(1), 100, 1);
		await addFile('theirs', 'a.wav', h(1), 'x');

		await loginAs(SUPER_UID);
		const res = await callDelete('theirs', 'x');
		expect(res.status).toBe(200);
		expect(await filesIn('theirs', 'x')).toBe(0);
	});
});
