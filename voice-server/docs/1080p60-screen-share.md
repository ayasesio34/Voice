# 1080p60 屏幕共享：编码配置与带宽设计

> 目标：屏幕共享跑 **1920×1080 @ 60fps**，文字清晰可读，服务端 100 Mbps 出口不被打爆。

---

## 一、结论先行

**能做到，但有三个硬约束，必须提前设计而不是事后调参。**

| 约束 | 数字 | 后果 |
|---|---|---|
| **服务端出口带宽** | 8 Mbps × 观看人数 | 100 Mbps 上限 → **最多约 11 人同时看** |
| **客户端编码器** | 必须走**硬件编码** | 软件编码 1080p60 会吃满 CPU、掉帧、卡到没法看 |
| **码率 vs 画质** | 屏幕内容（文字）比摄像头难压 | 4 Mbps 的 1080p60 会糊成一团，8 Mbps 起步 |

---

## 二、码率参考

屏幕共享和摄像头直播不是一回事。**摄像头画面是连续的自然图像，压缩率高；屏幕上有大量锐利边缘和静态文字，压缩器很难处理**。所以同样分辨率，屏幕共享需要的码率往往比摄像头更高。

| 内容类型 | 建议码率（1080p60） | 说明 |
|---|---|---|
| PPT / 静态文档 | 3 ~ 5 Mbps | 画面几乎不变，只有鼠标在动 |
| 代码、网页滚动 | 6 ~ 10 Mbps | 文字多 + 滚动会破坏帧间预测 |
| 视频播放 / 游戏 | 12 ~ 20 Mbps | 高运动，最吃带宽 |

**建议的档位设计**（写进客户端设置里）：

| 档位 | 分辨率 | 帧率 | 码率 | 出口/人 |
|---|---|---|---|---|
| 省流 | 1280×720 | 30 | 2.5 Mbps | 2.5 Mbps |
| **标准（默认）** | 1920×1080 | 30 | 5 Mbps | 5 Mbps |
| 流畅 | 1920×1080 | 60 | 8 Mbps | 8 Mbps |
| 高画质 | 1920×1080 | 60 | 12 Mbps | 12 Mbps |

> 💡 **说说 60fps 值不值**：代码、文档、PPT 这类内容，30fps 和 60fps 肉眼几乎没区别 —— 因为画面本身几乎是静止的。60fps 真正有价值的是**滚动长网页、看视频、玩游戏**，以及**你的鼠标指针移动的顺滑感**。
> 8 Mbps@60fps 对比 5 Mbps@30fps，**带宽多了 60%**。建议默认 1080p30，把 60fps 做成一个显式的"流畅模式"开关。你要的 60fps 完全支持，只是别让它当默认值。

---

## 三、编解码器选择（这里是最容易踩坑的地方）

| 编码器 | 屏幕内容压缩效率 | 硬件编码普及度 | 1080p60 可行性 |
|---|---|---|---|
| **H.264** | 一般（基准） | ⭐⭐⭐⭐⭐ NVENC / QuickSync / AMF / VideoToolbox 全都有 | ✅ **稳** |
| **VP9** | 好 30~50% | ⭐⭐ 只有较新的 Intel / AMD 核显 | ⚠️ 多数机器走软件编码 → 掉帧 |
| **AV1** | 最好 | ⭐ RTX 40 系 / Intel Arc | ⚠️ 客户端普及率太低 |

### 推荐策略

```
默认：H.264  —— 保 60fps 稳定，硬件编码覆盖最广
可选：VP9    —— 标为"省流量"档，让 CPU 富余的人自己开
```

**为什么不是 VP9 优先？** VP9 对屏幕内容的压缩确实好得多，而且支持 **SVC**（一次编码产生多个空间层，弱网用户自动降层，不用 3 倍编码开销）。听起来完美。但问题是：**绝大多数消费级 GPU 没有 VP9 硬件编码器**，只能走 CPU 软件编码。1080p60 软件编码可以轻易吃掉 4~8 个核心 —— 而你的用户是普通学生电脑，编码一卡，所有人都跟着卡。

**60fps 是硬需求时，稳定性优先于压缩率。**

> 📌 检测方法：Electron 主进程里 `app.getGPUFeatureStatus()`，看 `video_encode` 是不是 `hardware_accelerated`。如果不是，就老老实实用 H.264 并把帧率降到 30。

---

## 四、关键配置

### 4.1 Room 初始化

