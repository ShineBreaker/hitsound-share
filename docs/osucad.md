# osucad 预览：仓库拓扑与更新工作流

实时预览由本仓库内嵌 `/osucad/` 静态产物提供，源码在独立的 osucad 仓库里，
以 **git submodule** 收在 `vendor/osucad`，方便一次 clone 拿到全部源码。

## 仓库拓扑

```
hitsound-share                本仓库（SvelteKit + CF Pages）
├── vendor/osucad             ← submodule → github.com/ShineBreaker/osucad.git
│   └── 分支 main（指针钉在某个 commit，见 git submodule status）
├── static/osucad/            ← 提交入库的构建产物（Pages 直接部署，勿手改）
├── static/osucad.build-info.txt  ← 本次构建的源码溯源（自动生成）
└── scripts/build-osucad-preview.sh / smoke-osucad-preview.mjs
```

osucad 侧远端：

- `fork`/默认 remote → `github.com/ShineBreaker/osucad.git`（我们的工作仓库）
- 上游 `minetoblend/osucad` 只用于同步，**不要推**
- 工作分支固定 `main`（fork 上的工作主线，历史从 `feat/hitsound-preview` 合并而来）

构建脚本找源码的顺序：`OSUCAD_DIR` 环境变量 → `vendor/osucad` 子模块 →
`../osucad` 兄弟 clone。日常开发建议在旁边单独 clone 一份 osucad 随便折腾，
发版构建用 vendor 里的钉住版本（或先 bump 指针再构建）。

## 克隆与部署

```bash
# 只部署（直接用已提交的 static/osucad 产物）：什么都不用做
git clone <repo> && pnpm install && pnpm build

# 要改预览器/重建产物：连子模块一起拉
git clone --recurse-submodules <repo>
# 或已 clone：git submodule update --init vendor/osucad
```

Cloudflare Pages 部署**不需要**子模块——产物已随库提交，Pages 不初始化
submodule 也没影响。

## 更新工作流（改预览器）

> 以下每步都有 justfile 封装（`just` 列出）：`just osucad-dev` / `just osucad-test` /
> `just osucad-build` / `just osucad-smoke`（自拉起 dev server 跑完自动收尾）。
> osucad 推了新提交后要同步到本站，一条命令走全流程：`just osucad-release`
> （bump 子模块指针 → 重建产物 → 单测+构建 → 冒烟 → 暂存待提交）。

### 1. 源码就位

二选一：

```bash
git submodule update --init vendor/osucad     # 用库内钉住的版本
# 或自己 clone 到旁边，开发更自由：
git clone git@github.com:ShineBreaker/osucad.git ../osucad   # main 即工作分支
```

`cd <osucad> && pnpm install`

### 2. 开发与迭代

```bash
cd <osucad>/apps/hitsound-preview && pnpm dev    # http://localhost:4201
```

vite 配了 `resolve.conditions: ["source"]`，workspace 包直接编译 `src/*.ts`，
改 framework/core/ruleset-osu 源码即时生效，无需先 build 包。

页面加载谱面走 postMessage 协议：`window.postMessage({type:"hs:load",name,bytes:ArrayBuffer})`
（顶层窗口 `window.parent === window`，自检通过；`hs:update` 同协议热更新）。
调试句柄：`window.__game`（PreviewGame 实例，可 `__game.clock.seek(t)` 定点）。

### 3. 测试

```bash
cd <osucad>/apps/hitsound-preview && pnpm vitest run   # golden 采样测试
```

`vitest.config.ts` 把 `@osucad/*` 别名到 src，node 环境可跑。golden 测试用真实
.osz（reimei / Curtain Call）逐物件比对 lazer 语义（lookupNames/音量/下标语义），
改采样/解析逻辑必过。

### 4. 构建回拷 + 本仓库验证

```bash
cd hitsound-share
bash scripts/build-osucad-preview.sh   # 构建 → 回拷 static/osucad → 写 build-info.txt
pnpm test && pnpm build                # 本仓库回归（必须全绿）
pnpm dev --port 4521 &                 # 冒烟需要 dev server
node scripts/smoke-osucad-preview.mjs  # CDP 全链路冒烟
```

冒烟验证：iframe 装载 → `cad:ready` → `hs:load` → `cad:loaded` → play/`cad:time` →
`cad:stats.hits`（采样命中数）→ 二次导入 `hs:update`（不重载 iframe、保播放位置）→
难度切换 → 音量通道。全绿无 `cad:error` 才算完成。

### 5. 提交与指针同步（两侧）

- osucad 侧：提交并推 fork `main`
- hitsound-share 侧：提交 `static/osucad/` + `static/osucad.build-info.txt` +
  脚本/文档改动
- **若 osucad 推了新提交**，顺手 bump 子模块指针保持一致：
  `git -C vendor/osucad pull origin main`（或 checkout 目标 sha），
  然后 `git add vendor/osucad` 提交指针

`build-info.txt` 记录的是**实际构建所用源码**（remote/branch/sha/dirty），
子模块指针记录的是**库内钉住的版本**——两者语义不同：开发期可以不一致
（用兄弟 clone 构建时 dirty 会如实记进去），发版时应保持指针==构建源。

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

## submodule 使用注意

- 指针与构建产物可能短暂不一致（比如在兄弟 clone 里构建过但还没推/没 bump）——
  以 `build-info.txt` 为构建真相，指针为「库内钉住版本」，发版前对齐
- `git submodule update --remote` 会把 vendor 拉到 `main` 最新，
  再 `git add vendor/osucad` 提交新指针；配合 `build-osucad-preview.sh` 重建产物
- 子模块内做开发也可以，但注意 git 的 detached HEAD 习惯（先
  `git checkout main` 再动手）；改完记得：osucad 推远端 →
  本仓库 bump 指针 → 重建产物，三步缺一不可
