// fetchPeaks 批量合并：16ms 窗口内的 id 合并成一次 /api/waveform?ids=… 请求；
// 失败 resolve null 并把本批 id 逐出缓存（下次可重试）；
// exchangeAuthCode：OAuth 交付码换会话 token（桌面端登录态 header 轨）
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchPeaks, buildForest, exchangeAuthCode, fetchMe, unlockSite } from './api';
import {
	clearConnection,
	GATE_TOKEN_KEY,
	getGateToken,
	getSessionToken,
	setApiBase
} from './api-base.svelte';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('fetchPeaks', () => {
	it('窗口内 3 个 id → 一次批量请求，各自 resolve', async () => {
		vi.useFakeTimers();
		const calls: string[] = [];
		vi.stubGlobal('fetch', async (url: string) => {
			calls.push(url);
			return new Response(
				JSON.stringify({ peaks: { bt_a: [0.1], bt_b: [0.2], bt_c: [0.3] } }),
				{ status: 200 }
			);
		});
		const p = Promise.all([fetchPeaks('bt_a'), fetchPeaks('bt_b'), fetchPeaks('bt_c')]);
		await vi.advanceTimersByTimeAsync(50);
		expect(await p).toEqual([[0.1], [0.2], [0.3]]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatch(/^\/api\/waveform\?ids=/);
		expect(decodeURIComponent(calls[0])).toContain('bt_a,bt_b,bt_c');
	});

	it('同 id 二次调用命中缓存，不再发请求', async () => {
		vi.useFakeTimers();
		const calls: string[] = [];
		vi.stubGlobal('fetch', async (url: string) => {
			calls.push(url);
			return new Response(JSON.stringify({ peaks: { bt_d: [0.5] } }), { status: 200 });
		});
		const p = fetchPeaks('bt_d');
		await vi.advanceTimersByTimeAsync(50);
		expect(await p).toEqual([0.5]);
		await vi.advanceTimersByTimeAsync(50);
		expect(await fetchPeaks('bt_d')).toEqual([0.5]);
		expect(calls).toHaveLength(1);
	});

	it('请求失败 → resolve null 且逐出缓存（下次重发）', async () => {
		vi.useFakeTimers();
		let calls = 0;
		vi.stubGlobal('fetch', async () => {
			calls++;
			return new Response('x', { status: calls === 1 ? 500 : 200 });
		});
		const p1 = fetchPeaks('bt_e');
		await vi.advanceTimersByTimeAsync(50);
		expect(await p1).toBeNull();
		// 第二次（缓存已逐出）→ 重发请求成功
		vi.stubGlobal(
			'fetch',
			async () => new Response(JSON.stringify({ peaks: { bt_e: [0.9] } }), { status: 200 })
		);
		const p2 = fetchPeaks('bt_e');
		await vi.advanceTimersByTimeAsync(50);
		expect(await p2).toEqual([0.9]);
		expect(calls).toBeGreaterThanOrEqual(1);
	});

		it('响应缺少该 id → resolve null（但留在缓存）', async () => {
			vi.useFakeTimers();
			vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ peaks: {} }), { status: 200 }));
			const p = fetchPeaks('bt_f');
			await vi.advanceTimersByTimeAsync(50);
			expect(await p).toBeNull();
		});
});

describe('buildForest', () => {
	it('owner id/用户名冗余下传到包节点与各级文件夹节点；系统导入为 null', () => {
		const [root, sys] = buildForest([
			{ id: 'p1', name: 'P1', uploaderOsuId: 42, uploaderUsername: 'alice', folders: ['a/b', 'a'] },
			{ id: 'p2', name: 'P2', uploaderOsuId: null, uploaderUsername: null, folders: [''] }
		]);
		expect(root.ownerOsuId).toBe(42);
		expect(root.ownerName).toBe('alice');
		const a = root.children.find((n) => n.name === 'a')!;
		expect(a.ownerOsuId).toBe(42);
		expect(a.ownerName).toBe('alice');
		expect(a.children[0].ownerName).toBe('alice'); // 深层文件夹同样携带
		expect(sys.ownerName).toBeNull();
	});
});

