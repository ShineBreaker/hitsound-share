import { describe, it, expect } from 'vitest';
import { validateManifest, magicOk, MAX_ENTRIES } from './upload';

const H = 'a'.repeat(64);

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		path: 'dir/a.wav',
		hash: H,
		size: 100,
		ext: 'wav',
		durationS: 0.5,
		sampleRate: 44100,
		bitDepth: 16,
		channels: 2,
		peaks: [0.1, 0.9],
		...over
	};
}

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
	return { name: 'test', entries: [entry()], ...over };
}

describe('validateManifest', () => {
	it('合法 manifest 通过', () => {
		const r = validateManifest(manifest());
		expect(r.ok).toBe(true);
	});

	it('非对象 body → bad_body', () => {
		expect(validateManifest(null)).toEqual({ ok: false, error: 'bad_body' });
		expect(validateManifest('x')).toEqual({ ok: false, error: 'bad_body' });
	});

	it('路径安全：.. / 绝对路径 / 反斜杠 / 超长被拒', () => {
		for (const path of ['../a.wav', 'a/../b.wav', '/abs.wav', 'a\\b.wav', 'x'.repeat(513)]) {
			expect(validateManifest(manifest({ entries: [entry({ path })] }))).toEqual({
				ok: false,
				error: 'bad_path'
			});
		}
	});

	it('扩展名白名单', () => {
		expect(validateManifest(manifest({ entries: [entry({ ext: 'exe' })] }))).toEqual({
			ok: false,
			error: 'bad_ext'
		});
	});

	it('hash 必须是 64 位小写 hex（防 R2 key 注入）', () => {
		for (const hash of ['xyz', 'A'.repeat(64), 'a'.repeat(63), `${H}/../`] as const) {
			expect(validateManifest(manifest({ entries: [entry({ hash })] }))).toEqual({
				ok: false,
				error: 'bad_hash'
			});
		}
	});

	it('size：非正 / 超上限被拒', () => {
		expect(validateManifest(manifest({ entries: [entry({ size: 0 })] }))).toEqual({
			ok: false,
			error: 'bad_size'
		});
	});

	it('条目数：空 / 超 5000 被拒', () => {
		expect(validateManifest(manifest({ entries: [] }))).toEqual({
			ok: false,
			error: 'too_many_entries'
		});
		expect(
			validateManifest(manifest({ entries: Array.from({ length: MAX_ENTRIES + 1 }, () => entry()) }))
		).toEqual({ ok: false, error: 'too_many_entries' });
	});

	it('新建模式必须有合法 name；附加模式 name 免校验但 appendTo 须为 uuid', () => {
		expect(validateManifest(manifest({ name: '' }))).toEqual({ ok: false, error: 'bad_name' });
		expect(
			validateManifest(manifest({ name: '', appendTo: '123e4567-e89b-42d3-a456-426614174000' })).ok
		).toBe(true);
		expect(validateManifest(manifest({ appendTo: 'not-a-uuid' }))).toEqual({
			ok: false,
			error: 'bad_append_to'
		});
		expect(validateManifest(manifest({ appendTo: 42 }))).toEqual({
			ok: false,
			error: 'bad_append_to'
		});
	});

	it('peaks：非法数组被洗成 null（不拒整个条目）', () => {
		const r = validateManifest(manifest({ entries: [entry({ peaks: [1, 'x', 2] })] }));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value.entries[0].peaks).toBeNull();
	});
});

describe('magicOk', () => {
	const bytes = (s: number[]) => new Uint8Array(s);

	it('wav = RIFF', () => {
		expect(magicOk('wav', bytes([0x52, 0x49, 0x46, 0x46, 0]))).toBe(true);
		expect(magicOk('wav', bytes([0x4f, 0x67, 0x67, 0x53]))).toBe(false);
	});

	it('ogg = OggS', () => {
		expect(magicOk('ogg', bytes([0x4f, 0x67, 0x67, 0x53]))).toBe(true);
		expect(magicOk('ogg', bytes([0x52, 0x49, 0x46, 0x46]))).toBe(false);
	});

	it('mp3 = ID3 或 MPEG 帧同步', () => {
		expect(magicOk('mp3', bytes([0x49, 0x44, 0x33]))).toBe(true); // ID3
		expect(magicOk('mp3', bytes([0xff, 0xfb]))).toBe(true); // frame sync
		expect(magicOk('mp3', bytes([0xff, 0x0b]))).toBe(false);
		expect(magicOk('mp3', bytes([0x00]))).toBe(false);
	});

	it('短数据不误判', () => {
		expect(magicOk('wav', bytes([0x52, 0x49]))).toBe(false);
	});
});
