# DESIGN.md

> 视觉与交互规范。改 UI 前先读本文件；新增样式只允许消费这里的 token，禁止散落裸色值。
> 参照基准：osu!editor（lazer 系编辑器）橄榄绿界面 —— 页面橄榄灰、炭绿面板浮于其上、薄荷绿主强调。

## 主题定位

- 编辑器气质：深色工具型界面，信息密度高、装饰克制、状态用色收敛
- 层次方向与常见暗色相反：**页面最亮 → 面板更深 → 凹陷区（输入/日志/波形底）最深**，浮起元素（hover/格子/次级按钮）比面板浅
- 主按钮 = 薄荷填充 + 深色文字（编辑器签名样式）；危险/播放指示用粉；谨慎引入第三种强调色

## 色彩 token（`src/app.css` 唯一定义）

| token | 值 | 用途 |
| --- | --- | --- |
| `--accent` | `#3fd8a0` | 薄荷主强调：主按钮填充、选中态、焦点描边、进度条 |
| `--accent-bright` | `#8ceec8` | 高亮文字、悬停态、渐变起点、包名/链接色 |
| `--accent-deep` | `#25a97a` | 按下态、滚动条悬停 |
| `--on-accent` | `#0c1610` | 薄荷填充上的文字/图标（务必用它，不要写死黑色） |
| `--accent-pink` | `#ff7e96` | 播放指示条、危险/破坏性操作、错误、重名警示 |
| `--accent-amber` | `#e8c169` | 次要高亮（处理中徽章等），不与薄荷争主位 |
| `--bg-l1` | `#31362f` | 页面底（橄榄灰） |
| `--bg-l2` | `#1e231e` | 面板/卡片/顶栏/对话框 |
| `--bg-l3` | `#333b33` | 浮起层：hover 底色、格子、次级按钮、分隔线 |
| `--bg-inset` | `#131813` | 凹陷区：输入框、日志盒、拖拽区底 |
| `--text` | `#eef2ec` | 主文字 |
| `--text-dim` | `#a9b2a5` | 次级文字、表格单元格 |
| `--text-faint` | `#76816f` | 弱化文字：节标题、占位、计数 |

分层规则：`color-mix(in srgb, <token> <pct>%, transparent)` 做同族深浅过渡（行 hover、选中底色、徽章底）；跨族混色禁止。分隔线一律用 `--bg-l3` 或其 40%–70% 透明度变体，不引入独立线条色。

## 形状 / 阴影 / 动效

- `--radius: 6px`：控件、按钮、输入、chips、徽章；`--radius-lg: 12px`：面板卡片、对话框、浮层
- 面板/对话框阴影 `0 4px 18px ~ rgb(0 0 0 / .25–.45)`；面板不用显眼边框（至多 `--bg-l3` 60% 透明细边）
- 交互动效：`transition` 只挂 background/color/border-color/opacity，0.15s ease；不做位移动画、不做弹性
- 滚动条：10px 圆角滑块 `--bg-l3`，hover `--accent-deep`
- `::selection` 薄荷 40%；`:focus-visible` 统一 `outline: 2px solid var(--accent)`

## 排版

- 字体：`--font-ui`（Comfortaa 自托管 + 中文系统栈回退；Comfortaa 是 osu! 商业字体 Torus 的 OFL 替代——Torus 授权禁止第三方分发，勿引入真文件），字号基准 14px
- 节标题（面板头/分区块名）：11–12px、700、`letter-spacing: 1.5–2px`、`--text-faint`，文字下方缀 2px 薄荷短下划线（编辑器「颜色」节同款）
- 表格列头：11px、600、`letter-spacing: .08em`、`--text-faint`，sticky 吸顶 `--bg-l2`
- 数字一律 `.tnum`（tabular-nums）纵向对齐

## 组件模式

- **UI 基元唯一实现在 `src/app.css`**：`.btn` / `.btn.primary` / `.btn.danger` / `.btn.err` / `.btn.lg` / `.btn.packing`、`.dialog-mask` / `.dialog-card` / `.dialog-close`、`.skel`；组件只写布局与尺寸微调，不再自带一份按钮/对话框样式
- **面板**：`--bg-l2` 卡片浮于 `--bg-l1` 页面，圆角 `--radius-lg` + 轻阴影
- **按钮三档**：primary 薄荷填充/`--on-accent` 文字；默认透明 ghost（hover `--bg-l3`）；危险走 `--accent-pink`（hover 变边框+文字，填充仅确认后）；失败态 `.err` 粉底，点击即重试
- **进度按钮**：长任务（打包下载）期间按钮加 `.packing`，用 `style:--pct` 驱动 `accent-deep → accent` 填充，文字始终在填充之上
- **对话框**：打开即聚焦首个控件，Esc 关闭（进行中的上传除外）
- **加载骨架**：树与文件表加载中显示 `.skel` 占位条，只做透明度脉动；`prefers-reduced-motion` 下关闭所有循环动画（跳动条、骨架）
- **选中行**：薄荷约 10% 底 + 行首复选框薄荷填充；有选中集时格子描薄荷虚线，精确指针设备（`hover: hover` 且 `pointer: fine`）在格角显示快捷键键帽；入格后格子短暂闪烁（仅过渡底色和描边），结果通过 aria-live 播报
- **新手引导**：聚光框用 `box-shadow: 0 0 0 9999px` 遮罩圈出目标，说明卡片跟随目标定位并限制在视口内，移动端停靠在底部
- **移动端（≤768px）**：单列布局，目录树改为抽屉；文件表隐藏采样率、位深、声道三列；组装面板改为底部面板；≤480px 时 4 列格子必须全部放下，不允许横向滚动；可点区域 ≥28px；FAB 避让 `safe-area-inset-bottom`；触屏上改名按钮常显
- **输入/下拉**：`--bg-inset` 底 + `--bg-l3` 边，focus 描 `--accent`；原生控件由 `:root color-scheme: dark` 接管
- **选中态**：薄荷填充 + `--on-accent` 文字（树节点、分段器）；播放行用薄荷 14% 底 + 左侧 3px 内嵌薄荷条
- **格子（音效组装）**：`--bg-l3` 浮起方格 + 居中「+」，拖入悬停时描薄荷边 + 薄荷 12% 底
- **徽章**：`color-mix(accent 22%, transparent)` 底 + `accent-bright` 文；pending 用 amber
- **播放指示**：三根跳动条用 `--accent-pink`（薄荷海里一眼可辨）
- **波形**：薄荷垂直渐变（bright→accent→bright），已播实色、未播 alpha .45
- **悬浮钮**：薄荷圆钮 + `--on-accent` 图标，角标 `--accent-pink`

## 硬性约束（与 AGENTS.md 互补，不重复其工程条款）

1. 新样式只用本文件 token；确需新色 → 先在 `app.css` 加变量并登记本表
2. 不引入 UI 组件库 / CSS 框架 / 外链字体与 CDN；图标用内联 SVG 或字符
3. 文案一律走 `src/lib/i18n/zh.ts` 的 `t()`，组件内不写死中文
4. 文件名含 `#` ` ` `&` `,` 是常态：渲染靠 Svelte 插值转义，URL 用 encodeURIComponent/URLSearchParams
5. 图形/画布色值也要走 token：canvas 里必须读 `getComputedStyle` 取变量或集中常量，不散落 hex
