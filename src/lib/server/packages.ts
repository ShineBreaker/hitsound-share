// 包删除治理（上传者删自己的 / 管理员删任意）：
// D1 事务性清理（decrement refcount → 级联删 files/package）+ 归零 blob 与 zip 的 R2 对象删除。
// pending 懒清理复用同一路径（pending 未 done 过，refcount 未加，decrement 天然归零不影响）
import type { Env } from './media';

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

	// 包状态决定 refcount 是否累加过（done 置 visible 时才累加）
	const pkgRow = await DB.prepare('SELECT status FROM packages WHERE id = ?1')
		.bind(packageId)
		.first<{ status: string }>();
	const pkg_status_visible = pkgRow?.status === 'visible';

	// 1. 先取该包用到的 (hash, ext)——files 行马上要被级联删除，之后无从查起
	const { results: blobRows } = await DB.prepare(
		'SELECT DISTINCT blob_hash AS hash, format FROM files WHERE package_id = ?1'
	)
		.bind(packageId)
		.all<{ hash: string; format: string }>();

	// 2. decrement 该包全部引用（子查询计数，参数绑定）。
	//    pending 包的 refcount 从未累加过（done 才加），跳过 decrement 防多减
	if (pkg_status_visible) {
		await DB.prepare(
			`UPDATE blobs SET refcount = refcount - (
			   SELECT COUNT(*) FROM files WHERE files.package_id = ?1 AND files.blob_hash = blobs.hash
			 )
			 WHERE hash IN (SELECT DISTINCT blob_hash FROM files WHERE package_id = ?1)`
		)
			.bind(packageId)
			.run();
	}

	// 3. 删包（ON DELETE CASCADE 带 files）
	await DB.prepare('DELETE FROM packages WHERE id = ?1').bind(packageId).run();

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

/** 懒清理：删除指定用户超 24h 的 pending 包（建新上传前调用） */
export async function lazyCleanupPending(env: Env, uploaderOsuId: number): Promise<number> {
	const { results } = await env.DB.prepare(
		`SELECT id FROM packages
		 WHERE uploader_osu_id = ?1 AND status = 'pending'
		   AND created_at < datetime('now', '-24 hours')`
	)
		.bind(uploaderOsuId)
		.all<{ id: string }>();
	let n = 0;
	for (const row of results ?? []) {
		const r = await purgePackage(env, row.id);
		if (r.ok) n += 1;
	}
	return n;
}
