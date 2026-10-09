// POST /api/files/move 端到端：fake D1 + 内存 R2 + 签名 session
// 覆盖文件/小类两种模式：校验、权限、路径重写（含 toFolder='' 的 CASE 特判）、
// 三重去重（含「已在目标位置」的自匹配回归）、计数重算、refcount 对齐、子请求预算
import { describe, it, expect, beforeEach } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestD1, type TestD1 } from '../../../../test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from '../../../../test/r2-memory';
import { signSession, SESSION_COOKIE } from '$lib/server/session';
import { POST } from './+server';

const SECRET = 'move-test-secret';
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
	opts: { owner?: number; status?: string; appendTo?: string | null } = {}
): Promise<void> {
	await db()
		.prepare(
			`INSERT INTO packages (id, name, uploader_osu_id, size_bytes, logical_size, file_count, status, append_to)
			 VALUES (?1, ?2, ?3, 0, 0, 0, ?4, ?5)`
		)
		.bind(id, `pkg-${id}`, opts.owner ?? UID, opts.status ?? 'visible', opts.appendTo ?? null)
		.run();
}

async function addBlob(hash: string, size = 10, refcount = 1): Promise<void> {
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
	size = 10,
	owner: number | null = UID
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

async function callMove(body: unknown): Promise<Response> {
	return await POST({
		request: new Request('https://t.local/api/files/move', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}),
		platform: { env: { DB: db(), HITSOUND_FILES: r2.bucket, SESSION_SECRET: SECRET } },
		cookies: { get: (n: string) => (n === SESSION_COOKIE ? cookie : undefined) },
		params: {},
		locals: {},
		url: new URL('https://t.local/api/files/move')
	} as unknown as Parameters<typeof POST>[0]);
}

async function fileCount(pkg: string): Promise<number> {
	const r = await db()
		.prepare('SELECT COUNT(*) AS c FROM files WHERE package_id = ?1')
		.bind(pkg)
		.first<{ c: number }>();
	return r?.c ?? -1;
}

async function pkgCounts(pkg: string): Promise<{ c: number; s: number }> {
	const r = await db()
		.prepare('SELECT file_count AS c, logical_size AS s FROM packages WHERE id = ?1')
		.bind(pkg)
		.first<{ c: number; s: number }>();
	return { c: r?.c ?? -1, s: r?.s ?? -1 };
}

