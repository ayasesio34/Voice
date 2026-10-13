#!/usr/bin/env bash
#
# 排查「房间里有看不见的幽灵参与者」。
#
# 症状：成员列表里的人比实际打开的客户端多。
#
# 用法：sudo ./scripts/check-room.sh
#
set -uo pipefail

echo "=== 1. 当前有多少客户端连着 LiveKit 信令端口 (7880) ==="
echo "（每个连接对应一个参与者。这里几行，房间里就该有几个人）"
echo
CONNS="$(ss -tnp 2>/dev/null | grep ':7880' | grep -v LISTEN || true)"
if [ -z "$CONNS" ]; then
  echo "  （没有连接）"
else
  echo "$CONNS" | awk '{printf "  %-22s %-22s %s\n", $4, $5, $6}'
  echo
  echo "  合计: $(echo "$CONNS" | wc -l) 个连接"
fi

echo
echo "=== 2. LiveKit 日志里最近的参与者活动 ==="
echo "（看 participant active / left 的 identity，能对上是谁）"
echo
journalctl -u livekit --since "30 min ago" --no-pager 2>/dev/null \
  | grep -oE '"participant": "[^"]*"|"room": "[^"]*"|participant (active|left|joined)' \
  | tail -40 \
  | sed 's/^/  /' || echo "  （日志里没有相关内容）"

echo
echo "=== 3. 当前活跃房间里的参与者数 ==="
echo
if curl -s --max-time 5 http://127.0.0.1:6789/metrics 2>/dev/null | grep -q '^livekit_'; then
  curl -s --max-time 5 http://127.0.0.1:6789/metrics 2>/dev/null \
    | grep -E '^livekit_(participant|room)_(total|current)' \
    | sed 's/^/  /' || echo "  （没有匹配的指标）"
else
  echo "  （Prometheus 指标读不到）"
fi

echo
echo "=== 4. 想强制清空所有房间的话 ==="
echo
echo "  systemctl restart livekit"
echo "  （所有客户端会被断开，需要重新加入。平时别这么做，只在测试残留太多时用）"
echo
