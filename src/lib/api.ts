// 前端 API 封装：树 / 文件列表 / 波形（带缓存）/ 配置；含树构建（与后端聚合同口径）
import type { FileRow, TreeNode } from '$lib/types';

export interface TreePackage {
	id: string;
	name: string;
	folders: string[];
}

async function getJSON<T>(url: string): Promise<T> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return (await res.json()) as T;
}

export function fetchTree(): Promise<{ packages: TreePackage[] }> {
	return getJSON('/api/tree');
}

/** folder 含 # 空格 & 逗号：URLSearchParams 负责正确编码 */
export function fetchFiles(
	pkg: string,
	folder: string,
	offset = 0,
	limit = 200
): Promise<{ total: number; files: FileRow[] }> {
	const q = new URLSearchParams({ pkg, folder, offset: String(offset), limit: String(limit) });
	return getJSON(`/api/files?${q}`);
}

export function fetchConfig(): Promise<{ uploadEnabled: boolean }> {
	return getJSON('/api/config');
}

/** 当前登录态（未配置/未登录均返回 loggedIn:false） */
export async function fetchMe(): Promise<{ loggedIn: boolean; username?: string }> {
	try {
		return await getJSON('/api/auth/me');
	} catch {
		return { loggedIn: false };
	}
}

// 波形模块级缓存：跨文件夹切换复用；存 Promise 防同 id 并发重复请求
const peaksCache = new Map<string, Promise<number[] | null>>();
export function fetchPeaks(id: string): Promise<number[] | null> {
	let p = peaksCache.get(id);
	if (!p) {
		p = getJSON<{ peaks: number[] | null }>(`/api/waveform/${encodeURIComponent(id)}`)
			.then((r) => r.peaks)
			.catch(() => null);
		peaksCache.set(id, p);
	}
	return p;
}

/** 由「包 + DISTINCT folder_path 列表」构建前端树（根 = 包，children = 文件夹层级） */
export function buildForest(packages: TreePackage[]): TreeNode[] {
	return packages.map((p) => {
		const root: TreeNode = { name: p.name, key: `pkg:${p.id}`, isPackage: true, children: [] };
		const byPath = new Map<string, TreeNode>([['', root]]);

		// 逐级补全中间路径节点（'a/b/c' 逐段挂到父节点；顶层无斜杠时父路径为 '' = 包根）
		const ensureFolder = (path: string): TreeNode => {
			const hit = byPath.get(path);
			if (hit) return hit;
			const slash = path.lastIndexOf('/');
			const node: TreeNode = {
				name: path.slice(slash + 1),
				key: `pkg:${p.id}/${path}`,
				isPackage: false,
				children: []
			};
			byPath.set(path, node);
			// 注意：slash === -1 时父路径必须是 ''（包根），slice(0, -1) 会变成去尾字符
			ensureFolder(slash === -1 ? '' : path.slice(0, slash)).children.push(node);
			return node;
		};

		for (const f of p.folders) if (f !== '') ensureFolder(f);

		// 文件夹名排序，展示稳定
		const sortNodes = (nodes: TreeNode[]): TreeNode[] => {
			nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
			for (const n of nodes) sortNodes(n.children);
			return nodes;
		};
		sortNodes(root.children);
		return root;
	});
}

/** 选中键 → {包 id, 文件夹路径}：'pkg:<id>' 或 'pkg:<id>/<folderPath>' */
export function parseNodeKey(key: string): { pkg: string; folder: string } {
	const rest = key.slice('pkg:'.length);
	const slash = rest.indexOf('/');
	return slash === -1
		? { pkg: rest, folder: '' }
		: { pkg: rest.slice(0, slash), folder: rest.slice(slash + 1) };
}
