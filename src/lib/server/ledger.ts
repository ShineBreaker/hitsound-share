// Blob 账本模块：拥有 blobs 表 refcount 的完整生命周期（ADR 0002，绝对对齐口径）。
// - 登记：reserveBlobStatements（manifest 阶段预插 refcount=0 行，files 外键前置）
// - 秒传判定：committedHashes（refcount > 0 = 已有 done 核验过的 R2 对象，可复用）
// - 落账：settleAll（done 的全表绝对对齐，幂等可重放）
// - 回收：releasePackage（包删除 / pending 懒清理共用）、releaseFiles（文件/文件夹级删除）
//
// releasePackage 子请求预算 ≈ 2 次 D1 + ⌈回收 key 数 / 1000⌉ 次 R2——与包大小无关的
// 常数次（对齐/级联/回收用集合式 SQL 与 DELETE…RETURNING，不逐行循环）。
// 已知良性竞态：并发中的 pending 上传若在 releasePackage 的 R2 批删之前 PUT 了同 hash
// 对象，新 PUT 会被一并删掉——该上传的 done 核验随后以 blob_mismatch 失败（账本无损，
// 用户重传即可）；删除之后才发生的 PUT 则完全无害。
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { blobKey, type Env } from './media';
import { MIME_BY_EXT, type AudioExt } from './upload';

/** 全表版 refcount 对齐（done 用）：单条语句重算全部 blob——比按 hash 分片少占子请求
 *  （免费计划单请求 50 上限，大包分片 UPDATE 会各占一次），代价是每次全库行写 */
export const ALIGN_ALL_REFCOUNT_SQL =
	`UPDATE blobs SET refcount = (
	   SELECT COUNT(*) FROM files f JOIN packages p ON p.id = f.package_id
	   WHERE f.blob_hash = blobs.hash AND p.status = 'visible'
	 )`;

/** manifest 阶段的 blob 行预登记（refcount=0；同 hash 去重，OR IGNORE 幂等） */
export function reserveBlobStatements(
	db: D1Database,
	blobs: Iterable<{ hash: string; size: number; ext: AudioExt }>
): D1PreparedStatement[] {
	const seen = new Set<string>();
	const stmts: D1PreparedStatement[] = [];
	for (const b of blobs) {
		if (seen.has(b.hash)) continue;
		seen.add(b.hash);
		stmts.push(
			db.prepare(
				'INSERT OR IGNORE INTO blobs (hash, size, mime, refcount) VALUES (?1, ?2, ?3, 0)'
			).bind(b.hash, b.size, MIME_BY_EXT[b.ext])
		);
	}
	return stmts;
}

/** 已核验在库的 hash 集（refcount > 0）：分片 IN 查询合成 batch（每批 1 子请求） */
export async function committedHashes(db: D1Database, hashes: string[]): Promise<Set<string>> {
	const committed = new Set<string>();
	const stmts: D1PreparedStatement[] = [];
	for (let i = 0; i < hashes.length; i += 100) {
		const chunk = hashes.slice(i, i + 100);
		stmts.push(
			db.prepare(
				`SELECT hash FROM blobs WHERE hash IN (${chunk.map((_, j) => `?${j + 1}`).join(', ')}) AND refcount > 0`
			).bind(...chunk)
		);
	}
	for (let i = 0; i < stmts.length; i += 250) {
		const res = await db.batch(stmts.slice(i, i + 250));
		for (const r of res) {
			for (const row of (r.results ?? []) as Array<{ hash: string }>) committed.add(row.hash);
		}
	}
	return committed;
}

/** done 的 refcount 全表绝对对齐：单语句重算（幂等；行写浪费换子请求预算） */
export async function settleAll(db: D1Database): Promise<void> {
	await db.prepare(ALIGN_ALL_REFCOUNT_SQL).run();
}

/** mime → ext 反查（MIME_BY_EXT 的逆映射；历史同 hash 异 ext 对象按 mime 找回主 ext） */
const EXT_BY_MIME: Record<string, AudioExt> = Object.fromEntries(
	Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext as AudioExt])
);

