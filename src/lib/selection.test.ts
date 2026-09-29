// Selection：有序多选集（切换/连选/清空/锚点/顺序保持），跨文件夹保留
import { describe, it, expect, beforeEach } from 'vitest';
import { Selection, type KitFile } from './selection.svelte';

const f = (id: string): KitFile => ({ id, name: `${id}.wav`, format: 'wav' });

describe('Selection', () => {
	let sel: Selection;
	beforeEach(() => {
		sel = new Selection();
	});

	it('toggle 加入/移除，锚点跟随最后交互项', () => {
		sel.toggle(f('a'));
		sel.toggle(f('b'));
		expect(sel.size).toBe(2);
		expect(sel.anchor).toBe('b');
		sel.toggle(f('a')); // 再点取消
		expect(sel.has('a')).toBe(false);
		expect(sel.size).toBe(1);
		expect(sel.anchor).toBe('b'); // 锚点不因取消他人而变
		sel.toggle(f('b'));
		expect(sel.anchor).toBe(''); // 取消锚点项则清空锚点
	});

	it('selectRange 按给定顺序补齐缺失项，已存在项不重复，锚点不动', () => {
		sel.toggle(f('b'));
		sel.selectRange([f('a'), f('b'), f('c'), f('d')]);
		expect(sel.items.map((i) => i.id)).toEqual(['b', 'a', 'c', 'd']);
		expect(sel.anchor).toBe('b'); // 锚点保持最后 toggle 项，连选可反复调整范围
	});

	it('插入顺序保持；clear 清空并复位锚点', () => {
		sel.selectRange([f('z'), f('y'), f('x')]);
		expect(sel.items.map((i) => i.id)).toEqual(['z', 'y', 'x']);
		sel.clear();
		expect(sel.size).toBe(0);
		expect(sel.anchor).toBe('');
		expect(sel.items).toEqual([]);
	});

	it('跨文件夹选中保留：直接操作的集合不依赖当前文件表', () => {
		sel.toggle(f('folder1/file'));
		sel.toggle(f('folder2/file'));
		expect(sel.size).toBe(2);
		expect(sel.has('folder1/file')).toBe(true);
	});
});
