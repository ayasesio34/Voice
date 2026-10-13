/**
 * 聊天消息分组的测试。
 *
 * 跑法（在 voice-client 目录）：node scripts/test-chat-groups.mjs
 *
 * ── 为什么这段必须测 ────────────────────────────────────────
 * 分组的边界很容易写错，而错了的表现是
 * "**两句风马牛不相及的话被塞进一个框**" ✗ ——
 * 那不会报错 ✓ 也不会崩 ✓ 就是看着怪 ✓ 很难一眼发现 ✓
 *
 * 尤其两个坑：
 *   · 光判"作者相同"不够 ✗ 一个人上午一句、下午一句（中间没人说话）
 *     会被并成一个框 ✓ 那个框横跨六小时 ✓
 *   · 时间窗口要和**上一条**比，不是和"块的第一条"比 ✗
 *     否则一个人每 4 分钟说一句、连说五条，会被并成一块 ✓ 跨度 16 分钟 ✓
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildSync } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src', 'renderer', 'src', 'lib', 'chatGroups.ts')

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
const { groupMessages, blockWantsBubble, GROUP_WINDOW_MS } = mod

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

const MIN = 60 * 1000
const T0 = 1_700_000_000_000

/** 造一条消息 */
let seq = 0
const m = (author, atMin, opts = {}) => ({
  id: ++seq,
  channel_id: 'general',
  author_id: author,
  author_name: opts.name ?? author,
  body: opts.body ?? 'hi',
  created_at: T0 + atMin * MIN,
  attachment: opts.attachment ?? null,
})

/** 只取"每块几条 + 作者"，方便断言 */
const shape = (blocks) => blocks.map((b) => `${b.authorName}×${b.items.length}`)

console.log('\n聊天消息分组测试\n')

console.log('【基本】')

check('一条消息 → 一个块', () => {
  eq(shape(groupMessages([m('u1', 0, { name: '小明' })])), ['小明×1'])
})

check('空数组 → 空', () => {
  eq(groupMessages([]), [])
})

check('★ 同一个人连发三条 → 合并成一块', () => {
  const b = groupMessages([
    m('u1', 0, { name: '小明' }),
    m('u1', 1, { name: '小明' }),
    m('u1', 2, { name: '小明' }),
  ])
  eq(shape(b), ['小明×3'])
})

check('不同的人 → 各一块', () => {
  const b = groupMessages([m('u1', 0, { name: '小明' }), m('u2', 1, { name: '小红' })])
  eq(shape(b), ['小明×1', '小红×1'])
})

check('★ 别人插一句之后再说话 → 重新开一块', () => {
  // A A B A  →  三块（最后的 A 单独一块）
  const b = groupMessages([
    m('u1', 0, { name: '小明' }),
    m('u1', 1, { name: '小明' }),
    m('u2', 2, { name: '小红' }),
    m('u1', 3, { name: '小明' }),
  ])
  eq(shape(b), ['小明×2', '小红×1', '小明×1'])
})

console.log('\n【★ 两个最容易写错的边界】')

check('★ 同一个人但隔了 10 分钟 → **不**合并', () => {
  const b = groupMessages([m('u1', 0, { name: '小明' }), m('u1', 10, { name: '小明' })])
  eq(shape(b), ['小明×1', '小明×1'])
})

check('★ 时间窗口刚好在边界上（5 分钟）→ 合并', () => {
  const b = groupMessages([m('u1', 0, { name: '小明' }), m('u1', 5, { name: '小明' })])
  eq(shape(b), ['小明×2'])
})

check('★ 超过一秒就不合并（6 分钟）', () => {
  const b = groupMessages([m('u1', 0, { name: '小明' }), m('u1', 6, { name: '小明' })])
  eq(shape(b), ['小明×1', '小明×1'])
})

check('★ 慢慢连发（每条隔 4 分钟、共 5 条）→ 跨度也被压住，不会并成一大块', () => {
  // ⚠️ 这条是冲着"拿**上一条**去比"那个写法来的 ✗
  //    那样写的话每段间隔都在窗口内 → 5 条并成**一块**，跨度 16 分钟 ✓
  //    而一块只显示一个时间（第一条的 ✗）→ 框上写着开头那个时间 ✓ 误导 ✓
  //    拿"块的第一条"比：0/4 一块、8/12 一块、16 单独一块 ✓
  const b = groupMessages([
    m('u1', 0, { name: '小明' }),
    m('u1', 4, { name: '小明' }),
    m('u1', 8, { name: '小明' }),
    m('u1', 12, { name: '小明' }),
    m('u1', 16, { name: '小明' }),
  ])
  eq(shape(b), ['小明×2', '小明×2', '小明×1'])
})

check('★ 每一块的跨度都不超过窗口（那个时间是可信的）', () => {
  const b = groupMessages([
    m('u1', 0, { name: '小明' }),
    m('u1', 4, { name: '小明' }),
    m('u1', 8, { name: '小明' }),
    m('u1', 12, { name: '小明' }),
    m('u1', 16, { name: '小明' }),
  ])
  for (const block of b) {
    const first = block.items[0].created_at
    const last = block.items[block.items.length - 1].created_at
    if (last - first > GROUP_WINDOW_MS) {
      throw new Error(`有一块跨了 ${(last - first) / MIN} 分钟，超过窗口了`)
    }
  }
})

check('时间倒流（时钟不准 / 乱序）不硬并', () => {
  const a = m('u1', 5, { name: '小明' })
  const b2 = m('u1', 0, { name: '小明' })
  eq(shape(groupMessages([a, b2])), ['小明×1', '小明×1'])
})

check('窗口可以调（默认 5 分钟）', () => {
  const msgs = [m('u1', 0, { name: '小明' }), m('u1', 3, { name: '小明' })]
  eq(shape(groupMessages(msgs, 1 * MIN)), ['小明×1', '小明×1'])
  eq(shape(groupMessages(msgs, 10 * MIN)), ['小明×2'])
  eq(GROUP_WINDOW_MS, 5 * MIN, '默认窗口应该是 5 分钟')
})

console.log('\n【块上带的元信息】')

check('key 用第一条消息的 id（稳定，不会因为后面追加而变）', () => {
  const first = m('u1', 0, { name: '小明' })
  const b = groupMessages([first, m('u1', 1, { name: '小明' })])
  eq(b[0].key, String(first.id))
})

check('时间用**第一条**的（一块只显示一个时间）', () => {
  const first = m('u1', 0, { name: '小明' })
  const b = groupMessages([first, m('u1', 3, { name: '小明' })])
  eq(b[0].createdAt, first.created_at)
})

check('作者信息取自组内（作者 id 相同才可能并）', () => {
  const b = groupMessages([m('u1', 0, { name: '小明' }), m('u1', 1, { name: '小明' })])
  eq(b[0].authorId, 'u1')
  eq(b[0].authorName, '小明')
})

console.log('\n【要不要套气泡】')

check('纯文字 → 套气泡', () => {
  eq(blockWantsBubble({ items: [{ attachment: null }] }), true)
})

check('整块都是附件 → 不套（附件自己有形状）', () => {
  eq(blockWantsBubble({ items: [{ attachment: { id: 'f1' } }] }), false)
})

check('★ 一块里既有文字又有附件 → 套（不然文字没有底）', () => {
  eq(blockWantsBubble({ items: [{ attachment: { id: 'f1' } }, { attachment: null }] }), true)
})

console.log(`\n${'─'.repeat(48)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
