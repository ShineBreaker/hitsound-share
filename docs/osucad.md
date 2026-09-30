# osucad 预览：仓库拓扑与更新工作流

实时预览由本仓库内嵌 `/osucad/` 静态产物提供，源码不在本仓库——在独立的 osucad 仓库里。
本文档说明两仓库的关系、如何改预览、如何构建回拷、以及如何验证。

## 仓库拓扑

```
Projects/osu/
├── hitsound-share            本仓库（SvelteKit + CF Pages）
│   ├── static/osucad/        ← 提交入库的构建产物（Pages 直接部署，勿手改）
│   ├── static/osucad.build-info.txt  ← 本次构建的源码溯源（自动生成）
│   └── scripts/build-osucad-preview.sh / smoke-osucad-preview.mjs
└── osucad                    独立 clone（vite workspace 单仓）
    ├── remote fork  → github.com/ShineBreaker/osucad.git（我们的工作仓库）
    ├── remote origin → github.com/minetoblend/osucad.git（上游，只同步）
    ├── 工作分支 feat/hitsound-preview（fork 推送目标）
    └── apps/hitsound-preview  ← 预览 app 源码
```

- osucad 路径默认取 `<本仓库>/../osucad`，可用 `OSUCAD_DIR=/path/to/osucad` 覆盖
- osucad 的提交推 `fork` 的 `feat/hitsound-preview`；不要推 `origin`（上游不是我们的）
- hitsound-share 不推远端的工作流不变：`static/osucad/` + `build-info.txt` 一起提交即可

## 产物与部署的关系

- `static/osucad/` 是 `apps/hitsound-preview` 的 `vite build` 产物（PixiJS/WebGL2），**已提交入库**——Pages 部署只拿本仓库内容，构建机器不需要 osucad 源码。
- `static/osucad.build-info.txt` 由构建脚本生成，记录 `osucad remote / branch / commit / 未提交改动数 / 构建时间`——想知道某个线上预览是从哪份源码出的，看这个文件。
- 只改 hitsound-share 侧代码**不需要**动 osucad；只有要改预览器行为/贴图/采样语义时才走下面的流程。

## 更新工作流（改预览器）

### 1. 准备

```bash
git clone git@github.com:ShineBreaker/osucad.git ../osucad   # 放到本仓库旁边
cd ../osucad && git checkout feat/hitsound-preview
git remote add origin https://github.com/minetoblend/osucad.git   # 可选：同步上游
pnpm install
```

### 2. 开发与迭代

```bash
cd ../osucad/apps/hitsound-preview && pnpm dev    # http://localhost:4201
```

vite 配了 `resolve.conditions: ["source"]`，workspace 包直接编译 `src/*.ts`，改 framework/core/ruleset-osu 源码即时生效，无需先 build 包。

页面加载谱面走 postMessage 协议：`window.postMessage({type:"hs:load",name,bytes:ArrayBuffer})`
（顶层窗口 `window.parent === window`，自检通过；`hs:update` 同协议热更新）。
调试句柄：`window.__game`（PreviewGame 实例，可 `__game.clock.seek(t)` 定点）。

### 3. 测试

```bash
cd ../osucad/apps/hitsound-preview && pnpm vitest run   # golden 采样测试 6 个
```

`vitest.config.ts` 把 `@osucad/*` 别名到 src，node 环境可跑。golden 测试用真实
.osz（reimei / Curtain Call）逐物件比对 lazer 语义（lookupNames/音量/下标语义），
改采样/解析逻辑必过。

### 4. 构建回拷 + 本仓库验证

```bash
cd ../hitsound-share
bash scripts/build-osucad-preview.sh   # 构建 → 回拷 static/osucad → 写 build-info.txt
pnpm test && pnpm build                # 本仓库回归（必须全绿）
pnpm dev --port 4521 &                 # 冒烟需要 dev server
node scripts/smoke-osucad-preview.mjs  # CDP 全链路冒烟
```

冒烟验证：iframe 装载 → `cad:ready` → `hs:load` → `cad:loaded` → play/`cad:time` →
`cad:stats.hits`（采样命中数）→ 二次导入 `hs:update`（不重载 iframe、保播放位置）→
难度切换 → 音量通道。全绿无 `cad:error` 才算完成。

### 5. 提交（两侧）

