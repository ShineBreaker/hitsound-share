// 管理员判定与名单：ADMIN_OSU_ID 超管 + users.is_admin 名单
import { describe, it, expect, beforeEach } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestD1, type TestD1 } from '../../test/d1-sqlite';
import {
	isAdmin,
	isSuperAdmin,
	findUserByIdent,
	setAdmin,
	listAdmins
} from './admin';

let d1: TestD1;

function db(): D1Database {
	return d1.db;
}

async function addUser(osuId: number, username: string, admin = 0): Promise<void> {
	await db()
		.prepare('INSERT INTO users (osu_id, username, is_admin) VALUES (?1, ?2, ?3)')
		.bind(osuId, username, admin)
		.run();
}

beforeEach(() => {
	d1 = createTestD1();
});

describe('isSuperAdmin', () => {
	it('ADMIN_OSU_ID 精确匹配；空配置恒 false', () => {
		expect(isSuperAdmin({ ADMIN_OSU_ID: '42' }, 42)).toBe(true);
		expect(isSuperAdmin({ ADMIN_OSU_ID: '42' }, 43)).toBe(false);
		expect(isSuperAdmin({}, 42)).toBe(false); // 未配置
		expect(isSuperAdmin({ ADMIN_OSU_ID: '42' }, 0)).toBe(false);
	});
});

describe('isAdmin', () => {
	it('超管直接放行（不打 DB）；名单内用户放行', async () => {
		await addUser(7, 'hero', 1);
		const before = d1.calls;
		expect(await isAdmin(db(), { ADMIN_OSU_ID: '42' }, 42)).toBe(true);
		expect(d1.calls).toBe(before); // 超管短路，零子请求
		expect(await isAdmin(db(), { ADMIN_OSU_ID: '42' }, 7)).toBe(true);
	});

	it('普通用户与非存在用户 → false；撤权即时生效', async () => {
		await addUser(7, 'hero', 1);
		await addUser(8, 'plain', 0);
		expect(await isAdmin(db(), {}, 8)).toBe(false);
		expect(await isAdmin(db(), {}, 404)).toBe(false);
		await setAdmin(db(), 7, false);
		expect(await isAdmin(db(), {}, 7)).toBe(false);
	});
});

describe('名单维护', () => {
	it('findUserByIdent：数字按 ID、其余按用户名（NOCASE），查无此人返回 null', async () => {
		await addUser(7, 'Hero_Name', 0);
		expect((await findUserByIdent(db(), '7'))?.username).toBe('Hero_Name');
		expect((await findUserByIdent(db(), 'hero_name'))?.osu_id).toBe(7); // 大小写不敏感
		expect(await findUserByIdent(db(), 'nobody')).toBeNull();
		expect(await findUserByIdent(db(), '  ')).toBeNull();
	});

	it('setAdmin 幂等；listAdmins 只回 is_admin=1 且按用户名排序', async () => {
		await addUser(1, 'bmod');
		await addUser(2, 'amod');
		await addUser(3, 'user');
		await setAdmin(db(), 1, true);
		await setAdmin(db(), 2, true);
		await setAdmin(db(), 2, true); // 幂等
		expect((await listAdmins(db())).map((a) => a.username)).toEqual(['amod', 'bmod']);
		await setAdmin(db(), 1, false);
		expect((await listAdmins(db())).map((a) => a.username)).toEqual(['amod']);
	});
});
