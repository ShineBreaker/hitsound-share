# 桌面端（Tauri）工程实录

> 本仓库已含 Tauri 2 桌面壳工程 `src-tauri/`：现有前端**零改动**即可打包为 Linux 桌面应用（桌面形态检测靠 Tauri 2 默认注入的 `__TAURI_INTERNALS__`，前端不依赖 `@tauri-apps/api`、不开 `withGlobalTauri`）。本文记录工程结构、构建命令、配置决策与上线前置；后端跨源支持（`CORS_ORIGINS`、门 token、会话 token）见 [deployment.md](./deployment.md) 二节与 [architecture-split.md](./architecture-split.md)。

## 一、构建与开发

- **构建依赖**（`manifest.scm`，direnv 自动加载）：`rust` + `rust:cargo`（工具链）、`pkg-config`、`webkitgtk-for-gtk3`（Linux WebView，连带 javascriptcoregtk-4.1 / gtk+-3.0 / libsoup-3.0）、`xz`（补 `liblzma.pc`——gdk-pixbuf 的 private 依赖链 `libtiff-4 → liblzma` 需要它，缺失时 pkg-config 解析 `gdk-3.0` 整链失败）、`librsvg`（`rsvg-convert` 图标源生成）。CLI 侧只加 devDependency `@tauri-apps/cli`（预编译二进制，无构建脚本需放行）。另 `src-tauri/.cargo/config.toml` 在链接期把 ELF interpreter 钉到 `/lib64/ld-linux-x86-64.so.2`——guix rustc 默认烧 `/gnu/store/...` 路径，产物离开本机 guix store 即无法执行（本机开发不受影响，webkit 库走 direnv 注入的 `LD_LIBRARY_PATH`）。
- `just tauri-dev`：桌面开发模式——`beforeDevCommand` 自动拉起 vite dev server（:5173），Tauri 壳连 `devUrl`，改前端即时热更。
- `just tauri-build`：打包发布（= 前置 `build-static` 产静态目录 → `pnpm tauri build`）→ `src-tauri/target/release/bundle/deb/hitsound-share_0.1.0_amd64.deb`（control 已声明 `libwebkit2gtk-4.1-0` / `libgtk-3-0` 依赖，目标发行版 apt 安装即用）。日志全量落 `/tmp/tauri-build.log`，控制台收敛尾部 40 行。
- 图标再生成：`guix shell librsvg -- rsvg-convert -w 1024 -h 1024 static/favicon.svg -o /tmp/icon-1024.png` → `direnv exec . pnpm tauri icon /tmp/icon-1024.png`（favicon 是 64×64 方形，无变形处理）；`icons/` 下 android/ios 移动端目录已移除，本工程仅 Linux 桌面目标。

## 二、工程结构与配置决策

```
src-tauri/
├── Cargo.toml          # tauri 2 / tauri-build 2 / serde / serde_json；bin 名 hitsound-share
├── build.rs            # tauri_build::build()
├── src/main.rs         # 入口，转调 lib.rs 的 run()
├── src/lib.rs          # 标准 run()：无命令、无插件——壳只装载静态产物
├── tauri.conf.json     # 本节各项决策落点
├── capabilities/default.json  # 最小权限 core:default，无插件权限
└── icons/              # favicon.svg 派生全套（32~512 png / icns / ico）
```

