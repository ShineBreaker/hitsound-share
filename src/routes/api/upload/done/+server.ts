// POST /api/upload/done：闭环核验后置 visible 并补 refcount。
// blob 清单从 D1（该包 files 行）自取，不信前端；核验 = R2 head 实际大小比对 +
// 首 16 字节魔数（RIFF/OggS/ID3|帧同步）；original.zip 同样核验大小与 PK 头。
// 全部通过才一次性落账（blobs upsert refcount、置 visible），任一失败无副作用留 pending
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv, blobKey } from '$lib/server/media';
import { getSecrets } from '$lib/server/env';
import { verifySession, SESSION_COOKIE } from '$lib/server/session';
import { MIME_BY_EXT, magicOk, type AudioExt } from '$lib/server/upload';

interface BlobAgg {
	hash: string;
	ext: AudioExt;
	n: number; // 该包内引用此 hash 的文件数（refcount 增量）
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

	// 包必须属于当前用户且处于 pending
	const pkg = await env.DB.prepare(
		'SELECT id, uploader_osu_id, status, logical_size FROM packages WHERE id = ?1'
	)
		.bind(body.packageId)
		.first<{ id: string; uploader_osu_id: number | null; status: string; logical_size: number }>();
	if (!pkg || pkg.uploader_osu_id !== session.osuId || pkg.status !== 'pending') {
		return json({ error: 'package_not_found' }, { status: 404 });
	}

	// 从 files 行聚合待核验 blob（含已存在 blob —— 它们的 refcount 也要补）
	const { results: aggRows } = await env.DB.prepare(
		`SELECT blob_hash AS hash, MIN(format) AS ext, COUNT(*) AS n, MAX(size_bytes) AS size
		 FROM files WHERE package_id = ?1 GROUP BY blob_hash`
	)
		.bind(pkg.id)
		.all<{ hash: string; ext: string; n: number; size: number }>();
	const blobs = (aggRows ?? []).filter(
		(r): r is BlobAgg => /^[0-9a-f]{64}$/.test(r.hash) && ['wav', 'ogg', 'mp3'].includes(r.ext)
	);

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
		const head16 = new Uint8Array(await obj.body.arrayBuffer());
		if (!magicOk(b.ext, head16)) bad.push(b.hash);
	});
	if (bad.length > 0) return json({ error: 'blob_mismatch', bad }, { status: 400 });

	// original.zip 核验：存在、大小与声明一致（zipSize 可选）、PK 头
	const zipSize = typeof body.zipSize === 'number' && body.zipSize > 0 ? body.zipSize : null;
	const zipKey = `packages/${pkg.id}/original.zip`;
	const zipHead = await env.HITSOUND_FILES.head(zipKey);
	if (!zipHead || zipHead.size <= 0) return json({ error: 'zip_missing' }, { status: 400 });
	if (zipSize !== null && zipHead.size !== zipSize) {
		return json({ error: 'zip_mismatch' }, { status: 400 });
	}
	const zipObj = await env.HITSOUND_FILES.get(zipKey, { range: { offset: 0, length: 4 } });
	if (!zipObj) return json({ error: 'zip_missing' }, { status: 400 });
	const zipMagic = new Uint8Array(await zipObj.body.arrayBuffer());
	if (!(zipMagic[0] === 0x50 && zipMagic[1] === 0x4b)) {
		return json({ error: 'zip_mismatch' }, { status: 400 });
	}

	// 全部核验通过 → 一次性落账（分片 batch）
	const stmts: D1PreparedStatement[] = [];
	for (const b of blobs) {
		stmts.push(
			env.DB.prepare(
				`INSERT INTO blobs (hash, size, mime, refcount) VALUES (?1, ?2, ?3, ?4)
				 ON CONFLICT(hash) DO UPDATE SET refcount = blobs.refcount + ?5`
			).bind(b.hash, b.size, MIME_BY_EXT[b.ext], b.n, b.n)
		);
	}
	stmts.push(
		env.DB.prepare('UPDATE packages SET status = ?1, size_bytes = ?2 WHERE id = ?3').bind(
			'visible',
			zipHead.size,
			pkg.id
		)
	);
	for (let i = 0; i < stmts.length; i += 50) {
		await env.DB.batch(stmts.slice(i, i + 50));
	}

	return json({ ok: true });
};
