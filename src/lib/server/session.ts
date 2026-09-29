// 无状态 session：HMAC-SHA256 签名 cookie（payload 为 base64url(JSON)），
// 密钥 SESSION_SECRET 只从环境变量读；payload 不含敏感凭证（仅 osu 身份 + 过期时间）
export const SESSION_COOKIE = 'hs_session';
export const SESSION_MAX_AGE_S = 7 * 24 * 3600; // 7 天

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

/** 签发 cookie 值：payload.signature */
export async function signSession(user: Omit<SessionUser, 'exp'>, secret: string): Promise<string> {
	const payload: SessionUser = { ...user, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S };
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
	const given = b64urlDecode(sig);
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

/** 随机 hex（OAuth state 等） */
export function randomHex(bytes: number): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}
