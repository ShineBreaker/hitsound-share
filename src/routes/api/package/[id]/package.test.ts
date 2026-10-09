// PATCH / DELETE /api/package/<id> 端到端：fake D1 + 内存 R2 + 签名 session
// 重点覆盖 PATCH 撞名合并（merge=true）：去重/迁移/计数重算/refcount 对齐/子请求预算
import { describe, it, expect, beforeEach } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestD1, type TestD1 } from '../../../../test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from '../../../../test/r2-memory';
import { signSession, SESSION_COOKIE } from '$lib/server/session';
import { PATCH } from './+server';

const SECRET = 'package-test-secret';
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

async function addPackage(
	id: string,
	opts: { name?: string; owner?: number; status?: string; appendTo?: string | null } = {}
): Promise<void> {
	await db()
		.prepare(
			`INSERT INTO packages (id, name, uploader_osu_id, size_bytes, logical_size, file_count, status, append_to)
			 VALUES (?1, ?2, ?3, 0, 0, 0, ?4, ?5)`
		)
		.bind(id, opts.name ?? `pkg-${id}`, opts.owner ?? UID, opts.status ?? 'visible', opts.appendTo ?? null)
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
	size = 100
): Promise<string> {
	const id = crypto.randomUUID();
	await db()
		.prepare(
			`INSERT INTO files (id, package_id, folder_path, name, format, size_bytes, blob_hash, owner_osu_id)
			 VALUES (?1, ?2, ?3, ?4, 'wav', ?5, ?6, NULL)`
		)
		.bind(id, pkg, folder, name, size, hash)
		.run();
	return id;
}

async function callPatch(id: string, body: unknown): Promise<Response> {
	return await PATCH({
		request: new Request('https://t.local/api/package/x', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}),
		platform: { env: { DB: db(), HITSOUND_FILES: r2.bucket, SESSION_SECRET: SECRET } },
		cookies: { get: (n: string) => (n === SESSION_COOKIE ? cookie : undefined) },
		params: { id },
		locals: {},
		url: new URL('https://t.local/api/package/x')
	} as unknown as Parameters<typeof PATCH>[0]);
}

async function pkgRow(
	id: string
): Promise<{ name: string; file_count: number; logical_size: number } | null> {
	return await db()
		.prepare('SELECT name, file_count, logical_size FROM packages WHERE id = ?1')
		.bind(id)
		.first<{ name: string; file_count: number; logical_size: number }>();
}

async function fileRows(
	pkg: string
): Promise<Array<{ folder_path: string; name: string; blob_hash: string }>> {
	const { results } = await db()
		.prepare('SELECT folder_path, name, blob_hash FROM files WHERE package_id = ?1 ORDER BY id')
		.bind(pkg)
		.all<{ folder_path: string; name: string; blob_hash: string }>();
	return results ?? [];
}

async function refcountOf(hash: string): Promise<number> {
	const r = await db()
		.prepare('SELECT refcount AS r FROM blobs WHERE hash = ?1')
		.bind(hash)
		.first<{ r: number }>();
	return r?.r ?? -1;
}

beforeEach(async () => {
	d1 = createTestD1();
	r2 = createMemoryR2();
	cookie = await signSession({ osuId: UID, username: 'tester', avatarUrl: null }, SECRET);
	await addUser(UID);
	await addUser(888); // 他人
});

describe('PATCH /api/package/<id>（改名回归）', () => {
	it('普通改名 200 且名变更；未登录 401；坏名 400；他人包 403；影子 pending 包 400', async () => {
		cookie = 'bogus';
		expect((await callPatch('a', { name: 'x' })).status).toBe(401);

		cookie = await signSession({ osuId: UID, username: 't', avatarUrl: null }, SECRET);
		await addPackage('a', { name: 'old' });
		expect((await callPatch('a', { name: '' })).status).toBe(400);
		expect((await callPatch('a', {})).status).toBe(400);
		const res = await callPatch('a', { name: 'new' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect((await pkgRow('a'))?.name).toBe('new');

		await addPackage('b', { name: 'theirs', owner: 888 });
		expect((await callPatch('b', { name: 'zzz' })).status).toBe(403);

		await addPackage('s', { name: 'shadow', status: 'pending', appendTo: 'a' });
		const r = await callPatch('s', { name: 'yyy' });
		expect(r.status).toBe(400);
		expect(await r.json()).toEqual({ error: 'appending_in_progress' });
	});

	it('撞名无 merge → 409 name_taken（targetId 指向同名包），两包零变更', async () => {
		await addPackage('a', { name: 'dup' });
		await addPackage('b', { name: 'other' });

		const res = await callPatch('b', { name: 'dup' });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: 'name_taken', targetId: 'a' });
		expect((await pkgRow('b'))?.name).toBe('other');
		expect(await pkgRow('a')).not.toBeNull();
	});
});

