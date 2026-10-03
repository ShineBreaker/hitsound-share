# 桌面端（Tauri）包装指引

> 本仓库不含 Tauri/Rust 工程；`just build-static` 产出可供 Tauri `frontendDist` 直接消费的纯静态目录。本文写给未来的 Tauri 集成者：配置要点、能力边界与上线前置核对。后端跨源支持（`CORS_ORIGINS`、门 token）见 [deployment.md](./deployment.md) 二节。

## 一、产物与构建

- `just build-static`（= `pnpm build` 后跑 `node scripts/build-static.mjs`，等价 `pnpm build:static`）→ `build-static/`（已 gitignore）。
- 通道原理：唯一页面 `/` 已 prerender，预渲染 shell + `_app` + `osucad` 静态资产本就在 `.svelte-kit/cloudflare/` 产物里；脚本只做**抽取**——排除 Pages 专用文件（`_worker.js` / `_routes.json` / `_headers`）与 adapter 中间目录（`output/` / `cloudflare-tmp/`），并对 `index.html` 的 CSP meta 做放宽后处理（`connect-src 'self' https: blob:`、`media-src` 加 `https: data:`、追加 `img-src`；script-src 水合 hash 原样保留）。不引入 adapter-static，Pages 构建命令与部署零改动。
- 替换采用精确匹配、miss 即构建失败：`svelte.config.js` 的 CSP directives 变更后须同步更新 `scripts/build-static.mjs` 的替换串。

## 二、Tauri 配置要点

- `build.frontendDist` 指向 `build-static/`；开发期 `build.devUrl` 指向 vite dev server（`pnpm dev` :5173，同源假设由连接设置 UI 覆盖——在应用内配置服务器地址）。
- **CSP 由 Tauri conf 接管**（`tauri.conf.json > app > security > csp`）：写成等价于 build-static 已放宽的 directive 集，另加 `tauri:` 协议资产（如 `ipc: http://ipc.localhost` 按 Tauri 版本文档配）。产物内 meta CSP 与 Tauri CSP 同时生效时**取交集**——Tauri 侧不得比产物更严，否则拦掉 API 域请求。
- 服务器地址：应用内「连接设置」填 `https://hitsound-share.pages.dev`（或自部署 API 域）。
- 能力边界：桌面端不支持 OAuth 登录/上传/改名/删除（入口自动隐藏，`isDesktopApp()` 检测）——WebView 对自定义协议 origin 的第三方 cookie 不可靠，且 osu! OAuth 回调要求 https 注册地址。浏览/试听/下载/组装/osz 导出均可用；站点门走 localStorage token（`x-hs-gate` header + `/f/` query）。

## 三、根路径部署边界（静态版硬约束）

静态产物只能部署在**域根路径**。硬约束是 osucad 预览 iframe 的根绝对 src `"/osucad/index.html"`（`src/lib/components/CadPreview.svelte`）：子路径部署（如 `example.com/app/`）会因 iframe 404 断掉 cad 预览。`index.html` 的 `_app` 引用实测是 `./` 相对、wasm 是 `import.meta.url` 相对，这两类在子路径下本可正常工作。未来若要解子路径限制，改法是把 CadPreview 的 iframe src 改相对引用（本次不做）。Tauri `frontendDist` 是协议根，不受此约束影响。

## 四、上线前置核对

1. **后端 `CORS_ORIGINS`** 加桌面 origin：Windows WebView2 是 `http://tauri.localhost`，macOS/Linux WebKitGTK 是 `tauri://localhost`（按目标平台配，见 deployment.md 二节）。
2. **R2 桶 CORS 三项核对**（缺一则桌面直传/直连失败）：
   - AllowedOrigins：追加跨源 Web 前端域、`http://tauri.localhost` 与 `tauri://localhost`（R2 接受任意 origin 字符串，含自定义协议）；
   - AllowedMethods：须含 `PUT`（上传预签名直传）与 `GET`（下载直连）；
   - AllowedHeaders：直传链路不带自定义 header（`x-hs-gate` 只发给 API 域），现配置满足即不动。

## 五、桌面实机核查清单（人工验证）

Tauri WebView 行为无法在本地浏览器冒烟覆盖，打包后逐项核对：

- [ ] osucad 预览 iframe 在自定义协议源下加载并收到 `cad:ready`（iframe 与宿主同 origin，postMessage `targetOrigin=location.origin` 语义不变）；
- [ ] 整包/单文件下载落盘：`zip-save` 在桌面模式强制跳过 `showSaveFilePicker` 走 Blob + `a.download` 兜底，`a.download` 在自定义协议源的实际行为属实机待验项（失败则需接 Tauri dialog/fs 插件，另行提案）；
- [ ] R2 预签名直连下载（R2 CORS 放行 tauri origin 后可用）；
- [ ] 试听播放（`/f/` query token）、波形、组装面板、osz 导出基本流。

## 六、排障

- 连不上 API（请求 TypeError、空树重试 UI）→ 先查后端 `CORS_ORIGINS` 是否含桌面 origin（scheme/host/port 须完全一致），再查 R2 CORS；
- 跨源 **Web** 登录在 Safari 不可用（ITP 拦第三方 cookie），用 Chromium/Firefox；桌面端不受影响（本就不走登录，门走 token）；
- 静态版只能部署在域根路径（见三节）。
