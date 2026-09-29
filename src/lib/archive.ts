// 上传链路的压缩包解析（浏览器端）：按魔数分流 zip / rar，不信任扩展名——
// Windows 上 rar/7z 改名 .zip 或工具导出错后缀都常态，按扩展名走错解析器只会报含糊的网络错误。
// zip 不复用 fflate 高层 unzip：它把条目名一律按 UTF-8 解码，而中文 Windows 系统压缩的
// zip 条目名是 GBK（EFS 位未置位），解出即乱码入库；这里自行解析 central directory 拿
// 原始名字字节，严格 UTF-8 失败后回退 GBK。rar 经 node-unrar-js（UnRAR wasm）解包。

import { inflateSync } from 'fflate';

export interface ArchiveFile {
	/** 已归一：`\` 分隔符换 `/`（服务端 manifest 校验拒绝 `\`），剥 `./` 前缀 */
	path: string;
	data: Uint8Array;
}

export type ArchiveErrorCode = 'unknown_format' | 'format_unsupported' | 'encrypted' | 'corrupt';

export class ArchiveError extends Error {
	readonly code: ArchiveErrorCode;
	constructor(code: ArchiveErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

function magic(d: Uint8Array, bytes: number[]): boolean {
	return bytes.every((b, i) => d[i] === b);
}

/**
 * 解包压缩包。loadWasm 由调用方注入（浏览器经 Vite `?url` 资源同源拉取 unrar.wasm，
 * 测试环境直接读文件），wasm 仅在遇到 rar 时才加载。
 */
export async function readArchive(
	d: Uint8Array,
	loadWasm: () => Promise<ArrayBuffer>
): Promise<ArchiveFile[]> {
	if (magic(d, [0x50, 0x4b, 0x03, 0x04]) || magic(d, [0x50, 0x4b, 0x05, 0x06])) return readZip(d);
	if (magic(d, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]) || magic(d, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]))
		return readRar(d, loadWasm);
	if (magic(d, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))
		throw new ArchiveError('format_unsupported', '检测到 7z 格式，暂不支持');
	throw new ArchiveError('unknown_format', '未识别的压缩包格式（内容与扩展名不符）');
}

const EOCD_SIG = 0x06054b50; // PK\x05\x06
const CD_SIG = 0x02014b50; // PK\x01\x02
const LFH_SIG = 0x04034b50; // PK\x03\x04