```js
import { Room } from 'livekit-client';

const room = new Room({
  // 只订阅屏幕上真正看得见的那几路，别把所有人的流都拉下来
  adaptiveStream: true,
  // 没人订阅的层就不发，直接省服务端出口带宽
  dynacast: true,

  publishDefaults: {
    videoCodec: 'h264',   // 见第三章；想省流量可以切成 'vp9'
    videoEncoding: { maxBitrate: 1_200_000, maxFramerate: 30 }, // 摄像头，与屏幕共享无关

    // ── 屏幕共享 ──────────────────────────────────
    screenShareEncoding: {
      maxBitrate: 8_000_000,
      maxFramerate: 60,
      priority: 'high',
    },

    // ⚠️ 空数组 = 关闭屏幕共享的 simulcast。
    // 1080p60 的三层 simulcast 意味着同时编码 1080p60 + 720p30 + 360p15，
    // 编码开销直接三倍。小圈子场景下不值得。
    screenShareSimulcastLayers: [],

    // ⚠️ 带宽紧张时"保分辨率、降帧率"，而不是"降分辨率"。
    // 屏幕共享最怕的是分辨率被降 —— 文字会糊到不可读。
    degradationPreference: 'maintain-resolution',

    // ── 音频 ──────────────────────────────────────
    dtx: true,   // Opus 静音不发包，语音流量降 40~60%（省的是真金白银）
    red: true,   // 冗余编码，抗丢包
  },
});
```

### 4.2 采集与发布（Electron）

**Electron 里不能用浏览器那套 `getDisplayMedia()`** —— 拿到的会是空流或者报错。必须走 `desktopCapturer` + `chromeMediaSource` 约束。

```js
import { desktopCapturer } from 'electron';
import { Track } from 'livekit-client';

// ① 拿可共享的源
const sources = await desktopCapturer.getSources({
  types: ['screen', 'window'],
  thumbnailSize: { width: 0, height: 0 },  // 不要缩略图，省 CPU 和内存
});

const source = sources.find(s => s.id.startsWith('screen:')) ?? sources[0];

// ② 用 chromeMediaSource 约束采集
const stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    // Windows 上共享整个屏幕时捕获系统声音，就靠这一行
    mandatory: { chromeMediaSource: 'desktop' },
  },
  video: {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: source.id,
      maxWidth: 1920,
      maxHeight: 1080,
      maxFrameRate: 60,
    },
  },
});

// ③ 最关键的一行：告诉编码器"这是文字内容，优先保清晰度"
const videoTrack = stream.getVideoTracks()[0];
videoTrack.contentHint = 'text';   // 老版本 Electron / 浏览器用 'detail'

// ④ 发布
await room.localParticipant.publishTrack(videoTrack, {
  name: 'screen',
  source: Track.Source.ScreenShare,
  simulcast: false,
  videoEncoding: {
    maxBitrate: 8_000_000,
    maxFramerate: 60,
    priority: 'high',
  },
  degradationPreference: 'maintain-resolution',
});

// 系统音频单独发布（LiveKit 需要它作为独立的 audio track）
const audioTrack = stream.getAudioTracks()[0];
if (audioTrack) {
  await room.localParticipant.publishTrack(audioTrack, {
    name: 'screen-audio',
    source: Track.Source.ScreenShareAudio,
  });
}
```

> ⚠️ 上面 `publishDefaults` 的字段名（`screenShareEncoding` / `screenShareSimulcastLayers` / `degradationPreference`）是 `livekit-client` v2 的命名。装完 SDK 后对一下 `TrackPublishDefaults` 的类型定义再动手 —— 这类选项改名不算罕见。

### 4.3 `contentHint` 到底做了什么

`MediaStreamTrack.contentHint` 是给编码器的**语义提示**：

| 值 | 编码器倾向 |
|---|---|
| `'motion'` | 摄像机拍运动物体，容忍模糊 |
| `'detail'` | 高细节但非文字 |
| **`'text'`** | **文字 / 屏幕内容，优先保锐利边缘，允许帧率下降** |

屏幕共享不设这个，编码器会按"运动画面"来优化 —— 结果就是文字边缘出现振铃和模糊。**这一行代码的收益比调码率大。**

---

## 五、带宽与流量

服务端出口 = **单路码率 × 观看人数**（入方向不计费也不算 100 Mbps 上限的对称部分，但出口是实打实的）。

### 8 Mbps（1080p60）档

