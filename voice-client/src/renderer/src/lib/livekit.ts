import {
  AudioPresets,
  Room,
  Track,
  type RoomOptions,
  type LocalTrackPublication,
} from 'livekit-client'
import { stopScreenAudio } from './screenAudio'

// ─────────────────────────────────────────────────────────────
// 音频质量
//
// 显式指定档位，而不是吃 LiveKit 的默认值 —— 这样"现在是什么音质"有确定答案。
//
// Opus 的采样率固定 48 kHz，能调的只有码率和声道数。LiveKit 提供的预设
// （数值取自 SDK 源码，没写声道数 —— 声道由采集端决定，麦克风默认单声道）：
//
//   telephone               12 kbps
//   speech                  24 kbps
//   music                   48 kbps   ← 麦克风用这个
//   musicStereo             64 kbps   ← 共享声音用这个
//   musicHighQuality        96 kbps
//   musicHighQualityStereo 128 kbps
// ─────────────────────────────────────────────────────────────

/**
 * 麦克风：**96 kbps 单声道**。
 *
 * ⚠️ 把这笔账写清楚，免得以后有人以为是免费的 ✗
 *    Opus 单声道对"人说话"在 32 kbps 就已经透明 ✓
 *    所以 48 → 96 kbps 在多数情况下**听不出差别** ✓
 *    但这是明确选择要留余量 ✓ 那就把代价写在这儿 ✓
 *
 * SFU 是"收 1 份、发 N-1 份" ✓ 5 个人的服务端出口：
 *
 *     48 kbps（music）              5 × 4 × 48k  = 0.96 Mbps
 *     96 kbps（musicHighQuality）   5 × 4 × 96k  = 1.92 Mbps   ← 当前
 *     128 kbps（musicHighQualityStereo）5 × 4 × 128k = 2.56 Mbps
 *
 * 开了 DTX 之后静音期间不发包 ✓ 实际平均比上面低 40~60% ✓
 * 而且**投屏改走 P2P 之后服务器出口基本只剩语音** ✓ 1.92 Mbps 完全放得下 ✓
 * （⚠️ 那个改造完成之前别动这一档 ✗ 那时服务器还要扛投屏 ✓ 加起来就超 6 Mbps 了）
 *
 * ★ 为什么是 96 而不是 128 ✗
 *   128 那一档（musicHighQualityStereo）是**给立体声源准备的** ✓
 *   麦克风是**单声道** ✓ 用它会白白多花 33% 的带宽 ✓ 而听感没有区别 ✓
 *   96 kbps 单声道已经**远超**人声透明所需的码率 ✓
 *
 * ⚠️ 语音"听起来不对"的时候，第一个该怀疑的**不是码率** ✗
 *     ① AGC（自动增益）—— 大声时被压出 artifact ✓ 最像"大声就卡/发闷"
 *     ② 降噪 —— 处理过头会让人声发闷、带金属感
 *     ③ 回声消除 —— 外放时最容易出问题
 *    这三项在设置面板里都能单独关 ✓ **先让出问题的人关掉 AGC 试试** ✓
 */
export const MIC_AUDIO_PRESET = AudioPresets.musicHighQuality

/**
 * 共享的系统声音：游戏声 / 视频声 / 音乐，**立体声 128 kbps**。
 *
 * ⚠️ 这一档和麦克风不一样 ✗ —— 音乐是**真的吃码率** ✓
 *    原来用的是 musicStereo（64 kbps 立体声）✓
 *    立体声要摊到两个声道 ✓ 等于**每个声道只有 32 kbps** ✗
 *    放音乐时会明显发闷、镲片糊成一片 ✓
 *    提到 128 kbps 立体声（每声道 64 kbps）是**真能听出区别的** ✓✓
 *
 * 代价很小 ✓ 因为它**只在"投屏 + 勾了分享声音"时才有这一路** ✓
 * 单路 128 kbps ✓ 对 6 Mbps 的服务器可以忽略 ✓
 */
export const SCREEN_AUDIO_PRESET = AudioPresets.musicHighQualityStereo

// ─────────────────────────────────────────────────────────────
// 画质档位
// 屏幕共享的码率参考见 voice-server/docs/1080p60-screen-share.md
// ─────────────────────────────────────────────────────────────
export type Preset = {
  key: string
  /** 档位的短名（720p30 / 2K60…）—— 状态条上显示这个 ✓ 标签也从它开头 ✓ */
  name: string
  label: string
  width: number
  height: number
  fps: number
  kbps: number
}

/**
 * ⚠️ 档位标签里的 Mbps **是从 `kbps` 算出来的**，不是手写的。
 *
 *    以前是手写的 ✗ —— 于是"改了 kbps 忘了改标签"时，界面上显示的还是旧数字 ✓
 *    用户照着标签判断"够不够清楚" ✗ 而实际码率已经变了 ✓ 这种谎最难发现 ✓
 */
