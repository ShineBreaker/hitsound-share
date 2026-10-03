#!/usr/bin/env node
// 跨源端到端冒烟（design.md §9.3）：build-static 静态前端（127.0.0.1:8798，与后端
// localhost 形成真实跨站——site = scheme+eTLD+1，IP 整体是一个 site）×
// wrangler pages dev 后端（localhost:8799）。
// 后端生命周期与数据播种全程由本脚本托管（不依赖外部 justfile recipe——一次性
// mktemp persist 目录只有本进程知道路径，起后端→播种→断言→收尾同进程内状态隔离）：
//   mktemp 工作目录 → 生成种子 WAV（真实 sha256，与 R2 key / D1 行对齐）→ 起后端
//   （假密钥 + SITE_DEFAULT_PASSWORD + CORS_ORIGINS；**不传 R2 三项**——传了则 zip
//   清单走预签名指向不存在的 R2 域，缺省才强制 /api/blob 绝对回退分支，副作用
//   uploadEnabled=false 恰好验证连接齿轮无条件显示）→ 播种 schema + fixture + R2
//   对象 + SELECT COUNT 验证（d1 execute 假失败坑）→ 起静态前端 → CDP 消息级断言
//   （复用 smoke-osucad-preview 骨架）→ 收尾杀全部子进程。
// 用法：node scripts/smoke-cross-origin.mjs [--keep-servers]
//   --keep-servers：跑完不杀进程不清理，打印端口 / 播种 hash / 状态目录供人工调试。
// 前置：just build build-static（just smoke-cross-origin 已含依赖）。
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const KEEP = process.argv.includes('--keep-servers');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
const API_PORT = 8799; // 后端（wrangler pages dev，绑定 localhost）
const FRONT_PORT = 8798; // 静态前端（python http.server，绑定 127.0.0.1 → 与后端跨站）
const DBG = 9445; // chromium CDP 端口（避开 osucad smoke 的 9444）
const API = `http://localhost:${API_PORT}`;
const FRONT = `http://127.0.0.1:${FRONT_PORT}/`;
const PASSWORD = 'smoke-pass-123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => console.log(`✓ ${msg}`);

// ── 种子数据：最小 WAV（0.5s / 8kHz / mono / 16bit，与 fixture 行对齐）──────
// 哈希必须真实：/f/[id] 走 files.blob_hash 组 R2 key（blobs/<hash前2>/<sha256>.wav），
// 哈希与字节不符即 R2 404
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
	v.setUint16(20, 1, true); // PCM
	v.setUint16(22, 1, true); // mono
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

// osz 导入用（组装面板 → 实时预览 → cad:ready）：最小合法谱面集，song.wav 参数照搬
// smoke-osucad-preview 的形态
function oszWav(freq, ms) {
	const sr = 44100;
	const n = Math.floor((sr * ms) / 1000);
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
		v.setInt16(44 + i * 2, Math.sin((2 * Math.PI * freq * i) / sr) * 32767 * Math.exp(-i / (n / 4)), true);
	return data;
}
function makeOsz() {
	const enc = new TextEncoder();
	const osu = `osu file format v14

[General]
AudioFilename: song.wav
Mode: 0
SampleSet: Normal

[Metadata]
Title:SmokeMap
Artist:Tester
Creator:dev
Version:Hard
BeatmapID:1
BeatmapSetID:1

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:8
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,1,0,80,1,0

[HitObjects]
256,192,1000,1,0,0:0:0:0:
300,192,1600,1,2,0:0:0:0:
`;
	return zipSync({
		'test-map.osu': enc.encode(osu),
		'song.wav': oszWav(220, 2000),
		'normal-hitnormal.wav': oszWav(660, 90)
	});
}

