// GET /f/<id>：D1 尺寸驱动的 Range 归一化——全程零 R2 head（每请求省 1 次 Class B），
// 尺寸来自 files.size_bytes（done 核验保证与 R2 对象一致）；R2 仅剩至多 1 次 get
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestD1, type TestD1 } from '../../../test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from '../../../test/r2-memory';
import { blobKey } from '$lib/server/media';
import { GET } from './+server';

const HASH = 'ab'.padEnd(64, '0');
const KEY = blobKey(HASH, 'wav');
// 500 字节确定性内容：Range 断言按偏移取字节即可核对
const BYTES = Uint8Array.from({ length: 500 }, (_, i) => i % 251);

let d1: TestD1;
let r2: MemoryR2;

beforeEach(async () => {
	d1 = createTestD1();
	r2 = createMemoryR2();
	await r2.bucket.put(KEY, BYTES);
	await d1.db
		.prepare('INSERT INTO packages (id, name, size_bytes, logical_size, file_count) VALUES (?1, ?2, 0, 0, 0)')
		.bind('pkg-1', 'p')
		.run();
	await d1.db
		.prepare('INSERT INTO blobs (hash, size, mime, refcount) VALUES (?1, ?2, ?3, 1)')
		.bind(HASH, BYTES.length, 'audio/wav')
		.run();
	await d1.db
		.prepare(
			`INSERT INTO files (id, package_id, folder_path, name, format, size_bytes, blob_hash)
			 VALUES ('f1', 'pkg-1', '', 'a.wav', 'wav', ?1, ?2)`
		)
		.bind(BYTES.length, HASH)
		.run();
});

async function call(id: string, headers: Record<string, string> = {}): Promise<Response> {
	return await GET({
		url: new URL(`https://t.local/f/${id}`),
		platform: { env: { DB: d1.db, HITSOUND_FILES: r2.bucket } },
		params: { id },
		request: new Request(`https://t.local/f/${id}`, { headers }),
		cookies: { get: () => undefined },
		locals: {}
	} as unknown as Parameters<typeof GET>[0]);
}

describe('GET /f/<id>', () => {
	it('无 Range → 200 全量，Content-Length 用 D1 尺寸；零 head + 单次 get', async () => {
		const res = await call('f1');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-length')).toBe('500');
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
		expect(r2.calls).toMatchObject({ head: 0, get: 1, list: 0, delete: 0 });
		expect(d1.calls).toBe(4); // seed 3 次 + 本请求 1 次行读
	});

	it('单区间 → 206 + Content-Range，区间按 D1 尺寸归一化', async () => {
		const res = await call('f1', { range: 'bytes=100-' });
		expect(res.status).toBe(206);
		expect(res.headers.get('content-length')).toBe('400');
		expect(res.headers.get('content-range')).toBe('bytes 100-499/500');
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES.subarray(100));
		expect(r2.calls.head).toBe(0);
		expect(r2.calls.get).toBe(1);
		expect(d1.calls).toBe(4);
	});

	it('后缀区间 bytes=-n：offset 由 D1 尺寸推出（head 移除后唯一尺寸来源）', async () => {
		const res = await call('f1', { range: 'bytes=-50' });
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe('bytes 450-499/500');
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES.subarray(450));
		expect(r2.calls.head).toBe(0);
	});

	it('If-None-Match 命中 → 304，全程零 R2 调用', async () => {
		const res = await call('f1', { 'if-none-match': `"${HASH}"` });
		expect(res.status).toBe(304);
		expect(r2.calls).toMatchObject({ head: 0, get: 0, list: 0, delete: 0 });
		expect(d1.calls).toBe(4);
	});

	it('start >= D1 尺寸 → 416，全程零 R2 调用（原实现此处需一次 head）', async () => {
		const res = await call('f1', { range: 'bytes=500-' });
		expect(res.status).toBe(416);
		expect(res.headers.get('content-range')).toBe('bytes */500');
		expect(r2.calls).toMatchObject({ head: 0, get: 0, list: 0, delete: 0 });
	});

	it('多区间 → 回退 200 全量', async () => {
		const res = await call('f1', { range: 'bytes=0-10,20-30' });
		expect(res.status).toBe(200);
		expect(res.headers.get('content-length')).toBe('500');
		expect(r2.calls.head).toBe(0);
		expect(r2.calls.get).toBe(1);
	});

	it('id 不存在 → 404', async () => {
		const res = await call('gone');
		expect(res.status).toBe(404);
	});

	it('D1 行在而 R2 对象缺失 → get 兜底 404', async () => {
		await r2.bucket.delete(KEY);
		const res = await call('f1');
		expect(res.status).toBe(404);
		expect(r2.calls.head).toBe(0);
		expect(r2.calls.get).toBe(1);
	});
});
