// 站点访问密码门统一拦截：/api/* 与 /f/*（单文件下载短链）未解锁一律 401 site_locked；
// 白名单 = 解锁端点自身与 /api/config（只透出开关/限制/用量，无目录数据，且携带 gate.locked
// 供前端显示解锁遮罩）。门未启用（无库记录且未配 SITE_DEFAULT_PASSWORD）不拦，站点行为同旧版。
// 首页 shell 是预渲染静态资产不进 Functions，数据全在被拦的 API 之后，故无需拦页面路径。
// 每个被拦请求 1 条 settings 主键 SELECT（见 site-gate.ts）。
// 跨源 CORS：CORS_ORIGINS 白名单命中时注入响应头 + OPTIONS 预检放行；未配置零行为变化。
import { json } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit';
import { getEnv } from '$lib/server/media';
import { getSecrets } from '$lib/server/env';
import { GATE_COOKIE, isSiteUnlocked } from '$lib/server/site-gate';
import {
	isAllowedOrigin,
	parseCorsOrigins,
	preflightResponse,
	withCorsHeaders
} from '$lib/server/cors';

const GATE_ALLOWED = new Set(['/api/site-gate', '/api/config']);

export const handle: Handle = async ({ event, resolve }) => {
	const path = event.url.pathname;
	const gated = path.startsWith('/api/') || path.startsWith('/f/');
	// 命中白名单才注入 CORS 头（origin 即回显值）；解析纯本地计算，不加子请求。
	// 仅请求带 Origin 头时才读 platform.env：跨源请求（fetch/预检）必带 Origin，而
	// prerenderable route 的 bindings 读取会被 adapter-cloudflare 直接抛错，须短路。
	const origin = event.request.headers.has('origin')
		? isAllowedOrigin(parseCorsOrigins(getSecrets(event.platform).CORS_ORIGINS), event.request)
		: null;
	const finish = (res: Response): Response => (origin ? withCorsHeaders(res, origin) : res);

	// OPTIONS 预检放行：必须在下方早退与门判定之前——门白名单端点（site-gate/config）自身
	// 不答 OPTIONS（落端点即 405），跨源 JSON 请求必先发预检；且预检不带 cookie，过不了门。
	if (event.request.method === 'OPTIONS' && gated && origin) return preflightResponse(origin);

	if (!gated || GATE_ALLOWED.has(path)) return finish(await resolve(event));

	const env = getEnv(event.platform);
	if (!env) return finish(await resolve(event)); // 无 bindings（构建期/未部署）：交由各端点自行 503
	const { SITE_DEFAULT_PASSWORD } = getSecrets(event.platform);
	if (!(await isSiteUnlocked(env.DB, event.cookies.get(GATE_COOKIE), SITE_DEFAULT_PASSWORD))) {
		// 门拒绝同样注入 CORS 头：跨源 fetch 收 401 时错误码可读，而非被浏览器吞成 TypeError
		return finish(json({ error: 'site_locked' }, { status: 401 }));
	}
	return finish(await resolve(event));
};
