// 上传管线（非 UI 部分，可被单测）：选好的文件 → 按魔数解包/直收 → sha256 + 元数据
// （wav 手解 RIFF 头兜底，decodeMeta 注入）→ POST /api/upload（manifest）→
// 并发直传缺失 blob（预签名 PUT，5xx/429 与网络错误按 retryDelaysMs 重试）→ POST /api/upload/done。
// 事件经 onEvent 上报（phase/progress/skipped/log），UI 只管呈现；
// 错误一律包装为 UploadError（code = upload.err.* 文案键后缀）
import { readArchive, ArchiveError } from './archive';
import { mapPool } from './pool';
import { t } from './i18n';
import type { DecodedMeta } from './audio-meta';

export type UploadSource = { name: string; bytes: Uint8Array };

export type UploadTarget =
	| { kind: 'new'; name: string }
	| { kind: 'append'; packageId: string };

export type UploadEvent =
	| { type: 'phase'; phase: 'parsing' | 'uploading' | 'finalizing' }
	| { type: 'progress'; n: number; total: number }
	| { type: 'skipped'; count: number }
	| { type: 'log'; level: 'info' | 'error'; msg: string };

/** 上传失败的分类码：与 zh.ts 的 upload.err.<code> 文案键对应 */
export class UploadError extends Error {
	readonly code: string;
	constructor(code: string, message?: string) {
		super(message ?? code);
		this.code = code;
	}
}

export interface UploadDeps {
	fetch: typeof fetch;
	loadWasm: () => Promise<ArrayBuffer>; // unrar wasm 按需加载（仅遇到 rar 时调用）
	decodeMeta: (d: Uint8Array) => Promise<DecodedMeta | null>;
	concurrency?: number; // 默认 4：解析哈希与直传共用
	retryDelaysMs?: number[]; // 默认 [500, 1500]：第 N 次重试前等待
}

// 压缩包与单音频分流仍按扩展名（.rar 允许进入）；压缩包内部格式由 readArchive 按魔数判定
export const ARCHIVE_EXTS = ['zip', 'rar'];
const AUDIO_EXT_SET = new Set(['wav', 'ogg', 'mp3']);

