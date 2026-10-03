#!/usr/bin/env node
// 前后端分离跨域冒烟（vite dev :5173 × wrangler pages dev :8799）：
//   开发期真实形态——前端走 vite dev server（非构建产物），localStorage 预置连接配置
//   （hs_api_base / hs_gate_token，键名见 src/lib/api-base.svelte.ts），后端由本脚本
//   全程托管（仓库外临时目录断 .env 搜索链，姿势同 justfile pages-dev recipe）。
// 与 scripts/smoke-cross-origin.mjs（静态产物 :8798）互补：那条覆盖静态 CSP 通道，
// 本条覆盖 dev 工作流 + Web 同源回归（:8799 直连）+ 静态构建通道抽查。
//
// 流程：mktemp 工作目录 → 起后端（假密钥 + CORS_ORIGINS 白名单）→ 播种 schema +
//   门密码 settings 行（sha256(SALT+密码)，SALT 复刻自 site-gate.ts）+ 包/文件行 +
//   R2 对象 → SELECT COUNT 验证（d1 execute 假失败坑）→ node 侧 HTTP 断言（预检/
//   401/解锁/树/波形）→ 起 vite dev :5173 + headless Chromium CDP → localStorage 预置
//   → 遮罩→解锁→树渲染（截图 /tmp）→ :8799 同源回归（SiteGate 表单解锁→树渲染）
//   → 静态产物伺服（原样 :8797 shell 可加载 + CSP 本地适配副本 :8798 树渲染）。
//
// 已知姿势（AGENTS 坑位）：
//  - vite dev 输出与生产相同的 CSP（实测 header connect-src 'self' …），不含本地
//    http://localhost:8799 → 用 CDP Page.setBypassCSP 绕过（无侵入；生产 CSP 语义
//    由静态通道冒烟 smoke-cross-origin 覆盖，本条焦点是跨域链路本身）；
//  - headless 下 showSaveFilePicker 永不 resolve → 不测下载落盘，注入脚本置 undefined；
//  - /api/tree 响应带 60s 私有缓存 → 页面内探针 fetch 一律 cache:'reload'。
//
// 用法：node scripts/smoke-split.mjs [--keep-servers]
//   --keep-servers：跑完不杀进程不清理，打印端口 / 状态目录供人工调试。
// 前置：just build build-static（后端伺服 .svelte-kit/cloudflare，静态通道抽查 build-static）。
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEP = process.argv.includes('--keep-servers');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
const VITE = path.join(ROOT, 'node_modules', '.bin', 'vite');
const API_PORT = 8799; // 后端（wrangler pages dev）
const FRONT_PORT = 5173; // 前端（vite dev，ask 指定端口）
const STATIC_RAW_PORT = 8797; // 静态原样产物（仅验证可加载；CSP 按设计拦本地 http API）
const STATIC_ADAPTED_PORT = 8798; // 静态 CSP 本地适配副本（justfile serve-static 同端口位）
const DBG = 9446; // chromium CDP（避开 osucad 9444 / cross-origin 9445）
const API = `http://localhost:${API_PORT}`;
const FRONT = `http://localhost:${FRONT_PORT}/`;
const FRONT_ORIGIN = `http://localhost:${FRONT_PORT}`;
const ADAPTED_ORIGIN = `http://127.0.0.1:${STATIC_ADAPTED_PORT}`; // 127.0.0.1 × localhost = 真实跨站
const PASSWORD = 'smoke-split-pass-1';
// 站点门密码 hash 盐，复刻自 src/lib/server/site-gate.ts 的 SALT（改动须同步）
const GATE_SALT = 'hitsound-share/site-gate/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => console.log(`✓ ${msg}`);

// ── 验收清单结果收集（对应 ask 的 7 项，末尾打印 JSON 摘录）────────────────
const checks = [];
function check(name, ok, detail) {
	checks.push({ name, ok, detail });
	console.log(`${ok ? '✓' : '✗'} [${name}] ${detail}`);
	if (!ok) fail(`验收项未通过：${name}`);
}