describe('PATCH /api/package/<id>（merge=true 撞名合并）', () => {
	it('本人两包合并：迁移 + 三重去重 + 计数重算 + refcount 对齐，常数子请求 ≤5', async () => {
		await db()
			.batch([
				db().prepare('INSERT INTO blobs (hash, size, mime, refcount) VALUES (?1, 100, ?2, 2)').bind(h(1), 'audio/wav'),
				db().prepare('INSERT INTO blobs (hash, size, mime, refcount) VALUES (?1, 50, ?2, 2)').bind(h(2), 'audio/wav'),
				db().prepare('INSERT INTO blobs (hash, size, mime, refcount) VALUES (?1, 30, ?2, 1)').bind(h(3), 'audio/wav'),
				db().prepare('INSERT INTO blobs (hash, size, mime, refcount) VALUES (?1, 40, ?2, 1)').bind(h(4), 'audio/wav')
			]);
		await addPackage('a', { name: 'mine' });
		await addPackage('t', { name: 'clash' });
		const dup = await addFile('a', 'a.wav', h(1), '', 100); // 与 t 三重复制 → 去重
		await addFile('a', 'b.wav', h(2), 'sub', 50); // 与 t 同名不同 hash → 并存
		await addFile('a', 'c.wav', h(3), '', 30); // 独有
		await addFile('t', 'a.wav', h(1), '', 100); // 去重判定的存活孪生行
		await addFile('t', 'a.wav', h(2), '', 50); // 同名不同 hash
		await addFile('t', 'b.wav', h(4), 'sub', 40); // 同名不同 hash

		const before = d1.calls;
		const r2Before = r2.calls.delete;
		const res = await callPatch('a', { name: 'clash', merge: true });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, merged: true, targetId: 't', deduped: [dup] });

		// 守卫(1) + 同名查靶(1) + 合并 batch(1) + 分片对齐(1)——本人目标免 isAdmin
		expect(d1.calls - before).toBeLessThanOrEqual(5);
		// 合并补清被并包 legacy original.zip：恒 1 次 R2 delete（对象不存在时幂等 no-op）
		expect(r2.calls.delete - r2Before).toBe(1);

		// 被并包行删除；目标包 5 行（三重相同的一行被丢）
		expect(await pkgRow('a')).toBeNull();
		const rows = await fileRows('t');
		expect(rows).toHaveLength(5);
		const subB = rows
			.filter((r) => r.folder_path === 'sub' && r.name === 'b.wav')
			.map((r) => r.blob_hash)
			.sort();
		expect(subB).toEqual([h(2), h(4)].sort()); // 同名不同 hash 并存

		// 目标包计数按迁移后 files 重算：100+50+30+40+50
		expect(await pkgRow('t')).toEqual({ name: 'clash', file_count: 5, logical_size: 270 });

		// settleAll 生效：refcount = visible 引用数（去重行消失后 h1 只剩 t 的一行）
		expect(await refcountOf(h(1))).toBe(1);
		expect(await refcountOf(h(2))).toBe(2);
		expect(await refcountOf(h(3))).toBe(1);
		expect(await refcountOf(h(4))).toBe(1);
	});

	it('目标为他人包且操作者非管理员 → 403，零数据变更', async () => {
		await addBlob(h(1), 100, 1);
		await addPackage('a', { name: 'mine' });
		await addPackage('t', { name: 'clash', owner: 888 });
		await addFile('a', 'x.wav', h(1));

		const res = await callPatch('a', { name: 'clash', merge: true });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'merge_target_forbidden' });
		expect((await pkgRow('a'))?.name).toBe('mine');
		expect(await pkgRow('t')).not.toBeNull();
		expect(await fileRows('a')).toHaveLength(1);
		expect(await fileRows('t')).toHaveLength(0);
	});

	it('管理员（users.is_admin）以他人包为目标合并 → 200', async () => {
		await addUser(ADMIN_UID, 1);
		cookie = await signSession({ osuId: ADMIN_UID, username: 'mod', avatarUrl: null }, SECRET);
		await addPackage('a', { name: 'src' });
		await addPackage('t', { name: 'dst', owner: 888 });
		await addBlob(h(1), 10, 1);
		await addFile('a', 'x.wav', h(1));

		const res = await callPatch('a', { name: 'dst', merge: true });
		expect(res.status).toBe(200);
		expect(await pkgRow('a')).toBeNull();
		expect(await fileRows('t')).toHaveLength(1);
	});

	it('目标为影子 visible 包（append_to 非空）→ 409 merge_target_invalid', async () => {
		await addPackage('a', { name: 'mine' });
		await addPackage('s', { name: 'clash', appendTo: 'a' }); // done 合并中断的孤儿行

		const res = await callPatch('a', { name: 'clash', merge: true });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: 'merge_target_invalid' });
		expect(await pkgRow('a')).not.toBeNull();
	});
});
