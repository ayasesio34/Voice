/**
 * 验证 ChatPanel 里那个 dataUrlToBlob。
 *
 * 跑法：node voice-client/scripts/test-dataurl.mjs
 *
 * 为什么值得测：这个函数的输入是**用户框选出来的截图**，
 * 解码错一个字节就是一张打不开的图 —— 而且报错会推迟到上传那一步，更难查。
 *
 * 关键点：测试是**从源码里把函数抠出来**执行的，不是抄一份 ——
 * 抄一份的话改了源码测试还是绿的，等于没测。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { transformSync } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(
  join(here, '..', 'src', 'renderer', 'src', 'components', 'ChatPanel.tsx'),
  'utf8'
)

/** 从源码里抠出一个具名函数的完整文本（按花括号配对） */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`源码里找不到 function ${name}`)

  let depth = 0
  let i = source.indexOf('{', start)
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`${name} 的花括号没有配上对`)
}

const fnSource = extractFunction(src, 'dataUrlToBlob')

// ⚠️ 抠出来的是 **TypeScript**，不能直接 new Function ——
//    先过一遍 esbuild 把类型标注剥掉（vite 自带，不用额外装东西）。
const fnJs = transformSync(fnSource, { loader: 'ts', format: 'esm' }).code

// 只用到 Blob / Uint8Array / atob，Node 都有
const dataUrlToBlob = new Function(`${fnJs}; return dataUrlToBlob;`)()

// ── 脚手架：先把用例收集起来，最后逐个 await ──────────────
const tests = []
const test = (name, fn) => tests.push({ name, fn })

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer())

// ── 用例 ────────────────────────────────────────────────────

test('base64 PNG：字节逐一对得上', async () => {
  const original = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 255, 254, 253])
  const b64 = Buffer.from(original).toString('base64')
  const blob = dataUrlToBlob(`data:image/png;base64,${b64}`)

  assert.equal(blob.type, 'image/png')
  assert.equal(blob.size, original.length)
  assert.deepEqual(Array.from(await bytesOf(blob)), Array.from(original))
})

test('MIME 类型被正确取出', () => {
  assert.equal(dataUrlToBlob('data:image/webp;base64,AAAA').type, 'image/webp')
})

test('★ 0x80 以上的字节不会被截断（charCodeAt 经典坑）', async () => {
  const original = new Uint8Array([0x80, 0xff, 0x00, 0x7f, 0xab, 0xcd])
  const b64 = Buffer.from(original).toString('base64')
  const blob = dataUrlToBlob(`data:application/octet-stream;base64,${b64}`)
  assert.equal(blob.size, 6)
  assert.deepEqual(Array.from(await bytesOf(blob)), [0x80, 0xff, 0x00, 0x7f, 0xab, 0xcd])
})

test('非 base64 的 dataURL 当文本处理', async () => {
  const blob = dataUrlToBlob('data:text/plain,hello%20world')
  assert.equal(blob.type, 'text/plain')
  assert.equal(await blob.text(), 'hello world')
})

test('空的 base64 不会炸', () => {
  assert.equal(dataUrlToBlob('data:image/png;base64,').size, 0)
})

test('没有逗号的畸形输入不会炸', () => {
  // 实际到不了这里 —— 主进程会校验 `data:image/png;base64,` 前缀。
  // 但万一到了也**不该抛异常**：那会让整条截图链路挂掉，而且报错很难懂。
  // 契约是"不炸"，不是"返回空" —— 所以这里只断言类型。
  assert.ok(dataUrlToBlob('garbage') instanceof Blob)
})

test('256KB 数据正确往返（抽查首尾和中间）', async () => {
  const original = new Uint8Array(256 * 1024)
  for (let i = 0; i < original.length; i++) original[i] = (i * 7 + 13) & 0xff
  const b64 = Buffer.from(original).toString('base64')
  const blob = dataUrlToBlob(`data:image/png;base64,${b64}`)

  assert.equal(blob.size, original.length)
  const got = await bytesOf(blob)
  for (const i of [0, 1, 1000, 65535, original.length - 1]) {
    assert.equal(got[i], original[i], `第 ${i} 个字节不对`)
  }
})

test('确认现在是真图：真 PNG 文件能解出正确的文件头', async () => {
  // 一张 1x1 的透明 PNG
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const blob = dataUrlToBlob(`data:image/png;base64,${b64}`)
  const got = await bytesOf(blob)

  assert.equal(blob.type, 'image/png')
  // PNG 的魔数
  assert.deepEqual(Array.from(got.slice(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  // 结尾必须是 IEND
  assert.equal(Buffer.from(got.slice(-8, -4)).toString('ascii'), 'IEND')
})

// ── 执行 ────────────────────────────────────────────────────

console.log('\ndataUrlToBlob 测试\n')

let passed = 0
let failed = 0
for (const t of tests) {
  try {
    await t.fn()
    passed++
    console.log(`  \u2705 ${t.name}`)
  } catch (err) {
    failed++
    console.log(`  \u274c ${t.name}`)
    console.log(`     ${err.message}`)
  }
}

console.log(`\n${'─'.repeat(46)}`)
console.log(`通过 ${passed} / 失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
