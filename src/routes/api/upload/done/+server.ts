// POST /api/upload/done：闭环核验后置 visible 并对齐 refcount。
// blob 清单从 D1（该包 files 行）自取，不信前端；核验 = R2 head 实际大小比对 +
// 首 16 字节魔数（RIFF/OggS/ID3|帧同步）；original.zip 无条件限制实测大小 ≤100MB
// （manifest 声明值不可信，预签名 PUT 不签 Content-Length）+ PK 头。
// refcount 落账用「绝对对齐」（= 全库 visible 包引用数）：done 重放幂等，批间失败重试
// 不会双加，并可自愈历史偏差
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv, blobKey } from '$lib/server/media';
import { getSecrets } from '$lib/server/env';
import { verifySession, SESSION_COOKIE } from '$lib/server/session';
import { ALIGN_REFCOUNT_SQL } from '$lib/server/packages';
import { magicOk, MAX_ZIP_BYTES, type AudioExt } from '$lib/server/upload';

interface BlobAgg {
	hash: string;
	ext: AudioExt;
	size: number; // 期望字节数（同 hash 同内容同大小，取 MAX）
}

/** 并发池：控制同时核验的 blob 数（IO 等待不占 CPU，但避免一次打满 R2 连接） */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	});
	await Promise.all(workers);
	return out;
}

export const POST: RequestHandler = async ({ request, platform, cookies }) => {
	const env = getEnv(platform);
	const secrets = getSecrets(platform);
	if (!env || !secrets.SESSION_SECRET) return json({ error: 'service_unavailable' }, { status: 503 });

	const session = await verifySession(cookies.get(SESSION_COOKIE), secrets.SESSION_SECRET);
	if (!session) return json({ error: 'not_logged_in' }, { status: 401 });

	const body = (await request.json().catch(() => null)) as { packageId?: unknown; zipSize?: unknown } | null;
	if (!body || typeof body.packageId !== 'string') {
		return json({ error: 'bad_body' }, { status: 400 });
	}

	// 包必须属于当前用户；pending 走全量核验，visible 允许重放（仅对齐 refcount，幂等）
	const pkg = await env.DB.prepare('SELECT id, uploader_osu_id, status FROM packages WHERE id = ?1')
		.bind(body.packageId)
		.first<{ id: string; uploader_osu_id: number | null; status: string }>();
	if (!pkg || pkg.uploader_osu_id !== session.osuId || !['pending', 'visible'].includes(pkg.status)) {
		return json({ error: 'package_not_found' }, { status: 404 });
	}

	// 从 files 行聚合 blob 清单（对齐 refcount 需要完整 hash 列表）
	const { results: aggRows } = await env.DB.prepare(
		`SELECT blob_hash AS hash, MIN(format) AS ext, MAX(size_bytes) AS size
		 FROM files WHERE package_id = ?1 GROUP BY blob_hash`
	)
		.bind(pkg.id)
		.all<{ hash: string; ext: string; size: number }>();
	const blobs = (aggRows ?? []).filter(
		(r): r is BlobAgg => /^[0-9a-f]{64}$/.test(r.hash) && ['wav', 'ogg', 'mp3'].includes(r.ext)
	);

	if (pkg.status === 'pending') {
		// 逐 blob：head 存在 + 大小一致 + 首 16 字节魔数匹配扩展名
		const bad: string[] = [];
		await mapPool(blobs, 32, async (b) => {
			const key = blobKey(b.hash, b.ext);
			const head = await env.HITSOUND_FILES.head(key);
			if (!head || head.size !== b.size) {
				bad.push(b.hash);
				return;
			}
			const obj = await env.HITSOUND_FILES.get(key, { range: { offset: 0, length: 16 } });
			if (!obj) {
				bad.push(b.hash);
				return;
			}
			// R2 body 是 ReadableStream：经 Response 聚合后读首字节
			const head16 = new Uint8Array(await new Response(obj.body).arrayBuffer());
			if (!magicOk(b.ext, head16)) bad.push(b.hash);
		});
		if (bad.length > 0) return json({ error: 'blob_mismatch', bad }, { status: 400 });

		// original.zip 核验：存在 + 无条件限制实测大小 ≤100MB + PK 头。
		// （不依赖可选的声明 zipSize——预签名 PUT 不签 Content-Length，实测值才作数）
		const zipKey = `packages/${pkg.id}/original.zip`;
		const zipHead = await env.HITSOUND_FILES.head(zipKey);
		if (!zipHead || zipHead.size <= 0) return json({ error: 'zip_missing' }, { status: 400 });
		if (zipHead.size > MAX_ZIP_BYTES) return json({ error: 'zip_too_large' }, { status: 400 });
		const declared = typeof body.zipSize === 'number' && body.zipSize > 0 ? body.zipSize : null;
		if (declared !== null && zipHead.size !== declared) {
			return json({ error: 'zip_mismatch' }, { status: 400 });
		}
		const zipObj = await env.HITSOUND_FILES.get(zipKey, { range: { offset: 0, length: 4 } });
		if (!zipObj) return json({ error: 'zip_missing' }, { status: 400 });
		const zipMagic = new Uint8Array(await new Response(zipObj.body).arrayBuffer());
		if (!(zipMagic[0] === 0x50 && zipMagic[1] === 0x4b)) {
			return json({ error: 'zip_mismatch' }, { status: 400 });
		}

		// 置 visible（zip 实测大小入账；重放无害——条件限定 pending 抢占，防并发双翻转窗口）
		await env.DB.prepare(
			`UPDATE packages SET status = 'visible', size_bytes = ?1
			 WHERE id = ?2 AND status = 'pending'`
		)
			.bind(zipHead.size, pkg.id)
			.run();
	}

	// refcount 绝对对齐（幂等：= 全库 visible 包引用数；批间失败重放不双加，自愈偏差）。
	// 注意此时本包已置 visible，对齐结果包含本包引用
	const stmts = blobs.map((b) => env.DB.prepare(ALIGN_REFCOUNT_SQL).bind(b.hash));
	for (let i = 0; i < stmts.length; i += 50) {
		await env.DB.batch(stmts.slice(i, i + 50));
	}

	return json({ ok: true });
};
