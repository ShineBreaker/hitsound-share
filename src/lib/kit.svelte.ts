// 组装面板领域状态（格子内容 / 序号编号 / 键位映射 / 开面态）——唯一入口，组件只渲染。
// 注意：绝不能对 $state 代理用 `??=` 返回值做写操作（`(cells[k] ??= []).push(x)` 的
// `??=` 求值结果是裸数组而非代理，push 不触发响应式、数组 length 源还停在 0 ——
// 「第一次拖不进格子」的根因）。所有写入一律整列重赋值或经 `cells[k]` 复读出的代理。

export const KIT_ROWS = ['normal', 'soft', 'drum'] as const;
export const KIT_COLS = [
	'hitnormal',
	'hitwhistle',
	'hitfinish',
	'hitclap',
	'sliderslide',
	'slidertick'
] as const;
export type KitRow = (typeof KIT_ROWS)[number];
export type KitCol = (typeof KIT_COLS)[number];
export type CellKey = `${KitRow}/${KitCol}`;

export interface KitFile {
	id: string; // files.id → /f/<id> 取数据
	name: string; // 源文件名（格子内显示）
	format: string; // 目标扩展名沿用源格式
}

export interface KitItem extends KitFile {
	uid: number; // 同一文件可重复入格，each 键必须全局唯一
	suffix: string; // 可选数字序号（'' = 无后缀）
}

export interface KitEntry {
	uid: number;
	id: string;
	target: string; // <行>-<列><序号>.<格式>
}

// 物理键位 → 格子（e.code 与键盘布局无关）：QWERTY=normal 行，ASDFGH=soft 行，ZXCVBN=drum 行
export const CELL_KEYS: Record<string, CellKey> = {
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

// 反查：格子 → 键帽字母（选中文件后格角显示的快捷提示）
export const CELL_LETTERS = Object.fromEntries(
	Object.entries(CELL_KEYS).map(([code, key]) => [key, code.slice(3)])
) as Record<CellKey, string>;

/**
 * 键盘事件 → 目标格子。不响应的场景：组合键（Ctrl/Alt/Meta）、
 * 焦点在可编辑元素（input/textarea/select/contenteditable）、任意模态框打开中
 */
export function cellForKey(e: KeyboardEvent): CellKey | null {
	if (e.ctrlKey || e.altKey || e.metaKey) return null;
	const el = e.target as Element | null;
	if (typeof el?.closest === 'function' && el.closest('input, textarea, select, [contenteditable]')) {
		return null;
	}
	if (typeof document !== 'undefined' && document.querySelector('[aria-modal="true"]')) return null;
	return CELL_KEYS[e.code] ?? null;
}

/** 目标文件名：序号 '1' 与 '' 同义（lazer 只为组下标 ≥2 查后缀名，`hitnormal1.wav` 不会被读取） */
export function kitTarget(row: KitRow, col: KitCol, it: KitItem): string {
	return `${row}-${col}${it.suffix === '1' ? '' : it.suffix}.${it.format}`;
}

let uidSeq = 0;

export class Kit {
	cells = $state<Record<string, KitItem[]>>({});
	open = $state(false); // FAB(false) ↔ 面板(true)；快捷键入格也会展开
	notice = $state(''); // kit-bar aria-live 播报（「已加入 N 个到 …」）
	flashKey = $state(''); // 刚被写入的格子，短暂高亮反馈

	private flashTimer: ReturnType<typeof setTimeout> | null = null;

	/** 单文件拖入：无序号（沿用原行为） */
	add(key: string, file: KitFile): void {
		this.cells[key] = [...(this.cells[key] ?? []), { ...file, uid: ++uidSeq, suffix: '' }];
	}

	/** 批量入格（多选/多文件拖入）：逻辑序号从 1 起（osu! 音效组下标 1 = 无后缀名）；
	 *  格内已有项按逻辑序号取最大值续编（'' 记作 1），1 渲染为 '' 不写进文件名 */
	addNumbered(key: string, files: KitFile[]): void {
		if (files.length === 0) return;
		const list = this.cells[key] ?? [];
		let max = 0;
		for (const it of list) {
			const n = it.suffix === '' ? 1 : Number(it.suffix);
			if (Number.isInteger(n) && n > max) max = n;
		}
		let next = max + 1;
		const items = files.map((f) => {
			const n = next++;
			return { ...f, uid: ++uidSeq, suffix: n === 1 ? '' : String(n) };
		});
		this.cells[key] = [...list, ...items];
	}

	remove(key: string, uid: number): void {
		const list = this.cells[key];
		if (!list) return;
		this.cells[key] = list.filter((i) => i.uid !== uid);
	}

	/** 移除引用给定文件 id 的全部格子项（文件被删除后调用，防止打包时 404） */
	removeByFileIds(ids: Set<string>): void {
		for (const k of Object.keys(this.cells)) {
			const list = this.cells[k];
			const filtered = list.filter((i) => !ids.has(i.id));
			if (filtered.length !== list.length) this.cells[k] = filtered;
		}
	}

	clear(): void {
		this.cells = {};
	}

	setSuffix(key: string, uid: number, suffix: string): void {
		const it = this.cells[key]?.find((i) => i.uid === uid);
		if (it) it.suffix = suffix;
	}

	/** 格子短暂高亮（加入反馈；仅过渡色，无位移动画） */
	flash(key: string): void {
		this.flashKey = key;
		if (this.flashTimer) clearTimeout(this.flashTimer);
		this.flashTimer = setTimeout(() => (this.flashKey = ''), 900);
	}

	/** 展平为打包清单（按行×列稳定序）：target = <行>-<列><序号>.<格式>（序号规则见 kitTarget） */
	get entries(): KitEntry[] {
		const out: KitEntry[] = [];
		for (const row of KIT_ROWS) {
			for (const col of KIT_COLS) {
				for (const it of this.cells[`${row}/${col}`] ?? []) {
					out.push({ uid: it.uid, id: it.id, target: kitTarget(row, col, it) });
				}
			}
		}
		return out;
	}

	get count(): number {
		return this.entries.length;
	}

	/** 重名检测：zip 内同名条目解压时互相覆盖，标红提醒用户调序号 */
	get dupTargets(): Set<string> {
		const seen = new Map<string, number>();
		for (const e of this.entries) seen.set(e.target, (seen.get(e.target) ?? 0) + 1);
		return new Set([...seen.entries()].filter(([, c]) => c > 1).map(([n]) => n));
	}
}

export const kit = new Kit();
