// GET /api/package/<id>/zip 清单：回退分支 URL 形态（请求 origin 绝对地址，
// 跨源前端可直连 API 域）与预签名分支不回归
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestD1, type TestD1 } from '../../../../../test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from '../../../../../test/r2-memory';
import { GET } from './+server';

const h = (n: number) => n.toString(16).padStart(64, '0');

let d1: TestD1;
let r2: MemoryR2;

function callZip(withR2Secrets: boolean): Promise<Response> {
	const env: Record<string, unknown> = { DB: d1.db, HITSOUND_FILES: r2.bucket };
	if (withR2Secrets) {
		env.R2_ACCOUNT_ID = 'acct';
		env.R2_ACCESS_KEY_ID = 'ak';
		env.R2_SECRET_ACCESS_KEY = 'sk';
	}
	return GET({
		request: new Request('https://api.local/api/package/p1/zip'),
		platform: { env },
		params: { id: 'p1' },
		url: new URL('https://api.local/api/package/p1/zip'),
		locals: {}
	} as unknown as Parameters<typeof GET>[0]);
}

beforeEach(async () => {
	d1 = createTestD1();
	r2 = createMemoryR2();
	await d1.db
		.prepare(
			`INSERT INTO packages (id, name, uploader_osu_id, size_bytes, logical_size, file_count, status)
			 VALUES ('p1', 'pkg', NULL, 0, 0, 0, 'visible')`
		)
		.run();
	await d1.db
		.prepare('INSERT INTO blobs (hash, size, mime, refcount) VALUES (?1, 100, ?2, 1)')
		.bind(h(1), 'audio/wav')
		.run();
	await d1.db
		.prepare(
			`INSERT INTO files (id, package_id, folder_path, name, format, size_bytes, blob_hash, owner_osu_id)
			 VALUES ('f1', 'p1', 'sub', 'a.wav', 'wav', 100, ?1, NULL)`
		)
		.bind(h(1))
		.run();
});

describe('GET /api/package/<id>/zip 拉取 URL', () => {
	it('无 R2 secrets：urls 为请求 origin 的绝对 URL（跨源前端不再打到自身 origin 404）', async () => {
		const res = await callZip(false);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.name).toBe('pkg');
		expect(data.files).toEqual([{ path: 'sub/a.wav', hash: h(1), ext: 'wav', size: 100 }]);
		expect(data.urls).toEqual({ [h(1)]: `https://api.local/api/blob/${h(1)}/wav` });
	});

	it('R2 三项 secrets 齐：仍预签名直连，时效 15 分钟（清单外泄后可复用窗口收敛）', async () => {
		const res = await callZip(true);
		expect(res.status).toBe(200);
		const data = await res.json();
		const url = new URL(data.urls[h(1)]);
		expect(url.href).toContain(
			`https://acct.r2.cloudflarestorage.com/hitsound-files/blobs/${h(1).slice(0, 2)}/${h(1)}.wav`
		);
		expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
		expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
	});
});
