// POST /api/files/move：把文件/小类搬到另一包（或同包另一小类）。
// 两种互斥模式（ids 与 fromPackage 同时出现或都缺 → 400 bad_body）：
// - 文件模式 { ids, toPackage, toFolder }：跨包移动选中文件，ids 校验与 DELETE /api/files 同口径
// - 小类模式 { fromPackage, fromFolder, toPackage, toFolder }：整小类（含子树）迁移；
//   fromFolder 非空（'' 是包根，整包内容迁移走改名合并 PATCH /api/package/<id> merge=true）
// 源侧权限与 DELETE /api/files 同口径：文件级 owner（非管理员须全部本人上传，owner NULL
// 仅管理员），任一不符 403 全不动；目标包走 requirePackageOwner + visible 非影子。
// folder_path 全值精确匹配（substr 前缀判定，不用 LIKE）；目标已有三重相同（同路径同名同内容）
// 的行 = 合并去重（EXISTS 恒排除候选行自身）。refcount 只按本次受影响 hash 集合分片对齐
// （集合由归属查询顺带收集，零额外子请求）。子请求预算：文件模式最坏路径（500 ids）恒
// 1 + 1 + 1 次 D1——主事务单批：2×⌈500/90⌉ 选择器 + ≤⌈501/90⌉ 计数重算分片 + ⌈去重hash/90⌉
// 对齐分片 ≤ 250；小类模式主事务单批（语句数 = 4 + 对齐分片）
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import { requirePackageOwner } from '$lib/server/guard';
import { isAdmin } from '$lib/server/admin';
import { selectByIds, alignRefcountStmts } from '$lib/server/ledger';

const MAX_MOVE_IDS = 500;

/** 路径合法性：拒目录穿越/绝对路径/反斜杠/空段，长度 ≤512（与 folder 端点同口径） */
function validFolderPath(p: unknown): p is string {
	if (typeof p !== 'string' || p.length === 0 || p.length > 512) return false;
	if (p.includes('..') || p.startsWith('/') || p.includes('\\')) return false;
	return p.split('/').every((seg) => seg.length > 0);
}

/** 目标路径额外允许 ''（包根） */
function validTargetPath(p: unknown): p is string {
	return p === '' || validFolderPath(p);
}

/** 受影响包计数重算（迁移后按 files 现状重算，不增量累加，天然幂等） */
function recountStmt(db: D1Database, pid: string): D1PreparedStatement {
	return db.prepare(
		`UPDATE packages SET
		   file_count = (SELECT COUNT(*) FROM files WHERE package_id = ?1),
		   logical_size = (SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE package_id = ?1)
		 WHERE id = ?1`
	).bind(pid);
}

/** 文件模式的计数重算：受影响包合并为 IN 分片语句（每片 ≤90 参数，与 selectByIds 同余量）。
 *  语句数与受影响包数解耦——主事务恒单批 ≤250 语句，大批量不拆批破坏单事务原子性 */
function recountStmts(db: D1Database, pids: string[]): D1PreparedStatement[] {
	const stmts: D1PreparedStatement[] = [];
	for (let i = 0; i < pids.length; i += 90) {
		const chunk = pids.slice(i, i + 90);
		stmts.push(
			db.prepare(
				`UPDATE packages SET
				   file_count = (SELECT COUNT(*) FROM files WHERE package_id = packages.id),
				   logical_size = (SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE package_id = packages.id)
				 WHERE id IN (${chunk.map((_, j) => `?${j + 1}`).join(', ')})`
			).bind(...chunk)
		);
	}
	return stmts;
}

