// POST /api/auth/exchange：OAuth 交付码换完整会话签名值。
// 有效码（60s 内）→ 200 { token }（7 天会话，值与 cookie 同构）；过期/篡改 → 400 bad_code。
// 无 DB：零子请求预算关联
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EXCHANGE_TTL_S, SESSION_MAX_AGE_S, signSession, verifySession } from '$lib/server/session';
import { POST } from './+server';

const SECRET = 'exchange-test-secret';
const USER = { osuId: 4242, username: 'player-1', avatarUrl: null };

afterEach(() => {
	vi.useRealTimers();
});

function call(body: unknown): Promise<Response> {
	return POST({
		request: new Request('https://t.local/api/auth/exchange', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		}),
		platform: { env: { SESSION_SECRET: SECRET } }
	} as unknown as Parameters<typeof POST>[0]);
}

describe('POST /api/auth/exchange', () => {
	it('有效交付码 → 200 { token }；token 验出同一用户且 exp 重置为完整 7 天', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_700_000_000_000);
		const code = await signSession(USER, SECRET, EXCHANGE_TTL_S);
		// 消耗 30s（回调跳转 + 前端交换的真实延迟形态），码仍在时效内
		vi.setSystemTime(1_700_000_000_000 + 30_000);

		const res = await call({ code });
		expect(res.status).toBe(200);
		const { token } = (await res.json()) as { token: string };
		const user = await verifySession(token, SECRET);
		expect(user?.osuId).toBe(USER.osuId);
		expect(user?.username).toBe(USER.username);
		expect(user?.exp).toBe(Math.floor(1_700_000_030_000 / 1000) + SESSION_MAX_AGE_S);
	});

	it('过期码（60s 后到达）→ 400 bad_code', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_700_000_000_000);
		const code = await signSession(USER, SECRET, EXCHANGE_TTL_S);
		vi.setSystemTime(1_700_000_000_000 + (EXCHANGE_TTL_S + 1) * 1000);

		const res = await call({ code });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe('bad_code');
	});

	it('篡改码（签名破坏）→ 400 bad_code', async () => {
		const code = await signSession(USER, SECRET, EXCHANGE_TTL_S);
		const [body, sig] = code.split('.');
		const res = await call({ code: `${body}.${sig.slice(0, -2)}xx` });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe('bad_code');
	});

	it('非法字符码（sig 段非 base64）→ 400 bad_code 而非 500（解码异常不得逃逸）', async () => {
		const code = await signSession(USER, SECRET, EXCHANGE_TTL_S);
		const [body] = code.split('.');
		const res = await call({ code: `${body}.!!!not-base64!!!` });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe('bad_code');
	});

	it('密钥不符的码（异部署）→ 400 bad_code', async () => {
		const code = await signSession(USER, 'other-secret', EXCHANGE_TTL_S);
		expect((await call({ code })).status).toBe(400);
	});

	it('结构坏 body（缺 code / 非 JSON）→ 400 bad_body', async () => {
		expect(((await call({})) as Response).status).toBe(400);
		expect(((await call('not-json')) as Response).status).toBe(400);
	});

	it('SESSION_SECRET 未配置 → 503', async () => {
		const res = await POST({
			request: new Request('https://t.local/api/auth/exchange', { method: 'POST', body: '{}' }),
			platform: { env: {} }
		} as unknown as Parameters<typeof POST>[0]);
		expect(res.status).toBe(503);
	});
});
