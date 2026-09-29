// /api/waveform/<id>：单文件波形峰值（files.peaks 的 JSON 数组）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/media';

export const GET: RequestHandler = async ({ params, platform }) => {
	const env = getEnv(platform);
	if (!env) return json({ error: 'service_unavailable' }, { status: 503 });

	const row = await env.DB.prepare('SELECT peaks FROM files WHERE id = ?1')
		.bind(params.id)
		.first<{ peaks: string | null }>();
	if (!row) return json({ error: 'not_found' }, { status: 404 });

	// peaks 为 TEXT 存的 JSON 数组；缺失（如 mp3 未解析）返回 null，前端显示占位
	let peaks: number[] | null = null;
	if (row.peaks) {
		try {
			const parsed: unknown = JSON.parse(row.peaks);
			if (Array.isArray(parsed)) {
				peaks = parsed.filter((v): v is number => typeof v === 'number');
			}
		} catch {
			peaks = null;
		}
	}
	return json({ peaks });
};
