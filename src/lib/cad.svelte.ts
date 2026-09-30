// osu!cad 实时预览桥：悬浮窗内嵌 iframe（/osucad/index.html，本仓库 static/ 下的同源静态产物），
// postMessage 协议与 osucad 仓库 apps/hitsound-preview/src/protocol.ts 一一对应。
// 推送内容 = osz.buildBytes 的当前合并包字节（与「导出 .osz」同一份产物）：
// 格子音效或谱面集变化 → invalidate()（调用方防抖）→ flush 构建并投递。
// 引擎未就绪时改动挂起（dirty），收到 cad:ready 后补推；构建期间的新改动合并为下一次推送。
// 热更新由 iframe 内部完成（重建 Skin → sourceChanged → 采样重取），不重载页面、不重置播放位置。
import { kit } from './kit.svelte';
import { osz } from './osz.svelte';

/** iframe → 宿主的谱面元信息（对应 PreviewMeta） */
export interface CadMeta {
	title: string;
	artist: string;
	version: string;
	creator: string;
	duration: number;
	objects: number;
	hasAudio: boolean;
	beatmapFile: string;
	difficulties: string[];
	difficultyIndex: number;
}

type ToPreview =
	| { type: 'hs:load'; name: string; bytes: ArrayBuffer }
	| { type: 'hs:update'; name: string; bytes: ArrayBuffer }
	| { type: 'hs:control'; action: 'play' | 'pause' | 'seek' | 'stats'; value?: number }
	| { type: 'hs:control'; action: 'volume'; channel: 'music' | 'effects'; value: number }
	| { type: 'hs:control'; action: 'difficulty'; value: number };

type ToParent =
	| { type: 'cad:ready' }
	| { type: 'cad:loaded'; meta: CadMeta }
	| { type: 'cad:time'; time: number; duration: number; playing: boolean }
	| { type: 'cad:stats'; lookups: number; hits: number }
	| { type: 'cad:error'; message: string };

function isToParent(m: unknown): m is ToParent {
	if (typeof m !== 'object' || m === null) return false;
	const t = (m as { type?: unknown }).type;
	return (
		t === 'cad:ready' ||
		t === 'cad:loaded' ||
		t === 'cad:time' ||
		t === 'cad:stats' ||
		t === 'cad:error'
	);
}

export interface CadDeps {
	/** 当前合并包字节（与导出 .osz 同一产物） */
	buildBytes: () => Promise<Uint8Array>;
	/** 投递消息到 iframe（bytes 作为 transferable） */
	send: (msg: ToPreview) => void;
	/** 导出文件名（透传给 iframe 展示/调试） */
	name?: () => string;
	/** 当前是否有可推送的谱面集（测试可注入；缺省恒真） */
	hasContent?: () => boolean;
}

export class Cad {
	open = $state(false);
	ready = $state(false); // iframe 内引擎 loadComplete（cad:ready）
	loaded = $state(false); // 首个包已装载（cad:loaded）
	meta = $state<CadMeta | null>(null);
	time = $state(0);
	duration = $state(0);
	playing = $state(false);
	error = $state('');

	/** 音乐音量 0–1（音轨 mixer），localStorage 持久化 */
	volMusic = $state(readVolume('cad.vol.music'));
	/** 音效音量 0–1（采样 mixer），localStorage 持久化 */
	volEffects = $state(readVolume('cad.vol.effects'));

	/** 组件绑定的 iframe 元素（postMessage 目标；非响应式） */
	frame: HTMLIFrameElement | null = null;

	readonly #deps: CadDeps;
	#dirty = false; // 有待推送的包内容
	#pushing = false; // flush 进行中（新 invalidate 合并进循环）
	#sent = 0; // 已推送包数：0 → 下一条 hs:load，否则 hs:update
	#wantedDifficulty: number | null = null; // 用户选过的难度下标，重开后按此恢复

	constructor(deps: CadDeps) {
		this.#deps = deps;
	}

