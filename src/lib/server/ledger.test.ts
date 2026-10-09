// 账本测试：releasePackage 的 refcount 回收语义 + 常数子请求预算、分片对齐（settleHashes）
import { describe, it, expect, beforeEach } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestD1, type TestD1 } from '../../test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from '../../test/r2-memory';
import { blobKey, type Env } from './media';
import {
	releasePackage,
	releaseFiles,
	settleHashes,
	alignRefcountStmts,
	selectByIds,
	committedHashes,
	reserveBlobStatements
} from './ledger';

const h = (n: number) => n.toString(16).padStart(64, '0'); // 64 位 hex 假 hash

let d1: TestD1;
let r2: MemoryR2;
let env: Env;

function db(): D1Database {
	return d1.db;
}

async function addUser(osuId: number): Promise<void> {
	await db().prepare('INSERT INTO users (osu_id, username) VALUES (?1, ?2)').bind(osuId, `u${osuId}`).run();
}

async function addPackage(
	id: string,
	opts: { owner?: number; status?: string; appendTo?: string | null } = {}
): Promise<void> {
	await db()
		.prepare(
			`INSERT INTO packages (id, name, uploader_osu_id, size_bytes, logical_size, file_count, status, append_to)
			 VALUES (?1, ?2, ?3, 0, 0, 0, ?4, ?5)`
		)
		.bind(id, `pkg-${id}`, opts.owner ?? 1, opts.status ?? 'visible', opts.appendTo ?? null)
		.run();
}

async function addBlob(hash: string, size = 100, refcount = 0, mime = 'audio/wav'): Promise<void> {
	await db()
		.prepare('INSERT OR IGNORE INTO blobs (hash, size, mime, refcount) VALUES (?1, ?2, ?3, ?4)')
		.bind(hash, size, mime, refcount)
		.run();
}

async function addFile(pkg: string, name: string, hash: string, format = 'wav', size = 100): Promise<void> {
	await db()
		.prepare(
			`INSERT INTO files (id, package_id, folder_path, name, format, size_bytes, blob_hash)
			 VALUES (?1, ?2, '', ?3, ?4, ?5, ?6)`
		)
		.bind(crypto.randomUUID(), pkg, name, format, size, hash)
		.run();
}

async function refcountOf(hash: string): Promise<number> {
	const row = await db().prepare('SELECT refcount AS r FROM blobs WHERE hash = ?1').bind(hash).first<{ r: number }>();
	return row?.r ?? -1;
}

async function blobExists(hash: string): Promise<boolean> {
	return (await db().prepare('SELECT hash FROM blobs WHERE hash = ?1').bind(hash).first()) !== null;
}

beforeEach(() => {
	d1 = createTestD1();
	r2 = createMemoryR2();
	env = { DB: d1.db, HITSOUND_FILES: r2.bucket };
});

