# voice-server · 运维手册

自建语音服务端（语音频道 + 文字频道 + 1080p60 屏幕共享），跑在一台 **2 核 2 GiB 阿里云 ECS** 上。

**状态：已在真机验证通过** —— 双端互见屏幕、UDP 媒体通路正常、服务器重启后服务自动恢复。

- 🚀 **从零部署**看 [开始操作.md](开始操作.md)
- 🔧 **日常运维、排错、配置解释**看本文

---

## 架构

```
┌──────── 用户电脑：桌面客户端（M2 开发中）────────┐
│  语音 / 屏幕共享 / 文字                          │
└──────┬──────────────────────┬───────────────────┘
       │ ws://IP:7880 信令     │ UDP 7882-7885 媒体
       ▼                      ▼
┌──────────────────┐   ┌─────────────────────┐
│ voice-backend    │   │ LiveKit Server      │
│ :3005            │   │ :7880 :7881         │
│ token / 文字频道  │   │ SFU + 内置 TURN/STUN │
│ SQLite           │   │ 单文件二进制          │
└──────────────────┘   └─────────────────────┘
       systemd 托管，开机自启，崩溃自动重启
```

**这套设计里刻意去掉的东西**（每一项都是有原因的，别顺手加回来）：

| 没装 | 为什么 |
|---|---|
| **Docker** | 国内拉 Docker Hub 镜像频繁失败。LiveKit 官方二进制只有 18 MB，效果一样，还省内存 |
| **域名 / 证书 / 备案** | 客户端是原生程序，直连 `ws://IP:端口`。备案管的是"域名 + 网站"，不涉及 |
| **coturn** | LiveKit 内置 TURN/STUN，`turn.udp_port` 一开就有 |
| **PostgreSQL** | 用 Node 24 内置的 `node:sqlite`，省 300~500 MB 内存，且**零原生依赖** |
| **Redis** | 单节点不需要，多节点才要 |
| **Caddy / Nginx** | 没有域名和证书，反代没意义 |

---

## 关键路径

| 是什么 | 在哪 |
|---|---|
| 项目根目录 | `/opt/voice-server` |
| LiveKit 配置 | `/opt/voice-server/livekit/livekit.yaml` |
| API 密钥 / 邀请码 / 端口 | `/opt/voice-server/.env` |
| SQLite 数据库 | `/opt/voice-server/data/voice.db` |
| LiveKit 可执行文件 | `/usr/local/bin/livekit-server` |
| Node 可执行文件 | `/usr/local/bin/node` |
| 后端源码 | `/opt/voice-server/backend/src/` |
| systemd 服务 | `/etc/systemd/system/livekit.service`、`voice-backend.service` |

---

## 服务端版本号

**服务端版本独立于客户端**，两边各自记各自的 —— 因为它们可以分别部署、也会分别回滚。

| 改了什么 | 改哪个版本号 |
|---|---|
| 服务端代码 | `backend/package.json` 的 `version` |
| 客户端代码 | `voice-client/package.json` 的 `version` |
| 两边都改 | 两边都改 |

版本号**硬编码在 `backend/src/version.js` 的那一行**（`SERVER_VERSION`）。

> 为什么不读 `backend/package.json`（那样能"单一来源"）：
> 部署是**手工 scp 几个文件**的，万一漏传了 package.json，
> 版本号会**显示旧值** —— 那比没有版本号更糟，因为会让人以为部署成功了。
> 硬编码在一个文件里，传了就是传了，没有中间状态。
>
> `package.json` 里那个 `version` 只给 npm 看，改的时候顺手一起改。

### 怎么确认服务器上跑的是哪一版

```bash
curl -s http://127.0.0.1:3005/health
```

```json
{
  "ok": true,
  "serverVersion": "1.0.0",
  "uptimeSec": 163,
  "memoryMB": 97,
  "livekitUrl": "ws://YOUR_SERVER_IP:17707"
}
```

