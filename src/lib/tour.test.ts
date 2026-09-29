// 引导：visibleSteps 过滤缺失目标 + 完成标记（localStorage hs_tour_v1）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { visibleSteps, type TourStep } from './tour';
import { ui, startTour, endTour, tourDone, TOUR_LS_KEY } from './ui.svelte';

describe('visibleSteps', () => {
	const steps: TourStep[] = [
		{ sel: '#a', title: 'A', body: 'a' },
		{ sel: '#b', title: 'B', body: 'b' },
		{ sel: '#c', title: 'C', body: 'c' }
	];

	it('只保留存在的目标（如上传未启用时无上传钮）', () => {
		const list = visibleSteps(steps, (sel) => sel !== '#b');
		expect(list.map((s) => s.sel)).toEqual(['#a', '#c']);
	});

	it('全缺失返回空数组', () => {
		expect(visibleSteps(steps, () => false)).toEqual([]);
	});
});

describe('tour done flag', () => {
	let store: Map<string, string>;
	beforeEach(() => {
		store = new Map();
		vi.stubGlobal('localStorage', {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k)
		});
		ui.tourActive = false;
	});
	afterEach(() => vi.unstubAllGlobals());

	it('未看过 → false；endTour 后 → true；startTour 可重开', () => {
		expect(tourDone()).toBe(false);
		startTour();
		expect(ui.tourActive).toBe(true);
		endTour();
		expect(ui.tourActive).toBe(false);
		expect(tourDone()).toBe(true);
		expect(store.get(TOUR_LS_KEY)).toBe('1');
		// 重开仍可用（flag 只挡自动启动）
		startTour();
		expect(ui.tourActive).toBe(true);
		endTour();
	});
});
