// /api/config：前端能力开关。上传链路所需凭证（osu OAuth + session 密钥 + R2 直传）
// 任一未配置时 uploadEnabled=false，前端隐藏登录/上传入口（浏览/试听/下载不受影响）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecrets } from '$lib/server/env';

export const GET: RequestHandler = async ({ platform }) => {
	const s = getSecrets(platform);
	const uploadEnabled = Boolean(
		s.OSU_CLIENT_ID &&
			s.OSU_CLIENT_SECRET &&
			s.SESSION_SECRET &&
			s.R2_ACCOUNT_ID &&
			s.R2_ACCESS_KEY_ID &&
			s.R2_SECRET_ACCESS_KEY
	);
	return json({ uploadEnabled });
};
