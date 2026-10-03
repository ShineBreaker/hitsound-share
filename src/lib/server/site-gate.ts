// 站点访问密码门（deep module）：数据 API 须解锁后访问（统一拦截在 src/hooks.server.ts）。
// - 密码源（优先级）：D1 settings（key = 'site_password_hash'，管理员改密后落库）
//   > 环境变量 SITE_DEFAULT_PASSWORD（部署方配置的初始密码）；两者皆无 = 门未启用，站点不拦；
// - 密码只以 sha256(SALT + 密码) 形态出现，明文不进代码/库；校验用请求提交值现算比对；
// - 解锁凭据 = cookie `hs_gate`，值为以「当前密码 hash」为密钥的 HMAC 签名
//   → 管理员改密码即作废全部已解锁会话，且不依赖 SESSION_SECRET；
//   跨源 Web / 桌面端（无 cookie 保障）用同构 token 经 `x-hs-gate` 头或 `?hs_gate=` query
//   携带（pickGateCredential 三源择一，cookie 优先——同源行为与纯 cookie 时代逐字节一致）；
// - 验证 = 1 条 settings 主键 SELECT + 1 次 HMAC（子请求预算每请求 +1）；
//   表未建/查询失败按无记录处理（退回环境变量或未启用），部署先发代码后建表也不会 500
import type { D1Database } from '@cloudflare/workers-types';

export const GATE_COOKIE = 'hs_gate';
export const GATE_MAX_AGE_S = 30 * 24 * 3600; // 解锁有效期 30 天

// 域分隔盐：防通用彩虹表直接命中
const SALT = 'hitsound-share/site-gate/v1';
const SETTINGS_KEY = 'site_password_hash';

const te = new TextEncoder();
const HMAC_SHA256_KEYGEN: Algorithm = { name: 'HMAC', hash: 'SHA-256' };

export interface GateState {
	/** 门是否启用（settings 有记录或环境变量配了初始密码） */
	enabled: boolean;
	/** 当前密码 hash；未启用时为 null */
	hash: string | null;
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', te.encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64urlEncode(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 定长逐位比较，避免时序侧信道（与 session.ts 同策略）
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** 合法密码：4-100 字符且不全为空白（设置时校验；比对存原值不 trim） */
export function validGatePassword(pw: string): boolean {
	return pw.length >= 4 && pw.length <= 100 && pw.trim() !== '';
}

/** 读当前门状态：库记录优先，其次环境变量初始密码，皆无 → 未启用 */
export async function getGateState(
	db: D1Database,
	defaultPassword?: string
): Promise<GateState> {
	const row = await db
		.prepare('SELECT value FROM settings WHERE key = ?1')
		.bind(SETTINGS_KEY)
		.first<{ value: string }>()
		.catch(() => null);
	if (row?.value) return { enabled: true, hash: row.value };
	if (defaultPassword) return { enabled: true, hash: await sha256Hex(SALT + defaultPassword) };
	return { enabled: false, hash: null };
}

/** 覆盖访问密码，返回新 hash（供调用方即时签发新解锁 cookie） */
export async function setGatePassword(db: D1Database, pw: string): Promise<string> {
	const hash = await sha256Hex(SALT + pw);
	await db
		.prepare(
			'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2'
		)
		.bind(SETTINGS_KEY, hash)
		.run();
	return hash;
}

/** 校验访问密码（与当前 hash 常量时间比对；门未启用恒 false——先判 state.enabled） */
export async function checkGatePassword(
	db: D1Database,
	pw: string,
	defaultPassword?: string
): Promise<boolean> {
	const state = await getGateState(db, defaultPassword);
	if (!state.hash) return false;
	return timingSafeEqual(await sha256Hex(SALT + pw), state.hash);
}

/** 签发解锁值：`<hash前16>.<HMAC(密码hash, "hs-gate:"+hash前16)>` */
export async function issueUnlockValue(passwordHash: string): Promise<string> {
	const fp = passwordHash.slice(0, 16);
	const key = await crypto.subtle.importKey('raw', te.encode(passwordHash), HMAC_SHA256_KEYGEN, false, [
		'sign'
	]);
	const sig = await crypto.subtle.sign('HMAC', key, te.encode(`hs-gate:${fp}`));
	return `${fp}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** 验证解锁值（fp 一致性由 HMAC 消息绑定隐式保证；改密码后旧值立即失效） */
export async function verifyUnlockValue(
	value: string | undefined,
	passwordHash: string
): Promise<boolean> {
	if (!value) return false;
	const dot = value.indexOf('.');
	if (dot === -1) return false;
	const fp = value.slice(0, dot);
	const sig = value.slice(dot + 1);
	try {
		const key = await crypto.subtle.importKey(
			'raw',
			te.encode(passwordHash),
			HMAC_SHA256_KEYGEN,
			false,
			['sign']
		);
		const expected = await crypto.subtle.sign('HMAC', key, te.encode(`hs-gate:${fp}`));
		return timingSafeEqual(sig, b64urlEncode(new Uint8Array(expected)));
	} catch {
		return false;
	}
}

/** 三源凭证择一：cookie ?? x-hs-gate 头 ?? ?hs_gate= query（cookie 优先）。
 *  纯函数零查询；返回值与 cookie 值同构，直接交给 verifyUnlockValue 验签 */
export function pickGateCredential(
	cookieValue: string | undefined,
	headerValue: string | null,
	queryValue: string | null
): string | undefined {
	return cookieValue ?? headerValue ?? queryValue ?? undefined;
}

/** 组合判定：门未启用 → true（放行）；启用则验证凭证（三源择一后）对当前密码是否有效 */
export async function isSiteUnlocked(
	db: D1Database,
	cookieValue: string | undefined,
	defaultPassword?: string
): Promise<boolean> {
	const state = await getGateState(db, defaultPassword);
	if (!state.hash) return true;
	return verifyUnlockValue(cookieValue, state.hash);
}
