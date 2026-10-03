// 前端 API 封装：树 / 文件列表 / 波形（带缓存）/ 配置 / 整包下载清单 / 改名 / 移动；
// 含树构建（与后端聚合同口径）。网络出口统一走 api-base 的 apiFetch（可配 API base + 门 token）
import type { FileRow, TreeNode, ZipManifest } from '$lib/types';
import type { KitFile } from '$lib/kit.svelte';
import { apiFetch, setGateToken, setSessionToken } from '$lib/api-base.svelte';

export interface TreePackage {
	id: string;
	name: string;
	uploaderOsuId: number | null;
	uploaderUsername: string | null;
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

/** 管理权判定：管理员管理一切，普通用户仅内容 owner（包级 uploader / 文件级 owner；null = 系统导入仅管理员） */
export function canManage(me: Me, ownerId: number | null): boolean {
	return Boolean(me.loggedIn && (me.isAdmin || (me.osuId != null && me.osuId === ownerId)));
}

async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await apiFetch(url, init);
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

/** 站点配置：上传开关 + 限制常量 + 存储池用量 + 访问密码门状态；dailyPackagesUsed 仅登录时非 null */
export interface SiteConfig {
	uploadEnabled: boolean;
	/** 访问密码门：locked = 未解锁（前端显示全站遮罩） */
	gate: { locked: boolean };
	limits: {
		maxFileBytes: number;
		maxPackageBytes: number;
		maxEntries: number;
		dailyPackages: number;
		storageCapBytes: number;
	};
	storageUsedBytes: number | null;
	dailyPackagesUsed: number | null;
}

export function fetchConfig(): Promise<SiteConfig> {
	return getJSON('/api/config');
}

/** 解锁站点访问密码门；密码错误 reject Error('wrong_password')。
 *  响应体含 token（跨源后端下发）时存 localStorage 供 apiFetch/absoluteApiUrl 使用；
 *  旧后端无该字段则忽略，cookie 语义照旧 */
export async function unlockSite(password: string): Promise<void> {
	const res = await mutateJSON<{ token?: string }>('/api/site-gate', 'POST', { password });
	if (typeof res.token === 'string') setGateToken(res.token);
}

/** 修改站点访问密码（管理员）；非法长度 reject Error('bad_password') */
export function setSitePassword(password: string): Promise<void> {
	return mutate('/api/admin/site-gate', 'PUT', { password });
}

/** 当前登录态（未配置/未登录均返回 loggedIn:false） */
export async function fetchMe(): Promise<Me> {
	try {
		return await getJSON('/api/auth/me');
	} catch {
		return { loggedIn: false };
	}
}

/**
 * OAuth 交付码落地：callback 跨源 302 附带的 ?hs_code=（60s 短时效签名值）换发
 * 完整会话 token 存 localStorage（桌面 WebView 第三方 cookie 不可靠，登录态此后走
 * x-hs-session 头）。调用方负责清 URL 参数与静默失败（失败保持未登录态）。
 * 返回是否换发成功
 */
export async function exchangeAuthCode(code: string): Promise<boolean> {
	try {
		const res = await mutateJSON<{ token?: string }>('/api/auth/exchange', 'POST', { code });
		if (typeof res.token !== 'string' || res.token === '') return false;
		setSessionToken(res.token);
		return true;
	} catch {
		return false;
	}
}

/** 整包下载清单（当前包内容；URL 为 R2 预签名直连或同源代理路径） */
export function fetchZipManifest(pkgId: string): Promise<ZipManifest> {
	return getJSON(`/api/package/${encodeURIComponent(pkgId)}/zip`);
}

async function mutateJSON<T>(url: string, method: string, body?: unknown): Promise<T> {
	const res = await apiFetch(url, {
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

/** 包改名结果：merge=true 成功时 merged/targetId/deduped 有值（deduped = 被去重丢弃的文件 id） */
export interface RenameResult {
	ok: boolean;
	merged?: boolean;
	targetId?: string;
	deduped?: string[];
}

/** 改名撞名（409 name_taken）：message 固定 'name_taken'，targetId = 将吸收本包的最老同名包 id */
export class RenameConflictError extends Error {
	readonly targetId: string;
	constructor(targetId: string) {
		super('name_taken');
		this.name = 'RenameConflictError';
		this.targetId = targetId;
	}
}

/**
 * 大类改名（包名）；merge=true 时把本包并入最老同名包（先撞 409 再带 merge 重试的流程见页面层）。
 * 不走 mutateJSON：409 name_taken 的 body 里的 targetId 也得带出来，mutateJSON 只留 error 码——
 * 故手写请求（出口仍走 apiFetch）。约定不变：失败一律 throw，message = 服务端错误码；唯独
 * name_taken 抛 RenameConflictError（instanceof 判别 + targetId 字段），其余错误码仍是普通 Error
 */
export async function renamePackage(
	pkgId: string,
	name: string,
	merge = false
): Promise<RenameResult> {
	const res = await apiFetch(`/api/package/${encodeURIComponent(pkgId)}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(merge ? { name, merge } : { name })
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { error?: string; targetId?: string };
		if (err.error === 'name_taken') throw new RenameConflictError(err.targetId ?? '');
		throw new Error(err.error ?? `HTTP ${res.status}`);
	}
	return (await res.json().catch(() => ({}))) as RenameResult;
}

/** 小类改名（包内文件夹，含子文件夹级联；to 已存在 = 合并） */
export function renameFolder(pkgId: string, from: string, to: string): Promise<void> {
	return mutate(`/api/package/${encodeURIComponent(pkgId)}/folder`, 'PATCH', { from, to });
}

/** 单文件改名（文件 owner / 管理员） */
export function renameFile(id: string, name: string): Promise<void> {
	return mutate('/api/files', 'PATCH', { id, name });
}

/** 删除整包（包主/管理员） */
export function deletePackage(pkgId: string): Promise<void> {
	return mutate(`/api/package/${encodeURIComponent(pkgId)}`, 'DELETE');
}

/** 删除小类（文件夹及其子文件夹的全部文件；包主/管理员） */
export function deleteFolder(pkgId: string, path: string): Promise<void> {
	return mutate(`/api/package/${encodeURIComponent(pkgId)}/folder`, 'DELETE', { path });
}

/** 批量删除文件行（包主删自己包的 / 管理员任意，可跨包，≤500） */
export function deleteFiles(ids: string[]): Promise<void> {
	return mutate('/api/files', 'DELETE', { ids });
}

/** 移动结果：moved = 实际移动的文件数，deduped = 目标已有同内容而被去重丢弃的文件 id */
export interface MoveResult {
	moved: number;
	deduped: string[];
}

/** 批量移动文件到目标包的目标小类（toFolder '' = 包根；服务端单次 ≤500，多则分片调用） */
export function moveFiles(ids: string[], toPackage: string, toFolder: string): Promise<MoveResult> {
	return mutateJSON('/api/files/move', 'POST', { ids, toPackage, toFolder });
}

/** 整个小类移动到目标包（fromFolder 非空；toFolder '' = 目标包根；含子文件夹级联） */
export function moveFolder(
	fromPackage: string,
	fromFolder: string,
	toPackage: string,
	toFolder: string
): Promise<MoveResult> {
	return mutateJSON('/api/files/move', 'POST', { fromPackage, fromFolder, toPackage, toFolder });
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
// 与端点上限一致）；模块级缓存存 Promise 防同 id 并发重复请求；失败 resolve null 并逐出缓存。
// Map 插入序即 LRU 序：超 2000 条逐出最旧（200×8B peaks，封顶 ≈3.2MB）
const PEAKS_FLUSH_MS = 16;
const PEAKS_BATCH = 100;
const PEAKS_CACHE_MAX = 2000;
const peaksCache = new Map<string, Promise<number[] | null>>();
let peaksQueue = new Map<string, Array<(v: number[] | null) => void>>();
let peaksTimer: ReturnType<typeof setTimeout> | null = null;

export function fetchPeaks(id: string): Promise<number[] | null> {
	let p = peaksCache.get(id);
	if (p) {
		peaksCache.delete(id); // LRU：命中移到最新位
		peaksCache.set(id, p);
	} else {
		p = new Promise<number[] | null>((resolve) => {
			const list = peaksQueue.get(id) ?? [];
			list.push(resolve);
			peaksQueue.set(id, list);
		});
		peaksCache.set(id, p);
		if (peaksCache.size > PEAKS_CACHE_MAX) {
			for (const k of peaksCache.keys()) {
				if (peaksQueue.has(k)) continue; // 在途请求不逐出（resolver 会丢）
				peaksCache.delete(k);
				break;
			}
		}
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
			ownerOsuId: p.uploaderOsuId,
			ownerName: p.uploaderUsername
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
				ownerOsuId: p.uploaderOsuId,
				ownerName: p.uploaderUsername
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
