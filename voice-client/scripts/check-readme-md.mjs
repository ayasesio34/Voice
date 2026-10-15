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

  // ── ⓪ 代码围栏收尾被粘住 ────────────────────────────────
  // 放在最前面：它是**结构性**的破坏 ✓ 会让后面所有检查都看错东西 ✓
  // （标题粘在围栏上 → 那一整段被当成代码 → 里面什么都不检查 ✓）
  checkFenceTail(lines.join('\n'), rel, fatal)

  // ── ⓪ 乱码检测 ──────────────────────────────────────────
  // ⚠️ 编码事故：UTF-8 的文件被按 GBK 读，整篇会变成「鎯宠绔嬪埢楠岃瘉」这种字 ✓
  //    它**仍然是合法的 Markdown** ✗ 所以下面那几项检查一个都发现不了 ✓
  //    真发生过：make-public.ps1 里 Get-Content 少了 -Encoding UTF8
  //    （PowerShell 5.1 默认按系统代码页读 ✓）→ 生成的 README 整篇乱码 ✓
  //    差一点就推到 GitHub 上了 ✗
  //
  // ⚠️ 判据换过三次，前两次都是错的 ✗
  //    ① 挑「锛」「銆」两个字 → 它们只在原文含标点时才出现 ✓ 没标点的乱码命中 0 ✗
  //    ② 用一段样本生成特征字表 → 只覆盖那段样本用到的字 ✓ 换一段就不在表里 ✗
  //    ③ 现在的判据：**常用汉字的占比** ✓
  //       乱码是把 UTF-8 字节按 GBK 重新配对 ✓ 出来的字几乎全是生僻字 ✓
  //       所以"最常用的那 80 个汉字"在乱码里占比接近 0 ✓
  //       实测：正常中文约 40% ✓ 乱码约 0.5% ✓ 阈值 8% 两边都留了很大余量 ✓
  //       这 80 个字是从仓库语料里统计出来的 ✓ 不是手打的 ✓
  {
    const raw = lines.join('\n')
    if (raw.includes('\uFFFD')) {
      fatal.push(`${rel}  含 U+FFFD 替换字符（文件被用错误的编码读过，有字节已永久丢失）`)
    }
    const COMMON = '的一不是个在了用有会里上音时成出字只到这频就来看那开人端面没自道下本件文条行以进动要后和务名能改器两码屏都服把现新标所声示而也同它程被全发接共掉色口实主置享话设'
    const cjk = raw.match(/[\u4e00-\u9fff]/g) ?? []
    if (cjk.length >= 20) {
      const hit = cjk.filter((c) => COMMON.includes(c)).length
      const ratio = hit / cjk.length
      if (ratio < 0.08) {
        fatal.push(
          `${rel}  疑似乱码（UTF-8 被按 GBK 读）：${cjk.length} 个汉字里只有 ${hit} 个是常用字（${Math.round(ratio * 100)}%，正常中文约 40%）`,
        )
      }
    }
  }
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

// ⚠️ 围栏收尾后面**直接跟内容** ✗
//
//   真发生过：`## 0.50.0` 被粘在代码块收尾的三个反引号后面 ✓
//   变成了 ` ```## 0.50.0 ` ✓
//   → Markdown 认为它还在代码块里 ✓ → **那一版的标题就"消失"了** ✗
//     版本列表从 0.52 / 0.51 / 0.49 直接跳过了 0.50 ✓ 而谁都没发现 ✓
//
//   原来那几条规则（粗体闭合 / 链接 / 表格 / 乱码）都查不到这个 ✗
//   而它是**结构性**的破坏 ✓ 比粗体没闭合严重得多 ✓
//
//   规则：一行如果以三个反引号**开头** ✓ 那它后面除了空白不许有别的东西 ✓
//        （带语言标注的 ` ```js ` 是合法的 ✓ 所以只查**单独的**收尾围栏 ✗）
function checkFenceTail(text, file, problems) {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    // ⚠️⚠️ 第一个版本是错的 ✗ 而**只有"故意弄坏看它红不红"才发现** ✓
    //    当时写的是 `/^```([A-Za-z0-9+#-]*)\s*(\S.*)$/` ✓
    //    我把 `#` 也放进了"语言标注"的字符类里 ✗
    //    → ```` ```## 0.50.0 ```` 被当成"带 `##` 标注的围栏" ✓
    //      → 判定"带标注是合法的" → continue ✗ 永远不报 ✓
    //    **而它看起来是完全正常的** ✗ 光看"没报错"根本发现不了 ✓
    //
    //    这一路的第七次"检查答错了问题" ✗
    //
    //    现在改成问更本质的事：**反引号后面第一个字符是什么** ✓
    //      是字母 → 语言标注（```js ```bash ```json）✓ 合法 ✓
    //      没有东西 → 干净的收尾围栏 ✓ 合法 ✓
    //      **别的任何东西** → 有内容粘上来了 ✗ 报 ✓
    //        能抓到的：#（标题）✓ |（表格）✓ >（引用）✓ -（列表）✓
    //    ⚠️ 粘上来的是**普通文字**抓不到 ✗（```foo 看起来就像语言标注 ✓）
    //       这一条刻意收窄 ✓ 因为"反引号后面跟字母"本来就是合法语法 ✓
    const m = /^```([A-Za-z]|$)/.exec(lines[i])
    if (m) continue
    if (!/^```/.test(lines[i])) continue
    problems.push(
      `${file}:${i + 1}  代码块收尾后面直接粘着内容（会被当成还在代码块里 ✓ 里面的标题会"消失" ✗）: ${JSON.stringify(lines[i].slice(0, 50))}`,
    )
  }
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
