// fetchPeaks 批量合并：16ms 窗口内的 id 合并成一次 /api/waveform?ids=… 请求；
// 失败 resolve null 并把本批 id 逐出缓存（下次可重试）
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchPeaks } from './api';

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
