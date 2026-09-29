// 上传链路共享：manifest 强校验 / aws4fetch 预签名 / blob 魔数核验
import { AwsClient } from 'aws4fetch';
import type { Secrets } from './env';

export const AUDIO_EXTS = ['wav', 'ogg', 'mp3'] as const;
export type AudioExt = (typeof AUDIO_EXTS)[number];

export const MIME_BY_EXT: Record<AudioExt, string> = {
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	mp3: 'audio/mpeg'
};

// 防滥用上限（按真实素材校准：lasse 库 497MB/2429 文件）
export const MAX_ENTRIES = 5000;
export const MAX_AUDIO_BYTES = 1024 * 1024 * 1024; // 单包音频累计 ≤1GB
export const GLOBAL_CAP_BYTES = 8 * 1024 * 1024 * 1024; // 全局水位 ≥8GB 拒新上传
export const PKGS_PER_DAY = 5; // 每用户 5 包/天
export const PENDING_TTL_H = 24; // pending 懒清理阈值

export interface ManifestEntry {
	path: string; // zip 内相对路径（服务端拆 folder/name）
	hash: string; // sha256 hex（64 位小写十六进制，进 R2 key，必须严格校验）
	size: number;
	ext: AudioExt;
	durationS: number | null;
	sampleRate: number | null;
	bitDepth: number | null;
	channels: number | null;
	peaks: number[] | null;
}

export interface Manifest {
	name: string; // 新建模式的包名；附加模式取目标包名（此字段被忽略）
	appendTo: string | null; // 附加到现有包的 id（uuid）；null = 新建包
	entries: ManifestEntry[];
}

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

function isFiniteNum(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v);
}

function intOrNull(v: unknown, min: number, max: number): number | null {
	return isFiniteNum(v) && v >= min && v <= max ? Math.round(v) : null;
}

/**
 * manifest 强校验：条目数、路径安全（拒 ..、绝对路径、反斜杠）、扩展名白名单、
 * hash 形态（防注入 R2 key）、元数据范围、音频累计大小。
 * appendTo（可选）为 uuid 形态；附加模式下 name 由服务端取目标包名，不校验。
 * 不通过返回中文原因码（前端映射文案）
 */
export function validateManifest(body: unknown): Validated<Manifest> {
	if (typeof body !== 'object' || body === null) return { ok: false, error: 'bad_body' };
	const b = body as Record<string, unknown>;
	const appendTo =
		typeof b.appendTo === 'string' ? b.appendTo : typeof b.appendTo === 'undefined' ? null : undefined;
	if (appendTo === undefined) return { ok: false, error: 'bad_append_to' };
	if (appendTo !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(appendTo)) {
		return { ok: false, error: 'bad_append_to' };
	}
	if (appendTo === null && (typeof b.name !== 'string' || b.name.length < 1 || b.name.length > 100)) {
		return { ok: false, error: 'bad_name' };
	}
	if (!Array.isArray(b.entries) || b.entries.length === 0 || b.entries.length > MAX_ENTRIES) {
		return { ok: false, error: 'too_many_entries' };
	}

	let total = 0;
	const entries: ManifestEntry[] = [];
	for (const raw of b.entries) {
		if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'bad_entry' };
		const e = raw as Record<string, unknown>;

		if (typeof e.path !== 'string' || e.path.length === 0 || e.path.length > 512) {
			return { ok: false, error: 'bad_path' };
		}
		// 路径安全：拒绝目录穿越、绝对路径、Windows 分隔符（值只作为 D1 字符串，不进任何 key/URL）
		if (e.path.includes('..') || e.path.startsWith('/') || e.path.includes('\\')) {
			return { ok: false, error: 'bad_path' };
		}
		if (typeof e.ext !== 'string' || !AUDIO_EXTS.includes(e.ext as AudioExt)) {
			return { ok: false, error: 'bad_ext' };
		}
		const ext = e.ext as AudioExt;
		// hash 直接拼进 R2 key：只允许 64 位小写 hex，杜绝任何注入
		if (typeof e.hash !== 'string' || !/^[0-9a-f]{64}$/.test(e.hash)) {
			return { ok: false, error: 'bad_hash' };
		}
		if (!isFiniteNum(e.size) || e.size <= 0 || e.size > MAX_AUDIO_BYTES) {
			return { ok: false, error: 'bad_size' };
		}
		total += e.size;
		if (total > MAX_AUDIO_BYTES) return { ok: false, error: 'too_large' };

		// peaks：数组、数值 0-1、条数合理（存进 D1 前收紧）
		let peaks: number[] | null = null;
		if (Array.isArray(e.peaks)) {
			if (e.peaks.length > 1000) return { ok: false, error: 'bad_peaks' };
			if (e.peaks.every((p) => isFiniteNum(p) && p >= 0 && p <= 1)) {
				peaks = e.peaks.map((p) => p as number);
			}
		}

		entries.push({
			path: e.path,
			hash: e.hash,
			size: e.size,
			ext,
			durationS:
				isFiniteNum(e.durationS) && e.durationS >= 0 && e.durationS <= 3600 ? e.durationS : null,
			sampleRate: intOrNull(e.sampleRate, 1, 384000),
			bitDepth: intOrNull(e.bitDepth, 1, 64),
			channels: intOrNull(e.channels, 1, 32),
			peaks
		});
	}
	return { ok: true, value: { name: typeof b.name === 'string' ? b.name : '', appendTo, entries } };
}

