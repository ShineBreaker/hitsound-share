// /api/config：前端能力开关 + 上传限制与存储池用量（前台展示用）。
// 上传链路所需凭证（osu OAuth + session 密钥 + R2 直传）任一未配置时 uploadEnabled=false，
// 前端隐藏登录/上传入口（浏览/试听/下载不受影响）。
// storageUsedBytes 与 /api/upload 的水位公式同口径（blobs 账本 SUM + visible 包 zip 存量）；
// dailyPackagesUsed 仅登录时返回，与配额闸门同口径（24h 内全部包，含 pending/影子包）。
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecrets, uploadCapable } from '$lib/server/env';
import { getEnv } from '$lib/server/media';
import { verifySession, SESSION_COOKIE } from '$lib/server/session';
import {
	GLOBAL_CAP_BYTES,
	MAX_AUDIO_BYTES,
	MAX_ENTRIES,
	MAX_FILE_BYTES,
	PKGS_PER_DAY
} from '$lib/server/upload';

export const GET: RequestHandler = async ({ platform, cookies }) => {
	const secrets = getSecrets(platform);
	const env = getEnv(platform);
	const uploadEnabled = uploadCapable(secrets);

	let storageUsedBytes: number | null = null;
	let dailyPackagesUsed: number | null = null;
	if (env) {
		const usage = await env.DB.prepare(
			`SELECT (SELECT COALESCE(SUM(size), 0) FROM blobs)
			      + (SELECT COALESCE(SUM(size_bytes), 0) FROM packages WHERE status = 'visible') AS used`
		)
			.first<{ used: number }>()
			.catch(() => null);
		storageUsedBytes = usage?.used ?? 0;

		const user = secrets.SESSION_SECRET
			? await verifySession(cookies.get(SESSION_COOKIE), secrets.SESSION_SECRET)
			: null;
		if (user) {
			const counted = await env.DB.prepare(
				`SELECT COUNT(*) AS c FROM packages
				 WHERE uploader_osu_id = ?1 AND created_at >= datetime('now', '-1 day')`
			)
				.bind(user.osuId)
				.first<{ c: number }>()
				.catch(() => null);
			dailyPackagesUsed = counted?.c ?? 0;
		}
	}

	return json({
		uploadEnabled,
		limits: {
			maxFileBytes: MAX_FILE_BYTES,
			maxPackageBytes: MAX_AUDIO_BYTES,
			maxEntries: MAX_ENTRIES,
			dailyPackages: PKGS_PER_DAY,
			storageCapBytes: GLOBAL_CAP_BYTES
		},
		storageUsedBytes,
		dailyPackagesUsed
	});
};
