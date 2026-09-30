// /api/upload 端到端（水位闸门与豁免口径）：
// - 单文件 >10MB 拒（管理员放宽到单包累计约束）
// - 每日 5 包配额拒（管理员豁免）
// - 全局水位 10GB 拒（管理员不豁免：防付费硬闸）
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestD1, type TestD1 } from '../../../test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from '../../../test/r2-memory';
import { signSession, SESSION_COOKIE } from '$lib/server/session';
import { GLOBAL_CAP_BYTES, MAX_FILE_BYTES } from '$lib/server/upload';
import { POST } from './+server';

const SECRET = 'upload-test-secret';
const UID = 4242;
const h = (n: number) => n.toString(16).padStart(64, '0');

let d1: TestD1;
let r2: MemoryR2;
let cookie = '';

async function setAdmin(on: boolean): Promise<void> {
	await d1.db
		.prepare('UPDATE users SET is_admin = ?1 WHERE osu_id = ?2')
		.bind(on ? 1 : 0, UID)
		.run();
}

async function seedPackages(n: number): Promise<void> {
	for (let i = 0; i < n; i++) {
		await d1.db
			.prepare(
				`INSERT INTO packages (id, name, uploader_osu_id, size_bytes, logical_size, file_count, status)
				 VALUES (?1, ?2, ?3, 0, 0, 0, 'visible')`
			)
			.bind(`seed-${i}`, `pkg-${i}`, UID)
			.run();
	}
}

function body(sizes: number[]): Record<string, unknown> {
	return {
		name: 'test',
		entries: sizes.map((size, i) => ({
			path: `f${i}.wav`,
			hash: h(i + 1),
			size,
			ext: 'wav'
		}))
	};
}

function callUpload(payload: unknown, cookieValue = cookie): Promise<Response> {
	return POST({
		request: new Request('https://t.local/api/upload', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		}),
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
		url: new URL('https://t.local/api/upload')
	} as unknown as Parameters<typeof POST>[0]);
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

describe('POST /api/upload：单文件上限', () => {
	it('普通用户单文件 >10MB → 400 file_too_large', async () => {
		const res = await callUpload(body([MAX_FILE_BYTES + 1]));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'file_too_large' });
	});

	it('管理员单文件 >10MB → 放行（预签名直传 URL 返回）', async () => {
		await setAdmin(true);
		const res = await callUpload(body([MAX_FILE_BYTES + 1]));
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(typeof data.packageId).toBe('string');
		expect(data.missing).toHaveLength(1);
		expect(data.missing[0].url).toContain(
			'https://acct.r2.cloudflarestorage.com/hitsound-files/blobs/'
		);
	});
});

describe('POST /api/upload：每日配额与管理员豁免', () => {
	it('普通用户当日第 6 包 → 429 daily_limit', async () => {
		await seedPackages(5);
		const res = await callUpload(body([100]));
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: 'daily_limit' });
	});

	it('管理员当日第 6 包 → 200（配额豁免）', async () => {
		await seedPackages(5);
		await setAdmin(true);
		const res = await callUpload(body([100]));
		expect(res.status).toBe(200);
	});
});

describe('POST /api/upload：全局水位（不豁免）', () => {
	it('blobs 账本已达水位 → 管理员同样 507 storage_full', async () => {
		await setAdmin(true);
		await d1.db
			.prepare('INSERT INTO blobs (hash, size, mime, refcount) VALUES (?1, ?2, ?3, 1)')
			.bind(h(1), GLOBAL_CAP_BYTES, 'audio/wav')
			.run();
		const res = await callUpload(body([100]));
		expect(res.status).toBe(507);
		expect(await res.json()).toEqual({ error: 'storage_full' });
	});
});

describe('POST /api/upload：子请求预算', () => {
	it('单条目成功上传的 D1 子请求 ≤15（免费计划 50 上限的余量）', async () => {
		const before = d1.calls;
		const res = await callUpload(body([100]));
		expect(res.status).toBe(200);
		expect(d1.calls - before).toBeLessThanOrEqual(15);
	});
});
