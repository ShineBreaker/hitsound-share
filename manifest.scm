;; 开发环境依赖（direnv 经 .envrc 的 use guix -m 加载）
;; Node 大版本与 .node-version（Pages 构建镜像钉住的大版本）保持一致；
;; pnpm 由 Node 自带的 corepack 按 package.json 的 packageManager 精确版本提供
;; （guix 未收录 pnpm，且 guix store 只读无法 corepack enable 到系统路径，
;;  shim 落在本仓库 .cache/bin，见 .envrc）
(specifications->manifest (list "node"))
