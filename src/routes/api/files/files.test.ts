// GET / PATCH / DELETE /api/files 端到端：fake D1 + 内存 R2 + 签名 session
import { describe, it, expect, beforeEach } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestD1, type TestD1 } from '../../../test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from '../../../test/r2-memory';
import { signSession, SESSION_COOKIE } from '$lib/server/session';
import { blobKey } from '$lib/server/media';
import { DELETE, GET, PATCH } from './+server';

const SECRET = 'files-test-secret';
const UID = 4242;
const ADMIN_UID = 9001;
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

async function addFile(
	pkg: string,
	name: string,
	hash: string,
	folder = '',
	size = 100,
	owner: number | null = null
): Promise<string> {
	const id = crypto.randomUUID();
	await db()
		.prepare(
			`INSERT INTO files (id, package_id, folder_path, name, format, size_bytes, blob_hash, owner_osu_id)
			 VALUES (?1, ?2, ?3, ?4, 'wav', ?5, ?6, ?7)`
		)
		.bind(id, pkg, folder, name, size, hash, owner)
		.run();
	return id;
}

async function callGet(pkg: string, folder = ''): Promise<Response> {
	return await GET({
		platform: { env: { DB: db(), HITSOUND_FILES: r2.bucket, SESSION_SECRET: SECRET } },
		url: new URL(
			`https://t.local/api/files?pkg=${encodeURIComponent(pkg)}&folder=${encodeURIComponent(folder)}`
		)
	} as unknown as Parameters<typeof GET>[0]);
}

async function callPatch(id: unknown, name: unknown): Promise<Response> {
	return await PATCH({
		request: new Request('https://t.local/api/files', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id, name })
		}),
		platform: { env: { DB: db(), HITSOUND_FILES: r2.bucket, SESSION_SECRET: SECRET } },
		cookies: { get: (n: string) => (n === SESSION_COOKIE ? cookie : undefined) },
		params: {},
		locals: {},
		url: new URL('https://t.local/api/files')
	} as unknown as Parameters<typeof PATCH>[0]);
}

async function callDelete(ids: unknown): Promise<Response> {
	return await DELETE({
		request: new Request('https://t.local/api/files', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ids })
		}),
		platform: { env: { DB: db(), HITSOUND_FILES: r2.bucket, SESSION_SECRET: SECRET } },
		cookies: { get: (n: string) => (n === SESSION_COOKIE ? cookie : undefined) },
		params: {},
		locals: {},
		url: new URL('https://t.local/api/files')
	} as unknown as Parameters<typeof DELETE>[0]);
}

async function fileCount(pkg: string): Promise<number> {
	const r = await db()
		.prepare('SELECT COUNT(*) AS c FROM files WHERE package_id = ?1')
		.bind(pkg)
		.first<{ c: number }>();
	return r?.c ?? -1;
}

async function blobExists(hash: string): Promise<boolean> {
	return (await db().prepare('SELECT hash FROM blobs WHERE hash = ?1').bind(hash).first()) !== null;
}

async function refcountOf(hash: string): Promise<number> {
	const r = await db().prepare('SELECT refcount AS r FROM blobs WHERE hash = ?1').bind(hash).first<{ r: number }>();
	return r?.r ?? -1;
}

beforeEach(async () => {
	d1 = createTestD1();
	r2 = createMemoryR2();
	cookie = await signSession({ osuId: UID, username: 'tester', avatarUrl: null }, SECRET);
	await addUser(UID);
	await addUser(888); // 他人
});

