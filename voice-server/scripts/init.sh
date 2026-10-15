#!/usr/bin/env bash
#
# 一键初始化。做四件事：
#   1. 生成随机密钥，写入 .env 和 livekit/livekit.yaml
#   2. 自动探测公网 IP，写入 livekit.yaml 的 node_ip（阿里云 ECS 必须显式指定）
#   3. 加 2 GiB swap（阿里云 Ubuntu 镜像默认没有，2 GiB 内存机器上很关键）
#   4. 调内核 UDP 缓冲区（高码率媒体必需）
#
# 用法：sudo ./scripts/init.sh
#
# 如果报 "bad interpreter: /bin/bash^M"，说明脚本被 Windows 的换行符污染了：
#   sed -i 's/\r$//' scripts/*.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log()  { printf '\033[0;36m[init]\033[0m %s\n' "$*"; }
ok()   { printf '\033[0;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m  !\033[0m %s\n' "$*"; }
die()  { printf '\033[0;31m[fatal]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "需要 root：sudo ./scripts/init.sh"
command -v openssl >/dev/null || die "缺少 openssl"
command -v node >/dev/null || die "找不到 node。先按 开始操作.md 第 2 步安装 Node"
command -v livekit-server >/dev/null || die "找不到 livekit-server。先按 开始操作.md 第 1 步安装"
[ -f .env.example ]        || die "找不到 .env.example，确认在 voice-server 目录下"
[ -f livekit/livekit.yaml ] || die "找不到 livekit/livekit.yaml"

# 注意：本项目不使用 Docker。LiveKit 和 Node 都是官方二进制 + systemd 直接跑，
# 因为国内从 Docker Hub 拉镜像经常失败（unexpected EOF），而官方二进制只有 18 MB。

YAML=livekit/livekit.yaml

# ─────────────────────────────────────────────────────────────
# 1. 探测公网 IP
# ─────────────────────────────────────────────────────────────
detect_public_ip() {
  local ip=""
  # 阿里云元数据服务：不依赖外网，最可靠
  for p in public-ipv4 eipv4; do
    ip="$(curl -s --max-time 3 "http://100.100.100.200/latest/meta-data/${p}" 2>/dev/null || true)"
    if [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then echo "$ip"; return; fi
  done
  # 退而求其次
  # ⚠️ 先试**国内可达**的源，再退回国外源。
  #    原因：国内服务器（尤其不能挂代理的）访问 api.ipify.org / ifconfig.me
  #    经常超时 ✓ 探测失败会直接导致 node_ip 写不进去 ✓ 客户端就永远连不上 ✗
  for u in https://ip.3322.net https://myip.ipip.net/s https://api.ipify.org https://ifconfig.me/ip https://ipinfo.io/ip; do
    ip="$(curl -s --max-time 5 "$u" 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1 || true)"
    if [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then echo "$ip"; return; fi
  done
  echo ""
}

log "探测公网 IP…"
PUBLIC_IP="$(detect_public_ip)"
if [ -n "$PUBLIC_IP" ]; then
  ok "公网 IP = $PUBLIC_IP"
else
  warn "探测失败。稍后请手动确认 $YAML 里的 node_ip"
fi

# ─────────────────────────────────────────────────────────────
# 2. 生成 .env
# ─────────────────────────────────────────────────────────────
if [ -f .env ]; then
  ok ".env 已存在，保留现有配置"
else
  log "生成随机密钥…"
  API_KEY="LK$(openssl rand -hex 8)"
  API_SECRET="$(openssl rand -hex 32)"
  INVITE="$(openssl rand -hex 6)"

  # ⚠️ 注意下面 LIVEKIT_URL 那条：**只替换 IP，保留原来的端口** ✗
  #    为什么：NAT 型机器上服务商规定公网端口只能用某个范围（比如 17705-17709）✓
  #    于是 .env.example 里写的是 ws://IP:17707 ✓
  #    而原来的写法把端口写死成 7880 ✗ → 客户端拿到的信令地址就错了 → 连不上 ✗
  #
  #    ⚠️ 注释必须写在 sed 命令**外面** ✗
  #       写在 -e 续行中间的话，bash 的 `\` 续行会把 # 之后全部注释掉 ✓
  #       连 -e 参数和输入文件都没了 ✗ 而 `bash -n` 检查不出来（语法是合法的 ✓）
  sed -e "s|^LIVEKIT_API_KEY=.*|LIVEKIT_API_KEY=${API_KEY}|" \
      -e "s|^LIVEKIT_API_SECRET=.*|LIVEKIT_API_SECRET=${API_SECRET}|" \
      -e "s|^INVITE_CODE=.*|INVITE_CODE=${INVITE}|" \
      -e "s|^LIVEKIT_URL=ws://[^:]*:\([0-9]*\)|LIVEKIT_URL=ws://${PUBLIC_IP:-你的公网IP}:\1|" \
      .env.example > .env

  chmod 600 .env
  ok ".env 已生成"
# ── 频道主是谁 ────────────────────────────────────────────
  # ⚠️ 两种模式行为**不一样** ✗ 说清楚免得踩：
  #    填了名字 → 第一个用**这个昵称**连的人成为频道主 ✓ 结果确定 ✓
  #    留空     → **第一个连上来的任何人**成为频道主 ✗ 谁手快是谁 ✓
  #              （容易被临时连接抢先 ✓ 比如用 tools/test-page 试一下 ✓）
  OWNER_NOW="$(grep -oP '^OWNER_NAME=\K.*' .env 2>/dev/null || true)"
  if [ -z "$OWNER_NOW" ]; then
    warn "OWNER_NAME 是空的 —— 频道主采用「先到先得」✗"
    warn "  **第一个连上来的人会成为频道主** ✓ 建议填一个名字让结果确定 ✓"
    warn "  填法：sudo sed -i 's|^OWNER_NAME=.*|OWNER_NAME=你的昵称|' .env"
    warn "        sudo systemctl restart voice-backend"
    warn "  已经有人抢先了的话：node backend/src/fix-member.mjs promote <你的 userId>"
  else
    ok "OWNER_NAME = ${OWNER_NOW}（第一个用这个昵称连上来的人会成为频道主 ✓）"
  fi
fi

# 读回来（也支持你手动改过的情况）
set -a
# shellcheck disable=SC1091
. ./.env
set +a

[ -n "${LIVEKIT_API_KEY:-}" ]    || die ".env 里 LIVEKIT_API_KEY 为空"
[ -n "${LIVEKIT_API_SECRET:-}" ] || die ".env 里 LIVEKIT_API_SECRET 为空"
[ -n "${INVITE_CODE:-}" ]        || die ".env 里 INVITE_CODE 为空"

# ─────────────────────────────────────────────────────────────
# 3. 把密钥写进 livekit.yaml
# ─────────────────────────────────────────────────────────────
if grep -q 'REPLACE_API_KEY' "$YAML"; then
  # 用 | 做分隔符，避免 secret 里出现特殊字符时被 sed 吃掉
  sed -i "s|REPLACE_API_KEY|${LIVEKIT_API_KEY}|g; s|REPLACE_API_SECRET|${LIVEKIT_API_SECRET}|g" "$YAML"
  ok "livekit.yaml 密钥已写入"
elif grep -qF "${LIVEKIT_API_KEY}" "$YAML"; then
  ok "livekit.yaml 密钥与 .env 一致"
else
  warn "livekit.yaml 里的密钥和 .env 不一致，token 会校验失败！"
  warn "请把 $YAML 的 keys: 段改成这一行（注意缩进是两个空格）："
  warn "  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}"
fi

# ─────────────────────────────────────────────────────────────
# 4. node_ip（阿里云 ECS 必须显式指定，否则客户端永远连不上）
# ─────────────────────────────────────────────────────────────
CUR_IP="$(grep -oP '^\s*node_ip:\s*\K[0-9.]+' "$YAML" 2>/dev/null | head -1 || true)"
if [ -n "$PUBLIC_IP" ]; then
  if [ "$CUR_IP" != "$PUBLIC_IP" ]; then
    sed -i "s|^\(\s*\)node_ip: .*|\1node_ip: ${PUBLIC_IP}|" "$YAML"
    ok "node_ip 已更新：${CUR_IP:-（空）} → ${PUBLIC_IP}"
  else
    ok "node_ip 正确（${PUBLIC_IP}）"
  fi
else
  warn "无法自动确认公网 IP。当前 node_ip = ${CUR_IP:-（空）}，请自行核对 $YAML"
fi

chmod 600 "$YAML"
ok "livekit.yaml 权限已设为 600"

# ─────────────────────────────────────────────────────────────
# 5. swap（2 GiB 内存机器上，这是防 OOM 的保险）
# ─────────────────────────────────────────────────────────────
if swapon --show 2>/dev/null | grep -q .; then
  ok "swap 已存在，跳过"
else
  log "添加 2 GiB swap…"
  if ! fallocate -l 2G /swapfile 2>/dev/null; then
    dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  fi
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "swap 已启用并写入 /etc/fstab"
fi

# ─────────────────────────────────────────────────────────────
# 6. 内核参数
# ─────────────────────────────────────────────────────────────
log "写入内核参数…"
cat > /etc/sysctl.d/99-voice.conf <<'EOF'
# ── 自建语音服务端调优 ──────────────────────────────────────
# WebRTC 高码率媒体（1080p60 ≈ 8 Mbps）需要更大的 socket 缓冲区，
# 否则接收端来不及读就会丢包，表现为画面卡顿和马赛克。
net.core.rmem_max = 26214400
net.core.wmem_max = 26214400
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576

# 每个连接排队的最大数据包数，突发流量下减少丢包
net.core.netdev_max_backlog = 5000

# 2 GiB 内存机器：降低 swap 倾向，避免把热数据换出去
vm.swappiness = 10
EOF
sysctl --system >/dev/null 2>&1 || warn "sysctl 应用失败，重启后会自动生效"
ok "已写入 /etc/sysctl.d/99-voice.conf"

# ─────────────────────────────────────────────────────────────
# 7. 数据目录
# ─────────────────────────────────────────────────────────────
mkdir -p data
ok "data/ 已就绪"

# ─────────────────────────────────────────────────────────────
# 完成
# ─────────────────────────────────────────────────────────────
cat <<EOF

────────────────────────────────────────────────────────
  初始化完成
────────────────────────────────────────────────────────

  API Key     : ${LIVEKIT_API_KEY}
  邀请码      : ${INVITE_CODE}
  信令地址    : ${LIVEKIT_URL}
  node_ip     : $(grep -oP '^\s*node_ip:\s*\K[0-9.]+' "$YAML" 2>/dev/null | head -1 || echo '（未设置）')

  ⚠️  邀请码是客户端接入的唯一口令，别贴到公开的地方。

  下一步：

    sudo ./scripts/install-services.sh     # 装成 systemd 服务（开机自启）
    ./scripts/selfcheck.sh                 # 体检

  记得在阿里云安全组放行：
    22/tcp, 7880/tcp, 7881/tcp, 7882-7885/udp, 3005/tcp

  注意后端端口是 3005，不是 3000
  （这台机器上 3000/3001 被原有的 Haven 占用了）。

────────────────────────────────────────────────────────
EOF
