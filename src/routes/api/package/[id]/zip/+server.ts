// GET /api/package/<id>/zip：整包下载清单——包的当前 files 全列 + 每个去重 blob
// 的拉取 URL（R2 三项 secrets 齐时预签名 GET 直连，缺失时回退 /api/blob 同源代理）。
// 前端按清单并发拉取 + 流式拼 zip 保存：下载始终反映当前包内容（附加/改名后即时生效）。
// 服务端拼包不可行（免费计划单请求 50 子请求上限，大包 2400+ 文件必超）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv, blobKey } from '$lib/server/media';
import { getSecrets, pickR2Secrets } from '$lib/server/env';
import { presignGet } from '$lib/server/upload';

interface FileEntry {
	path: string; // folder_path/name（zip 内相对路径）
	hash: string;
	ext: string;
	size: number;
}

export const GET: RequestHandler = async ({ params, platform }) => {
	const env = getEnv(platform);
	if (!env) return json({ error: 'service_unavailable' }, { status: 503 });

	const pkg = await env.DB.prepare(
		`SELECT id, name FROM packages WHERE id = ?1 AND status = 'visible' AND append_to IS NULL`
	)
		.bind(params.id)
		.first<{ id: string; name: string }>();
	if (!pkg) return json({ error: 'package_not_found' }, { status: 404 });

	const { results } = await env.DB.prepare(
		`SELECT folder_path, name, blob_hash, format, size_bytes
		 FROM files WHERE package_id = ?1 ORDER BY folder_path, name COLLATE NOCASE`
	)
		.bind(pkg.id)
		.all<{ folder_path: string; name: string; blob_hash: string; format: string; size_bytes: number }>();

	const files: FileEntry[] = [];
	const hashExt = new Map<string, string>(); // 去重 hash → ext（同 hash 同内容，ext 一致）
	for (const r of results ?? []) {
		files.push({
			path: r.folder_path ? `${r.folder_path}/${r.name}` : r.name,
			hash: r.blob_hash,
			ext: r.format,
			size: r.size_bytes
		});
		hashExt.set(r.blob_hash, r.format);
	}
	if (files.length === 0) return json({ error: 'package_not_found' }, { status: 404 });

	// 预签名 GET 每个不同 URL ~800B；清单即时生成随包内容变化，不做缓存。
	// R2 三项凑齐才走预签名直连，否则回退同源代理（浏览/下载不依赖上传链路配置）
	const r2 = pickR2Secrets(getSecrets(platform));
	const urls = Object.fromEntries(
		await Promise.all(
			[...hashExt].map(async ([hash, ext]) => [
				hash,
				r2 ? await presignGet(r2, blobKey(hash, ext)) : `/api/blob/${hash}/${ext}`
			])
		)
	);

	return json({ name: pkg.name, files, urls }, { headers: { 'Cache-Control': 'no-store' } });
};
