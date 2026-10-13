/**
 * README / Markdown 护栏 —— 查那些"写错了但看不出来"的问题。
 *
 * 跑法（在 voice-client 目录）：node scripts/check-readme-md.mjs
 *
 * ── 为什么需要它 ✗ ──────────────────────────────────────────
 * 我往 README 里加那段「进程级音频回环」时写成了：
 *
 *     - **投屏分享的是「游戏 / 音乐」，**不含**频道里的说话声** ——
 *                        ↑ 粗体里又套了粗体 ✗
 *
 * CommonMark 的规则里 `，**不含` 这个 `**` 前面是标点、后面是字 ✓
 * 所以它被当成**开标记**而不是闭标记 ✓ → 粗体一直不闭合 ✓
 * **在 GitHub 上就是渲染坏的样子** ✗ 但在纯文本编辑器里看着完全正常 ✓
 *
 * ── 几条踩过坑才定下来的规则 ✗ ──────────────────────────────
 *
 * ① **只扫 voice-server / voice-client** ✗
 *    最早写成扫整个仓库 ✓ 结果把 market-sim/.venv 里 numpy 的 license
 *    也扫进来报了一堆 ✓（和 check-cmd-ascii.ps1 犯的是同一个错 ✓）
 *
 * ② 粗体按**段落**判，不是按行 ✗
 *    CommonMark 允许粗体**跨行**（只要不跨空行）✓
 *    CHANGELOG 里有大量 `**第一行\n第二行**` ✓ 按行判全是误报 ✓
 *    按段落判才对：跨空行的粗体才是真的没闭合 ✓
 *
 * ③ 表格里 **`\|` 是转义的竖线** ✗
 *    `ss -lntp \| grep 7880` 写在表格单元格里是正确的 ✓
 *    数列数时必须跳过它 ✓ 否则报"列数不齐" ✓
 *
 * ④ 标题跳级只当**警告** ✗
 *    它不影响渲染 ✓ 不该让 npm test 挂掉 ✓
 *
 * ⑤ 代码块（``` 围栏内）里的内容**一律不检查** ✗ —— 那是字面量 ✓
 *
 * ⚠️ 本文件自己也是 .mjs ✓ LF ✓ 不涉及 BOM 那套规则 ✓
 * ⚠️ 消息字符串里**绝对不能**写三个反引号 ✗ 模板字符串会被截断 ✓（真踩过 ✓）
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..') // voice-client/scripts/ → 仓库根

// ⚠️ 只看我们自己的两个项目 ✗ 工作区里还有别的项目 ✓ 不归我们管 ✓
const SCAN_ROOTS = ['voice-server', 'voice-client'].map((d) => join(REPO, d)).filter((d) => existsSync(d))

const SKIP_DIRS = new Set(['node_modules', 'out', 'release', 'dist', '.git', 'build', '.venv', 'venv', '__pycache__'])

const fatal = []
const warnings = []
let fileCount = 0
let lineCount = 0

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(join(dir, e.name), out)
    } else if (e.name.toLowerCase().endsWith('.md')) {
      out.push(join(dir, e.name))
    }
  }
  return out
}

const sh = (s) => String(s).trim().slice(0, 80)

function checkFile(abs) {
  const rel = relative(REPO, abs).replace(/\\/g, '/')
  const isChangelog = /CHANGELOG\.md$/i.test(rel)
  fileCount++

  const lines = readFileSync(abs, 'utf8').split(/\r?\n/)
  lineCount += lines.length
  const dir = dirname(abs)

  // ── 切成"非代码块"的区间 + 段落 ─────────────────────────
  // inFence 为 true 的行不参与任何检查 ✓
  const inFence = new Array(lines.length).fill(false)
  let fence = false
  let fenceStart = 0
  let fenceCount = 0
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      fenceCount++
      if (!fence) {
        fenceStart = i + 1
        inFence[i] = true // 围栏行本身也跳过
        fence = true
      } else {
        inFence[i] = true
        fence = false
      }
      return
    }
    inFence[i] = fence
  })

  if (fenceCount % 2 !== 0) {
    fatal.push(`${rel}:${fenceStart}  代码围栏没闭合（全文 ${fenceCount} 个围栏标记，应为偶数）`)
  }

  // ── ① 逐段落检查粗体 ────────────────────────────────────
  let para = []
  let paraStart = 0
  // ⚠️ 行内代码（`...`）里的 `**` 是**字面量** ✗ 不算粗体标记 ✓
  //    这个项目的文档到处都在讨论 `**` 本身 ✓ 不排掉的话全是误报 ✓（踩过 ✓）
  //
  // ⚠️⚠️ 但是**不能替换成空字符串** ✗
  //     `**为什么不用 \`apt\`**：…` 去掉代码后会变成 `**为什么不用 **：…`
  //     —— 那个 `**` 前面**多了个空格** ✓ flanking 规则就完全变了 ✓
  //     结果把大量**合法**的粗体判成坏的 ✓（真踩过 ✓）
  //     换成**一个普通字母**就对：既不空白、也不标点 ✓ 上下文保持不变 ✓
  const stripCode = (s) => s.replace(/`[^`]*`/g, 'x')

  // ⚠️⚠️ 为什么不能只数"偶数个双星号" ✗
  //
  //   我原来写坏的那一行是：
  //     - **投屏分享的是「游戏 / 音乐」，**不含**频道里的说话声** ——
  //   它一共 **4 个** 双星号 ✓ **是偶数** ✗ 所以"数偶数"根本抓不到 ✓
  //
  //   真正坏在哪里：CommonMark 对 `**` 有 flanking 规则 ✓
  //     · 能不能**开**：后面不是空白 ✓（且后面不是标点、或前面是空白/标点）
  //     · 能不能**闭**：前面不是空白 ✓（且前面不是标点、或后面是空白/标点）
  //   上面那个 `，**不含` —— 前面是标点 `，` ✓ 后面是字 `不` ✗
  //   → **只能开、不能闭** ✓
  //   于是第一个 `**` 一直没被闭合 ✓ 整行渲染就是坏的 ✓
  //   但在纯文本编辑器里看着**完全正常** ✗ 这就是它危险的地方 ✓
  //
  //   判据：**已经开着一个粗体时，又出现一个"只能开"的 `**`** → 一定是写坏了 ✓
  //   （Markdown 本来就不能嵌套 `**` ✓ 所以这个判据不会误伤 ✓）
  const isWs = (c) => c === undefined || /\s/.test(c)
  const isPunct = (c) => c !== undefined && /[\p{P}\p{S}]/u.test(c)

  function findNestedBold(text) {
    const hits = []
    let open = false
    for (let i = 0; i + 1 < text.length; i++) {
      if (text[i] !== '*' || text[i + 1] !== '*') continue
      const before = text[i - 1]
      const after = text[i + 2]
      const canOpen = !isWs(after) && (!isPunct(after) || isWs(before) || isPunct(before))
      const canClose = !isWs(before) && (!isPunct(before) || isWs(after) || isPunct(after))
      if (canClose && open) {
        open = false
      } else if (canOpen) {
        if (open) hits.push(i) // 开着还开 → 写坏了
        open = true
      }
      i++ // 跳过第二个星号
    }
    return hits
  }

  const flushPara = () => {
    if (para.length === 0) return
    const text = stripCode(para.join('\n'))
    const n = (text.match(/\*\*/g) ?? []).length
    if (n % 2 !== 0) {
      fatal.push(`${rel}:${paraStart}  这一段有 ${n} 个双星号（奇数 = 粗体没闭合）: ${sh(para[0])}`)
    }
    const nested = findNestedBold(text)
    if (nested.length > 0) {
      fatal.push(
        `${rel}:${paraStart}  粗体里又开了粗体（那个双星号只能开、不能闭 → 整行渲染会坏）: ${sh(para[0])}`,
      )
    }
    para = []
  }
  lines.forEach((line, i) => {
    if (inFence[i] || line.trim() === '') {
      flushPara()
      return
    }
    if (para.length === 0) paraStart = i + 1
    para.push(line)
  })
  flushPara()

  // ── ② 相对链接和图片必须存在 ────────────────────────────
  lines.forEach((line, i) => {
    if (inFence[i]) return
    const re = /!?\[[^\]]*\]\(([^)\s]+)\)/g
    let m
    while ((m = re.exec(line)) !== null) {
      let target = m[1]
      if (/^(https?:|mailto:|#)/.test(target)) continue
      target = target.split('#')[0]
      if (!target) continue
      if (!existsSync(resolve(dir, decodeURIComponent(target)))) {
        fatal.push(`${rel}:${i + 1}  链接指向的文件不存在（页面上会裂）: ${target}`)
      }
    }
  })

  // ── ③ 表格列数一致（跳过转义的竖线）─────────────────────
  let inTable = false
  let tableCols = 0
  let tableStart = 0
  const countPipes = (line) => {
    // ⚠️ `\|` 是转义的竖线 ✗ 不能算列分隔 ✓
    return (line.replace(/\\\|/g, '').match(/\|/g) ?? []).length
  }
  lines.forEach((line, i) => {
    if (inFence[i] || !/^\s*\|.*\|\s*$/.test(line)) {
      inTable = false
      tableCols = 0
      return
    }
    const cols = countPipes(line)
    if (!inTable) {
      inTable = true
      tableCols = cols
      tableStart = i + 1
    } else if (cols !== tableCols) {
      fatal.push(`${rel}:${i + 1}  表格列数不齐（这块自第 ${tableStart} 行起是 ${tableCols} 个竖线，这行是 ${cols} 个）`)
    }
  })

  // ── ④ 标题跳级（只警告）────────────────────────────────
  let lastLevel = 0
  lines.forEach((line, i) => {
    if (inFence[i]) return
    const m = /^(#{1,6})\s/.exec(line)
    if (!m) return
    const lv = m[1].length
    if (lastLevel > 0 && lv > lastLevel + 1) {
      const from = '#'.repeat(lastLevel)
      const to = '#'.repeat(lv)
      warnings.push(`${rel}:${i + 1}  标题从 ${from} 跳到 ${to}: ${sh(line)}`)
    }
    lastLevel = lv
  })
}

const files = SCAN_ROOTS.flatMap((r) => walk(r)).sort()
for (const f of files) checkFile(f)

console.log('')
console.log(`  扫了 ${fileCount} 个 .md 文件 / ${lineCount} 行（只扫 voice-server 和 voice-client）`)
console.log('')

if (warnings.length > 0) {
  console.log(`  ⚠️  ${warnings.length} 条警告（不影响渲染，不阻塞）：`)
  for (const w of warnings) console.log('      ' + w)
  console.log('')
}

if (fatal.length === 0) {
  console.log('  ✅ 没有发现会破坏渲染的问题')
  console.log('')
  process.exit(0)
}

console.log(`  ❌ ${fatal.length} 个必须修的问题：`)
console.log('')
for (const p of fatal) console.log('    ' + p)
console.log('')
process.exit(1)
