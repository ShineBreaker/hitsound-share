// GET /api/waveform?ids=a,b,c：批量文件波形峰值（files.peaks 的 JSON 数组）。
// 前端 fetchPeaks 把 16ms 窗口内的请求合并成一次调用；缺失/未解析的 id 回 null
// （如 mp3 未解出波形），前端显示占位。peaks 是内容静态数据，可私有缓存 1h
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/media';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // uuid 形态，收紧防注入/超长
const MAX_IDS = 100; // 与前端分批大小一致

function parsePeaks(raw: string | null): number[] | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === 'number') : null;
	} catch {
		return null;
	}
}

export const GET: RequestHandler = async ({ url, platform }) => {
	const env = getEnv(platform);
	if (!env) return json({ error: 'service_unavailable' }, { status: 503 });

	const ids = (url.searchParams.get('ids') ?? '')
		.split(',')
		.filter((s) => s.length > 0);
	if (ids.length === 0 || ids.length > MAX_IDS || !ids.every((id) => ID_RE.test(id))) {
		return json({ error: 'bad_request' }, { status: 400 });
	}

	const { results } = await env.DB.prepare(
		`SELECT id, peaks FROM files WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(', ')})`
	)
		.bind(...ids)
		.all<{ id: string; peaks: string | null }>();

	const byId = new Map((results ?? []).map((r) => [r.id, r.peaks]));
	const peaks: Record<string, number[] | null> = {};
	for (const id of ids) peaks[id] = parsePeaks(byId.get(id) ?? null);

	return json({ peaks }, { headers: { 'Cache-Control': 'private, max-age=3600' } });
};