启动日志里也会打一行：

```
voice-backend v1.0.0 已启动
```

**为什么专门加这个**：在这之前服务端没有任何版本号，于是"服务器上跑的到底是哪一版"
只能靠**推断** —— 比如"systemctl 重启时间晚于文件改动时间"。
那个证据链不够硬：scp 可能只传了一半，重启也可能是因为别的原因。
现在一眼就能确认，不用再猜。

---

## 日常运维命令

```bash
# ── 状态 ──────────────────────────────────────────
systemctl status livekit voice-backend          # 两个服务活着吗
./scripts/selfcheck.sh                          # 完整体检（推荐先跑这个）

# ── 日志 ──────────────────────────────────────────
journalctl -u livekit -f                        # 实时（Ctrl+C 退出）
journalctl -u voice-backend -f
journalctl -u livekit -n 100 --no-pager         # 最近 100 行
journalctl -u livekit --since "10 min ago"      # 最近 10 分钟

# ── 重启 ──────────────────────────────────────────
systemctl restart livekit voice-backend
systemctl restart livekit                       # 只重启一个

# ── 查信息 ────────────────────────────────────────
grep INVITE_CODE /opt/voice-server/.env         # 邀请码
grep -E '^(PORT|LIVEKIT_API_KEY)=' /opt/voice-server/.env
ss -lntup | grep -E '7880|7881|3005'            # 端口占用
ps aux | grep -E '[l]ivekit-server|[n]ode src'  # 进程

# ── 数据 ──────────────────────────────────────────
sqlite3 /opt/voice-server/data/voice.db 'select count(*) from messages;'
```

> 这台机器上没有 `sqlite3` 命令的话：`apt-get install -y sqlite3`。

---

## 端口与安全组

| 端口 | 协议 | 用途 | 必须 |
|---|---|---|---|
| 22 | TCP | SSH（**建议限制来源 IP**） | ✅ |
| 7880 | TCP | LiveKit 信令（WebSocket） | ✅ |
| 7881 | TCP | WebRTC over TCP（UDP 不通时兜底） | ✅ |
| **7882-7885** | **UDP** | **媒体流（语音 + 屏幕共享）** | ✅ |
| 3005 | TCP | 后端 API（签发 token、文字频道） | ✅ |

**不要开放**：80、443、3478、5349、6789。

> ⚠️ `7882-7885` 必须选 **自定义 UDP**。选成 TCP 的话，连接会退回 TCP 隧道 —— 能通，但 5 Mbps 的视频会撑爆 LiveKit 的包缓冲（日志里出现 `unbound buffer overflowing, dropping packets`），表现为画面卡顿甚至停住。

---

## 配置里几个"为什么"

### 1. `use_external_ip: false` + `node_ip: <公网IP>`

阿里云 ECS 的"公网 IP"是 **NAT 映射**：网卡上只有内网 IP，公网 IP 不在进程可见的接口上。不显式指定的话，LiveKit 会把内网 IP 当候选地址通告出去 → **客户端永远连不上**。

两种解法：

| 方案 | 配置 | 特点 |
|---|---|---|
| **显式指定**（本项目） | `use_external_ip: false` + `node_ip` | 确定、不依赖外部服务 |
| 自动探测 | `use_external_ip: true` | 靠 STUN。**国内 Google 的 STUN 常常不可达**，探测失败就用错 IP |

⚠️ **换公网 IP / 换机器后必须改这一行**，然后 `systemctl restart livekit`。`selfcheck.sh` 会自动比对并报错。

`init.sh` 会从阿里云元数据服务（`100.100.100.200`）自动探测并写入。

### 2. `rtc.udp_port: 7882-7885`（UDP 端口复用）

LiveKit 默认用 `50000-60000`（10001 个端口，每个参与者占 2 个）。改成复用模式后：

- 安全组只需要**一条** UDP 规则
- NAT 行为更可预测

