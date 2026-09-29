// POST /api/admin/purge-zips：一次性清理存量 original.zip（v4 起整包下载实时打包，
// zip 无消费者）。仅 ADMIN_OSU_ID。每调用处理 ≤40 个包（R2 binding 调用计入子请求，
// 免费计划单请求上限 50），返回 remaining，>0 时再调一次即可（幂等，zip 不存在不报错）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/media';
import { getSecrets, isAdmin } from '$lib/server/env';
import { verifySession, SESSION_COOKIE } from '$lib/server/session';

const BATCH = 40;

export const POST: RequestHandler = async ({ platform, cookies }) => {
	const env = getEnv(platform);
	const secrets = getSecrets(platform);
	if (!env || !secrets.SESSION_SECRET) return json({ error: 'service_unavailable' }, { status: 503 });

	const session = await verifySession(cookies.get(SESSION_COOKIE), secrets.SESSION_SECRET);
	if (!session) return json({ error: 'not_logged_in' }, { status: 401 });
	if (!isAdmin(secrets, session.osuId)) return json({ error: 'forbidden' }, { status: 403 });

	// size_bytes > 0 = 账上有 zip 的历史包；清完置 0，天然形成断点游标
	const { results } = await env.DB.prepare(
		`SELECT id FROM packages WHERE size_bytes > 0 ORDER BY created_at LIMIT ?1`
	)
		.bind(BATCH)
		.all<{ id: string }>();

	for (const row of results ?? []) {
		await env.HITSOUND_FILES.delete(`packages/${row.id}/original.zip`);
	}
	if ((results ?? []).length > 0) {
		await env.DB.batch(
			(results ?? []).map((row) =>
				env.DB.prepare('UPDATE packages SET size_bytes = 0 WHERE id = ?1').bind(row.id)
			)
		);
	}

	const left = await env.DB.prepare(
		'SELECT COUNT(*) AS c FROM packages WHERE size_bytes > 0'
	).first<{ c: number }>();

	return json({ deleted: (results ?? []).length, remaining: left?.c ?? 0 });
};