- `build.frontendDist = "../build-static"`：消费 `just build-static` 的纯静态产物（构建通道见 [architecture-split.md](./architecture-split.md) 五节）。
- `build.beforeBuildCommand` 留空：前端构建编排由 just 承担（`tauri-build` 依赖 `build-static`），避免 `pnpm tauri build` 内部再起一次前端构建的双重建。
- `build.devUrl = "http://localhost:5173"`、`beforeDevCommand = "pnpm dev"`：dev 模式走 vite dev server；dev 页面不经 tauri 协议服务，`app.security.csp` 对其不生效（Linux WebKitGTK 的 user script 不受页面 CSP 约束，`__TAURI_INTERNALS__` 注入不受影响）。
- **CSP 由 Tauri conf 接管**（`app > security > csp`）：与 build-static 产物 meta 放宽后的 directive 集等价（`scripts/build-static.mjs` 的 CSP_FIXES：`connect-src 'self' https: blob:`、`media-src 'self' blob: https: data:`、`img-src 'self' https: data:`），另加 Tauri IPC 两项 `ipc: http://ipc.localhost`。产物内 meta CSP 与 Tauri CSP 同时生效时**取交集**——Tauri 侧不得比产物更严，否则拦掉 API 域请求。
  - `script-src` 写 `'self' 'wasm-unsafe-eval' 'unsafe-inline'`：产物水合是内联脚本 + hash 形态，Tauri 以自身 CSP 替换产物 meta 后 hash 段失效，缺 `'unsafe-inline'` 会拦掉水合（产物自身是本地静态可信资产，放宽面可控）。
  - 同源 Web 版 CSP（`svelte.config.js`）不动：三层各自归属——同源走 svelte.config.js、静态版走 build-static 后处理、Tauri 版走 tauri.conf.json 接管。
- `identifier = "dev.hitsound.share"`：占位口径，正式分发前可按需改。
- 窗口：标题「hitsound 分享站」（与顶栏 `t('app.title')` 一致），1280×800 起、最小 960×600、可缩放。
- `bundle.targets = ["deb"]`：**AppImage 在本环境结构性不可打包**，只打 deb。原因（tauri-cli 2.12.1 实测）：appimage 打包经 linuxdeploy，tauri-bundler 每次构建把内嵌的 `linuxdeploy-plugin-gstreamer.sh`（shebang 硬编码 `#!/bin/bash`，缓存副本被改即重写）写入 `~/.cache/tauri/`，linuxdeploy 启动时枚举同目录全部插件并查询 `--plugin-api-version`——本机 guix 布局无 `/bin/bash`，该插件 exec ENOENT 直接拖垮整个打包（报错只有一句 `failed to run linuxdeploy`，真实 stderr 被 bundler 吞掉，需 strace 定位）。仓库层无法提供 `/bin/bash`（绝对路径 + 文件每次被重写）；将来若系统提供 `/bin/bash` 或上游修 shebang，把 `"appimage"` 加回 targets 即可（届时还需 bash/file/find/grep/sed/ldd 及 `glib:bin`/`gtk+:bin` 进 manifest——linuxdeploy 的 gtk 插件按 FHS 假设写）。

## 三、根路径部署边界（静态版硬约束，Tauri 不受影响）

静态产物只能部署在**域根路径**。硬约束是 osucad 预览 iframe 的根绝对 src `"/osucad/index.html"`（`src/lib/components/CadPreview.svelte`）：子路径部署（如 `example.com/app/`）会因 iframe 404 断掉 cad 预览。`index.html` 的 `_app` 引用实测是 `./` 相对、wasm 是 `import.meta.url` 相对，这两类在子路径下本可正常工作。未来若要解子路径限制，改法是把 CadPreview 的 iframe src 改相对引用（本次不做）。Tauri `frontendDist` 是协议根，不受此约束影响。

## 四、上线前置核对（运维）

1. **后端 `CORS_ORIGINS`** 加桌面 origin：Windows WebView2 是 `http://tauri.localhost`，macOS/Linux WebKitGTK 是 `tauri://localhost`（按目标平台配，见 deployment.md 二节）。
2. **R2 桶 CORS 三项核对**（缺一则桌面直传/直连失败）：
   - AllowedOrigins：追加跨源 Web 前端域、`http://tauri.localhost` 与 `tauri://localhost`（R2 接受任意 origin 字符串，含自定义协议）；
   - AllowedMethods：须含 `PUT`（上传预签名直传）与 `GET`（下载直连）；
   - AllowedHeaders：直传链路不带自定义 header（`x-hs-gate` / `x-hs-session` 只发给 API 域），现配置满足即不动。

