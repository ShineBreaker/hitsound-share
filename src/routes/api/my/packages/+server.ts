// GET /api/my/packages：我的上传列表（登录后可见；附加影子包不展示，合并后即消失）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/media';
import { getSecrets } from '$lib/server/env';
import { verifySession, SESSION_COOKIE } from '$lib/server/session';

export const GET: RequestHandler = async ({ platform, cookies }) => {
	const env = getEnv(platform);
	const secrets = getSecrets(platform);
	if (!env || !secrets.SESSION_SECRET) return json({ error: 'service_unavailable' }, { status: 503 });

	const session = await verifySession(cookies.get(SESSION_COOKIE), secrets.SESSION_SECRET);
	if (!session) return json({ error: 'not_logged_in' }, { status: 401 });

	const { results } = await env.DB.prepare(
		`SELECT id, name, status, created_at, file_count, size_bytes, logical_size
		 FROM packages WHERE uploader_osu_id = ?1 AND append_to IS NULL
		 ORDER BY created_at DESC`
	)
		.bind(session.osuId)
		.all<{
			id: string;
			name: string;
			status: string;
			created_at: string;
			file_count: number;
			size_bytes: number;
			logical_size: number;
		}>();

	return json({ packages: results ?? [] });
};