// ── 种子 WAV（0.5s / 8kHz / mono / 16bit，与 blobs/files 行对齐；哈希须真实）──
function seedWav() {
	const sr = 8000;
	const n = Math.floor(sr * 0.5);
	const data = new Uint8Array(44 + n * 2);
	const v = new DataView(data.buffer);
	const s = (o, str) => str.split('').forEach((c, i) => (data[o + i] = c.charCodeAt(0)));
	s(0, 'RIFF');
	v.setUint32(4, 36 + n * 2, true);
	s(8, 'WAVEfmt ');
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, 1, true);
	v.setUint32(24, sr, true);
	v.setUint32(28, sr * 2, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	s(36, 'data');
	v.setUint32(40, n * 2, true);
	for (let i = 0; i < n; i++)
		v.setInt16(44 + i * 2, Math.sin((2 * Math.PI * 440 * i) / sr) * 32767, true);
	return data;
}
const wavBytes = seedWav();
const HASH = createHash('sha256').update(wavBytes).digest('hex');
const pwHashHex = createHash('sha256').update(GATE_SALT + PASSWORD).digest('hex');

// ── 子进程管理（detached 进程组，收尾整组杀——wrangler 的 workerd 是孙进程）──
const TMP = mkdtempSync(path.join(tmpdir(), 'hs-smoke-split-'));
const STATE = path.join(TMP, 'state');
const kids = []; // { name, proc, logPath, exited }
// 起服务前排除端口残留（上一轮 --keep-servers 的进程会让探活命中别人、断言全打错服务）
async function assertPortFree(url, desc) {
	try {
		await fetch(url, { signal: AbortSignal.timeout(1500) });
		fail(`${desc} 端口已被占用（上一轮 --keep-servers 的残留？）：${url}`);
	} catch {
		/* 连接失败 = 空闲 */
	}
}
function launch(name, cmd, args, cwd = TMP) {
	const logPath = path.join(TMP, `${name}.log`);
	const log = openSync(logPath, 'a');
	const proc = spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', log, log] });
	const kid = { name, proc, logPath, exited: false };
	proc.on('error', (e) => fail(`${name} 启动失败：${e.message}`));
	proc.on('exit', () => (kid.exited = true));
	kids.push(kid);
	return proc;
}
function tailLog(name, lines = 25) {
	const k = kids.find((x) => x.name === name);
	if (!k || !existsSync(k.logPath)) return '';
	return readFileSync(k.logPath, 'utf8').split('\n').slice(-lines).join('\n');
}
let cleaned = false;
function cleanup() {
	if (cleaned || KEEP) return;
	cleaned = true;
	for (const { proc } of kids) {
		try {
			process.kill(-proc.pid, 'SIGTERM');
		} catch {
			/* 已退出 */
		}
	}
	try {
		rmSync(TMP, { recursive: true, force: true });
	} catch {
		/* state 仍被进程占用时留给 /tmp 系统清理 */
	}
}
process.on('exit', cleanup);
function fail(msg) {
	console.error(`smoke-split: ${msg}`);
	if (KEEP) console.error(`（--keep-servers：日志与状态在 ${TMP}）`);
	for (const { name } of kids) {
		const t = tailLog(name);
		if (t) console.error(`── ${name}.log 尾部 ──\n${t}`);
	}
	if (checks.length) console.error(`已完成验收项：${JSON.stringify(checks, null, 2)}`);
	process.exit(1);
}