describe('DELETE /api/files', () => {
	it('未登录 → 401；坏 body → 400；目标不存在 → 404', async () => {
		cookie = 'bogus';
		expect((await callDelete(['x'])).status).toBe(401);

		cookie = await signSession({ osuId: UID, username: 't', avatarUrl: null }, SECRET);
		expect((await callDelete([])).status).toBe(400);
		expect((await callDelete('nope')).status).toBe(400);
		expect((await callDelete(['missing-id'])).status).toBe(404);
	});

	it('非管理员删他人上传的文件 → 403（全不删）', async () => {
		await addPackage('theirs', 888);
		await addBlob(h(1), 100, 1);
		const fid = await addFile('theirs', 'a.wav', h(1), '', 100, 888);

		const res = await callDelete([fid]);
		expect(res.status).toBe(403);
		expect(await fileCount('theirs')).toBe(1);
	});

	it('文件 owner 删自己上传的文件：行删除 + 计数器/逻辑大小重算 + 独占 blob 回收 + R2 对象删除', async () => {
		await addPackage('mine', UID);
		await addBlob(h(1), 100, 2); // 与 shared 包共享
		await addBlob(h(2), 200, 1); // mine 独占
		await addPackage('shared', 888);
		const f1 = await addFile('mine', 'a.wav', h(1), '', 100, UID);
		const f2 = await addFile('mine', 'b.wav', h(2), 'sub', 200, UID);
		await addFile('shared', 'a.wav', h(1), '', 100, 888);
		await r2.bucket.put(blobKey(h(1), 'wav'), new Uint8Array(100));
		await r2.bucket.put(blobKey(h(2), 'wav'), new Uint8Array(200));

		const res = await callDelete([f1, f2]);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, deleted: 2 });

		expect(await fileCount('mine')).toBe(0);
		const pkg = await db()
			.prepare('SELECT file_count AS c, logical_size AS s FROM packages WHERE id = ?1')
			.bind('mine')
			.first<{ c: number; s: number }>();
		expect(pkg).toEqual({ c: 0, s: 0 });

		// h1 仍被 shared 包引用：行在、refcount 对齐为 1、对象保留；h2 行+对象回收
		expect(await blobExists(h(1))).toBe(true);
		expect(await refcountOf(h(1))).toBe(1);
		expect(await blobExists(h(2))).toBe(false);
		expect(r2.keys()).toContain(blobKey(h(1), 'wav'));
		expect(r2.keys()).not.toContain(blobKey(h(2), 'wav'));
	});

	it('DB 管理员（users.is_admin）删他人文件 → 200', async () => {
		await addUser(ADMIN_UID, 1);
		cookie = await signSession({ osuId: ADMIN_UID, username: 'mod', avatarUrl: null }, SECRET);
		await addPackage('theirs', 888);
		await addBlob(h(1), 100, 1);
		const fid = await addFile('theirs', 'a.wav', h(1), '', 100, 888);

		const res = await callDelete([fid]);
		expect(res.status).toBe(200);
		expect(await fileCount('theirs')).toBe(0);
	});

	it('跨包混合删除：管理员一次删多包文件，各包计数器独立重算', async () => {
		await addUser(ADMIN_UID, 1);
		cookie = await signSession({ osuId: ADMIN_UID, username: 'mod', avatarUrl: null }, SECRET);
		await addPackage('p1', 888);
		await addPackage('p2', UID);
		await addBlob(h(1), 100, 1);
		await addBlob(h(2), 100, 1);
		const f1 = await addFile('p1', 'a.wav', h(1), '', 100, 888);
		const f2 = await addFile('p2', 'b.wav', h(2), '', 100, UID);

		const res = await callDelete([f1, f2]);
		expect(res.status).toBe(200);
		expect(await fileCount('p1')).toBe(0);
		expect(await fileCount('p2')).toBe(0);
	});

	it('300 个文件 id 批量删除：常数子请求（≤5 D1 + ≤1 R2 delete）', async () => {
		await addPackage('big', UID);
		const ids: string[] = [];
		for (let i = 0; i < 300; i += 250) {
			const stmts = [];
			for (let j = i; j < Math.min(i + 250, 300); j++) {
				stmts.push(
					db().prepare('INSERT INTO blobs (hash, size, mime, refcount) VALUES (?1, 10, ?2, 1)').bind(h(j), 'audio/wav'),
					db()
						.prepare(
							`INSERT INTO files (id, package_id, folder_path, name, format, size_bytes, blob_hash, owner_osu_id)
							 VALUES (?1, 'big', '', ?2, 'wav', 10, ?3, ?4)`
						)
						.bind(`f${j}`, `f${j}.wav`, h(j), UID)
				);
				ids.push(`f${j}`);
			}
			await db().batch(stmts);
		}

		const d1Before = d1.calls;
		const r2Before = r2.calls.delete;
		const res = await callDelete(ids);
		expect(res.status).toBe(200);
		// 归属查询(1 batch) + 格式集合(1 batch) + 主事务(1 batch)——全为本人文件免 isAdmin
		expect(d1.calls - d1Before).toBeLessThanOrEqual(4);
		expect(r2.calls.delete - r2Before).toBeLessThanOrEqual(1); // 300 keys < 1000
		expect(await fileCount('big')).toBe(0);
	});
});

