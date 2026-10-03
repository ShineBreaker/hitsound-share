// guard 层双轨凭证：requireUser 的 cookie 优先 / x-hs-session 头兜底 / 401 语义。
// 纯守卫逻辑不触库（isAdmin 由上层守卫调用），platform 只需 SESSION_SECRET
import { describe, it, expect } from 'vitest';
import { signSession, SESSION_COOKIE, SESSION_HEADER } from './session';
import { requireUser } from './guard';

const SECRET = 'guard-test-secret';
const USER = { osuId: 4242, username: 'player-1', avatarUrl: null };

function platform(secret?: string): App.Platform {
	// getEnv 要求 DB + HITSOUND_FILES bindings 齐全（requireUser 与门同款前置）；
	// requireUser 自身不触库，假值即可
	return {
		env: { SESSION_SECRET: secret, DB: {}, HITSOUND_FILES: {} }
	} as unknown as App.Platform;
}

const cookies = (value: string | undefined) => ({ get: (n: string) => (n === SESSION_COOKIE ? value : undefined) });

async function call(opts: {
	secret?: string;
	cookie?: string;
	header?: string | null;
}): Promise<Response | Awaited<ReturnType<typeof requireUser>>> {
	const headers: Record<string, string> = {};
	if (opts.header) headers[SESSION_HEADER] = opts.header;
	return requireUser(
		platform(opts.secret ?? SECRET),
		cookies(opts.cookie) as never,
		new Request('https://t.local/api/my', { headers })
	);
}

describe('requireUser 双轨凭证', () => {
	it('cookie 有效 → session（同源现状）', async () => {
		const g = await call({ cookie: await signSession(USER, SECRET) });
		expect((g as { session: { osuId: number } }).session.osuId).toBe(USER.osuId);
	});

	it('无 cookie + x-hs-session 有效 → session（桌面 token 轨）', async () => {
		const g = await call({ header: await signSession(USER, SECRET) });
		expect((g as { session: { osuId: number } }).session.osuId).toBe(USER.osuId);
	});

	it('cookie 优先：无效 cookie 遮蔽有效 header → 401（header 不覆盖 cookie）', async () => {
		const g = (await call({
			cookie: 'stale.badsig',
			header: await signSession(USER, SECRET)
		})) as Response;
		expect(g.status).toBe(401);
		expect(((await g.json()) as { error: string }).error).toBe('not_logged_in');
	});

	it('两者皆无 / header 无效 → 401', async () => {
		expect(((await call({})) as Response).status).toBe(401);
		const g = (await call({ header: 'tampered.sig' })) as Response;
		expect(g.status).toBe(401);
	});

	it('SESSION_SECRET 缺失 → 503（上传链路降级语义不变）', async () => {
		const g = (await requireUser(
			platform(undefined),
			cookies(undefined) as never,
			new Request('https://t.local/api/my', { headers: { [SESSION_HEADER]: 'x.y' } })
		)) as Response;
		expect(g.status).toBe(503);
	});
});
