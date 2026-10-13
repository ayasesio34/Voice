/**
 * 阶段 2 验证：原生插件能不能拿到 PCM，而且拿到的是**真东西**。
 *
 * 跑法：
 *     cd native/process-loopback
 *     npm run build
 *     node test.js                                  # 基本连通性
 *     node test.js --wav out.wav                    # 顺便存成 WAV 供分析
 *     node test.js --exclude 1234 --wav out.wav     # 排除指定 PID
 *     node test.js --include 1234 --wav out.wav     # 只录指定 PID
 *
 * ⚠️ 光看"收到了多少数据"是**不够**的 ——
 *    静音也会产生同样多的数据块。第一次跑的时候峰值只有 11/32767，
 *    看起来"成功"了，其实什么都没采到。
 *    所以真正判断要靠 --wav 存下来做频谱分析（配合 ../spike/verify.py）。
 */

const fs = require('fs')
const path = require('path')
const loopback = require('./index')

// ── 参数 ────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
function argValue(name, fallback) {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const wavPath = argValue('--wav', '')
const seconds = Number(argValue('--sec', '2'))
const includePid = argValue('--include', '')
const excludePid = argValue('--exclude', '')

const mode = includePid ? 'include' : 'exclude'
const pid = Number(includePid || excludePid) || process.pid

// ── 加载 ────────────────────────────────────────────────────────
console.log('=== 插件加载 ===')
console.log('available:', loopback.available)
if (!loopback.available) {
  console.log('reason:   ', loopback.reason)
  process.exit(1)
}

console.log('\n=== 正在出声的进程 ===')
const sessions = loopback.listSessions()
if (sessions.length === 0) console.log('（没枚举到）')
for (const s of sessions) {
  console.log(`  ${String(s.pid).padEnd(8)} ${(s.name || '?').padEnd(28)} ${s.active ? '出声中' : '空闲'}`)
}

// ── 采集 ────────────────────────────────────────────────────────
console.log(`\n=== 开始采集（mode=${mode}, pid=${pid}）===`)

const cap = loopback.create()
const chunks = []
let chunks2 = 0
let samples = 0
let peak = 0
let sumSquares = 0
let errors = 0

cap.start({ pid, mode }, (buf) => {
  if (buf instanceof Error) {
    errors++
    console.error('  [采集错误]', buf.message)
    return
  }

  chunks2++
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)
  chunks.push(pcm)
  samples += pcm.length

  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]
    const abs = v < 0 ? -v : v
    if (abs > peak) peak = abs
    sumSquares += v * v
  }
})

setTimeout(() => {
  cap.stop()

  const captured = samples / 2 / 48000
  const rms = samples > 0 ? Math.sqrt(sumSquares / samples) : 0

  console.log('\n=== 结果 ===')
  console.log(`  数据块      ${chunks2}`)
  console.log(`  采样数      ${samples}（立体声，等效 ${captured.toFixed(2)} 秒）`)
  console.log(`  峰值        ${peak} / 32767`)
  console.log(`  均方根      ${rms.toFixed(0)} / 32767`)
  console.log(`  错误        ${errors}`)

  // 存 WAV
  if (wavPath && samples > 0) {
    const total = new Int16Array(samples)
    let off = 0
    for (const c of chunks) {
      total.set(c, off)
      off += c.length
    }

    const dataBytes = total.byteLength
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + dataBytes, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20) // PCM
    header.writeUInt16LE(2, 22) // 立体声
    header.writeUInt32LE(48000, 24)
    header.writeUInt32LE(48000 * 4, 28)
    header.writeUInt16LE(4, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(dataBytes, 40)

    const out = path.resolve(wavPath)
    fs.writeFileSync(out, Buffer.concat([header, Buffer.from(total.buffer, total.byteOffset, dataBytes)]))
    console.log(`\n  已写出      ${out}`)
    console.log(`  下一步      python ../spike/verify.py analyze "${out}" --mode ${mode}`)
  }

  if (chunks2 === 0) {
    console.log('\n[X] 一块数据都没收到 —— 采集链路没通')
    process.exit(1)
  }

  // ⚠️ 别拿"收到数据"当成功判据 —— 静音一样有数据。
  if (peak < 50) {
    console.log('\n[!] 峰值极低（几乎是静音）—— 链路通了，但这轮**没采到有意义的声音**。')
    console.log('    要判断包含/排除对不对，先放一个测试音再跑。')
    process.exit(2)
  }

  console.log('\n[OK] 采到了有意义的声音')
}, seconds * 1000)
