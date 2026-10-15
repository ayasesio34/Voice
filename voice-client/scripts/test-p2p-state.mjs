/**
 * 投屏 P2P **状态机**的测试。
 *
 * 跑法（在 voice-client 目录）：node scripts/test-p2p-state.mjs
 *
 * ── 为什么只测这两个函数 ✗ ──────────────────────────────────
 *   `screenShareP2P.ts` 整体要 React + 浏览器才能跑 ✓ 在这儿测不了 ✓
 *   但真正决定"界面上那个徽章显示什么"的 ✓ 是里面两个**纯函数** ✓
 *   而那正是最该测对的地方 ✗
 *     徽章标错了，用户会去查一个**根本不存在**的问题 ✓
 *     比如明明在走服务器却写着"直连" ✓ 他会一直以为服务器没省下来流量 ✓
 *
 * ── 传输层本身在哪测 ✓ ──────────────────────────────────────
 *   `verify-p2p-transport.mjs` —— 两个真 Chrome、真建 RTCPeerConnection、
 *   真的数帧 ✓（连接建起来但没画面是最常见的失败方式 ✓ 光看状态不够 ✓）
 *   这个文件**不重复**那部分 ✓
 *
 * ── ⚠️ 还有一块**没验到**的 ✗ ───────────────────────────────
 *   "分享端开广播 + 观看端开接收" 这段**跟着 React 状态走的编排** ✓
 *   要真机两台机器联调才验得了 ✓
 *   （门面图 fixture 用的是假 LiveKit 地址 ✓ 根本没有语音房间 ✓）
 *   所以这一块现在只有 typecheck 兜着 ✓ —— 这个事实必须写在 CHANGELOG 里 ✗
 */

import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(join(tmpdir(), 'voice-p2pstate-'))

