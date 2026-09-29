# AGENTS.md

> 项目协作与工程约定。修改前先读本文件与 README.md，保持改动最小化、沿用现有风格。

## 概述

osu! 铺面音效（hitsound）分享站：浏览、试听（Range 流式 + 波形跳播）、下载（单文件 / 整包 zip）、上传（osu! OAuth + 内容寻址去重秒传）。技术栈 SvelteKit 5 + Cloudflare Pages（Functions）+ R2 + D1，线上 https://hitsound-share.pages.dev。

## 常用命令

- `pnpm dev` / `pnpm build` / `pnpm preview`；无独立 lint/test 脚本，改动后至少跑 `pnpm build` 验证
- Node 版本钉在 `.node-version`（24.18.0），pnpm 钉在 package.json 的 `packageManager`（12.3.4）；只用 pnpm，不用 npm/yarn 安装依赖

## 本地开发与部署

- 本地：`pnpm install` → `cp .env.example .env` 并填入 R2 三项（ACCOUNT_ID / ACCESS_KEY_ID / SECRET_ACCESS_KEY）即可跑通浏览/试听/下载；OAuth 项留空时登录/上传入口自动隐藏
- 部署走 Pages Git 集成：推送 main 分支自动构建，配置全在 `wrangler.toml`（构建命令、输出目录、R2/D1 bindings）
- 运行时需在 Pages 配 7 个 Production 加密变量：`OSU_CLIENT_ID`、`OSU_CLIENT_SECRET`、`SESSION_SECRET`、`ADMIN_OSU_ID`、`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`（`SESSION_SECRET` 用 `openssl rand -hex 32` 生成）
- osu! OAuth 回调地址：`https://<域名>/api/auth/callback`（默认按请求 origin 推导，`OSU_REDIRECT_URI` 一般不用配）
- D1 初始化/变更：执行 `schema.sql`，执行后必须 SELECT 验证（见下文已知坑）

## 目录速览

- `src/lib/server/` — 仅服务端代码：`osu.ts`（唯一出网通道）、`session.ts`（HMAC 签名 cookie）、`media.ts`（R2 Range 流式代理）、`upload.ts`（上传校验/配额）、`env.ts`（密钥读取）、`packages.ts`（包/删除/refcount）
- `src/routes/api/**` — 全部 API 端点（编译为 Pages Functions）；`src/routes/+page.ts` prerender 首页 shell 省 Functions 配额
- `src/lib/components/` — TreeView / FileTable / WaveformCanvas / UploadDialog / MyPackages
- `src/lib/i18n/` — 文案集中在 `zh.ts` + `t()`（预留 en），不要在组件里写死中文
- `schema.sql` — D1 表结构；`wrangler.toml` — Pages 构建配置 + R2/D1 bindings；`svelte.config.js` — CSP

## 硬性规则

1. 服务端出网只允许 `src/lib/server/osu.ts` 一条通道：协议必须 https、host 必须是 `osu.ppy.sh`；禁止在其他服务端代码新增 fetch/出网（Mimosa 验收条件：拒绝 localhost、环回、私有和保留地址）
2. 凭证只从环境变量读（`getSecrets()`），严禁硬编码、打印、入库；`.env` 已 gitignore。Agent 不得读取、展示、复制 `.env` 或 Pages 变量中的密钥**值**，不得把任何密钥发往外部（含日志、issue、对话输出）；任何对外发送数据的操作须逐次征得用户确认
3. 内容寻址存储：R2 key = `blobs/<hash前2>/<sha256>.<ext>`，`blobs.refcount` 管生命周期——删包时 refcount--，归零才能删 R2 对象；整包 zip 在 `packages/<pid>/original.zip`
4. 文件/文件夹名含 `#`、空格、`&`、逗号是常态：渲染必须转义，URL 必须用 URLSearchParams/encodeURIComponent
5. 上传链路优雅降级：7 个环境变量（OSU_CLIENT_ID / OSU_CLIENT_SECRET / SESSION_SECRET / ADMIN_OSU_ID / R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）任一缺失 → `/api/config` 返回 `uploadEnabled=false` → 前端隐藏登录/上传入口，浏览/试听/下载不受影响；改上传链路时保持该行为
6. UI 手写 CSS 变量（osu!lazer Argon：主紫 #8c66ff、点缀粉 #ff66aa、背景 #1b171c/#28222a/#362e38、圆角 5px），不引入 UI 组件库；字体 Exo 2 自托管，勿依赖外链 CDN

## Git 纪律

- 中文 conventional commit，末尾附 `Co-authored-by: ZCode (GLM-5.3) <noreply@z.ai>`
- 严禁提交 `.env` / `node_modules` / `.svelte-kit`；不执行 git push（由用户执行）；禁用 rm -rf、git reset --hard、sudo

## 已知坑

- `wrangler d1 execute` 可能假失败（报语法错但实际写入成功）：执行后必须 SELECT 验证；批量写入改走 D1 HTTP API
- `wrangler r2 object` 操作必须加 `--remote`，否则写进本地模拟器
- `wrangler.toml` 的 `[build] command = "pnpm build"` 是 Pages Git 集成的构建入口，勿删
- `.svelte-kit/` 是构建产物（已 gitignore）：安全扫描在其上报告的 SSRF/命令注入均为误报（那是浏览器端 bundle）
- R2 CORS 已配 `https://*.pages.dev` 与 `http://localhost:5173`；更换上传/调试域名需同步修改

## 先读再改

- 上传/删除/配额/去重方案：`.agents/workfile/main/tech-proposal.md`（只读）
- 需求口径与决策记录：`.agents/workfile/main/requirements-consensus.md`（只读）
- 表结构变更：`schema.sql`；CSP 与适配器：`svelte.config.js`

## 技能索引

- `.agents/skills/` — 项目技能与工作流
