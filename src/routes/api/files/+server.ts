// /api/files：按包 + 文件夹分页列文件（不 SELECT peaks，波形按需另取）；
// DELETE 批量删除文件行（包主删自己包的 / 管理员任意，可跨包）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/media';
import { requireUser } from '$lib/server/guard';
import { isAdmin } from '$lib/server/admin';
import { releaseFiles, selectByIds } from '$lib/server/ledger';
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

const MAX_DELETE_IDS = 500;

/**
 * DELETE /api/files：body { ids: string[] }（≤500，去重）。
 * 目标可跨包：逐包校验归属——非管理员时所有文件的包都须是本人上传，
 * 任一不符 → 403 全不删（不做部分成功）；系统导入包（uploader NULL）仅管理员可动。
 */
export const DELETE: RequestHandler = async ({ request, platform, cookies }) => {
	const g = await requireUser(platform, cookies);
	if (g instanceof Response) return g;
	const env = g.env;

	const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
	const ids = body?.ids;
	if (
		!Array.isArray(ids) ||
		ids.length === 0 ||
		ids.length > MAX_DELETE_IDS ||
		!ids.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 64)
	) {
		return json({ error: 'bad_ids' }, { status: 400 });
	}
	const unique = [...new Set(ids)];

	// 目标文件的包归属（分片 IN；files 别名 f，选择器列名须带前缀）
	const ownerStmts = selectByIds(unique, 'f.id').map((s) =>
		env.DB.prepare(
			`SELECT DISTINCT f.package_id AS pid, p.uploader_osu_id AS owner
			 FROM files f JOIN packages p ON p.id = f.package_id WHERE ${s.clause}`
		).bind(...s.params)
	);
	const pkgRows: Array<{ pid: string; owner: number | null }> = [];
	for (let i = 0; i < ownerStmts.length; i += 250) {
		const res = await env.DB.batch(ownerStmts.slice(i, i + 250));
		for (const r of res) pkgRows.push(...((r.results ?? []) as typeof pkgRows));
	}
	if (pkgRows.length === 0) return json({ error: 'not_found' }, { status: 404 });
	// 全部是本人包则直接放行（省一次 users 读）；出现他人包才判定管理员
	if (
		pkgRows.some((r) => r.owner !== g.session.osuId) &&
		!(await isAdmin(env.DB, g.secrets, g.session.osuId))
	) {
		return json({ error: 'forbidden' }, { status: 403 });
	}

	const deleted = await releaseFiles(
		env,
		selectByIds(unique),
		[...new Set(pkgRows.map((r) => r.pid))]
	);
	return json({ ok: true, deleted });
};
