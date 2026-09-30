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
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ type: 'hs:load' });
	});

	it('就绪后的改动走 hs:update（热更新，不整页重载）', async () => {
		const { cad, sent } = setup();
		cad.openPreview();
		ready(cad);
		await tick();
		expect(sent[0]).toMatchObject({ type: 'hs:load' });

		cad.invalidate();
		await tick();
		expect(sent).toHaveLength(2);
		expect(sent[1]).toMatchObject({ type: 'hs:update' });
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
		expect(sent).toHaveLength(3);
		expect(sent[1]).toMatchObject({ type: 'hs:update' });
		expect(sent[2]).toMatchObject({ type: 'hs:update' });
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
				beatmapFile: 'a.osu'
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
		expect(sent).toHaveLength(1);

		cad.close();
		expect(cad.open).toBe(false);
		expect(cad.ready).toBe(false);
		expect(cad.loaded).toBe(false);
		expect(cad.meta).toBeNull();

		cad.openPreview();
		ready(cad);
		await tick();
		expect(sent).toHaveLength(2);
		expect(sent[1]).toMatchObject({ type: 'hs:load' }); // 新引擎重新 load
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
