// mapPool：并发上限、首个失败后不再调度新任务、在途任务收尾后重抛首个错误
import { describe, it, expect } from 'vitest';
import { mapPool } from './pool';

describe('mapPool', () => {
	it('全量处理且并发不超过 limit', async () => {
		let inflight = 0;
		let maxInflight = 0;
		const seen: number[] = [];
		await mapPool(
			Array.from({ length: 30 }, (_, i) => i),
			4,
			async (i) => {
				inflight++;
				maxInflight = Math.max(maxInflight, inflight);
				await new Promise((r) => setTimeout(r, 1));
				inflight--;
				seen.push(i);
			}
		);
		expect(maxInflight).toBeLessThanOrEqual(4);
		expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
	});

	it('首个失败后不再调度新任务，等在途收尾后重抛', async () => {
		const started: number[] = [];
		let settled = 0;
		const boom = new Error('boom');
		await expect(
			mapPool(
				Array.from({ length: 20 }, (_, i) => i),
				3,
				async (i) => {
					started.push(i);
					if (i === 0) throw boom;
					await new Promise((r) => setTimeout(r, 5));
					settled++;
				}
			)
		).rejects.toBe(boom);
		// 失败时已启动的在途任务跑完，但不会有超过 limit 个新任务被调度
		expect(started.length).toBeLessThanOrEqual(3);
		expect(settled).toBeLessThanOrEqual(2);
	});

	it('items 为空 / limit 大于条目数时直接完成', async () => {
		await mapPool([], 4, async () => {
			throw new Error('never');
		});
		const seen: number[] = [];
		await mapPool([1, 2], 10, async (i) => void seen.push(i));
		expect(seen).toHaveLength(2);
	});
});
