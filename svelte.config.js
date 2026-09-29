import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// 部署到 Cloudflare Pages：API 路由编译为 Pages Functions，R2/D1 走 bindings
		adapter: adapter()
	}
};

export default config;