function presetLabel(name: string, note: string, kbps: number): string {
  const mbps = kbps % 1000 === 0 ? String(kbps / 1000) : (kbps / 1000).toFixed(1)
  return `${name} · ${mbps} Mbps（${note}）`
}

/**
 * 屏幕共享的档位。
 *
 * ── 码率是怎么定的 ──────────────────────────────────────────
 * **屏幕内容和摄像头画面完全不是一回事** ✗：
 *   摄像头画面是柔和的、可以糊一点 ✓
 *   屏幕上是**锐利的文字和 UI 边缘** ✓ 一糊就看不清 ✓
 * 所以同样分辨率，屏幕共享需要的码率要高得多 ✓
 *
 * 粗略的经验值（比特 / 像素 / 帧）：
 *   摄像头   ≈ 0.03~0.05
 *   屏幕     ≈ **0.10~0.15**  ← 这里就是按这个定的
 *
 * 比如 1080p60 = 1920×1080×60×0.10 ≈ **12 Mbps** ✓
 * （原来给的是 8 Mbps ✗ 折算下来 0.064 ✓ 偏低了 ✓ 文字发虚 ✓）
 *
 * ⚠️ **代价是流量**（服务器按流量计费 ✓ 出口 = 观看人数 × 码率 × 时长）：
 *      8 Mbps ≈ 3.6 GB/时      12 Mbps ≈ 5.4 GB/时
 *     16 Mbps ≈ 7.2 GB/时      24 Mbps ≈ 10.8 GB/时
 *    4 个人看 2K60 一小时 ≈ 43 GB ✗ 心里有个数 ✓
 */
export const PRESETS: Preset[] = (
  [
    // ⚠️ 最省流那一档是给"服务器出口只有 6 Mbps"这种机器准备的 ✓
    //    投屏是**一发多收**：服务器出口 = 观看人数 × 码率 ✗
    //    4 Mbps 的档两个人看就要 8 Mbps ✗ 6M 的机器塞不下 ✓
    //    2.5 Mbps 两个人看 = 5 Mbps ✓ 加上语音刚好卡在 6M 以内 ✓
    //    代价是清晰度密度掉到 0.090（屏幕内容理想是 0.10~0.15）✓
    //    → 看文档还够用 ✓ 看视频会有点糊 ✓ 但**至少不卡** ✓
    { key: '720p30low', name: '720p30', note: '最省流 · 2 人同看', width: 1280, height: 720, fps: 30, kbps: 2500 },
    { key: '720p30', name: '720p30', note: '省流', width: 1280, height: 720, fps: 30, kbps: 4000 },
    { key: '1080p30', name: '1080p30', note: '标准', width: 1920, height: 1080, fps: 30, kbps: 8000 },
    { key: '1080p60', name: '1080p60', note: '流畅', width: 1920, height: 1080, fps: 60, kbps: 12000 },
    { key: '1080p60hq', name: '1080p60', note: '高画质', width: 1920, height: 1080, fps: 60, kbps: 16000 },
    // 2K。⚠️ 像素数比 1080p 多 78% ✓ 按 1080p 的码率推 2K 只会得到一片糊的文字 ✓
    { key: '1440p30', name: '2K30', note: '清晰', width: 2560, height: 1440, fps: 30, kbps: 16000 },
    { key: '1440p60', name: '2K60', note: '很吃流量', width: 2560, height: 1440, fps: 60, kbps: 24000 },
  ] as const
).map((p) => ({ ...p, label: presetLabel(p.name, p.note, p.kbps) }))

export function presetByKey(key: string): Preset {
  // ⚠️ 兜底要**按 key 找**，不能用 PRESETS[1] ✗
  //    在列表里插入新档位时，下标会整体挪位 ✓
  //    那样"找不到时退回哪一档"就悄悄变了 ✓ 很难发现 ✓
  return PRESETS.find((p) => p.key === key) ?? PRESETS.find((p) => p.key === '1080p30') ?? PRESETS[0]
}

/**
 * 状态条用的短标签，例如 "1080p60"、"2K60"。
 *
 * ⚠️ 直接返回档位的 `name`，**不要**再用 `${height}p${fps}` 拼 ✗ ——
 *    那样 2K 会显示成 "1440p30" ✗ 而选择器里写的是 "2K30" ✓
 *    同一个东西两处叫法不一样，用户会以为是两个档位 ✓
 */
export function presetShort(p: Preset): string {
  return p.name
}

export type VideoCodecChoice = 'h264' | 'vp9' | 'vp8'

