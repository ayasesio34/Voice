#!/usr/bin/env bash
#
# 服务端体检。任何时候出问题，先跑这个。
#
# 用法：sudo ./scripts/selfcheck.sh
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -t 1 ]; then
  G=$'\033[0;32m'; R=$'\033[0;31m'; Y=$'\033[0;33m'; C=$'\033[0;36m'; N=$'\033[0m'; B=$'\033[1m'
else
  G=; R=; Y=; C=; N=; B=
fi

PASS=0; FAIL=0; WARN=0
pass() { printf "  ${G}✓${N} %s\n" "$*"; PASS=$((PASS+1)); }
fail() { printf "  ${R}✗${N} %s\n" "$*"; FAIL=$((FAIL+1)); }
warn() { printf "  ${Y}!${N} %s\n" "$*"; WARN=$((WARN+1)); }
# ⚠️ 函数名不要叫 head —— 会覆盖同名命令，后面 grep | head -1 就废了
section() { printf "\n${B}${C}%s${N}\n" "$*"; }

YAML=livekit/livekit.yaml
BACKEND_PORT="$(grep -oP '^PORT=\K[0-9]+' .env 2>/dev/null | head -1 || echo 3005)"

# ─────────────────────────────────────────────────────────────
# ⚠️ LiveKit 的三个端口**从 livekit.yaml 读**，不要写死 ✗
#
# 写死的后果（真踩过）：把 udp_port 从 7882 改成 17709（NAT 机器只能用
# 服务商给的那段端口）之后 ✓ 这个体检脚本还在查 7882 ✗
# 于是报"UDP 一个都没起来" ✗ —— 而服务其实是好的 ✓ 白白吓一跳 ✓
# ─────────────────────────────────────────────────────────────
# 顶层 port（信令）—— 注意 prometheus 段里也有一个缩进的 port: 6789 ✓
# 用 ^port: 锚定行首 ✓ 不会误匹配到它 ✓
SIGNAL_PORT="$(grep -oP '^port:\s*\K[0-9]+' "$YAML" 2>/dev/null | head -1 || true)"
SIGNAL_PORT="${SIGNAL_PORT:-7880}"

TCP_PORT="$(grep -oP '^\s*tcp_port:\s*\K[0-9]+' "$YAML" 2>/dev/null | head -1 || true)"
TCP_PORT="${TCP_PORT:-7881}"

# udp_port 可能是**一个端口**（17709）也可能是**一段**（7882-7885）✓ 两种都要支持
UDP_SPEC="$(grep -oP '^\s*udp_port:\s*\K[0-9-]+' "$YAML" 2>/dev/null | head -1 || true)"
UDP_SPEC="${UDP_SPEC:-7882}"
if [[ "$UDP_SPEC" == *-* ]]; then
  UDP_START="${UDP_SPEC%-*}"; UDP_END="${UDP_SPEC#*-}"
else
  UDP_START="$UDP_SPEC"; UDP_END="$UDP_SPEC"
fi

# ─────────────────────────────────────────────────────────────
section "1. systemd 服务"
# ─────────────────────────────────────────────────────────────
for svc in livekit voice-backend; do
  if ! systemctl list-unit-files "$svc.service" >/dev/null 2>&1; then
    fail "$svc.service 不存在（跑过 sudo ./scripts/install-services.sh 吗？）"
    continue
  fi
  act="$(systemctl is-active "$svc" 2>/dev/null || echo unknown)"
  ena="$(systemctl is-enabled "$svc" 2>/dev/null || echo unknown)"
  if [ "$act" = "active" ] && [ "$ena" = "enabled" ]; then
    pass "$svc 运行中，且已设为开机自启"
  elif [ "$act" = "active" ]; then
    fail "$svc 在跑，但没设开机自启（enabled=$ena）→ 重启后会丢"
  else
    fail "$svc 状态 = $act → journalctl -u $svc -n 30"
  fi
done

# 重启次数能反映稳定性（崩溃重启通常意味着配置错误）
for svc in livekit voice-backend; do
  n="$(systemctl show -p NRestarts --value "$svc" 2>/dev/null || echo 0)"
  [ "${n:-0}" != "0" ] && warn "$svc 重启过 $n 次 → journalctl -u $svc -n 50"
done

# ─────────────────────────────────────────────────────────────
section "2. TCP 端口监听"
# ─────────────────────────────────────────────────────────────
check_tcp() {
  if ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"; then
    pass "TCP $1 正在监听（$2）"
  else
    fail "TCP $1 没有监听（$2）"
  fi
}
check_tcp "$SIGNAL_PORT" "LiveKit 信令"
check_tcp "$TCP_PORT" "WebRTC over TCP 兜底"
check_tcp "$BACKEND_PORT" "后端 API"

