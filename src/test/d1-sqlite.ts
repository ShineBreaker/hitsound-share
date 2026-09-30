// 测试用 D1 适配器：node:sqlite 内存库模拟 D1Database 的 prepare/bind/first/all/run/batch。
// - PRAGMA foreign_keys = ON：ON DELETE CASCADE 等行为与 D1 一致
// - ?1..?N 编号参数按位置绑定（与 D1 同）
// - batch 用 BEGIN/COMMIT 包裹，出错 ROLLBACK；SELECT 或含 RETURNING 的语句
//   在 results 里返回行（D1 语义），batch 整体只计一次调用
// - calls 计数器：每次 first/all/run/batch 记一次（= 一次子请求），供预算断言
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';

const SCHEMA_PATH = fileURLToPath(new URL('../../schema.sql', import.meta.url));

/** 语句是否需要在 batch/run 里回行：SELECT/WITH 开头或含 RETURNING 子句 */
function returnsRows(sql: string): boolean {
	const head = sql.trimStart().toUpperCase();
	return head.startsWith('SELECT') || head.startsWith('WITH') || /\bRETURNING\b/i.test(sql);
}

/**
 * node:sqlite 只认匿名 ? 的位置绑定（?N 要对象绑定）——把 ?N 归一为 ? 并按出现
 * 顺序从 D1 式编号参数取值（?2 ?1 乱序、同号复用都合法）。跳过字符串与注释。
 */
function normalizeParams(sql: string, args: unknown[]): { sql: string; args: unknown[] } {
	let out = '';
	const order: number[] = [];
	let inStr = false;
	for (let i = 0; i < sql.length; i++) {
		const c = sql[i];
		if (inStr) {
			out += c;
			if (c === "'") {
				if (sql[i + 1] === "'") {
					out += "'";
					i += 1; // '' 转义
				} else {
					inStr = false;
				}
			}
			continue;
		}
		if (c === "'") {
			inStr = true;
			out += c;
			continue;
		}
		if (c === '-' && sql[i + 1] === '-') {
			const e = sql.indexOf('\n', i);
			out += sql.slice(i, e === -1 ? sql.length : e);
			i = (e === -1 ? sql.length : e) - 1;
			continue;
		}
		if (c === '/' && sql[i + 1] === '*') {
			const e = sql.indexOf('*/', i + 2);
			out += sql.slice(i, e === -1 ? sql.length : e + 2);
			i = (e === -1 ? sql.length : e + 2) - 1;
			continue;
		}
		if (c === '?') {
			let j = i + 1;
			let n = 0;
			let numbered = false;
			while (j < sql.length && sql[j] >= '0' && sql[j] <= '9') {
				n = n * 10 + (sql[j].charCodeAt(0) - 48);
				numbered = true;
				j += 1;
			}
			out += '?';
			order.push(numbered ? n - 1 : order.length); // 匿名 ? 按位顺取
			i = j - 1;
			continue;
		}
		out += c;
	}
	return { sql: out, args: order.map((k) => args[k]) };
}
function fakeMeta(changes: number): D1Result['meta'] {
	return { changes } as D1Result['meta'];
}

/** 不带计数的底层执行（batch 内部复用） */
class FakeStmt {
	constructor(
		private readonly inner: DatabaseSync,
		readonly sql: string,
		private readonly args: unknown[] = []
	) {}

	bind(...args: unknown[]): FakeStmt {
		return new FakeStmt(this.inner, this.sql, args);
	}

	private raw() {
		const { sql, args } = normalizeParams(this.sql, this.args);
		const s = this.inner.prepare(sql);
		// node:sqlite 不接受 undefined 绑定：统一转 null
		return { s, args: args.map((a) => (a === undefined ? null : a)) as never[] };
	}

	async first<T = unknown>(): Promise<T | null> {
		const { s, args } = this.raw();
		return (s.get(...args) ?? null) as T | null;
	}

	async all<T = unknown>(): Promise<D1Result<T>> {
		const { s, args } = this.raw();
		return { results: s.all(...args) as T[], success: true, meta: fakeMeta(0) };
	}

	async run(): Promise<D1Result> {
		const { s, args } = this.raw();
		// RETURNING 语句跑 all() 收行（行数即 changes），否则 run()
		const changes = returnsRows(this.sql)
			? s.all(...args).length
			: Number(s.run(...args).changes);
		return { results: [], success: true, meta: fakeMeta(changes) };
	}
}

/** 暴露给 db.batch 的包装对象形态：底层 FakeStmt 挂在 __st 上 */
interface WrappedStmt {
	__st: FakeStmt;
	bind(...args: unknown[]): WrappedStmt;
	first<T = unknown>(): Promise<T | null>;
	all<T = unknown>(): Promise<D1Result<T>>;
	run(): Promise<D1Result>;
}

export interface TestD1 {
	db: D1Database;
	/** 已发生的 D1 调用数（prepare/bind 不计，first/all/run/batch 各计一次） */
	readonly calls: number;
}

export function createTestD1(): TestD1 {
	const inner = new DatabaseSync(':memory:');
	inner.exec('PRAGMA foreign_keys = ON');
	inner.exec(readFileSync(SCHEMA_PATH, 'utf8'));
	const state = { calls: 0 };

	const wrap = (st: FakeStmt): WrappedStmt => ({
		__st: st,
		bind: (...args: unknown[]) => wrap(st.bind(...args)),
		first: <T>() => {
			state.calls += 1;
			return st.first<T>();
		},
		all: <T>() => {
			state.calls += 1;
			return st.all<T>();
		},
		run: () => {
			state.calls += 1;
			return st.run();
		}
	});

	const db = {
		prepare(sql: string): D1PreparedStatement {
			return wrap(new FakeStmt(inner, sql)) as unknown as D1PreparedStatement;
		},
		async batch(stmts: D1PreparedStatement[]): Promise<D1Result[]> {
			state.calls += 1;
			inner.exec('BEGIN');
			try {
				const out: D1Result[] = [];
				for (const st of stmts as unknown as WrappedStmt[]) {
					out.push(returnsRows(st.__st.sql) ? await st.__st.all() : await st.__st.run());
				}
				inner.exec('COMMIT');
				return out;
			} catch (e) {
				inner.exec('ROLLBACK');
				throw e;
			}
		}
	};

	return {
		db: db as unknown as D1Database,
		get calls() {
			return state.calls;
		}
	};
}
