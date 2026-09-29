// GET /api/waveform?ids=… 批量峰值：全部请求 id 都出现在响应里（缺失/不可解析 → null）
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestD1, type TestD1 } from '../../../test/d1-sqlite';
import { createMemoryR2 } from '../../../test/r2-memory';
import { GET } from './+server';

let d1: TestD1;

async function seedFile(id: string, peaks: string | null): Promise<void> {
	await d1.db
		.prepare('INSERT OR IGNORE INTO blobs (hash, size, mime, refcount) VALUES (?1, 1, ?2, 0)')
		.bind(`blob-${id}`, 'audio/wav')
		.run();
	await d1.db
		.prepare('INSERT INTO packages (id, name, size_bytes, logical_size, file_count) VALUES (?1, ?2, 0, 0, 0)')
		.bind(`pkg-${id}`, 'p')
		.run();
	await d1.db
		.prepare(
			`INSERT INTO files (id, package_id, folder_path, name, format, size_bytes, peaks, blob_hash)
			 VALUES (?1, ?2, '', ?3, 'wav', 1, ?4, ?5)`
		)
		.bind(id, `pkg-${id}`, `${id}.wav`, peaks, `blob-${id}`)
		.run();
}

async function call(query: string): Promise<Response> {
	return await GET({
		url: new URL(`https://t.local/api/waveform${query}`),
		platform: { env: { DB: d1.db, HITSOUND_FILES: createMemoryR2().bucket } },
		params: {},
		request: new Request(`https://t.local/api/waveform${query}`),
		cookies: { get: () => undefined },
		locals: {}
	} as unknown as Parameters<typeof GET>[0]);
}

beforeEach(() => {
	d1 = createTestD1();
});

describe('GET /api/waveform', () => {
	it('批量返回每个请求 id 的 peaks（缺失/坏 JSON → null）', async () => {
		await seedFile('id1', '[0.1,0.5,0.9]');
		await seedFile('id2', null);
		await seedFile('id3', 'not-json');

		const res = await call('?ids=id1,id2,id3,gone');
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
		const body = (await res.json()) as { peaks: Record<string, number[] | null> };
		expect(body.peaks).toEqual({
			id1: [0.1, 0.5, 0.9],
			id2: null,
			id3: null,
			gone: null
		});
	});

	it('ids 为空 / 非法字符 / 超 100 个 → 400 bad_request', async () => {
		for (const q of ['', '?ids=', '?ids=a$b', '?ids=' + 'a'.repeat(65), '?ids=' + Array(101).fill('x').join(',')]) {
			const res = await call(q);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: 'bad_request' });
		}
	});
});