function readZip(d: Uint8Array): ArchiveFile[] {
	const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
	// EOCD：固定 22 字节 + 最多 64KB 注释，从尾部按「位置+22+注释长 == 文件长」校验着找
	const minPos = Math.max(0, d.length - 65557);
	let eocd = -1;
	for (let i = d.length - 22; i >= minPos; i--) {
		if (dv.getUint32(i, true) === EOCD_SIG && i + 22 + dv.getUint16(i + 20, true) === d.length) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new ArchiveError('corrupt', '找不到 zip 目录（EOCD），文件损坏或格式不符');
	const totalEntries = dv.getUint16(eocd + 10, true);
	const cdSize = dv.getUint32(eocd + 12, true);
	const cdOff = dv.getUint32(eocd + 16, true);
	if (cdOff === 0xffffffff || totalEntries === 0xffff)
		throw new ArchiveError('format_unsupported', 'zip64 包暂不支持');
	// 自解压头等前置数据会让 CD 实际位置偏离 CD 记录值：由 EOCD 位置反推并修正条目 local 偏移
	const fix = eocd - cdSize - cdOff;
	let pos = cdOff + fix;
	const out: ArchiveFile[] = [];
	const utf8 = new TextDecoder('utf-8', { fatal: true });
	let gbk: TextDecoder | null = null;
	for (let n = 0; n < totalEntries; n++) {
		if (pos + 46 > d.length || dv.getUint32(pos, true) !== CD_SIG)
			throw new ArchiveError('corrupt', 'zip 目录（central directory）损坏');
		const flags = dv.getUint16(pos + 8, true);
		const method = dv.getUint16(pos + 10, true);
		const csize = dv.getUint32(pos + 20, true);
		const nameLen = dv.getUint16(pos + 28, true);
		const extraLen = dv.getUint16(pos + 30, true);
		const cmtLen = dv.getUint16(pos + 32, true);
		const lho = dv.getUint32(pos + 42, true) + fix;
		if (flags & 0x1) throw new ArchiveError('encrypted', 'zip 带密码加密，暂不支持');
		// 条目名：规范 bit11 置位才声明 UTF-8，未置位按系统代码页（中文 Windows 即 GBK）。
		// 严格 UTF-8 优先——纯 ASCII 名必然命中；GBK 字节流几乎必含非法 UTF-8 序列，失败即回退
		const nameB = d.subarray(pos + 46, pos + 46 + nameLen);
		let name: string;
		try {
			name = utf8.decode(nameB);
		} catch {
			gbk ??= new TextDecoder('gbk');
			name = gbk.decode(nameB);
		}
		pos += 46 + nameLen + extraLen + cmtLen;
		if (name === '' || name.endsWith('/')) continue; // 目录条目
		if (method !== 0 && method !== 8)
			throw new ArchiveError('format_unsupported', `不支持的压缩方法 ${method}：${name}`);
		if (csize === 0xffffffff) throw new ArchiveError('format_unsupported', `zip64 条目：${name}`);
		// 数据起点按 local header 自带的 name/extra 长度求（允许与 CD 记录不一致）
		if (lho < 0 || lho + 30 > d.length || dv.getUint32(lho, true) !== LFH_SIG)
			throw new ArchiveError('corrupt', `local header 损坏：${name}`);
		const dataStart = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
		if (dataStart + csize > d.length) throw new ArchiveError('corrupt', `数据截断：${name}`);
		const raw = d.subarray(dataStart, dataStart + csize);
		let data: Uint8Array;
		if (method === 0) data = raw;
		else {
			try {
				data = inflateSync(raw);
			} catch {
				throw new ArchiveError('corrupt', `deflate 数据损坏：${name}`);
			}
		}
		out.push({ path: normalizePath(name), data });
	}
	return out;
}

async function readRar(d: Uint8Array, loadWasm: () => Promise<ArrayBuffer>): Promise<ArchiveFile[]> {
	const { createExtractorFromData } = await import('node-unrar-js');
	const extractor = await createExtractorFromData({
		// slice 复制出连续独立 ArrayBuffer（UnRAR 按整块数据访问）
		data: d.slice().buffer as ArrayBuffer,
		wasmBinary: await loadWasm()
	});
	const out: ArchiveFile[] = [];
	try {
		// 只走 extract()（其 arcHeader 同样带包级 flags）：getFileList 与 extract 连用会
		// 在同一 wasm 实例上留下未关闭的 RarArchive，实测触发 ERAR_EREAD
		const arc = extractor.extract({});
		if (arc.arcHeader.flags.volume)
			throw new ArchiveError('format_unsupported', '分卷 rar 暂不支持');
		for (const f of arc.files) {
			const h = f.fileHeader;
			if (h.flags.directory) continue;
			if (h.flags.encrypted) throw new ArchiveError('encrypted', `rar 条目加密：${h.name}`);
			if (!f.extraction) continue;
			out.push({ path: normalizePath(h.name), data: f.extraction });
		}
	} catch (e) {
		if (e instanceof ArchiveError) throw e;
		const reason = (e as { reason?: string }).reason ?? '';
		if (reason === 'ERAR_MISSING_PASSWORD' || reason === 'ERAR_BAD_PASSWORD')
			throw new ArchiveError('encrypted', 'rar 条目需要密码，暂不支持');
		throw new ArchiveError('corrupt', `rar 解包失败：${reason || (e as Error).message}`);
	}
	return out;
}

function normalizePath(p: string): string {
	// rar 规范分隔符是 `\`，个别 Windows zip 工具也会写入；统一成 `/` 再交给服务端
	return p.replace(/\\/g, '/').replace(/^\.\//, '');
}
