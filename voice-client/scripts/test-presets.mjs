/**
 * 投屏档位的测试。
 *
 * 跑法（在 voice-client 目录）：node scripts/test-presets.mjs
 *
 * ── 为什么这个也值得测 ──────────────────────────────────────
 * 两个都是"错了不会报错、但用户一眼看出来"的东西：
 *
 * ① **标签里的 Mbps 必须和真实 kbps 一致** ✗
 *    以前标签是手写的 ✓ 改了 kbps 忘了改标签 → 界面显示的还是旧数字 ✓
 *    用户照着标签判断"够不够清楚" ✗ 实际码率早变了 ✓ 这种谎最难发现 ✓
 *
 * ② **码率不能低于屏幕内容的合理密度** ✗
 *    屏幕上是锐利的文字和 UI 边缘 ✓ 一糊就看不清 ✓
 *    摄像头画面柔 ✓ 同样码率能看 ✓ —— 屏幕共享不行 ✓
 *    原来 1080p60 给 8 Mbps = 0.064 比特/像素/帧 ✓ 偏低 ✓ 文字发虚 ✓
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildSync } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src', 'renderer', 'src', 'lib', 'livekit.ts')

const built = buildSync({
  entryPoints: [SRC],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
})
const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')
)
const { PRESETS, presetByKey, presetShort, degradationFor } = mod

let pass = 0
let fail = 0
const check = (name, fn) => {
  try {
    fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (err) {
    fail++
    console.log(`  ❌ ${name}`)
    console.log(`     ${err.message}`)
  }
}
const eq = (a, b, msg) => {
  const A = JSON.stringify(a)
  const B = JSON.stringify(b)
  if (A !== B) throw new Error(`${msg ?? ''}  实际 ${A} 期望 ${B}`)
}

/** 比特 / 像素 / 帧 —— 衡量"这个码率配这个分辨率够不够" */
const bpp = (p) => (p.kbps * 1000) / (p.width * p.height * p.fps)

console.log('\n投屏档位测试\n')

console.log('【结构】')

check('档位不是空的，key 不重复', () => {
  if (PRESETS.length === 0) throw new Error('空的')
  const keys = PRESETS.map((p) => p.key)
  if (new Set(keys).size !== keys.length) throw new Error(`key 有重复：${keys}`)
})

check('每个档位字段齐全、都是正数', () => {
  for (const p of PRESETS) {
    for (const k of ['width', 'height', 'fps', 'kbps']) {
      if (!Number.isFinite(p[k]) || p[k] <= 0) throw new Error(`${p.key}.${k} = ${p[k]}`)
    }
    if (typeof p.label !== 'string' || !p.label) throw new Error(`${p.key} 没有 label`)
  }
})

check('presetByKey 找得到，找不到时有兜底', () => {
  eq(presetByKey('1080p60').key, '1080p60')
  const fallback = presetByKey('不存在的档位')
  if (!fallback || !fallback.key) throw new Error('没有兜底')
  // ⚠️ 兜底必须是**明确的那一档**，不能靠下标 ✗
  //    在列表里插入新档位会让 PRESETS[1] 换成别的 ✓ 静悄悄地变 ✓
  eq(fallback.key, '1080p30', '兜底应该固定是 1080p30，不该随列表顺序漂移')
})

check('★ 每个档位的 key 唯一，而且插入新档位不会改兜底', () => {
  const keys = PRESETS.map((p) => p.key)
  eq(new Set(keys).size, keys.length, 'key 不该重复')
  eq(presetByKey('随便什么').key, '1080p30')
})

check('presetShort 就是档位短名（2K 显示成 2K30，不是 1440p30）', () => {
  eq(presetShort(presetByKey('1080p60hq')), '1080p60')
  eq(presetShort(presetByKey('720p30')), '720p30')
  // ⚠️ 这一条是防"两处叫法不一样"的：选择器里写 2K30、
  //    状态条如果显示 1440p30，用户会以为是两个不同的档位 ✗
  eq(presetShort(presetByKey('1440p30')), '2K30')
  eq(presetShort(presetByKey('1440p60')), '2K60')
})

