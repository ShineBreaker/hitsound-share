// /api/upload/done 端到端：fake D1（node:sqlite）+ 内存 R2 + 签名 session
import { describe, it, expect, beforeEach } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestD1, type TestD1 } from '../../../../test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from '../../../../test/r2-memory';
import { signSession, SESSION_COOKIE } from '$lib/server/session';
import { blobKey } from '$lib/server/media';
import { POST } from './+server';

const SECRET = 'done-test-secret';
const UID = 4242;
const h = (n: number) => n.toString(16).padStart(64, '0');

let d1: TestD1;
let r2: MemoryR2;
let cookie: string;

function db(): D1Database {
	return d1.db;
}

function wavBytes(size: number): Uint8Array {
	const d = new Uint8Array(size);
	[0x52, 0x49, 0x46, 0x46].forEach((b, i) => (d[i] = b)); // RIFF
	return d;
}

async function addBlob(hash: string, size: number, refcount: number, mime = 'audio/wav') {
	await db()
		.prepare('INSERT OR IGNORE INTO blobs (hash, size, mime, refcount) VALUES (?1, ?2, ?3, ?4)')
		.bind(hash, size, mime, refcount)
		.run();
}

async function addFile(
	pkg: string,
	name: string,
	hash: string,
	folder = '',
	format = 'wav',
	size = 100,
	owner: number | null = UID
) {
	await db()
		.prepare(
			`INSERT INTO files (id, package_id, folder_path, name, format, size_bytes, blob_hash, owner_osu_id)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
		)
		.bind(crypto.randomUUID(), pkg, folder, name, format, size, hash, owner)
		.run();
}

async function addPackage(
	id: string,
	opts: { status?: string; appendTo?: string | null; owner?: number } = {}
) {
	await db()
		.prepare(
			`INSERT INTO packages (id, name, uploader_osu_id, size_bytes, logical_size, file_count, status, append_to)
			 VALUES (?1, ?2, ?3, 0, 0, 0, ?4, ?5)`
		)
		.bind(id, `pkg-${id}`, opts.owner ?? UID, opts.status ?? 'visible', opts.appendTo ?? null)
		.run();
}

async function callDone(packageId: string): Promise<Response> {
	return await POST({
		request: new Request('https://t.local/api/upload/done', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ packageId })
		}),
		platform: {
			env: { DB: db(), HITSOUND_FILES: r2.bucket, SESSION_SECRET: SECRET }
		},
		cookies: { get: (n: string) => (n === SESSION_COOKIE ? cookie : undefined) },
		params: {},
		locals: {},
		url: new URL('https://t.local/api/upload/done')
	} as unknown as Parameters<typeof POST>[0]);
}

beforeEach(async () => {
	d1 = createTestD1();
	r2 = createMemoryR2();
	cookie = await signSession({ osuId: UID, username: 'tester', avatarUrl: null }, SECRET);
	await db()
		.prepare('INSERT INTO users (osu_id, username) VALUES (?1, ?2)')
		.bind(UID, 'tester')
		.run();
});

describe('POST /api/upload/done', () => {
	it('未登录 → 401', async () => {
		cookie = 'bogus';
		const res = await callDone('whatever');
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'not_logged_in' });
	});

	it('pending → visible：committed（refcount>0，不打 R2）+ fresh（ranged GET）混合', async () => {
		// committed blob：账本 refcount=1，无 R2 对象也应通过（已核验过的可信行）
		await addBlob(h(1), 100, 1);
		// fresh blob：refcount=0，R2 有对象且大小/魔数正确（files.size_bytes 须与对象一致）
		await addBlob(h(2), 64, 0);
		await r2.bucket.put(blobKey(h(2), 'wav'), wavBytes(64));
		await addPackage('pk');
		await db()
			.prepare(`UPDATE packages SET status = 'pending' WHERE id = 'pk'`)
			.run();
		await addFile('pk', 'a.wav', h(1));
		await addFile('pk', 'b.wav', h(2), '', 'wav', 64);

		const res = await callDone('pk');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });

		const pkg = await db()
			.prepare(`SELECT status FROM packages WHERE id = 'pk'`)
			.first<{ status: string }>();
		expect(pkg?.status).toBe('visible');
		// refcount 对齐：两个 blob 各被 1 个 visible 引用
		for (const i of [1, 2]) {
			const r = await db()
				.prepare('SELECT refcount AS r FROM blobs WHERE hash = ?1')
				.bind(h(i))
				.first<{ r: number }>();
			expect(r?.r).toBe(1);
		}
		// 只有 fresh blob 打了 R2（ranged get）；committed 的没有
		expect(r2.ops.filter((o) => o.startsWith('get:'))).toEqual([`get:${blobKey(h(2), 'wav')}`]);
	});

	it('committed blob 声明大小与账本不一致 → 400 blob_mismatch（不打 R2）', async () => {
		await addBlob(h(1), 100, 1);
		await addPackage('pk', { status: 'pending' });
		await addFile('pk', 'a.wav', h(1), '', 'wav', 999); // 声明 999 ≠ 账本 100

		const res = await callDone('pk');
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; bad: string[] };
		expect(body.error).toBe('blob_mismatch');
		expect(body.bad).toEqual([h(1)]);
		expect(r2.calls.get + r2.calls.list).toBe(0); // 完全没打 R2
	});

	it('fresh 核验失败 → 400 且坏对象即时从 R2 删除（不等懒清理）', async () => {
		// fresh blob：R2 对象大小与声明不符（拿预签名 URL 直传了超标/错误字节的场景）
		await addBlob(h(1), 100, 0);
		await addBlob(h(2), 64, 0);
		await r2.bucket.put(blobKey(h(1), 'wav'), wavBytes(50)); // 声明 100，实存 50
		await r2.bucket.put(blobKey(h(2), 'wav'), wavBytes(64)); // 合格
		await addPackage('pk', { status: 'pending' });
		await addFile('pk', 'bad.wav', h(1), '', 'wav', 100);
		await addFile('pk', 'ok.wav', h(2), '', 'wav', 64);

		const res = await callDone('pk');
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; bad: string[] };
		expect(body.bad).toEqual([h(1)]);
		// 只有坏对象被删；合格对象保留（成功重试路径无需重传）
		expect(r2.keys()).not.toContain(blobKey(h(1), 'wav'));
		expect(r2.keys()).toContain(blobKey(h(2), 'wav'));
	});

	it('committed 坏 blob 不删 R2 对象（可能被其他 visible 包引用）', async () => {
		await addBlob(h(1), 100, 1); // committed：账本声明不符 → bad，但对象归属他人引用
		await r2.bucket.put(blobKey(h(1), 'wav'), wavBytes(100));
		await addPackage('pk', { status: 'pending' });
		await addFile('pk', 'a.wav', h(1), '', 'wav', 999);

		const res = await callDone('pk');
		expect(res.status).toBe(400);
		expect(r2.keys()).toContain(blobKey(h(1), 'wav')); // 不删
	});

	it('已 visible 且非影子包重放 → 200 幂等短路（不触发核验与账本写）', async () => {
		await addBlob(h(1), 100, 99); // 错账：短路意味着不做对齐，保持原值
		await addPackage('pk', { status: 'visible' });
		await addFile('pk', 'a.wav', h(1));
		await r2.bucket.put(blobKey(h(1), 'wav'), wavBytes(50)); // 即使对象异常也不核验

		const res = await callDone('pk');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(r2.calls.get + r2.calls.list).toBe(0); // 不核验
		const r = await db()
			.prepare('SELECT refcount AS r FROM blobs WHERE hash = ?1')
			.bind(h(1))
			.first<{ r: number }>();
		expect(r?.r).toBe(99); // 未对齐
	});

	it('附加合并：三重复制行去重 + 目标包计数重算 + 影子包删除', async () => {
		// 目标包 T（visible，属本人）已有 a.wav(h1)、b.wav(h2)
		await addBlob(h(1), 100, 1);
		await addBlob(h(2), 100, 1);
		await addPackage('T');
		await addFile('T', 'a.wav', h(1));
		await addFile('T', 'b.wav', h(2));
		// 影子包 S（pending，append_to=T）：一条与 T 三重复制（同 folder/name/hash），一条新增 c.wav
		await addBlob(h(3), 32, 0);
		await r2.bucket.put(blobKey(h(3), 'wav'), wavBytes(32));
		await addPackage('S', { status: 'pending', appendTo: 'T' });
		await addFile('S', 'a.wav', h(1)); // 与 T 的三重复制行
		await addFile('S', 'c.wav', h(3), 'sub', 'wav', 32);

		const res = await callDone('S');
		expect(res.status).toBe(200);

		// 影子包已删；T 的文件 = a、b、c（去重后 3 行）
		expect(await db().prepare(`SELECT id FROM packages WHERE id = 'S'`).first()).toBeNull();
		const cnt = await db()
			.prepare(`SELECT COUNT(*) AS c FROM files WHERE package_id = 'T'`)
			.first<{ c: number }>();
		expect(cnt?.c).toBe(3);
		const pkg = await db()
			.prepare(`SELECT file_count FROM packages WHERE id = 'T'`)
			.first<{ file_count: number }>();
		expect(pkg?.file_count).toBe(3);
		// h1 refcount 仍为 1（去重后只剩 T 的一行引用）
		const r = await db()
			.prepare('SELECT refcount AS r FROM blobs WHERE hash = ?1')
			.bind(h(1))
			.first<{ r: number }>();
		expect(r?.r).toBe(1);
		// 合并只迁 package_id：文件级 owner 保留（= 影子包上传者，即附加者本人）
		const migrated = await db()
			.prepare(`SELECT owner_osu_id AS o FROM files WHERE package_id = 'T' AND name = 'c.wav'`)
			.first<{ o: number | null }>();
		expect(migrated?.o).toBe(UID);
	});

	it('他人包 / 不存在包 → 404 package_not_found', async () => {
		await db()
			.prepare('INSERT INTO users (osu_id, username) VALUES (?1, ?2)')
			.bind(999, 'other')
			.run();
		await addPackage('other', { owner: 999 });
		expect((await callDone('other')).status).toBe(404);
		expect((await callDone('nope')).status).toBe(404);
	});
});
