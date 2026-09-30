// 谱面集（osz）导入与合并打包——领域状态唯一入口，组件只渲染。
// osz = zip 容器：导入后全部条目解压留在内存（.osu 难度文件、歌曲音频、音效、皮肤资源等），
// 不出内存、不上传。覆盖原则：格子项目标文件名（<行>-<列><序号>.<格式>）与谱面集根目录
// 音频按「去扩展名 stem、不区分大小写」匹配——命中者被剔除、新音效写包根；未命中也写包根。
// 只匹配根目录音频：osu! 按 stem 在谱面根目录解析 hitsound；子目录音频是 .osu 里按显式
// 路径引用的独立资源（改名/换后缀会断引用），不参与覆盖。
// packArgs 的 entries+load 直接喂 packZip / saveZip（导出 .osz 落盘）；
// buildBytes 收集同一份字节流——osucad 实时预览（第二阶段）共用这个出口。
import { readArchive, ArchiveError, type ArchiveWasmLoaders } from './archive';
import { AUDIO_EXTS, fileExt, liftTopDir } from './upload-pipeline';
import { packZip, type PackZipOpts, type ZipEntry } from './zip-save';
import type { KitEntry } from './kit.svelte';

const AUDIO_EXT_SET = new Set(AUDIO_EXTS);
const AUDIO_MIME: Record<string, string> = { wav: 'audio/wav', ogg: 'audio/ogg', mp3: 'audio/mpeg' };

/** 导入上限：osz 全量解压进内存，超出直接拒绝（防弱设备 OOM） */
export const OSZ_MAX_BYTES = 256 * 1024 * 1024;

export interface OszEntry {
	path: string; // zip 内归一路径（唯一顶层文件夹已剥前缀提升）
	data: Uint8Array; // 解压后字节
	audio: boolean; // wav / ogg / mp3
}

/** 一条格子项的覆盖结果：target = 目标文件名，hits = 被替换的根目录音频 path */
export interface OverlayHit {
	uid: number;
	target: string;
	hits: string[];
}

export type OszErrorCode = ArchiveError['code'] | 'no_osu' | 'too_large';

