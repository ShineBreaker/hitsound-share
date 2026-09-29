// DELETE /api/package/<id>：上传者删自己的包 / 管理员删任意（ADMIN_OSU_ID）。
// D1：decrement refcount → 删包（级联 files）→ 清归零 blobs 行；R2：删归零 blob + zip
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/media';
import { getSecrets, isAdmin } from '$lib/server/env';
import { verifySession, SESSION_COOKIE } from '$lib/server/session';
import { getPackage, purgePackage } from '$lib/server/packages';

export const DELETE: RequestHandler = async ({ params, platform, cookies }) => {
	const env = getEnv(platform);
	const secrets = getSecrets(platform);
	if (!env || !secrets.SESSION_SECRET) return json({ error: 'service_unavailable' }, { status: 503 });

	const session = await verifySession(cookies.get(SESSION_COOKIE), secrets.SESSION_SECRET);
	if (!session) return json({ error: 'not_logged_in' }, { status: 401 });

	const pkg = await getPackage(env.DB, params.id);
	if (!pkg) return json({ error: 'not_found' }, { status: 404 });

	// 权限：上传者本人；或管理员；系统导入（uploader NULL）仅管理员
	const owner = pkg.uploader_osu_id === session.osuId;
	const admin = isAdmin(secrets, session.osuId);
	if (!owner && !admin) return json({ error: 'forbidden' }, { status: 403 });

	const result = await purgePackage(env, pkg.id);
	if (!result.ok) return json({ error: result.error }, { status: 500 });
	return json({ ok: true });
};