## 五、桌面实机核查清单（人工验证）

Tauri WebView 行为无法在本地浏览器冒烟覆盖，打包后逐项核对：

- [ ] **Xvfb 自动冒烟的环境要点**（已单变量对照实测）：`WEBKIT_DISABLE_DMABUF_RENDERER=1` + `GDK_BACKEND=x11` 二者必须同时设置——后者是窗口能映射的关键（Xvfb 下 GDK 默认后端选择会让窗口创建挂起，主循环静默等待且零报错输出），`NO_AT_BRIDGE=1` 经对照无效果、不需要；
- [ ] osucad 预览 iframe 在自定义协议源下加载并收到 `cad:ready`（iframe 与宿主同 origin，postMessage `targetOrigin=location.origin` 语义不变）；
- [ ] 登录全流程：授权后 302 落回 `/?hs_code=…` → 参数被清 → 顶栏出现用户名 → 上传/改名/删除可用 → 登出后回落未登录（`hs_session_token` 被清）；
- [ ] 整包/单文件下载落盘：`zip-save` 在桌面模式强制跳过 `showSaveFilePicker` 走 Blob + `a.download` 兜底，`a.download` 在自定义协议源的实际行为属实机待验项（失败则需接 Tauri dialog/fs 插件，另行提案）；
- [ ] R2 预签名直连下载（R2 CORS 放行 tauri origin 后可用）；
- [ ] 试听播放（`/f/` query token）、波形、组装面板、osz 导出基本流。

## 六、登录与会话机制（桌面轨）

桌面 WebView 对自定义协议 origin 的第三方 cookie 不可靠，登录态因此不走 cookie 轨（机制详情见 [architecture-split.md](./architecture-split.md) 3.2/3.3）：

- **登录 = `hs_code` 交换**：`loginUrl()` 以 `hs_origin=<tauri origin>` 跳 osu! 授权 → callback 命中 `CORS_ORIGINS` 白名单后 302 回前端域 `/?hs_code=<60s 交付码>` → 落地页自动 `POST /api/auth/exchange` 换发 7 天会话 token 存 localStorage（键 `hs_session_token`）并清 URL 参数 → 此后请求经 `x-hs-session` 头携带。
- **两种打开方式同轨**：WebView 内整页导航（现状默认）或将来 Tauri 壳用 shell-open / deep-link 拉起系统浏览器——两者最终都落回前端域的 `hs_code` 交换，桌面壳无需额外逻辑。
- 站点门与从前一样走 localStorage token（`x-hs-gate` header + `/f/` query），与会话 token 并存互不干扰。
- 首启引导：桌面形态且未配服务器地址时前端显示连接引导遮罩（`needsDesktopSetup()`），在应用内「连接设置」填 `https://hitsound-share.pages.dev`（或自部署 API 域）。

## 七、排障

- 连不上 API（请求 TypeError、空树重试 UI）→ 先查后端 `CORS_ORIGINS` 是否含桌面 origin（scheme/host/port 须完全一致），再查 R2 CORS；
- 登录请求被浏览器拦（console 报 CORS 头不足）→ 核对预检响应 `Access-Control-Allow-Headers` 含 `x-hs-session`（旧产物/旧后端混部署时可能缺失，两端同版本即可）；登录后仍 401 → 会话 token 7 天过期，重新登录即可；
- 跨源 **Web** 登录在 Safari 不可用（ITP 拦第三方 cookie），用 Chromium/Firefox；桌面端不受影响（登录态走 `x-hs-session` 头，不依赖第三方 cookie）；
- `cargo` 构建报 `gdk-3.0 was not found` → direnv 环境未重建或 manifest 缺 `xz`（见一节依赖说明）；
- appimage 打包报 `failed to run linuxdeploy` → 见二节 targets 说明（本环境结构性不可打包，strace 是定位这类被吞 stderr 的子进程失败的唯一途径）；
- 静态版只能部署在域根路径（见三节）。
