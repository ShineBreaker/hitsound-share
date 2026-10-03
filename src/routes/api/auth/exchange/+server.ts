// POST /api/auth/exchange { code }：OAuth 交付码换完整会话签名值。
// 桌面（Tauri）等第三方 cookie 不可靠的环境：callback 302 回前端域时以 ?hs_code= 携带
// 短时效码（与 session 同 HMAC 同构，60s exp），前端用本端点换成 7 天会话 token 存
// localStorage，此后经 x-hs-session 头携带。无 DB 子请求；无严格一次性——码与会话仅
// 时效不同，60s 窗口即防重放取舍（码泄露至多换出一段会话，与 cookie 泄露同级；
// 见 docs/desktop.md）。本端点不在 hooks 门白名单内：门启用时同受 x-hs-gate 保护
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecrets } from '$lib/server/env';
import { signSession, verifySession } from '$lib/server/session';

export const POST: RequestHandler = async ({ request, platform }) => {
	const secrets = getSecrets(platform);
	if (!secrets.SESSION_SECRET) return json({ error: 'service_unavailable' }, { status: 503 });

	const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
	if (typeof body?.code !== 'string' || body.code === '') {
		return json({ error: 'bad_body' }, { status: 400 });
	}

	// verifySession 内置验签 + exp 时效检查：坏码 / 过期码一律 400 bad_code，不区分成因
	const user = await verifySession(body.code, secrets.SESSION_SECRET);
	if (!user) return json({ error: 'bad_code' }, { status: 400 });

	// 换发完整 7 天会话（exp 重置）；值与 cookie 值完全同构
	const token = await signSession(
		{ osuId: user.osuId, username: user.username, avatarUrl: user.avatarUrl },
		secrets.SESSION_SECRET
	);
	return json({ token });
};
