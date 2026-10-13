/**
 * 进程级音频回环捕获 —— 加载器
 *
 * ⚠️ 这个模块**必须能优雅地加载失败**。
 *
 * 原生插件在几种情况下会拿不到：
 *   · 平台不是 Windows
 *   · 没编译过（`npm run build` 没跑）
 *   · Windows 版本太老（进程级回环需要 Build 20348+）
 *
 * 任何一种情况下，上层都应该**退回现在的整系统捕获**，而不是整个应用起不来。
 * 所以这里不抛异常，而是返回一个 available 标志 + 失败原因。
 */

const path = require('path')

/** 按顺序找编译产物。Release 优先，Debug 兜底 */
const CANDIDATES = [
  path.join(__dirname, 'build', 'Release', 'process_loopback.node'),
  path.join(__dirname, 'build', 'Debug', 'process_loopback.node'),
]

function tryLoad() {
  if (process.platform !== 'win32') {
    return { addon: null, reason: '只有 Windows 支持进程级回环捕获' }
  }

  const failures = []
  for (const file of CANDIDATES) {
    try {
      return { addon: require(file), reason: '' }
    } catch (err) {
      failures.push(`${path.basename(path.dirname(file))}: ${err.message}`)
    }
  }

  return {
    addon: null,
    reason: `原生插件没编译（在 native/process-loopback 下跑 npm run build）—— ${failures.join(' / ')}`,
  }
}

const { addon, reason } = tryLoad()

module.exports = {
  /** 插件能不能用。false 时上层必须退回整系统捕获 */
  available: Boolean(addon),

  /** 不可用的原因。available 为 true 时是空串 */
  reason,

  /**
   * 创建一个捕获器。
   *
   *   const cap = loopback.create()
   *   cap.start({ pid: 1234, mode: 'exclude' }, (buf) => { ... })
   *   cap.stop()
   *
   * `buf` 是**交错立体声、16 位有符号、48kHz** 的 PCM，
   * 也就是可以直接喂给 AudioWorklet 的那种。
   *
   * 插件不可用时返回 null。
   */
  create() {
    return addon ? new addon.ProcessLoopback() : null
  },

  /**
   * 列出默认输出设备上正在出声的进程。
   * 排查"该排除哪个 PID"的时候用，插件不可用时返回空数组。
   */
  listSessions() {
    if (!addon) return []
    try {
      return addon.listSessions()
    } catch {
      return []
    }
  },
}