# ─────────────────────────────────────────────────────────────
section "3. UDP 媒体端口"
# ─────────────────────────────────────────────────────────────
UDP_OPEN=0
for p in $(seq "$UDP_START" "$UDP_END"); do
  ss -lun 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$" && UDP_OPEN=$((UDP_OPEN+1))
done
if [ "$UDP_OPEN" -eq 4 ]; then
  pass "UDP $UDP_SPEC 全部就绪（媒体流）"
elif [ "$UDP_OPEN" -gt 0 ]; then
  warn "UDP $UDP_SPEC 只起来了 $UDP_OPEN 个"
else
  fail "UDP $UDP_SPEC 一个都没起来 —— 语音和屏幕共享都不会通"
fi

# 客户端实际用的是 UDP 还是退回了 TCP，这个区别很大
if [ -f /var/log/livekit.log ]; then
  LAST_TYPE="$(grep -o '"connectionType": "[a-z]*"' /var/log/livekit.log 2>/dev/null | tail -1 | grep -o '"[a-z]*"$' | tr -d '"' || true)"
  case "$LAST_TYPE" in
    udp) pass "最近一次连接走的是 UDP（理想）" ;;
    tcp) warn "最近一次连接退回了 TCP —— 检查安全组的 7882-7885/UDP 规则" ;;
  esac
fi

# ─────────────────────────────────────────────────────────────
section "4. 后端服务"
# ─────────────────────────────────────────────────────────────
HEALTH="$(curl -s --max-time 5 "http://127.0.0.1:${BACKEND_PORT}/health" 2>/dev/null || true)"
if printf '%s' "$HEALTH" | grep -q '"ok":true'; then
  MEM="$(printf '%s' "$HEALTH" | grep -oP '"memoryMB":\K[0-9]+' || echo '?')"
  UP="$(printf '%s' "$HEALTH" | grep -oP '"uptimeSec":\K[0-9]+' || echo '?')"
  pass "后端健康（内存 ${MEM} MB，已运行 ${UP} 秒）"
else
  fail "后端 /health 无响应：${HEALTH:-（空）}"
fi

