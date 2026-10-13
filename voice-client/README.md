# voice-client · 桌面客户端

自建语音软件的桌面端：**语音 + 文字 + 1080p60 屏幕共享**，界面借 Discord 形态。

技术栈：Electron + React + TypeScript + Vite + `livekit-client`。

---

## 前置条件

**服务端必须已经在跑。** 检查一下：

```bash
cd /opt/voice-server && ./scripts/selfcheck.sh
```

记住里面的两个地址和邀请码：

| 要填什么 | 从哪来 |
|---|---|
| LiveKit 信令地址 | `ws://你的公网IP:7880` |
| 后端地址 | `http://你的公网IP:3005` |
| 邀请码 | `/opt/voice-server/.env` 里的 `INVITE_CODE` |

---

## 安装

```powershell
cd voice-client
npm install
```

> ⚠️ **国内网络下 Electron 的二进制下载会卡住**。项目里的 `.npmrc` 已经配好了 npmmirror 镜像，正常情况下不用管。
>
> 如果还是卡在 `Downloading electron` 或者报超时，手动设环境变量再来一次：
>
> ```powershell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
> npm install
> ```

### ⚠️ 如果 `npm run dev` 报 `Error: Electron uninstall`

这说明 **Electron 的 npm 包装上了，但它真正的运行时（约 100 MB 的 `electron.exe`）没下载成功**。

典型症状：`npm install` 只花了 30 秒就"成功"了（100 MB 不可能这么快），`node_modules/electron/` 里有 `dist` 目录但**是空的**，也没有 `path.txt`。

更坑的是：`@electron/get` 会把失败/半截的下载**缓存**在 `%LOCALAPPDATA%\electron`，下次直接复用坏缓存，表现为 `node install.js` **秒退且不报任何错**。

**绕开它的办法是手动下载 + 解压**（这三步和正常安装完全等价 —— Electron 的 `index.js` 就是读 `path.txt` 再去 `dist/` 找可执行文件）：

```powershell
# ① 清掉坏缓存（关键，不清的话后面还是会秒退）
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\electron" -ErrorAction SilentlyContinue

cd C:\path\to\voice-client
Remove-Item -Recurse -Force node_modules\electron -ErrorAction SilentlyContinue
npm install electron --save-dev --foreground-scripts
```

如果上面还是不行，直接手动下 zip：

```powershell
cd C:\path\to\voice-client
$version = (Get-Content node_modules\electron\package.json | ConvertFrom-Json).version
$ProgressPreference = 'SilentlyContinue'
$zip = "$env:TEMP\electron-$version.zip"

# 依次试几个镜像地址，哪个通用哪个
$urls = @(
  "https://npmmirror.com/mirrors/electron/v$version/electron-v$version-win32-x64.zip",
  "https://npmmirror.com/mirrors/electron/$version/electron-v$version-win32-x64.zip",
  "https://cdn.npmmirror.com/binaries/electron/v$version/electron-v$version-win32-x64.zip"
)
foreach ($u in $urls) {
  "尝试: $u"
  try { Invoke-WebRequest -Uri $u -OutFile $zip -ErrorAction Stop; "  成功"; break }
  catch { "  失败: $($_.Exception.Message)" }
}

# 解压 + 告诉 Electron 去哪找自己
Remove-Item -Recurse -Force node_modules\electron\dist -ErrorAction SilentlyContinue
Expand-Archive -Path $zip -DestinationPath node_modules\electron\dist -Force
Set-Content -Path node_modules\electron\path.txt -Value "electron.exe" -NoNewline -Encoding ascii

Test-Path node_modules\electron\dist\electron.exe   # 必须是 True
```

**装好之后就不用再管了** —— 二进制已经在本地，以后每次只要 `npm run dev`，不需要再设镜像环境变量。

---

## 运行

```powershell
npm run dev
```

窗口会自动弹出，并打开 DevTools。改代码即时热更新。

---

## 首次配置

点右下角「**设置**」填：

| 字段 | 填什么 |
|---|---|
| LiveKit 信令地址 | `ws://你的公网IP:7880` |
| 后端地址 | `http://你的公网IP:3005` |
| 邀请码 | 服务端 `.env` 里的 `INVITE_CODE` |
| 昵称 | 随便 |

保存后会存在 localStorage，下次不用再填。

---

## 界面布局