/** 归零且无 files 引用的 blob 行删除并回清单（pending 包引用的行被 files 存在性挡住） */
const RECLAIM_SQL =
	`DELETE FROM blobs
	 WHERE refcount <= 0
	   AND NOT EXISTS (SELECT 1 FROM files WHERE files.blob_hash = blobs.hash)
	 RETURNING hash, mime`;

/** 回收行 → R2 key：回收行 mime 反查 ext ∪ 删除目标里见过的 format（历史异 ext 对象一并清） */
function reclaimKeys(
	rows: Array<{ hash: string; mime: string }>,
	formatsByHash: Map<string, Set<string>>
): string[] {
	const keys: string[] = [];
	for (const row of rows) {
		const exts = new Set<string>(formatsByHash.get(row.hash) ?? []);
		const mapped = EXT_BY_MIME[row.mime];
		if (mapped) exts.add(mapped);
		for (const ext of exts) keys.push(blobKey(row.hash, ext));
	}
	return keys;
}

/**
 * 删除一个包并回收其独占 blob（权限已由调用方校验）。R2 delete 幂等（对象不存在不报错）。
 * RETURNING 出的行可能包含既往崩溃残留的更早孤儿行——一并删其 R2 对象是刻意的自愈。
 */
export async function releasePackage(env: Env, packageId: string): Promise<void> {
	const { DB, HITSOUND_FILES } = env;

	// 1. 该包用过的 (hash, format)——files 行将在批内级联删除，格式集合先取出
	const { results: fmtRows } = await DB.prepare(
		'SELECT DISTINCT blob_hash AS hash, format FROM files WHERE package_id = ?1'
	)
		.bind(packageId)
		.all<{ hash: string; format: string }>();
	const formatsByHash = new Map<string, Set<string>>();
	for (const r of fmtRows ?? []) {
		let s = formatsByHash.get(r.hash);
		if (!s) formatsByHash.set(r.hash, (s = new Set()));
		s.add(r.format);
	}

	// 2. 单事务三步：本包涉及 hash 的 refcount 按「除本包外的 visible 引用数」就地重算 →
	//    删包（ON DELETE CASCADE 带 files）→ 归零且无任何 files 引用的 blob 行删除并
	//    RETURNING 回收清单（pending 包引用的行被 files 存在性挡住，不误删）
	const batchRes = await DB.batch([
		DB.prepare(
			`UPDATE blobs SET refcount = (
			   SELECT COUNT(*) FROM files f JOIN packages p ON p.id = f.package_id
			   WHERE f.blob_hash = blobs.hash AND p.status = 'visible' AND p.id <> ?1
			 )
			 WHERE hash IN (SELECT blob_hash FROM files WHERE package_id = ?1)`
		).bind(packageId),
		DB.prepare('DELETE FROM packages WHERE id = ?1').bind(packageId),
		DB.prepare(RECLAIM_SQL).bind()
	]);

	// 3. R2 对象删除：回收行 ×（mime 反查 ext ∪ 本包 files 见过的 format）+ 历史 original.zip；
	//    批量 delete 上限 1000 key/次（R2 限制）
	const keys = reclaimKeys(
		(batchRes[2]?.results ?? []) as Array<{ hash: string; mime: string }>,
		formatsByHash
	);
	keys.push(`packages/${packageId}/original.zip`);
	for (let i = 0; i < keys.length; i += 1000) {
		await HITSOUND_FILES.delete(keys.slice(i, i + 1000));
	}
}

/**
 * 文件级删除目标：clause 是 files 表 WHERE 片段（含编号占位），params 全绑定。
 * IN 列表每段 ≤90 值（D1 单语句绑定参数上限 100，留余量），目标集大时拆成多段。
 */
export interface FileSelector {
	clause: string;
	params: Array<string | number>;
}

const IN_CHUNK = 90;

