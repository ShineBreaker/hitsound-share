// 路由守卫：登录态 + 包归属校验的统一入口。
// 返回 Response 即「已作答」（调用方 `if (g instanceof Response) return g;`），
// 否则放行并回传 env / secrets / session（/pkg）
import { json, type Cookies } from '@sveltejs/kit';
import { getEnv, type Env } from './media';
import { getSecrets, isAdmin, type Secrets } from './env';
import { verifySession, SESSION_COOKIE, type SessionUser } from './session';
import { getPackage, type PackageRow } from './packages';

export interface UserGuard {
	env: Env;
	secrets: Partial<Secrets>;
	session: SessionUser;
}

/** 登录守卫：bindings 与 SESSION_SECRET 缺一 → 503；无有效 session → 401 */
export async function requireUser(
	platform: App.Platform | undefined,
	cookies: Cookies
): Promise<UserGuard | Response> {
	const env = getEnv(platform);
	const secrets = getSecrets(platform);
	if (!env || !secrets.SESSION_SECRET) return json({ error: 'service_unavailable' }, { status: 503 });
	const session = await verifySession(cookies.get(SESSION_COOKIE), secrets.SESSION_SECRET);
	if (!session) return json({ error: 'not_logged_in' }, { status: 401 });
	return { env, secrets, session };
}

export type PackageGuard = (UserGuard & { pkg: PackageRow }) | Response;

/** 包级操作守卫：登录 + 包存在（404）+ 上传者本人或管理员（403；uploader NULL 的系统导入仅管理员） */
export async function requirePackageOwner(
	platform: App.Platform | undefined,
	cookies: Cookies,
	id: string
): Promise<PackageGuard> {
	const g = await requireUser(platform, cookies);
	if (g instanceof Response) return g;
	const pkg = await getPackage(g.env.DB, id);
	if (!pkg) return json({ error: 'not_found' }, { status: 404 });
	const owner = pkg.uploader_osu_id === g.session.osuId;
	if (!owner && !isAdmin(g.secrets, g.session.osuId)) {
		return json({ error: 'forbidden' }, { status: 403 });
	}
	return { ...g, pkg };
}
