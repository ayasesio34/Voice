/**
 * 跑完 voice-server/backend 下所有 test-*.mjs。
 *
 * 跑法（在 voice-server/backend 目录）：node run-tests.mjs
 *
 * ── 为什么要有这个文件 ✗ ────────────────────────────────────
 *   这里本来有 **12 个**测试文件 ✓ 却**没有一个统一的入口** ✗
 *   每次都是临时敲一段 PowerShell 循环 ✓ 而那个循环有两个毛病：
 *
 *     ① 只抓 `^通过` 那一行 ✗
 *        测试挂了的话它只打印一个 ❌ ✓ **看不到任何失败原因** ✗
 *        我第一次遇到 test-reply 变红时就是这样 ✓ 完全无从下手 ✓
 *        只能单独再跑一遍 —— 而单独跑它**又过了** ✗（偶发 ✓）
 *
 *     ② 没有"全过才算过"的退出码 ✗
 *        12 行里混一行 ❌ 很容易看漏 ✓
 *
 * ── 关于偶发 ✗ ──────────────────────────────────────────────
 *   12 个测试会**依次各起一个后端**（各占一个端口 ✓ 各自一个临时库 ✓）
 *   连着跑的时候启动会变慢 ✓ 偶尔有一两个会踩到自己的等待超时 ✓
 *   实测：约 10 次批量里见过 1 次 ✓（单独跑 4/4 全过 ✓）
 *
 *   ⚠️ 所以这个运行器**不做自动重试** ✗
 *      重试只会把"偶发"藏起来 ✓ 而偶发的测试最终会被所有人无视 ✗
 *      它做的是：**失败就把完整输出打出来** ✓ 让人一眼能判断是"真挂了"
 *      还是"启动慢了" ✓ 然后把超时调宽一点 ✓（那才是真正的修法 ✓）
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const files = readdirSync(HERE)
  .filter((f) => /^test-.*\.mjs$/.test(f))
  .sort()

if (files.length === 0) {
  console.log('  没有找到 test-*.mjs ✗')
  process.exit(1)
}

let ok = 0
const failed = []

console.log('')
for (const f of files) {
  const r = spawnSync(process.execPath, [f], { cwd: HERE, encoding: 'utf8' })
  // ⚠️ 把 stdout 和 stderr 合起来找 ✓ 有些测试的失败信息在 stderr ✓
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const line = out.split('\n').find((l) => l.startsWith('通过'))

  if (line && r.status === 0) {
    ok++
    console.log(`  ${f.padEnd(24)} ${line.trim()}`)
  } else {
    failed.push(f)
    console.log(`  ${f.padEnd(24)} ❌ 退出码 ${r.status}`)
    // ★ 这里才是这个文件的重点 ✗
    //   失败时把**完整输出**打出来 ✓ 不截断 ✓
    //   （不然只知道"挂了"、不知道为什么 ✓ 又得单独跑一遍 ✓）
    console.log('  ' + '─'.repeat(60))
    for (const l of out.split('\n')) {
      if (l.trim()) console.log(`     ${l}`)
    }
    console.log('  ' + '─'.repeat(60))
  }
}

console.log('')
if (failed.length > 0) {
  console.log(`  ❌ ${files.length} 个文件里有 ${failed.length} 个没过：${failed.join('、')}`)
  console.log('')
  process.exit(1)
}
console.log(`  ✅ ${ok} 个测试文件全过`)
console.log('')