```
┌──────────────┬────────────────────┬──────────────┐
│ ⚙ 我的服务器 │  聊天 / 屏幕共享    │  成员         │
│  # 综合       │                    │  · 所有人     │
│  🔊 语音 1    │                    │    在线的亮   │
│    A Owner    │                    │    离线的暗   │
│    A 小明     │                    │              │
│  🔊 语音 2    │                    │              │
│  + 创建频道   │                    │              │
├──────────────┴────────────────────┴──────────────┤
│ 🟢 🔊 语音 1 · 2 人在线 · 1080p60  闭麦 喇叭开 共享屏幕 断开 设置 │
└──────────────────────────────────────────────────┘
```

- **左上角**是服务器身份（头像 + 名字）。管理员以上点它能改名字和头像
- **左侧语音频道下方**列出该频道里正在语音的人（头像 + 名字 + 静音/共享状态图标）
- **右侧**是**全部成员**（在线的亮、离线的压暗），带角色徽标
- **频道列表底部**有「+ 创建频道」（仅管理员以上可见）

## 角色

| 角色 | 权限 |
|---|---|
| **频道主** | 全部。可以任命/撤销管理员 |
| **管理员** | 创建/删除频道、改服务器名字和头像 |
| **成员** | 加入语音、发消息、共享屏幕 |

**第一个连上服务器的人自动成为频道主**（相当于新建 Discord 服务器时创建者就是服主）。
频道主在成员列表里点别人那行的「升管」/「撤管」来任命管理员。

### ⚠️ 但"先到先得"不可靠，建议改用 `OWNER_NAME`

先到先得的坑：第一个连上来的**不一定是人** —— 浏览器测试页、忘了关的旧窗口、
甚至开发模式下 React StrictMode 多开的那条连接，都可能抢先。

在服务端 `.env` 里配一行就行：

```
OWNER_NAME=Owner
```

- 谁用这个昵称连上，谁就是频道主，**跟本地身份无关**
- 因此清缓存、换电脑、重装服务器都能自动拿回频道主
- 配了之后**关闭"先到先得"**，别人不会误抢

改完 `systemctl restart voice-backend` 生效。

### 还是出问题了？用 admin.js

```bash
cd /opt/voice-server
node scripts/admin.js list                              # 看现在谁是什么角色
node scripts/admin.js owner Owner                       # 转移频道主
node scripts/admin.js role Owner admin                  # 设为管理员
node scripts/admin.js remove <userId>                   # 清理废弃身份
```

> 有重名成员时**用完整的 userId**，别用昵称 —— 脚本按昵称匹配会挑到第一个。

**屏幕共享和聊天是上下共存的** —— 有人共享时，画面占主区域上半部分，聊天永远在下面：

```
┌────────────────────────────┐
│ Owner 正在共享屏幕    收起 │
│                            │
│      （共享的画面）         │  ← 高度可调
│                            │
├════════════════════════════┤  ← 拖这个手柄上下调整
│  # 综合                    │
│  Owner: 看得见吗            │
│  [输入框.............] [发送]│  ← 永远可打字
└────────────────────────────┘
```

- **拖动中间的手柄**可以调整画面占多大
- 点「**收起**」把画面缩成一条细条，只看聊天；点细条就展开

> 同一个人会同时出现在左侧语音频道下方和右侧成员列表里 —— 这是 Discord 的行为，
> 两处的语境不同：一个是「谁在这个语音频道里」，一个是「整个服务器有哪些人」。
>
> 这份占用数据是**服务端**每 3 秒向 LiveKit 查询后推给客户端的。
> 客户端自己只能看到它加入的那个房间，别的频道里是谁只有服务端知道。

---

## 怎么用

1. 左侧点一个**文字频道**（`#` 开头的）→ 中间就是聊天
2. 点一个**语音频道**（🔊 开头的）→ 自动加入语音房间
3. 底部状态条：
   - 「**🎤 已开麦 / 🔇 已静音**」—— 开关自己的麦克风
   - 「**喇叭开 / 喇叭关**」—— 关掉所有别人的声音（**会顺带闭麦**，取消时恢复原来的麦克风状态）
   - 「**🖥 共享屏幕**」—— 选屏幕或窗口共享
4. 有人共享时，中间区域会自动切换到画面；本地共享时右上角有「停止共享」

**两个人测试**：在另一台电脑（或另一个浏览器/另一份客户端）用同样的配置进**同一个语音频道**即可。

> ⚠️ 语音频道在服务端是**按 id** 区分的。客户端里显示的「语音 1」内部 id 是 `voice-1`，
> 用浏览器测试页连的时候要填 `voice-1`，不能填中文名。

---

## 已知行为（不是 bug）