describe('releasePackage', () => {
	it('两 visible 包共享 blob：删一个保留，删两个回收行+R2 对象', async () => {
		await addUser(1);
		await addPackage('p1');
		await addPackage('p2');
		await addBlob(h(1), 100, 2);
		await addBlob(h(2), 200, 1);
		await addFile('p1', 'a.wav', h(1));
		await addFile('p2', 'a.wav', h(1)); // 共享
		await addFile('p1', 'b.wav', h(2)); // p1 独占
		await r2.bucket.put(blobKey(h(1), 'wav'), new Uint8Array(100));
		await r2.bucket.put(blobKey(h(2), 'wav'), new Uint8Array(200));

		// 删 p1：h1 仍被 p2 引用（行+对象都在，refcount 对齐为 1），h2 独占回收
		await releasePackage(env, 'p1');
		expect(await blobExists(h(1))).toBe(true);
		expect(await refcountOf(h(1))).toBe(1);
		expect(await blobExists(h(2))).toBe(false);
		expect(r2.keys()).toContain(blobKey(h(1), 'wav'));
		expect(r2.keys()).not.toContain(blobKey(h(2), 'wav'));

		// 删 p2：h1 也回收
		await releasePackage(env, 'p2');
		expect(await blobExists(h(1))).toBe(false);
		expect(r2.keys()).not.toContain(blobKey(h(1), 'wav'));
	});

	it('被 pending 包引用的 blob 保留（files 存在性挡住删除）', async () => {
		await addUser(1);
		await addPackage('vis');
		await addPackage('pend', { status: 'pending' });
		await addBlob(h(1), 100, 1);
		await addFile('vis', 'a.wav', h(1));
		await addFile('pend', 'b.wav', h(1)); // pending 包引用同一 blob
		await r2.bucket.put(blobKey(h(1), 'wav'), new Uint8Array(100));

		await releasePackage(env, 'vis');
		expect(await blobExists(h(1))).toBe(true); // 行还在（pending files 引用）
		expect(await refcountOf(h(1))).toBe(0); // visible 引用归零
		expect(r2.keys()).toContain(blobKey(h(1), 'wav')); // 对象保留
	});

	it('既往残留的孤儿 blob 行一并回收（自愈）', async () => {
		await addUser(1);
		await addPackage('p1');
		await addBlob(h(9), 300, 0); // 孤儿行：无 files 引用、非本包
		await addBlob(h(1), 100, 1);
		await addFile('p1', 'a.wav', h(1));
		await r2.bucket.put(blobKey(h(9), 'wav'), new Uint8Array(300)); // 孤儿对象
		await r2.bucket.put(blobKey(h(1), 'wav'), new Uint8Array(100));

		await releasePackage(env, 'p1');
		expect(await blobExists(h(9))).toBe(false);
		expect(r2.keys()).not.toContain(blobKey(h(9), 'wav'));
	});

	it('2500 文件的包：releasePackage 常数子请求（≤3 D1 + ≤3 R2 delete）', async () => {
		await addUser(1);
		await addPackage('big');
		// 2500 个独占 blob + files 行（分批 batch 灌入）
		for (let i = 0; i < 2500; i += 250) {
			const stmts = [];
			for (let j = i; j < i + 250; j++) {
				stmts.push(
					db()
						.prepare('INSERT INTO blobs (hash, size, mime, refcount) VALUES (?1, 10, ?2, 1)')
						.bind(h(j), 'audio/wav'),
					db()
						.prepare(
							`INSERT INTO files (id, package_id, folder_path, name, format, size_bytes, blob_hash)
							 VALUES (?1, 'big', '', ?2, 'wav', 10, ?3)`
						)
						.bind(`f${j}`, `f${j}.wav`, h(j))
				);
			}
			await db().batch(stmts);
		}

		const d1Before = d1.calls;
		const r2Before = r2.calls.delete;
		await releasePackage(env, 'big');
		expect(d1.calls - d1Before).toBeLessThanOrEqual(3);
		expect(r2.calls.delete - r2Before).toBeLessThanOrEqual(3); // 2501 keys → ⌈/1000⌉ = 3

		// 行全部回收
		const left = await db().prepare('SELECT COUNT(*) AS c FROM blobs').first<{ c: number }>();
		expect(left?.c).toBe(0);
		expect(await db().prepare('SELECT COUNT(*) AS c FROM files').first<{ c: number }>()).toEqual({ c: 0 });
	});
});

