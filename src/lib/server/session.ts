// 无状态 session：HMAC-SHA256 签名 cookie（payload 为 base64url(JSON)），
// 密钥 SESSION_SECRET 只从环境变量读；payload 不含敏感凭证（仅 osu 身份 + 过期时间）。
// 双轨凭证：同源 Web 走 cookie（语义不变），桌面（Tauri）等第三方 cookie 不可靠的环境
// 以 x-hs-session 头携带同一签名值——统一读取入口 readSession（cookie 优先、header 兜底）
export const SESSION_COOKIE = 'hs_session';
export const SESSION_HEADER = 'x-hs-session';
export const SESSION_MAX_AGE_S = 7 * 24 * 3600; // 7 天
/** OAuth 交付码有效期（秒）：回调 302 → 前端立即 POST /api/auth/exchange 交换，60s 足够。
 *  码与会话同构（同 HMAC 同格式）仅时效更短，无严格一次性——短时效窗口即防重放取舍 */
export const EXCHANGE_TTL_S = 60;

const HMAC_SHA256_KEYGEN: Algorithm = { name: 'HMAC', hash: 'SHA-256' };

export interface SessionUser {
	osuId: number;
	username: string;
	avatarUrl: string | null;
	exp: number; // 过期时刻（Unix 秒）
}

const te = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text: string): Uint8Array {
	const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', te.encode(secret), HMAC_SHA256_KEYGEN, false, ['sign']);
}

/** 签发签名值（cookie 值 / x-hs-session 头值 / 交付码同构）：payload.signature。
 *  ttlS 缺省 7 天（会话）；OAuth 交付码传 EXCHANGE_TTL_S */
export async function signSession(
	user: Omit<SessionUser, 'exp'>,
	secret: string,
	ttlS: number = SESSION_MAX_AGE_S
): Promise<string> {
	const payload: SessionUser = { ...user, exp: Math.floor(Date.now() / 1000) + ttlS };
	const body = b64urlEncode(te.encode(JSON.stringify(payload)));
	const key = await hmacKey(secret);
	const sig = await crypto.subtle.sign('HMAC', key, te.encode(body));
	return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** 验签并解出用户；过期/坏签名返回 null */
export async function verifySession(cookieVal: string | undefined, secret: string): Promise<SessionUser | null> {
	if (!cookieVal) return null;
	const dot = cookieVal.lastIndexOf('.');
	if (dot === -1) return null;
	const body = cookieVal.slice(0, dot);
	const sig = cookieVal.slice(dot + 1);
	let expected: Uint8Array;
	try {
		const key = await hmacKey(secret);
		expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, te.encode(body)));
	} catch {
		return null;
	}
	// sig 段畸形（非 base64 字符）时 atob 抛 InvalidCharacterError——凭证值是外部输入
	//（cookie / x-hs-session 头 / 交换码 body），解码异常不得逃逸成 500，按坏签名返回 null
	let given: Uint8Array;
	try {
		given = b64urlDecode(sig);
	} catch {
		return null;
	}
	// 定长比较，避免时序侧信道
	if (given.length !== expected.length) return null;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= given[i] ^ expected[i];
	if (diff !== 0) return null;
	try {
		const user = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as SessionUser;
		if (typeof user.osuId !== 'number' || typeof user.exp !== 'number') return null;
		if (user.exp < Math.floor(Date.now() / 1000)) return null;
		return user;
	} catch {
		return null;
	}
}

/** 双轨凭证择一：cookie ?? x-hs-session 头（cookie 优先，与 site-gate 的 pickGateCredential 同策略）。
 *  cookie 存在（即便无效）时不看 header——同源行为与纯 cookie 时代逐字节一致；
 *  桌面 WebView 无可靠 cookie，header 轨兜底。纯函数零查询 */
export function pickSessionCredential(
	cookieVal: string | undefined,
	headerVal: string | null
): string | undefined {
	return cookieVal ?? headerVal ?? undefined;
}

/** 统一登录态读取入口：双轨凭证择一后验签。散布的 verifySession(cookies.get(...))
 *  调用一律收敛到此（guard / config / me），callback 的 cookie 写入不走这里 */
export async function readSession(
	cookieVal: string | undefined,
	headerVal: string | null,
	secret: string
): Promise<SessionUser | null> {
	return verifySession(pickSessionCredential(cookieVal, headerVal), secret);
}

/** 随机 hex（OAuth state 等） */
export function randomHex(bytes: number): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}
