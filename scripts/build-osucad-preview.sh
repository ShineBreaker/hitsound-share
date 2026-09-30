#!/usr/bin/env bash
# 构建 osu!cad 实时预览 iframe 产物 → static/osucad/
# 源码在 osucad 仓库 apps/hitsound-preview（默认 ../osucad，OSUCAD_DIR 可覆盖）；
# static/osucad/ 是提交进仓库的构建产物，Pages 随站部署，CI 不需要 nx/pnpm 工具链。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OSUCAD="${OSUCAD_DIR:-$ROOT/../osucad}"
APP="$OSUCAD/apps/hitsound-preview"

if [ ! -d "$APP" ]; then
	echo "找不到 $APP —— 请先 clone osucad 到 $OSUCAD（或设 OSUCAD_DIR）" >&2
	exit 1
fi

cd "$APP"
pnpm build

mkdir -p "$ROOT/static"
# 先删再拷保证与 dist 完全一致（环境无 rsync）
[ -d "$ROOT/static/osucad" ] && rm -r "$ROOT/static/osucad"
cp -a "$APP/dist" "$ROOT/static/osucad"
echo "已更新 static/osucad/（$(du -sh "$ROOT/static/osucad" | cut -f1)）"