describe('settleHashes / alignRefcountStmts（分片绝对对齐）', () => {
	it('受影响 hash 对齐为 visible 包引用数（幂等，修正偏差）；pending 不计入', async () => {
		await addUser(1);
		await addPackage('p1');
		await addPackage('pend', { status: 'pending' });
		await addBlob(h(1), 100, 99); // 错账：应为 1
		await addBlob(h(2), 100, 0);
		await addFile('p1', 'a.wav', h(1));
		await addFile('pend', 'b.wav', h(2)); // pending 不计入

		await settleHashes(db(), [h(1), h(2)]);
		expect(await refcountOf(h(1))).toBe(1);
		expect(await refcountOf(h(2))).toBe(0);

		// 重复执行幂等
		await settleHashes(db(), [h(1)]);
		expect(await refcountOf(h(1))).toBe(1);
	});

	it('只重算传入的 hash：集合外的错账保持原值（行写与受影响集合挂钩）', async () => {
		await addUser(1);
		await addPackage('p1');
		await addBlob(h(1), 100, 99); // 本次受影响：对齐修正
		await addBlob(h(9), 100, 77); // 集合外错账：不触碰
		await addFile('p1', 'a.wav', h(1));
		await addFile('p1', 'i.wav', h(9));

		await settleHashes(db(), [h(1)]);
		expect(await refcountOf(h(1))).toBe(1);
		expect(await refcountOf(h(9))).toBe(77);
	});

	it('空集合 no-op；>90 个 hash 按片拆分且全部落单 batch（1 子请求）', async () => {
		await addUser(1);
		await addPackage('p1');
		const hashes: string[] = [];
		const stmts = [];
		for (let i = 0; i < 200; i++) {
			hashes.push(h(i));
			stmts.push(
				db().prepare('INSERT INTO blobs (hash, size, mime, refcount) VALUES (?1, 10, ?2, 99)').bind(h(i), 'audio/wav'),
				db()
					.prepare(
						`INSERT INTO files (id, package_id, folder_path, name, format, size_bytes, blob_hash)
						 VALUES (?1, 'p1', '', ?2, 'wav', 10, ?3)`
					)
					.bind(`f${i}`, `f${i}.wav`, h(i))
			);
		}
		await db().batch(stmts);
		// 200 hash / 每片 90 → 3 片
		expect(alignRefcountStmts(db(), hashes)).toHaveLength(3);
		expect(alignRefcountStmts(db(), [])).toHaveLength(0);

		const before = d1.calls;
		await settleHashes(db(), hashes);
		// 3 片 ≤ 250 语句/批：恒单 batch = 1 子请求
		expect(d1.calls - before).toBe(1);
		for (let i = 0; i < 200; i += 99) expect(await refcountOf(h(i))).toBe(1);
	});
});

describe('releaseFiles（分片对齐触达面）', () => {
	it('被删文件涉及 hash 的 refcount 对齐回收；集合外错账不被重算', async () => {
		await addUser(1);
		await addPackage('p1');
		await addBlob(h(1), 100, 1); // 独占：删后归零回收
		await addBlob(h(9), 100, 77); // 集合外错账：保持
		await addFile('p1', 'a.wav', h(1));
		await addFile('p1', 'i.wav', h(9));
		await r2.bucket.put(blobKey(h(1), 'wav'), new Uint8Array(100));

		const fid = (
			await db().prepare(`SELECT id FROM files WHERE blob_hash = ?1`).bind(h(1)).first<{ id: string }>()
		)!.id;
		const deleted = await releaseFiles(env, selectByIds([fid]), ['p1']);
		expect(deleted).toBe(1);
		expect(await blobExists(h(1))).toBe(false); // 归零且无引用 → 行回收
		expect(r2.keys()).not.toContain(blobKey(h(1), 'wav'));
		expect(await refcountOf(h(9))).toBe(77); // 未受影响：不重算
	});
});

describe('committedHashes / reserveBlobStatements', () => {
	it('committedHashes 只回 refcount > 0 的 hash', async () => {
		await addBlob(h(1), 100, 1);
		await addBlob(h(2), 100, 0);
		const got = await committedHashes(db(), [h(1), h(2), h(3)]);
		expect(got).toEqual(new Set([h(1)]));
	});

	it('reserveBlobStatements 去重且幂等（INSERT OR IGNORE）', async () => {
		const stmts = reserveBlobStatements(db(), [
			{ hash: h(1), size: 10, ext: 'wav' },
			{ hash: h(1), size: 10, ext: 'wav' }, // 重复
			{ hash: h(2), size: 20, ext: 'ogg' }
		]);
		expect(stmts.length).toBe(2);
		await db().batch(stmts);
		await db().batch(reserveBlobStatements(db(), [{ hash: h(1), size: 10, ext: 'wav' }])); // 重放
		expect(await db().prepare('SELECT COUNT(*) AS c FROM blobs').first<{ c: number }>()).toEqual({
			c: 2
		});
		expect(await refcountOf(h(1))).toBe(0);
	});
});
