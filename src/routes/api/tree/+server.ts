// /api/tree：各包 + 包内文件夹层级（一条 SQL 聚合 DISTINCT folder_path）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/media';

export const GET: RequestHandler = async ({ platform }) => {
	const env = getEnv(platform);
	if (!env) return json({ error: 'service_unavailable' }, { status: 503 });

	const { results } = await env.DB.prepare(
		`SELECT p.id, p.name, f.folder_path
		 FROM packages p JOIN files f ON f.package_id = p.id
		 WHERE p.status = 'visible'
		 GROUP BY p.id, p.name, f.folder_path
		 ORDER BY p.created_at DESC, p.name, f.folder_path`
	).all<{ id: string; name: string; folder_path: string }>();

	// 按包聚合文件夹路径列表（树的前端构建见 src/lib/api.ts buildForest）
	const byId = new Map<string, { id: string; name: string; folders: string[] }>();
	for (const row of results ?? []) {
		let pkg = byId.get(row.id);
		if (!pkg) {
			pkg = { id: row.id, name: row.name, folders: [] };
			byId.set(row.id, pkg);
		}
		pkg.folders.push(row.folder_path);
	}
	return json({ packages: [...byId.values()] });
};
