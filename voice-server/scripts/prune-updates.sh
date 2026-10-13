#!/usr/bin/env bash
#
# 清理更新目录里过期的安装包。
#
# 为什么旧包可以放心删 —— electron-updater 只会去拉三样东西：
#     latest.yml                    知道最新版本是哪个、文件叫什么、sha512 是多少
#     清单里那个 .exe               下载它
#     清单里那个 .exe 的 .blockmap  差分下载用（和客户端本地的旧文件比对）
#
# 所以**只有当前版本的那三个文件有用**，历史版本一律是死重量：
#   · 客户端不会去下载旧版本
#   · 旧 blockmap 也用不上（差分是拿"新的 blockmap"对"本地的旧文件"）
#
# 用法：
#     bash scripts/prune-updates.sh          # 试运行，只列出会删什么
#     bash scripts/prune-updates.sh --yes    # 真的删
#
set -euo pipefail

DIR="${UPDATES_DIR:-/opt/voice-server/updates}"

if [[ ! -d "$DIR" ]]; then
  echo "目录不存在：$DIR" >&2
  exit 1
fi

cd "$DIR"

if [[ ! -f latest.yml ]]; then
  echo "找不到 $DIR/latest.yml —— 这个目录还没发布过东西？" >&2
  exit 1
fi

# latest.yml 里的 path: 就是当前版本的安装包文件名
KEEP="$(sed -n 's/^path:[[:space:]]*//p' latest.yml | head -1)"

if [[ -z "$KEEP" ]]; then
  echo "latest.yml 里没有 path: 字段，不敢乱删" >&2
  exit 1
fi

if [[ ! -f "$KEEP" ]]; then
  echo "警告：latest.yml 指向的 $KEEP 不在目录里！" >&2
  echo "      先确认发布是不是出问题了，现在什么都没删。" >&2
  exit 1
fi

echo "目录:     $DIR"
echo "当前版本: $KEEP"
echo "总占用:   $(du -sh . | cut -f1)"
echo

# 收集要删的：除了 latest.yml / 当前 exe / 当前 blockmap 之外的都算过期
DEL=()
while IFS= read -r f; do
  # 用显式 if 而不是 `[[ ... ]] && continue`：
  # 后者在 set -e 下是个容易踩的坑（&& 列表整体返回非零）
  if [[ -z "$f" ]]; then
    continue
  fi

  # 目录一律不碰 —— `rm` 删不掉目录会让 set -e 中途退出，删到一半最糟
  if [[ -d "$f" ]]; then
    echo "跳过目录：$f" >&2
    continue
  fi

  case "$f" in
    latest.yml | "$KEEP" | "$KEEP".blockmap) continue ;;
  esac
  DEL+=("$f")
done < <(ls -1)

if [[ ${#DEL[@]} -eq 0 ]]; then
  echo "没有过期文件，目录是干净的。"
  exit 0
fi

echo "过期的（共 ${#DEL[@]} 个）："
for f in "${DEL[@]}"; do
  printf '  %-38s %s\n' "$f" "$(du -h "$f" | cut -f1)"
done
echo

if [[ "${1:-}" != "--yes" ]]; then
  echo "↑ 这是试运行，什么都没删。"
  echo "  确认无误后加 --yes 真的删："
  echo "      bash scripts/prune-updates.sh --yes"
  exit 0
fi

rm -v -- "${DEL[@]}"

echo
echo "清理完成。现在占用：$(du -sh . | cut -f1)"
ls -lh