/** 预签名所需的 R2 三项（getSecrets 的子集，凑齐即可签名，不要求上传链路全套） */
export type R2Secrets = Pick<Secrets, 'R2_ACCOUNT_ID' | 'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY'>;

/** 生成 R2 S3 预签名 PUT URL（aws4fetch，SigV4 query 签名，限时 10 分钟） */
export async function presignPut(secrets: R2Secrets, key: string, expiresS = 600): Promise<string> {
	const client = new AwsClient({
		accessKeyId: secrets.R2_ACCESS_KEY_ID,
		secretAccessKey: secrets.R2_SECRET_ACCESS_KEY,
		service: 's3',
		region: 'auto'
	});
	// 预置 X-Amz-Expires 会被纳入签名 query（aws4fetch 对缺失时默认 86400，这里收紧）
	const url = new URL(
		`https://${secrets.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/hitsound-files/${key}?X-Amz-Expires=${expiresS}`
	);
	const req = await client.sign(url.toString(), { method: 'PUT', aws: { signQuery: true } });
	return req.url;
}

/** 生成 R2 S3 预签名 GET URL（整包下载的浏览器直连拉取；大包耗时长，默认 1 小时） */
export async function presignGet(secrets: R2Secrets, key: string, expiresS = 3600): Promise<string> {
	const client = new AwsClient({
		accessKeyId: secrets.R2_ACCESS_KEY_ID,
		secretAccessKey: secrets.R2_SECRET_ACCESS_KEY,
		service: 's3',
		region: 'auto'
	});
	const url = new URL(
		`https://${secrets.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/hitsound-files/${key}?X-Amz-Expires=${expiresS}`
	);
	const req = await client.sign(url.toString(), { method: 'GET', aws: { signQuery: true } });
	return req.url;
}

/** 首字节魔数核验：wav=RIFF、ogg=OggS、mp3=ID3 或 MPEG 帧同步 */
export function magicOk(ext: AudioExt, head: Uint8Array): boolean {
	const startsWith = (sig: number[]): boolean =>
		head.length >= sig.length && sig.every((b, i) => head[i] === b);

	switch (ext) {
		case 'wav':
			return startsWith([0x52, 0x49, 0x46, 0x46]); // RIFF
		case 'ogg':
			return startsWith([0x4f, 0x67, 0x67, 0x53]); // OggS
		case 'mp3':
			return (
				startsWith([0x49, 0x44, 0x33]) || // ID3
				(head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) // MPEG frame sync
			);
	}
}