describe('exchangeAuthCode（OAuth 交付码落地）', () => {
	afterEach(() => {
		clearConnection(); // api-base 模块级 $state 跨用例共享
	});

	function lastCall(): { url: string; init: RequestInit } {
		return calls.at(-1)!;
	}
	let calls: Array<{ url: string; init: RequestInit }>;

	it('成功：POST /api/auth/exchange 带 { code }，token 存入会话态并返回 true', async () => {
		calls = [];
		vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
			calls.push({ url, init: init ?? {} });
			return new Response(JSON.stringify({ token: 'sess-7d' }), { status: 200 });
		});
		await expect(exchangeAuthCode('short-lived-code')).resolves.toBe(true);
		const { url, init } = lastCall();
		expect(url).toBe('/api/auth/exchange');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({ code: 'short-lived-code' });
		expect(getSessionToken()).toBe('sess-7d');
	});

	it('失败（400 bad_code）→ 返回 false 且不落 token', async () => {
		vi.stubGlobal(
			'fetch',
			async () => new Response(JSON.stringify({ error: 'bad_code' }), { status: 400 })
		);
		await expect(exchangeAuthCode('expired-code')).resolves.toBe(false);
		expect(getSessionToken()).toBeNull();
	});

	it('换发成功后，后续 apiFetch 自动附 x-hs-session（登录态 header 轨闭环）', async () => {
		calls = [];
		vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
			calls.push({ url, init: init ?? {} });
			return new Response(
				JSON.stringify(url === '/api/auth/exchange' ? { token: 'sess-7d' } : { loggedIn: true }),
				{ status: 200 }
			);
		});
		await exchangeAuthCode('code-1');
		calls = [];
		await fetchMe();
		expect(calls[0].url).toBe('/api/auth/me');
		expect(new Headers(calls[0].init.headers).get('x-hs-session')).toBe('sess-7d');
	});
});

describe('unlockSite（站点门解锁）', () => {
	afterEach(() => {
		clearConnection(); // api-base 模块级 $state 跨用例共享
	});

	function stubStore(): Map<string, string> {
		const store = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k)
		});
		return store;
	}

	function stubUnlock(): Array<{ url: string; init: RequestInit }> {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
			calls.push({ url, init: init ?? {} });
			return new Response(JSON.stringify({ ok: true, token: 'tok-9.a' }), { status: 200 });
		});
		return calls;
	}

	it('同源（base 空）：POST /api/site-gate 带 { password }，token 不落 localStorage（纯 cookie 轨）', async () => {
		const store = stubStore();
		const calls = stubUnlock();
		await unlockSite('pw-1');
		expect(calls[0].url).toBe('/api/site-gate');
		expect(calls[0].init.method).toBe('POST');
		expect(JSON.parse(calls[0].init.body as string)).toEqual({ password: 'pw-1' });
		expect(getGateToken()).toBeNull();
		expect(store.has(GATE_TOKEN_KEY)).toBe(false);
	});

	it('跨源（base 非空）：token 存入门态与 localStorage（apiFetch / absoluteApiUrl 可用）', async () => {
		const store = stubStore();
		stubUnlock();
		setApiBase('https://api.example.com');
		await unlockSite('pw-1');
		expect(getGateToken()).toBe('tok-9.a');
		expect(store.get(GATE_TOKEN_KEY)).toBe('tok-9.a');
	});

	it('旧后端无 token 字段 → 忽略不报错（cookie 语义照旧）', async () => {
		const store = stubStore();
		setApiBase('https://api.example.com');
		vi.stubGlobal(
			'fetch',
			async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
		);
		await expect(unlockSite('pw-1')).resolves.toBeUndefined();
		expect(getGateToken()).toBeNull();
		expect(store.has(GATE_TOKEN_KEY)).toBe(false);
	});
});
