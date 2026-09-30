// Kit：格子内容/序号续编/计数与重名 + cellForKey 物理键位映射
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Kit, kit, cellForKey, KIT_ROWS, KIT_COLS, type KitFile } from './kit.svelte';

const f = (id: string, name = `${id}.wav`): KitFile => ({ id, name, format: 'wav' });

describe('Kit', () => {
	let k: Kit;
	beforeEach(() => {
		k = new Kit();
	});

	it('首放入新格子立即可见于 entries/count（回归：??= 裸数组吞首次 push）', () => {
		k.add('normal/hitnormal', f('a'));
		expect(k.count).toBe(1);
		expect(k.entries).toHaveLength(1);
		expect(k.entries[0].target).toBe('normal-hitnormal.wav');
		// 再放入第二格不受首格影响
		k.add('drum/hitclap', f('b'));
		expect(k.count).toBe(2);
	});

	it('add 用空序号；addNumbered 逻辑序号从 1 起、1 渲染为无后缀', () => {
		k.add('drum/hitnormal', f('solo'));
		expect(k.cells['drum/hitnormal'][0].suffix).toBe('');

		k.addNumbered('soft/hitwhistle', [f('x'), f('y'), f('z')]);
		// 逻辑组下标 1/2/3 → 存储 '', '2', '3'（lazer 只为 ≥2 查后缀名）
		expect(k.cells['soft/hitwhistle'].map((i) => i.suffix)).toEqual(['', '2', '3']);
		const targets = k.entries.map((e) => e.target);
		expect(targets).toContain('soft-hitwhistle.wav');
		expect(targets).toContain('soft-hitwhistle2.wav');
		expect(targets).toContain('soft-hitwhistle3.wav');
		expect(targets).not.toContain('soft-hitwhistle1.wav');
	});

	it('手填序号 1 与空序号同义（都生成无后缀名）', () => {
		k.addNumbered('normal/hitnormal', [f('a'), f('b')]);
		k.setSuffix('normal/hitnormal', k.cells['normal/hitnormal'][1].uid, '1');
		const targets = k.entries.map((e) => e.target);
		expect(targets).toEqual(['normal-hitnormal.wav', 'normal-hitnormal.wav']);
		expect(k.dupTargets.has('normal-hitnormal.wav')).toBe(true);
	});

	it("addNumbered 从格内最大逻辑序号续编，空序号记作 1", () => {
		k.addNumbered('drum/hitclap', [f('a'), f('b')]); // '', '2'
		k.add('drum/hitclap', f('manual')); // '' → 逻辑 1
		k.addNumbered('drum/hitclap', [f('c'), f('d')]); // 续编 3,4
		expect(k.cells['drum/hitclap'].map((i) => i.suffix)).toEqual(['', '2', '', '3', '4']);
	});

	it('remove 移除单项、clear 清空、setSuffix 改序号', () => {
		k.addNumbered('normal/hitfinish', [f('a'), f('b')]);
		const uid = k.cells['normal/hitfinish'][0].uid;
		k.setSuffix('normal/hitfinish', k.cells['normal/hitfinish'][1].uid, '9');
		expect(k.cells['normal/hitfinish'][1].suffix).toBe('9');
		k.remove('normal/hitfinish', uid);
		expect(k.count).toBe(1);
		k.clear();
		expect(k.count).toBe(0);
		expect(k.entries).toEqual([]);
	});

	it('滑条列按 <行>-<列><序号> 命名（sliderslide/slidertick）', () => {
		k.addNumbered('drum/sliderslide', [f('a'), f('b')]);
		k.add('normal/slidertick', f('c'));
		expect(k.entries.map((e) => e.target)).toEqual([
			'normal-slidertick.wav',
			'drum-sliderslide.wav',
			'drum-sliderslide2.wav'
		]);
	});

	it('dupTargets 标出 zip 内重名（含序号冲突）', () => {
		k.add('normal/hitnormal', f('a')); // normal-hitnormal.wav
		k.addNumbered('normal/hitnormal', [f('b'), f('c')]); // 续编 '2','3' → 不重名
		expect(k.dupTargets.size).toBe(0);
		k.add('normal/hitnormal', f('d')); // 又一个 normal-hitnormal.wav
		expect(k.dupTargets.has('normal-hitnormal.wav')).toBe(true);
	});

	it('单例 kit 可用且 add 不吞首放', () => {
		kit.clear();
		kit.add('soft/hitfinish', f('s'));
		expect(kit.count).toBe(1);
		kit.clear();
	});
});

describe('cellForKey', () => {
	const ev = (code: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent =>
		({ code, ctrlKey: false, altKey: false, metaKey: false, target: null, ...extra }) as KeyboardEvent;

	beforeEach(() => {
		vi.stubGlobal('document', { querySelector: () => null });
	});
	afterEach(() => vi.unstubAllGlobals());

	it('18 个物理键全部映射到对应格子（滑条两列在行尾）', () => {
		const map: Record<string, string> = {
			KeyQ: 'normal/hitnormal',
			KeyW: 'normal/hitwhistle',
			KeyE: 'normal/hitfinish',
			KeyR: 'normal/hitclap',
			KeyT: 'normal/sliderslide',
			KeyY: 'normal/slidertick',
			KeyA: 'soft/hitnormal',
			KeyS: 'soft/hitwhistle',
			KeyD: 'soft/hitfinish',
			KeyF: 'soft/hitclap',
			KeyG: 'soft/sliderslide',
			KeyH: 'soft/slidertick',
			KeyZ: 'drum/hitnormal',
			KeyX: 'drum/hitwhistle',
			KeyC: 'drum/hitfinish',
			KeyV: 'drum/hitclap',
			KeyB: 'drum/sliderslide',
			KeyN: 'drum/slidertick'
		};
		for (const [code, want] of Object.entries(map)) {
			expect(cellForKey(ev(code)), code).toBe(want);
		}
		expect(cellForKey(ev('KeyM'))).toBeNull();
	});

	it('修饰键 / 输入目标 / 模态在场时返回 null', () => {
		expect(cellForKey(ev('KeyQ', { ctrlKey: true }))).toBeNull();
		expect(cellForKey(ev('KeyQ', { metaKey: true }))).toBeNull();
		expect(cellForKey(ev('KeyQ', { altKey: true }))).toBeNull();

		const input = { closest: (s: string) => (s.includes('input') ? {} : null) };
		expect(cellForKey(ev('KeyQ', { target: input as unknown as EventTarget }))).toBeNull();
		const editable = { closest: (s: string) => (s.includes('contenteditable') ? {} : null) };
		expect(cellForKey(ev('KeyQ', { target: editable as unknown as EventTarget }))).toBeNull();

		vi.stubGlobal('document', {
			querySelector: (s: string) => (s === '[aria-modal="true"]' ? {} : null)
		});
		expect(cellForKey(ev('KeyQ'))).toBeNull();
	});
});
