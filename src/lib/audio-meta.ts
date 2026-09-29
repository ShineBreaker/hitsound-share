// 音频元数据解码（浏览器专用：借 OfflineAudioContext 的解码器，无需用户手势）。
// 独立于上传管线存在以便注入：测试环境给假实现即可
export interface DecodedMeta {
	durationS: number;
	sampleRate: number;
	channels: number;
	peaks: number[]; // 200 桶峰值（0-1）
}

/** decodeAudioData：时长/采样率/声道 + 200 桶峰值波形；解码失败返回 null */
export async function decodeMeta(data: Uint8Array): Promise<DecodedMeta | null> {
	try {
		const ctx = new OfflineAudioContext(1, 1, 44100);
		// decodeAudioData 会接管 buffer，传副本
		const buf = await ctx.decodeAudioData(data.slice().buffer as ArrayBuffer);
		const ch = buf.getChannelData(0);
		const n = 200;
		const peaks: number[] = [];
		const step = Math.max(1, Math.floor(ch.length / n));
		for (let i = 0; i < n; i++) {
			let m = 0;
			const s = i * step;
			for (let j = 0; j < step && s + j < ch.length; j++) {
				const v = Math.abs(ch[s + j]);
				if (v > m) m = v;
			}
			peaks.push(Math.round(Math.min(1, m) * 1000) / 1000);
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