官方建议复用端口数 **≥ vCPU 数**。本机 2 vCPU，给 4 个足够。

> ⚠️ 设了 `udp_port` 之后，`port_range_start` / `port_range_end` **必须留空**，否则复用不生效。

### 3. 没有 `redis:`

LiveKit 只在**多节点**部署时才需要 Redis 做房间路由。单节点用内存状态即可，日志里那句 `not suitable for multi-node` 的警告可以忽略。省约 50 MB 内存。

### 4. 没有 `turn:`

LiveKit 内置 TURN，但源码里（`pkg/service/turn.go`）要求：

```go
} else if turnConf.TLSPort > 0 {
    if turnConf.Domain == "" {
        return nil, errors.New("TURN domain required")
    }
```

**只要 `tls_port > 0` 就必须有域名和证书**，而 `tls_port` 默认是 5349 —— 一开 `turn.enabled: true` 就很可能会启动失败。没有域名走不通 TURN/TLS。

当前的兜底链条：`host candidate（node_ip 直连） → ICE/TCP :7881`。家庭宽带和大部分校园网够用。

> 如果将来确认有用户连不上（深层 NAT、企业防火墙），再回头解决域名 + TURN，或者用 Tailscale。

### 5. 没有 `enabled_codecs`

刻意不锁编解码器。屏幕共享调 1080p60 时再按需配置 —— 提前锁死很容易**静默地让某个编码器不可用**，排查起来非常痛苦。

### 6. `limit.bytes_per_sec: 12500000`

出口速率安全阀（100 Mbps）。默认是 1 GB/s，远超本机能力。设成这个值防止异常客户端把流量打满导致账单失控。想关掉改成 `-1`。

### 7. SQLite 用 `node:sqlite` 而不是 `better-sqlite3`

`better-sqlite3` 是原生模块，安装时要下载预编译二进制（走 GitHub，国内经常失败）或现场编译（要 python3 + g++）。`node:sqlite` 是 Node 24 自带的，**零依赖、零编译、零下载**。

⚠️ 代价：`node:sqlite` **只支持位置参数 `?`**，不支持具名参数。改 `backend/src/db.js` 时注意别混用。

---

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 客户端一直 connecting | 7880 没通，或 LiveKit 没起来 | `systemctl status livekit`；`ss -lntp \| grep 7880` |
| 连上了但没声音 | UDP 媒体端口没通 | 查安全组 `7882-7885/UDP`；`selfcheck.sh` 第 3 节会报 |
| 连接走 TCP 而非 UDP | 安全组 UDP 规则选成了 TCP | 改安全组 → `systemctl restart livekit` |
| 画面卡顿 / 日志里 `buffer overflowing` | 走 TCP 传视频导致突发 | 同上，修 UDP |
| **统计里码率一直是 0** | **房间里没人订阅你的流** | **正常**。`dynacast` 不给无人观看的流浪费带宽。开第二个窗口进同一房间即可 |
| 画面"看着清楚"但码率很低 | 看到的是本地采集预览，不是发出去的流 | 用第二个客户端当观众才能判断真实质量 |
| `TURN domain required` | 有人开了 `turn.enabled` 但没配 domain | 本项目不启用 TURN，检查配置被改过 |
| `node_ip` 不对 | 换过公网 IP / 绑了 EIP | 改 `livekit/livekit.yaml` → `systemctl restart livekit` |
| 服务反复重启 | 配置错误 / 依赖没装 | `journalctl -u voice-backend -n 50`；后端要先 `npm install` |
| `EADDRINUSE` | 端口被别的程序占（Haven 用 3000/3001） | 改 `.env` 的 `PORT`，然后 `systemctl restart voice-backend` |
| 后端报 `Cannot find module 'node:sqlite'` | Node 版本 < 22.5 | 重装 Node 24（见 [开始操作.md](开始操作.md) 第 3 步） |
| 机器变慢 / 进程莫名消失 | 内存不足被 OOM | `free -h`；`dmesg -T \| grep -i oom`；确认 swap 已加 |