/** 按文件 id 组选择器；col 供带别名的联表查询使用（如 'f.id'） */
export function selectByIds(ids: string[], col = 'id'): FileSelector[] {
	const out: FileSelector[] = [];
	for (let i = 0; i < ids.length; i += IN_CHUNK) {
		const chunk = ids.slice(i, i + IN_CHUNK);
		out.push({
			clause: `${col} IN (${chunk.map((_, j) => `?${j + 1}`).join(', ')})`,
			params: [...chunk]
		});
	}
	return out;
}

/** 按包 + folder_path 精确值集组选择器（folder_path 全值比较，不用 LIKE/GLOB） */
export function selectByFolders(packageId: string, paths: string[]): FileSelector[] {
	const out: FileSelector[] = [];
	for (let i = 0; i < paths.length; i += IN_CHUNK - 1) {
		const chunk = paths.slice(i, i + IN_CHUNK - 1); // ?1 留给 package_id
		out.push({
			clause: `package_id = ?1 AND folder_path IN (${chunk.map((_, j) => `?${j + 2}`).join(', ')})`,
			params: [packageId, ...chunk]
		});
	}
	return out;
}

/**
 * 删除一批文件行并回收其独占 blob（权限已由调用方校验）。
 * selectors 同一组条件先取 (hash, format) 集合再删除；packageIds 为受影响包，
 * 重算 file_count / logical_size（包删空后自动从树消失——/api/tree JOIN files）。
 * 子请求 ≈ ⌈selectors/250⌉ + 1 次 D1 + ⌈回收 key 数/1000⌉ 次 R2——与文件总数无关的常数次。
 */
export async function releaseFiles(
	env: Env,
	selectors: FileSelector[],
	packageIds: string[]
): Promise<number> {
	const { DB, HITSOUND_FILES } = env;

	// 1. 待删文件用过的 (hash, format)——行删前先取（R2 key 反查 ext 用）
	const formatsByHash = new Map<string, Set<string>>();
	for (let i = 0; i < selectors.length; i += 250) {
		const res = await DB.batch(
			selectors.slice(i, i + 250).map((s) =>
				DB.prepare(`SELECT DISTINCT blob_hash AS hash, format FROM files WHERE ${s.clause}`).bind(
					...s.params
				)
			)
		);
		for (const r of res) {
			for (const row of (r.results ?? []) as Array<{ hash: string; format: string }>) {
				let s = formatsByHash.get(row.hash);
				if (!s) formatsByHash.set(row.hash, (s = new Set()));
				s.add(row.format);
			}
		}
	}

	// 2. 单事务：删 files → 受影响包计数器重算 → 全表 refcount 对齐 → 归零且无引用的
	//    blob 行删除并 RETURNING 回收清单（pending 包引用被 files 存在性挡住）
	const stmts: D1PreparedStatement[] = [
		...selectors.map((s) =>
			DB.prepare(`DELETE FROM files WHERE ${s.clause}`).bind(...s.params)
		),
		...packageIds.map((pid) =>
			DB.prepare(
				`UPDATE packages SET
				   file_count = (SELECT COUNT(*) FROM files WHERE package_id = ?1),
				   logical_size = (SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE package_id = ?1)
				 WHERE id = ?1`
			).bind(pid)
		),
		DB.prepare(ALIGN_ALL_REFCOUNT_SQL),
		DB.prepare(RECLAIM_SQL)
	];
	const batchRes = await DB.batch(stmts);

	const deleted = batchRes
		.slice(0, selectors.length)
		.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);

	// 3. R2 对象删除（无 original.zip——包壳仍在，zip 由 releasePackage 负责）
	const keys = reclaimKeys(
		(batchRes[batchRes.length - 1]?.results ?? []) as Array<{ hash: string; mime: string }>,
		formatsByHash
	);
	for (let i = 0; i < keys.length; i += 1000) {
		await HITSOUND_FILES.delete(keys.slice(i, i + 1000));
	}
	return deleted;
}
