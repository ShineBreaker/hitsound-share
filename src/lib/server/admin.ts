// 管理员判定与名单维护（deep module）：
// - 超级管理员 = ADMIN_OSU_ID 环境变量（部署即固定，唯一能管理名单的人）
// - 管理员 = users.is_admin = 1（schema 预留列），由超级管理员经 /api/admin/admins 增删；
//   与超级管理员同权（改名/删除任意包、文件夹、文件、purge-zips），但不能动名单
// 判定每次实时查库（主键读，1 子请求），不落 session——撤权立即生效
import type { D1Database } from '@cloudflare/workers-types';
import type { Secrets } from './env';

/** 超级管理员：ADMIN_OSU_ID 环境变量比对（唯一不可被移除的管理员） */
export function isSuperAdmin(secrets: Partial<Secrets>, osuId: number): boolean {
	return Boolean(secrets.ADMIN_OSU_ID && secrets.ADMIN_OSU_ID === String(osuId));
}

/** 管理员：超级管理员或 users.is_admin = 1 */
export async function isAdmin(
	db: D1Database,
	secrets: Partial<Secrets>,
	osuId: number
): Promise<boolean> {
	if (isSuperAdmin(secrets, osuId)) return true;
	const row = await db
		.prepare('SELECT is_admin FROM users WHERE osu_id = ?1')
		.bind(osuId)
		.first<{ is_admin: number }>();
	return row?.is_admin === 1;
}

export interface AdminRow {
	osu_id: number;
	username: string;
	avatar_url: string | null;
}

/** 名单（DB 内授出的管理员；超级管理员若在名单内也会出现） */
export async function listAdmins(db: D1Database): Promise<AdminRow[]> {
	const { results } = await db
		.prepare(
			'SELECT osu_id, username, avatar_url FROM users WHERE is_admin = 1 ORDER BY username COLLATE NOCASE'
		)
		.all<AdminRow>();
	return results ?? [];
}

export interface UserRow {
	osu_id: number;
	username: string;
	avatar_url: string | null;
	is_admin: number;
}

/** 按 osu! 用户 ID（全数字）或用户名（大小写不敏感精确匹配）找已登录过的用户 */
export async function findUserByIdent(db: D1Database, ident: string): Promise<UserRow | null> {
	const s = ident.trim();
	if (!s) return null;
	if (/^\d+$/.test(s)) {
		return await db
			.prepare('SELECT osu_id, username, avatar_url, is_admin FROM users WHERE osu_id = ?1')
			.bind(Number(s))
			.first<UserRow>();
	}
	return await db
		.prepare(
			'SELECT osu_id, username, avatar_url, is_admin FROM users WHERE username = ?1 COLLATE NOCASE'
		)
		.bind(s)
		.first<UserRow>();
}

/** 授/撤管理员标记（幂等；用户不存在时命中 0 行） */
export async function setAdmin(db: D1Database, osuId: number, on: boolean): Promise<void> {
	await db
		.prepare('UPDATE users SET is_admin = ?1 WHERE osu_id = ?2')
		.bind(on ? 1 : 0, osuId)
		.run();
}