| 观看人数 | 出口带宽 | 每小时流量 | 占 100 Mbps 上限 |
|---:|---:|---:|---:|
| 2 | 16 Mbps | 7.2 GB | 16% |
| 4 | 32 Mbps | 14.4 GB | 32% |
| 6 | 48 Mbps | 21.6 GB | 48% |
| 8 | 64 Mbps | 28.8 GB | 64% |
| 10 | 80 Mbps | 36.0 GB | 80% |
| **12** | **96 Mbps** | **43.2 GB** | **96% ⚠️** |

**硬上限：约 11 人同时观看一路 1080p60。** 到顶之后所有人一起卡 —— 包括语音，因为语音也走同一块网卡。

### 5 Mbps（1080p30）档

| 观看人数 | 出口带宽 | 每小时流量 |
|---:|---:|---:|
| 4 | 20 Mbps | 9.0 GB |
| 8 | 40 Mbps | 18.0 GB |

> 顺带一个对比：**纯语音**是 32 kbps/路。10 人语音频道服务器出口约 2.9 Mbps —— **一路 1080p60 屏幕共享 ≈ 一路语音频道的 3 倍，而一个人看 8 人共享 ≈ 22 倍。** 这就是为什么前面反复强调码率上限要在客户端里写死。

### 三条省流量的措施

1. **`dynacast: true`** —— 没人订阅的层不发。屏幕上只显示 1 路画面时，其余流不发。
2. **`adaptiveStream: true`** —— 只订阅用户真正看得见的流。
3. **屏幕共享默认 1080p30 / 5 Mbps**，60fps 做成手动开关。

---

## 六、降级策略：弱网观众怎么办

单层 1080p60 的代价是：**一个网络差的观众，要么卡，要么拖累别人的带宽估计**。三种处理方式：

| 方案 | 编码开销 | 弱网体验 | 适用 |
|---|---|---|---|
| **单层 1080p60**（本文默认） | 1× | 差 —— 会卡 | 小圈子、网络都不错 |
| 双层 simulcast：1080p60 + 360p15 | 2× | 好 —— 自动降到 360p | 有人网络不稳定 |
| VP9 SVC | 1×（但软件编码） | 最好 —— 三档空间层 | 客户端 CPU 富余 |

想要双层，把 `screenShareSimulcastLayers` 从 `[]` 改成：

```js
import { VideoPresets } from 'livekit-client';

screenShareSimulcastLayers: [
  // 1080p60 由 screenShareEncoding 定义，这里是额外的低层
  new VideoPreset(640, 360, 500_000, 15),
],
```

**先按单层跑，等真有人抱怨卡再改。** 提前上 simulcast 会让所有人的编码开销翻倍，可能把本来就吃紧的 60fps 拖垮。

---

## 七、验收与排错

在测试页（`tools/test-page`）上共享屏幕，观察：

| 指标 | 期望 | 不达标说明 |
|---|---|---|
| 发送分辨率 | 1920×1080 | 采集约束被改了，或显示器本身不是 1080p |
| 发送帧率 | 接近 60fps | **编码器跟不上** → 查硬件编码、降档 |
| 发送码率 | 稳定在设定值的 ±15% | 网络拥塞或编码器降级 |
| 接收端文字 | 锐利可读 | `contentHint` 没设，或码率太低 |

### 常见现象对照

| 现象 | 原因 | 处理 |
|---|---|---|
| 只有 15~30fps | 走了软件编码 | 用 H.264，或 `app.getGPUFeatureStatus()` 确认 `video_encode` |
| 文字发虚 / 边缘有光晕 | 没设 `contentHint = 'text'` | 加上那一行 |
| 画面突然变模糊（分辨率被降） | `degradationPreference` 是默认的 `balanced` | 改成 `'maintain-resolution'` |
| 观众越多越卡 | 出口带宽到顶 | 降档，或减少同时观看人数 |
| 声音有了但画面黑 | UDP 端口没通 | 回归 [README 第二节](../README.md#二安全组配置) |
| 共享时笔记本风扇狂转 | 软件编码 + 60fps | 降到 1080p30，或换有硬件编码的机器 |

### 实时监控服务端出口

```bash
# 每秒刷新一次，看 eth0 的发送速率（Mbps）
watch -n1 "awk 'NR>2{split(\$0,a,\":\"); if(a[1] ~ /eth|ens/) {split(a[2],b,\" \"); print a[1], b[9]/1000000*8 \" Mbps\"}}' /proc/net/dev"
```

或直接读后端的接口（会把宿主机的网卡统计透出来）：

```bash
curl -s http://127.0.0.1:3000/api/net/summary | head -c 400
```
