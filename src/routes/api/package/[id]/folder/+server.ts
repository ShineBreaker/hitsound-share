// PATCH /api/package/<id>/folder：包内文件夹改名（小类改名，含子文件夹级联）。
// folder_path 含 # 空格 & 逗号为常态：不用 LIKE（通配符转义易错），而是 DISTINCT 取
// 全量路径在 JS 算前缀映射，再按全值精确匹配逐条 UPDATE（值全部参数绑定）。
// to 已存在 = 合并文件夹（允许：把一个小类并入另一个小类）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePackageOwner } from '$lib/server/packages';

/** 路径合法性：拒目录穿越/绝对路径/反斜杠/空段，长度 ≤512（与 manifest 路径校验同口径） */
function validFolderPath(p: unknown): p is string {
	if (typeof p !== 'string' || p.length === 0 || p.length > 512) return false;
	if (p.includes('..') || p.startsWith('/') || p.includes('\\')) return false;
	return p.split('/').every((seg) => seg.length > 0);
}

export const PATCH: RequestHandler = async ({ params, request, platform, cookies }) => {
	const guard = await requirePackageOwner(platform, cookies, params.id);
	if ('error' in guard) return json({ error: guard.error }, { status: guard.status });

	const body = (await request.json().catch(() => null)) as { from?: unknown; to?: unknown } | null;
	// '' = 包根，包根不可改名（改包名走 PATCH /api/package/<id>）
	if (!validFolderPath(body?.from) || !validFolderPath(body?.to) || body.from === body.to) {
		return json({ error: 'bad_folder' }, { status: 400 });
	}
	// to 落在 from 子树内（如 a → a/b）：快照式顺序 UPDATE 会把已迁入的行再次搬走，拒绝
	if (body.to.startsWith(`${body.from}/`)) {
		return json({ error: 'bad_folder' }, { status: 400 });
	}

	const { results } = await guard.env.DB.prepare(
		'SELECT DISTINCT folder_path FROM files WHERE package_id = ?1'
	)
		.bind(guard.pkg.id)
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
		guard.env.DB.prepare(
			'UPDATE files SET folder_path = ?1 WHERE package_id = ?2 AND folder_path = ?3'
		).bind(m.to, guard.pkg.id, m.from)
	);
	for (let i = 0; i < stmts.length; i += 50) {
		await guard.env.DB.batch(stmts.slice(i, i + 50));
	}
	return json({ ok: true, moved: moves.length });
};
