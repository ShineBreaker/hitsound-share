// POST /api/site-gate { password }：解锁站点。正确 → 签发 30 天 HttpOnly cookie（hs_gate）并
// 在响应体下发同构 token（跨源 Web / 桌面端无 cookie 保障，存 localStorage 后经
// x-hs-gate 头 / ?hs_gate= query 携带）；错误 → 401 wrong_password；连续失败达阈值 →
// 429 too_many_attempts（isolate 内存限速，见 site-gate.ts）；门未启用 → 404。
// 本端点在 hooks 白名单内，未解锁可访问
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/media';
import { getSecrets } from '$lib/server/env';
import { isAllowedOrigin, parseCorsOrigins } from '$lib/server/cors';
import {
	GATE_COOKIE,
	GATE_MAX_AGE_S,
	checkGatePassword,
	clearGateAttempts,
	gateAttemptAllowed,
	getGateState,
	issueUnlockValue,
	recordGateFailure
} from '$lib/server/site-gate';

export const POST: RequestHandler = async ({ request, platform, cookies }) => {
	const env = getEnv(platform);
	if (!env) return json({ error: 'service_unavailable' }, { status: 503 });

	// 失败限速（cf-connecting-ip 由 Pages 注入；缺失时归并 unknown）：锁定期内直接 429，
	// 不查库不验密——本端点在门白名单内且无其他防线，是全站唯一的匿名爆破面
	const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
	if (!gateAttemptAllowed(ip)) return json({ error: 'too_many_attempts' }, { status: 429 });

	const secrets = getSecrets(platform);
	const defaultPw = secrets.SITE_DEFAULT_PASSWORD;
	const state = await getGateState(env.DB, defaultPw);
	if (!state.enabled || !state.hash) return json({ error: 'gate_not_enabled' }, { status: 404 });

	const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
	if (typeof body?.password !== 'string') return json({ error: 'bad_body' }, { status: 400 });

	if (!(await checkGatePassword(env.DB, body.password, defaultPw))) {
		recordGateFailure(ip);
		return json({ error: 'wrong_password' }, { status: 401 });
	}
	clearGateAttempts(ip);
	const token = await issueUnlockValue(state.hash);
	// SameSite 按跨源判定：请求 Origin ∈ CORS_ORIGINS → None（跨源 Web 顶层导航下载的
	// cookie 轨），其余维持 Lax 现状
	const crossOrigin = isAllowedOrigin(parseCorsOrigins(secrets.CORS_ORIGINS), request);
	cookies.set(GATE_COOKIE, token, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: crossOrigin ? 'none' : 'lax',
		maxAge: GATE_MAX_AGE_S
	});
	return json({ ok: true, token });
};