// ── 子进程管理（detached 进程组，收尾整组杀——wrangler 的 workerd 是孙进程）──
const TMP = mkdtempSync(path.join(tmpdir(), 'hs-smoke-'));
const STATE = path.join(TMP, 'state');
const kids = []; // { name, proc, logPath, exited }
// 端口被占时探活会命中别人的进程（如上一轮 --keep-servers 的残留），后续断言全部
// 打在错误的服务上——起服务前先排除
async function assertPortFree(url, desc) {
	try {
		await fetch(url, { signal: AbortSignal.timeout(1500) });
		fail(`${desc} 端口已被占用（上一轮 --keep-servers 的残留？）：${url}`);
	} catch {
		/* 连接失败 = 空闲 */
	}
}
function launch(name, cmd, args) {
	const logPath = path.join(TMP, `${name}.log`);
	const log = openSync(logPath, 'a');
	const proc = spawn(cmd, args, { cwd: TMP, detached: true, stdio: ['ignore', log, log] });
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
		/* state 仍被进程占用时留给系统清理 */
	}
}
process.on('exit', cleanup);
function fail(msg) {
	console.error(`smoke-cross-origin: ${msg}`);
	if (KEEP) console.error(`（--keep-servers：日志与状态在 ${TMP}）`);
	for (const { name } of kids) {
		const t = tailLog(name);
		if (t) console.error(`── ${name}.log 尾部 ──\n${t}`);
	}
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
		// 子进程早退（如端口被占）时立即报错，别等超时——探活可能命中残留进程
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

// ── 前置检查（放在 fail/kids 就绪之后）──────────────────────
if (!existsSync(path.join(ROOT, 'build-static', 'index.html')))
	fail('缺少 build-static/index.html——先跑 just build-static（just smoke-cross-origin 已含）');
if (!existsSync(path.join(ROOT, '.svelte-kit', 'cloudflare', 'index.html')))
	fail('缺少 .svelte-kit/cloudflare/index.html——先跑 pnpm build');

// ── 1. 起后端（cwd 在仓库外断 .env 搜索链；wrangler.toml 副本提供 bindings）──
await assertPortFree(`${API}/`, '后端 8799');
cpSync(path.join(ROOT, 'wrangler.toml'), path.join(TMP, 'wrangler.toml'));
launch(
	'backend',
	WRANGLER,
	[
		'pages', 'dev', path.join(ROOT, '.svelte-kit', 'cloudflare'),
		'--port', String(API_PORT),
		'--persist-to', STATE,
		// 假密钥姿势同 justfile pages-dev；CORS_ORIGINS 放行前端 origin（跨站）
		'-b', 'OSU_CLIENT_ID=dev', '-b', 'OSU_CLIENT_SECRET=dev',
		'-b', 'SESSION_SECRET=dev-secret-0123456789abcdef01234567',
		'-b', 'ADMIN_OSU_ID=1',
		'-b', `SITE_DEFAULT_PASSWORD=${PASSWORD}`,
		'-b', `CORS_ORIGINS=http://127.0.0.1:${FRONT_PORT}`
		// 故意不传 R2 三项：强制 zip 清单 /api/blob 绝对回退分支（预签名会指向不存在的 R2 域），
		// 且 uploadEnabled=false 恰好覆盖「连接齿轮无条件显示」
	]
);
await waitUrl(`${API}/`, 90_000, 'wrangler pages dev 后端', 'backend');
step(`后端 :${API_PORT} 就绪（无 R2 三项 → 清单回退 + uploadEnabled=false）`);

// ── 2. 播种 D1 + R2 ─────────────────────────────────────────
const wavPath = path.join(TMP, 'smoke.wav');
writeFileSync(wavPath, wavBytes);
const d1 = ['d1', 'execute', 'hitsound-share-db', '--local', '--persist-to', STATE];
await run(WRANGLER, [...d1, '--file', path.join(ROOT, 'schema.sql')]);
const fixture = `INSERT INTO packages (id, name, uploader_osu_id, size_bytes, logical_size, file_count, status, append_to)
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
const selOut = await run(WRANGLER, [...d1, '--command', 'SELECT COUNT(*) AS n FROM files', '--json']);
const n = JSON.parse(selOut.slice(selOut.indexOf('['), selOut.lastIndexOf(']') + 1))[0].results[0].n;
if (Number(n) !== 1) fail(`files 播种验证失败（COUNT=${n}，应为 1）——d1 execute 假失败？`);
step(`播种完成：packages/blobs/files 各 1 行 + R2 对象（hash=${HASH.slice(0, 12)}…）`);

// ── 3. 静态前端目录（本地 CSP 适配副本）──────────────────────
// build-static 的 CSP connect/media-src 只放行 https:（面向生产 https API 域，§6.2），
// 本地 wrangler 后端是 http://localhost——CSP scheme-source 不匹配会被拦成
// TypeError: Failed to fetch。拷一份产物，精确追加本地 API origin（不放宽到 http:，
// 与生产 CSP 语义差异最小化），miss 即败（同 build-static 的防漂移风格）
const FRONT_DIR = path.join(TMP, 'front');
cpSync(path.join(ROOT, 'build-static'), FRONT_DIR, { recursive: true });
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

// ── 4. 起静态前端（python 静态服务，纯静态无 .env 风险）───────────────────
await assertPortFree(FRONT, '前端 8798');
launch('front', 'python3', [
	'-m', 'http.server', String(FRONT_PORT), '--bind', '127.0.0.1',
	'--directory', FRONT_DIR
]);
await waitUrl(FRONT, 15_000, '静态前端', 'front');
step(`静态前端 :${FRONT_PORT} 就绪（127.0.0.1 × localhost:8799 = 真实跨站）`);

// ── 5. CDP（骨架同 smoke-osucad-preview：原生 WebSocket + Runtime.evaluate）──
await assertPortFree(`http://localhost:${DBG}/json/list`, 'chromium CDP 9445');
launch('chromium', 'chromium', [
	'--headless=new', `--remote-debugging-port=${DBG}`,
	'--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', // osucad 渲染器硬依赖 WebGL2
	'--autoplay-policy=no-user-gesture-required',
	'--mute-audio', '--window-size=1280,900', 'about:blank'
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
const netLog = []; // Network.responseReceived → { url, status }（页面全部请求，消息级断言）
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
	if (m.method === 'Runtime.exceptionThrown')
		consoleLogs.push(`EXC: ${JSON.stringify(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text)}`);
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
// 页面表达式轮询（真值即过；reload 中上下文销毁的瞬时报错按未就绪继续轮询）
async function waitFor(expr, timeout = 10_000, desc = expr) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		try {
			if (await evalJs(expr)) return;
		} catch {
			/* 导航中 */
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

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
	await send('Page.addScriptToEvaluateOnNewDocument', { source: `
	// headless 下 showSaveFilePicker 存在但永不 resolve（AGENTS 已知坑⑧）：置 undefined
	// 强制整包下载走 Blob 兜底（注入模式与 smoke-osucad 一致）
	try { window.showSaveFilePicker = undefined; } catch {}
	window.__msgs = [];
	window.addEventListener("message", e => {
		if (e.data && typeof e.data.type === "string" && e.data.type.startsWith("cad:"))
			window.__msgs.push(e.data);
	});
	window.__errs = [];
	window.addEventListener("error", e => window.__errs.push(String(e.error?.stack || e.message)));
	window.addEventListener("unhandledrejection", e => window.__errs.push(String(e.reason)));
	try { localStorage.setItem("hs_tour_v1", "1"); } catch {} // 关新手引导（pageReady 后会盖住 UI）
` });

// ── 6. 断言序列 ─────────────────────────────────────────────
try {
	// 首启：非 Tauri（桌面引导遮罩不触发）+ uploadEnabled=false 下连接齿轮仍可见可开
	await send('Page.navigate', { url: FRONT });
	await waitFor(`!!document.querySelector('.gear-btn')`, 15_000, '首屏渲染（顶栏齿轮）');
	// 预渲染 shell 的齿轮是静态 DOM，水合前点击无效——以 config 拉取（layout onMount）为水合信号
	await waitNet((e) => e.url.includes('/api/config'), 15_000, 'layout 水合（config 拉取）');
	if (await evalJs(`'__TAURI_INTERNALS__' in window || '__TAURI__' in window`))
		fail('Tauri 检测误报（headless chromium 不应命中桌面判定）');
	await waitFor(`!document.querySelector('.gate-mask')`, 5_000, '无桌面首启遮罩（非 Tauri）');
	if (await evalJs(`!!document.querySelector('[data-tour="upload"]')`))
		fail('uploadEnabled=false 下上传按钮不应显示（R2 三项缺失的副作用验证）');
	await click(`document.querySelector('.gear-btn').click()`);
	await waitFor(`!!document.querySelector('#conn-base')`, 5_000, '连接设置对话框可打开');
	step('首启：齿轮在 uploadEnabled=false 下可见可开，无桌面误报');

	// 配置：先错密码回显 wrong_password，再正确密码 → token 入 localStorage → reload
	await setInput('#conn-base', API);
	await click(`document.querySelector('.dialog-card form .btn.primary').click()`);
	await waitFor(`!!document.querySelector('#conn-pw')`, 10_000, 'locked 后密码框亮出');
	await setInput('#conn-pw', 'definitely-wrong');
	await click(`document.querySelector('.dialog-card form .btn.primary').click()`);
	await waitFor(`!!document.querySelector('.msg.err')`, 10_000, '错密码错误回显');
	const errText = await evalJs(`document.querySelector('.msg.err')?.textContent ?? ''`);
	if (!errText.includes('站点密码错误')) fail(`错密码回显文案不符：${errText}`);
	await setInput('#conn-pw', PASSWORD);
	// 代际标记：window 属性不跨导航——旧页面（保存前）该表达式恒 false，
	// 防止 localStorage 在 reload 前已写入导致的假通过
	const netMark = netLog.length;
	await evalJs(`window.__preSave = true; true`);
	await click(`document.querySelector('.dialog-card form .btn.primary').click()`);
	await waitFor(
		`!window.__preSave && localStorage.getItem('hs_api_base') === '${API}' && !!document.querySelector('.gear-btn')`,
		20_000,
		'保存 base → reload 后顶栏回来'
	);
	const token = await evalJs(`localStorage.getItem('hs_gate_token') ?? ''`);
	if (!token || !token.includes('.')) fail(`hs_gate_token 未写入：${token}`);
	// 等 reload 后这次 config 拉取落地（from=netMark 排除保存流程中的旧记录），
	// 再断言无遮罩——避免 config 尚在途时遮罩判定早退
	await waitNet((e) => e.url.startsWith(`${API}/api/config`), 10_000, 'reload 后 config 拉取', netMark);
	await waitFor(`!document.querySelector('.gate-mask')`, 10_000, '解锁后 config gate.locked=false（无遮罩）');
	step(`连接配置：错密码回显 → 正确密码解锁 → token 入 localStorage（${token.slice(0, 8)}…）`);

	// 树 + 文件表（播种数据可见——数据类断言不可砍）
	await waitFor(`[...document.querySelectorAll('.tree .label')].some(el => el.textContent.includes('冒烟包'))`, 15_000, '树中出现播种包「冒烟包」');
	await waitFor(`[...document.querySelectorAll('.fname')].some(el => el.textContent.includes('smoke.wav'))`, 15_000, '文件表渲染播种文件');
	await waitNet((e) => e.url.startsWith(`${API}/api/tree`), 10_000, '/api/tree 拉取（x-hs-gate 生效）');
	step('树加载：播种包可见（x-hs-gate 过门）');

	// 波形合批：/api/waveform?ids=… 经 apiFetch（header 凭证）返回 200
	await waitNet((e) => e.url.startsWith(`${API}/api/waveform?ids=`) && e.status === 200, 15_000, '波形合批 /api/waveform');
	step('波形合批 /api/waveform 200（files.peaks 播种值）');

	// 单文件下载链接：base + /f/<id>/download?hs_gate=（整页导航无法带 header 的 query 轨）
	const href = await evalJs(`document.querySelector('.dl')?.href ?? ''`);
	const expectHref = `${API}/f/smoke-file-1/download?hs_gate=${token}`;
	if (href !== expectHref) fail(`下载链接不符：\n  实际 ${href}\n  期望 ${expectHref}`);
	const dl = await fetch(href);
	if (dl.status !== 200) fail(`下载链接返回 ${dl.status}`);
	const cd = dl.headers.get('content-disposition') ?? '';
	const dlBytes = await dl.arrayBuffer();
	if (!cd.includes('smoke.wav')) fail(`Content-Disposition 缺文件名：${cd}`);
	if (dlBytes.byteLength !== wavBytes.length) fail(`下载字节 ${dlBytes.byteLength} ≠ 播种 ${wavBytes.length}`);
	step('单文件下载：链接指向 base+/f/<id>/download?hs_gate= 且 200 回放完整字节');

	// 播放：点文件行 → Audio src（?hs_gate= query）→ 媒体 Range 请求 206（R2 播种对象）
	await click(`document.querySelector('.files-body tbody tr').click()`);
	await waitNet((e) => e.url.startsWith(`${API}/f/smoke-file-1`) && e.status === 206, 15_000, '/f/ 播放 206');
	step('播放：/f/<id>?hs_gate= 媒体请求 206');

	// 整包下载：清单 → /api/blob 绝对回退 URL（无 R2 三项强制该分支）→ Blob 兜底（picker 已被
	// 注入脚本置 undefined 前？——headless 下 showSaveFilePicker 存在但永不 resolve（已知坑⑧），
	// 页面内 hook createObjectURL 记录 Blob 兜底产物大小）
	await evalJs(`(() => {
		const orig = URL.createObjectURL.bind(URL);
		window.__blobSizes = [];
		URL.createObjectURL = (b) => { window.__blobSizes.push(b.size); return orig(b); };
		return true;
	})()`);
	await click(`document.querySelector('[data-tour="packdl"]').click()`);
	await waitNet((e) => e.url.includes('/api/package/smoke-pkg-1/zip') && e.status === 200, 10_000, '拉取整包清单');
	await waitNet((e) => e.url === `${API}/api/blob/${HASH}/wav` && e.status === 200, 15_000, '清单回退绝对 URL 命中 API 域');
	await waitFor(`!document.querySelector('.packing')`, 20_000, '打包完成回 idle');
	const blobSizes = (await evalJs(`window.__blobSizes ?? []`)) ?? [];
	if (!blobSizes.some((s) => s > 0)) fail(`Blob 兜底未产出 zip（sizes=${JSON.stringify(blobSizes)}）`);
	if (blobSizes[blobSizes.length - 1] <= wavBytes.length) fail('zip 应大于单个 wav（含头与目录）');
	step(`整包下载：/api/blob 绝对回退 URL + Blob 兜底（zip ${blobSizes.at(-1)} 字节）`);

	// osucad：静态产物下 iframe 载入 /osucad/index.html 并收到 cad:ready
	await click(`document.querySelector('.kit-fab').click()`);
	await waitFor(`!!document.querySelector('.kit-panel input[type=file]')`, 5_000, '组装面板展开');
	const oszB64 = Buffer.from(makeOsz()).toString('base64');
	await evalJs(`(() => {
		const bin = atob(${JSON.stringify(oszB64)});
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const f = new File([bytes], "smoke.osz");
		const dt = new DataTransfer();
		dt.items.add(f);
		const input = document.querySelector('.kit-panel input[type=file]');
		input.files = dt.files;
		input.dispatchEvent(new Event("change", { bubbles: true }));
		return true;
	})()`);
	await waitFor(`!!document.querySelector('.osz-name')`, 15_000, 'osz 导入');
	await click(`[...document.querySelectorAll('.osz-bar .btn')].find(b => b.textContent.includes('预览')).click()`);
	await waitFor(`!!document.querySelector('.cad-win iframe')`, 5_000, '预览窗 iframe 挂载');
	const iframeSrc = await evalJs(`document.querySelector('.cad-win iframe')?.src ?? ''`);
	if (!iframeSrc.endsWith('/osucad/index.html')) fail(`osucad iframe src 异常：${iframeSrc}`);
	let ready = null;
	const t0 = Date.now();
	while (Date.now() - t0 < 30_000) {
		ready = await evalJs(`(window.__msgs || []).find(m => m.type === 'cad:ready') || null`);
		if (ready) break;
		await sleep(300);
	}
	if (!ready) fail(`cad:ready 超时（console 尾部：${consoleLogs.slice(-10).join(' | ')}）`);
	step('osucad：静态产物 iframe 加载并收到 cad:ready（同源 postMessage）');

	// OPTIONS 预检（脚本直发）：204 + 白名单 origin 回显
	const opt = await fetch(`${API}/api/tree`, {
		method: 'OPTIONS',
		headers: { Origin: `http://127.0.0.1:${FRONT_PORT}`, 'Access-Control-Request-Method': 'GET' }
	});
	const acao = opt.headers.get('access-control-allow-origin');
	if (opt.status !== 204 || acao !== `http://127.0.0.1:${FRONT_PORT}`)
		fail(`OPTIONS 预检异常：status=${opt.status} acao=${acao}`);
	step('CORS 预检：OPTIONS /api/tree → 204 + origin 回显');

	// 失效 token：门 401 响应跨源可读（CORS 注入到拒绝分支，而非浏览器 TypeError）
	await evalJs(`localStorage.setItem('hs_gate_token', 'deadbeefdeadbeef.deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead'); location.reload(); true`);
	await waitFor(`!!document.querySelector('.gate-mask')`, 15_000, '失效 token 后 SiteGate 遮罩（config locked:true）');
	const probe = await evalJs(`(async () => {
		try {
			// cache:'reload' 绕 /api/tree 的 60s 私有缓存（树加载阶段已缓存 200，否则断言打到缓存）
			const r = await fetch('${API}/api/tree', {
				headers: { 'x-hs-gate': localStorage.getItem('hs_gate_token') },
				credentials: 'include',
				cache: 'reload'
			});
			let error = null;
			try { error = (await r.json()).error; } catch {}
			return { ok: true, status: r.status, error };
		} catch (e) { return { ok: false, err: String(e) }; }
	})()`);
	if (!probe?.ok || probe.status !== 401 || probe.error !== 'site_locked')
		fail(`门 401 可读性失败（应为 401 site_locked 而非 TypeError）：${JSON.stringify(probe)}`);
	step('失效 token：401 site_locked 跨源可读 + SiteGate 遮罩复现');

	// 清空 base → 回同源空壳：树失败 UI 可重试、无桌面遮罩、无页面异常（不崩溃）
	await evalJs(`localStorage.removeItem('hs_api_base'); localStorage.removeItem('hs_gate_token'); location.reload(); true`);
	await waitFor(`!!document.querySelector('.tree .retry')`, 15_000, '清空 base 后树失败重试 UI');
	await waitFor(`!document.querySelector('.gate-mask')`, 5_000, '同源空壳无门遮罩');
	const pageErrs = (await evalJs(`window.__errs ?? []`)) ?? [];
	if (pageErrs.length) fail(`同源空壳下页面异常：${JSON.stringify(pageErrs)}`);
	step('清空 base：回同源空壳（树失败 UI 可重试，页面不崩溃）');

	ws.close();
	console.log('SMOKE OK —— 跨源端到端冒烟全过');
} catch (e) {
	fail(String(e?.stack ?? e));
}
cleanup();

if (KEEP) {
	console.log(`\n--keep-servers：服务保留中`);
	console.log(`  后端 ${API} ｜ 前端 ${FRONT} ｜ CDP :${DBG}`);
	console.log(`  播种 hash ${HASH} ｜ 状态目录 ${STATE} ｜ 日志 ${TMP}`);
}
// 显式退出：KEEP 下子进程（wrangler/chromium）仍在跑，CDP WebSocket 的关闭握手
// 会挂住事件循环使本进程永不退出
process.exit(0);