let pass = 0
let fail = 0
function check(name, fn) {
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

function load() {
  const built = buildSync({
    entryPoints: [join(ROOT, 'src', 'renderer', 'src', 'lib', 'screenShareP2P.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    target: 'node20',
    logLevel: 'silent',
  })
  const out = join(tmp, 'm.mjs')
  writeFileSync(out, built.outputFiles[0].text)
  return import(pathToFileURL(out).href)
}

async function main() {
  const { mergeStates, verdict, badgeFor } = await load()
  console.log('')

  check('什么都没有 → idle（**注意：这不代表不显示徽章** ✗ 见下面的 badgeFor 那几条 ✓）', () => {
    assert.equal(verdict({}), 'idle')
  })

  check('全部 connected → p2p（显示"直连"✓）', () => {
    assert.equal(verdict({ a: 'connected', b: 'connected' }), 'p2p')
  })

  check('有一个还在连 → connecting（显示"直连中…"✓）', () => {
    assert.equal(verdict({ a: 'connected', b: 'connecting' }), 'connecting')
    assert.equal(verdict({ a: 'connecting' }), 'connecting')
  })

  check('★ 只要**有一个**打不通 → relay（不能报"直连"✗）', () => {
    // ⚠️ 这是这个状态机里最重要的一条 ✗
    //    有一个人在走服务器 ✓ 就不能跟他说"你们是直连" ✓
    //    他那边可能画质不一样 ✓ 而他会一直不知道自己是例外 ✓
    assert.equal(verdict({ a: 'connected', b: 'connected', c: 'failed' }), 'relay')
    // 哪怕只有一个连上了、其余全失败，也得报 relay ✓
    assert.equal(verdict({ a: 'connected', b: 'failed' }), 'relay')
  })

  check('failed 优先于 connecting（已经在走服务器了，别再显示"直连中"✗）', () => {
    assert.equal(verdict({ a: 'failed', b: 'connecting' }), 'relay')
  })

  check('mergeStates：新状态覆盖旧的 ✓', () => {
    const r = mergeStates({ a: 'connecting' }, { a: 'connected' })
    assert.deepEqual(r, { a: 'connected' })
  })

  check('mergeStates：不同的人各自保留 ✓', () => {
    const r = mergeStates({ a: 'connected' }, { b: 'connecting' })
    assert.deepEqual(r, { a: 'connected', b: 'connecting' })
  })

  check('★ mergeStates：idle **不进表** ✗（不然会越积越多 ✓）', () => {
    // ⚠️ 'idle' 的语义是"这个 key 还没有状态"✓ 不是一种状态 ✓
    //    塞进表里的话，拆掉的连接会永远留在表里 ✓
    //    于是 verdict 一直算上它 ✓ 徽章就再也回不到 idle 了 ✗
    const r = mergeStates({ a: 'connected' }, { a: 'idle' })
    assert.deepEqual(r, {}, `idle 应该被丢掉，实际=${JSON.stringify(r)}`)
    assert.equal(verdict(r), 'idle')
  })

  check('mergeStates：传空对象不会清掉已有的 ✓', () => {
    // 某一方暂时没有状态时不该把表清空 ✓（另一方可能还有连接 ✓）
    const r = mergeStates({ a: 'connected' }, {})
    assert.deepEqual(r, { a: 'connected' })
  })
  // ══════════════════════════════════════════════════════════
  // ★★ 徽章**必须一直存在** ✗ —— 一个真 bug 的回归测试
  //
  //   用户报的：「投屏时的徽章只出现一下就消失了」
  //   根因：徽章的**存在与否**取决于 verdict 的结果 ✓
  //         而 verdict 在没有 P2P 连接时返回 idle ✓
  //         而 App 里 idle → null → 徽章消失 ✗
  //         而"一条连接都没有"正是接收端 unwatch 之后的那一刻 ✓
  //
  //   ⚠️ 而上面那条测试原来的名字是「什么都没有 → idle（**不显示徽章** ✓）」
  //      —— 那个括号里的假设**就是**这个 bug ✗ 一起改掉了 ✓
  //
  //   现在：存在与否看"画面上有没有投屏" ✓ 写什么看 badgeFor ✓
  //        所以 badgeFor **一个状态都不许返回 null** ✗
  // ══════════════════════════════════════════════════════════

  check('★ 每个状态都有徽章（一个都不许是 null ✗）', () => {
    for (const s of ['idle', 'connecting', 'p2p', 'relay']) {
      const b = badgeFor(s)
      assert.ok(b, s + ' 没有徽章 ✗ —— 这就是"闪一下就没了"那个 bug ✓')
      assert.ok(b.textKey, s + ' 缺 textKey ✗')
      assert.ok(b.tipKey, s + ' 缺 tipKey ✗')
    }
  })

  check('★ idle 尤其不能没有 ✗（原来它返回 null ✓）', () => {
    const b = badgeFor('idle')
    assert.ok(b, 'idle 返回了 null ✗ 徽章会消失 ✓')
    assert.equal(b.cls, 'warn', 'idle 应当是 warn ✓（画面在走服务器 ✓）')
  })

  check('★ idle 说「未建立直连」而**不是**「经服务器」✗', () => {
    // ⚠️ 第一版让 idle 借用 relay 的正文（都是"经服务器"）✗ 那是错的 ✓
    //    用户量出来服务器流量**低于基线**（没在转发画面 ✓）
    //    而徽章写着"经服务器" ✓ → 他合理地以为 P2P 没生效 ✓
    //    其实那一轮**根本没人观看** ✓ 没有画面在传 ✓
    assert.equal(badgeFor('idle').textKey, 'p2p.notDirect')
    assert.notEqual(
      badgeFor('idle').textKey,
      badgeFor('relay').textKey,
      'idle 不能再说"经服务器" ✗ 没人看的时候没有画面在传 ✓',
    )
    assert.notEqual(badgeFor('idle').tipKey, badgeFor('relay').tipKey)
  })

  check('p2p → 直连 ✓ 绿色 ✓', () => {
    assert.equal(badgeFor('p2p').textKey, 'p2p.direct')
    assert.equal(badgeFor('p2p').cls, 'ok')
  })

  check('connecting → 直连中… ✓ 无色 ✓', () => {
    assert.equal(badgeFor('connecting').textKey, 'p2p.connecting')
    assert.equal(badgeFor('connecting').cls, '')
  })

  check('四种状态的正文键**互不重复** ✓（不能两个状态显示同一句话 ✓）', () => {
    const keys = ['idle', 'connecting', 'p2p', 'relay'].map((s) => badgeFor(s).textKey)
    // idle 现在有**自己的**正文 ✓ 所以四个状态应当是 4 个不同的 ✓
    assert.equal(new Set(keys).size, 4)
  })

  console.log('')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  console.log('')

  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.log('  ❌ ' + err.message)
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(1)
})
