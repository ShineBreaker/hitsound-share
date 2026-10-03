// API 客户端层：全站唯一知道「服务器地址可配置」的模块（前后端分离的连接状态）。
// base = '' 即同源（Web 版现状：相对路径 + same-origin cookie，行为零回归）；
// base 非空 = 跨源消费（独立域静态部署 / Tauri 桌面）：相对路径拼 base、
// 带 x-hs-gate 门凭证（token，POST /api/site-gate 响应下发）、cookie credentials include。
// 登录态双轨：x-hs-session 头（token，?hs_code= 交换下发，键 hs_session_token）——
// 桌面 WebView 第三方 cookie 不可靠，与 gate token 并存互不干扰。
// 依赖方向硬约束：本模块不 import 任何业务模块（api.ts 反向依赖它），避免环。
export const API_BASE_KEY = 'hs_api_base';
export const GATE_TOKEN_KEY = 'hs_gate_token';
export const SESSION_TOKEN_KEY = 'hs_session_token';

/** localStorage 读取；测试环境（node 无 localStorage）按空处理 */
function readStored(key: string): string {
	try {
		if (typeof localStorage === 'undefined') return '';
		return localStorage.getItem(key) ?? '';
	} catch {
		return '';
	}
}

/** 存储不可用（隐私模式 / node）时仅内存生效，不致命 */
function writeStored(key: string, value: string | null): void {
	try {
		if (typeof localStorage === 'undefined') return;
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		/* 同上 */
	}
}

// $state 整值赋值（代理坑：禁止局部写）；组件消费一律走导出函数
let apiBase = $state(readStored(API_BASE_KEY));
let gateToken = $state<string | null>(readStored(GATE_TOKEN_KEY) || null);
let sessionToken = $state<string | null>(readStored(SESSION_TOKEN_KEY) || null);

/** 当前 API base；'' = 同源（默认，Web 版现状） */
export function getApiBase(): string {
	return apiBase;
}

/** 设置并持久化 base；规范化：trim、去尾部 '/'、必须 http(s) 起头；非法 throw Error('bad_url') */
export function setApiBase(raw: string): void {
	const normalized = raw.trim().replace(/\/+$/, '');
	if (!/^https?:\/\/\S+$/.test(normalized)) throw new Error('bad_url');
	apiBase = normalized;
	writeStored(API_BASE_KEY, normalized);
}

/** 清空 base 与双 token（断开连接；会话 token 属于该连接，一并作废） */
export function clearConnection(): void {
	apiBase = '';
	gateToken = null;
	sessionToken = null;
	writeStored(API_BASE_KEY, null);
	writeStored(GATE_TOKEN_KEY, null);
	writeStored(SESSION_TOKEN_KEY, null);
}

/** 门解锁 token（POST /api/site-gate 响应下发）；无则 null */
export function getGateToken(): string | null {
	return gateToken;
}

export function setGateToken(t: string | null): void {
	gateToken = t;
	writeStored(GATE_TOKEN_KEY, t);
}

/** 登录态 token（?hs_code= 经 POST /api/auth/exchange 换发的会话签名值）；
 *  与 cookie 值同构，服务端经 x-hs-session 头读取（cookie 优先）。无则 null */
export function getSessionToken(): string | null {
	return sessionToken;
}

export function setSessionToken(t: string | null): void {
	sessionToken = t;
	writeStored(SESSION_TOKEN_KEY, t);
}

/** Tauri WebView 检测（纯检测，不做任何网络请求） */
export function isDesktopApp(): boolean {
	return '__TAURI_INTERNALS__' in globalThis || '__TAURI__' in globalThis;
}

/** 桌面首启引导：Tauri 环境且尚未配置 API base（自定义协议源下没有同源后端，必须先走连接设置） */
export function needsDesktopSetup(): boolean {
	return isDesktopApp() && !getApiBase();
}

/**
 * 统一 fetch 出口。语义按输入分派：
 *  - 绝对 http(s) URL（R2 预签名 PUT/GET）→ 原样 fetch，不加 header、不加 credentials
 *    （预签名 URL 只签了既定 headers，附加自定义头会导致签名失配 + 预检失败）；
 *  - 相对路径（/api/*、/f/*）→ getApiBase() 拼接（base 空则原样）；
 *    有 gate token 时注入 'x-hs-gate'、有会话 token 时注入 'x-hs-session'（并存）；
 *    credentials = base ? 'include' : 'same-origin'
 *    （base 空时 'same-origin' 与 fetch 默认一致，同源行为零变化）。
 * init 透传（含 cache:'reload' 等既有语义）。
 */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
	if (/^https?:\/\//i.test(input)) return fetch(input, init);
	const base = getApiBase();
	const url = base + input;
	const credentials: RequestCredentials = base ? 'include' : 'same-origin';
	const gate = getGateToken();
	const session = getSessionToken();
	if (gate || session) {
		const headers = new Headers(init?.headers);
		if (gate) headers.set('x-hs-gate', gate);
		if (session) headers.set('x-hs-session', session);
		return fetch(url, { ...init, headers, credentials });
	}
	return fetch(url, { ...init, credentials });
}

/**
 * 构造带门凭证的完整 URL（给 Audio.src / 整页导航用——无法带 header 的场合）：
 * base + path；有 token 且 path 以 '/f/' 前缀（音频流/单文件下载，或显式
 * withGate=true）时追加 ?hs_gate=<token>；withGate=false 显式关闭。
 */
export function absoluteApiUrl(path: string, withGate?: boolean): string {
	const url = getApiBase() + path;
	const token = getGateToken();
	if (token && (withGate === true || (withGate !== false && path.startsWith('/f/')))) {
		return `${url}?hs_gate=${encodeURIComponent(token)}`;
	}
	return url;
}

/**
 * 服务端下发 URL 的消费出口（整包下载清单 urls 值），三支分派：
 *  ① 相对路径（'/api/blob/…'，旧后端下发形态）→ 转 apiFetch；
 *  ② 绝对 URL 且 origin === API base（新后端下发的 /api/blob 绝对回退 URL，受站点门
 *     保护）→ 剥掉 base 转相对路径后走 apiFetch（必须带 x-hs-gate + credentials，
 *     裸 fetch 会被 hooks 401）；
 *  ③ 其余绝对 URL（R2 预签名域，自带凭证）→ 裸 fetch。
 */
export async function fetchIssuedUrl(url: string, init?: RequestInit): Promise<Response> {
	if (!/^https?:\/\//i.test(url)) return apiFetch(url, init);
	const base = getApiBase();
	const apiOrigin = base
		? new URL(base).origin
		: typeof location === 'undefined'
			? ''
			: location.origin;
	const u = new URL(url);
	if (apiOrigin && u.origin === apiOrigin) return apiFetch(u.pathname + u.search, init);
	return fetch(url, init);
}

/**
 * 登录入口 URL（两处整页导航共用）：base + '/api/auth/login' + query 参数
 * （gate token 存在时 hs_gate；base 非空时 hs_origin=<location.origin>，供 OAuth
 * state 编码前端来源）。MUST 用 URLSearchParams 组装——无 gate token 时
 * （未解锁的跨源用户点登录是真实组合）手拼 '&' 会产出 '/api/auth/login&hs_origin=…'
 * 坏 URL，query 轨失效退化到 Origin 头。
 */
export function loginUrl(): string {
	const params = new URLSearchParams();
	const token = getGateToken();
	if (token) params.set('hs_gate', token);
	if (getApiBase()) params.set('hs_origin', location.origin);
	const q = params.toString();
	return `${getApiBase()}/api/auth/login${q ? `?${q}` : ''}`;
}