/** 编码器说明：
 *  - h264：硬件编码覆盖最广（NVENC / QuickSync / AMF），1080p60 最稳 ← 默认
 *  - vp9 ：屏幕内容压缩率好 30~50%，但多数消费级 GPU 没有硬件编码器，1080p60 会掉帧
 *  - vp8 ：兼容性兜底
 */
export const CODECS: { key: VideoCodecChoice; label: string }[] = [
  { key: 'h264', label: 'H.264（推荐，硬件编码最普及）' },
  { key: 'vp9', label: 'VP9（压缩好，但多数机器软件编码）' },
  { key: 'vp8', label: 'VP8（兼容性兜底）' },
]

/**
 * 创建一个 Discord 式语音房间。
 *
 * 几个关键取舍（都是踩过坑换来的）：
 *
 * 1. screenShareSimulcastLayers: []
 *    1080p60 的三层 simulcast 意味着同时编码 1080p60 + 720p30 + 360p15，
 *    编码开销直接三倍，小圈子场景不值得。
 *
 * 2. degradationPreference: 'maintain-resolution'
 *    带宽紧张时"保分辨率、降帧率"。屏幕共享最怕分辨率被降 —— 文字会糊到不可读。
 *
 * 3. dtx + red
 *    dtx 让 Opus 静音时不发包（语音流量降 40~60%，这在按流量计费的服务器上是真金白银）；
 *    red 是音频冗余编码，抗丢包。
 *
 * 4. adaptiveStream + dynacast
 *    只订阅屏幕上真正看得见的那几路；没人看的流不发。省客户端带宽也省服务端出口。
 *    ⚠️ 副作用：房间里只有你一个人时，你共享的屏幕码率会显示为 0 —— 这是正常的，
 *       不是故障。开第二个客户端进来就能看到码率起来。
 */
export function createRoom(opts: { codec: VideoCodecChoice; preset: Preset }): Room {
  const options: RoomOptions = {
    adaptiveStream: true,
    dynacast: true,
    publishDefaults: {
      videoCodec: opts.codec,
      // 音频档位显式指定 —— 见文件顶部 AUDIO_QUALITY 的说明
      audioPreset: MIC_AUDIO_PRESET,
      dtx: true,
      red: true,
      // 摄像头参数（与屏幕共享无关，给以后开摄像头留的）
      videoEncoding: { maxBitrate: 1_200_000, maxFramerate: 30 },
      // 屏幕共享参数
      screenShareEncoding: {
        maxBitrate: opts.preset.kbps * 1000,
        maxFramerate: opts.preset.fps,
        priority: 'high',
      },
      screenShareSimulcastLayers: [],
      degradationPreference: 'maintain-resolution',
    },
  }
  return new Room(options)
}

export type ScreenShareHandle = {
  stop: () => Promise<void>
}

/**
 * 从指定的屏幕/窗口源开始共享。
 *
 * ⚠️⚠️ Electron 里**不能**用浏览器的 `getDisplayMedia()` —— 拿到的会是空流或者直接报错。
 *      必须：先用主进程的 `desktopCapturer.getSources()` 拿到 sourceId，
 *      再用 `chromeMediaSource: 'desktop'` 约束交给 `getUserMedia`。
 *
 * 另一个关键点：采集之后、编码开始之前，把 `contentHint` 设成 'text'。
 * 这是告诉编码器"这是文字内容，优先保锐利边缘"—— 收益比从 6 Mbps 调到 8 Mbps 更大。
 * 不设的话编码器会按"运动画面"优化，文字边缘会出振铃和模糊。
 */
/**
 * 「内容提示」—— 告诉编码器这是什么画面，它会据此决定**牺牲什么** ✓
 *
 * ⚠️ **这个选择比码率影响更大** ✗ 别小看它 ✓
 *
 *   'text'   文字/文档 ✓ 保清晰 ✓ 缺带宽时**降帧率** ✗
 *            （看代码、网页、表格用这个 ✓ 静态画面不需要高帧率 ✓）
 *
 *   'detail' 细节优先 ✓ 和 text 类似 ✓ 更偏"保细节" ✓
 *
 *   'motion' 视频/动态 ✓ **保流畅** ✓ 缺带宽时**降分辨率** ✓
 *            （看视频、打游戏、看动画必须用这个 ✓）
 *
 *   ''       不设置 ✓ 交给浏览器自己判断 ✓（通常偏 motion ✓）
 *
 * ── 为什么加 'motion' ✗ ────────────────────────────────────
 * 原来只有 text / detail / '' ✗ —— **前两个都是"保细节"** ✓
 * 于是"看视频"这种高动态场景被按"文字"编码 ✓ 帧率一直被压 ✓ **卡顿** ✓
 *
 * 实测证据（用户报的）：
 *   · 共享**纯文字**画面 → 流畅 ✓
 *   · 共享**视频**画面   → 第三个人看着也卡 ✓ 而分享者自己**不卡** ✓
 *   → 排除了机器满载（他自己不卡 ✓）和某个观看者的网络（大家都卡 ✓）
 *   → 就是**内容相关**的帧率丢失 ✓ 正是 text 提示的语义 ✓
 */
