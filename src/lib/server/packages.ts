// 包删除治理（上传者删自己的 / 管理员删任意）：
// D1 事务性清理（对齐 refcount → 级联删 files/package）→ 归零 blob 与 zip 的 R2 对象删除。
// pending 懒清理复用同一路径（对齐口径一致：refcount = 全库 visible 包对该 blob 的引用数）
import type { Env } from './media';

/** refcount 绝对对齐：置为全库 visible 包对该 hash 的引用数（幂等，可重放，自愈历史偏差） */
export const ALIGN_REFCOUNT_SQL =
	`UPDATE blobs SET refcount = (
	   SELECT COUNT(*) FROM files f JOIN packages p ON p.id = f.package_id
	   WHERE f.blob_hash = blobs.hash AND p.status = 'visible'
	 )
	 WHERE hash = ?1`;

export interface PackageRow {
	id: string;
	name: string;
	uploader_osu_id: number | null;
	status: string;
	size_bytes: number;
}

export async function getPackage(db: Env['DB'], id: string): Promise<PackageRow | null> {
	return await db
		.prepare('SELECT id, name, uploader_osu_id, status, size_bytes FROM packages WHERE id = ?1')
		.bind(id)
		.first<PackageRow>();
}

/**
 * 删除一个包。权限已由调用方校验。
 * 返回 { ok } 或 { error }；R2 delete 幂等（对象不存在不报错）。
 */
export async function purgePackage(env: Env, packageId: string): Promise<{ ok: true } | { error: string }> {
	const { DB, HITSOUND_FILES } = env;

	// 1. 先取该包用到的 (hash, ext)——files 行马上要被级联删除，之后无从查起
	const { results: blobRows } = await DB.prepare(
		'SELECT DISTINCT blob_hash AS hash, format FROM files WHERE package_id = ?1'
	)
		.bind(packageId)
		.all<{ hash: string; format: string }>();

	// 2. 删包（ON DELETE CASCADE 带 files）
	await DB.prepare('DELETE FROM packages WHERE id = ?1').bind(packageId).run();

	// 3. 对该包涉及的全部 hash 做 refcount 绝对对齐（此时该包已不在计数内；分片 batch，
	//    对齐幂等，批间失败重放无副作用）
	const alignStmts = (blobRows ?? []).map((r) => DB.prepare(ALIGN_REFCOUNT_SQL).bind(r.hash));
	for (let i = 0; i < alignStmts.length; i += 50) {
		await DB.batch(alignStmts.slice(i, i + 50));
	}

	// 4. 清「归零且已无任何 files 引用」的 blob 行 + 对应 R2 对象。
	//    归零但被其他 pending 包引用的行不能删（files 外键约束），留待其自身清理
	const zeroSql =
		'SELECT hash FROM blobs WHERE refcount <= 0 AND NOT EXISTS (SELECT 1 FROM files WHERE files.blob_hash = blobs.hash)';
	const { results: zeroed } = await DB.prepare(zeroSql).all<{ hash: string }>();
	const zeroSet = new Set((zeroed ?? []).map((r) => r.hash));
	if (zeroSet.size > 0) {
		await DB.prepare(
			'DELETE FROM blobs WHERE refcount <= 0 AND NOT EXISTS (SELECT 1 FROM files WHERE files.blob_hash = blobs.hash)'
		).run();
	}
	for (const row of blobRows ?? []) {
		if (zeroSet.has(row.hash)) {
			// key 由服务端生成的 hash/ext 组成，无用户可控字符
			await HITSOUND_FILES.delete(`blobs/${row.hash.slice(0, 2)}/${row.hash}.${row.format}`);
		}
	}

	// 5. 删整包 zip（无 zip 的历史导入包：delete 幂等）
	await HITSOUND_FILES.delete(`packages/${packageId}/original.zip`);
	return { ok: true };
}

/** 懒清理：全站扫描超 24h 的 pending 包（他人弃单也回收，防占死水位；每次至多 20 个） */
export async function lazyCleanupPending(env: Env): Promise<number> {
	const { results } = await env.DB.prepare(
		`SELECT id FROM packages
		 WHERE status = 'pending' AND created_at < datetime('now', '-24 hours')
		 LIMIT 20`
	).all<{ id: string }>();
	let n = 0;
	for (const row of results ?? []) {
		const r = await purgePackage(env, row.id);
		if (r.ok) n += 1;
	}
	return n;
}
