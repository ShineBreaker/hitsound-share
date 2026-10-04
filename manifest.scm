;; 开发环境依赖（direnv 经 .envrc 的 use guix -m 加载）
;; Node 大版本与 .node-version（Pages 构建镜像钉住的大版本）保持一致；
;; pnpm 由 Node 自带的 corepack 按 package.json 的 packageManager 精确版本提供
;; （guix 未收录 pnpm，且 guix store 只读无法 corepack enable 到系统路径，
;;  shim 落在本仓库 .cache/bin，见 .envrc）
;; 桌面壳（src-tauri/，docs/desktop.md）构建依赖：
;; rust + rust:cargo：Rust 工具链（cargo 1.93 实测可用）
;; pkg-config：定位 webkit2gtk-4.1 的编译/链接参数（tauri 构建脚本必需）
;; webkitgtk-for-gtk3：Tauri 2 Linux WebView，连带 javascriptcoregtk-4.1 / gtk+-3.0 / libsoup-3.0
;; xz：补 liblzma.pc——gdk-pixbuf 的 private 依赖链（libtiff-4 → liblzma）需要它，
;;     缺失时 pkg-config 0.29.2 解析 gdk-3.0 整链失败，tauri 构建脚本找不到 GDK
;; librsvg：提供 rsvg-convert（static/favicon.svg 转位图，图标源生成）
(specifications->manifest
 (list "node"
       "rust"
       "rust:cargo"
       "pkg-config"
       "webkitgtk-for-gtk3"
       "xz"
       "librsvg"))