export const POST: RequestHandler = async ({ request, platform, cookies }) => {
	const body = (await request.json().catch(() => null)) as {
		ids?: unknown;
		toPackage?: unknown;
		toFolder?: unknown;
		fromPackage?: unknown;
		fromFolder?: unknown;
	} | null;
	// 模式判定：ids 与 fromPackage 恰有其一
	const fileMode = body?.ids !== undefined;
	if (!body || fileMode === (body.fromPackage !== undefined)) {
		return json({ error: 'bad_body' }, { status: 400 });
	}

	let uniqueIds: string[] = [];
	let fromPackage = '';
	let fromFolder = '';
	if (fileMode) {
		const ids = body.ids;
		if (
			!Array.isArray(ids) ||
			ids.length === 0 ||
			ids.length > MAX_MOVE_IDS ||
			!ids.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 64)
		) {
			return json({ error: 'bad_body' }, { status: 400 });
		}
		uniqueIds = [...new Set(ids)];
	} else {
		if (
			typeof body.fromPackage !== 'string' ||
			body.fromPackage.length === 0 ||
			!validFolderPath(body.fromFolder)
		) {
			return json({ error: 'bad_body' }, { status: 400 });
		}
		fromPackage = body.fromPackage;
		fromFolder = body.fromFolder;
	}
	if (
		typeof body.toPackage !== 'string' ||
		body.toPackage.length === 0 ||
		!validTargetPath(body.toFolder)
	) {
		return json({ error: 'bad_body' }, { status: 400 });
	}
	const toPackage = body.toPackage;
	const toFolder = body.toFolder;

	// 1. 目标包：包主/管理员 + visible 非影子（pending / 影子 visible 行不作迁移目标）
	const g = await requirePackageOwner(platform, cookies, request, toPackage);
	if (g instanceof Response) return g;
	if (g.pkg.status !== 'visible' || g.pkg.append_to !== null) {
		return json({ error: 'bad_target' }, { status: 409 });
	}
	const env = g.env;

	// 2. 源侧归属（两模式同口径）：DISTINCT (包, owner, hash)——非管理员须全部本人上传，
	//    任一不符 403 全不动；全部本人则免 isAdmin 读（省一次 users 主键查询）。
	//    blob_hash 顺带带出：候选行的 DISTINCT hash 集恰为本次 refcount 对齐的受影响集合
	//    （含将被去重删除的行——查询时都还在），零额外子请求
	interface SrcRow {
		pid: string;
		owner: number | null;
		hash: string;
	}
	const srcRows: SrcRow[] = [];
	if (fileMode) {
		// files 别名 f：选择器列名须带前缀；package_id 供受影响包圈定
		const ownerStmts = selectByIds(uniqueIds, 'f.id').map((s) =>
			env.DB.prepare(
				`SELECT DISTINCT f.package_id AS pid, f.owner_osu_id AS owner, f.blob_hash AS hash
				 FROM files f WHERE ${s.clause}`
			).bind(...s.params)
		);
		for (let i = 0; i < ownerStmts.length; i += 250) {
			const res = await env.DB.batch(ownerStmts.slice(i, i + 250));
			for (const r of res) srcRows.push(...((r.results ?? []) as SrcRow[]));
		}
		if (srcRows.length === 0) return json({ error: 'not_found' }, { status: 404 });
	} else {
		// 小类含子树：恰为 fromFolder 或 fromFolder + '/' 前缀（substr 全值比较，'a' 不误伤 'ab'）
		const { results } = await env.DB.prepare(
			`SELECT DISTINCT package_id AS pid, owner_osu_id AS owner, blob_hash AS hash FROM files
			 WHERE package_id = ?1 AND (folder_path = ?2 OR substr(folder_path, 1, length(?2) + 1) = ?2 || '/')`
		)
			.bind(fromPackage, fromFolder)
			.all<SrcRow>();
		srcRows.push(...(results ?? []));
		if (srcRows.length === 0) return json({ error: 'folder_not_found' }, { status: 404 });
	}
	if (
		srcRows.some((r) => r.owner !== g.session.osuId) &&
		!(await isAdmin(env.DB, g.secrets, g.session.osuId))
	) {
		return json({ error: 'forbidden' }, { status: 403 });
	}

	// 3. 小类模式边界：同包内原地/落入自身子树会让单条 UPDATE 把已迁行再搬走（口径同 folder PATCH）
	if (!fileMode && fromPackage === toPackage) {
		if (toFolder === fromFolder || toFolder.startsWith(`${fromFolder}/`)) {
			return json({ error: 'bad_folder' }, { status: 400 });
		}
	}

	// 4. 主事务：去重（RETURNING 收 deduped）→ 迁移 → 受影响包计数重算 → refcount
	//    按受影响 hash 集合分片对齐。去重不跑 RECLAIM / R2 删除：被丢行必有同 hash
	//    孪生行存活于目标包（EXISTS 命中即证明），迁移后引用只在包间挪动，构造上无 blob 归零
	const affectedHashes = [...new Set(srcRows.map((r) => r.hash))];
	let moved = 0;
	let deduped: string[] = [];
	if (fileMode) {
		const selectors = selectByIds(uniqueIds);
		const stmts: D1PreparedStatement[] = [];
		const dedupeAt: number[] = [];
		for (const s of selectors) {
			const base = s.params.length;
			dedupeAt.push(stmts.length);
			stmts.push(
				env.DB.prepare(
					// t.id <> files.id：已在 (toPackage, toFolder) 的候选行不得命中自己——
					// 否则被「去重」的是唯一存活行，blob 引用蒸发（P0 回归）
					`DELETE FROM files WHERE ${s.clause} AND EXISTS (
					   SELECT 1 FROM files t
					   WHERE t.package_id = ?${base + 1}
					     AND t.folder_path = ?${base + 2}
					     AND t.name = files.name
					     AND t.blob_hash = files.blob_hash
					     AND t.id <> files.id)
					 RETURNING id`
				).bind(...s.params, toPackage, toFolder)
			);
		}
		const migrateAt = stmts.length;
		for (const s of selectors) {
			const base = s.params.length;
			stmts.push(
				env.DB.prepare(
					`UPDATE files SET package_id = ?${base + 1}, folder_path = ?${base + 2} WHERE ${s.clause}`
				).bind(...s.params, toPackage, toFolder)
			);
		}
		stmts.push(...recountStmts(env.DB, [...new Set([...srcRows.map((r) => r.pid), toPackage])]));
		stmts.push(...alignRefcountStmts(env.DB, affectedHashes));
		// 250 语句/批分批；各批结果按语句序拼接，下标与 stmts 对齐
		const batchRes: D1Result[] = [];
		for (let i = 0; i < stmts.length; i += 250) {
			batchRes.push(...(await env.DB.batch(stmts.slice(i, i + 250))));
		}
		deduped = dedupeAt.flatMap((at) =>
			((batchRes[at]?.results ?? []) as Array<{ id: string }>).map((r) => r.id)
		);
		moved = batchRes
			.slice(migrateAt, migrateAt + selectors.length)
			.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
	} else {
		// toFolder='' 时 to||substr(...) 会产出前导 '/' 的非法路径：CASE 特判；
		// 去重 EXISTS 与迁移 UPDATE 的目标路径表达式须逐字一致
		const newPath = `CASE WHEN ?4 = ''
			  THEN substr(files.folder_path, length(?2) + 2)
			  ELSE ?4 || substr(files.folder_path, length(?2) + 1) END`;
		const subtree = `package_id = ?1
			  AND (folder_path = ?2 OR substr(folder_path, 1, length(?2) + 1) = ?2 || '/')`;
		const batchRes = await env.DB.batch([
			// 目标包已有三重相同（迁移后同路径同名同内容）的行直接丢弃
			env.DB.prepare(
				`DELETE FROM files WHERE ${subtree} AND EXISTS (
				   SELECT 1 FROM files t
				   WHERE t.package_id = ?3
				     AND t.folder_path = (${newPath})
				     AND t.name = files.name
				     AND t.blob_hash = files.blob_hash)
				 RETURNING id`
			).bind(fromPackage, fromFolder, toPackage, toFolder),
			// 余下条目迁移并把路径中 fromFolder 段整体替换为 toFolder
			env.DB.prepare(
				`UPDATE files SET package_id = ?3, folder_path = ${newPath} WHERE ${subtree}`
			).bind(fromPackage, fromFolder, toPackage, toFolder),
			recountStmt(env.DB, fromPackage),
			recountStmt(env.DB, toPackage),
			...alignRefcountStmts(env.DB, affectedHashes)
		]);
		deduped = ((batchRes[0]?.results ?? []) as Array<{ id: string }>).map((r) => r.id);
		moved = batchRes[1]?.meta?.changes ?? 0;
	}
	return json({ ok: true, moved, deduped });
};
