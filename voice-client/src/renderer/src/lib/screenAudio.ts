/**
 * 屏幕共享的「系统声音」—— 走原生插件的**进程级回环捕获**。
 *
 * ── 为什么不用浏览器自带的那套 ──────────────────────────────
 * Chromium 的 `chromeMediaSource: 'desktop'` 录的是**默认输出设备正在播放的一切**，
 * 而通话里别人的说话声正是从那儿出去的 —— 所以对方一定会听到自己说话的回声。
 * 换耳机也没用：录的是数字流，耳机和音箱是同一路。
 *
 * 原生插件能反过来做「系统混音 **减去** 本软件的进程树」：
 *
 *     游戏 + 音乐 + 通话声  −  本软件  =  游戏 + 音乐
 *
 * 通话声**物理上没进过采集链路**，零音质损失。
 *
 * ── 数据路径 ────────────────────────────────────────────────
 * 原生插件输出的正好是 **16 位有符号 / 48kHz / 交错立体声**，
 * 而 `AudioData` 直接支持 `format: 's16'` —— 所以**中间不需要任何转换**：
 *
 *     PCM(Uint8Array) → new AudioData({format:'s16'})
 *        → MediaStreamTrackGenerator.writable
 *           → MediaStreamTrack → 交给 LiveKit 发布
 *
 * 不需要 AudioWorklet、不需要环形缓冲、不需要重采样。
 *
 * ── 排除谁 ──────────────────────────────────────────────────
 * 排除的是 **Electron 主进程**那棵树。Chromium 的音频是由一个独立的
 * AudioService 子进程播放的，而它是主进程的直接子进程 ——
 * 排除主进程就把它一起排掉了（这条链路在 native/spike 里双向实测过）。
 */

/** `MediaStreamTrackGenerator` 还没进 TS 的标准 DOM 类型，自己声明一下 */
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'audio' | 'video' })
  readonly writable: WritableStream<AudioData>
}

export type ScreenAudioSupport = {
  available: boolean
  reason: string
}

/** 原生捕获能不能用。不能用时上层要退回 Chromium 的整系统捕获 */
export function screenAudioSupport(): ScreenAudioSupport {
  const api = window.desktop?.screenAudio
  if (!api) return { available: false, reason: '这个客户端版本没有原生捕获接口' }
  return { available: api.available, reason: api.reason }
}

/** 当前正在跑的采集。同一时间只允许一个 */
let active: { stop: () => void } | null = null

/** 停掉当前的系统声音采集。没在跑时什么也不做 */
export function stopScreenAudio(): void {
  if (!active) return
  const a = active
  active = null
  try {
    a.stop()
  } catch {
    /* 停的时候出错没什么可做的 */
  }
}

/**
 * 起一路「不含通话声」的系统声音采集，返回可以直接发布的音轨。
 *
 * 拿不到原生插件时返回 null —— 上层应该退回 Chromium 的整系统捕获，
 * **而不是让共享失败**。功能降级比功能没有强。
 */
export async function startScreenAudioTrack(): Promise<MediaStreamTrack | null> {
  stopScreenAudio()

  const api = window.desktop?.screenAudio
  if (!api?.available) return null

  if (typeof MediaStreamTrackGenerator !== 'function' || typeof AudioData !== 'function') {
    // 理论上不会发生（Electron 33 实测两个都有），但真遇到了就别硬来
    return null
  }

  const generator = new MediaStreamTrackGenerator({ kind: 'audio' })
  const writer = generator.writable.getWriter()

  let timestampUs = 0
  let stopped = false
  let writeFails = 0

  const stop = (): void => {
    if (stopped) return
    stopped = true
    try {
      api.stop()
    } catch {
      /* ignore */
    }
    // 先关 writer 再停轨道 —— 反过来的话 write() 会挂在已结束的流上
    void writer.close().catch(() => undefined)
    try {
      generator.stop()
    } catch {
      /* ignore */
    }
  }

  active = { stop }

  // ⚠️ 回调是**高频**的（每 10ms 一块左右），里面别做任何重活。
  //    这里只做一次 AudioData 包装然后丢给 writer。
  api.start(
    (pcm: Uint8Array) => {
      if (stopped || pcm.byteLength === 0) return

      // 背压：writer 消费不过来时宁可丢块，也不能无限堆积。
      // 音频堆积的后果是延迟越滚越大，最后完全没法听。
      if (writer.desiredSize !== null && writer.desiredSize < -20) return

      const totalSamples = pcm.byteLength / 2
      const frames = Math.floor(totalSamples / 2) // 2 声道
      if (frames <= 0) return

      let audioData: AudioData
      try {
        audioData = new AudioData({
          format: 's16',
          sampleRate: 48000,
          numberOfFrames: frames,
          numberOfChannels: 2,
          timestamp: Math.round(timestampUs),
          // 必须传 Int16Array 视图，而且长度要和 numberOfFrames 对得上 ——
          // pcm 可能带偏移，所以要显式构造视图而不是直接用 .buffer
          //
          // `as ArrayBuffer`：TS 5.7 之后 `ArrayBufferView.buffer` 的类型是
          // ArrayBufferLike（含 SharedArrayBuffer），而 AudioData 要的是 BufferSource，
          // 对不上报错。这里是普通 ArrayBuffer（跨 contextBridge 过来的 Buffer
          // 就是普通 buffer），所以断言是安全的。
          data: new Int16Array(pcm.buffer as ArrayBuffer, pcm.byteOffset, frames * 2),
        })
      } catch {
        return
      }

      timestampUs += (frames / 48000) * 1e6

      writer.write(audioData).catch(() => {
        // 写失败通常意味着轨道被停了，累计几次就自己收摊
        writeFails += 1
        if (writeFails > 10) stop()
      })
    },
    () => {
      // 采集出错（比如 Windows 版本不支持）—— 停掉，别让半死不活的轨道挂在那
      stop()
    }
  )

  return generator
}