console.log('\n【★ 标签必须和真实码率一致】')

check('★ 标签里的 Mbps 是从 kbps 算出来的（改一个不会漏另一个）', () => {
  for (const p of PRESETS) {
    const mbps = p.kbps % 1000 === 0 ? String(p.kbps / 1000) : (p.kbps / 1000).toFixed(1)
    if (!p.label.includes(`${mbps} Mbps`)) {
      throw new Error(`${p.key} 标签写的是「${p.label}」，但 kbps=${p.kbps}（应该是 ${mbps} Mbps）`)
    }
  }
})

check('标签以档位短名开头（两处叫法必须一致）', () => {
  for (const p of PRESETS) {
    if (!p.label.startsWith(p.name)) {
      throw new Error(`${p.key} 标签「${p.label}」应该以「${p.name}」开头`)
    }
  }
})

console.log('\n【★ 码率够不够（屏幕内容）】')

check('★ 每一档的比特/像素/帧 都在屏幕内容的合理区间（0.08~0.20）', () => {
  for (const p of PRESETS) {
    const v = bpp(p)
    if (v < 0.08) {
      throw new Error(
        `${p.key} 只有 ${v.toFixed(3)} 比特/像素/帧 —— 太低了，文字会发虚 ` +
          `（屏幕内容至少要 0.10 上下，摄像头才用 0.03~0.05）`
      )
    }
    if (v > 0.2) {
      throw new Error(`${p.key} 到了 ${v.toFixed(3)} —— 没必要这么高，纯烧流量`)
    }
  }
})

check('★ 1080p60 那一档不能低于 10 Mbps（这就是"很模糊"的那一档）', () => {
  const p = presetByKey('1080p60')
  if (p.kbps < 10000) throw new Error(`1080p60 只有 ${p.kbps / 1000} Mbps`)
})

check('★ 像素多的档位码率也要高（2K 不能和 1080p 一个码率）', () => {
  const p1080 = presetByKey('1080p30')
  const p2k = presetByKey('1440p30')
  const pxRatio = (p2k.width * p2k.height) / (p1080.width * p1080.height)
  const kbpsRatio = p2k.kbps / p1080.kbps
  // 同帧率下，码率增长不该明显落后于像素增长
  if (kbpsRatio < pxRatio * 0.8) {
    throw new Error(`2K 像素是 1080p 的 ${pxRatio.toFixed(2)} 倍，码率却只有 ${kbpsRatio.toFixed(2)} 倍`)
  }
})

check('60fps 的档位码率高于同分辨率的 30fps 档位', () => {
  if (presetByKey('1080p60').kbps <= presetByKey('1080p30').kbps) {
    throw new Error('1080p60 不该比 1080p30 低')
  }
  if (presetByKey('1440p60').kbps <= presetByKey('1440p30').kbps) {
    throw new Error('2K60 不该比 2K30 低')
  }
})

console.log('\n【★ 内容提示 → 缺带宽时牺牲什么】')

check('★ 选「视频优先」时必须**保帧率**（这就是"看视频卡顿"的解药）', () => {
  eq(degradationFor('motion'), 'maintain-framerate')
})

check('文字/细节/不设置 → 保清晰（丢帧率，静态画面无所谓）', () => {
  eq(degradationFor('text'), 'maintain-resolution')
  eq(degradationFor('detail'), 'maintain-resolution')
  eq(degradationFor(''), 'maintain-resolution')
})

check('★ 只有 motion 是保帧率，别的一律保清晰（别写反了）', () => {
  const keepFps = ['text', 'detail', '', 'motion'].filter(
    (h) => degradationFor(h) === 'maintain-framerate'
  )
  eq(keepFps, ['motion'])
})

console.log('\n【当前实际档位】')
for (const p of PRESETS) {
  const gb = ((p.kbps / 1000) * 3600) / 8 / 1000
  console.log(
    `  ${p.label.padEnd(28)} ${p.width}x${p.height}@${p.fps}  ` +
      `比特/像素/帧=${bpp(p).toFixed(3)}  约 ${gb.toFixed(1)} GB/时`
  )
}

console.log(`\n${'─'.repeat(56)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