# ─────────────────────────────────────────────────────────────
section "5. node_ip 与实际公网 IP 是否一致（最容易出错的一项）"
# ─────────────────────────────────────────────────────────────
CONF_IP="$(grep -oP '^\s*node_ip:\s*\K[0-9.]+' "$YAML" 2>/dev/null | head -1 || true)"
REAL_IP=""
for p in public-ipv4 eipv4; do
  REAL_IP="$(curl -s --max-time 3 "http://100.100.100.200/latest/meta-data/${p}" 2>/dev/null || true)"
  [[ "$REAL_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && break
  REAL_IP=""
done
# ⚠️ 先试**国内可达**的源 ✓ 再退回国外源 ✗
  #    国内服务器（尤其不能挂代理的）访问 api.ipify.org 经常超时 ✓
  #    探测失败只会打个"无法探测"的警告 ✓ 但那就失去了"node_ip 对不对"的检查 ✓
  if [ -z "$REAL_IP" ]; then
    for u in https://ip.3322.net https://myip.ipip.net/s https://api.ipify.org https://ifconfig.me/ip; do
      REAL_IP="$(curl -s --max-time 5 "$u" 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1 || true)"
      [ -n "$REAL_IP" ] && break
    done
  fi

if [ -z "$CONF_IP" ]; then
  fail "$YAML 里没设 node_ip —— 客户端会拿到内网 IP，永远连不上"
elif [ -z "$REAL_IP" ]; then
  warn "无法探测真实公网 IP，当前配置 node_ip = $CONF_IP"
elif [ "$CONF_IP" = "$REAL_IP" ]; then
  pass "node_ip = $CONF_IP 与实际公网 IP 一致"
else
  fail "node_ip = $CONF_IP，但真实公网 IP = $REAL_IP —— 必须改 $YAML 后 systemctl restart livekit"
fi

if grep -q '^\s*use_external_ip:\s*true' "$YAML"; then
  warn "use_external_ip 是 true。国内环境下 Google STUN 常常不可达，建议改成 false + 显式 node_ip"
fi

# ─────────────────────────────────────────────────────────────
section "6. 内存与 swap"
# ─────────────────────────────────────────────────────────────
MEM_TOTAL="$(awk '/MemTotal/{printf "%.1f", $2/1024/1024}' /proc/meminfo)"
MEM_AVAIL="$(awk '/MemAvailable/{printf "%.1f", $2/1024/1024}' /proc/meminfo)"
SWAP_TOTAL="$(awk '/SwapTotal/{printf "%.1f", $2/1024/1024}' /proc/meminfo)"

printf "  内存 %.1f GiB，可用 %.1f GiB；swap %.1f GiB\n" "$MEM_TOTAL" "$MEM_AVAIL" "$SWAP_TOTAL"
if awk "BEGIN{exit !($MEM_AVAIL < 0.4)}"; then
  fail "可用内存不足 400 MB，随时可能 OOM"
elif awk "BEGIN{exit !($MEM_AVAIL < 0.8)}"; then
  warn "可用内存偏低（< 800 MB）"
else
  pass "内存充裕"
fi

if awk "BEGIN{exit !($SWAP_TOTAL < 0.5)}"; then
  fail "没有 swap —— OOM killer 会随机杀掉进程。跑 sudo ./scripts/init.sh 补上"
else
  pass "swap 已配置"
fi

if dmesg -T 2>/dev/null | tail -300 | grep -qi 'out of memory'; then
  warn "dmesg 里有 OOM 记录，近期有进程被杀过"
fi

# ─────────────────────────────────────────────────────────────
section "7. 出口流量速率（按流量计费，值得盯）"
# ─────────────────────────────────────────────────────────────
IFACE="$(ip route show default 2>/dev/null | awk '{print $5; exit}')"
if [ -n "$IFACE" ] && [ -r "/sys/class/net/$IFACE/statistics/tx_bytes" ]; then
  T1="$(cat /sys/class/net/$IFACE/statistics/tx_bytes)"
  R1="$(cat /sys/class/net/$IFACE/statistics/rx_bytes)"
  sleep 3
  T2="$(cat /sys/class/net/$IFACE/statistics/tx_bytes)"
  R2="$(cat /sys/class/net/$IFACE/statistics/rx_bytes)"
  TX_MBPS="$(awk "BEGIN{printf \"%.3f\", ($T2-$T1)*8/3/1000000}")"
  RX_MBPS="$(awk "BEGIN{printf \"%.3f\", ($R2-$R1)*8/3/1000000}")"
  printf "  网卡 %s：出口 %.3f Mbps，入口 %.3f Mbps\n" "$IFACE" "$TX_MBPS" "$RX_MBPS"
  printf "  按当前速率持续一个月 ≈ %.1f GB 出口流量\n" "$(awk "BEGIN{printf \"%.1f\", ($TX_MBPS/8)*3600*24*30/1000}")"
  printf "  ${Y}大陆地域 CDT 免费额度只有 20 GB/月，超出 0.80 元/GB${N}\n"
else
  warn "读不到网卡统计"
fi

# ─────────────────────────────────────────────────────────────
section "8. 安全组提醒（脚本无法检测，请手动核对）"
# ─────────────────────────────────────────────────────────────
cat <<EOF
  阿里云控制台 → ECS → 安全组 → 入方向，应包含：

    22/tcp             ← 建议限制来源为你的固定 IP
    ${SIGNAL_PORT}/tcp           LiveKit 信令
    ${TCP_PORT}/tcp           WebRTC over TCP 兜底
    ${UDP_SPEC}/udp      ← 媒体流。最容易漏，漏了就退回 TCP 或没声音
    ${BACKEND_PORT}/tcp            后端 API

  不应开放：80, 443, 3478, 5349, 6789
EOF

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
  printf "\n  ufw 是启用的，当前规则：\n"
  ufw status | sed 's/^/    /'
fi

# ─────────────────────────────────────────────────────────────
printf "\n${B}%s${N}\n" "────────────────────────────────────────"
printf "${B}结果：${G}%d 通过${N}  ${R}%d 失败${N}  ${Y}%d 警告${N}\n" "$PASS" "$FAIL" "$WARN"
printf "${B}%s${N}\n\n" "────────────────────────────────────────"

if [ "$FAIL" -gt 0 ]; then
  cat <<EOF
有失败项。常用排查命令：

  看服务状态   systemctl status livekit voice-backend
  看日志       journalctl -u livekit -n 50 --no-pager
               journalctl -u voice-backend -n 50 --no-pager
  重启         systemctl restart livekit voice-backend
  查临时进程   ps aux | grep -E "[l]ivekit-server|[n]ode src"
  查端口占用   ss -lntup | grep -E "${SIGNAL_PORT}|${TCP_PORT}|${UDP_START}|${BACKEND_PORT}"

EOF
  exit 1
fi

cat <<EOF
服务端体检通过。

客户端侧验收（必须从 http://localhost 打开，不能用 file://）：

  cd tools/test-page && python -m http.server 8123 --bind 127.0.0.1
  浏览器打开 http://127.0.0.1:8123
  邀请码见 .env 的 INVITE_CODE

EOF
