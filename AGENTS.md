# AGENTS.md

> 项目协作与工程约定。修改前先读本文件与 README.md，保持改动最小化、沿用现有风格。

## 概述

osu! 铺面音效（hitsound）分享站：浏览、试听（Range 流式 + 波形跳播）、下载（单文件 / 整包按当前内容实时打包）、上传（osu! OAuth + 内容寻址去重秒传 + 附加到现有分组）、大类/小类在线改名。技术栈 SvelteKit 5 + Cloudflare Pages（Functions）+ R2 + D1，线上 https://hitsound-share.pages.dev。

## 常用命令

- `pnpm dev` / `pnpm build` / `pnpm preview`；`pnpm test`（vitest，`src/**/*.test.ts`）——改动后 `pnpm test` 与 `pnpm build` 都须通过；无 lint 脚本
- `wrangler d1 execute hitsound-share-db --local --file schema.sql`：初始化本地 D1 模拟库；`--command "SQL"` 单条执行（线上操作用 `--remote`）
- `wrangler pages dev .svelte-kit/cloudflare --port 8799 -b KEY=VALUE…`：用构建产物起本地 Functions（bindings 从 wrangler.toml 读，env 变量用 `-b` 传）
- `wrangler r2 object put/get/list hitsound-files/<key> --local/--remote`：R2 对象操作（不加 `--local` 的默认仍是本地，**线上必须显式 `--remote`**）
- pnpm 钉在 package.json 的 `packageManager`（12.3.4）；只用 pnpm，不用 npm/yarn 安装依赖

## 开发环境（direnv + guix）

- 首次进入：`direnv allow`——`.envrc` 经 `use guix -m manifest.scm` 注入 Node 22（大版本与 `.node-version` 一致）；pnpm 由 Node 自带 corepack 按 `packageManager` 提供到 `.cache/bin/pnpm`（guix 未收录 pnpm，且 guix store 只读无法 `corepack enable`；wrapper 细节见 `.envrc` 注释）
- `pnpm install` 后 `node_modules/.bin`（wrangler 等）自动进 PATH；`.cache/` 是 corepack/pnpm shim 缓存，已 gitignore
- pnpm 设置在 `pnpm-workspace.yaml`（pnpm 12 起不再读 package.json 的 `pnpm` 字段）：`allowBuilds` 放行 esbuild 构建脚本；workerd 用平台二进制分发无需脚本
- manifest 目录授权（一次性）：`echo $PWD >> ~/.config/guix/shell-authorized-directories`

## 本地开发与部署

- 本地：`direnv allow` → `pnpm install` → 初始化本地 D1（见常用命令）→ `pnpm dev` 跑浏览/试听；上传链路需 OAuth 项，留空时登录/上传入口自动隐藏；改 API 层用 `wrangler pages dev` 起产物实测
- 部署走 Pages Git 集成：推送 main 分支自动构建；**构建命令（`pnpm build`）配置在 Pages 项目构建设置里（面板/API 的 build_config），不在 wrangler.toml**——wrangler.toml 只承载输出目录、compatibility 与 R2/D1 bindings
- 运行时需在 Pages 配 7 个 Production 加密变量：`OSU_CLIENT_ID`、`OSU_CLIENT_SECRET`、`SESSION_SECRET`、`ADMIN_OSU_ID`、`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`（`SESSION_SECRET` 用 `openssl rand -hex 32` 生成）；可选 `SITE_DEFAULT_PASSWORD`（站点访问密码门初始密码，配置即启用；管理员在线改密后落 D1 settings，此变量不再生效）
- osu! OAuth 回调地址：`https://<域名>/api/auth/callback`（默认按请求 origin 推导，`OSU_REDIRECT_URI` 一般不用配）
- D1 初始化/变更：执行 `schema.sql`，执行后必须 SELECT 验证（见下文已知坑）；线上库 v5→v6 直接执行 `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`（站点访问密码），v3→v4 需先执行 `ALTER TABLE packages ADD COLUMN append_to TEXT;` 再部署代码
- 存量 original.zip 清理（v4 停传后的一次性动作）：admin 登录后 `POST /api/admin/purge-zips`，重复调用至 `remaining: 0`

## 目录速览

