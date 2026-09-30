// 浏览器端实时打包下载（ADR 0001）：entries（path→key）按 key 去重拉取，
// fflate 流式 STORE 拼 zip（CPU 仅 crc32），输出经 write 回调串行落盘。
// 落盘策略：Chromium 走 File System Access 流式写（内存不随包体线性增长）；
// 其余浏览器降级内存 Blob + <a download>。
import { Zip, ZipDeflate } from 'fflate';
import { mapPool } from './pool';

export interface ZipEntry {
	path: string; // zip 内相对路径
	key: string; // 拉取去重键（blob hash 或 files.id）
}

export interface PackZipOpts {
	entries: ZipEntry[];
	load: (key: string) => Promise<Uint8Array>;
	write: (chunk: Uint8Array) => void | Promise<void>;
	concurrency?: number;
	onProgress?: (done: number, total: number) => void;
}

/**
 * 打包核心：同 key 只 load 一次，最后一个条目消费完即释放缓存；
 * 条目乱序写入 zip 合法（central directory 记录名字，无顺序要求）；
 * Zip 回调错误与 write 链错误都会使 promise 拒绝。
 */
export async function packZip(opts: PackZipOpts): Promise<void> {
	const { entries, load, write, concurrency = 6, onProgress } = opts;
	let zipErr: Error | null = null;
	let writeChain: Promise<void> = Promise.resolve();
	const zip = new Zip((err, dat) => {
		if (err) {
			zipErr ??= err;
			return;
		}
		// 写入失败即刻入 zipErr（mapPool 下一轮即中止，不空拉整包），
		// 挂在链上消化避免游离 unhandled rejection
		writeChain = writeChain.then(() => write(dat)).catch((e: unknown) => {
			zipErr ??= e instanceof Error ? e : new Error(String(e));
		});
	});

	// key → 拉取 Promise（去重）+ 剩余引用计数（全部条目消费完即释放缓存）
	const bufCache = new Map<string, Promise<Uint8Array>>();
	const remaining = new Map<string, number>();
	for (const e of entries) remaining.set(e.key, (remaining.get(e.key) ?? 0) + 1);
	const getBuf = (key: string): Promise<Uint8Array> => {
		let p = bufCache.get(key);
		if (!p) {
			p = load(key);
			bufCache.set(key, p);
		}
		return p;
	};

	let done = 0;
	try {
		await mapPool(entries, concurrency, async (e) => {
			if (zipErr) throw zipErr;
			const data = await getBuf(e.key);
			if (zipErr) throw zipErr;
			const entry = new ZipDeflate(e.path, { level: 0 }); // STORE 直通
			zip.add(entry);
			entry.push(data, true);
			done += 1;
			onProgress?.(done, entries.length);
			const left = (remaining.get(e.key) ?? 1) - 1;
			remaining.set(e.key, left);
			if (left === 0) bufCache.delete(e.key);
		});
		zip.end(); // 同步流：返回时 central directory 已收入写链
	} catch (e) {
		throw zipErr ?? e;
	}
	await writeChain; // 链上写入错误已统一汇入 zipErr（含 zip.end() 产出的尾块）
	if (zipErr) throw zipErr;
}

export type SaveZipResult = 'saved' | 'cancelled';

export interface SaveZipOpts extends Omit<PackZipOpts, 'write'> {
	/** 保存扩展名（默认 zip；谱面集导出传 'osz'） */
	ext?: string;
}

// File System Access API：lib.dom 未收录 showSaveFilePicker / 流式写接口，最小声明够用即可
interface SaveFilePickerOptions {
	suggestedName?: string;
	types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}
interface FsWritable {
	write(chunk: Uint8Array): Promise<void>;
	close(): Promise<void>;
	abort(): Promise<void>;
}
interface FsFileHandle {
	createWritable(): Promise<FsWritable>;
}
const picker = (): ((o: SaveFilePickerOptions) => Promise<FsFileHandle>) | undefined =>
	(window as { showSaveFilePicker?: (o: SaveFilePickerOptions) => Promise<FsFileHandle> })
		.showSaveFilePicker;

/**
 * 打包并保存为 <name>.<ext>：File System Access 可用时流式写盘（用户取消 → 'cancelled'，
 * 其他异常回退内存 Blob）；任何失败若有 writable 先 abort 再抛出。
 */
export async function saveZip(
	name: string,
	opts: SaveZipOpts
): Promise<SaveZipResult> {
	const { ext = 'zip', ...pack } = opts;
	const suggested = `${name || 'package'}.${ext}`;
	if (typeof window !== 'undefined' && typeof picker() === 'function') {
		let handle: FsFileHandle | null = null;
		try {
			handle = await picker()!({
				suggestedName: suggested,
				types: [{ description: ext.toUpperCase(), accept: { 'application/octet-stream': [`.${ext}`] } }]
			});
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
			handle = null; // 其余异常（如权限/不支持）降级内存 Blob
		}
		if (handle) {
			const writable = await handle.createWritable();
			try {
				await packZip({ ...pack, write: (chunk) => writable.write(chunk) });
				await writable.close();
				return 'saved';
			} catch (e) {
				await writable.abort().catch(() => {});
				throw e;
			}
		}
	}

	// 内存 Blob 兜底（超大包移动端可能吃紧，可接受）
	const chunks: Uint8Array[] = [];
	await packZip({ ...pack, write: (chunk) => void chunks.push(chunk) });
	const blob = new Blob(chunks as BlobPart[], { type: 'application/zip' });
	const a = document.createElement('a');
	a.href = URL.createObjectURL(blob);
	a.download = suggested;
	a.click();
	// 延迟回收：click 已把下载交给浏览器，下一帧释放 URL 即可
	setTimeout(() => URL.revokeObjectURL(a.href), 0);
	return 'saved';
}