| 现象 | 说明 |
|---|---|
| **房间里只有你一个人时，共享的码率显示 0** | **正常。** LiveKit 的 `dynacast` 不给"无人观看"的流浪费带宽。开第二个客户端进同一频道，码率立刻起来 |
| 画面看着清晰，实际码率很低 | 你看到的是**本地采集预览**，不代表发出去的流质量。判断真实质量要看接收端 |
| 屏幕内容不动时帧率掉到 0 | **正常。** 屏幕捕获只在画面变化时产生帧 |
| 改了画质档位不生效 | 编码参数在**开始共享那一刻**定下来。改了要**停止共享再重新共享** |
| 共享时鼠标滚轮/键盘不响应 | 共享的那个窗口被系统捕获时可能收不到输入，这是 Windows 的行为 |

---

## 关键实现说明

### 屏幕共享为什么不用 `getDisplayMedia()`

**Electron 里不能用浏览器的 `navigator.mediaDevices.getDisplayMedia()`** —— 要么拿到空流，要么直接报错。正确路径是：

```
主进程 desktopCapturer.getSources()  →  拿到 sourceId
        ↓  IPC
渲染进程 navigator.mediaDevices.getUserMedia({
  video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, ... } },
  audio: { mandatory: { chromeMediaSource: 'desktop' } },   // Windows 系统声音
})
        ↓
room.localParticipant.publishTrack(videoTrack, { ... })
```

代码在 `src/renderer/src/lib/livekit.ts` 的 `publishScreenFromSource()`。
主进程里另外注册了 `setDisplayMediaRequestHandler` 作为安全网（万一某个依赖内部调了 `getDisplayMedia`）。

> 📌 各版本 Electron 对这两条路径的支持略有差异。如果共享拿不到画面，先去 DevTools 看 `getUserMedia` 抛的具体错误，再对照 `desktopCapturer` 的返回。

### `contentHint = 'text'`

采集之后、编码之前设的：

```ts
videoTrack.contentHint = 'text'
```

这是告诉编码器"这是文字内容，优先保锐利边缘"。**收益比从 6 Mbps 调到 8 Mbps 更大。** 不设的话编码器按"运动画面"优化，文字边缘会有振铃和模糊。

### 1080p60 的编码取舍

```ts
screenShareSimulcastLayers: [],              // 关闭 simulcast：三层 = 三倍编码开销
degradationPreference: 'maintain-resolution', // 带宽紧张时保分辨率降帧率
videoCodec: 'h264',                          // 硬件编码覆盖最广，保住 60fps
```

为什么默认 H.264 而不是压缩率更好的 VP9：**多数消费级 GPU 没有 VP9 硬件编码器**，只能软件编码，1080p60 软编能吃掉 4~8 个核心。60fps 是硬需求时，稳定性优先于压缩率。

完整分析见 [`voice-server/docs/1080p60-screen-share.md`](../voice-server/docs/1080p60-screen-share.md)。

### 服务端出口带宽

屏幕共享的出口带宽 = **单路码率 × 观看人数**。8 Mbps 的 1080p60 给 9 个人看就是 72 Mbps，接近服务端 100 Mbps 的上限。

服务端配置里有一个安全阀 `limit.bytes_per_sec: 12500000`，防止异常客户端把带宽打满。

---

## ⚠️ 打包前必须先编译原生模块

`native/process-loopback` 是**进程级音频回环** —— 投屏时只录「别的程序」的声音，
不把自己的通话声录进去。它是 **C++ 原生模块**，编译产物**不在仓库里**
（`.gitignore` 故意排除了 `.node`：平台绑定的二进制不进版本库）。

所以**新克隆下来的人必须先编译它**，否则 `npm run dist` 打出来的包
一启动就会报找不到 `process_loopback.node`。

```powershell
cd native\process-loopback
npm install
npm run build
```

构建前提：

| 需要 | 说明 |
|---|---|
| **Visual Studio Build Tools** | 勾选「使用 C++ 的桌面开发」 |
| **Python 3** | node-gyp 要用 |
| **node-gyp v11** | `npm install -g node-gyp@11` |
| **网络** | 编译要下 Node 头文件，`npm run build` 已内置 `--dist-url=https://npmmirror.com/mirrors/node` |

详见 [native/process-loopback/README.md](native/process-loopback/README.md)。

---

## 打包

```powershell
cd C:\path\to\voice-client
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist
```

> ⚠️ 那个环境变量必须设 —— electron-builder 要从 GitHub 下载 nsis 和 winCodeSign
> （约 100 MB），国内直连会失败。和当初 Electron 二进制下不下来是同一类问题。

