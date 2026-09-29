// /f/<id>/download：单文件下载 —— attachment + RFC 5987 编码的原始文件名（含 # 空格 & 逗号）
import type { RequestHandler } from './$types';
import { getEnv, blobKey, contentDisposition, queryFileBlob } from '$lib/server/media';

export const GET: RequestHandler = async ({ params, platform }) => {
	const env = getEnv(platform);
	if (!env) return new Response('Service unavailable', { status: 503 });

	const row = await queryFileBlob(env.DB, params.id);
	if (!row) return new Response('Not found', { status: 404 });

	// 下载走全量流式回放，不做 Range（浏览器断点续传由重新 GET 满足）
	const obj = await env.HITSOUND_FILES.get(blobKey(row.hash, row.format));
	if (!obj) return new Response('Blob missing', { status: 404 });

	return new Response(obj.body, {
		status: 200,
		headers: {
			'Content-Type': row.mime,
			'Content-Length': String(obj.size),
			'Content-Disposition': contentDisposition(row.name),
			// 内容寻址对象不可变，可长缓存；ETag 供一致性校验
			'Cache-Control': 'public, max-age=31536000, immutable',
			ETag: `"${row.hash}"`
		}
	});
};
