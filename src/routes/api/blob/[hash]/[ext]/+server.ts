// GET /api/blob/<hash>/<ext>：内容寻址 blob 的同源代理（整包下载在 R2 预签名
// secrets 缺失时的回退拉取路径；公开读，与试听同口径）。
// 参数严格校验（64 位小写 hex + 扩展名白名单）——它们拼进 R2 key，杜绝注入
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv, blobKey } from '$lib/server/media';
import { AUDIO_EXTS, MIME_BY_EXT, type AudioExt } from '$lib/server/upload';

export const GET: RequestHandler = async ({ params, platform }) => {
	const env = getEnv(platform);
	if (!env) return json({ error: 'service_unavailable' }, { status: 503 });

	const { hash, ext } = params;
	if (!/^[0-9a-f]{64}$/.test(hash) || !AUDIO_EXTS.includes(ext as AudioExt)) {
		return json({ error: 'bad_request' }, { status: 400 });
	}

	const obj = await env.HITSOUND_FILES.get(blobKey(hash, ext));
	if (!obj) return json({ error: 'not_found' }, { status: 404 });

	return new Response(obj.body, {
		status: 200,
		headers: {
			'Content-Type': MIME_BY_EXT[ext as AudioExt],
			'Content-Length': String(obj.size),
			'Cache-Control': 'public, max-age=31536000, immutable' // hash 即内容，永不变
		}
	});
};
