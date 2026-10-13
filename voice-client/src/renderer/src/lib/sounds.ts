/**
 * 提示音。
 *
 * 全部用 **Web Audio 现场合成**，不打包任何音频文件 ——
 * 四个音加起来不到 70 行，比四个 .wav 还小，改起来也不用重新找素材。
 *
 * 音色设计（借鉴 Discord 的思路）：
 *
 *   加入频道   两个音**上行**（C5 → E5）—— 听起来像"来了"
 *   离开频道   两个音**下行**（E5 → C5）—— 听起来像"走了"
 *   开麦       短促的**高**单音
 *   闭麦       短促的**低**单音
 *   开喇叭     两个音**上行**（低音区）
 *   闭喇叭     两个音**下行**（低音区）
 *
 * 上行/下行区分进出，音高区分开麦闭麦 —— 不用记音色也分得出来。
 *
 * **麦和喇叭靠"单音 / 双音"区分**：
 *   麦克风是小的东西，给一个短促单音；
 *   喇叭是大的东西，给两个音、而且落在更低的音区。
 * 这样即使不看屏幕，也能立刻知道自己关的是哪一个 ——
 * 两个都做成同样的"哒"一声，反而分不清。
 *
 * ⚠️ 浏览器要求 AudioContext 必须由**用户手势**启动。
 *    这里的几个音都是在点击/按键之后才播的，所以没问题；
 *    但页面刚加载时如果直接播，会被静默拦掉（不报错，就是没声音）。
 */

/** 本模块专用的 AudioContext。和远端音量那个分开，是为了各自独立、互不拖累 */
let ctx: AudioContext | null = null

function audioCtx(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext()
    // 挂起状态（浏览器自动挂起、或者系统切换音频设备）时唤醒一下
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    // 极少数环境拿不到 AudioContext —— 没提示音不该让别的功能挂掉
    return null
  }
}

const NOTE = {
  C4: 261.63,
  E4: 329.63,
  B4: 493.88,
  C5: 523.25,
  E5: 659.25,
  G5: 783.99,
} as const

type ToneSpec = {
  freq: number
  /** 相对开始时刻的秒数 */
  at: number
  /** 持续秒数 */
  dur: number
  /** 峰值音量 */
  peak?: number
}

/**
 * 一个带包络的正弦音。
 *
 * 包络是关键：起音太慢听不出"点"，收尾太急会有咔哒声。
 * 所以用「12ms 快速淡入 + 指数淡出」。
 */
function tone(c: AudioContext, { freq, at, dur, peak = 0.16 }: ToneSpec): void {
  const t0 = c.currentTime + at
  const osc = c.createOscillator()
  const gain = c.createGain()

  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, t0)

  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)

  osc.connect(gain)
  gain.connect(c.destination)

  osc.start(t0)
  osc.stop(t0 + dur + 0.03)
}

function play(specs: ToneSpec[]): void {
  const c = audioCtx()
  if (!c) return
  for (const s of specs) tone(c, s)
}

// ── 进 / 出语音频道（**所有人都听得见**，由服务端广播触发）────

/** 有人加入语音频道：上行两音 */
export function playJoinSound(): void {
  play([
    { freq: NOTE.C5, at: 0, dur: 0.14, peak: 0.24 },
    { freq: NOTE.E5, at: 0.085, dur: 0.24, peak: 0.24 },
  ])
}

/** 有人离开语音频道：下行两音 */
export function playLeaveSound(): void {
  play([
    { freq: NOTE.E5, at: 0, dur: 0.14, peak: 0.24 },
    { freq: NOTE.C5, at: 0.085, dur: 0.24, peak: 0.24 },
  ])
}

// ── 开麦 / 闭麦（**只有自己听得见**）──────────────────────
//
// ⚠️⚠️ 音高必须落在**人声掩蔽较弱**的频段，这比"音量大"重要得多。
//
// 之前是闭麦 300 Hz、开麦 880 Hz，而且只有 0.08~0.11 秒、峰值 0.13。
// 问题在于**这两个频率都压在语音的能量区里** —— 一边听别人说话、
// 一边按闭麦，那一声会被直接掩蔽掉。用户的原话是"需要仔细去听才能听到"。
//
// 光把音量调大治标不治本（而且会变吵）。真正的修法是**换频段**：
//
//   人耳在 **1~4 kHz** 最敏感，而语音的能量到那个频段已经明显下降了。
//   所以开麦挪到 1568 Hz、闭麦挪到 880 Hz —— 两头都抬进"听得见"的区域。
//
// 两个音仍然差一个八度：低的是"关了"，高的是"开了"，方向感保留。
// 峰值也从 0.13 抬到 0.30 —— 但仍然远不到刺耳的程度。

/** 闭麦：低单音（880 Hz）。比开麦沉，一听就知道是"关了" */
export function playMuteSound(): void {
  play([{ freq: 880, at: 0, dur: 0.16, peak: 0.3 }])
}

/** 开麦：高单音（1568 Hz）。亮，像"打开" */
export function playUnmuteSound(): void {
  play([{ freq: 1568, at: 0, dur: 0.12, peak: 0.3 }])
}

// ── 关喇叭 / 开喇叭（**只有自己听得见**）──────────────────
//
// 和开关麦放在一起对比着看，差别是刻意的：
//
//   麦   → **单音**，高音区（880 / 1568 Hz）
//   喇叭 → **双音**，低音区（330 / 494 Hz）
//
// 单音 vs 双音是一耳朵就能听出来的差别，比"两个不同的音高"可靠得多 ——
// 尤其在游戏里、背景音很吵的时候。
//
// 峰值和开关麦一致（0.30）—— 两组音只差在**形状**和**音区**，
// 不靠音量区分。混着用不同音量只会让人以为哪个坏了。

/** 关喇叭：下行双音。像"合上" */
export function playDeafenSound(): void {
  play([
    { freq: NOTE.B4, at: 0, dur: 0.13, peak: 0.3 },
    { freq: NOTE.E4, at: 0.1, dur: 0.24, peak: 0.3 },
  ])
}

/** 开喇叭：上行双音。像"打开" */
export function playUndeafenSound(): void {
  play([
    { freq: NOTE.E4, at: 0, dur: 0.13, peak: 0.3 },
    { freq: NOTE.B4, at: 0.1, dur: 0.24, peak: 0.3 },
  ])
}
