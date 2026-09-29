// 服务端共享：bindings 获取 / R2 key 组装 / Range 解析 / Content-Disposition / blob 查询
import type { R2Bucket, D1Database } from '@cloudflare/workers-types';

export interface Env {
	DB: D1Database;
	HITSOUND_FILES: R2Bucket;
}

/** 从 platform 取 bindings；缺失（如构建期无运行时）返回 null */
export function getEnv(platform: App.Platform | undefined): Env | null {
	if (!platform?.env?.DB || !platform?.env?.HITSOUND_FILES) return null;
	return platform.env;
}

/** blob 的 R2 key：blobs/<hash前2>/<sha256>.<ext>（内容寻址，用户路径特殊字符不进 key） */
export function blobKey(hash: string, ext: string): string {
	return `blobs/${hash.slice(0, 2)}/${hash}.${ext}`;
}

export interface ByteRange {
	offset: number;
	length: number;
}

/** 只允许纯数字字符串；空串返回 null（区分「未提供」与 0） */
function digits(s: string): number | null {
	if (!/^[0-9]+$/.test(s)) return null;
	return Number(s);
}

/**
 * 解析单区间 Range 头（音频播放器只发单区间；多区间按约定回退 200 全量）
 * 返回：
 * - null：无 Range 头 → 200 全量
 * - 'multi'：多区间 → 回退 200
 * - 'unsatisfiable'：start >= size → 416
 * - 'invalid'：格式非法 → 忽略，回退 200
 * - ByteRange：合法单区间
 */
export function parseRange(
	header: string | null,
	size: number
): ByteRange | 'multi' | 'unsatisfiable' | 'invalid' | null {
	if (!header) return null;
	const spec = header.trim();
	if (!spec.startsWith('bytes=')) return 'invalid';
	const part = spec.slice('bytes='.length).trim();
	if (part.includes(',')) return 'multi';
	const dash = part.indexOf('-');
	if (dash === -1) return 'invalid';
	const startStr = part.slice(0, dash);
	const endStr = part.slice(dash + 1);

	if (startStr === '' && endStr === '') return 'invalid';
	if (startStr === '') {
		// 后缀区间 bytes=-n：取文件末尾 n 字节
		if (!/^[0-9]+$/.test(endStr)) return 'invalid';
		const len = Math.min(Number(endStr), size);
		return { offset: size - len, length: len };
	}
	const start = digits(startStr);
	if (start === null) return 'invalid';
	if (start >= size) return 'unsatisfiable';
	if (endStr === '') return { offset: start, length: size - start };
	const end = digits(endStr);
	if (end === null || end < start) return 'invalid';
	return { offset: start, length: Math.min(end, size - 1) - start + 1 }; // end 超尾按 S3 语义收敛
}

/** attachment 头：RFC 5987 编码原始文件名（含 # 空格 & 逗号），并给纯 ASCII fallback */
export function contentDisposition(filename: string): string {
	const fallback = filename.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').trim() || 'hitsound';
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface FileBlobRow {
	name: string;
	hash: string;
	format: string;
	mime: string;
}

/** 查单个文件的下载信息（files join blobs：blob_hash + mime + 原始文件名） */
export async function queryFileBlob(db: D1Database, id: string): Promise<FileBlobRow | null> {
	return await db
		.prepare(
			`SELECT f.name, f.blob_hash AS hash, f.format, b.mime
			 FROM files f JOIN blobs b ON b.hash = f.blob_hash
			 WHERE f.id = ?1`
		)
		.bind(id)
		.first<FileBlobRow>();
}
