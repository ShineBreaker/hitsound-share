// CDP 端到端冒烟：hitsound-share 真实 UI → 导入 osz → 实时预览 → 热更新
// 用法：
//   1. pnpm dev --port 4521        （另一个终端起 dev server）
//   2. node scripts/smoke-osucad-preview.mjs
// 验证：iframe /osucad/index.html 起来 → cad:ready → hs:load → cad:loaded → play → cad:time
//       → cad:stats.hits>0（hitsound 确实命中样本）→ 再次导入 → hs:update → 第二个 cad:loaded（不重载）
// 注意：osucad 渲染器硬依赖 WebGL2 —— 无 GPU 环境必须给 chromium 传
//       --use-gl=angle --use-angle=gl-egl（mesa llvmpipe）；--disable-gpu 会导致无法启动。
import { zipSync } from "fflate";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const DBG = 9444;
const APP = "http://localhost:4521/";

function wav(freq, ms) {
  const sr = 44100, n = Math.floor(sr * ms / 1000);
  const data = new Uint8Array(44 + n * 2);
  const v = new DataView(data.buffer);
  const s = (o, str) => str.split("").forEach((c, i) => data[o + i] = c.charCodeAt(0));
  s(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); s(8, "WAVEfmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  s(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++)
    v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * freq * i / sr) * 32767 * Math.exp(-i / (n / 4)), true);
  return data;
}

function makeOsz(hitFreq, ms) {
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
340,220,2200,1,8,0:0:0:0:
256,300,2800,1,10,0:0:0:0:
`;
  return zipSync({
    "test-map.osu": enc.encode(osu),
    "song.wav": wav(220, 5000),
    "normal-hitnormal.wav": wav(hitFreq, ms),
  });
}

const chrome = spawn("chromium", [
  "--headless=new", `--remote-debugging-port=${DBG}`,
  "--no-sandbox", "--use-gl=angle", "--use-angle=gl-egl",
  "--autoplay-policy=no-user-gesture-required",
  "--window-size=1280,800", "about:blank",
], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 2500));

const list = await fetch(`http://localhost:${DBG}/json/list`).then(r => r.json());
const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);