产物在 `release/`：

| 文件 | 用途 |
|---|---|
| `Voice-v0.1.0-setup.exe` | 安装包，发给朋友 |
| `win-unpacked\Voice.exe` | 免安装版，双击直接用 |
| `latest.yml` / `*.blockmap` | 以后做自动更新要用 |

安装时 Windows 会弹 SmartScreen 警告（`Windows 已保护你的电脑`）—— 因为没买代码签名证书。
点「更多信息」→「仍要运行」即可，朋友那边也一样。

打包体积约 80~150 MB（Electron 运行时占大头）。

### 关于版本号

**版本号只有一个来源：`package.json` 里的 `version`。**

- 标题栏显示 `Voice v0.2.0`（来自 `app.getVersion()`）
- 安装包文件名里的 `v0.2.0`（来自 `artifactName` 的 `${version}`）
- `latest.yml` 里的版本号（自动更新靠它比对）

三处都从那一处取，所以不会出现"标题写 0.1 但安装包叫 0.2"。

> `0.1` 和 `0.1.0` 是一回事 —— semver 要求写满三段，所以 `package.json` 里是 `0.1.0`。
> 想只显示 `v0.1` 的话改 `src/main/index.ts` 里拼接标题那一行即可。

---

## 发布新版本（完整流程）

```powershell
# 1. 改 package.json 里的 version（0.2.0 → 0.3.0 之类）
# 2. 在 CHANGELOG.md 顶上记一条

# 3. 打包
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist

# 4. 上传到更新服务器
npm run publish:update
```

**第 4 步不能漏。** 只打包不上传的话，朋友那边永远收不到更新 ——
他们拉的还是服务器上那份旧的 `latest.yml`。

**第 4 步会自动清理服务器上的旧安装包**（见下面「更新目录会一直涨」）。
不想清理就加 `-NoPrune`：

```powershell
npm run publish:update -- -NoPrune
```

---

## 更新目录会一直涨

`/opt/voice-server/updates/` 里每个安装包约 **80 MB**，而且**只涨不减**。

但**只有当前版本的那三个文件有用**：

| 文件 | 作用 |
|---|---|
| `latest.yml` | 客户端靠它知道最新版本是哪个、文件叫什么、sha512 是多少 |
| 清单里那个 `.exe` | 下载它 |
| 清单里那个 `.exe` 的 `.blockmap` | 差分下载（拿**新**的 blockmap 配**本地**的旧文件） |

历史版本一律是死重量 —— 客户端不会去下载旧版本，旧 blockmap 也用不上。

`publish.ps1` 上传完会**自动**跑服务器上的清理脚本。需要先传一次（只需一次）：

```powershell
scp voice-server\scripts\prune-updates.sh root@YOUR_SERVER_IP:/opt/voice-server/scripts/
```

清理脚本也可以手动跑，**默认是试运行**：

```bash
cd /opt/voice-server/scripts
bash prune-updates.sh          # 只列出会删什么
bash prune-updates.sh --yes    # 真的删
```

脚本里的保险：找不到 `latest.yml`、或者清单指向的 exe 不在目录里，
**它会直接停下什么都不删** —— 免得发布出了问题还雪上加霜。

> 另外两处也会涨，但**不要用脚本删**：
> - `/opt/voice-server/data/uploads/` —— 聊天附件和云端文件。
>   元信息在数据库里，直接删文件会让聊天里出现"文件不见了"。
>   要清就在客户端里删。
> - 本地 `release/` 文件夹 —— 每次 `npm run dist` 多一个 80 MB 的 exe。留下最近两三个就行。

---

## ⚠️ 改 `scripts/*.ps1` 之后必须重新加 BOM

`npm run` 调的是 **Windows PowerShell 5.1**（不是 `pwsh`），它默认按**系统 ANSI 编码**
读 `.ps1` 文件。脚本里只要有中文，就会被读成乱码 —— 乱码里如果凑出个引号，
PowerShell 会直接报 `字符串缺少终止符` 而拒绝执行。

**症状**：`npm run publish:update` 报 `ParserError: 字符串缺少终止符`，并且错误信息里的
中文显示成一堆 `鎯崇珛鍒婚獙璇�` 这样的乱码。

**修法**：给文件加 UTF-8 BOM。

```powershell
$p = "voice-client\scripts\publish.ps1"
$c = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText($p, $c, (New-Object System.Text.UTF8Encoding $true))
```

（`UTF8Encoding($true)` 的 `$true` 就是"带 BOM"。）

改完可以这样验证：

