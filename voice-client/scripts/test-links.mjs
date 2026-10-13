/**
 * 聊天里链接识别的测试。
 *
 * 跑法（在 voice-client 目录）：
 *     node scripts/test-links.mjs
 *
 * ── 为什么值得单独测 ────────────────────────────────────────
 * 这里有两类很容易写错、而且**错了很难发现**的东西：
 *
 *   1. **协议白名单**。只认 http/https —— 要是把 `javascript:` 也当链接，
 *      点一下就执行任意脚本。这条必须机器盯着。
 *   2. **结尾标点**。中文里「看这个 https://a.com。」太常见了，
 *      正则吞掉句号之后链接就变成 `https://a.com。`，点开 404。
 *
 * ⚠️ 正则从**源码里抠出来**，不在这里重抄一遍 ——
 *    抄一遍就等于测了个副本，源码改坏了测试照样绿。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CHAT = join(here, '..', 'src', 'renderer', 'src', 'components', 'ChatPanel.tsx')
const APP = join(here, '..', 'src', 'renderer', 'src', 'App.tsx')
const src = readFileSync(CHAT, 'utf8')
const appSrc = readFileSync(APP, 'utf8')

/** 从源码里抠一个正则字面量 */
function grabRegex(name) {
  // ⚠️ 里面的 `.*` 必须**贪婪** —— 正则字面量里本身就有转义的斜杠
  //    （`/https?:\/\//`），非贪婪会在第一个 `/` 就停下，切出个半截。
  const m = src.match(new RegExp(`^const ${name} = (/.*/[a-z]*)$`, 'm'))
  if (!m) throw new Error(`源码里找不到 ${name}`)
  // eslint-disable-next-line no-eval
  return eval(m[1])
}

const URL_RE = grabRegex('URL_RE')
const TRAILING_PUNCT = grabRegex('TRAILING_PUNCT')

/** 和 renderBody 里一样的提取方式 */
function extract(text) {
  return [...text.matchAll(URL_RE)].map((m) => {
    const raw = m[0]
    const url = raw.replace(TRAILING_PUNCT, '')
    return { url, tail: raw.slice(url.length) }
  })
}

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
  if (A !== B) throw new Error(`${msg ?? ''}\n     实际 ${A}\n     期望 ${B}`)
}

console.log('\n聊天链接识别测试\n')
console.log('【协议白名单】')

check('识别 http 和 https', () => {
  eq(extract('http://a.com https://b.com').map((x) => x.url), ['http://a.com', 'https://b.com'])
})

check('★ javascript: 不当链接（点一下就是任意脚本执行）', () => {
  eq(extract('javascript:alert(1)'), [])
})

check('★ data: / file: / vbscript: 都不当链接', () => {
  eq(extract('data:text/html,<script>x</script> file:///C:/windows vbscript:msgbox'), [])
})

check('裸域名不识别（`a.com` 可能是文件名，误判更烦）', () => {
  eq(extract('看 a.com 和 b.cn'), [])
})

check('邮件地址不识别（本轮只做 http/https）', () => {
  eq(extract('mailto:a@b.com'), [])
})

console.log('\n【结尾标点】')

check('★ 中文句号不吞进链接', () => {
  // 现在中文标点被正则直接排除，所以它根本没被匹配到 ——
  // 链接是干净的，标点原样留在正文里（renderBody 会把中间的文字原样输出）
  eq(extract('看这个 https://a.com/x。').map((x) => x.url), ['https://a.com/x'])
})

check('★ 英文句号 / 逗号也不吞', () => {
  eq(extract('see https://a.com/x.').map((x) => x.url), ['https://a.com/x'])
  eq(extract('a https://a.com/x, b').map((x) => x.url), ['https://a.com/x'])
})

check('★ 全角括号不吞', () => {
  eq(extract('（见 https://a.com/x）').map((x) => x.url), ['https://a.com/x'])
})

check('★ ASCII 右括号**保留** —— 维基百科那类链接自带括号', () => {
  eq(extract('https://en.wikipedia.org/wiki/Foo_(bar)').map((x) => x.url), [
    'https://en.wikipedia.org/wiki/Foo_(bar)',
  ])
})

check('感叹号 / 问号结尾不吞（但链接里的 ?a=1 要留着）', () => {
  eq(extract('真的？https://a.com/x?id=1！').map((x) => x.url), ['https://a.com/x?id=1'])
})

check('中英混排：多个链接 + 中间的文字', () => {
  const r = extract('先看 https://a.com/1，再看 https://b.com/2。')
  eq(r.map((x) => x.url), ['https://a.com/1', 'https://b.com/2'])
})

console.log('\n【不该误伤】')

check('链接里带路径 / 查询 / 锚点都完整保留', () => {
  eq(extract('https://a.com/p/q?x=1&y=2#frag').map((x) => x.url), ['https://a.com/p/q?x=1&y=2#frag'])
})

check('中文紧贴链接时，**在中文处截断**（中文不是链接的一部分）', () => {
  // 之前我以为是"保留中文"，是错的：URL 里出现裸中文极罕见，
  // 而「看这个 https://a.com/x然后呢」这种太常见了 —— 截断更安全
  eq(extract('这是https://a.com/x这是中文').map((x) => x.url), ['https://a.com/x'])
})

check('链接末尾紧跟中文标点 + 文字，也在标点前截断', () => {
  eq(extract('看这个 https://a.com/1，再看别的').map((x) => x.url), ['https://a.com/1'])
})

check('尖括号 / 引号内的链接能正确截断', () => {
  eq(extract('<https://a.com/x>').map((x) => x.url), ['https://a.com/x'])
  eq(extract('"https://a.com/x"').map((x) => x.url), ['https://a.com/x'])
})

console.log('\n【源码里的双保险】')

check('★ 渲染层显式拦了非 http(s)（不只靠正则）', () => {
  // 那一道在 App.tsx 的 openLink 里 —— 所以两个文件都要读
  if (!appSrc.includes('/^https?:\\/\\//i.test(url)')) {
    throw new Error('App.tsx 里应该还有一道 ^https?:// 校验')
  }
})

console.log(`\n${'─'.repeat(48)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
