import { describe, it, expect, beforeEach } from 'vitest';
import { parseRange, contentDisposition, blobKey, queryFileBlob } from './media';
import { createTestD1, type TestD1 } from '../../test/d1-sqlite';

describe('parseRange', () => {
	const SIZE = 500;

	it('无 Range 头 → null（200 全量）', () => {
		expect(parseRange(null, SIZE)).toBeNull();
	});

	it('普通区间', () => {
		expect(parseRange('bytes=0-99', SIZE)).toEqual({ offset: 0, length: 100 });
		expect(parseRange('bytes=100-', SIZE)).toEqual({ offset: 100, length: 400 });
	});

	it('end 超尾按 S3 语义收敛', () => {
		expect(parseRange('bytes=10-99999', SIZE)).toEqual({ offset: 10, length: 490 });
	});

	it('后缀区间 bytes=-n', () => {
		expect(parseRange('bytes=-50', SIZE)).toEqual({ offset: 450, length: 50 });
		// n 超过整个文件 → 全量
		expect(parseRange('bytes=-9999', SIZE)).toEqual({ offset: 0, length: 500 });
	});

	it('多区间 → multi（回退 200）', () => {
		expect(parseRange('bytes=0-10,20-30', SIZE)).toBe('multi');
	});

	it('start >= size → unsatisfiable（416）', () => {
		expect(parseRange('bytes=500-', SIZE)).toBe('unsatisfiable');
		expect(parseRange('bytes=999-1000', SIZE)).toBe('unsatisfiable');
	});

	it('非法格式 → invalid（回退 200）', () => {
		expect(parseRange('items=0-10', SIZE)).toBe('invalid');
		expect(parseRange('bytes=', SIZE)).toBe('invalid');
		expect(parseRange('bytes=-', SIZE)).toBe('invalid');
		expect(parseRange('bytes=abc-def', SIZE)).toBe('invalid');
		expect(parseRange('bytes=10-5', SIZE)).toBe('invalid'); // end < start
		expect(parseRange('bytes=-x', SIZE)).toBe('invalid');
		expect(parseRange('bytes=1.5-3', SIZE)).toBe('invalid');
	});
});

describe('contentDisposition', () => {
	it('RFC 5987 编码原始名 + ASCII fallback', () => {
		const h = contentDisposition('a b#.wav');
		expect(h).toContain(`filename*=UTF-8''${encodeURIComponent('a b#.wav')}`);
		expect(h).toContain('filename="a b#.wav"');
	});

	it('纯非 ASCII 名：fallback 兜底 hitsound，filename* 保留原文', () => {
		const h = contentDisposition('音效');
		expect(h).toContain('filename="hitsound"');
		expect(h).toContain(encodeURIComponent('音效'));
	});

	it('引号/反斜杠从 fallback 剔除', () => {
		const h = contentDisposition('a"b\\c.wav');
		expect(h).toContain('filename="abc.wav"');
	});
});

describe('blobKey', () => {
	it('内容寻址路径：blobs/<hash前2>/<hash>.<ext>', () => {
		expect(blobKey('ab12'.padEnd(64, '0'), 'wav')).toBe(
			`blobs/ab/${'ab12'.padEnd(64, '0')}.wav`
		);
	});
});

describe('queryFileBlob', () => {
	let d1: TestD1;
	const HASH = 'ab'.padEnd(64, '0');

	beforeEach(async () => {
		d1 = createTestD1();
		await d1.db
			.prepare('INSERT INTO packages (id, name, size_bytes, logical_size, file_count) VALUES (?1, ?2, 0, 0, 0)')
			.bind('pkg-1', 'p')
			.run();
		await d1.db
			.prepare('INSERT INTO blobs (hash, size, mime, refcount) VALUES (?1, ?2, ?3, 1)')
			.bind(HASH, 500, 'audio/wav')
			.run();
	});

	it('返回 hash/mime/原始名 + files.size_bytes 尺寸（供调用方免 R2 head）', async () => {
		await d1.db
			.prepare(
				`INSERT INTO files (id, package_id, folder_path, name, format, size_bytes, blob_hash)
				 VALUES ('f1', 'pkg-1', '', 'a b#.wav', 'wav', 500, ?1)`
			)
			.bind(HASH)
			.run();

		const before = d1.calls;
		const row = await queryFileBlob(d1.db, 'f1');
		expect(row).toEqual({
			name: 'a b#.wav',
			hash: HASH,
			format: 'wav',
			mime: 'audio/wav',
			size: 500
		});
		expect(d1.calls - before).toBe(1); // 单次行读，无额外子请求
	});

	it('id 不存在 → null', async () => {
		expect(await queryFileBlob(d1.db, 'gone')).toBeNull();
	});
});
