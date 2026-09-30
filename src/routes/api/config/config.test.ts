// /api/config 端到端：限制常量透出 + 存储池用量（与水位公式同口径）+ 登录时当日配额
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestD1, type TestD1 } from '../../../test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from '../../../test/r2-memory';
import { signSession, SESSION_COOKIE } from '$lib/server/session';
import { GET } from './+server';

const SECRET = 'config-test-secret';
const UID = 4242;
const h = (n: number) => n.toString(16).padStart(64, '0');

let d1: TestD1;
let r2: MemoryR2;
let cookie = '';

function call(cookieValue = cookie): Promise<Response> {
	return GET({
		platform: {
			env: {
				DB: d1.db,
				HITSOUND_FILES: r2.bucket,
				SESSION_SECRET: SECRET,
				OSU_CLIENT_ID: '1',
				OSU_CLIENT_SECRET: 's',
				R2_ACCOUNT_ID: 'acct',
				R2_ACCESS_KEY_ID: 'ak',
				R2_SECRET_ACCESS_KEY: 'sk'
			}
		},
		cookies: { get: (n: string) => (n === SESSION_COOKIE ? cookieValue : undefined) },
		url: new URL('https://t.local/api/config')
	} as unknown as Parameters<typeof GET>[0]);
}

async function addBlobRow(hash: string, size: number): Promise<void> {
	await d1.db
		.prepare('INSERT INTO blobs (hash, size, mime, refcount) VALUES (?1, ?2, ?3, 1)')
		.bind(hash, size, 'audio/wav')
		.run();
}

/** SQLite datetime('now') 同格式的 UTC 时间串（绑定参数不执行 SQL 函数，须 JS 侧算好） */
function sqliteUtc(msAgo = 0): string {
	return new Date(Date.now() - msAgo)
		.toISOString()
		.slice(0, 19)
		.replace('T', ' ');
}

async function addPackage(id: string, createdAt: string, zipBytes: number): Promise<void> {
	await d1.db
		.prepare(
			`INSERT INTO packages (id, name, uploader_osu_id, size_bytes, logical_size, file_count, status, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?4, 1, 'visible', ?5)`
		)
		.bind(id, `pkg-${id}`, UID, zipBytes, createdAt)
		.run();
}

beforeEach(async () => {
	d1 = createTestD1();
	r2 = createMemoryR2();
	cookie = await signSession({ osuId: UID, username: 'tester', avatarUrl: null }, SECRET);
	await d1.db
		.prepare('INSERT INTO users (osu_id, username) VALUES (?1, ?2)')
		.bind(UID, 'tester')
		.run();
});

describe('GET /api/config', () => {
	it('未登录：限制常量 + 存储池用量（blobs + visible zip 存量同口径），dailyPackagesUsed=null', async () => {
		await addBlobRow(h(1), 100);
		await addBlobRow(h(2), 50);
		await addPackage('pk-old', sqliteUtc(2 * 24 * 3600 * 1000), 30);

		const res = await call('');
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.uploadEnabled).toBe(true);
		expect(data.limits).toEqual({
			maxFileBytes: 10 * 1024 * 1024,
			maxPackageBytes: 1024 * 1024 * 1024,
			maxEntries: 5000,
			dailyPackages: 5,
			storageCapBytes: 10 * 1024 * 1024 * 1024
		});
		expect(data.storageUsedBytes).toBe(180);
		expect(data.dailyPackagesUsed).toBeNull();
	});

	it('登录：dailyPackagesUsed 按 24h 口径计数（pending/影子包在内，旧包不计）', async () => {
		await addPackage('p1', sqliteUtc(), 0);
		await addPackage('p2', sqliteUtc(), 0);
		await addPackage('p3', sqliteUtc(2 * 24 * 3600 * 1000), 0);

		const res = await call();
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.dailyPackagesUsed).toBe(2);
	});

	it('无 bindings：storageUsedBytes=null（浏览功能不受影响）', async () => {
		const res = await GET({
			platform: undefined,
			cookies: { get: () => undefined },
			url: new URL('https://t.local/api/config')
		} as unknown as Parameters<typeof GET>[0]);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.uploadEnabled).toBe(false);
		expect(data.storageUsedBytes).toBeNull();
		expect(data.dailyPackagesUsed).toBeNull();
	});
});
