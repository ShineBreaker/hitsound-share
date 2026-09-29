# AGENTS.md

> 项目协作与工程约定。修改前先读本文件与 README.md，保持改动最小化、沿用现有风格。

## 概述

osu! 铺面音效（hitsound）分享站：浏览、试听（Range 流式 + 波形跳播）、下载（单文件 / 整包按当前内容实时打包）、上传（osu! OAuth + 内容寻址去重秒传 + 附加到现有分组）、大类/小类在线改名。技术栈 SvelteKit 5 + Cloudflare Pages（Functions）+ R2 + D1，线上 https://hitsound-share.pages.dev。

## 常用命令

- `pnpm dev` / `pnpm build` / `pnpm preview`；无独立 lint/test 脚本，改动后至少跑 `pnpm build` 验证
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
- 运行时需在 Pages 配 7 个 Production 加密变量：`OSU_CLIENT_ID`、`OSU_CLIENT_SECRET`、`SESSION_SECRET`、`ADMIN_OSU_ID`、`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`（`SESSION_SECRET` 用 `openssl rand -hex 32` 生成）
- osu! OAuth 回调地址：`https://<域名>/api/auth/callback`（默认按请求 origin 推导，`OSU_REDIRECT_URI` 一般不用配）
- D1 初始化/变更：执行 `schema.sql`，执行后必须 SELECT 验证（见下文已知坑）；线上库 v3→v4 需先执行 `ALTER TABLE packages ADD COLUMN append_to TEXT;` 再部署代码
- 存量 original.zip 清理（v4 停传后的一次性动作）：admin 登录后 `POST /api/admin/purge-zips`，重复调用至 `remaining: 0`

## 目录速览

- `src/lib/server/` — 仅服务端代码：`osu.ts`（唯一出网通道）、`session.ts`（HMAC 签名 cookie）、`media.ts`（R2 key/Range/流式代理）、`upload.ts`（manifest 校验/配额/预签名 PUT+GET/魔数核验）、`env.ts`（密钥读取）、`packages.ts`（包治理：权限守卫/删除/refcount 对齐/懒清理）
- `src/routes/api/**` — 全部 API 端点（编译为 Pages Functions）：`upload`（manifest+影子包）、`upload/done`（核验+合并）、`package/[id]`（PATCH 改名 / DELETE）、`package/[id]/folder`（小类改名）、`package/[id]/zip`（整包下载清单）、`blob/[hash]/[ext]`（下载回退代理）、`admin/purge-zips`、`tree`/`files`/`waveform`/`my`/`auth`/`config`
- `src/routes/+page.ts` prerender 首页 shell 省 Functions 配额；整包下载在 `+page.svelte` 浏览器端实时拼 zip（fflate 流式 STORE）
- `src/lib/components/` — TreeView（含行内改名）/ FileTable / WaveformCanvas / UploadDialog（新建/附加模式）/ MyPackages
- `src/lib/i18n/` — 文案集中在 `zh.ts` + `t()`（预留 en），不要在组件里写死中文
- `schema.sql` — D1 表结构（v4：packages.append_to 影子包）；`wrangler.toml` — Pages 构建配置 + R2/D1 bindings；`svelte.config.js` — CSP
- 环境三件套：`.envrc`（direnv 入口）、`manifest.scm`（guix 依赖）、`pnpm-workspace.yaml`（pnpm 设置）

## 硬性规则

