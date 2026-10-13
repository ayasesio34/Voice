#!/usr/bin/env bash
#
# 安装 systemd 服务：让 LiveKit 和后端开机自启、崩溃自动重启。
#
# 用法：sudo ./scripts/install-services.sh
#
# 为什么需要这一步：不用 systemd 的话只能用 nohup 起临时进程，
# 服务器一重启就全没了，而且重启后没人知道原来跑的是什么命令。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\033[0;36m[services]\033[0m %s\n' "$*"; }
ok()   { printf '\033[0;32m  ✓\033[0m %s\n' "$*"; }
die()  { printf '\033[0;31m[fatal]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "需要 root：sudo ./scripts/install-services.sh"

# ── 前置检查 ────────────────────────────────────────────────
NODE_BIN="$(command -v node || true)"
LK_BIN="$(command -v livekit-server || true)"

[ -n "$NODE_BIN" ] || die "找不到 node。先按 开始操作.md 第 2 步安装 Node"
[ -n "$LK_BIN" ]   || die "找不到 livekit-server。先按 开始操作.md 第 1 步安装 LiveKit"
[ -f "$ROOT/.env" ]             || die "找不到 .env，先跑 sudo ./scripts/init.sh"
[ -f "$ROOT/livekit/livekit.yaml" ] || die "找不到 livekit/livekit.yaml"

ok "node            = $NODE_BIN ($("$NODE_BIN" -v))"
ok "livekit-server  = $LK_BIN ($("$LK_BIN" --version 2>/dev/null || echo '?'))"

# ── 写 unit 文件 ────────────────────────────────────────────
say "写入 /etc/systemd/system/livekit.service"
cat > /etc/systemd/system/livekit.service <<EOF
[Unit]
Description=LiveKit Server (SFU)
Documentation=https://docs.livekit.io
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${LK_BIN} --config ${ROOT}/livekit/livekit.yaml
Restart=always
RestartSec=3
# 每个 WebRTC 参与者要开若干 socket，默认 1024 不够
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

say "写入 /etc/systemd/system/voice-backend.service"
cat > /etc/systemd/system/voice-backend.service <<EOF
[Unit]
Description=Voice Backend (LiveKit token + text chat)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}/backend
EnvironmentFile=${ROOT}/.env
Environment=NODE_ENV=production
ExecStart=${NODE_BIN} src/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# ── 清掉可能残留的 nohup 临时进程（否则端口冲突起不来）──────
say "清理临时进程…"
pkill -f "livekit-server --config" 2>/dev/null || true
pkill -f "node src/index.js"       2>/dev/null || true
sleep 2

# ── 启用 ────────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable --now livekit voice-backend
sleep 3

echo
say "状态："
systemctl --no-pager -l status livekit voice-backend 2>/dev/null \
  | grep -E '^(●|.*Loaded:|.*Active:)' | sed 's/^/    /' || true

echo
ok "完成。以后服务器重启，这两个服务会自己起来。"
echo
echo "  看日志：  journalctl -u livekit -f"
echo "            journalctl -u voice-backend -f"
echo "  重启：    systemctl restart livekit voice-backend"
echo "  体检：    ./scripts/selfcheck.sh"
echo