```powershell
[System.IO.File]::ReadAllBytes($p)[0..2] | ForEach-Object { $_.ToString('X2') }
# 应该是 EF BB BF
```

> 顺带提醒：脚本里也**别用 `→` 这类字符**，在 GBK 里没有对应字节，容易把解析搞崩。
> 用 `->` 就行。

---

## 自动更新是怎么工作的

用的是 `electron-updater` 的 **generic provider**，更新文件放在**你自己的 ECS** 上：

```
客户端启动 8 秒后
    │
    ├─ GET http://YOUR_SERVER_IP:17706/updates/latest.yml
    │     清单里有：版本号、文件名、sha512
    │
    ├─ 版本号比本地新？
    │     否 → 什么都不做（6 小时后再查）
    │     是 → 顶部弹出提示条「发现新版本 vX.Y.Z」+ 下载 / 以后再说
    │
    └─ 用户点「下载」
          → 按清单里的文件名拉 exe，边下边显示进度
          → 下完校验 sha512 对不上就丢弃
          → 提示「立即重启安装」/「退出时安装」
```

**不依赖 GitHub Releases** —— 那个国内拉不动，而且我们已经在 3005 端口上有个服务了，
复用它可以省掉新端口和安全组规则。

> ⚠️ **只在打包安装后生效。** `npm run dev` 下 `app.isPackaged` 是 false，主进程直接跳过 ——
> 否则 electron-updater 会抛 "application is not packed"。
>
> 想验证自动更新，必须**装一遍旧版本**（比如先装 0.1.0），
> 然后发布 0.2.0，启动旧版等 8 秒就能看到提示条。

### 更新走的是明文 http

这个接口只提供"下载某个文件"，没有凭据可泄露，安装包本身有 sha512 校验，所以够用。
想上 https 的话需要先有域名 + 证书（见 [voice-server/README](../voice-server/README.md) 里关于备案的说明）。

---

## 打包产物说明

| 文件 | 作用 |
|---|---|
| `Voice-v0.2.0-setup.exe` | 安装包，发给朋友 |
| `latest.yml` | **版本清单，自动更新的入口。必须和 exe 一起上传** |
| `Voice-v0.2.0-setup.exe.blockmap` | 差分更新索引（以后能只下变化的部分） |
| `win-unpacked\` | 免安装版，双击直接用（但**没有自动更新**，因为它不是"安装"的） |

---

## 目录结构

```
voice-client/
├── .npmrc                      # 国内镜像（npm + Electron 二进制）
├── package.json
├── electron.vite.config.ts
├── tsconfig.json
└── src/
    ├── main/index.ts           # 主进程：窗口、desktopCapturer、IPC
    ├── preload/index.ts        # contextBridge 白名单
    └── renderer/
        ├── index.html
        └── src/
            ├── main.tsx
            ├── App.tsx         # 三栏布局 + 全部状态编排
            ├── styles.css
            ├── hooks/
            │   └── useVoiceRoom.ts   # LiveKit 房间的 React 封装
            ├── lib/
            │   ├── config.ts         # 本地配置持久化
            │   ├── api.ts            # 换 token / 文字频道 WebSocket
            │   └── livekit.ts        # Room 创建 + 屏幕共享（Electron 专有路径）
            └── components/
                ├── ChannelList.tsx       # 频道列表
                ├── ChatPanel.tsx         # 文字频道
                ├── SettingsDialog.tsx    # 服务器 / 画质设置
                ├── SourcePicker.tsx      # 屏幕/窗口选择器（缩略图网格）
                └── VideoTile.tsx         # 把 LiveKit 轨道挂到 <video>/<audio>
```

> 服务器图标栏、成员列表、语音状态条都内联在 `App.tsx` 里 ——
> 它们和顶层状态耦合太紧，拆出去反而要绕一圈传回调。

---

## 下一步

| 阶段 | 内容 |
|---|---|
| **M4** | **PTT 按住说话**（全局键鼠钩子 `uiohook-napi`）+ 设备选择 + 单人音量调节 |
| M5 | 服务端补完整业务：账号体系、多服务器/频道管理、消息历史翻页、权限 |
| M6 | `electron-builder` 自动更新（`electron-updater` + 自托管更新清单） |

### 关于 PTT 的一个坑

Electron 的 `globalShortcut` **只能注册单次触发，检测不到"按住/松开"状态**，做不了真正的按住说话。需要 `uiohook-napi` 这类全局键鼠钩子。代价是它是原生模块 —— 在国内安装时可能要去 GitHub 下预编译二进制，需要配镜像。
