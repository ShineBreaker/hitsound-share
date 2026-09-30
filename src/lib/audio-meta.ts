// 音频元数据解码（浏览器专用）。
// wav 走免解码快路：PCM/float 直接从 data 块取峰（0 分配、无 AudioContext），
// 其余编码与所有 mp3/ogg 仍借 OfflineAudioContext 的解码器（无需用户手势）。
// 独立于上传管线存在以便注入：测试环境给假实现即可
import { parseWavHeader } from './upload-pipeline';
import { yieldMain } from './pool';

export interface DecodedMeta {
	durationS: number;
	sampleRate: number;
	channels: number;
	peaks: number[]; // 200 桶峰值（0-1）
}

const PEAK_BUCKETS = 200;

/** PCM/float wav 直取峰：只扫第 0 声道（与 decodeAudioData 口径一致），失败返回 null 由调用方回退。
 *  扫描是主线程逐帧循环：每 4M 帧让出一次事件循环防长文件卡顿 */
async function wavMeta(d: Uint8Array): Promise<DecodedMeta | null> {
	const h = parseWavHeader(d);
	if (!h || h.dataOffset === 0 || h.dataSize <= 0 || h.channels <= 0) return null;
	const bytesPer = h.bitDepth / 8;
	if (bytesPer !== Math.floor(bytesPer) || bytesPer < 1 || bytesPer > 4) return null;
	// PCM(1) 支持 8/16/24/32 位；float(3) 支持 32 位；其余回退解码器
	if (!((h.formatTag === 1 && h.bitDepth <= 32) || (h.formatTag === 3 && h.bitDepth === 32))) return null;

	const frames = Math.floor(h.dataSize / (bytesPer * h.channels));
	if (frames <= 0) return null;
	const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
	const step = Math.max(1, Math.floor(frames / PEAK_BUCKETS));
	const peaks: number[] = [];
	let sinceYield = 0;
	for (let i = 0; i < PEAK_BUCKETS; i++) {
		let m = 0;
		const s = i * step;
		for (let f = s; f < Math.min(s + step, frames); f++) {
			const o = h.dataOffset + f * bytesPer * h.channels; // 第 0 声道样本
			let v: number;
			if (h.formatTag === 3) {
				v = Math.abs(dv.getFloat32(o, true));
			} else if (bytesPer === 1) {
				v = Math.abs(d[o] - 128) / 128; // 8-bit PCM 无符号
			} else if (bytesPer === 2) {
				v = Math.abs(dv.getInt16(o, true)) / 32768;
			} else if (bytesPer === 3) {
				const x = d[o] | (d[o + 1] << 8) | (d[o + 2] << 16);
				v = Math.abs((x << 8) >> 8) / 8388608; // 24-bit 符号扩展
			} else {
				v = Math.abs(dv.getInt32(o, true)) / 2147483648;
			}
			if (v > m) m = v;
		}
		peaks.push(Math.round(Math.min(1, m) * 1000) / 1000);
		sinceYield += step;
		if (sinceYield >= 4_000_000) {
			sinceYield = 0;
			await yieldMain();
		}
	}
	return {
		durationS: Math.round((frames / h.sampleRate) * 1000) / 1000,
		sampleRate: h.sampleRate,
		channels: h.channels,
		peaks
	};
}

/** wav 免解码直取；其余经 decodeAudioData：时长/采样率/声道 + 200 桶峰值波形；失败返回 null */
export async function decodeMeta(data: Uint8Array): Promise<DecodedMeta | null> {
	const fast = await wavMeta(data);
	if (fast) return fast;
	try {
		const ctx = new OfflineAudioContext(1, 1, 44100);
		// decodeAudioData 会接管 buffer，传副本
		const buf = await ctx.decodeAudioData(data.slice().buffer as ArrayBuffer);
		const ch = buf.getChannelData(0);
		const n = PEAK_BUCKETS;
		const peaks: number[] = [];
		const step = Math.max(1, Math.floor(ch.length / n));
		let sinceYield = 0;
		for (let i = 0; i < n; i++) {
			let m = 0;
			const s = i * step;
			for (let j = 0; j < step && s + j < ch.length; j++) {
				const v = Math.abs(ch[s + j]);
				if (v > m) m = v;
			}
			peaks.push(Math.round(Math.min(1, m) * 1000) / 1000);
			sinceYield += step;
			if (sinceYield >= 4_000_000) {
				sinceYield = 0;
				await yieldMain();
			}
		}
		return {
			durationS: Math.round(buf.duration * 1000) / 1000,
			sampleRate: buf.sampleRate,
			channels: buf.numberOfChannels,
			peaks
		};
	} catch {
		return null;
	}
}
