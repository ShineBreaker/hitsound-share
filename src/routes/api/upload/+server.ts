// POST /api/upload：manifest 强校验（登录 + 水位 + 每日配额 + 条目/路径/白名单）→
// 建 pending 包与 files 行 → 查 blobs 表得缺失清单（已有 blob 秒传跳过）→
// 返回缺失 blob 的 R2 预签名 PUT URL（浏览器直传，服务端不出网）。
// appendTo 模式：建 append_to 指向目标包的影子 pending 包，done 核验后合并进目标包
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { getEnv, blobKey } from '$lib/server/media';
import { getSecrets, uploadCapable } from '$lib/server/env';
import { requireUser } from '$lib/server/guard';
import { isAdmin } from '$lib/server/admin';
import { lazyCleanupPending } from '$lib/server/packages';
import { reserveBlobStatements, committedHashes } from '$lib/server/ledger';
import {
	GLOBAL_CAP_BYTES,
	MAX_AUDIO_BYTES,
	MAX_ENTRIES,
	PKGS_PER_DAY,
	presignPut,
	validateManifest
} from '$lib/server/upload';

/** 服务端拆包内路径 → folderPath + name（不信前端拆分） */
function splitPath(path: string): { folderPath: string; name: string } {
	const slash = path.lastIndexOf('/');
	return slash === -1
		? { folderPath: '', name: path }
		: { folderPath: path.slice(0, slash), name: path.slice(slash + 1) };
}

