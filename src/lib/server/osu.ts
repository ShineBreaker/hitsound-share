// 服务端出网唯一通道：仅允许 https://osu.ppy.sh 固定 host（Mimosa 硬性验收条件）。
// 其余一切服务端代码禁止直接 fetch 外部地址
export const OSU_ORIGIN = 'https://osu.ppy.sh';

/** 带 host 白名单校验的 osu! 请求：协议必须 https、主机必须是 osu.ppy.sh */
export async function osuFetch(path: string, init?: RequestInit): Promise<Response> {
	const url = new URL(path, OSU_ORIGIN);
	if (url.protocol !== 'https:' || url.hostname !== 'osu.ppy.sh') {
		throw new Error('blocked: only https://osu.ppy.sh is allowed');
	}
	return fetch(url.toString(), init);
}
