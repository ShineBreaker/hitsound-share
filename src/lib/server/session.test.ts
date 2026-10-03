// session deep module：签名/验签往返、双轨凭证择一（cookie 优先、x-hs-session 头兜底）、
// 交付码短时效。纯函数无 DB/R2，无子请求预算关联
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	SESSION_MAX_AGE_S,
	EXCHANGE_TTL_S,
	signSession,
	verifySession,
	readSession,
	pickSessionCredential
} from './session';

const SECRET = 'session-test-secret';
const USER = { osuId: 4242, username: 'player-1', avatarUrl: null };

afterEach(() => {
	vi.useRealTimers();
});

describe('signSession / verifySession', () => {
	it('往返：签名值可验出同一用户，exp = 签发时刻 + 7 天（缺省 ttl）', async () => {
		const t0 = 1_700_000_000_000;
		vi.useFakeTimers();
		vi.setSystemTime(t0);
		const value = await signSession(USER, SECRET);
		expect(value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/); // body.sig b64url 两段
		const user = await verifySession(value, SECRET);
		expect(user?.osuId).toBe(USER.osuId);
		expect(user?.username).toBe(USER.username);
		expect(user?.exp).toBe(Math.floor(t0 / 1000) + SESSION_MAX_AGE_S);
	});

	it('ttl 参数：EXCHANGE_TTL_S 签出 60s exp（交付码短时效）', async () => {
		const t0 = 1_700_000_000_000;
		vi.useFakeTimers();
		vi.setSystemTime(t0);
		const code = await signSession(USER, SECRET, EXCHANGE_TTL_S);
		const user = await verifySession(code, SECRET);
		expect(user?.exp).toBe(Math.floor(t0 / 1000) + EXCHANGE_TTL_S);
	});

	it('密钥不匹配 → null；篡改 body → null', async () => {
		const value = await signSession(USER, SECRET);
		expect(await verifySession(value, 'other-secret')).toBeNull();
		const [body, sig] = value.split('.');
		expect(await verifySession(`${body}x.${sig}`, SECRET)).toBeNull();
	});

	it('畸形 sig 段（非 base64 字符）→ null，不抛解码异常（畸形值可经 x-hs-session 头到达任意守卫端点）', async () => {
		// 合法 body + 畸形 sig
		const value = await signSession(USER, SECRET);
		const [body] = value.split('.');
		await expect(verifySession(`${body}.!!!not-base64!!!`, SECRET)).resolves.toBeNull();
		// 整值即畸形
		await expect(verifySession('x.!!!', SECRET)).resolves.toBeNull();
	});

	it('过期（ttl 已过）→ null', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_700_000_000_000);
		const code = await signSession(USER, SECRET, EXCHANGE_TTL_S);
		vi.setSystemTime(1_700_000_000_000 + (EXCHANGE_TTL_S + 1) * 1000);
		expect(await verifySession(code, SECRET)).toBeNull();
	});
});

describe('pickSessionCredential / readSession 双轨择一', () => {
	it('cookie 优先：cookie 存在时 header 不参与（同源行为逐字节一致）', () => {
		expect(pickSessionCredential('cookie-val', 'header-val')).toBe('cookie-val');
		// cookie 无效值也遮蔽 header——与门凭证三源择一同策略
		expect(pickSessionCredential('stale.badsig', 'good.sig')).toBe('stale.badsig');
	});

	it('无 cookie 时 header 兜底；两者皆无 → undefined', () => {
		expect(pickSessionCredential(undefined, 'header-val')).toBe('header-val');
		expect(pickSessionCredential(undefined, null)).toBeUndefined();
	});

	it('readSession：cookie 有效 → 胜出（header 篡改不影响）', async () => {
		const good = await signSession(USER, SECRET);
		const user = await readSession(good, 'tampered.sig', SECRET);
		expect(user?.osuId).toBe(USER.osuId);
	});

	it('readSession：cookie 缺失 + header 有效 → header 轨登录（桌面 WebView 场景）', async () => {
		const token = await signSession(USER, SECRET);
		const user = await readSession(undefined, token, SECRET);
		expect(user?.osuId).toBe(USER.osuId);
	});

	it('readSession：无效 cookie 遮蔽有效 header → null（401 路径）', async () => {
		const token = await signSession(USER, SECRET);
		expect(await readSession('stale.badsig', token, SECRET)).toBeNull();
	});

	it('readSession：两者皆无 → null', async () => {
		expect(await readSession(undefined, null, SECRET)).toBeNull();
	});
});
