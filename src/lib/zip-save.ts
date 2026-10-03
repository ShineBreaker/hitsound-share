// 浏览器端实时打包下载（ADR 0001）：entries（path→key）按 key 去重拉取，
// 自写 STORE zip 写出（UTF-8 名、写头时 CRC/大小已知 → 无数据描述符），
// 输出经 write 回调零拷贝直发；CRC32 按内容字节 WeakMap 缓存——谱面集热更新
// 重建时未变的谱面集条目不重复算 CRC（S1：整包 CRC 主线程卡顿的根因）。
// 落盘策略：Chromium 走 File System Access 流式写（内存不随包体线性增长）；
// 其余浏览器降级内存 Blob + <a download>。Tauri WebView 下 showSaveFilePicker 可能
// 「存在但永不 resolve」，现状仅抛异常才降级会永久 pending——桌面端跳过 picker 直接兜底。
import { mapPool, yieldMain } from './pool';
import { isDesktopApp } from './api-base.svelte';
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

// —— CRC32（查表；按 Uint8Array 对象身份缓存，同一份字节第二次算直接命中） ——
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();
const crcCache = new WeakMap<Uint8Array, number>();

// 单个大文件的 CRC 是同步阻塞循环：每 ~16MB 一片，片间交还事件循环，
// 否则整段时长变成一次帧冻结（播放/预览同步卡）；内层无分支跑满片
const CRC_CHUNK = 16 * 1024 * 1024;


async function crc32(d: Uint8Array): Promise<number> {
	const hit = crcCache.get(d);
	if (hit !== undefined) return hit;
	let c = 0xffffffff;
	if (d.length <= CRC_CHUNK) {
		// 小文件不付 async 开销（占绝大多数：音效通常 <1MB）
		for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xff] ^ (c >>> 8);
	} else {
		for (let i = 0; i < d.length; i += CRC_CHUNK) {
			const end = Math.min(i + CRC_CHUNK, d.length);
			for (let j = i; j < end; j++) c = CRC_TABLE[(c ^ d[j]) & 0xff] ^ (c >>> 8);
			await yieldMain();
		}
	}
	c ^= 0xffffffff;
	crcCache.set(d, c);
	return c;
}

const textEncoder = new TextEncoder();

/** DOS 时间戳（打包时刻）；一次打包内所有条目共用 */
function dosTime(now: Date): number {
	const y = now.getFullYear() - 1980;
	return (
		((y < 0 ? 0 : y > 119 ? 119 : y) << 25) |
		((now.getMonth() + 1) << 21) |
		(now.getDate() << 16) |
		(now.getHours() << 11) |
		(now.getMinutes() << 5) |
		(now.getSeconds() >> 1)
	);
}

/** 中央目录条目（本地头 offset 在真正写出时回填序号） */
interface Central {
	name: Uint8Array; // UTF-8 编码名
	utf8: boolean;
	crc: number;
	size: number;
	offset: number;
}

const u32 = (dv: DataView, o: number, v: number) => dv.setUint32(o, v >>> 0, true);
const u16 = (dv: DataView, o: number, v: number) => dv.setUint16(o, v & 0xffff, true);

/**
 * 打包核心：同 key 只 load 一次，最后一个条目消费完即释放缓存；
 * 条目乱序写入 zip 合法（central directory 记录名字与 offset，无顺序要求）；
 * write 链与 load 错误都会使 promise 拒绝。
 */
export async function packZip(opts: PackZipOpts): Promise<void> {
	const { entries, load, write, concurrency = 6, onProgress } = opts;
	// 非 ZIP64 上限：条目数按 u16 截断会产出坏包，提前显式报错
	if (entries.length > 0xffff) throw new Error('zip entry count exceeds 65535');
	let zipErr: Error | null = null;
	let writeChain: Promise<void> = Promise.resolve();
	let written = 0; // 已排队的字节数 → 下一条本地头的 offset
	const central: Central[] = [];
	const mtime = dosTime(new Date());

	const emit = (chunk: Uint8Array): void => {
		writeChain = writeChain.then(() => write(chunk)).catch((e: unknown) => {
			zipErr ??= e instanceof Error ? e : new Error(String(e));
		});
	};

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

			const name = textEncoder.encode(e.path);
			if (name.length > 0xffff) throw new Error(`zip entry name too long: ${e.path}`);
			// 非 ZIP64 上限：越界会静默截断出坏包，显式报错（同 fflate 行为上限，改显式失败）
			if (data.length > 0xffffffff) throw new Error(`entry exceeds 4GiB: ${e.path}`);
			const utf8 = name.length !== e.path.length;
			const crc = await crc32(data);

			// 本地头：sizes/CRC 已知 → flag 仅 UTF-8 位，无数据描述符
			const head = new Uint8Array(30 + name.length);
			const dv = new DataView(head.buffer);
			u32(dv, 0, 0x04034b50);
			u16(dv, 4, 20); // version needed
			u16(dv, 6, utf8 ? 0x0800 : 0);
			u16(dv, 8, 0); // STORE
			u32(dv, 10, mtime);
			u32(dv, 14, crc);
			u32(dv, 18, data.length);
			u32(dv, 22, data.length);
			u16(dv, 26, name.length);
			head.set(name, 30);

			// u32 offset 越界会产生坏包：累加前先检查（同条目大小限制，显式失败）
			if (written + head.length + data.length > 0xffffffff) {
				throw new Error('archive exceeds 4GiB');
			}
			central.push({ name, utf8, crc, size: data.length, offset: written });
			written += head.length + data.length;
			emit(head);
			emit(data);

			done += 1;
			onProgress?.(done, entries.length);
			const left = (remaining.get(e.key) ?? 1) - 1;
			remaining.set(e.key, left);
			if (left === 0) bufCache.delete(e.key);
		});
	} catch (e) {
		throw zipErr ?? e;
	}

	// 中央目录 + EOCD
	const dirSize = central.reduce((s, c) => s + 46 + c.name.length, 0);
	const tail = new Uint8Array(dirSize + 22);
	const tdv = new DataView(tail.buffer);
	let b = 0;
	for (const c of central) {
		u32(tdv, b, 0x02014b50);
		u16(tdv, b + 4, 20); // version made by
		u16(tdv, b + 6, 20); // version needed
		u16(tdv, b + 8, c.utf8 ? 0x0800 : 0);
		u16(tdv, b + 10, 0);
		u32(tdv, b + 12, mtime);
		u32(tdv, b + 16, c.crc);
		u32(tdv, b + 20, c.size);
		u32(tdv, b + 24, c.size);
		u16(tdv, b + 28, c.name.length);
		u32(tdv, b + 42, c.offset);
		tail.set(c.name, b + 46);
		b += 46 + c.name.length;
	}
	u32(tdv, b, 0x06054b50);
	u16(tdv, b + 8, central.length);
	u16(tdv, b + 10, central.length);
	u32(tdv, b + 12, dirSize);
	u32(tdv, b + 16, written);
	emit(tail);

	await writeChain; // 链上写入错误已统一汇入 zipErr
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
 * 其他异常回退内存 Blob）；桌面端（Tauri）跳过 picker 直接走内存 Blob + a.download 兜底
 * （picker 存在但永不 resolve 的永久 pending 只有跳过才能防住）；任何失败若有 writable 先 abort 再抛出。
 */
export async function saveZip(
	name: string,
	opts: SaveZipOpts
): Promise<SaveZipResult> {
	const { ext = 'zip', ...pack } = opts;
	const suggested = `${name || 'package'}.${ext}`;
	if (typeof window !== 'undefined' && !isDesktopApp() && typeof picker() === 'function') {
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
