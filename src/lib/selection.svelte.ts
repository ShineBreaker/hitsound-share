// 文件表多选状态（跨文件夹翻页保持）：Ctrl/⌘ 点击 toggle、Shift 点击连选、复选框勾选；
// 选好后按 Q–Y/A–H/Z–N 或点击组装面板格子批量入格（assignSelection）
import { kit, type CellKey, type KitFile } from './kit.svelte';
import { t } from './i18n';

export class Selection {
	items = $state<KitFile[]>([]); // 选中项（保持插入顺序 = 入格顺序）
	anchor = $state(''); // Shift 连选锚点（最后一次 toggle 的文件 id）

	// id 镜像（普通 Set，非 $state）：has 的 O(1) 查询表。2400 行 × 大选中集
	// 时原 some 线性扫把单次选中变化放大成 O(n×m)（行渲染 × 每行 3 处 has +
	// 表头 allSelected/someSelected 再各扫一遍）。响应式语义不变：has 每次都
	// 读 items（模板的依赖追踪正靠这次读取），引用未变则复用镜像；全仓写
	// 路径（内部方法与 FileTable/+page 的外部裸赋值）一律整值重赋值 → 引用
	// 失配即版本失配，下一次 has 自动 O(m) 重建一次
	#ids = new Set<string>();
	#idsFor: KitFile[] | null = null;

	get size(): number {
		return this.items.length;
	}

	has(id: string): boolean {
		const items = this.items;
		if (this.#idsFor !== items) {
			this.#idsFor = items;
			this.#ids = new Set(items.map((i) => i.id));
		}
		return this.#ids.has(id);
	}

	toggle(file: KitFile): void {
		if (this.has(file.id)) {
			this.items = this.items.filter((i) => i.id !== file.id);
			if (this.anchor === file.id) this.anchor = ''; // 取消锚点项 → 锚点失效
		} else {
			this.items = [...this.items, file];
			this.anchor = file.id;
		}
	}

	/** 把给定序的缺失项并入选中集（Shift 连选；锚点不动，便于反复调整范围） */
	selectRange(files: KitFile[]): void {
		const add = files.filter((f) => !this.has(f.id));
		if (add.length === 0) return;
		this.items = [...this.items, ...add];
	}

	clear(): void {
		this.items = [];
		this.anchor = '';
	}
}

export const selection = new Selection();

/**
 * 选中集 → 格子：按选择顺序续号入格 → 清空选择 → 展开面板 → 闪格 → aria-live 播报
 */
export function assignSelection(key: CellKey): void {
	if (selection.size === 0) return;
	const n = selection.size;
	kit.addNumbered(key, selection.items);
	selection.clear();
	kit.open = true;
	kit.flash(key);
	kit.notice = t('kit.assigned', { count: n, cell: key.replace('/', '-') });
}
