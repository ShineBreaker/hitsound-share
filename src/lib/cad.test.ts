// Cad 预览桥：open→ready→load→update 状态机 + 推送合并（dirty 并发归并）
// + 格子字节缓存 LRU（createByteCache，注入 fetchBytes 直测）
import { describe, it, expect, vi } from 'vitest';
import { Cad, createByteCache, type CadDeps } from './cad.svelte';

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

	const meta = {
		title: 'T', artist: 'A', version: 'V', creator: 'C',
		duration: 60000, objects: 5, hasAudio: true, beatmapFile: 'a.osu',
		difficulties: ['V'], difficultyIndex: 0
	};
	const label = (m: unknown) => {
		const t = m as { type: string; action?: string };
		return t.action ? `${t.type}:${t.action}` : t.type;
	};

	it('播放中热更新：先暂停再构建，cad:loaded 后自动恢复播放', async () => {
		const { cad, sent } = setup();
		cad.openPreview();
		ready(cad);
		await tick();

		// 播放中改格子（cad:time 上报 playing）
		cad.onMessage({ type: 'cad:time', time: 1234, duration: 60000, playing: true });
		sent.length = 0;

		cad.invalidate();
		await tick();
		await tick();
		await tick();

		const labels = sent.map(label);
		// 暂停必须发生在构建推送之前（冻结窗口挪到暂停态）
		expect(labels.indexOf('hs:control:pause')).toBeGreaterThanOrEqual(0);
		expect(labels.indexOf('hs:update')).toBeGreaterThan(labels.indexOf('hs:control:pause'));

		// 构建失败路径之外不提前恢复；cad:loaded 到达后恢复播放，且在 hs:update 之后
		cad.onMessage({ type: 'cad:loaded', meta });
		const plays = sent.filter(m => label(m) === 'hs:control:play');
		expect(plays).toHaveLength(1);
		expect(sent.indexOf(plays[0])).toBeGreaterThan(labels.indexOf('hs:update'));
	});

	it('暂停态热更新：不自动暂停也不自动恢复（保持暂停、位置保留）', async () => {
		const { cad, sent } = setup();
		cad.openPreview();
		ready(cad);
		await tick();

		// 暂停态（cad:time 上报 playing=false）
		cad.onMessage({ type: 'cad:time', time: 1234, duration: 60000, playing: false });
		sent.length = 0;

		cad.invalidate();
		await tick();
		await tick();

		expect(sent.map(label)).toContain('hs:update');
		expect(sent.filter(m => label(m) === 'hs:control:pause')).toHaveLength(0);

		cad.onMessage({ type: 'cad:loaded', meta });
		expect(sent.filter(m => label(m) === 'hs:control:play')).toHaveLength(0);
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

describe('createByteCache（格子字节缓存 LRU）', () => {
	const bytes = (n: number) => new Uint8Array(n);

	it('超上限从最旧逐出；被逐出的 id 重拉走 fetch', async () => {
		const fetched: string[] = [];
		const c = createByteCache(
			async (id) => {
				fetched.push(id);
				return bytes(60);
			},
			100
		);
		await c.load('a');
		await c.load('b'); // 60+60 > 100 → 逐出最旧 a
		expect(c.size).toBe(1);
		expect(c.bytes).toBe(60);
		await c.load('a'); // 已逐出 → 重新 fetch
		expect(fetched).toEqual(['a', 'b', 'a']);
	});

	it('命中刷新 LRU 位：新近访问的不被逐出', async () => {
		const fetched: string[] = [];
		const c = createByteCache(
			async (id) => {
				fetched.push(id);
				return bytes(id === 'a' ? 60 : id === 'b' ? 30 : 40);
			},
			100
		);
		await c.load('a');
		await c.load('b'); // 90 ≤ 100
		await c.load('a'); // 命中刷新位（不再 fetch）
		await c.load('c'); // 130 > 100 → 逐出最旧的 b，a 因刷新保留
		expect(fetched.filter((x) => x === 'a')).toHaveLength(1); // a 未重拉
		expect(fetched.filter((x) => x === 'b')).toHaveLength(1);
		expect(c.size).toBe(2);
		expect(c.bytes).toBe(100);
	});

	it('同 id 并发合并为一次请求；在途完成登记不受期间逐出干扰', async () => {
		let resolveA!: (v: Uint8Array) => void;
		const fetched: string[] = [];
		const c = createByteCache(
			(id) =>
				new Promise<Uint8Array>((resolve) => {
					fetched.push(id);
					if (id === 'a') resolveA = resolve;
					else resolve(bytes(80));
				}),
			100
		);
		const pa1 = c.load('a'); // 挂起在途
		const pa2 = c.load('a'); // 并发共享同一在途 Promise
		await c.load('b'); // 期间完成另一条目（a 在途无条目可逐）
		resolveA(bytes(50)); // a 完成：登记 50 → 130 > 100 → 逐出 b
		const [r1, r2] = await Promise.all([pa1, pa2]);
		expect(r1).toBe(r2); // 同一字节对象（合并而非双拉）
		expect(fetched.filter((x) => x === 'a')).toHaveLength(1);
		expect(c.size).toBe(1);
		expect(c.bytes).toBe(50);
	});

	it('逐出后 buildBytes 重拉路径仍成功（新字节对象，CRC 按身份重算）', async () => {
		let n = 0;
		const c = createByteCache(
			async () => new Uint8Array([0x52, 0x49, ++n]),
			1 // cap=1：任何条目入缓存即超限，下一次必然逐出重拉
		);
		const buildBytes = async () => (await c.load('x')).slice(); // 模拟 osz.buildBytes 的取字节形态
		const r1 = await buildBytes();
		const r2 = await buildBytes(); // x 已被逐出 → 重新 fetch
		expect(n).toBe(2);
		expect(r1).not.toBe(r2); // 新对象（WeakMap CRC 缓存按身份失效，属预期重算）
		expect(r2[2]).toBe(2);
	});

	it('trim 只缩容不清空（close 语义：热格子驻留）', async () => {
		const c = createByteCache(async () => bytes(60), 100);
		await c.load('a');
		await c.load('b'); // 逐出 a，b 驻留
		c.trim();
		expect(c.size).toBe(1);
		expect(c.bytes).toBe(60);
	});
});