export class OszError extends Error {
	readonly code: OszErrorCode;
	constructor(code: OszErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

/** 覆盖匹配的「同名」口径：basename 去扩展名、小写（不区分后缀与大小写） */
export function stemOf(path: string): string {
	const base = path.slice(path.lastIndexOf('/') + 1);
	const i = base.lastIndexOf('.');
	return (i === -1 ? base : base.slice(0, i)).toLowerCase();
}

/**
 * 覆盖计划：每条格子项 → 命中的谱面集根目录音频 path 列表（0 或更多——
 * 同 stem 不同后缀的多份音频全部命中，由同一份新内容顶替）。
 */
export function planOverlays(
	oszEntries: readonly OszEntry[],
	kitEntries: readonly KitEntry[]
): OverlayHit[] {
	const rootAudio = new Map<string, string[]>(); // stem → 根目录音频 path
	for (const e of oszEntries) {
		if (!e.audio || e.path.includes('/')) continue;
		const s = stemOf(e.path);
		rootAudio.set(s, [...(rootAudio.get(s) ?? []), e.path]);
	}
	return kitEntries.map((k) => ({
		uid: k.uid,
		target: k.target,
		hits: rootAudio.get(stemOf(k.target)) ?? []
	}));
}

/**
 * 合并打包清单（packZip 的 entries）：被替换的根目录音频剔除，
 * 格子项一律以目标文件名写包根（命中即顶替，未命中即新增）。
 * key 命名空间：o:<idx> = 谱面集原条目（内存直给），k:<uid> = 格子项（按 uid 反查 files.id 拉取）。
 */
export function planMerge(
	oszEntries: readonly OszEntry[],
	kitEntries: readonly KitEntry[]
): ZipEntry[] {
	const replaced = new Set(planOverlays(oszEntries, kitEntries).flatMap((o) => o.hits));
	const out: ZipEntry[] = [];
	oszEntries.forEach((e, i) => {
		if (!replaced.has(e.path)) out.push({ path: e.path, key: `o:${i}` });
	});
	for (const k of kitEntries) out.push({ path: k.target, key: `k:${k.uid}` });
	return out;
}

export class Osz {
	name = $state(''); // 导入文件名
	entries = $state<OszEntry[]>([]); // 全部条目（含非音频）

	// 试听用 blob URL（按条目缓存；clear/importFile 时统一回收）
	private urls = new Map<OszEntry, string>();

	get loaded(): boolean {
		return this.entries.length > 0;
	}

	/** 谱面集内全部音频条目（含子目录——展示用；匹配仍只算根目录） */
	get audioEntries(): OszEntry[] {
		return this.entries.filter((e) => e.audio);
	}

	/** .osu 难度文件数（导入校验要求 ≥1） */
	get beatmapCount(): number {
		return this.entries.reduce((n, e) => n + (fileExt(e.path) === 'osu' ? 1 : 0), 0);
	}

	/** 非音频条目数（.osu / 图片 / 视频等，导出时原样保留——展示口径） */
	get otherCount(): number {
		return this.entries.length - this.audioEntries.length;
	}

	/** 导出文件名 stem：剥掉 .osz/.zip 等压缩包后缀，saveZip 统一补 .osz */
	get exportName(): string {
		return this.name.replace(/\.(osz|zip|rar|7z)$/i, '') || 'beatmap';
	}

	/**
	 * 导入谱面集：魔数解包 → 唯一顶层文件夹剥前缀提升（同上传口径）→ 必须含 .osu。
	 * 失败抛 OszError（code 对应 zh.ts 的 osz.err.<code>）。重复导入先回收旧状态。
	 */
	async importFile(
		source: { name: string; bytes: Uint8Array },
		deps: { loadWasm: ArchiveWasmLoaders }
	): Promise<void> {
		if (source.bytes.length > OSZ_MAX_BYTES) {
			throw new OszError('too_large', `谱面包超出大小限制（≤${OSZ_MAX_BYTES / 1024 / 1024}MB）`);
		}
		let files: OszEntry[];
		try {
			const unpacked = await readArchive(source.bytes, deps.loadWasm);
			const lifted = liftTopDir(unpacked);
			files = (lifted?.stripped ?? unpacked).map((f) => ({
				path: f.path,
				data: f.data,
				audio: AUDIO_EXT_SET.has(fileExt(f.path))
			}));
		} catch (e) {
			throw new OszError(e instanceof ArchiveError ? e.code : 'corrupt', String(e));
		}
		if (!files.some((f) => fileExt(f.path) === 'osu')) {
			throw new OszError('no_osu', '包内没有 .osu 谱面文件');
		}
		this.clear();
		this.entries = files;
		this.name = source.name;
	}

	clear(): void {
		for (const u of this.urls.values()) URL.revokeObjectURL(u);
		this.urls.clear();
		this.entries = [];
		this.name = '';
	}

	/** 当前格子内容下的覆盖计划（命中集合驱动黄框） */
	overlays(kitEntries: readonly KitEntry[]): OverlayHit[] {
		return planOverlays(this.entries, kitEntries);
	}

	/**
	 * 合并打包参数（saveZip / packZip 直接可用；loadFile 由调用方注入——页面走 /f/<id>）。
	 * 格子项同 files.id 天然去重：packZip 按 key 只 load 一次。
	 */
	packArgs(
		kitEntries: readonly KitEntry[],
		loadFile: (id: string) => Promise<Uint8Array>
	): Omit<PackZipOpts, 'write'> {
		const ids = new Map(kitEntries.map((k) => [`k:${k.uid}`, k.id]));
		return {
			entries: planMerge(this.entries, kitEntries),
			concurrency: 6,
			load: (key) =>
				key.startsWith('o:')
					? Promise.resolve(this.entries[Number(key.slice(2))].data)
					: loadFile(ids.get(key) ?? '')
		};
	}

	/** 合并产物字节流：osucad 实时预览（第二阶段）与导出下载共用同一产物 */
	async buildBytes(
		kitEntries: readonly KitEntry[],
		loadFile: (id: string) => Promise<Uint8Array>
	): Promise<Uint8Array> {
		const chunks: Uint8Array[] = [];
		await packZip({ ...this.packArgs(kitEntries, loadFile), write: (c) => void chunks.push(c) });
		const total = chunks.reduce((s, c) => s + c.length, 0);
		const out = new Uint8Array(total);
		let off = 0;
		for (const c of chunks) {
			out.set(c, off);
			off += c.length;
		}
		return out;
	}

	/** 谱面集音频条目的试听 URL（惰性创建 blob URL，clear/重复导入时回收） */
	audioUrl(e: OszEntry): string {
		let u = this.urls.get(e);
		if (!u) {
			u = URL.createObjectURL(new Blob([e.data as BlobPart], { type: AUDIO_MIME[fileExt(e.path)] ?? '' }));
			this.urls.set(e, u);
		}
		return u;
	}
}

export const osz = new Osz();
