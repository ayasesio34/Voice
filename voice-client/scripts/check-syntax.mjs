/**
 * 用 `node --check` 检查所有脚本的**语法**。
 *
 * 跑法（在 voice-client 目录）：node scripts/check-syntax.mjs
 *
 * ── ⚠️⚠️ 为什么必须有这个 ✗ ─────────────────────────────────
 *
 *   这个项目有一类**重复踩了 5 次**的坑 ✓
 *
 *   好几个 verify-*.mjs 的测试页是写成**模板字符串**的：
 *       const driver = `...页面的 JS 代码...`
 *   而模板字符串里只要出现一个**没转义的反引号** ✓
 *   ——哪怕它在一个注释里 ✓ —— 就会把它**提前截断** ✗
 *   于是后面那段中文说明被当成 JS 代码 → 语法错 → 整个脚本起不来 ✓
 *
 *   最近一次（第 5 次）：
 *       verify-p2p-hook.mjs 的注释里写了「`!== false`」✓
 *       → `SyntaxError: Unexpected identifier 'cfg'` ✓
 *
 *   ⚠️ 这不是"难查的 bug" ✗ —— `node --check` **一秒就能抓出来** ✓
 *      问题是：**没人跑它** ✓
 *      `npm test` 里跑的只有 test-*.mjs ✓ 而 verify-*.mjs **不在里面** ✓
 *      （它们要开浏览器、几分钟 ✓ 不适合每次跑 ✓）
 *      → 但"语法对不对"这个最便宜的检查完全可以每次跑 ✓
 *
 * ── 为什么只查语法，不查别的 ✗ ───────────────────────────────
 *   verify-*.mjs 要真开 Chrome、真建 WebRTC ✓ 那几分钟只能手工跑 ✓
 *   这里只做**静态**那一点 ✓ 但恰好是踩坑最多的那一点 ✓
 *
 * ── ⚠️ 为什么连 `src/` 也查 ✗ ────────────────────────────────
 *   `src/` 底下是 .ts / .tsx ✓ node --check 解析不了 ✓ 跳过 ✓
 *   那些由 `npm run typecheck` 兜着 ✓（它跑得也很快 ✓）
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 要检查的目录（相对 ROOT） */
const DIRS = ['scripts', 'src']
/** 能被 node --check 直接解析的扩展名（.ts 不行 ✗ 那走 typecheck ✓） */
const EXTS = new Set(['.mjs', '.cjs', '.js'])

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    // ⚠️ node_modules 一定要跳 ✗ 否则要检查几万个文件 ✓
    if (name === 'node_modules' || name === '.git' || name === 'out' || name === 'release') continue
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out)
    else if (EXTS.has(p.slice(p.lastIndexOf('.')))) out.push(p)
  }
  return out
}

const files = DIRS.flatMap((d) => walk(join(ROOT, d))).sort()

let pass = 0
let fail = 0

console.log('')
console.log(`  语法检查 ${files.length} 个文件…`)

for (const f of files) {
  const rel = relative(ROOT, f).replace(/\\/g, '/')
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
    pass++
  } catch (err) {
    fail++
    console.log(`  ❌ ${rel}`)
    const msg = String(err.stderr ?? err.message)
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 6)
    for (const l of msg) console.log(`       ${l}`)
    // ⚠️ 这类错误九成是模板字符串被反引号截断 ✗ 直接把怀疑方向说出来 ✓
    console.log('       ↳ 如果报的是 Unexpected identifier / Unexpected token：')
    console.log('         多半是这个文件里的**模板字符串**被一个没转义的反引号截断了 ✓')
    console.log('         driver 页面里的注释**不要写反引号** ✗ 用「」代替 ✓')
  }
}

console.log('')
console.log(`  通过 ${pass} / 失败 ${fail}`)
console.log('')

process.exit(fail === 0 ? 0 : 1)