let id = 0;
const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const consoleLogs = [];
ws.addEventListener("message", e => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.consoleAPICalled")
    consoleLogs.push(`${m.params.type}: ${m.params.args.map(a => a.value ?? a.description ?? "").join(" ")}`);
  if (m.method === "Runtime.exceptionThrown")
    consoleLogs.push(`EXC: ${JSON.stringify(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text)}`);
});
const send = (method, params = {}) => new Promise(res => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__msgs = [];
  window.addEventListener("message", e => {
    if (e.data && typeof e.data.type === "string" && e.data.type.startsWith("cad:"))
      window.__msgs.push(e.data);
  });
  window.__errs = [];
  window.addEventListener("error", e => window.__errs.push(String(e.error?.stack||e.message)));
  window.addEventListener("unhandledrejection", e => window.__errs.push(String(e.reason)));
` });
await send("Page.navigate", { url: APP });
await new Promise(r => setTimeout(r, 5000));

// 打开组装面板（FAB）
const fab = await evalJs(`!!document.querySelector(".kit-fab")`);
if (!fab) throw new Error("kit-fab 不存在（页面未渲染？）");
await evalJs(`document.querySelector(".kit-fab").click()`);
await new Promise(r => setTimeout(r, 500));

// 构造 .osz File 塞进隐藏 input（input.files 可赋值 DataTransfer.files）
const oszB64 = Buffer.from(makeOsz(660, 90).buffer).toString("base64");
await evalJs(`(() => {
  const bin = atob(${JSON.stringify(oszB64)});
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const f = new File([bytes], "smoke.osz");
  const dt = new DataTransfer();
  dt.items.add(f);
  const input = document.querySelector(".kit-panel input[type=file]");
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`);
await new Promise(r => setTimeout(r, 1500));

const oszLoaded = await evalJs(`!!document.querySelector(".osz-name")`);
if (!oszLoaded) {
  console.log("osz import failed?", await evalJs(`document.querySelector(".osz-hint")?.textContent`));
  throw new Error("osz 未导入");
}
console.log("osz imported:", await evalJs(`document.querySelector(".osz-name")?.textContent`));

// 点「实时预览」→ iframe 出现 → 等 cad:ready / cad:loaded
await evalJs(`[...document.querySelectorAll(".osz-bar .btn")].find(b => b.textContent.includes("预览")).click()`);
await new Promise(r => setTimeout(r, 800));
const hasIframe = await evalJs(`!!document.querySelector(".cad-win iframe")`);
if (!hasIframe) throw new Error("预览窗/iframe 未出现");
console.log("preview iframe mounted");

const waitMsg = async (type, timeout = 20000, from = 0) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const found = await evalJs(`(window.__msgs||[]).slice(${from}).find(m => m.type === ${JSON.stringify(type)}) || null`);
    if (found) return found;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting ${type}`);
};

console.log("wait cad:ready…");
console.log("ready:", await waitMsg("cad:ready"));
console.log("wait cad:loaded…");
const loaded = await waitMsg("cad:loaded", 30000);
console.log("loaded:", JSON.stringify(loaded.meta));

// 点播放 → cad:time 推进
await evalJs(`document.querySelector(".cad-win .pp").click()`);
await new Promise(r => setTimeout(r, 2500));
const times = await evalJs(`(window.__msgs||[]).filter(m => m.type === "cad:time").slice(-3)`);
console.log("time msgs:", JSON.stringify(times));
if (!times.length || !times.at(-1).playing) throw new Error("播放未推进");

// 采样命中统计
await evalJs(`document.querySelector(".cad-win iframe").contentWindow.postMessage({ type: "hs:control", action: "stats" }, "*")`);
await new Promise(r => setTimeout(r, 500));
const stats = await evalJs(`(window.__msgs||[]).filter(m => m.type === "cad:stats").slice(-1)`);
console.log("stats:", JSON.stringify(stats));
if (!stats.length || stats[0].hits <= 0) throw new Error("hitsound 未命中（stats.hits<=0）");

const shot = await send("Page.captureScreenshot", { format: "png" });
mkdirSync("/tmp/cad-shots", { recursive: true });
writeFileSync("/tmp/cad-shots/e2e-window.png", Buffer.from(shot.result.data, "base64"));

// 热更新：重新导入 osz（hitnormal 换频）→ osz.entries 变化 → invalidate → hs:update → cad:loaded#2
const n1 = await evalJs(`window.__msgs.length`);
const osz2B64 = Buffer.from(makeOsz(440, 200).buffer).toString("base64");
await evalJs(`(() => {
  const bin = atob(${JSON.stringify(osz2B64)});
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const f = new File([bytes], "smoke.osz");
  const dt = new DataTransfer();
  dt.items.add(f);
  const input = document.querySelector(".kit-panel input[type=file]");
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`);
console.log("wait cad:loaded #2（热更新）…");
const loaded2 = await waitMsg("cad:loaded", 20000, n1);
console.log("loaded#2:", JSON.stringify(loaded2.meta));

// 热更新后 hitsound 仍命中：seek 回开头重播 → stats 的 hits 应继续增长（证明新 skin 生效）
await evalJs(`document.querySelector(".cad-win iframe").contentWindow.postMessage({ type: "hs:control", action: "seek", value: 0 }, "*")`);
await evalJs(`document.querySelector(".cad-win iframe").contentWindow.postMessage({ type: "hs:control", action: "play" }, "*")`);
await new Promise(r => setTimeout(r, 2500));
await evalJs(`document.querySelector(".cad-win iframe").contentWindow.postMessage({ type: "hs:control", action: "stats" }, "*")`);
await new Promise(r => setTimeout(r, 500));
const stats2 = await evalJs(`(window.__msgs||[]).filter(m => m.type === "cad:stats").slice(-1)`);
console.log("stats#2:", JSON.stringify(stats2));
const hitsBefore = stats[0]?.hits ?? 0;
if (!stats2.length || stats2[0].hits <= hitsBefore)
  throw new Error("热更新后 hitsound 未继续命中（stale skin？）");

console.log("errors:", JSON.stringify(await evalJs(`(window.__msgs||[]).filter(m => m.type === "cad:error")`)));
console.log("pageErrs:", JSON.stringify(await evalJs(`window.__errs||[]`)));
console.log("console:", JSON.stringify(consoleLogs.slice(-30), null, 0));

const shot2 = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("/tmp/cad-shots/e2e-after-update.png", Buffer.from(shot2.result.data, "base64"));

ws.close(); chrome.kill();
console.log("DONE");