	openPreview(): void {
		if (!(this.#deps.hasContent?.() ?? true)) return;
		this.open = true;
		this.invalidate();
	}

	close(): void {
		this.open = false;
		this.ready = false;
		this.loaded = false;
		this.meta = null;
		this.time = 0;
		this.duration = 0;
		this.playing = false;
		this.error = '';
		this.#dirty = false;
		byteCache.clear(); // 预览关闭即释放缓存的格子字节
		// 关闭即卸载 iframe（组件 {#if}）→ 下次打开是新引擎，重新走 hs:load
		this.#sent = 0;
		this.frame = null;
	}

	/** 内容变化（格子/谱面集）：标脏并推送；未就绪时挂起等 cad:ready */
	invalidate(): void {
		if (!this.open || !(this.#deps.hasContent?.() ?? true)) return;
		this.#dirty = true;
		void this.#flush();
	}

	async #flush(): Promise<void> {
		if (this.#pushing || !this.ready || !this.open) return;
		this.#pushing = true;
		try {
			while (this.#dirty && this.open && this.ready) {
				this.#dirty = false;
				const bytes = await this.#deps.buildBytes();
				if (!this.open || !this.ready) break;
				this.#deps.send({
					type: this.#sent > 0 ? 'hs:update' : 'hs:load',
					name: this.#deps.name?.() ?? 'preview.osz',
					bytes: bytes.buffer as ArrayBuffer
				});
				this.#sent++;
			}
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
		} finally {
			this.#pushing = false;
		}
	}

	/** 组件收到 message 事件后调用（source/origin 校验在组件侧做） */
	onMessage(data: unknown): void {
		if (!isToParent(data)) return;
		switch (data.type) {
			case 'cad:ready':
				this.ready = true;
				if (this.open) {
					// iframe 每次打开都是新引擎——把持久化的音量推过去
					this.#sendVolume('music');
					this.#sendVolume('effects');
					void this.#flush();
				}
				break;
			case 'cad:loaded':
				this.loaded = true;
				this.meta = data.meta;
				this.error = '';
				// 重开/热更新后恢复用户之前选的难度（iframe 按路径保持，
				// 但谱面集换掉或全新引擎时下标可能漂移）
				if (
					this.#wantedDifficulty !== null &&
					data.meta.difficultyIndex !== this.#wantedDifficulty &&
					this.#wantedDifficulty < data.meta.difficulties.length
				) {
					this.selectDifficulty(this.#wantedDifficulty);
				}
				break;
			case 'cad:time':
				this.time = data.time;
				this.duration = data.duration;
				this.playing = data.playing;
				break;
			case 'cad:error':
				this.error = data.message;
				break;
			case 'cad:stats':
				break; // 冒烟/调试用，UI 不展示
		}
	}

	control(action: 'play' | 'pause' | 'seek' | 'stats', value?: number): void {
		if (!this.ready) return;
		this.#deps.send({ type: 'hs:control', action, value });
	}

	#sendVolume(channel: 'music' | 'effects'): void {
		if (!this.ready) return;
		const value = channel === 'music' ? this.volMusic : this.volEffects;
		this.#deps.send({ type: 'hs:control', action: 'volume', channel, value });
	}

	/** 音量 0–1；写状态 + 持久化 + 立即推给 iframe */
	setVolume(channel: 'music' | 'effects', value: number): void {
		const v = Math.min(1, Math.max(0, value));
		if (channel === 'music') this.volMusic = v;
		else this.volEffects = v;
		try {
			localStorage.setItem(`cad.vol.${channel}`, String(v));
		} catch {
			/* 隐私模式等场景忽略 */
		}
		this.#sendVolume(channel);
	}

	/** 切换难度（谱面集内 .osu 下标）；iframe 内热更新不改选择的难度 */
	selectDifficulty(index: number): void {
		this.#wantedDifficulty = index;
		if (!this.ready) return;
		this.#deps.send({ type: 'hs:control', action: 'difficulty', value: index });
	}
}

function readVolume(key: string): number {
	try {
		const v = Number(localStorage.getItem(key));
		return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1;
	} catch {
		return 1;
	}
}

/** 格子项音源：/f/<id> 全量拉取（与 osz 导出共用口径）。
 *  按 id 缓存字节：files.id 是文件行 id（内容不变），预览热更新反复重建
 *  时未变的格子项不再走网络栈（S7）；clear() 时随预览关闭清空。 */
const byteCache = new Map<string, Uint8Array>();

async function loadFileBytes(id: string): Promise<Uint8Array> {
	const hit = byteCache.get(id);
	if (hit) return hit;
	const r = await fetch(`/f/${encodeURIComponent(id)}`);
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	const bytes = new Uint8Array(await r.arrayBuffer());
	byteCache.set(id, bytes);
	return bytes;
}

export const cad = new Cad({
	buildBytes: () => osz.buildBytes(kit.entries, loadFileBytes),
	hasContent: () => osz.loaded,
	name: () => `${osz.exportName}.osz`,
	send(msg) {
		const w = cad.frame?.contentWindow;
		if (!w) return;
		// 字节负载 transferable 零拷贝；detached 无副作用（每次推送都是新 buildBytes）
		w.postMessage(msg, location.origin, msg.type === 'hs:control' ? [] : [msg.bytes]);
	}
});
