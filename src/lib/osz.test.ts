// 谱面集（osz）：导入校验、覆盖计划（根目录 stem 匹配）与合并打包产物
import { describe, it, expect } from 'vitest';
import { zipSync, unzipSync } from 'fflate';
import {
	Osz,
	OszError,
	stemOf,
	planOverlays,
	planMerge,
	type OszEntry
} from './osz.svelte';
import type { KitEntry } from './kit.svelte';
import type { ArchiveWasmLoaders } from './archive';

// zip 输入不触达 wasm 加载器（仅 rar/7z 才会调用）
const loaders: ArchiveWasmLoaders = {
	unrar: () => Promise.reject(new Error('测试不含 rar')),
	sz: () => Promise.reject(new Error('测试不含 7z'))
};

const b = (s: string) => new TextEncoder().encode(s);
const makeOsz = (files: Record<string, Uint8Array>) => zipSync(files);
const k = (uid: number, target: string, id = `file-${uid}`): KitEntry => ({ uid, id, target });

function audioEntry(path: string, data = b('x')): OszEntry {
	return { path, data, audio: /\.(wav|ogg|mp3)$/i.test(path) };
}

describe('stemOf', () => {
	it('basename 去扩展名、小写', () => {
		expect(stemOf('normal-hitnormal.wav')).toBe('normal-hitnormal');
		expect(stemOf('dir/Soft-HitClap.MP3')).toBe('soft-hitclap');
		expect(stemOf('noext')).toBe('noext');
		expect(stemOf('d.e.e/name.with.dots.wav')).toBe('name.with.dots');
	});
});

describe('Osz.importFile', () => {
	it('zip/osz 解包：条目全量入库（含非音频），统计口径正确', async () => {
		const o = new Osz();
		await o.importFile(
			{
				name: 'my map.osz',
				bytes: makeOsz({
					'my map.osu': b('osu file format v14'),
					'normal-hitnormal.wav': b('wav1'),
					'song.mp3': b('mp3'),
					'bg.jpg': b('jpg'),
					'SB/spinner.png': b('png')
				})
			},
			{ loadWasm: loaders }
		);
		expect(o.loaded).toBe(true);
		expect(o.entries).toHaveLength(5);
		expect(o.audioEntries.map((e) => e.path).sort()).toEqual(['normal-hitnormal.wav', 'song.mp3']);
		expect(o.beatmapCount).toBe(1);
		expect(o.otherCount).toBe(3);
		expect(o.exportName).toBe('my map');
	});

	it('唯一顶层文件夹剥前缀提升（zip 打包文件夹的常态）', async () => {
		const o = new Osz();
		await o.importFile(
			{
				name: 'wrapped.zip',
				bytes: makeOsz({ 'BeatmapFolder/a.osu': b('osu'), 'BeatmapFolder/x.wav': b('w') })
			},
			{ loadWasm: loaders }
		);
		expect(o.entries.map((e) => e.path).sort()).toEqual(['a.osu', 'x.wav']);
	});

	it('无 .osu → no_osu；非压缩包 → unknown_format', async () => {
		const o = new Osz();
		await expect(
			o.importFile({ name: 'x.osz', bytes: makeOsz({ 'a.wav': b('w') }) }, { loadWasm: loaders })
		).rejects.toMatchObject({ code: 'no_osu' });
		await expect(
			o.importFile({ name: 'x.osz', bytes: b('not an archive') }, { loadWasm: loaders })
		).rejects.toMatchObject({ code: 'unknown_format' });
	});

	it('重复导入回收旧状态', async () => {
		const o = new Osz();
		await o.importFile(
			{ name: 'a.osz', bytes: makeOsz({ 'a.osu': b('o'), 'x.wav': b('1') }) },
			{ loadWasm: loaders }
		);
		await o.importFile(
			{ name: 'b.osz', bytes: makeOsz({ 'b.osu': b('o'), 'y.wav': b('2') }) },
			{ loadWasm: loaders }
		);
		expect(o.name).toBe('b.osz');
		expect(o.entries.map((e) => e.path).sort()).toEqual(['b.osu', 'y.wav']);
	});
});