/** 取小写扩展名；无扩展名返回空串 */
export function fileExt(name: string): string {
	const i = name.lastIndexOf('.');
	return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

/** wav 手解 RIFF 头：fmt 块的声道/采样率/位深 + byteRate（算时长） */
export function parseWavHeader(d: Uint8Array): {
	channels: number;
	sampleRate: number;
	bitDepth: number;
	byteRate: number;
} | null {
	if (d.length < 12) return null;
	const tag = (o: number) => String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
	if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
	const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
	let off = 12;
	while (off + 8 <= d.length) {
		const id = tag(off);
		const size = dv.getUint32(off + 4, true);
		if (id === 'fmt ' && off + 24 <= d.length) {
			return {
				channels: dv.getUint16(off + 10, true),
				sampleRate: dv.getUint32(off + 12, true),
				bitDepth: dv.getUint16(off + 22, true),
				byteRate: dv.getUint32(off + 16, true)
			};
		}
		off += 8 + size + (size % 2); // chunk 按 2 字节对齐
	}
	return null;
}

export async function sha256Hex(d: Uint8Array): Promise<string> {
	// slice 复制防 ArrayBuffer 被 detach（digest 不 detach，防御性）
	const h = await crypto.subtle.digest('SHA-256', d.slice().buffer as ArrayBuffer);
	return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Entry {
	path: string;
	hash: string;
	size: number;
	ext: string;
	durationS: number | null;
	sampleRate: number | null;
	bitDepth: number | null;
	channels: number | null;
	peaks: number[] | null;
}

/** 构造单文件条目：解码元数据优先；wav 且解码失败时回退 RIFF 手解（时长 = 大小/字节率） */
async function buildEntry(
	path: string,
	d: Uint8Array,
	ext: string,
	hash: string,
	decodeMeta: UploadDeps['decodeMeta']
): Promise<Entry> {
	const wav = ext === 'wav' ? parseWavHeader(d) : null;
	const dec = await decodeMeta(d);
	return {
		path,
		hash,
		size: d.length,
		ext,
		durationS: dec?.durationS ?? (wav && wav.byteRate > 0 ? d.length / wav.byteRate : null),
		sampleRate: dec?.sampleRate ?? wav?.sampleRate ?? null,
		bitDepth: dec ? (ext === 'wav' ? (wav?.bitDepth ?? null) : null) : (wav?.bitDepth ?? null),
		channels: dec?.channels ?? wav?.channels ?? null,
		peaks: dec?.peaks ?? null
	};
}

/** 日志里的 URL 只留 origin+path：预签名 query（X-Amz-* 凭证参数）不落日志 */
function safeUrl(url: string): string {
	try {
		const u = new URL(url);
		return u.origin + u.pathname;
	} catch {
		return url.split('?')[0];
	}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface ManifestResult {
	packageId?: string;
	missing?: Array<{ hash: string; url: string }>;
	appending?: boolean;
	existingCount?: number;
	error?: string;
}

/**
 * 跑完整个上传流程。成功 resolve（UI 置 done）；失败抛 UploadError（code 已是文案键后缀）。
 * 错误码映射与既有行为一致：manifest → 服务端 error ?? manifest_failed；
 * done → 附加模式 package_not_found 记 append_gone，否则 error ?? blob_mismatch；
 * ArchiveError → 其 code；包内无音频 → bad_ext；其余意外 → network。
 */
export async function runUpload(
	source: UploadSource,
	target: UploadTarget,
	deps: UploadDeps,
	onEvent: (e: UploadEvent) => void
): Promise<void> {
	const concurrency = deps.concurrency ?? 4;
	const retryDelays = deps.retryDelaysMs ?? [500, 1500];
	const log = (level: 'info' | 'error', msg: string) => onEvent({ type: 'log', level, msg });

	try {
		onEvent({ type: 'phase', phase: 'parsing' });

		// —— 解包 / 直收：按魔数识别压缩包，非音频条目跳过 ——
		const ext = fileExt(source.name);
		const audioFiles: Array<{ path: string; data: Uint8Array }> = [];
		if (ARCHIVE_EXTS.includes(ext)) {
			const files = await readArchive(source.bytes, deps.loadWasm);
			for (const f of files) {
				if (AUDIO_EXT_SET.has(fileExt(f.path))) audioFiles.push(f);
			}
			const skipped = files.length - audioFiles.length;
			onEvent({ type: 'skipped', count: skipped });
			log('info', t('upload.log.unpacked', { n: audioFiles.length, skipped }));
			if (audioFiles.length === 0) {
				log('error', t('upload.log.noAudio'));
				throw new UploadError('bad_ext');
			}
		} else {
			if (!AUDIO_EXT_SET.has(ext)) {
				log('error', t('upload.log.noAudio'));
				throw new UploadError('bad_ext');
			}
			audioFiles.push({ path: source.name, data: source.bytes });
		}

		// —— 解析：sha256 + 元数据并发算（mapPool 限流），entries 保持压缩包内顺序 ——
		const blobData = new Map<string, Uint8Array>(); // hash → 原始字节（直传用，天然去重）
		const entries: Entry[] = new Array(audioFiles.length);
		let parsed = 0;
		await mapPool(audioFiles, concurrency, async (f, i) => {
			const hash = await sha256Hex(f.data);
			entries[i] = await buildEntry(f.path, f.data, fileExt(f.path), hash, deps.decodeMeta);
			if (!blobData.has(hash)) blobData.set(hash, f.data);
			parsed += 1;
			onEvent({ type: 'progress', n: parsed, total: audioFiles.length });
		});
		if (audioFiles.length === 1) {
			const [f] = audioFiles;
			log(
				'info',
				t('upload.log.parsed', {
					n: 1,
					ext: fileExt(f.path),
					hash: entries[0].hash.slice(0, 12)
				})
			);
		}

		// —— 1. manifest（服务端强校验 + 秒传判定，返回缺失清单与预签名 URL）——
		onEvent({ type: 'phase', phase: 'uploading' });
		const mres = await deps.fetch('/api/upload', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				...(target.kind === 'append' ? { appendTo: target.packageId } : { name: target.name }),
				entries
			})
		});
		const mdata = (await mres.json().catch(() => ({}))) as ManifestResult;
		if (!mres.ok || !mdata.packageId) {
			log('error', t('upload.log.manifestFail', { status: mres.status, error: mdata.error ?? '' }));
			throw new UploadError(mdata.error ?? 'manifest_failed');
		}
		log(
			'info',
			t('upload.log.manifest', {
				status: mres.status,
				missing: mdata.missing?.length ?? 0,
				existing: mdata.existingCount ?? 0,
				appending: mdata.appending ? t('upload.log.appending') : ''
			})
		);

		// —— 2. 直传缺失 blob（并发限流；5xx/429 与网络错误按节奏重试，其余非 2xx 即败）——
		const missing = mdata.missing ?? [];
		let putDone = 0;
		await mapPool(missing, concurrency, async (m) => {
			const body = blobData.get(m.hash);
			if (!body) {
				log('error', t('upload.log.missingBlob', { hash: m.hash.slice(0, 12) }));
				throw new UploadError('bad_hash');
			}
			for (let attempt = 0; ; attempt++) {
				let status = 'ERR';
				let detail = '';
				try {
					// body 实为独立 ArrayBuffer（slice 拷贝）；泛型 Uint8Array<ArrayBufferLike> 仅类型层面收窄
					const res = await deps.fetch(m.url, {
						method: 'PUT',
						body: body as Uint8Array<ArrayBuffer>
					});
					if (res.ok) break;
					status = String(res.status);
					detail = (await res.text().catch(() => '')).slice(0, 200);
					if (!(res.status >= 500 || res.status === 429) || attempt >= retryDelays.length) {
						log('error', t('upload.log.putFail', { url: safeUrl(m.url), status, detail }));
						throw new UploadError('put_failed');
					}
				} catch (e) {
					if (e instanceof UploadError) throw e;
					detail = e instanceof Error ? e.message : String(e);
					if (attempt >= retryDelays.length) {
						log('error', t('upload.log.putFail', { url: safeUrl(m.url), status, detail }));
						throw new UploadError('put_failed');
					}
				}
				const delay = retryDelays[attempt];
				log('info', t('upload.log.putRetry', { url: safeUrl(m.url), status, ms: delay }));
				await sleep(delay);
			}
			putDone += 1;
			onEvent({ type: 'progress', n: putDone, total: missing.length });
		});
		if (missing.length > 0) log('info', t('upload.log.putDone', { n: missing.length }));

		// —— 3. done 闭环核验（附加模式在此合并进目标分组）——
		onEvent({ type: 'phase', phase: 'finalizing' });
		const dres = await deps.fetch('/api/upload/done', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ packageId: mdata.packageId })
		});
		if (!dres.ok) {
			const derr = ((await dres.json().catch(() => ({}))) as { error?: string }).error;
			log('error', t('upload.log.doneFail', { status: dres.status, error: derr ?? '' }));
			// 附加模式 404：合并批次可能已完成而响应丢失（影子包已删）——提示刷新确认
			if (target.kind === 'append' && derr === 'package_not_found') {
				throw new UploadError('append_gone');
			}
			throw new UploadError(derr ?? 'blob_mismatch');
		}
		log('info', t('upload.log.doneOk', { status: dres.status }));
	} catch (err) {
		if (err instanceof UploadError) throw err;
		// 解包错误按原因码提示（格式/加密/损坏），不再一律报网络错误
		if (err instanceof ArchiveError) {
			log('error', t('upload.log.archiveFail', { code: err.code, msg: err.message }));
			throw new UploadError(err.code);
		}
		log('error', t('upload.log.interrupted', { msg: err instanceof Error ? err.message : String(err) }));
		throw new UploadError('network');
	}
}