- `src/lib/server/` — 仅服务端代码：`osu.ts`（唯一出网通道）、`session.ts`（HMAC 签名 cookie）、`guard.ts`（`requireUser`/`requireAdmin`/`requirePackageOwner`/`requireSuperAdmin`，返回 Response 即已作答）、`env.ts`（密钥读取 + `uploadCapable`/`pickR2Secrets` 能力判定）、`admin.ts`（管理员判定：超管 = ADMIN_OSU_ID 环境变量，管理员 = `users.is_admin`，每次实时查库不落 session）、`media.ts`（R2 key/Range/流式代理）、`upload.ts`（manifest 校验/预签名 PUT+GET/魔数）、`ledger.ts`（Blob 账本：refcount 登记/对齐/回收，唯一入口；`releasePackage` 整包、`releaseFiles` 文件/文件夹级删除）、`verify.ts`（done 新 blob 核验）、`packages.ts`（包行查询/pending 懒清理）、`site-gate.ts`（站点访问密码门：密码源 = D1 settings > `SITE_DEFAULT_PASSWORD`，皆无未启用；解锁 cookie 以当前密码 hash 为 HMAC 密钥——改密即全站会话失效）
- `src/lib/*.ts` — 浏览器端 deep module：`upload-pipeline.ts`（`prepareUpload` 解包（zip/rar/7z，唯一顶层文件夹剥前缀提升）→哈希 + `runUpload` manifest→并发直传→done，事件流上报；`archive.ts` 按魔数分流，rar/7z wasm 按需加载（`unrar-wasm.ts`/`seven-zip-wasm.ts`；7z 退出码不可靠，成败看输出文本与裸数字 throw）、`zip-save.ts`（整包下载与组装面板共用的打包落盘）、`player.svelte.ts`（全站唯一播放器）、`kit.svelte.ts`（组装面板格子/序号/Q–V 键位，唯一入口）、`selection.svelte.ts`（文件表选中集 + 入格）、`ui.svelte.ts` + `tour.ts`（帮助/新手引导状态与步骤）、`pool.ts`（并发池）、`api.ts`（含 peaks 合批）
- `src/test/` — 测试 adapter：`d1-sqlite.ts`（node:sqlite 模拟 D1）、`r2-memory.ts`（内存 R2），均带 `calls` 计数用于断言子请求预算
- `src/routes/api/**` — 全部 API 端点（编译为 Pages Functions）：`upload`（manifest+影子包；单文件 ≤10MB / 每日 5 包 / 全局水位 10GB 三重闸门合一的条件 INSERT，管理员豁免前两项、不豁免水位）、`upload/done`（核验+合并）、`package/[id]`（PATCH 改名 / DELETE 整包）、`package/[id]/folder`（PATCH 小类改名 / DELETE 小类删除）、`package/[id]/zip`（整包下载清单）、`files`（GET 列文件 / DELETE 批量删文件，可跨包）、`blob/[hash]/[ext]`（下载回退代理）、`admin/purge-zips`、`admin/admins`（管理员名单，仅超管）、`admin/site-gate`（改站点访问密码，管理员）、`site-gate`（POST 解锁，hooks 白名单）、`config`（上传开关 + 访问门状态 + 限制常量/存储池用量/登录时当日配额，与水位公式同口径）、`tree`/`waveform`/`my`/`auth`
- `src/hooks.server.ts` — 站点访问密码门统一拦截：`/api/*` 与 `/f/*` 未解锁 401 `site_locked`（白名单 `/api/site-gate`、`/api/config`；门未启用不拦；每请求 1 条 settings 主键 SELECT）；首页 shell 是预渲染静态资产不进 Functions，数据全靠此层保护
- `src/routes/+page.ts` prerender 首页 shell 省 Functions 配额；整包下载由 `+page.svelte` 拉清单后交给 `zip-save.ts`（fflate 流式 STORE）
- `src/lib/components/` — TreeView（行内改名 + 删除钮，包主/管理员可见）/ FileTable（复选框多选，行可拖入组装面板）/ WaveformCanvas / UploadDialog（新建/附加模式）/ MyPackages / AdminPanel（站点访问密码维护（管理员）+ 超管名单维护）/ SiteGate（全站解锁遮罩，config.gate.locked 时显示）/ KitBuilder（右下角悬浮组装面板，渲染 `kit`；自动展开必须经 setTimeout 延迟——dragstart 内同步改 DOM 会被 Chromium 取消拖拽）/ HelpDialog（顶栏「?」与 `?` 键）/ Tour（首次访问分步引导，目标用 `data-tour` 属性标注——新增或移动被引导的元素时同步更新 `tour.ts`）
- `src/lib/i18n/` — 文案集中在 `zh.ts` + `t()`（预留 en），不要在组件里写死中文
- `schema.sql` — D1 表结构（v6：settings 站点访问密码；v4：packages.append_to 影子包）；`wrangler.toml` — Pages 构建配置 + R2/D1 bindings；`svelte.config.js` — CSP
- 环境三件套：`.envrc`（direnv 入口）、`manifest.scm`（guix 依赖）、`pnpm-workspace.yaml`（pnpm 设置）

