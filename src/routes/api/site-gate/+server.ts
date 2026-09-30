// POST /api/site-gate { password }：解锁站点。正确 → 签发 30 天 HttpOnly cookie（hs_gate），
// 错误 → 401 wrong_password（本端点在 hooks 白名单内，未解锁可访问；门未启用 → 404）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/media';
import { getSecrets } from '$lib/server/env';
import {
	GATE_COOKIE,
	GATE_MAX_AGE_S,
	checkGatePassword,
	getGateState,
	issueUnlockValue
} from '$lib/server/site-gate';

export const POST: RequestHandler = async ({ request, platform, cookies }) => {
	const env = getEnv(platform);
	if (!env) return json({ error: 'service_unavailable' }, { status: 503 });

	const defaultPw = getSecrets(platform).SITE_DEFAULT_PASSWORD;
	const state = await getGateState(env.DB, defaultPw);
	if (!state.enabled || !state.hash) return json({ error: 'gate_not_enabled' }, { status: 404 });

	const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
	if (typeof body?.password !== 'string') return json({ error: 'bad_body' }, { status: 400 });

	if (!(await checkGatePassword(env.DB, body.password, defaultPw))) {
		return json({ error: 'wrong_password' }, { status: 401 });
	}
	cookies.set(GATE_COOKIE, await issueUnlockValue(state.hash), {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		maxAge: GATE_MAX_AGE_S
	});
	return json({ ok: true });
};
