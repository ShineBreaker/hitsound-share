// PUT /api/admin/site-gate { password }：管理员（超管或 users.is_admin）修改站点访问密码。
// 新 hash 落库后立即给当前管理员签发新解锁 cookie 并在响应体下发同构 token（跨源管理员
// 改密后免重输；旧会话全站作废，改密者不被锁在门外）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/guard';
import { getSecrets } from '$lib/server/env';
import { isAllowedOrigin, parseCorsOrigins } from '$lib/server/cors';
import {
	GATE_COOKIE,
	GATE_MAX_AGE_S,
	setGatePassword,
	validGatePassword,
	issueUnlockValue
} from '$lib/server/site-gate';

export const PUT: RequestHandler = async ({ request, platform, cookies }) => {
	const g = await requireAdmin(platform, cookies);
	if (g instanceof Response) return g;

	const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
	const pw = typeof body?.password === 'string' ? body.password : '';
	if (!validGatePassword(pw)) return json({ error: 'bad_password' }, { status: 400 });

	const hash = await setGatePassword(g.env.DB, pw);
	const token = await issueUnlockValue(hash);
	// SameSite 按跨源判定（与 site-gate POST 同口径）：Origin ∈ CORS_ORIGINS → None
	const crossOrigin = isAllowedOrigin(
		parseCorsOrigins(getSecrets(platform).CORS_ORIGINS),
		request
	);
	cookies.set(GATE_COOKIE, token, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: crossOrigin ? 'none' : 'lax',
		maxAge: GATE_MAX_AGE_S
	});
	return json({ ok: true, token });
};
