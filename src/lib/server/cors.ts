// 跨源 CORS（deep module）：白名单来自环境变量 CORS_ORIGINS（逗号分隔的绝对 origin，
// 如 https://app.example.com,http://tauri.localhost）。未配置 = 空 = 不启用（零行为变化）。
// 只回显白名单内的具体 origin（绝不 *）——credentials 模式下 * 无效且不安全；
// 每个带 CORS 头的响应追加 Vary: Origin，防共享缓存/CDN 按不同 origin 串缓存。
// 白名单每请求解析（与 getSecrets 同语义），不做模块级缓存（isolate 环境变量可热切换）。

const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
// x-hs-session：登录态 header 轨（桌面端 cookie 不可靠），与 x-hs-gate 并存的跨源自定义头
const ALLOW_HEADERS = 'Content-Type, x-hs-gate, x-hs-session';
const MAX_AGE_S = '86400'; // 浏览器缓存预检结果一天，减少预检往返

/** 解析白名单为小写 Set；未配置/全空白返回空 Set（= 不启用 CORS） */
export function parseCorsOrigins(raw: string | undefined): Set<string> {
	if (!raw) return new Set();
	return new Set(
		raw
			.split(',')
			.map((s) => s.trim().toLowerCase())
			.filter((s) => s.length > 0)
	);
}

/** 请求 Origin 是否命中白名单（比较前小写化）；命中返回请求原值供回显，无 Origin/未命中 null */
export function isAllowedOrigin(origins: Set<string>, request: Request): string | null {
	if (origins.size === 0) return null;
	const origin = request.headers.get('origin');
	if (!origin || !origins.has(origin.toLowerCase())) return null;
	return origin;
}

function applyCorsHeaders(headers: Headers, origin: string): void {
	headers.set('Access-Control-Allow-Origin', origin);
	headers.set('Access-Control-Allow-Credentials', 'true');
	headers.append('Vary', 'Origin');
}

/** OPTIONS 预检响应（204 全套头） */
export function preflightResponse(origin: string): Response {
	const headers = new Headers();
	applyCorsHeaders(headers, origin);
	headers.set('Access-Control-Allow-Methods', ALLOW_METHODS);
	headers.set('Access-Control-Allow-Headers', ALLOW_HEADERS);
	headers.set('Access-Control-Max-Age', MAX_AGE_S);
	return new Response(null, { status: 204, headers });
}

/** 给已解析响应注入 CORS 头 + 追加 Vary: Origin（已有 Vary 则 append）。
 *  直接改原响应 headers——hooks 的输入是 resolve()/json() 产物，其 headers 可变。 */
export function withCorsHeaders(res: Response, origin: string): Response {
	applyCorsHeaders(res.headers, origin);
	return res;
}
