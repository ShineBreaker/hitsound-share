#!/usr/bin/env node
// 从 .svelte-kit/cloudflare 抽取纯静态产物 → build-static/（Tauri frontendDist 消费，见 docs/desktop.md）。
// 不引入 adapter-static：唯一页面 / 已 prerender，预渲染 shell + _app + osucad 静态资产本就在
// Pages 产物里，抽取方案零构建配置改动、Pages 部署零影响、单一产物源（前置跑 pnpm build）。
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(ROOT, '.svelte-kit', 'cloudflare');
const DEST = path.join(ROOT, 'build-static');

const fail = (msg) => {
	console.error(`build-static: ${msg}`);
	process.exit(1);
};

if (!existsSync(path.join(SRC, 'index.html')))
	fail(`缺少 ${path.join(SRC, 'index.html')}——先跑 pnpm build（just build-static 已含）`);

// 排除 Pages 专用文件与 adapter 中间目录（output/、cloudflare-tmp/ 在当前 adapter 版本
// 落在 .svelte-kit/ 下而非产物内，此处按名字防御——不同版本布局可能不同，存在即排除）
const EXCLUDE = new Set(['_worker.js', '_routes.json', '_headers', 'output', 'cloudflare-tmp']);

rmSync(DEST, { recursive: true, force: true });
cpSync(SRC, DEST, { recursive: true, filter: (p) => !EXCLUDE.has(path.basename(p)) });

// CSP 放宽后处理——仅 index.html（404.html 是 9 字节纯文本 "Not Found"，无 meta，只拷贝不改）。
// 静态版 API base 可配（跨源 Web / Tauri，见 src/lib/api-base.svelte.ts），同源 CSP 挡住跨域请求。
// 替换用精确字符串匹配，miss 即败（沿用 vite.config.ts unrar-csp-fix 风格）：
// svelte.config.js 的 directives 或产物形态变化会让匹配 miss 并使构建直接失败——届时同步更新替换串。
const META_MARK = '<meta http-equiv="content-security-policy" content="';
const CSP_FIXES = [
	// API 域 + R2 预签名域 + 预签名回退代理：scheme-source 覆盖任意具体域，无需枚举
	["connect-src 'self' https://*.r2.cloudflarestorage.com", "connect-src 'self' https: blob:"],
	// 跨源下 Audio.src 是 API 域 https URL；data: 留余量
	["media-src 'self' blob:", "media-src 'self' blob: https: data:"],
	// 追加 img-src（头像展示余地）；script-src 的水合 hash 段原样保留，不动
	["object-src 'none'", "object-src 'none'; img-src 'self' https: data:"]
];
const indexPath = path.join(DEST, 'index.html');
let html = readFileSync(indexPath, 'utf8');
if (!html.includes(META_MARK)) fail('index.html 无 CSP meta（产物布局已变化？），放弃放宽');
for (const [orig, fixed] of CSP_FIXES) {
	if (!html.includes(orig)) fail(`CSP 替换片段未命中（svelte.config.js CSP 已变化？）：${orig}`);
	html = html.replace(orig, () => fixed);
}
writeFileSync(indexPath, html);

// 拷贝清单（顶层条目，目录计内部文件数）与体积摘要
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
	const p = path.join(dir, e.name);
	return e.isDirectory() ? walk(p) : [p];
});
const countFiles = (dir) => walk(dir).length;
const totalBytes = walk(DEST).reduce((n, f) => n + statSync(f).size, 0);
const entries = readdirSync(DEST, { withFileTypes: true })
	.map((e) => path.join(DEST, e.name))
	.sort();
console.log(`build-static/（${countFiles(DEST)} 个文件，${(totalBytes / 1024 / 1024).toFixed(1)} MiB）：`);
for (const p of entries) {
	const rel = path.relative(DEST, p);
	const line = statSync(p).isDirectory() ? `${rel}/（${countFiles(p)} 个文件）` : rel;
	console.log(`  ${line}${rel === 'index.html' ? '（CSP 已放宽）' : ''}`);
}
console.log(`  已排除：${[...EXCLUDE].join('、')}`);
