import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// 部署到 Cloudflare Pages：API 路由编译为 Pages Functions，R2/D1 走 bindings
		adapter: adapter(),
		// 内容安全策略（安全基线：default-src 'self'）。
		// mode auto：SSR 响应用 nonce，预渲染页用 hash —— SvelteKit 会为水合内联脚本
		// 自动追加 nonce/hash，无需手写 script-src；字体/CSS/API/音频均为同源，走 default-src 兜底。
		// connect-src 额外放行 R2 S3 端点：上传链路浏览器预签名直传（PUT）需要。
		// script-src 显式列出：'self'（模块脚本）+ 'wasm-unsafe-eval'（rar 解包的 UnRAR wasm 实例化）
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				'object-src': ['none'],
				'base-uri': ['self'],
				'script-src': ['self', 'wasm-unsafe-eval'],
				'connect-src': ['self', 'https://*.r2.cloudflarestorage.com']
			}
		}
	}
};

export default config;