describe('DELETE /api/files 文件级归属（owner 与包主解耦）', () => {
	it('他人包内 owner 是自己的文件 → 200（按文件 owner 放行，与所在包无关）', async () => {
		await addPackage('theirs', 888);
		await addBlob(h(1), 100, 1);
		const fid = await addFile('theirs', 'a.wav', h(1), '', 100, UID);

		const res = await callDelete([fid]);
		expect(res.status).toBe(200);
		expect(await fileCount('theirs')).toBe(0);
	});

	it('自己包内 owner 是他人的文件 → 403（包主身份不再放行）', async () => {
		await addPackage('mine', UID);
		await addBlob(h(1), 100, 1);
		const fid = await addFile('mine', 'a.wav', h(1), '', 100, 888);

		const res = await callDelete([fid]);
		expect(res.status).toBe(403);
		expect(await fileCount('mine')).toBe(1);
	});

	it('owner NULL（系统导入）：普通用户 403、管理员 200', async () => {
		await addPackage('sys', null);
		await addBlob(h(1), 100, 1);
		const fid = await addFile('sys', 'a.wav', h(1)); // owner 默认 NULL

		expect((await callDelete([fid])).status).toBe(403);
		expect(await fileCount('sys')).toBe(1);

		await addUser(ADMIN_UID, 1);
		cookie = await signSession({ osuId: ADMIN_UID, username: 'mod', avatarUrl: null }, SECRET);
		expect((await callDelete([fid])).status).toBe(200);
	});
});

describe('GET /api/files', () => {
	it('下发文件级 owner（id + 用户名）；系统导入为 null；包不存在 → 404', async () => {
		expect((await callGet('nope')).status).toBe(404);

		await addPackage('mine', UID);
		await addPackage('sys', null);
		await addBlob(h(1), 100, 1);
		await addBlob(h(2), 100, 1);
		const fid = await addFile('mine', 'a.wav', h(1), '', 100, UID);
		await addFile('sys', 'b.wav', h(2));

		const res = await callGet('mine');
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			total: number;
			files: Array<{ id: string; ownerOsuId: number | null; ownerName: string | null }>;
		};
		expect(body.total).toBe(1);
		expect(body.files[0].id).toBe(fid);
		expect(body.files[0].ownerOsuId).toBe(UID);
		expect(body.files[0].ownerName).toBe('u4242');

		const sys = (await (await callGet('sys')).json()) as {
			files: Array<{ ownerOsuId: number | null; ownerName: string | null }>;
		};
		expect(sys.files[0].ownerOsuId).toBeNull();
		expect(sys.files[0].ownerName).toBeNull();
	});
});

describe('PATCH /api/files（单文件改名）', () => {
	it('未登录 → 401；坏 body → 400；目标不存在 → 404', async () => {
		cookie = 'bogus';
		expect((await callPatch('x', 'n')).status).toBe(401);

		cookie = await signSession({ osuId: UID, username: 't', avatarUrl: null }, SECRET);
		await addPackage('mine', UID);
		await addBlob(h(1), 100, 1);
		const fid = await addFile('mine', 'a.wav', h(1), '', 100, UID);
		expect((await callPatch('', 'n')).status).toBe(400);
		expect((await callPatch(fid, '')).status).toBe(400);
		expect((await callPatch(fid, '  ')).status).toBe(400);
		expect((await callPatch(fid, 'x'.repeat(101))).status).toBe(400);
		expect((await callPatch(fid, 'a/b.wav')).status).toBe(400);
		expect((await callPatch(fid, 'a\\b.wav')).status).toBe(400);
		expect((await callPatch('missing-id', 'n')).status).toBe(404);
	});

	it('文件 owner 改名：落库 trim 后的名字', async () => {
		await addPackage('mine', UID);
		await addBlob(h(1), 100, 1);
		const fid = await addFile('mine', 'a.wav', h(1), '', 100, UID);

		const res = await callPatch(fid, '  b.wav  ');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		const row = await db()
			.prepare('SELECT name FROM files WHERE id = ?1')
			.bind(fid)
			.first<{ name: string }>();
		expect(row?.name).toBe('b.wav');
	});

	it('他人文件 → 403（即使是所在包的包主）；管理员 → 200', async () => {
		await addPackage('mine', UID);
		await addBlob(h(1), 100, 1);
		const fid = await addFile('mine', 'a.wav', h(1), '', 100, 888);

		expect((await callPatch(fid, 'b.wav')).status).toBe(403);

		await addUser(ADMIN_UID, 1);
		cookie = await signSession({ osuId: ADMIN_UID, username: 'mod', avatarUrl: null }, SECRET);
		expect((await callPatch(fid, 'b.wav')).status).toBe(200);
	});

	it('owner NULL（系统导入）：普通用户 403、管理员 200', async () => {
		await addPackage('sys', null);
		await addBlob(h(1), 100, 1);
		const fid = await addFile('sys', 'a.wav', h(1));

		expect((await callPatch(fid, 'b.wav')).status).toBe(403);

		await addUser(ADMIN_UID, 1);
		cookie = await signSession({ osuId: ADMIN_UID, username: 'mod', avatarUrl: null }, SECRET);
		expect((await callPatch(fid, 'b.wav')).status).toBe(200);
	});
});