---

## 成本

| 项目 | 说明 |
|---|---|
| 实例 | 学生免费计划，包年到 2027-05-26 |
| **公网流量** | ⚠️ **按使用流量计费，0.80 元/GB，大陆地域每月只有 20 GB 免费额度** |
| 语音 | 10 人语音约 2.9 Mbps，即 **1.3 GB/小时**（≈ ¥1/小时） |
| 屏幕共享 720p30 @2.5Mbps，5 人看 | 12.5 Mbps，即 **5.6 GB/小时**（≈ ¥4.5/小时） |
| 屏幕共享 1080p60 @8Mbps，9 人看 | 72 Mbps，即 **32 GB/小时**（≈ ¥26/小时） |

**只对出方向计费**，入方向免费。所以成本由"有多少人在看"决定，不是由"有多少人在共享"决定。

省流量的三招（客户端侧实现）：

1. **屏幕共享默认 720p30**，用户主动点"高清"再升
2. **开 Opus DTX**（不发言时不发包），语音流量降 40~60%
3. **`adaptiveStream` + `dynacast`**（已默认开启），没人看的流不发

实时监控：

```bash
./scripts/selfcheck.sh   # 第 7 节会显示实时进出口速率
curl -s http://127.0.0.1:3005/api/net/summary   # 原始字节数
```

---

## 关于后端 API 的安全

`POST /api/token` 用 `INVITE_CODE` 做口令，带速率限制（10 次/分钟）。对小圈子够用，但要清楚：

- **绝对不要把 `LIVEKIT_API_SECRET` 写进客户端。** 等于把服务器钥匙发出去 —— 任何人都能伪造身份、往任意房间推流。
- token 接口是唯一需要暴露的后端接口。以后如果要对外开放，改成真正的账号体系（用户名密码 / OAuth），而不是继续加长邀请码。

---

## 文件结构

```
voice-server/
├── 开始操作.md                 # ★ 从零部署手册
├── README.md                   # ★ 本文（运维手册）
├── .env.example                # 环境变量模板
├── .gitignore
├── livekit/
│   └── livekit.yaml            # LiveKit 配置（含密钥，chmod 600）
├── backend/
│   ├── package.json
│   ├── Dockerfile              # ⚠️ 已弃用，仅作参考
│   └── src/
│       ├── index.js            # HTTP 路由 + WebSocket 聊天
│       ├── db.js               # SQLite（node:sqlite）
│       └── livekit.js          # AccessToken 签发
├── tools/
│   └── test-page/index.html    # 验收测试页（含实时统计面板）
├── scripts/
│   ├── init.sh                 # 生成密钥 + 探测公网 IP + swap + 内核参数
│   ├── install-services.sh     # 装 systemd 服务（开机自启）
│   └── selfcheck.sh            # 体检
└── docs/
    └── 1080p60-screen-share.md # 屏幕共享编码与带宽设计
```

---

## 下一步（M2）

服务端已完成。剩下的是**桌面客户端**：

| 阶段 | 内容 |
|---|---|
| M2 | Electron 壳 + React 骨架（服务器栏 / 频道列表 / 成员 / 聊天）+ 接 LiveKit 打通语音 |
| M3 | 屏幕共享（`desktopCapturer` + 系统音频 + 码率上限）—— 编码参数见 [docs/1080p60-screen-share.md](docs/1080p60-screen-share.md) |
| M4 | PTT 全局快捷键（`uiohook-napi`）+ 设备管理 + 单人音量 |
| M5 | 把后端从骨架补成完整业务（账号、多频道、消息历史、权限） |
| M6 | `electron-builder` 打包 + `electron-updater` 自动更新 |

> Electron 里**不能用浏览器的 `getDisplayMedia()`**，必须走 `desktopCapturer` + `chromeMediaSource` 约束。详见屏幕共享文档。
