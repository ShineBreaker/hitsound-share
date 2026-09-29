// POST /api/upload：manifest 强校验（登录 + 水位 + 每日配额 + 条目/路径/白名单）→
// 建 pending 包与 files 行 → 查 blobs 表得缺失清单（已有 blob 秒传跳过）→
// 返回缺失 blob 与 original.zip 的 R2 预签名 PUT URL（浏览器直传，服务端不出网）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/media';
import { getSecrets, type Secrets } from '$lib/server/env';
import { verifySession, SESSION_COOKIE } from '$lib/server/session';
import { lazyCleanupPending } from '$lib/server/packages';
import { GLOBAL_CAP_BYTES, MIME_BY_EXT, PKGS_PER_DAY, validateManifest, presignPut } from '$lib/server/upload';

/** 服务端拆包内路径 → folderPath + name（不信前端拆分） */
function splitPath(path: string): { folderPath: string; name: string } {
	const slash = path.lastIndexOf('/');
	return slash === -1
		? { folderPath: '', name: path }
		: { folderPath: path.slice(0, slash), name: path.slice(slash + 1) };
}

function needUploadSecrets(s: Partial<Secrets>): s is Secrets {
	return Boolean(s.OSU_CLIENT_ID && s.OSU_CLIENT_SECRET && s.SESSION_SECRET && s.R2_ACCOUNT_ID && s.R2_ACCESS_KEY_ID && s.R2_SECRET_ACCESS_KEY);
}

export const POST: RequestHandler = async ({ request, platform, cookies }) => {
	const env = getEnv(platform);
	const secrets = getSecrets(platform);
	if (!env || !needUploadSecrets(secrets)) {
		return json({ error: 'service_unavailable' }, { status: 503 });
	}

	// 登录态（上传必须登录）
	const session = await verifySession(cookies.get(SESSION_COOKIE), secrets.SESSION_SECRET);
	if (!session) return json({ error: 'not_logged_in' }, { status: 401 });

	// manifest 强校验
	const validated = validateManifest(await request.json().catch(() => null));
	if (!validated.ok) return json({ error: validated.error }, { status: 400 });
	const m = validated.value;

	// 懒清理：全站扫描超 24h 的 pending 包（他人弃单同样回收，防其 blobs 预插行占死水位）
	await lazyCleanupPending(env).catch(() => 0);

	// users 幂等落行（packages.uploader_osu_id 有外键，须先行）
	await env.DB.prepare(
		`INSERT INTO users (osu_id, username, avatar_url)
		 VALUES (?1, ?2, ?3)
		 ON CONFLICT(osu_id) DO UPDATE SET username = excluded.username`
	)
		.bind(session.osuId, session.username, session.avatarUrl)
		.run();

	// 配额 + 全局水位合并为单条条件 INSERT（单语句原子，关闭并发 TOCTOU 窗口）：
	// - 每用户 24h 内（含 pending）< 5 包
	// - blobs 账本 SUM（含 pending 预插行，保守）+ visible 包 zip 总量 + 本包 logical_size < 8GB
	const packageId = crypto.randomUUID();
	const logicalSize = m.entries.reduce((acc, e) => acc + e.size, 0);
	const ins = await env.DB.prepare(
		`INSERT INTO packages (id, name, uploader_osu_id, size_bytes, logical_size, file_count, status)
		 SELECT ?1, ?2, ?3, 0, ?4, ?5, 'pending'
		 WHERE (SELECT COUNT(*) FROM packages
		        WHERE uploader_osu_id = ?3 AND created_at >= datetime('now', '-1 day')) < ?6
		   AND ((SELECT COALESCE(SUM(size), 0) FROM blobs)
		      + (SELECT COALESCE(SUM(size_bytes), 0) FROM packages WHERE status = 'visible')
		      + ?4) < ?7`
	)
		.bind(packageId, m.name, session.osuId, logicalSize, m.entries.length, PKGS_PER_DAY, GLOBAL_CAP_BYTES)
		.run();
	if ((ins.meta?.changes ?? 0) === 0) {
		// 闸门未过：复查区分原因，给出准确错误码（复查仅为报错，不再作为防线）
		const quota = await env.DB.prepare(
			`SELECT COUNT(*) AS c FROM packages
			 WHERE uploader_osu_id = ?1 AND created_at >= datetime('now', '-1 day')`
		)
			.bind(session.osuId)
			.first<{ c: number }>();
		if ((quota?.c ?? 0) >= PKGS_PER_DAY) {
			return json({ error: 'daily_limit' }, { status: 429 });
		}
		return json({ error: 'storage_full' }, { status: 507 });
	}

	// files.blob_hash 有外键 → blobs 行须先存在：manifest 阶段幂等插入（refcount=0），
	// done 核验通过才通过对齐累加；失败/清理路径按 refcount<=0 回收，跨包共享的行不受影响
	const byHash = new Map(m.entries.map((e) => [e.hash, e]));
	for (const [hash, entry] of byHash) {
		await env.DB.prepare(
			'INSERT OR IGNORE INTO blobs (hash, size, mime, refcount) VALUES (?1, ?2, ?3, 0)'
		)
			.bind(hash, entry.size, MIME_BY_EXT[entry.ext])
			.run();
	}

	const stmts: D1PreparedStatement[] = [];
	for (const e of m.entries) {
		const { folderPath, name } = splitPath(e.path);
		stmts.push(
			env.DB.prepare(
				`INSERT INTO files (id, package_id, folder_path, name, format, duration_s, sample_rate,
				                    bit_depth, channels, size_bytes, peaks, blob_hash)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
			).bind(
				crypto.randomUUID(),
				packageId,
				folderPath,
				name,
				e.ext,
				e.durationS,
				e.sampleRate,
				e.bitDepth,
				e.channels,
				e.size,
				e.peaks ? JSON.stringify(e.peaks) : null,
				e.hash
			)
		);
	}
	// D1 batch 分片（每 50 条语句一批，避免单批过大）
	for (let i = 0; i < stmts.length; i += 50) {
		await env.DB.batch(stmts.slice(i, i + 50));
	}

	// 秒传判定：refcount > 0 的 hash 说明 R2 已有 done 核验过的真实对象，直接复用；
	// 刚插入的 refcount=0 行（或历史孤儿）不算，仍需直传
	const existing = new Set<string>();
	const hashList = [...byHash.keys()];
	for (let i = 0; i < hashList.length; i += 100) {
		const chunk = hashList.slice(i, i + 100);
		const placeholders = chunk.map((_, j) => `?${j + 1}`).join(', ');
		const { results } = await env.DB.prepare(
			`SELECT hash FROM blobs WHERE hash IN (${placeholders}) AND refcount > 0`
		)
			.bind(...chunk)
			.all<{ hash: string }>();
		for (const row of results ?? []) existing.add(row.hash);
	}

	const missing: Array<{ hash: string; ext: string; url: string }> = [];
	for (const [hash, entry] of byHash) {
		if (existing.has(hash)) continue;
		const key = `blobs/${hash.slice(0, 2)}/${hash}.${entry.ext}`;
		missing.push({ hash, ext: entry.ext, url: await presignPut(secrets, key) });
	}

	return json({
		packageId,
		missing,
		zipUrl: await presignPut(secrets, `packages/${packageId}/original.zip`),
		existingCount: hashList.length - missing.length
	});
};
