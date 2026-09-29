// /api/config：前端能力开关。OSU OAuth 凭证未配置时 uploadEnabled=false，
// 前端据此隐藏登录/上传入口（浏览/试听/下载不受影响）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform }) => {
	// Pages 环境变量挂在 platform.env；本地 dev 兜底读 process.env（.env 由加载器注入）
	const bindings = platform?.env as Record<string, string | undefined> | undefined;
	const processEnv: Record<string, string | undefined> =
		typeof process !== 'undefined' ? process.env : {};

	const clientId = bindings?.OSU_CLIENT_ID ?? processEnv.OSU_CLIENT_ID;
	const clientSecret = bindings?.OSU_CLIENT_SECRET ?? processEnv.OSU_CLIENT_SECRET;

	return json({ uploadEnabled: Boolean(clientId && clientSecret) });
};