// 一次性子进程（播种用）：收 stdout，非零退出即败
function run(cmd, args) {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		p.stdout.on('data', (d) => (out += d));
		p.stderr.on('data', (d) => (err += d));
		p.on('error', reject);
		p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args[1]} 退出码 ${code}\n${err.slice(-800)}`))));
	});
}

async function waitUrl(url, timeoutMs, desc, kidName) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const kid = kids.find((k) => k.name === kidName);
		if (kid?.exited) fail(`${kidName} 进程已退出（日志尾部见下）`);
		try {
			const r = await fetch(url, { redirect: 'manual' });
			if (r.status < 500) return r;
		} catch {
			/* 未就绪 */
		}
		await sleep(500);
	}
	fail(`${desc} 未就绪（${timeoutMs / 1000}s）${kidName ? `\n${tailLog(kidName, 40)}` : ''}`);
}

// ── 前置检查（构建产物由外部命令生成：just build build-static）────────────
if (!existsSync(path.join(ROOT, '.svelte-kit', 'cloudflare', 'index.html')))
	fail('缺少 .svelte-kit/cloudflare/index.html——先跑 just build（just build-static 已含）');
if (!existsSync(path.join(ROOT, 'build-static', 'index.html')))
	fail('缺少 build-static/index.html——先跑 just build-static（静态通道抽查的前置）');
if (!existsSync(VITE)) fail('缺少 node_modules/.bin/vite——先 pnpm install');

// ── 1. 起后端（cwd 仓库外断 .env 搜索链；wrangler.toml 副本提供 bindings）──
await assertPortFree(`${API}/`, '后端 8799');
cpSync(path.join(ROOT, 'wrangler.toml'), path.join(TMP, 'wrangler.toml'));
launch('backend', WRANGLER, [
	'pages', 'dev', path.join(ROOT, '.svelte-kit', 'cloudflare'),
	'--port', String(API_PORT),
	'--persist-to', STATE,
	// 假密钥姿势照抄 justfile pages-dev recipe（7 项全集）
	'-b', 'OSU_CLIENT_ID=dev', '-b', 'OSU_CLIENT_SECRET=dev',
	'-b', 'SESSION_SECRET=dev-secret-0123456789abcdef01234567',
	'-b', 'ADMIN_OSU_ID=1',
	'-b', 'R2_ACCOUNT_ID=dev', '-b', 'R2_ACCESS_KEY_ID=dev', '-b', 'R2_SECRET_ACCESS_KEY=dev',
	// 跨源白名单：vite dev 前端 + 静态 CSP 适配副本（127.0.0.1 与后端 localhost 跨站）
	'-b', `CORS_ORIGINS=${FRONT_ORIGIN},${ADAPTED_ORIGIN}`
	// 门密码不走环境变量：播种 settings 行（D1 记录优先级高于 SITE_DEFAULT_PASSWORD）
]);
await waitUrl(`${API}/`, 90_000, 'wrangler pages dev 后端', 'backend');
step(`后端 :${API_PORT} 就绪（CORS_ORIGINS=${FRONT_ORIGIN},${ADAPTED_ORIGIN}）`);

// ── 2. 播种 D1 + R2（门密码 settings 行 + 包/文件行 + R2 对象）──────────────
const wavPath = path.join(TMP, 'smoke.wav');
writeFileSync(wavPath, wavBytes);
const d1 = ['d1', 'execute', 'hitsound-share-db', '--local', '--persist-to', STATE];
await run(WRANGLER, [...d1, '--file', path.join(ROOT, 'schema.sql')]);
const fixture = `INSERT INTO settings (key, value) VALUES ('site_password_hash', '${pwHashHex}');
INSERT INTO packages (id, name, uploader_osu_id, size_bytes, logical_size, file_count, status, append_to)
  VALUES ('smoke-pkg-1', '冒烟包', NULL, 0, ${wavBytes.length}, 1, 'visible', NULL);
INSERT INTO blobs (hash, size, mime, refcount) VALUES ('${HASH}', ${wavBytes.length}, 'audio/wav', 1);
INSERT INTO files (id, package_id, folder_path, name, format, duration_s, sample_rate, bit_depth, channels, size_bytes, peaks, blob_hash, owner_osu_id)
  VALUES ('smoke-file-1', 'smoke-pkg-1', '', 'smoke.wav', 'wav', 0.5, 8000, 16, 1, ${wavBytes.length}, '[0.1,0.5,0.9,0.5]', '${HASH}', NULL);