async function filesOf(
	pkg: string
): Promise<Array<{ folder_path: string; name: string; blob_hash: string }>> {
	const { results } = await db()
		.prepare('SELECT folder_path, name, blob_hash FROM files WHERE package_id = ?1 ORDER BY name')
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

describe('POST /api/files/move（文件模式）', () => {
	it('未登录 → 401', async () => {
		cookie = 'bogus';
		expect((await callMove({ ids: ['x'], toPackage: 't', toFolder: '' })).status).toBe(401);
	});

	it('坏 body → 400：空 ids / 超 500 / 缺 toPackage / 双模式 / 无模式 / fromFolder 空 / 非法 toFolder', async () => {
		expect((await callMove({ ids: [], toPackage: 't', toFolder: '' })).status).toBe(400);
		expect((await callMove({ ids: Array(501).fill('x'), toPackage: 't', toFolder: '' })).status).toBe(400);
		expect((await callMove({ ids: ['x'], toPackage: 't', toFolder: '../x' })).status).toBe(400);
		expect((await callMove({ ids: ['x'], toPackage: 't', toFolder: '/abs' })).status).toBe(400);
		expect((await callMove({ ids: ['x'] })).status).toBe(400);
		expect((await callMove({ ids: ['x'], fromPackage: 'a', toPackage: 't', toFolder: '' })).status).toBe(400);
		expect((await callMove({})).status).toBe(400);
		expect((await callMove({ fromPackage: 'a', fromFolder: '', toPackage: 't', toFolder: '' })).status).toBe(400);
	});

	it('ids 均不存在 → 404 not_found', async () => {
		await addPackage('t');
		expect((await callMove({ ids: ['nope'], toPackage: 't', toFolder: '' })).status).toBe(404);
	});

	it('非 owner 且非管理员 → 403 且文件行原位未动', async () => {
		await addPackage('theirs', { owner: 888 });
		await addPackage('t');
		await addBlob(h(1));
		const fid = await addFile('theirs', 'a.wav', h(1), '', 10, 888);

		const res = await callMove({ ids: [fid], toPackage: 't', toFolder: '' });
		expect(res.status).toBe(403);
		const row = await db()
			.prepare('SELECT package_id AS p, folder_path AS f FROM files WHERE id = ?1')
			.bind(fid)
			.first<{ p: string; f: string }>();
		expect(row).toEqual({ p: 'theirs', f: '' });
	});

	it('owner 是本人 → 移动成功（package_id 与 folder_path 均变）+ 源/目标计数重算', async () => {
		// 文件级归属与包主解耦：他人包里自己上传的文件可移（对齐 DELETE /api/files）
		await addPackage('p1', { owner: 888 });
		await addPackage('t');
		await addBlob(h(1), 100);
		const fid = await addFile('p1', 'a.wav', h(1), 'src', 100, UID);

		const res = await callMove({ ids: [fid], toPackage: 't', toFolder: 'dest' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, moved: 1, deduped: [] });
		const row = await db()
			.prepare('SELECT package_id AS p, folder_path AS f FROM files WHERE id = ?1')
			.bind(fid)
			.first<{ p: string; f: string }>();
		expect(row).toEqual({ p: 't', f: 'dest' });
		expect(await pkgCounts('p1')).toEqual({ c: 0, s: 0 });
		expect(await pkgCounts('t')).toEqual({ c: 1, s: 100 });
	});

	it('移到他人包（非管理员）→ 403；目标不存在 → 404；目标 pending/影子 → 409 bad_target', async () => {
		await addPackage('p1');
		await addBlob(h(1));
		const fid = await addFile('p1', 'a.wav', h(1), '', 10, UID);

		await addPackage('t2', { owner: 888 });
		expect((await callMove({ ids: [fid], toPackage: 't2', toFolder: '' })).status).toBe(403);
		expect((await callMove({ ids: [fid], toPackage: 'nope', toFolder: '' })).status).toBe(404);

		await addPackage('pend', { status: 'pending' });
		expect((await callMove({ ids: [fid], toPackage: 'pend', toFolder: '' })).status).toBe(409);
		await addPackage('shadow', { appendTo: 'p1' });
		expect((await callMove({ ids: [fid], toPackage: 'shadow', toFolder: '' })).status).toBe(409);
	});

	it('三重去重：deduped 回传 + moved 不含去重行 + refcount 对齐', async () => {
		await addPackage('s');
		await addPackage('t');
		await addBlob(h(1), 100, 2);
		await addBlob(h(2), 50, 1);
		const dup = await addFile('s', 'a.wav', h(1), '', 100, UID); // t 已有三重相同
		const keep = await addFile('s', 'b.wav', h(2), '', 50, UID);
		await addFile('t', 'a.wav', h(1), 'dest', 100, UID);

		const res = await callMove({ ids: [dup, keep], toPackage: 't', toFolder: 'dest' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, moved: 1, deduped: [dup] });

		const rows = await filesOf('t');
		expect(rows).toHaveLength(2); // 原有 a.wav + 移入 b.wav；同三重的 a.wav 被丢
		expect(rows.find((r) => r.name === 'b.wav')).toMatchObject({ folder_path: 'dest' });
		expect(await pkgCounts('t')).toEqual({ c: 2, s: 150 });
		expect(await pkgCounts('s')).toEqual({ c: 0, s: 0 });
		expect(await refcountOf(h(1))).toBe(1);
		expect(await refcountOf(h(2))).toBe(1);
	});

	it('已在目标位置的文件 no-op 存活（去重 EXISTS 排除候选行自身）', async () => {
		await addPackage('t');
		await addBlob(h(1), 100);
		const self = await addFile('t', 'a.wav', h(1), 'dest', 100, UID);

		const res = await callMove({ ids: [self], toPackage: 't', toFolder: 'dest' });
		expect(res.status).toBe(200);
		// moved=1：SQLite changes 计 WHERE 命中行（原地未动也计）；关键是行不被误删
		expect(await res.json()).toEqual({ ok: true, moved: 1, deduped: [] });
		const row = await db()
			.prepare('SELECT package_id AS p, folder_path AS f FROM files WHERE id = ?1')
			.bind(self)
			.first<{ p: string; f: string }>();
		expect(row).toEqual({ p: 't', f: 'dest' });
		expect(await refcountOf(h(1))).toBe(1);
	});

	it('选中集含目标位孪生行：恰留一行，deduped 只含被删者（修复前两行全灭）', async () => {
		await addPackage('s');
		await addPackage('t');
		await addBlob(h(1), 100, 2);
		const a = await addFile('s', 'a.wav', h(1), '', 100, UID);
		const b = await addFile('t', 'a.wav', h(1), 'dest', 100, UID); // 与 a 三重相同且已在目标位

		const res = await callMove({ ids: [a, b], toPackage: 't', toFolder: 'dest' });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { moved: number; deduped: string[] };
		expect(body.deduped).toHaveLength(1); // 只许删其一
		expect([a, b]).toContain(body.deduped[0]);
		const survivors =
			(
				await db()
					.prepare(
						`SELECT id FROM files
						 WHERE package_id = 't' AND folder_path = 'dest' AND name = 'a.wav' AND blob_hash = ?1`
					)
					.bind(h(1))
					.all<{ id: string }>()
			).results ?? [];
		expect(survivors).toHaveLength(1);
		expect(survivors[0]!.id).not.toBe(body.deduped[0]);
		// 存活行原地未动，迁移语句仍命中 → changes 计 1（moved 语义 = 迁移语句触及行数）
		expect(body.moved).toBe(1);
		expect(await refcountOf(h(1))).toBe(1);
	});

	it('多源包大批量：计数重算合并为 IN 分片，主事务恒单批（3 次 D1）', async () => {
		// 500 个 id 分属 400 个源包 → 受影响包 401：旧的 per-package recount（401 条）
		// 撑破 250 语句/批把主事务拆成多批；合并分片后主事务 18 条恒单批
		await addPackage('t');
		for (let i = 0; i < 400; i += 250) {
			const stmts = [];
			for (let j = i; j < Math.min(i + 250, 400); j++) {
				stmts.push(
					db()
						.prepare(
							`INSERT INTO packages (id, name, uploader_osu_id, size_bytes, logical_size, file_count, status, append_to)
							 VALUES (?1, ?2, ?3, 0, 0, 0, 'visible', NULL)`
						)
						.bind(`p${j}`, `pkg-p${j}`, UID)
				);
			}
			await db().batch(stmts);
		}
		const ids: string[] = [];
		for (let i = 0; i < 500; i += 250) {
			const stmts = [];
			for (let j = i; j < Math.min(i + 250, 500); j++) {
				stmts.push(
					db().prepare('INSERT INTO blobs (hash, size, mime, refcount) VALUES (?1, 10, ?2, 1)').bind(h(j), 'audio/wav'),
					db()
						.prepare(
							`INSERT INTO files (id, package_id, folder_path, name, format, size_bytes, blob_hash, owner_osu_id)
							 VALUES (?1, ?2, '', ?3, 'wav', 10, ?4, ?5)`
						)
						.bind(`f${j}`, `p${j % 400}`, `f${j}.wav`, h(j), UID)
				);
				ids.push(`f${j}`);
			}
			await db().batch(stmts);
		}

		const d1Before = d1.calls;
		const res = await callMove({ ids, toPackage: 't', toFolder: '' });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { moved: number }).moved).toBe(500);
		// 目标守卫(1) + 归属查询(1 batch) + 主事务(1 batch)——拆批时会是 4 次
		expect(d1.calls - d1Before).toBe(3);
		// 合并 recount 与逐包等价：源包清零、目标包全量
		expect(await pkgCounts('p0')).toEqual({ c: 0, s: 0 });
		expect(await pkgCounts('p399')).toEqual({ c: 0, s: 0 });
		expect(await pkgCounts('t')).toEqual({ c: 500, s: 5000 });
	});

	it('refcount 只对齐本次受影响 hash：移动集外的错账保持原值', async () => {
		await addPackage('s');
		await addPackage('t');
		await addBlob(h(1), 100, 1); // 受影响：对齐
		await addBlob(h(9), 100, 77); // 错账但不在移动集：分片对齐不触碰
		const fid = await addFile('s', 'a.wav', h(1), '', 100, UID);
		await addFile('s', 'z.wav', h(9), '', 100, UID); // 不移动

		const res = await callMove({ ids: [fid], toPackage: 't', toFolder: '' });
		expect(res.status).toBe(200);
		expect(await refcountOf(h(1))).toBe(1);
		expect(await refcountOf(h(9))).toBe(77);
	});

	it('同名不同 hash 并存', async () => {
		await addPackage('s');
		await addPackage('t');
		await addBlob(h(1), 100);
		await addBlob(h(2), 50);
		await addFile('t', 'a.wav', h(1), 'dest', 100, UID);
		const fid = await addFile('s', 'a.wav', h(2), '', 50, UID);

		const res = await callMove({ ids: [fid], toPackage: 't', toFolder: 'dest' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, moved: 1, deduped: [] });
		const hashes = (await filesOf('t')).filter((r) => r.name === 'a.wav').map((r) => r.blob_hash).sort();
		expect(hashes).toEqual([h(1), h(2)].sort());
	});

	it('管理员移动他人文件 → 200，多源包各自计数重算', async () => {
		await addUser(ADMIN_UID, 1);
		cookie = await signSession({ osuId: ADMIN_UID, username: 'mod', avatarUrl: null }, SECRET);
		await addPackage('p1', { owner: 888 });
		await addPackage('p2', { owner: 888 });
		await addPackage('t', { owner: ADMIN_UID });
		await addBlob(h(1), 10);
		await addBlob(h(2), 20);
		const f1 = await addFile('p1', 'a.wav', h(1), '', 10, 888);
		const f2 = await addFile('p2', 'b.wav', h(2), 'x', 20, 888);

		const res = await callMove({ ids: [f1, f2], toPackage: 't', toFolder: '' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, moved: 2, deduped: [] });
		expect(await pkgCounts('p1')).toEqual({ c: 0, s: 0 });
		expect(await pkgCounts('p2')).toEqual({ c: 0, s: 0 });
		expect(await pkgCounts('t')).toEqual({ c: 2, s: 30 });
	});

	it('300 ids 常数子请求（≤6 D1）且不触 R2', async () => {
		await addPackage('big');
		await addPackage('t');
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
		const res = await callMove({ ids, toPackage: 't', toFolder: '' });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { moved: number }).moved).toBe(300);
		// 目标守卫(1) + 归属查询(1 batch) + 主事务(1 batch)——全为本人文件免 isAdmin
		expect(d1.calls - d1Before).toBeLessThanOrEqual(6);
		expect(r2.calls.delete - r2Before).toBe(0); // 移动不删 blob 对象
		expect(await fileCount('big')).toBe(0);
		expect(await fileCount('t')).toBe(300);
	});
});

