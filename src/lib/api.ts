// 前端 API 封装：树 / 文件列表 / 波形（带缓存）/ 配置 / 整包下载清单 / 改名；
// 含树构建（与后端聚合同口径）
import type { FileRow, TreeNode, ZipManifest } from '$lib/types';

export interface TreePackage {
	id: string;
	name: string;
	uploaderOsuId: number | null;
	folders: string[];
}

export interface Me {
	loggedIn: boolean;
	username?: string;
	osuId?: number;
	isAdmin?: boolean;
}

async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return (await res.json()) as T;
}

/** force：绕过 /api/tree 的 60s HTTP 缓存（改名/上传后立即可见） */
export function fetchTree(force = false): Promise<{ packages: TreePackage[] }> {
	return getJSON('/api/tree', force ? { cache: 'reload' } : undefined);
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
export async function fetchMe(): Promise<Me> {
	try {
		return await getJSON('/api/auth/me');
	} catch {
		return { loggedIn: false };
	}
}

/** 整包下载清单（当前包内容；URL 为 R2 预签名直连或同源代理路径） */
export function fetchZipManifest(pkgId: string): Promise<ZipManifest> {
	return getJSON(`/api/package/${encodeURIComponent(pkgId)}/zip`);
}

async function mutate(url: string, method: string, body: unknown): Promise<void> {
	const res = await fetch(url, {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(err.error ?? `HTTP ${res.status}`);
	}
}

/** 大类改名（包名） */
export function renamePackage(pkgId: string, name: string): Promise<void> {
	return mutate(`/api/package/${encodeURIComponent(pkgId)}`, 'PATCH', { name });
}

/** 小类改名（包内文件夹，含子文件夹级联；to 已存在 = 合并） */
export function renameFolder(pkgId: string, from: string, to: string): Promise<void> {
	return mutate(`/api/package/${encodeURIComponent(pkgId)}/folder`, 'PATCH', { from, to });
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
		const root: TreeNode = {
			name: p.name,
			key: `pkg:${p.id}`,
			isPackage: true,
			children: [],
			ownerOsuId: p.uploaderOsuId
		};
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
				children: [],
				ownerOsuId: p.uploaderOsuId
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

/** 文件表行 → 组装面板格子的拖拽数据类型（dataTransfer 自定义 MIME，只接受本站行内拖出的数据） */
export const DND_FILE_MIME = 'application/x-hitsound-file';

export interface KitDragData {
	id: string; // files.id
	name: string;
	format: string;
}
