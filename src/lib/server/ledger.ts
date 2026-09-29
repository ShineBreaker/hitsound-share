// Blob 账本模块：拥有 blobs 表 refcount 的完整生命周期（ADR 0002，绝对对齐口径）。
// - 登记：reserveBlobStatements（manifest 阶段预插 refcount=0 行，files 外键前置）
// - 秒传判定：committedHashes（refcount > 0 = 已有 done 核验过的 R2 对象，可复用）
// - 落账：settleAll（done 的全表绝对对齐，幂等可重放）
// - 回收：releasePackage（包删除 / pending 懒清理共用）
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
		DB.prepare(
			`DELETE FROM blobs
			 WHERE refcount <= 0
			   AND NOT EXISTS (SELECT 1 FROM files WHERE files.blob_hash = blobs.hash)
			 RETURNING hash, mime`
		).bind()
	]);

	// 3. R2 对象删除：回收行 ×（mime 反查 ext ∪ 本包 files 见过的 format）+ 历史 original.zip；
	//    批量 delete 上限 1000 key/次（R2 限制）
	const keys: string[] = [];
	for (const row of (batchRes[2]?.results ?? []) as Array<{ hash: string; mime: string }>) {
		const exts = new Set<string>(formatsByHash.get(row.hash) ?? []);
		const mapped = EXT_BY_MIME[row.mime];
		if (mapped) exts.add(mapped);
		for (const ext of exts) keys.push(blobKey(row.hash, ext));
	}
	keys.push(`packages/${packageId}/original.zip`);
	for (let i = 0; i < keys.length; i += 1000) {
		await HITSOUND_FILES.delete(keys.slice(i, i + 1000));
	}
}
