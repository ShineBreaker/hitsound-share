// /p/<id>/download：整包下载 —— 回放上传时的 original.zip（packages/<pid>/original.zip）
import type { RequestHandler } from './$types';
import { getEnv, contentDisposition } from '$lib/server/media';

export const GET: RequestHandler = async ({ params, platform }) => {
	const env = getEnv(platform);
	if (!env) return new Response('Service unavailable', { status: 503 });

	const pkg = await env.DB.prepare('SELECT id, name FROM packages WHERE id = ?1 AND status = ?2')
		.bind(params.id, 'visible')
		.first<{ id: string; name: string }>();
	if (!pkg) return new Response('Not found', { status: 404 });

	const obj = await env.HITSOUND_FILES.get(`packages/${pkg.id}/original.zip`);
	if (!obj) return new Response('Zip missing', { status: 404 });

	return new Response(obj.body, {
		status: 200,
		headers: {
			'Content-Type': 'application/zip',
			'Content-Length': String(obj.size),
			'Content-Disposition': contentDisposition(`${pkg.name}.zip`)
		}
	});
};