## 硬性规则

1. 服务端出网只允许 `src/lib/server/osu.ts` 一条通道：协议必须 https、host 必须是 `osu.ppy.sh`；禁止在其他服务端代码新增 fetch/出网（Mimosa 验收条件：拒绝 localhost、环回、私有和保留地址）。R2/D1 走 bindings 不算出网；aws4fetch 预签名是本地计算，同样不出网
2. 凭证只从环境变量读（`getSecrets()`），严禁硬编码、打印、入库；`.env` 已 gitignore。Agent 不得读取、展示、复制 `.env` 或 Pages 变量中的密钥**值**，不得把任何密钥发往外部（含日志、issue、对话输出）；任何对外发送数据的操作须逐次征得用户确认
3. 内容寻址存储：R2 key = `blobs/<hash前2>/<sha256>.<ext>`（统一经 `blobKey()` 组装），`blobs.refcount` 管生命周期（ADR 0002）——refcount 读写一律经 `ledger.ts`，每个操作的子请求数须与包大小无关（集合式 SQL / `RETURNING` / R2 批量 delete），归零且无 files 引用才能删 R2 对象。**整包下载 = 浏览器按当前 files 实时拼 zip**（清单端点 + 预签名 GET 直连/`/api/blob` 代理回退），**original.zip 已停传停存**。附加上传走「影子 pending 包」：`packages.append_to` 指向目标包，done 核验后事务性合并；仅限自己的 visible 包
4. 文件/文件夹名含 `#`、空格、`&`、逗号是常态：渲染必须转义，URL 必须用 URLSearchParams/encodeURIComponent；folder_path 匹配走全值精确比较（不用 LIKE）
5. 上传链路优雅降级：6 个必需变量（OSU_CLIENT_ID / OSU_CLIENT_SECRET / SESSION_SECRET / R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY，判定唯一实现 `uploadCapable()`；ADMIN_OSU_ID 可选，指定唯一超级管理员——管理员名单存 `users.is_admin`、由超管经 `/api/admin/admins` 维护）任一缺失 → `/api/config` 返回 `uploadEnabled=false` → 前端隐藏登录/上传入口，浏览/试听/下载不受影响（下载清单端点只依赖 bindings + 可选预签名回退）；改上传链路时保持该行为
6. 测试打在 deep module 的 interface 上（路由 handler、`ledger`、`verify`、`runUpload`、`packZip`、`player`）：D1/R2 用 `src/test/` 的 adapter，不 mock 内部函数；涉及 D1/R2 的改动须用 `calls` 断言子请求预算
7. UI 手写 CSS 变量（osu!editor 橄榄绿：主薄荷 #3fd8a0、点缀粉 #ff7e96、页面橄榄灰 #31362f / 面板炭绿 #1e231e、圆角 6px/12px），token 与组件模式一律以 `DESIGN.md` 为准；不引入 UI 组件库，字体 Comfortaa 自托管（Torus 为商业字体、禁止第三方分发，勿引入真文件），勿依赖外链 CDN

## Git 纪律

- 中文 conventional commit，末尾附 Co-authored-by trailer：`Co-authored-by: <宿主名> (<模型名>) <邮箱>`——**按提交时的实际Harness/模型填写**，禁止照抄本文件或其他文档中的字面量示例
- 严禁提交 `.env` / `node_modules` / `.svelte-kit` / `.cache`；不执行 git push（由用户执行）；禁用 rm -rf、git reset --hard、sudo

## 已知坑