`;
const fixturePath = path.join(TMP, 'fixture.sql');
writeFileSync(fixturePath, fixture);
await run(WRANGLER, [...d1, '--file', fixturePath]);
// key 与 blobKey() 组装形态一致：blobs/<hash前2>/<sha256>.<ext>
await run(WRANGLER, [
	'r2', 'object', 'put', `hitsound-files/blobs/${HASH.slice(0, 2)}/${HASH}.wav`,
	'--file', wavPath, '--local', '--persist-to', STATE
]);
// AGENTS 已知坑：d1 execute 可能假失败（报错但实际写入）——SELECT COUNT 硬验证
const selOut = await run(WRANGLER, [...d1, '--command',
	'SELECT (SELECT COUNT(*) FROM files) AS f, (SELECT COUNT(*) FROM settings) AS s', '--json']);
const row = JSON.parse(selOut.slice(selOut.indexOf('['), selOut.lastIndexOf(']') + 1))[0].results[0];
if (Number(row.f) !== 1 || Number(row.s) !== 1)
	fail(`播种验证失败（files=${row.f} settings=${row.s}，均应为 1）——d1 execute 假失败？`);
step(`播种完成：settings 门密码行 + packages/blobs/files 各 1 行 + R2 对象（hash=${HASH.slice(0, 12)}…）`);

// ── 3. node 侧 HTTP 断言（服务端半边，逐项映射验收清单）───────────────────
// 验收 1：OPTIONS 预检（自定义头 x-hs-gate + Content-Type）
const opt = await fetch(`${API}/api/tree`, {
	method: 'OPTIONS',
	headers: {
		Origin: FRONT_ORIGIN,
		'Access-Control-Request-Method': 'GET',
		'Access-Control-Request-Headers': 'content-type,x-hs-gate'
	}
});
{
	const acao = opt.headers.get('access-control-allow-origin');
	const acac = opt.headers.get('access-control-allow-credentials');
	const acah = (opt.headers.get('access-control-allow-headers') ?? '').toLowerCase();
	const ok = opt.status >= 200 && opt.status < 300
		&& acao === FRONT_ORIGIN && acac === 'true'
		&& acah.includes('content-type') && acah.includes('x-hs-gate');
	check('1-OPTIONS 预检', ok,
		`OPTIONS /api/tree → ${opt.status}；allow-origin=${acao} allow-credentials=${acac} allow-headers=${acah}`);
}
// 验收 2：未解锁（无凭证）跨域 GET /api/tree → 401 site_locked
const locked = await fetch(`${API}/api/tree`, { headers: { Origin: FRONT_ORIGIN } });
{
	const body = await locked.json().catch(() => ({}));
	const acao = locked.headers.get('access-control-allow-origin');
	const ok = locked.status === 401 && body.error === 'site_locked' && acao === FRONT_ORIGIN;
	check('2-未解锁 401 site_locked', ok,
		`GET /api/tree（Origin=${FRONT_ORIGIN}，无凭证）→ ${locked.status} ${body.error}；allow-origin=${acao}（门拒绝分支也带 CORS 头，跨域可读）`);
}
// 解锁拿 token：POST /api/site-gate（正确密码）
const unlock = await fetch(`${API}/api/site-gate`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json', Origin: FRONT_ORIGIN },
	body: JSON.stringify({ password: PASSWORD })
});
const unlockBody = await unlock.json().catch(() => ({}));
const TOKEN = unlockBody.token ?? '';
if (unlock.status !== 200 || !unlockBody.ok || !TOKEN.includes('.'))
	fail(`解锁失败：${unlock.status} ${JSON.stringify(unlockBody)}`);
step(`POST /api/site-gate → 200，签发 token（${TOKEN.slice(0, 8)}…）`);
// 验收 3：带凭证 GET /api/tree → 200 且 CORS 头允许前端 origin
const tree = await fetch(`${API}/api/tree`, {
	headers: { Origin: FRONT_ORIGIN, 'x-hs-gate': TOKEN }
});
{
	const text = await tree.text();
	const acao = tree.headers.get('access-control-allow-origin');
	const acac = tree.headers.get('access-control-allow-credentials');
	const ok = tree.status === 200 && acao === FRONT_ORIGIN && acac === 'true' && text.includes('冒烟包');
	check('3-解锁后 200 + CORS', ok,
		`GET /api/tree（x-hs-gate）→ ${tree.status}；allow-origin=${acao} allow-credentials=${acac}；body 含「冒烟包」=${text.includes('冒烟包')}`);
}
// 验收 7：/api/waveform 带凭证 → 200
{
	const wf = await fetch(`${API}/api/waveform?ids=smoke-file-1`, {
		headers: { Origin: FRONT_ORIGIN, 'x-hs-gate': TOKEN }
	});
	const body = await wf.json().catch(() => ({}));
	const peaks = body?.peaks?.['smoke-file-1'];
	const ok = wf.status === 200 && Array.isArray(peaks) && peaks.length === 4;
	check('7-/api/waveform 带凭证 200', ok,
		`GET /api/waveform?ids=smoke-file-1（x-hs-gate）→ ${wf.status}；peaks=${JSON.stringify(peaks)}`);
}

// ── 4. vite dev 前端 + headless Chromium CDP（浏览器半边）──────────────────
await assertPortFree(FRONT, 'vite dev 5173');
launch('vite', VITE, ['dev', '--port', String(FRONT_PORT), '--strictPort'], ROOT);
await waitUrl(FRONT, 60_000, 'vite dev 前端', 'vite');
step(`vite dev :${FRONT_PORT} 就绪`);

await assertPortFree(`http://localhost:${DBG}/json/list`, 'chromium CDP 9446');
launch('chromium', 'chromium', [
	'--headless=new', `--remote-debugging-port=${DBG}`,
	'--no-sandbox', '--mute-audio', '--window-size=1280,900', 'about:blank'
]);
const list = JSON.parse(await (await waitUrl(`http://localhost:${DBG}/json/list`, 20_000, 'chromium CDP')).text());
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r, rej) => {
	ws.onopen = r;
	ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
});
let id = 0;
const pending = new Map();
const consoleLogs = [];
const netLog = []; // Network.responseReceived → { url, status }
ws.onmessage = (e) => {
	const m = JSON.parse(e.data);
	if (m.id && pending.has(m.id)) {
		pending.get(m.id)(m);
		pending.delete(m.id);
	}
	if (m.method === 'Network.responseReceived')
		netLog.push({ url: m.params.response.url, status: m.params.response.status });
	if (m.method === 'Runtime.consoleAPICalled')
		consoleLogs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
};
const send = (method, params = {}) =>
	new Promise((res) => {
		const i = ++id;
		pending.set(i, res);
		ws.send(JSON.stringify({ id: i, method, params }));
	});
