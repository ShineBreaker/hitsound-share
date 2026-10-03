// GET /api/my/packages：我的上传列表（登录后可见；附加影子包不展示，合并后即消失）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/guard';

export const GET: RequestHandler = async ({ request, platform, cookies }) => {
	const g = await requireUser(platform, cookies, request);
	if (g instanceof Response) return g;

	const { results } = await g.env.DB.prepare(
		`SELECT id, name, status, created_at, file_count, size_bytes, logical_size
		 FROM packages WHERE uploader_osu_id = ?1 AND append_to IS NULL
		 ORDER BY created_at DESC`
	)
		.bind(g.session.osuId)
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
