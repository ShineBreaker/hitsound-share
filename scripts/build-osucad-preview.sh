#!/usr/bin/env bash
# 构建 osu!cad 实时预览 iframe 产物 → static/osucad/
# 源码在 osucad 仓库 apps/hitsound-preview：默认 vendor/osucad 子模块
# （git submodule update --init 拉取），回落 ../osucad 兄弟 clone，OSUCAD_DIR 可覆盖；
# static/osucad/ 是提交进仓库的构建产物，Pages 随站部署，CI 不需要 nx/pnpm 工具链。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 源码位置：优先 vendor/osucad 子模块（别人 clone 后 submodule update --init 即有），
# 否则回落兄弟目录 ../osucad（自己日常开发 clone），OSUCAD_DIR 可显式覆盖
OSUCAD="${OSUCAD_DIR:-}"
if [ -z "$OSUCAD" ]; then
	if [ -d "$ROOT/vendor/osucad/apps/hitsound-preview" ]; then
		OSUCAD="$ROOT/vendor/osucad"
	elif [ -d "$ROOT/../osucad/apps/hitsound-preview" ]; then
		OSUCAD="$ROOT/../osucad"
	else
		echo "找不到 osucad 源码——执行 git submodule update --init vendor/osucad，" >&2
		echo "或把 osucad clone 到 ../osucad，或用 OSUCAD_DIR 指定" >&2
		exit 1
	fi
fi
APP="$OSUCAD/apps/hitsound-preview"

cd "$APP"
pnpm build

mkdir -p "$ROOT/static"
# 先删再拷保证与 dist 完全一致（环境无 rsync）
[ -d "$ROOT/static/osucad" ] && rm -r "$ROOT/static/osucad"
cp -a "$APP/dist" "$ROOT/static/osucad"

# 溯源：记录实际构建所用的 osucad 源码状态（提交进库，随产物走）
SHA=$(git -C "$OSUCAD" rev-parse HEAD 2>/dev/null || echo unknown)
BRANCH=$(git -C "$OSUCAD" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
REMOTE=$(git -C "$OSUCAD" remote get-url fork 2>/dev/null || git -C "$OSUCAD" remote get-url origin 2>/dev/null || echo unknown)
DIRTY=$(git -C "$OSUCAD" status --porcelain 2>/dev/null | grep -c . || true)
{
  echo "osucad: $REMOTE"
  echo "branch: $BRANCH"
  echo "commit: $SHA"
  echo "uncommitted-changes: $DIRTY"
  echo "built-at: $(date -u +%FT%TZ)"
} > "$ROOT/static/osucad.build-info.txt"
[ "$DIRTY" -gt 0 ] && echo "警告：osucad 工作区有 $DIRTY 处未提交改动，产物包含未提交状态"
echo "已更新 static/osucad/（$(du -sh "$ROOT/static/osucad" | cut -f1)）→ static/osucad.build-info.txt"