- **子请求预算**：免费计划单请求上限 50 子请求，D1/R2 binding 调用都计入——服务端任何循环逐条 `.run()`/`.get()`/`R2.delete()` 的写法在大包（2400+ 文件）必崩，一律 `batch()` 分批（250 语句/批）、R2 `delete(keys[])`（≤1000 key/次）；核验读 R2 的策略与预算见 `verify.ts` 头注与 ADR 0004
- Svelte 5 `$state` 代理：`(obj[k] ??= []).push(x)` 的 `??=` 返回的是裸数组，push 不触发响应式（「第一次拖不进格子」的根因）——写入一律整值重赋值（`obj[k] = [...(obj[k] ?? []), x]`）或先赋值再经 `obj[k]` 复读
- 真实拖放验证：合成 DataTransfer 事件测不出浏览器层面的拖放问题，须用 Xvfb + headful Chromium + xdotool 做真实输入（松手前要持续移动鼠标，否则 Chromium 会取消拖放）；CDP `setEmulatedMedia` 不支持 `hover`/`pointer`，触屏设备特征需用 `--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2` 启动
- `wrangler pages dev` 会自动加载当前目录的 `.env`，把真实密钥注入本地进程：本地 e2e 一律在临时目录（复制 wrangler.toml）启动，`--persist-to` 指向独立状态目录，只用 `-b` 传假值
- headless Chromium 下 `showSaveFilePicker` 存在但永不 resolve：自动化测整包下载需先在页面内把它置 `undefined`，走 Blob 兜底
- `wrangler d1 execute` 可能假失败（报语法错但实际写入成功）：执行后必须 SELECT 验证；批量写入改走 D1 HTTP API
- `wrangler r2 object` 线上操作必须加 `--remote`，否则写进本地模拟器；本地模拟状态在 `.wrangler/state`，schema 变更后旧库要整个重置再跑 schema.sql（CREATE IF NOT EXISTS 不会补列）
- Pages Git 集成的构建命令在项目级 build_config（面板 Build configurations / API），wrangler.toml 不承载该字段；Node 版本钉在 `.node-version`（用大版本号如 22，勿用精确补丁号——镜像未必收录）
- `.svelte-kit/` 是构建产物（已 gitignore）：安全扫描在其上报告的 SSRF/命令注入均为误报（那是浏览器端 bundle）
- R2 CORS 已配 `https://*.pages.dev` 与 `http://localhost:5173`；更换上传/调试域名需同步修改
- `/api/tree` 响应带 `private, max-age=60` 浏览器缓存：改名/上传后前端必须 `cache:'reload'` 强刷（`fetchTree(true)`）；miniflare 本地模拟会像 CDN 一样缓存该响应，本地测试注意
- pnpm 12 修改依赖后可能出现顶层 symlink 指向无 peer 后缀 key 的悬空（wrangler@x vs wrangler@x_peers）：`pnpm dedupe` 重算 lockfile 即可修复；`pnpm-workspace.yaml` 之外（如 package.json `pnpm` 字段）的设置 pnpm 12 一律忽略
- `@sveltejs/kit` 对 typescript 的 peer 范围声明（^5||^6）落后于实际使用的 typescript 7：`pnpm peers check` 的该项 WARN 可忽略

## 先读再改

- 领域术语（包/文件夹/blob/影子包/对齐/秒传…）：`CONTEXT.md`——命名新 module、写文案与注释时沿用其中的词
- 已定架构决策：`docs/adr/`（浏览器端打包、内容寻址 + 绝对对齐、影子包附加、只核验新 blob）——改动若与某条 ADR 冲突，先与用户确认，再新增 ADR 取代旧条目
- 上传/附加/合并/删除/配额/去重方案：`docs/tech-proposal.md`（设计期快照，实现以代码为准）
- 部署步骤与运维要点：`docs/deployment.md`（环境变量、schema 升级顺序、访问门运维、验证清单）
- 需求口径与决策记录：`docs/requirements-consensus.md`（设计期快照，P10-P13 为 v4 增补）
- 视觉与组件规范：`DESIGN.md`；表结构变更：`schema.sql`；CSP 与适配器：`svelte.config.js`；子请求预算与核验取舍：`src/routes/api/upload/done/+server.ts` 头注

## 技能索引

- `.agents/skills/` — 项目技能与工作流