const evalJs = async (expr) => {
	const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
	if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
	return r.result?.result?.value;
};
async function waitFor(expr, timeout = 10_000, desc = expr) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		try {
			if (await evalJs(expr)) return;
		} catch {
			/* 导航中上下文销毁，按未就绪继续轮询 */
		}
		await sleep(300);
	}
	fail(`页面断言超时：${desc}`);
}
async function waitNet(pred, timeout = 15_000, desc, from = 0) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const hit = netLog.slice(from).find(pred);
		if (hit) return hit;
		await sleep(300);
	}
	fail(
		`网络断言超时：${desc}\n已捕获请求（尾部）:\n${netLog.slice(-15).map((x) => `${x.status} ${x.url}`).join('\n')}`
	);
}
// Svelte bind:value 走 input 事件
const setInput = (sel, value) =>
	evalJs(`(() => {
		const el = document.querySelector(${JSON.stringify(sel)});
		el.value = ${JSON.stringify(value)};
		el.dispatchEvent(new Event('input', { bubbles: true }));
		return true;
	})()`);
const click = (expr) => evalJs(`${expr}; true`);
async function screenshot(file) {
	const r = await send('Page.captureScreenshot', { format: 'png' });
	writeFileSync(file, Buffer.from(r.result.data, 'base64'));
}

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
// vite dev 输出与生产同款 CSP（实测 header connect-src 'self' https://*.r2.…），
// 不含本地 http://localhost:8799 → CDP 绕过（生产 CSP 语义由静态通道冒烟覆盖）
await send('Page.setBypassCSP', { enabled: true });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
	// headless 下 showSaveFilePicker 永不 resolve（AGENTS 已知坑）：置 undefined（本条不测下载落盘）
	try { window.showSaveFilePicker = undefined; } catch {}
	window.__errs = [];
	window.addEventListener("error", e => window.__errs.push(String(e.error?.stack || e.message)));
	window.addEventListener("unhandledrejection", e => window.__errs.push(String(e.reason)));
	try { localStorage.setItem("hs_tour_v1", "1"); } catch {} // 关新手引导
