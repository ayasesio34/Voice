# Voice

自建的语音 + 文字 + 投屏客户端与服务端 —— 为**几个人的小圈子**写的私服，类似自建 Discord。

> ⚠️ 这个仓库是**通用模板** ✓ 里面的服务器地址和邀请码都是**占位符** ✗
> 部署时按下面的说明换成你自己的 ✓

## 组成

| 目录 | 是什么 |
|---|---|
| `voice-server/` | 服务端：Node 24 + Fastify + `node:sqlite`（**零原生依赖**）+ LiveKit（单文件二进制，**不用 Docker**） |
| `voice-client/` | 桌面客户端：Electron 33 + React 19，Windows 为主，支持自动更新 |

## 功能

- **语音频道** —— 麦克风处理开关（降噪/回声消除/自动增益）· 独立音量 · 进出铃声
- **文字频道 / 私聊** —— 附件、截图、云端文件、搜索
- **投屏** —— 720p30 到 2K60 六档可调 · 独立音量 · 观看者头像
- **状态** —— 「正在听」（Windows SMTC）·「正在玩」（进程 + 可共享的白名单）
- **权限** —— 频道主 / 管理员 / 成员

## 快速开始

部署看 **[voice-server/开始操作.md](voice-server/开始操作.md)** ——
从一台空服务器到跑起来，包括所有实际踩过的坑。

改代码之前先读 **[voice-client/CHANGELOG.md](voice-client/CHANGELOG.md)** ——
那里记了每个技术决策**为什么**这么做、以及踩过什么坑。

## 几个值得一说的设计

- **服务端零原生依赖** —— 用 Node 24 自带的 `node:sqlite` ✗
  不用 `better-sqlite3` ✓ 因为后者要下载预编译二进制（走 GitHub ✓ 国内经常失败 ✗）
- **身份由客户端生成** —— 不能让服务端下发 ✗
  否则 React StrictMode 会把 effect 跑两遍 ✓ 造出两个身份 ✓ 频道主锁死在一个回不来的身份上 ✗
- **投屏的 `contentHint` 比码率更重要** —— 屏幕内容是锐利文字 ✓
  编码器要优先保边缘 ✓ 选错会让帧率一直被压 ✓ 看着就是"卡"
- **`.cmd` 必须纯 ASCII**、**`.ps1` 必须带 BOM**、**`.yaml` 绝不能有 BOM** ✗
  三条互相矛盾的规则 ✓ 仓库里有护栏脚本自动检查 ✓

## 部署到自己的服务器

1. 把 `voice-client/src/renderer/src/lib/config.ts` 里的 `YOUR_SERVER_IP`
   换成你的地址（**两个端口也要按你的实际情况改**）
2. 把 `voice-server/livekit/livekit.yaml` 的 `node_ip` 换成你的公网 IP
3. 按 `voice-server/开始操作.md` 走一遍
4. 自己设一个邀请码，填进 `.env` 和服务端

## 许可

见 [LICENSE](LICENSE)。