// /api/tree：各包 + 包内文件夹层级（一条 SQL 聚合 DISTINCT folder_path）
// 影子 pending 包（append_to 非空）不进树；uploader_osu_id 供前端判定改名按钮显示
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/media';

export const GET: RequestHandler = async ({ platform }) => {
	const env = getEnv(platform);
	if (!env) return json({ error: 'service_unavailable' }, { status: 503 });

	const { results } = await env.DB.prepare(
		`SELECT p.id, p.name, p.uploader_osu_id, f.folder_path
		 FROM packages p JOIN files f ON f.package_id = p.id
		 WHERE p.status = 'visible' AND p.append_to IS NULL
		 GROUP BY p.id, p.name, p.uploader_osu_id, f.folder_path
		 ORDER BY p.created_at DESC, p.name, f.folder_path`
	).all<{ id: string; name: string; uploader_osu_id: number | null; folder_path: string }>();

	// 按包聚合文件夹路径列表（树的前端构建见 src/lib/api.ts buildForest）
	const byId = new Map<string, { id: string; name: string; uploaderOsuId: number | null; folders: string[] }>();
	for (const row of results ?? []) {
		let pkg = byId.get(row.id);
		if (!pkg) {
			pkg = { id: row.id, name: row.name, uploaderOsuId: row.uploader_osu_id, folders: [] };
			byId.set(row.id, pkg);
		}
		pkg.folders.push(row.folder_path);
	}
	// 树查询是 files 覆盖索引全扫描（lasse 库约 2400 行读/次）：
	// 浏览器缓存 60 秒，重复页面加载不再打 D1（新上传最迟 1 分钟可见，浏览场景可接受；
	// 上传完成/改名后前端用 cache:'reload' 强刷绕过）。private：禁止中间代理缓存
	return json(
		{ packages: [...byId.values()] },
		{ headers: { 'Cache-Control': 'private, max-age=60' } }
	);
};
