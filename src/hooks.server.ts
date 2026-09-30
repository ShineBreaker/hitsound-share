// 站点访问密码门统一拦截：/api/* 与 /f/*（单文件下载短链）未解锁一律 401 site_locked；
// 白名单 = 解锁端点自身与 /api/config（只透出开关/限制/用量，无目录数据，且携带 gate.locked
// 供前端显示解锁遮罩）。门未启用（无库记录且未配 SITE_DEFAULT_PASSWORD）不拦，站点行为同旧版。
// 首页 shell 是预渲染静态资产不进 Functions，数据全在被拦的 API 之后，故无需拦页面路径。
// 每个被拦请求 1 条 settings 主键 SELECT（见 site-gate.ts）。
import { json } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit';
import { getEnv } from '$lib/server/media';
import { getSecrets } from '$lib/server/env';
import { GATE_COOKIE, isSiteUnlocked } from '$lib/server/site-gate';

const GATE_ALLOWED = new Set(['/api/site-gate', '/api/config']);

export const handle: Handle = async ({ event, resolve }) => {
	const path = event.url.pathname;
	const gated = path.startsWith('/api/') || path.startsWith('/f/');
	if (!gated || GATE_ALLOWED.has(path)) return resolve(event);

	const env = getEnv(event.platform);
	if (!env) return resolve(event); // 无 bindings（构建期/未部署）：交由各端点自行 503
	const { SITE_DEFAULT_PASSWORD } = getSecrets(event.platform);
	if (!(await isSiteUnlocked(env.DB, event.cookies.get(GATE_COOKIE), SITE_DEFAULT_PASSWORD))) {
		return json({ error: 'site_locked' }, { status: 401 });
	}
	return resolve(event);
};