describe('planOverlays（覆盖计划）', () => {
	it('根目录音频同 stem（不区分后缀/大小写）即命中', () => {
		const oszFiles = [audioEntry('normal-hitnormal.wav'), audioEntry('song.mp3')];
		const plan = planOverlays(oszFiles, [k(1, 'normal-hitnormal.ogg'), k(2, 'soft-hitclap.wav')]);
		expect(plan[0].hits).toEqual(['normal-hitnormal.wav']);
		expect(plan[1].hits).toEqual([]);

		const ci = planOverlays([audioEntry('Normal-HitNormal.WAV')], [k(1, 'normal-hitnormal.wav')]);
		expect(ci[0].hits).toEqual(['Normal-HitNormal.WAV']);
	});

	it('子目录音频与非音频不参与匹配', () => {
		const oszFiles = [
			audioEntry('SB/normal-hitnormal.wav'),
			{ path: 'normal-hitnormal.png', data: b('p'), audio: false },
			{ path: 'm.osu', data: b('o'), audio: false }
		];
		const plan = planOverlays(oszFiles, [k(1, 'normal-hitnormal.wav')]);
		expect(plan[0].hits).toEqual([]);
	});

	it('同 stem 多份后缀全部命中', () => {
		const oszFiles = [audioEntry('x.wav'), audioEntry('x.mp3'), audioEntry('dir/x.wav')];
		const plan = planOverlays(oszFiles, [k(1, 'x.ogg')]);
		expect(plan[0].hits.sort()).toEqual(['x.mp3', 'x.wav']); // dir/x.wav 是子目录，不命中
	});
});

describe('planMerge（合并清单）', () => {
	it('被替换条目剔除、格子项写包根、其余原样保留', () => {
		const oszFiles = [
			audioEntry('normal-hitnormal.wav'),
			audioEntry('song.mp3'),
			{ path: 'm.osu', data: b('o'), audio: false },
			audioEntry('SB/soft-hitclap.wav')
		];
		const kit = [k(1, 'normal-hitnormal.ogg'), k(2, 'drum-hitfinish2.wav')];
		const entries = planMerge(oszFiles, kit);
		const paths = entries.map((e) => e.path);
		expect(paths).not.toContain('normal-hitnormal.wav'); // 被替换
		expect(paths).toContain('SB/soft-hitclap.wav'); // 子目录不动
		expect(paths).toContain('song.mp3');
		expect(paths).toContain('m.osu');
		expect(paths).toContain('normal-hitnormal.ogg'); // 顶替到包根
		expect(paths).toContain('drum-hitfinish2.wav'); // 未命中新增
	});

	it('空格子 = 原样重打包', () => {
		const oszFiles = [audioEntry('x.wav'), { path: 'm.osu', data: b('o'), audio: false }];
		const entries = planMerge(oszFiles, []);
		expect(entries.map((e) => e.path).sort()).toEqual(['m.osu', 'x.wav']);
	});
});

describe('Osz.buildBytes（导出产物）', () => {
	it('合并 osz 字节可解：替换生效、未动内容字节一致', async () => {
		const o = new Osz();
		await o.importFile(
			{
				name: 'map.osz',
				bytes: makeOsz({
					'm.osu': b('osu file format v14\n[General]'),
					'normal-hitnormal.wav': b('OLD'),
					'song.mp3': b('SONG')
				})
			},
			{ loadWasm: loaders }
		);
		const kit = [k(1, 'normal-hitnormal.ogg', 'new-sound')];
		const bytes = await o.buildBytes(kit, async (id) => {
			expect(id).toBe('new-sound');
			return b('NEW');
		});
		const out = unzipSync(bytes);
		expect(out['m.osu']).toEqual(b('osu file format v14\n[General]'));
		expect(out['song.mp3']).toEqual(b('SONG'));
		expect(out['normal-hitnormal.wav']).toBeUndefined(); // 已被剔除
		expect(out['normal-hitnormal.ogg']).toEqual(b('NEW')); // 顶替落包根
	});

	it('packArgs 的 load：o: 键读内存、k: 键走注入 loadFile', async () => {
		const o = new Osz();
		await o.importFile(
			{ name: 'm.osz', bytes: makeOsz({ 'm.osu': b('o'), 'x.wav': b('DATA') }) },
			{ loadWasm: loaders }
		);
		const args = o.packArgs([k(7, 'y.wav', 'id-7')], async () => b('FETCHED'));
		const i = args.entries.findIndex((e) => e.path === 'x.wav');
		expect(args.entries[i].key.startsWith('o:')).toBe(true);
		expect(await args.load(args.entries[i].key)).toEqual(b('DATA'));
		const ki = args.entries.findIndex((e) => e.path === 'y.wav');
		expect(ki).toBeGreaterThan(-1);
		expect(await args.load(args.entries[ki].key)).toEqual(b('FETCHED'));
	});
});
