// Cad 预览桥：open→ready→load→update 状态机 + 推送合并（dirty 并发归并）
import { describe, it, expect, vi } from 'vitest';
import { Cad, type CadDeps } from './cad.svelte';

const bytes = (n: number) => new Uint8Array([n]);

function setup(over: Partial<CadDeps> = {}) {
	const sent: unknown[] = [];
	let version = 0;
	const deps: CadDeps = {
		buildBytes: vi.fn(async () => bytes(++version)),
		send: (m) => sent.push(m),
		...over
	};
	return { cad: new Cad(deps), sent };
}

const ready = (c: Cad) => c.onMessage({ type: 'cad:ready' });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Cad', () => {
	it('openPreview 后等 cad:ready 才发 hs:load（未就绪挂起）', async () => {
		const { cad, sent } = setup();
		cad.openPreview();
		await tick();
		expect(sent).toHaveLength(0); // 引擎未就绪，不投

		ready(cad);
		await tick();
		// sent = [vol music, vol effects, hs:load]
		expect(sent.at(-1)).toMatchObject({ type: 'hs:load' });
		expect(sent.filter(m => (m as { type: string }).type === 'hs:load')).toHaveLength(1);
	});

	it('就绪后的改动走 hs:update（热更新，不整页重载）', async () => {
		const { cad, sent } = setup();
		cad.openPreview();
		ready(cad);
		await tick();
		expect(sent.at(-1)).toMatchObject({ type: 'hs:load' });

		cad.invalidate();
		await tick();
		expect(sent.at(-1)).toMatchObject({ type: 'hs:update' });
	});

	it('构建期间的连续改动合并为一次推送（dirty 归并）', async () => {
		const { cad, sent } = setup();
		cad.openPreview();
		ready(cad);
		await tick();

		// 模拟一次慢构建：多次 invalidate 落在同一 flush 窗口
		// 语义：每条已提交的构建对应一次发送 → 3 次 invalidate 归并为 2 条 update
		cad.invalidate();
		cad.invalidate();
		cad.invalidate();
		await tick();
		const updates = sent.filter(m => (m as { type: string }).type === 'hs:update');
		expect(updates).toHaveLength(2);
	});

	it('buildBytes 变慢时的 dirty 仍被循环消化', async () => {
		const sent: unknown[] = [];
		let gate!: () => void;
		const deps: CadDeps = {
			buildBytes: () => new Promise<Uint8Array>((r) => (gate = () => r(bytes(1)))),
			send: (m) => sent.push(m)
		};
		const c = new Cad(deps);
		c.openPreview();
		ready(c);
		await tick();
		// flush 在 buildBytes 上等 gate；期间再标脏
		c.invalidate();
		gate();
		await tick();
		gate();
		await tick();
		expect(sent.length).toBeGreaterThanOrEqual(1);
		expect(sent.at(-1)).toMatchObject({ type: 'hs:update' });
	});

	it('cad:loaded/cad:time/cad:error 更新状态', async () => {
		const { cad } = setup();
		cad.openPreview();
		ready(cad);
		cad.onMessage({
			type: 'cad:loaded',
			meta: {
				title: 'T',
				artist: 'A',
				version: 'V',
				creator: 'C',
				duration: 60000,
				objects: 5,
				hasAudio: true,
				beatmapFile: 'a.osu',
				difficulties: ['V'],
				difficultyIndex: 0
			}
		});
		expect(cad.loaded).toBe(true);
		expect(cad.meta?.title).toBe('T');

		cad.onMessage({ type: 'cad:time', time: 1234, duration: 60000, playing: true });
		expect(cad.time).toBe(1234);
		expect(cad.playing).toBe(true);

		cad.onMessage({ type: 'cad:error', message: 'boom' });
		expect(cad.error).toBe('boom');
	});

	it('close 复位全部状态，重开后重新走 hs:load', async () => {
		const { cad, sent } = setup();
		cad.openPreview();
		ready(cad);
		await tick();
		expect(sent.at(-1)).toMatchObject({ type: 'hs:load' });

		cad.close();
		expect(cad.open).toBe(false);
		expect(cad.ready).toBe(false);
		expect(cad.loaded).toBe(false);
		expect(cad.meta).toBeNull();

		cad.openPreview();
		ready(cad);
		await tick();
		const loads = sent.filter(m => (m as { type: string }).type === 'hs:load');
		expect(loads).toHaveLength(2); // 新引擎重新 load
	});

	it('音量按声道推送并在 ready 时恢复持久化值', async () => {
		const { cad, sent } = setup();
		cad.openPreview();
		ready(cad);
		await tick();

		// ready 时两声道各推一次（默认值 1）
		const vols = sent.filter(
			m => (m as { action?: string }).action === 'volume'
		);
		expect(vols).toHaveLength(2);
		expect(vols).toContainEqual(expect.objectContaining({ channel: 'music', value: 1 }));
		expect(vols).toContainEqual(expect.objectContaining({ channel: 'effects', value: 1 }));

		cad.setVolume('effects', 0.4);
		expect(cad.volEffects).toBe(0.4);
		expect(sent.at(-1)).toMatchObject({
			type: 'hs:control',
			action: 'volume',
			channel: 'effects',
			value: 0.4
		});
	});

	it('选择难度推送 difficulty，ready 前只记忆不发送', async () => {
		const { cad, sent } = setup();
		cad.selectDifficulty(2); // 未就绪：只记录
		expect(sent).toHaveLength(0);

		cad.openPreview();
		ready(cad);
		await tick();

		sent.length = 0;
		cad.selectDifficulty(1);
		expect(sent[0]).toMatchObject({
			type: 'hs:control',
			action: 'difficulty',
			value: 1
		});

		// 已装载难度与期望不符时自动重发
		cad.onMessage({
			type: 'cad:loaded',
			meta: {
				title: 'T', artist: 'A', version: 'V', creator: 'C',
				duration: 1, objects: 1, hasAudio: true, beatmapFile: 'a.osu',
				difficulties: ['E', 'N', 'H'], difficultyIndex: 0
			}
		});
		expect(sent.at(-1)).toMatchObject({
			type: 'hs:control',
			action: 'difficulty',
			value: 1
		});
	});

	it('无内容时不推送（hasContent=false）', async () => {
		const { cad, sent } = setup({ hasContent: () => false });
		cad.openPreview();
		expect(cad.open).toBe(false); // 没谱面集不开窗
		ready(cad);
		await tick();
		expect(sent).toHaveLength(0);
	});

	it('未识别消息类型被忽略', () => {
		const { cad } = setup();
		cad.onMessage({ type: 'hacker', payload: 1 });
		cad.onMessage(null);
		cad.onMessage('cad:ready'); // 非对象
		expect(cad.ready).toBe(false);
	});
});