1. 服务端出网只允许 `src/lib/server/osu.ts` 一条通道：协议必须 https、host 必须是 `osu.ppy.sh`；禁止在其他服务端代码新增 fetch/出网（Mimosa 验收条件：拒绝 localhost、环回、私有和保留地址）。R2/D1 走 bindings 不算出网；aws4fetch 预签名是本地计算，同样不出网
2. 凭证只从环境变量读（`getSecrets()`），严禁硬编码、打印、入库；`.env` 已 gitignore。Agent 不得读取、展示、复制 `.env` 或 Pages 变量中的密钥**值**，不得把任何密钥发往外部（含日志、issue、对话输出）；任何对外发送数据的操作须逐次征得用户确认
3. 内容寻址存储：R2 key = `blobs/<hash前2>/<sha256>.<ext>`（统一经 `blobKey()` 组装），`blobs.refcount` 管生命周期——done 用全表绝对对齐（= 全库 visible 包引用数），删除/清理按涉及 hash 对齐，归零才能删 R2 对象。**整包下载 = 浏览器按当前 files 实时拼 zip**（清单端点 + 预签名 GET 直连/`/api/blob` 代理回退），**original.zip 已停传停存**。附加上传走「影子 pending 包」：`packages.append_to` 指向目标包，done 核验后事务性合并；仅限自己的 visible 包
4. 文件/文件夹名含 `#`、空格、`&`、逗号是常态：渲染必须转义，URL 必须用 URLSearchParams/encodeURIComponent；folder_path 匹配走全值精确比较（不用 LIKE）
5. 上传链路优雅降级：7 个环境变量（OSU_CLIENT_ID / OSU_CLIENT_SECRET / SESSION_SECRET / ADMIN_OSU_ID / R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）任一缺失 → `/api/config` 返回 `uploadEnabled=false` → 前端隐藏登录/上传入口，浏览/试听/下载不受影响（下载清单端点只依赖 bindings + 可选预签名回退）；改上传链路时保持该行为
6. UI 手写 CSS 变量（osu!lazer Argon：主紫 #8c66ff、点缀粉 #ff66aa、背景 #1b171c/#28222a/#362e38、圆角 5px），不引入 UI 组件库；字体 Exo 2 自托管，勿依赖外链 CDN

## Git 纪律

- 中文 conventional commit，末尾附 Co-authored-by trailer：`Co-authored-by: <宿主名> (<模型名>) <noreply@z.ai>`——**按提交时的实际宿主/模型填写**，禁止照抄本文件或其他文档中的字面量示例
- 严禁提交 `.env` / `node_modules` / `.svelte-kit` / `.cache`；不执行 git push（由用户执行）；禁用 rm -rf、git reset --hard、sudo

## 已知坑

- **子请求预算**：免费计划单请求上限 50 子请求，D1/R2 binding 调用都计入——服务端任何循环逐条 `.run()`/`.get()` 的写法在大包（2400+ 文件）必崩，一律 `batch()` 分批（250 语句/批）；核验类读 R2 用 `list` 前缀分页（1000 对象/次），逐对象 head+get 只允许小额抽查（参考 `upload/done` 的预算注释）
- `wrangler d1 execute` 可能假失败（报语法错但实际写入成功）：执行后必须 SELECT 验证；批量写入改走 D1 HTTP API
- `wrangler r2 object` 线上操作必须加 `--remote`，否则写进本地模拟器；本地模拟状态在 `.wrangler/state`，schema 变更后旧库要整个重置再跑 schema.sql（CREATE IF NOT EXISTS 不会补列）
- Pages Git 集成的构建命令在项目级 build_config（面板 Build configurations / API），wrangler.toml 不承载该字段；Node 版本钉在 `.node-version`（用大版本号如 22，勿用精确补丁号——镜像未必收录）
- `.svelte-kit/` 是构建产物（已 gitignore）：安全扫描在其上报告的 SSRF/命令注入均为误报（那是浏览器端 bundle）
- R2 CORS 已配 `https://*.pages.dev` 与 `http://localhost:5173`；更换上传/调试域名需同步修改
- `/api/tree` 响应带 `private, max-age=60` 浏览器缓存：改名/上传后前端必须 `cache:'reload'` 强刷（`fetchTree(true)`）；miniflare 本地模拟会像 CDN 一样缓存该响应，本地测试注意
- pnpm 12 修改依赖后可能出现顶层 symlink 指向无 peer 后缀 key 的悬空（wrangler@x vs wrangler@x_peers）：`pnpm dedupe` 重算 lockfile 即可修复；`pnpm-workspace.yaml` 之外（如 package.json `pnpm` 字段）的设置 pnpm 12 一律忽略
- `@sveltejs/kit` 对 typescript 的 peer 范围声明（^5||^6）落后于实际使用的 typescript 7：`pnpm peers check` 的该项 WARN 可忽略

## 先读再改

- 上传/附加/合并/删除/配额/去重方案：`docs/tech-proposal.md`（设计期快照，实现以代码为准）
- 需求口径与决策记录：`docs/requirements-consensus.md`（设计期快照，P10-P13 为 v4 增补）
- 表结构变更：`schema.sql`；CSP 与适配器：`svelte.config.js`；子请求预算与核验取舍：`src/routes/api/upload/done/+server.ts` 头注

## 技能索引

- `.agents/skills/` — 项目技能与工作流