osucad 侧推 fork 分支；hitsound-share 侧提交 `static/osucad/` + `build-info.txt`
+ 脚本/文档改动。两端语言保持中文 conventional commit。

## 资产管线

`apps/hitsound-preview/src/`：

- `assets/skin/*.png` — 自绘皮肤贴图。`import.meta.glob` 注入默认皮肤文件系统，
  同名覆盖 `defaults.ts` 里的程序化生成件；未提供的名字（approachcircle/
  reversearrow/sliderendcircle/数字/判定图）保持生成。**注意 vite `assetsInlineLimit`
  默认 4KB：小 PNG 会被内联成 data URL，构建产物里 png 文件比源目录少是正常的。**
- `assets/samples/*.wav` — 默认皮肤采样（ppy/osu-resources legacy 皮肤），
  裸名 `hitnormal.wav` 等自动从 `normal-` 套复制。

皮肤查询分两层（lazer `LegacyBeatmapSkin`/`LegacySkin` 语义）：

- 谱面包层 `BeatmapSkin`：采样按自定义音效组下标过滤（index=0 不读包内文件；
  index≥2 包内只查带后缀名）；纹理按文件存在性回落
- 默认皮肤层 `DefaultSkin`：常驻，提供上面 assets 里的贴图与采样

`SkinProvidingContainer` 嵌套串链；`OsuLegacySkinTransformer` 对 Cursor/CursorTrail/
SliderBall 组件先检查素材存在性，缺则返回 null 走链回落——**给组件加新分支时
必须保持这个「无素材→null」语义，否则会挡住默认层回落**。

## 热更新链路

`cad.svelte.ts`（本站唯一桥）→ iframe `hs:update` 全量字节 → PreviewGame 重建
BeatmapSkin → `sourceChanged` → 所有 SkinnableDrawable/SkinnableSound 重取资源，
不重载 iframe、保播放位置。谱面 .osu 文本不变时复用游玩屏只换皮肤/音轨。

## 调试

- CDP + headless Chromium：`--use-gl=angle --use-angle=gl-egl`（WebGL2 经 llvmpipe），
  **不要 `--disable-gpu`**；`--no-sandbox` 视环境需要；截图 `Page.captureScreenshot`
- dev server（4201）下类名保留，可经 `__game` 遍历 Drawable 树（`children`/
  `internalChildren`）查 `constructor.name === "DrawableSlider"` 等定位组件；
  生产构建类名被压缩，树内验证请用 dev
- 临时探针脚本放 `/tmp`（不要提交仓库），页面侧调试从 `window.__msgs`/`__game` 入手
- `sample miss:` 日志在 `#applyBeatmap` 的统计包装层打印（前 12 条）

## 已知坑

- **vueuse computedAsync 不可用于本项目**：`@vueuse/core` 经 vue@3.5.35 解析到
  `@vue/reactivity@3.5.35`，框架本体是 3.5.34——跨实例依赖追踪失效，异步
  computed 只跑一次且不随依赖重算（SkinTextureStore 动画条目曾因此永远为空）。
  core/framework 里需要异步 computed 时用框架 ref+watch 手写（参考
  `SkinTextureStore.ts` 内注释）。
- `pnpm -r build`/typecheck 走工程引用，需先 build 依赖包（framework → core →
  ruleset-osu → app）；vitest 走别名不经 dist，不受影响
- `static/osucad/` 的产物文件名全部带内容 hash，每次构建大批 rename——
  提交时 `git add -A static/osucad` 即可，不要挑文件
- 部分组件是「代理渲染」（ProxyDrawable + RenderLayer）：源 drawable 离开
  PIXI 树时代理必须 detach，否则 seek 后残留幽灵图像（修过，勿回退）

## 为什么不收 submodule

osucad 不挂 git submodule，理由：

- 部署产物已 vendored（`static/osucad` 提交入库），站点不依赖 osucad 源码可达
- osucad 是**活跃共开发**仓库（独立分支持续演进、常有未提交 WIP），submodule
  指针每次构建都要两仓库同步，且指针 SHA 对 dirty 构建必然撒谎
- `build-info.txt` 记录了实际构建的 remote/branch/sha/dirty，溯源更诚实

若将来出现「第三方需要按 pin 复现构建」或「CI 校验产物==源码」的需求，再评估
submodule（推荐挂 `vendor/osucad` 指 fork 分支）或 subtree。