export type ContentHint = 'text' | 'detail' | 'motion' | ''

/**
 * 内容提示 → 缺带宽时**牺牲什么**。
 *
 * - `motion`  → `maintain-framerate` ✓ **丢分辨率保流畅** ← 视频要的 ✓
 * - 其余     → `maintain-resolution` ✓ 丢帧率保清晰 ← 文档要的 ✓
 *
 * ⚠️ 抽成纯函数是为了能单测 ✓ —— 这个值不体现在界面上 ✗
 *    写错了没有任何报错 ✓ 只有"用起来卡"或者"用起来糊" ✓
 */
export function degradationFor(contentHint: ContentHint): RTCDegradationPreference {
  return contentHint === 'motion' ? 'maintain-framerate' : 'maintain-resolution'
}

export async function publishScreenFromSource(
  room: Room,
  sourceId: string,
  preset: Preset,
  contentHint: ContentHint,
  withAudio: boolean,
  /**
   * 外部准备好的系统声音轨道（进程级回环捕获，**不含通话声**）。
   *
   * 传了它就用它，同时 `withAudio` 应该传 false —— 否则 Chromium 也会采一份，
   * 通话声又跟着回来了。
   */
  externalAudio: MediaStreamTrack | null = null
): Promise<ScreenShareHandle> {
  const constraints = {
    audio: withAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: preset.width,
        maxHeight: preset.height,
        maxFrameRate: preset.fps,
      },
    },
  } as unknown as MediaStreamConstraints

  const stream = await navigator.mediaDevices.getUserMedia(constraints)

  const videoTrack = stream.getVideoTracks()[0]
  if (!videoTrack) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error('没有拿到视频轨道，可能这个源不支持捕获')
  }

  if (contentHint) {
    try {
      videoTrack.contentHint = contentHint
    } catch {
      /* 老版本 Electron / 浏览器不支持就忽略 */
    }
  }

  await room.localParticipant.publishTrack(videoTrack, {
    name: 'screen',
    source: Track.Source.ScreenShare,
    simulcast: false,
    videoEncoding: {
      maxBitrate: preset.kbps * 1000,
      maxFramerate: preset.fps,
      priority: 'high',
    },
    // ⚠️ 跟着内容提示走：选「视频/动态」时是 maintain-framerate ✓
    //    （缺带宽就降分辨率 ✓ 保住流畅 ✓）—— 看视频/游戏卡顿就是这条治的 ✓
    degradationPreference: degradationFor(contentHint),
  })

  // 系统声音作为独立轨道发布。
  //
  // 优先用外面传进来的 externalAudio —— 那是原生插件采的，
  // **已经排除了本软件的进程树，所以不含通话声**。
  // 它拿不到时才退回 Chromium 的整系统捕获（那个会把通话声一起录进去）。
  const audioTrack = externalAudio ?? stream.getAudioTracks()[0]
  if (audioTrack) {
    try {
      await room.localParticipant.publishTrack(audioTrack, {
        name: 'screen-audio',
        source: Track.Source.ScreenShareAudio,
        // 共享的是内容声（游戏/视频），用立体声高一点的档位
        audioPreset: SCREEN_AUDIO_PRESET,
      })
    } catch {
      audioTrack.stop()
    }
  }

  // 用户从系统 UI（比如 Windows 的"停止共享"浮条）停止时，LiveKit 会结束轨道。
  // 这里监听一下，好让界面同步回未共享状态。
  videoTrack.addEventListener('ended', () => {
    void stopScreenShare(room)
  })

  return {
    stop: () => stopScreenShare(room),
  }
}

/** 停止屏幕共享：取消发布并关掉底层采集轨道 */
export async function stopScreenShare(room: Room): Promise<void> {
  // 原生插件那路采集不在 room 里，要单独停 —— 忘了它就会一直占着音频设备
  stopScreenAudio()

  const pubs: LocalTrackPublication[] = []
  const p1 = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)
  const p2 = room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)
  if (p1) pubs.push(p1)
  if (p2) pubs.push(p2)

  for (const pub of pubs) {
    const track = pub.track
    if (!track) continue
    try {
      await room.localParticipant.unpublishTrack(track)
    } catch {
      /* ignore */
    }
    try {
      track.mediaStreamTrack?.stop()
    } catch {
      /* ignore */
    }
  }
}
