// PATCH /api/package/<id>/folder：包内文件夹改名（小类改名，含子文件夹级联）。
// DELETE /api/package/<id>/folder：删除文件夹及其子文件夹的全部文件（包主/管理员）。
// folder_path 含 # 空格 & 逗号为常态：不用 LIKE（通配符转义易错），而是 DISTINCT 取
// 全量路径在 JS 算前缀映射，再按全值精确匹配逐条 UPDATE/生成选择器（值全部参数绑定）。
// to 已存在 = 合并文件夹（允许：把一个小类并入另一个小类）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePackageOwner } from '$lib/server/guard';
import { releaseFiles, selectByFolders } from '$lib/server/ledger';

/** 路径合法性：拒目录穿越/绝对路径/反斜杠/空段，长度 ≤512（与 manifest 路径校验同口径） */
function validFolderPath(p: unknown): p is string {
	if (typeof p !== 'string' || p.length === 0 || p.length > 512) return false;
	if (p.includes('..') || p.startsWith('/') || p.includes('\\')) return false;
	return p.split('/').every((seg) => seg.length > 0);
}

export const PATCH: RequestHandler = async ({ params, request, platform, cookies }) => {
	const g = await requirePackageOwner(platform, cookies, params.id);
	if (g instanceof Response) return g;

	const body = (await request.json().catch(() => null)) as { from?: unknown; to?: unknown } | null;
	// '' = 包根，包根不可改名（改包名走 PATCH /api/package/<id>）
	if (!validFolderPath(body?.from) || !validFolderPath(body?.to) || body.from === body.to) {
		return json({ error: 'bad_folder' }, { status: 400 });
	}
	// to 落在 from 子树内（如 a → a/b）：快照式顺序 UPDATE 会把已迁入的行再次搬走，拒绝
	if (body.to.startsWith(`${body.from}/`)) {
		return json({ error: 'bad_folder' }, { status: 400 });
	}

	const { results } = await g.env.DB.prepare(
		'SELECT DISTINCT folder_path FROM files WHERE package_id = ?1'
	)
		.bind(g.pkg.id)
		.all<{ folder_path: string }>();

	// 受影响 = 恰为 from 或其子路径（from + '/' 前缀）；全值匹配避免 'a' 误伤 'ab/c'
	const moves: Array<{ from: string; to: string }> = [];
	for (const r of results ?? []) {
		const p = r.folder_path;
		if (p === body.from || p.startsWith(`${body.from}/`)) {
			moves.push({ from: p, to: `${body.to}${p.slice(body.from.length)}` });
		}
	}
	if (moves.length === 0) return json({ error: 'folder_not_found' }, { status: 404 });

	const stmts = moves.map((m) =>
		g.env.DB.prepare(
			'UPDATE files SET folder_path = ?1 WHERE package_id = ?2 AND folder_path = ?3'
		).bind(m.to, g.pkg.id, m.from)
	);
	for (let i = 0; i < stmts.length; i += 50) {
		await g.env.DB.batch(stmts.slice(i, i + 50));
	}
	return json({ ok: true, moved: moves.length });
};

/** DELETE：body { path } 删该文件夹及子文件夹内全部文件；包删空后自动从树消失（tree JOIN files） */
export const DELETE: RequestHandler = async ({ params, request, platform, cookies }) => {
	const g = await requirePackageOwner(platform, cookies, params.id);
	if (g instanceof Response) return g;

	const body = (await request.json().catch(() => null)) as { path?: unknown } | null;
	const path = body?.path;
	// '' = 包根不是文件夹节点（整包删除走 DELETE /api/package/<id>），拒绝
	if (!validFolderPath(path)) return json({ error: 'bad_folder' }, { status: 400 });

	const { results } = await g.env.DB.prepare(
		'SELECT DISTINCT folder_path FROM files WHERE package_id = ?1'
	)
		.bind(g.pkg.id)
		.all<{ folder_path: string }>();

	// 受影响 = 恰为 path 或其子路径（path + '/' 前缀）；与 PATCH 同口径防 'a' 误伤 'ab/c'
	const paths = (results ?? [])
		.map((r) => r.folder_path)
		.filter((p) => p === path || p.startsWith(`${path}/`));
	if (paths.length === 0) return json({ error: 'folder_not_found' }, { status: 404 });

	const deleted = await releaseFiles(g.env, selectByFolders(g.pkg.id, paths), [g.pkg.id]);
	return json({ ok: true, deleted });
};