` });

// ── 验收 4：localStorage 预置连接配置 → vite dev 页面真实渲染树 ────────────
await send('Page.navigate', { url: FRONT });
await waitFor(`!!document.querySelector('.gear-btn')`, 30_000, 'vite dev 首屏渲染（顶栏齿轮）');
// 预置 base（键名 hs_api_base，读自 src/lib/api-base.svelte.ts）→ reload 生效
await evalJs(`localStorage.setItem('hs_api_base', '${API}'); location.reload(); true`);
await waitFor(`!!document.querySelector('.gate-mask')`, 20_000, '跨源 config 拉取后站点门遮罩出现');
await waitNet((e) => e.url.startsWith(`${API}/api/config`) && e.status === 200, 10_000, '跨源 /api/config');
// 浏览器内真跨域 401 可读性（CORS 头缺失时浏览器吞成 TypeError）——验收 2 的浏览器半边
{
	const probe = await evalJs(`(async () => {
		try {
			const r = await fetch('${API}/api/tree', { cache: 'reload' });
			let error = null;
			try { error = (await r.json()).error; } catch {}
			return { ok: true, status: r.status, error };
		} catch (e) { return { ok: false, err: String(e) }; }
	})()`);
	const ok = probe?.ok && probe.status === 401 && probe.error === 'site_locked';
	if (!ok) check('2-未解锁 401 site_locked', false, `浏览器内跨域 fetch：${JSON.stringify(probe)}`);
	else console.log(`✓ [2-未解锁 401 site_locked] 浏览器内跨域 fetch → ${probe.status} ${probe.error}（可读，非 TypeError）`);
}
// 预置 token（hs_gate_token）→ reload → 解锁渲染树（netMark 紧跟 reload 触发取值：
// /api/tree 是 reload 水合后才发的，必落在 mark 之后）
await evalJs(`localStorage.setItem('hs_gate_token', ${JSON.stringify(TOKEN)}); location.reload(); true`);
const netMark = netLog.length;
await waitFor(`[...document.querySelectorAll('.tree .label')].some(el => el.textContent.includes('冒烟包'))`, 20_000, '树中出现播种包「冒烟包」');
await waitFor(`[...document.querySelectorAll('.fname')].some(el => el.textContent.includes('smoke.wav'))`, 15_000, '文件表渲染播种文件');
await waitNet((e) => e.url.startsWith(`${API}/api/tree`) && e.status === 200, 10_000, '跨源 /api/tree 200（x-hs-gate 过门）', netMark);
const shot5173 = '/tmp/hitsound-smoke-split-5173.png';
await screenshot(shot5173);
check('4-vite dev 页面渲染树', true,
	`:5173 加载 + localStorage 预置（hs_api_base/hs_gate_token）→ 树渲染「冒烟包」+ 文件表 smoke.wav；netLog 跨源 /api/tree=200；截图 ${shot5173}`);

// ── 验收 5：Web 同源回归（直接访问 :8799，同源模式不回归）──────────────────
await send('Page.navigate', { url: `${API}/` });
await waitFor(`!!document.querySelector('.gate-mask')`, 20_000, '同源首页：站点门遮罩出现（同源 /api/config locked）');
await setInput('.gate-card input[type=password]', PASSWORD);
// mark 在 click 前取：解锁 POST → onunlock = location.reload()（+layout.svelte:208）→
// cookie 轨重载数据，reload 后的 /api/tree 必落在 mark 之后（排除 C 阶段同 URL 历史）
const mark8799 = netLog.length;
await click(`document.querySelector('.gate-card .btn.primary').click()`);
await waitFor(`[...document.querySelectorAll('.tree .label')].some(el => el.textContent.includes('冒烟包'))`, 20_000, '同源解锁后树渲染「冒烟包」');
await waitNet((e) => e.url.startsWith(`${API}/api/tree`) && e.status === 200, 10_000, '同源 /api/tree 200（cookie 过门）', mark8799);
const token8799 = await evalJs(`localStorage.getItem('hs_api_base') ?? ''`);
if (token8799) fail(`:8799 origin 下 localStorage 不应有 hs_api_base（跨源配置串扰？）：${token8799}`);
const shot8799 = '/tmp/hitsound-smoke-split-8799.png';
await screenshot(shot8799);
check('5-Web 同源回归(:8799)', true,
	`直连 :8799 首页 → 同源 config locked → SiteGate 表单输密码解锁 → 树渲染「冒烟包」（cookie 轨，无 localStorage base）；截图 ${shot8799}`);

// ── 验收 6：静态构建通道（build-static 产物静态伺服可加载）─────────────────
// 原样产物（:8797）：CSP 按生产口径拦本地 http API（设计使然），只断言 shell 可加载、
// 水合无致命异常；跨源数据链路由 CSP 本地适配副本（:8798，替换串同 smoke-cross-origin）证明
const RAW = path.join(ROOT, 'build-static');
await assertPortFree(`http://127.0.0.1:${STATIC_RAW_PORT}/`, '静态原样 8797');
launch('static-raw', 'python3', [
	'-m', 'http.server', String(STATIC_RAW_PORT), '--bind', '127.0.0.1', '--directory', RAW
]);
await waitUrl(`http://127.0.0.1:${STATIC_RAW_PORT}/`, 15_000, '静态原样伺服', 'static-raw');

