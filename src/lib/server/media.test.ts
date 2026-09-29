import { describe, it, expect } from 'vitest';
import { parseRange, contentDisposition, blobKey } from './media';

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
