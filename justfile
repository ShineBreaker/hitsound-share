# hitsound-share 常用命令封装 —— `just` 或 `just --list` 列出全部
# 约定与细节见 AGENTS.md / docs/osucad.md / docs/deployment.md

# 首次进入：装依赖 + 初始化 osucad 子模块 + 初始化本地 D1
setup:
    pnpm install
    git submodule update --init vendor/osucad
    @just db-init

# ── 日常 ────────────────────────────────────────────

# vite dev server（浏览/试听/打包/osz 预览）
dev:
    pnpm dev

# vitest 单测（可带过滤参数：just test src/lib/kit.test.ts）
test *ARGS:
    pnpm test {{ ARGS }}

# Pages 构建产物（.svelte-kit/cloudflare）
build:
    pnpm build

# vite preview 预览构建产物
preview:
    pnpm preview

# 纯静态产物（Tauri frontendDist 消费，docs/desktop.md）：先常规构建再抽取 + CSP 放宽后处理
build-static: build
    node scripts/build-static.mjs

# 本地起静态产物 :8798（跨源联调用；绑定 127.0.0.1 与后端 localhost 形成跨站）
serve-static:
    cd build-static && python3 -m http.server 8798 --bind 127.0.0.1

# 跨源端到端冒烟：托管后端(:8799) + 数据播种 + 静态前端(:8798) + CDP 断言
# 可透传参数：just smoke-cross-origin --keep-servers（跑完保留服务与状态目录供调试）
smoke-cross-origin *ARGS: build build-static
    node scripts/smoke-cross-origin.mjs {{ ARGS }}

# 提交前门禁：单测 + 构建全绿
verify: test build

# 初始化/重置本地 D1 模拟库（schema.sql）
db-init:
    ./node_modules/.bin/wrangler d1 execute hitsound-share-db --local --file schema.sql

# 用构建产物起本地 Functions :8799（临时目录脱离 .env 搜索链 + 假密钥 + 独立状态——见 deployment.md 七节）
pages-dev: build
    #!/usr/bin/env bash
    set -euo pipefail
    TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
    cp wrangler.toml "$TMP/"   # bindings（R2/D1）从 toml 读
    cd "$TMP"                  # cwd 在仓库外 → wrangler 找不到真实 .env
    "{{ justfile_directory() }}/node_modules/.bin/wrangler" pages dev \
      "{{ justfile_directory() }}/.svelte-kit/cloudflare" --port 8799 \
      --persist-to "$TMP/state" \
      -b OSU_CLIENT_ID=dev -b OSU_CLIENT_SECRET=dev \
      -b SESSION_SECRET=dev-secret-0123456789abcdef01234567 \
      -b ADMIN_OSU_ID=1 \
      -b R2_ACCOUNT_ID=dev -b R2_ACCESS_KEY_ID=dev -b R2_SECRET_ACCESS_KEY=dev

# ── osucad 预览（docs/osucad.md）────────────────────

# 初始化 vendor 子模块（.gitmodules 标了 update=none 让 CI 跳过，需 -c 覆盖强制拉取）
osucad-init:
    git -c submodule.vendor/osucad.update=checkout submodule update --init vendor/osucad

# 预览器 dev server（vite source 模式，改 framework/core 源码即时生效）:4201
osucad-dev:
    cd vendor/osucad/apps/hitsound-preview && pnpm dev

# osucad golden 采样测试（真实 osz 对 lazer 语义逐物件比对）
osucad-test:
    cd vendor/osucad/apps/hitsound-preview && pnpm vitest run

# 重建 static/osucad 产物（源码定位：OSUCAD_DIR > vendor/osucad > ../osucad）
osucad-build:
    bash scripts/build-osucad-preview.sh

# CDP 全链路冒烟：自拉起/复用 :4521 dev server，跑完自动收尾
osucad-smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    if curl -sf -o /dev/null http://localhost:4521; then
      echo "· 复用已在 :4521 运行的 dev server"
      exec node scripts/smoke-osucad-preview.mjs
    fi
    # 直接起 vite（绕开 pnpm 壳进程，保证 trap 能杀干净）
    ./node_modules/.bin/vite dev --port 4521 >/tmp/hitsound-share-smoke-dev.log 2>&1 &
    SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT
    for i in $(seq 1 60); do
      curl -sf -o /dev/null http://localhost:4521 && break || sleep 1
    done
    curl -sf -o /dev/null http://localhost:4521 || { echo "dev server 未就绪，日志见 /tmp/hitsound-share-smoke-dev.log"; exit 1; }
    node scripts/smoke-osucad-preview.mjs

# osucad 推了新提交后的一条命令：bump 指针 → 重建产物 → 单测+构建 → 冒烟 → 暂存
osucad-release:
    git -C vendor/osucad pull origin main
    bash scripts/build-osucad-preview.sh
    @just verify
    @just osucad-smoke
    git add vendor/osucad static/osucad static/osucad.build-info.txt
    @echo "—— 指针与产物已暂存，git diff --cached 确认后提交"

# ── 桌面端（docs/desktop.md）────────────────────────

# 桌面开发模式：Tauri 壳拉起 vite dev server（beforeDevCommand 自动起 :5173）
tauri-dev:
    pnpm tauri dev

# 桌面应用打包：静态产物（前置依赖）+ Tauri release 构建（deb；AppImage 在本环境结构性不可打包，见 docs/desktop.md 二节）
# 日志全量落 /tmp/tauri-build.log，控制台收敛尾部 40 行；pipefail 保失败码透传
tauri-build: build-static
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm tauri build 2>&1 | tee /tmp/tauri-build.log | tail -n 40
