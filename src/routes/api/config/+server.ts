// /api/config：前端能力开关 + 上传限制与存储池用量（前台展示用）。
// 上传链路所需凭证（osu OAuth + session 密钥 + R2 直传）任一未配置时 uploadEnabled=false，
// 前端隐藏登录/上传入口（浏览/试听/下载不受影响）。
// storageUsedBytes 与 /api/upload 的水位公式同口径（blobs 账本 SUM + visible 包 zip 存量）；
// dailyPackagesUsed 仅登录时返回，与配额闸门同口径（24h 内全部包，含 pending/影子包）。
// gate.locked = 站点访问密码门状态（本端点在 hooks 白名单内，未解锁可访问——前端据此显示遮罩；
// 门未启用恒 false）。凭证与 hooks 同为三源择一（cookie / x-hs-gate 头 / ?hs_gate= query）——
// 桌面端无 cookie，若只读 cookie 则解锁存 token 后 reload 仍 locked:true，遮罩死循环
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecrets, uploadCapable } from '$lib/server/env';
import { getEnv } from '$lib/server/media';
import { verifySession, SESSION_COOKIE } from '$lib/server/session';
import { GATE_COOKIE, isSiteUnlocked, pickGateCredential } from '$lib/server/site-gate';
import {
	GLOBAL_CAP_BYTES,
	MAX_AUDIO_BYTES,
	MAX_ENTRIES,
	MAX_FILE_BYTES,
	PKGS_PER_DAY
} from '$lib/server/upload';

export const GET: RequestHandler = async ({ platform, cookies, request, url }) => {
	const secrets = getSecrets(platform);
	const env = getEnv(platform);
	const uploadEnabled = uploadCapable(secrets);

	let storageUsedBytes: number | null = null;
	let dailyPackagesUsed: number | null = null;
	let gateLocked = false;
	if (env) {
		gateLocked = !(
			await isSiteUnlocked(
				env.DB,
				pickGateCredential(
					cookies.get(GATE_COOKIE),
					request.headers.get('x-hs-gate'),
					url.searchParams.get('hs_gate')
				),
				secrets.SITE_DEFAULT_PASSWORD
			)
		);
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
		gate: { locked: gateLocked },
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
