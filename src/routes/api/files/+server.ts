// /api/files：按包 + 文件夹分页列文件（不 SELECT peaks，波形按需另取）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/media';
import type { FileRow } from '$lib/types';

// 一页默认 200、上限 500（防一次拉爆 D1 行读与响应体）
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

interface DBFileRow {
	id: string;
	name: string;
	format: string;
	duration_s: number | null;
	sample_rate: number | null;
	bit_depth: number | null;
	channels: number | null;
	size_bytes: number;
}

export const GET: RequestHandler = async ({ platform, url }) => {
	const env = getEnv(platform);
	if (!env) return json({ error: 'service_unavailable' }, { status: 503 });

	// folder 含 # 空格 & 为常态，searchParams 已自动解码
	const pkg = url.searchParams.get('pkg') ?? '';
	const folder = url.searchParams.get('folder') ?? '';
	const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0') || 0);
	const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));

	// 只允许枚举 visible 包（全部值参数绑定，无 SQL 拼接）
	const exists = await env.DB.prepare('SELECT id FROM packages WHERE id = ?1 AND status = ?2')
		.bind(pkg, 'visible')
		.first<{ id: string }>();
	if (!exists) return json({ error: 'package_not_found' }, { status: 404 });

	// 计数 + 当前页，batch 一次往返；COUNT(*) 是全文件夹行读，
	// 「加载更多」（offset>0）时前端已持有 total，跳过计数省行读
	// 页查询（值全部参数绑定）
	const pageStmt = env.DB.prepare(
		`SELECT id, name, format, duration_s, sample_rate, bit_depth, channels, size_bytes
		 FROM files WHERE package_id = ?1 AND folder_path = ?2
		 ORDER BY name COLLATE NOCASE
		 LIMIT ?3 OFFSET ?4`
	).bind(pkg, folder, limit, offset);

	// 首页（offset=0）batch「COUNT + 当前页」一次往返；
	// 「加载更多」页前端已持有 total，跳过 COUNT（它是整个文件夹的全行读）只查当前页
	let total = -1;
	let rows: DBFileRow[];
	if (offset === 0) {
		const [countRes, pageRes] = await env.DB.batch([
			env.DB.prepare('SELECT COUNT(*) AS c FROM files WHERE package_id = ?1 AND folder_path = ?2').bind(pkg, folder),
			pageStmt
		]);
		total = (countRes.results[0] as { c: number } | undefined)?.c ?? 0;
		rows = (pageRes.results ?? []) as DBFileRow[];
	} else {
		const pageRes = await pageStmt.all();
		rows = (pageRes.results ?? []) as DBFileRow[];
	}

	const files: FileRow[] = rows.map((r) => ({
		id: r.id,
		name: r.name,
		folderPath: folder,
		format: r.format,
		durationS: r.duration_s,
		sampleRate: r.sample_rate,
		bitDepth: r.bit_depth,
		channels: r.channels,
		sizeBytes: r.size_bytes,
		peaks: null // 波形不随列表下发，前端按需拉 /api/waveform/<id>
	}));

	return json({ total, files });
};
