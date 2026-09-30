// 前端 API 封装：树 / 文件列表 / 波形（带缓存）/ 配置 / 整包下载清单 / 改名；
// 含树构建（与后端聚合同口径）
import type { FileRow, TreeNode, ZipManifest } from '$lib/types';
import type { KitFile } from '$lib/kit.svelte';

export interface TreePackage {
	id: string;
	name: string;
	uploaderOsuId: number | null;
	folders: string[];
}

export interface Me {
	loggedIn: boolean;
	username?: string;
	avatarUrl?: string | null;
	osuId?: number;
	isAdmin?: boolean;
	isSuperAdmin?: boolean;
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

async function mutateJSON<T>(url: string, method: string, body?: unknown): Promise<T> {
	const res = await fetch(url, {
		method,
		headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(err.error ?? `HTTP ${res.status}`);
	}
	return (await res.json().catch(() => ({}))) as T;
}

function mutate(url: string, method: string, body?: unknown): Promise<void> {
	return mutateJSON(url, method, body).then(() => undefined);
}

/** 大类改名（包名） */
export function renamePackage(pkgId: string, name: string): Promise<void> {
	return mutate(`/api/package/${encodeURIComponent(pkgId)}`, 'PATCH', { name });
}

/** 小类改名（包内文件夹，含子文件夹级联；to 已存在 = 合并） */
export function renameFolder(pkgId: string, from: string, to: string): Promise<void> {
	return mutate(`/api/package/${encodeURIComponent(pkgId)}/folder`, 'PATCH', { from, to });
}

export interface AdminRow {
	osu_id: number;
	username: string;
	avatar_url: string | null;
}

/** 管理员名单（仅超级管理员可调） */
export function fetchAdmins(): Promise<{ admins: AdminRow[] }> {
	return getJSON('/api/admin/admins');
}

/** 授管理员：user 为 osu! ID（全数字）或用户名（限已登录过本站的用户） */
export function addAdmin(user: string): Promise<{ admin: AdminRow }> {
	return mutateJSON('/api/admin/admins', 'POST', { user });
}

/** 撤管理员（幂等） */
export function removeAdmin(osuId: number): Promise<void> {
	return mutate('/api/admin/admins', 'DELETE', { osu_id: osuId });
}

// 波形批量取数：16ms 窗口内请求的 id 合并成一次 /api/waveform?ids=… 调用（每批 ≤100，
// 与端点上限一致）；模块级缓存存 Promise 防同 id 并发重复请求；失败 resolve null 并逐出缓存
const PEAKS_FLUSH_MS = 16;
const PEAKS_BATCH = 100;
const peaksCache = new Map<string, Promise<number[] | null>>();
let peaksQueue = new Map<string, Array<(v: number[] | null) => void>>();
let peaksTimer: ReturnType<typeof setTimeout> | null = null;

export function fetchPeaks(id: string): Promise<number[] | null> {
	let p = peaksCache.get(id);
	if (!p) {
		p = new Promise<number[] | null>((resolve) => {
			const list = peaksQueue.get(id) ?? [];
			list.push(resolve);
			peaksQueue.set(id, list);
		});
		peaksCache.set(id, p);
		peaksTimer ??= setTimeout(() => void flushPeaks(), PEAKS_FLUSH_MS);
	}
	return p;
}

async function flushPeaks(): Promise<void> {
	peaksTimer = null;
	const batch = peaksQueue;
	peaksQueue = new Map();
	const ids = [...batch.keys()];
	for (let i = 0; i < ids.length; i += PEAKS_BATCH) {
		const chunk = ids.slice(i, i + PEAKS_BATCH);
		let res: Record<string, number[] | null> | null = null;
		try {
			const q = new URLSearchParams({ ids: chunk.join(',') });
			res = (await getJSON<{ peaks: Record<string, number[] | null> }>(`/api/waveform?${q}`)).peaks;
		} catch {
			res = null;
		}
		for (const id of chunk) {
			if (res === null) peaksCache.delete(id); // 失败逐出缓存，下次可见时可重试
			for (const resolve of batch.get(id) ?? []) resolve(res?.[id] ?? null);
		}
	}
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

/** 拖拽载荷：{files} 有序列表——拖多选中行时整组入格（续号），单行单文件无序号 */
export interface KitDragData {
	files: KitFile[];
}