export const POST: RequestHandler = async ({ request, platform, cookies }) => {
	const env = getEnv(platform);
	const secrets = getSecrets(platform);
	if (!env || !uploadCapable(secrets)) {
		return json({ error: 'service_unavailable' }, { status: 503 });
	}

	// 登录态（上传必须登录）
	const g = await requireUser(platform, cookies, request);
	if (g instanceof Response) return g;
	const session = g.session;

	// 管理员豁免单文件上限与每日配额（全局水位不豁免：防付费的硬闸）；
	// 判定失败按非管理员处理（保守：宁可不放行）
	const admin = await isAdmin(env.DB, secrets, session.osuId).catch(() => false);

	// manifest 强校验
	const validated = validateManifest(await request.json().catch(() => null), {
		maxFileBytes: admin ? MAX_AUDIO_BYTES : undefined
	});
	if (!validated.ok) return json({ error: validated.error }, { status: 400 });
	const m = validated.value;
	const logicalSize = m.entries.reduce((acc, e) => acc + e.size, 0);

	// 附加模式：目标包必须存在、visible、非影子且属于本人（附加仅限自己的包）；
	// 合并后条目数/音频累计不得超上限（防借附加绕过单包上限）
	let appendName: string | null = null;
	if (m.appendTo !== null) {
		const target = await env.DB.prepare(
			`SELECT id, name, uploader_osu_id, status, append_to, file_count, logical_size
			 FROM packages WHERE id = ?1`
		)
			.bind(m.appendTo)
			.first<{
				id: string;
				name: string;
				uploader_osu_id: number | null;
				status: string;
				append_to: string | null;
				file_count: number;
				logical_size: number;
			}>();
		if (!target || target.uploader_osu_id !== session.osuId) {
			return json({ error: 'append_target_not_found' }, { status: 404 });
		}
		if (target.status !== 'visible' || target.append_to !== null) {
			return json({ error: 'append_target_invalid' }, { status: 400 });
		}
		if (target.file_count + m.entries.length > MAX_ENTRIES) {
			return json({ error: 'too_many_entries' }, { status: 400 });
		}
		if (target.logical_size + logicalSize > MAX_AUDIO_BYTES) {
			return json({ error: 'too_large' }, { status: 400 });
		}
		appendName = target.name;
	}

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
	// - 每用户 24h 内（含 pending 及附加影子包）< 5 包；管理员（?9=1）豁免
	// - blobs 账本 SUM（含 pending 预插行，保守）+ visible 包 zip 存量 + 本包 logical_size < 10GB（不豁免）
	const packageId = crypto.randomUUID();
	const ins = await env.DB.prepare(
		`INSERT INTO packages (id, name, uploader_osu_id, size_bytes, logical_size, file_count, status, append_to)
		 SELECT ?1, ?2, ?3, 0, ?4, ?5, 'pending', ?6
		 WHERE (?9 = 1 OR (SELECT COUNT(*) FROM packages
		        WHERE uploader_osu_id = ?3 AND created_at >= datetime('now', '-1 day')) < ?7)
		   AND ((SELECT COALESCE(SUM(size), 0) FROM blobs)
		      + (SELECT COALESCE(SUM(size_bytes), 0) FROM packages WHERE status = 'visible')
		      + ?4) < ?8`
	)
		.bind(
			packageId,
			appendName ?? m.name,
			session.osuId,
			logicalSize,
			m.entries.length,
			m.appendTo,
			PKGS_PER_DAY,
			GLOBAL_CAP_BYTES,
			admin ? 1 : 0
		)
		.run();
	if ((ins.meta?.changes ?? 0) === 0) {
		// 闸门未过：复查区分原因，给出准确错误码（复查仅为报错，不再作为防线）
		if (!admin) {
			const quota = await env.DB.prepare(
				`SELECT COUNT(*) AS c FROM packages
				 WHERE uploader_osu_id = ?1 AND created_at >= datetime('now', '-1 day')`
			)
				.bind(session.osuId)
				.first<{ c: number }>();
			if ((quota?.c ?? 0) >= PKGS_PER_DAY) {
				return json({ error: 'daily_limit' }, { status: 429 });
			}
		}
		return json({ error: 'storage_full' }, { status: 507 });
	}

	// files.blob_hash 有外键 → blobs 行须先存在：manifest 阶段幂等插入（refcount=0），
	// done 核验通过才通过对齐累加；失败/清理路径按 refcount<=0 回收，跨包共享的行不受影响。
	// D1 batch 是事务性的，混合语句一并分批（免费计划单请求 50 子请求上限：
	// 5000 条目 ×2 类插入按 250/批 ≈ 40 子请求，预算内）
	const byHash = new Map(m.entries.map((e) => [e.hash, e]));
	const stmts: D1PreparedStatement[] = [...reserveBlobStatements(env.DB, m.entries)];
	for (const e of m.entries) {
		const { folderPath, name } = splitPath(e.path);
		stmts.push(
			env.DB.prepare(
				`INSERT INTO files (id, package_id, folder_path, name, format, duration_s, sample_rate,
				                    bit_depth, channels, size_bytes, peaks, blob_hash, owner_osu_id)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
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
				e.hash,
				session.osuId
			)
		);
	}
	for (let i = 0; i < stmts.length; i += 250) {
		await env.DB.batch(stmts.slice(i, i + 250));
	}

	// 秒传判定：refcount > 0 的 hash 说明 R2 已有 done 核验过的真实对象，直接复用；
	// 刚插入的 refcount=0 行（或历史孤儿）不算，仍需直传
	const hashList = [...byHash.keys()];
	const existing = await committedHashes(env.DB, hashList);

	// 预签名是纯本地计算（不出网）：并发签出全部缺失 blob 的 PUT URL——
	// content-length 按声明 size 签入，实际 PUT 字节数被钉死在闸门口径内
	const missing = await Promise.all(
		[...byHash]
			.filter(([hash]) => !existing.has(hash))
			.map(async ([hash, entry]) => ({
				hash,
				ext: entry.ext as string,
				url: await presignPut(secrets, blobKey(hash, entry.ext), entry.size)
			}))
	);

	return json({
		packageId,
		missing,
		appending: m.appendTo !== null,
		existingCount: hashList.length - missing.length
	});
};
