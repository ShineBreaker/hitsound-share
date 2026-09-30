// decodeMeta 的 wav 免解码快路：PCM/float 直取峰；非 wav/无解码器 → null
// （测试环境无 OfflineAudioContext，非 wav 路径天然走到 catch → null）
import { describe, it, expect } from 'vitest';
import { decodeMeta } from './audio-meta';

/** 构造最小 PCM wav：单声道 16bit，给定的 int16 样本序列 */
function wav16(samples: number[], sampleRate = 44100, channels = 1): Uint8Array {
	const dataSize = samples.length * 2 * channels;
	const d = new Uint8Array(44 + dataSize);
	const dv = new DataView(d.buffer);
	d.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
	dv.setUint32(4, 36 + dataSize, true);
	d.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
	d.set([0x66, 0x6d, 0x74, 0x20], 12); // fmt
	dv.setUint32(16, 16, true);
	dv.setUint16(20, 1, true); // PCM
	dv.setUint16(22, channels, true);
	dv.setUint32(24, sampleRate, true);
	dv.setUint32(28, sampleRate * channels * 2, true); // byteRate
	dv.setUint16(32, channels * 2, true);
	dv.setUint16(34, 16, true);
	d.set([0x64, 0x61, 0x74, 0x61], 36); // data
	dv.setUint32(40, dataSize, true);
	samples.forEach((s, i) => dv.setInt16(44 + i * 2, s, true));
	return d;
}

describe('decodeMeta：wav 免解码快路', () => {
	it('16bit PCM：时长/采样率/声道正确，峰值反映样本极值', async () => {
		const sr = 44100;
		// 4410 帧 = 0.1s；中段放一个满幅样本，对端放 -0.5 幅
		const samples = new Array<number>(4410).fill(0);
		samples[2000] = 32767;
		samples[4000] = -16384;
		const meta = await decodeMeta(wav16(samples, sr));
		expect(meta).not.toBeNull();
		expect(meta!.durationS).toBeCloseTo(0.1, 3);
		expect(meta!.sampleRate).toBe(sr);
		expect(meta!.channels).toBe(1);
		expect(meta!.peaks).toHaveLength(200);
		// step=22：满幅样本 2000 → 桶 90 ≈1.0；4000 → 桶 181 ≈0.5
		expect(meta!.peaks[90]).toBeCloseTo(1.0, 1);
		expect(meta!.peaks[181]).toBeCloseTo(0.5, 1);
		expect(meta!.peaks[10]).toBe(0); // 静音区
	});

	it('8bit PCM：无符号偏移量正确归一', async () => {
		// 8bit 无符号：128=静音；255/0 = 满幅
		const dataSize = 2000;
		const d = new Uint8Array(44 + dataSize);
		const dv = new DataView(d.buffer);
		d.set([0x52, 0x49, 0x46, 0x46], 0);
		dv.setUint32(4, 36 + dataSize, true);
		d.set([0x57, 0x41, 0x56, 0x45], 8);
		d.set([0x66, 0x6d, 0x74, 0x20], 12);
		dv.setUint32(16, 16, true);
		dv.setUint16(20, 1, true);
		dv.setUint16(22, 1, true);
		dv.setUint32(24, 8000, true);
		dv.setUint32(28, 8000, true);
		dv.setUint16(32, 1, true);
		dv.setUint16(34, 8, true);
		d.set([0x64, 0x61, 0x74, 0x61], 36);
		dv.setUint32(40, dataSize, true);
		d.fill(128, 44); // 静音
		d[44 + 500] = 255; // 满幅
		const meta = await decodeMeta(d);
		expect(meta).not.toBeNull();
		expect(meta!.sampleRate).toBe(8000);
		expect(meta!.peaks[50]).toBeCloseTo(1.0, 0); // 500/2000=25% 位 → 桶 50
		expect(meta!.peaks[199]).toBe(0);
	});

	it('多声道只扫第 0 声道（与解码口径一致）', async () => {
		const frames = 1000;
		const dataSize = frames * 2 * 2; // stereo 16bit
		const d = new Uint8Array(44 + dataSize);
		const dv = new DataView(d.buffer);
		d.set([0x52, 0x49, 0x46, 0x46], 0);
		dv.setUint32(4, 36 + dataSize, true);
		d.set([0x57, 0x41, 0x56, 0x45], 8);
		d.set([0x66, 0x6d, 0x74, 0x20], 12);
		dv.setUint32(16, 16, true);
		dv.setUint16(20, 1, true);
		dv.setUint16(22, 2, true);
		dv.setUint32(24, 44100, true);
		dv.setUint32(28, 44100 * 4, true);
		dv.setUint16(32, 4, true);
		dv.setUint16(34, 16, true);
		d.set([0x64, 0x61, 0x74, 0x61], 36);
		dv.setUint32(40, dataSize, true);
		// 右声道满幅、左声道静音 → peaks 应全 0（只取 ch0）
		for (let f = 0; f < frames; f++) dv.setInt16(44 + f * 4 + 2, 32767, true);
		const meta = await decodeMeta(d);
		expect(meta).not.toBeNull();
		expect(meta!.channels).toBe(2);
		expect(Math.max(...meta!.peaks)).toBe(0);
	});

	it('非 wav（伪造 mp3）→ 解码器缺席 → null', async () => {
		const fake = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]);
		expect(await decodeMeta(fake)).toBeNull();
	});

	it('非 PCM wav（ADPCM tag=2）回退解码器 → 无解码器得 null', async () => {
		const d = wav16([0, 0, 0, 0]);
		new DataView(d.buffer).setUint16(20, 2, true); // formatTag=ADPCM
		expect(await decodeMeta(d)).toBeNull();
	});
});
