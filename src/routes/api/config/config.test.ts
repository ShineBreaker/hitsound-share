// /api/config 端到端：限制常量透出 + 存储池用量（与水位公式同口径）+ 登录时当日配额
// + gate.locked 三源凭证（cookie / x-hs-gate / ?hs_gate=，防桌面解锁死循环）
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestD1, type TestD1 } from '../../../test/d1-sqlite';
import { createMemoryR2, type MemoryR2 } from '../../../test/r2-memory';
import { signSession, SESSION_COOKIE } from '$lib/server/session';
import { getGateState, issueUnlockValue } from '$lib/server/site-gate';
import { GET } from './+server';

const SECRET = 'config-test-secret';
const UID = 4242;
const GATE_PW = 'gate-pass-1';
const h = (n: number) => n.toString(16).padStart(64, '0');

let d1: TestD1;
let r2: MemoryR2;
let cookie = '';

interface CallOpts {
	/** 模拟 SITE_DEFAULT_PASSWORD（配置 = 门启用） */
	gatePw?: string;
	/** x-hs-gate 头 */
	gateHeader?: string;
	/** 完整路径（含 query，如 ?hs_gate=） */
	path?: string;
}

function call(cookieValue = cookie, opts: CallOpts = {}): Promise<Response> {
	const path = opts.path ?? '/api/config';
	return GET({
		request: new Request(`https://t.local${path}`, {
			headers: opts.gateHeader ? { 'x-hs-gate': opts.gateHeader } : undefined
		}),
		platform: {
			env: {
				DB: d1.db,
				HITSOUND_FILES: r2.bucket,
				SESSION_SECRET: SECRET,
				OSU_CLIENT_ID: '1',
				OSU_CLIENT_SECRET: 's',
				R2_ACCOUNT_ID: 'acct',
				R2_ACCESS_KEY_ID: 'ak',
				R2_SECRET_ACCESS_KEY: 'sk',
				SITE_DEFAULT_PASSWORD: opts.gatePw
			}
		},
		cookies: { get: (n: string) => (n === SESSION_COOKIE ? cookieValue : undefined) },
		url: new URL(`https://t.local${path}`)
	} as unknown as Parameters<typeof GET>[0]);
}

async function addBlobRow(hash: string, size: number): Promise<void> {
	await d1.db
		.prepare('INSERT INTO blobs (hash, size, mime, refcount) VALUES (?1, ?2, ?3, 1)')
		.bind(hash, size, 'audio/wav')
		.run();
}

/** SQLite datetime('now') 同格式的 UTC 时间串（绑定参数不执行 SQL 函数，须 JS 侧算好） */
function sqliteUtc(msAgo = 0): string {
	return new Date(Date.now() - msAgo)
		.toISOString()
		.slice(0, 19)
		.replace('T', ' ');
}

async function addPackage(id: string, createdAt: string, zipBytes: number): Promise<void> {
	await d1.db
		.prepare(
			`INSERT INTO packages (id, name, uploader_osu_id, size_bytes, logical_size, file_count, status, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?4, 1, 'visible', ?5)`
		)
		.bind(id, `pkg-${id}`, UID, zipBytes, createdAt)
		.run();
}

beforeEach(async () => {
	d1 = createTestD1();
	r2 = createMemoryR2();
	cookie = await signSession({ osuId: UID, username: 'tester', avatarUrl: null }, SECRET);
	await d1.db
		.prepare('INSERT INTO users (osu_id, username) VALUES (?1, ?2)')
		.bind(UID, 'tester')
		.run();
});

describe('GET /api/config', () => {
	it('未登录：限制常量 + 存储池用量（blobs + visible zip 存量同口径），dailyPackagesUsed=null', async () => {
		await addBlobRow(h(1), 100);
		await addBlobRow(h(2), 50);
		await addPackage('pk-old', sqliteUtc(2 * 24 * 3600 * 1000), 30);

		const res = await call('');
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.uploadEnabled).toBe(true);
		expect(data.limits).toEqual({
			maxFileBytes: 10 * 1024 * 1024,
			maxPackageBytes: 1024 * 1024 * 1024,
			maxEntries: 5000,
			dailyPackages: 5,
			storageCapBytes: 10 * 1024 * 1024 * 1024
		});
		expect(data.storageUsedBytes).toBe(180);
		expect(data.dailyPackagesUsed).toBeNull();
	});

	it('登录：dailyPackagesUsed 按 24h 口径计数（pending/影子包在内，旧包不计）', async () => {
		await addPackage('p1', sqliteUtc(), 0);
		await addPackage('p2', sqliteUtc(), 0);
		await addPackage('p3', sqliteUtc(2 * 24 * 3600 * 1000), 0);

		const res = await call();
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.dailyPackagesUsed).toBe(2);
	});

	it('无 bindings：storageUsedBytes=null（浏览功能不受影响）', async () => {
		const res = await GET({
			request: new Request('https://t.local/api/config'),
			platform: undefined,
			cookies: { get: () => undefined },
			url: new URL('https://t.local/api/config')
		} as unknown as Parameters<typeof GET>[0]);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.uploadEnabled).toBe(false);
		expect(data.storageUsedBytes).toBeNull();
		expect(data.dailyPackagesUsed).toBeNull();
	});
});

describe('GET /api/config gate.locked 三源凭证', () => {
	it('门启用无凭证 → locked:true', async () => {
		const res = await call('', { gatePw: GATE_PW });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { gate: { locked: boolean } }).gate.locked).toBe(true);
	});

	it('x-hs-gate 有效 token → locked:false（桌面解锁存 token 后 reload 不再死循环）', async () => {
		const token = await issueUnlockValue((await getGateState(d1.db, GATE_PW)).hash!);
		const res = await call('', { gatePw: GATE_PW, gateHeader: token });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { gate: { locked: boolean } }).gate.locked).toBe(false);
	});

	it('?hs_gate= 有效 token → locked:false', async () => {
		const token = await issueUnlockValue((await getGateState(d1.db, GATE_PW)).hash!);
		const res = await call('', {
			gatePw: GATE_PW,
			path: `/api/config?hs_gate=${encodeURIComponent(token)}`
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { gate: { locked: boolean } }).gate.locked).toBe(false);
	});

	it('坏 token → locked:true', async () => {
		const res = await call('', { gatePw: GATE_PW, gateHeader: 'deadbeef.bogussig' });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { gate: { locked: boolean } }).gate.locked).toBe(true);
	});

	it('门判定子请求数不增：三源凭证下 config 仍只 1 条 settings SELECT + 1 条用量', async () => {
		const token = await issueUnlockValue((await getGateState(d1.db, GATE_PW)).hash!);
		const before = d1.calls;
		const res = await call('', { gatePw: GATE_PW, gateHeader: token }); // 未登录：无 daily 查询
		expect(res.status).toBe(200);
		expect(d1.calls - before).toBe(2);
	});
});