describe('POST /api/files/move（小类模式）', () => {
	it("toFolder=''：移到目标包根，'a'→''、'a/b'→'b'，无前导 '/'", async () => {
		await addPackage('s');
		await addPackage('t');
		await addBlob(h(1), 10);
		await addBlob(h(2), 10);
		await addFile('s', 'x.wav', h(1), 'a', 10, UID);
		await addFile('s', 'y.wav', h(2), 'a/b', 10, UID);

		const res = await callMove({ fromPackage: 's', fromFolder: 'a', toPackage: 't', toFolder: '' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, moved: 2, deduped: [] });
		const rows = await filesOf('t');
		expect(rows.find((r) => r.name === 'x.wav')).toMatchObject({ folder_path: '' });
		expect(rows.find((r) => r.name === 'y.wav')).toMatchObject({ folder_path: 'b' });
		expect(rows.every((r) => !r.folder_path.startsWith('/'))).toBe(true);
		expect(await pkgCounts('s')).toEqual({ c: 0, s: 0 });
		expect(await pkgCounts('t')).toEqual({ c: 2, s: 20 });
	});

	it("toFolder='c'：'a'→'c'、'a/b'→'c/b'", async () => {
		await addPackage('s');
		await addPackage('t');
		await addBlob(h(1), 10);
		await addBlob(h(2), 10);
		await addFile('s', 'x.wav', h(1), 'a', 10, UID);
		await addFile('s', 'y.wav', h(2), 'a/b', 10, UID);

		const res = await callMove({ fromPackage: 's', fromFolder: 'a', toPackage: 't', toFolder: 'c' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, moved: 2, deduped: [] });
		const rows = await filesOf('t');
		expect(rows.find((r) => r.name === 'x.wav')).toMatchObject({ folder_path: 'c' });
		expect(rows.find((r) => r.name === 'y.wav')).toMatchObject({ folder_path: 'c/b' });
	});

	it('空小类（无匹配行）→ 404 folder_not_found', async () => {
		await addPackage('s');
		await addPackage('t');
		await addBlob(h(1), 10);
		await addFile('s', 'x.wav', h(1), '', 10, UID); // 在包根，不在 'nope'

		expect(
			(await callMove({ fromPackage: 's', fromFolder: 'nope', toPackage: 't', toFolder: '' })).status
		).toBe(404);
	});

	it('小类内混合 owner（含他人文件）非管理员 → 403 全不动', async () => {
		await addPackage('s');
		await addPackage('t');
		await addBlob(h(1), 10);
		await addBlob(h(2), 10);
		await addFile('s', 'mine.wav', h(1), 'a', 10, UID);
		await addFile('s', 'theirs.wav', h(2), 'a', 10, 888);

		const res = await callMove({ fromPackage: 's', fromFolder: 'a', toPackage: 't', toFolder: '' });
		expect(res.status).toBe(403);
		const rows = await filesOf('s');
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.folder_path === 'a')).toBe(true);
		expect(await fileCount('t')).toBe(0);
	});

	it('目标已有同名小类 = 合并：三重去重生效 + refcount 对齐', async () => {
		await addPackage('s');
		await addPackage('t');
		await addBlob(h(1), 10, 2);
		await addBlob(h(2), 20, 1);
		const dup = await addFile('s', 'same.wav', h(1), 'a', 10, UID);
		await addFile('s', 'new.wav', h(2), 'a', 20, UID);
		await addFile('t', 'same.wav', h(1), 'c', 10, UID);

		const res = await callMove({ fromPackage: 's', fromFolder: 'a', toPackage: 't', toFolder: 'c' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, moved: 1, deduped: [dup] });
		const rows = await filesOf('t');
		expect(rows).toHaveLength(2);
		expect(rows.find((r) => r.name === 'new.wav')).toMatchObject({ folder_path: 'c' });
		expect(await refcountOf(h(1))).toBe(1);
		expect(await refcountOf(h(2))).toBe(1);
		expect(await pkgCounts('s')).toEqual({ c: 0, s: 0 });
		expect(await pkgCounts('t')).toEqual({ c: 2, s: 30 });
	});

	it('同包同名/子树目标 → 400 bad_folder（零变更）', async () => {
		await addPackage('s');
		await addBlob(h(1), 10);
		await addFile('s', 'x.wav', h(1), 'a', 10, UID);

		expect((await callMove({ fromPackage: 's', fromFolder: 'a', toPackage: 's', toFolder: 'a' })).status).toBe(400);
		expect((await callMove({ fromPackage: 's', fromFolder: 'a', toPackage: 's', toFolder: 'a/b' })).status).toBe(400);
		expect((await filesOf('s'))[0]).toMatchObject({ folder_path: 'a' });
	});

	it('跨包子树目标不拒：同形路径落到另一包合法', async () => {
		await addPackage('s');
		await addPackage('t');
		await addBlob(h(1), 10);
		await addFile('s', 'x.wav', h(1), 'a', 10, UID);

		const res = await callMove({ fromPackage: 's', fromFolder: 'a', toPackage: 't', toFolder: 'a/b' });
		expect(res.status).toBe(200);
		expect((await filesOf('t'))[0]).toMatchObject({ folder_path: 'a/b', name: 'x.wav' });
	});
});
