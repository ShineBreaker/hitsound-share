// blob 新鲜核验：done 阶段确认本次新上传的 blob 真实落地（对象存在 + 大小一致 + 魔数对得上）。
// 子请求预算（免费计划 ≤50 子请求/请求，大包 2400+ blob 必须批量）：
//   - ≤24 个：逐 blob 一次 ranged GET（offset 0 / len 16），大小与魔数一次拿全；
//   - >24 个：先 list 前缀分页（1000 对象/次）批量比大小——待核 hash 的 2 位前缀 ≤16 个时
//     按 `blobs/<pp>/` 逐个前缀分页，否则 `blobs/` 全量分页；再抽前 16 个做 ranged GET 魔数
//     （纵深防御的降级抽样，预算内尽力而为）。
import type { R2Bucket } from '@cloudflare/workers-types';
import { mapPool } from '../pool';
import { blobKey } from './media';
import { magicOk, type AudioExt } from './upload';

export interface FreshBlob {
	hash: string;
	ext: AudioExt;
	size: number; // 期望字节数
}

/** 小集合阈值：范围内逐 blob ranged GET 一次搞定；之外走 list 批量比对 */
const SMALL_SET = 24;
/** 大集合路径的魔数抽查数（预算内的纵深防御抽样） */
const MAGIC_SAMPLE = 16;
const LIST_PAGE = 1000;
/** list 按前缀分页的前缀上限（超出则直接全量扫，前缀太多反而更费子请求） */
const PREFIX_LIMIT = 16;

const KEY_RE = /^blobs\/[0-9a-f]{2}\/([0-9a-f]{64})\.(wav|ogg|mp3)$/;

/** ranged GET 首 16 字节做魔数核验；对象缺失或字节不符记 bad */
async function checkMagic(
	bucket: R2Bucket,
	b: FreshBlob,
	bad: Set<string>
): Promise<void> {
	const obj = await bucket.get(blobKey(b.hash, b.ext), {
		range: { offset: 0, length: 16 }
	});
	if (!obj) {
		bad.add(b.hash);
		return;
	}
	// R2 body 是 ReadableStream：经 Response 聚合后读首字节
	// （workers-types 的 ReadableStream 与 DOM lib 不是同一类型，仅类型层面 cast）
	const head = new Uint8Array(
		await new Response(obj.body as unknown as BodyInit).arrayBuffer()
	);
	if (!magicOk(b.ext, head)) bad.add(b.hash);
}

/** 返回未通过核验的 hash 列表（空数组 = 全部通过） */
export async function verifyFreshBlobs(
	bucket: R2Bucket,
	blobs: FreshBlob[]
): Promise<string[]> {
	const bad = new Set<string>();
	if (blobs.length === 0) return [];

	if (blobs.length <= SMALL_SET) {
		// 小集合：ranged GET 的 obj.size 是完整对象大小（R2 语义），大小比对与魔数一并完成
		await mapPool(blobs, SMALL_SET, async (b) => {
			const obj = await bucket.get(blobKey(b.hash, b.ext), {
				range: { offset: 0, length: 16 }
			});
			if (!obj || obj.size !== b.size) {
				bad.add(b.hash);
				return;
			}
			const head = new Uint8Array(
				await new Response(obj.body as unknown as BodyInit).arrayBuffer()
			);
			if (!magicOk(b.ext, head)) bad.add(b.hash);
		});
		return [...bad];
	}

	// 大集合：list 分页批量比大小（同 hash 多扩展名 key 同内容同大小，覆盖无害）
	const prefixes = new Set(blobs.map((b) => b.hash.slice(0, 2)));
	const sizes = new Map<string, number>();
	const scan = async (prefix: string): Promise<void> => {
		let cursor: string | undefined;
		do {
			const page = await bucket.list({ prefix, cursor, limit: LIST_PAGE });
			for (const obj of page.objects) {
				const m = obj.key.match(KEY_RE);
				if (m) sizes.set(m[1], obj.size);
			}
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
	};
	if (prefixes.size <= PREFIX_LIMIT) {
		for (const p of prefixes) await scan(`blobs/${p}/`);
	} else {
		await scan('blobs/');
	}
	for (const b of blobs) {
		if (sizes.get(b.hash) !== b.size) bad.add(b.hash);
	}

	// 魔数抽查：前 N 个新 blob 读首 16 字节验证扩展名（已判 bad 的跳过省请求）
	const sample = blobs.filter((b) => !bad.has(b.hash)).slice(0, MAGIC_SAMPLE);
	await mapPool(sample, MAGIC_SAMPLE, (b) => checkMagic(bucket, b, bad));

	return [...bad];
}