const FRONT_DIR = path.join(TMP, 'front-static');
cpSync(RAW, FRONT_DIR, { recursive: true });
const indexPath = path.join(FRONT_DIR, 'index.html');
let html = readFileSync(indexPath, 'utf8');
for (const [orig, fixed] of [
	["connect-src 'self' https: blob:", `connect-src 'self' https: ${API} blob:`],
	["media-src 'self' blob: https: data:", `media-src 'self' blob: https: data: ${API}`]
]) {
	if (!html.includes(orig)) fail(`静态副本 CSP 替换未命中（产物布局变化？）：${orig}`);
	html = html.replace(orig, () => fixed);
}
writeFileSync(indexPath, html);
await assertPortFree(`http://127.0.0.1:${STATIC_ADAPTED_PORT}/`, '静态适配副本 8798');
launch('static-adapted', 'python3', [
	'-m', 'http.server', String(STATIC_ADAPTED_PORT), '--bind', '127.0.0.1',
	'--directory', FRONT_DIR
]);
await waitUrl(`http://127.0.0.1:${STATIC_ADAPTED_PORT}/`, 15_000, '静态适配副本伺服', 'static-adapted');
step('静态伺服就绪：原样 :8797 + CSP 本地适配副本 :8798');

// 原样产物：shell 可加载（静态 DOM + 水合无 uncaught；数据请求被生产 CSP 拦属预期）
await send('Page.navigate', { url: `http://127.0.0.1:${STATIC_RAW_PORT}/` });
await waitFor(`!!document.querySelector('.gear-btn')`, 20_000, '原样产物 shell 加载（顶栏齿轮）');
const rawErrs = (await evalJs(`window.__errs ?? []`)) ?? [];
if (rawErrs.length) fail(`原样产物页面 uncaught 异常：${JSON.stringify(rawErrs)}`);
step('原样产物（:8797）：shell 加载 + 水合无 uncaught（数据被生产 CSP 拦属设计预期）');

// 适配副本：预置连接配置 → 树渲染（产物跨源数据链路真实可用）
await send('Page.navigate', { url: `http://127.0.0.1:${STATIC_ADAPTED_PORT}/` });
await waitFor(`!!document.querySelector('.gear-btn')`, 20_000, '适配副本 shell 加载');
await evalJs(`localStorage.setItem('hs_api_base', '${API}'); localStorage.setItem('hs_gate_token', ${JSON.stringify(TOKEN)}); location.reload(); true`);
const markAdapted = netLog.length;
await waitFor(`[...document.querySelectorAll('.tree .label')].some(el => el.textContent.includes('冒烟包'))`, 20_000, '适配副本树渲染「冒烟包」');
await waitNet((e) => e.url.startsWith(`${API}/api/tree`) && e.status === 200, 10_000, '副本跨源 /api/tree 200', markAdapted);
const shot8798 = '/tmp/hitsound-smoke-split-8798.png';
await screenshot(shot8798);
check('6-静态构建通道可加载', true,
	`构建命令 just build build-static（= pnpm build + node scripts/build-static.mjs），产物 build-static/；原样产物 :8797 shell 加载 + 水合无 uncaught；CSP 本地适配副本 :8798 树渲染「冒烟包」（跨站 127.0.0.1×localhost）；截图 ${shot8798}`);

ws.close();
console.log('\n── 验收清单 ──');
console.log(JSON.stringify(checks, null, 2));
console.log('SMOKE OK —— 前后端分离跨域冒烟全过');
cleanup();

if (KEEP) {
	console.log(`\n--keep-servers：服务保留中`);
	console.log(`  后端 ${API} ｜ vite dev ${FRONT} ｜ 静态 :${STATIC_RAW_PORT}/:${STATIC_ADAPTED_PORT} ｜ CDP :${DBG}`);
	console.log(`  状态目录 ${STATE} ｜ 日志 ${TMP}`);
}
// 显式退出：KEEP 下子进程（wrangler/vite/chromium）仍在跑，CDP WebSocket 的关闭握手
// 会挂住事件循环使本进程永不退出
process.exit(0);
