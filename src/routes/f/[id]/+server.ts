// /f/<id>：音频流 —— R2 绑定代理读取，支持 Range（单区间 206 + 显式 Content-Length，
// 多区间/非法回退 200 全量），ETag = sha256，immutable 缓存；全程流式不缓冲整对象
import type { RequestHandler } from './$types';
import { getEnv, blobKey, parseRange, queryFileBlob } from '$lib/server/media';

const CACHE_CTRL = 'public, max-age=31536000, immutable';

export const GET: RequestHandler = async ({ params, platform, request }) => {
	const env = getEnv(platform);
	if (!env) return new Response('Service unavailable', { status: 503 });

	const row = await queryFileBlob(env.DB, params.id);
	if (!row) return new Response('Not found', { status: 404 });

	const key = blobKey(row.hash, row.format);
	const etag = `"${row.hash}"`;
	const baseHeaders: Record<string, string> = {
		'Content-Type': row.mime,
		'Cache-Control': CACHE_CTRL,
		ETag: etag,
		'Accept-Ranges': 'bytes'
	};

	// 条件请求命中 → 304（省一次 R2 读）
	const inm = request.headers.get('if-none-match');
	if (inm && inm.split(',').some((v) => v.trim() === etag)) {
		return new Response(null, { status: 304, headers: baseHeaders });
	}

	// 尺寸取 D1 库值（done 核验保证与 R2 对象一致），省一次 R2 head（Class B）；
	// suffix 区间与 416 判定都依赖它；对象缺失的 404 由下方各 get 分支兜底
	const size = row.size;

	const range = parseRange(request.headers.get('range'), size);
	if (range === 'unsatisfiable') {
		return new Response(null, {
			status: 416,
			headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` }
		});
	}

	if (range === null || range === 'multi' || range === 'invalid') {
		// 无 Range / 多区间 / 非法 → 200 全量流式回放
		const obj = await env.HITSOUND_FILES.get(key);
		if (!obj) return new Response('Blob missing', { status: 404 });
		return new Response(obj.body, {
			status: 200,
			headers: { ...baseHeaders, 'Content-Length': String(size) }
		});
	}

	// 单区间 → 206 + Content-Range + 显式 Content-Length（播放器 seek 依赖）
	const obj = await env.HITSOUND_FILES.get(key, {
		range: { offset: range.offset, length: range.length }
	});
	if (!obj) return new Response('Blob missing', { status: 404 });
	return new Response(obj.body, {
		status: 206,
		headers: {
			...baseHeaders,
			'Content-Length': String(range.length),
			'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`
		}
	});
};

// HEAD 复用 GET 的头逻辑，仅去掉 body（播放器探测用）
export const HEAD: RequestHandler = async (event) => {
	const res = await GET(event);
	return new Response(null, { status: res.status, headers: res.headers });
};
