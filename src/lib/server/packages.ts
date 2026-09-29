// 包治理共享：包行查询 / pending 懒清理。守卫与 blob 回收分别在 guard.ts 与 ledger.ts
// （refcount 口径见 ADR 0002：refcount = 全库 visible 包对该 blob 的引用数）
import type { Env } from './media';
import { releasePackage } from './ledger';

export interface PackageRow {
	id: string;
	name: string;
	uploader_osu_id: number | null;
	status: string;
	size_bytes: number;
	append_to: string | null;
}

export async function getPackage(db: Env['DB'], id: string): Promise<PackageRow | null> {
	return await db
		.prepare(
			'SELECT id, name, uploader_osu_id, status, size_bytes, append_to FROM packages WHERE id = ?1'
		)
		.bind(id)
		.first<PackageRow>();
}

/** 懒清理：全站扫描超 24h 的 pending 包与影子包（他人弃单也回收，防占死水位）。
 *  在上传请求的子请求预算内执行，故每次至多 2 个（每个 releasePackage ≈2 次 D1 +
 *  ⌈keys/1000⌉ 次 R2）。append_to 非空的 visible 行是 done 合并中断的孤儿，一并兜底回收 */
export async function lazyCleanupPending(env: Env): Promise<number> {
	const { results } = await env.DB.prepare(
		`SELECT id FROM packages
		 WHERE (status = 'pending' OR append_to IS NOT NULL)
		   AND created_at < datetime('now', '-24 hours')
		 LIMIT 2`
	).all<{ id: string }>();
	let n = 0;
	for (const row of results ?? []) {
		try {
			await releasePackage(env, row.id);
			n += 1;
		} catch {
			/* 单个失败不挡其他清理 */
		}
	}
	return n;
}
