/**
 * 「谁在看这一路投屏」的挑选逻辑测试。
 *
 * 跑法（在 voice-client 目录）：node scripts/test-viewers.mjs
 *
 * ── 为什么这段必须单独测 ────────────────────────────────────
 * 界面那层**没法截图验证** —— 要真的开一路投屏、再让第二个人真的去看，
 * 才能看到那叠头像。而这里挑错了（把自己算进去、漏人、超出上限）
 * 全是"看起来能用"的错误，肉眼很难发现。
 *
 * 所以把挑选逻辑抽成纯函数、用这个测试钉住；
 * 界面那层只剩摆放和样式，能出错的余地小得多。
 *
 * 用 esbuild 把模块**打包**后直接 import（它依赖 ./names，
 * 单文件 transform 解析不了相对导入，必须 bundle）。
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildSync } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src', 'renderer', 'src', 'lib', 'viewers.ts')

const built = buildSync({
  entryPoints: [SRC],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
})
const code = built.outputFiles[0].text
const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const { pickViewers, MAX_VISIBLE_VIEWERS } = mod

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

/** 造一个语音房间成员 */
const m = (userId, name, opts = {}) => ({
  userId,
  identity: userId,
  name,
  avatar: opts.avatar ?? '',
  joinedAt: opts.joinedAt ?? 0,
  attributes: opts.watch ? { watch: opts.watch } : {},
})

const SID = 'SC_abc'

const SRC_HOVER = join(here, '..', 'src', 'renderer', 'src', 'lib', 'stageHover.ts')
const hoverBuilt = buildSync({
  entryPoints: [SRC_HOVER],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
})
const hoverMod = await import(
  'data:text/javascript;base64,' + Buffer.from(hoverBuilt.outputFiles[0].text).toString('base64')
)
const { inTopZone, inCornerZone, CONTROLS_SHOW_AT, CONTROLS_HIDE_AT, CORNER_SHOW_AT, CORNER_HIDE_AT } =
  hoverMod

console.log('\n「谁在看投屏」挑选逻辑测试\n')

console.log('【基本】')

check('一个人都没在看 → 空（界面就该什么都不渲染）', () => {
  eq(pickViewers([m('u1', '小明'), m('u2', '小红')], SID, 'u1'), {
    shown: [],
    extra: 0,
    allNames: [],
    total: 0,
  })
})

check('★ 只有自己在看 → 也是空（自己不是观众）', () => {
  // 共享画面的人自己的客户端也在"看"自己那一路 ——
  // 以前这里硬塞了个「你」，于是一个人没来也显示"1 人在看"。
  eq(pickViewers([m('u1', '小明', { watch: SID })], SID, 'u1').total, 0)
})

check('别人在看 → 挑出来', () => {
  const r = pickViewers([m('u1', '小明', { watch: SID }), m('u2', '小红', { watch: SID })], SID, 'u1')
  eq(r.total, 1)
  eq(r.shown.map((v) => v.name), ['小红'])
  eq(r.allNames, ['小红'])
})

check('★ 自己 + 别人 → 只算别人', () => {
  const r = pickViewers(
    [m('u1', '小明', { watch: SID }), m('u2', '小红', { watch: SID }), m('u3', '小刚', { watch: SID })],
    SID,
    'u1'
  )
  eq(r.total, 2)
  eq(r.allNames, ['小红', '小刚'])
})

console.log('\n【不能算进来的】')

check('在看**别路**投屏的人不算', () => {
  const r = pickViewers(
    [m('u2', '小红', { watch: 'SC_other' }), m('u3', '小刚', { watch: SID })],
    SID,
    'u1'
  )
  eq(r.allNames, ['小刚'])
})

check('没写 watch 属性的人不算', () => {
  eq(pickViewers([m('u2', '小红')], SID, 'u1').total, 0)
})

check('没有正在共享的投屏（sid 为空）→ 空', () => {
  eq(pickViewers([m('u2', '小红', { watch: SID })], null, 'u1').total, 0)
  eq(pickViewers([m('u2', '小红', { watch: SID })], undefined, 'u1').total, 0)
})

check('房间是空的 / 没加入频道 → 空，而且不抛异常', () => {
  eq(pickViewers([], SID, 'u1').total, 0)
  eq(pickViewers(undefined, SID, 'u1').total, 0)
})

console.log(`\n【上限：最多叠 ${MAX_VISIBLE_VIEWERS} 个，多的收成 +N】`)

check(`6 个人在看 → 显示 ${MAX_VISIBLE_VIEWERS} 个 + 「+2」`, () => {
  const members = ['u2', 'u3', 'u4', 'u5', 'u6', 'u7'].map((id, i) =>
    m(id, `人${i + 1}`, { watch: SID, joinedAt: i })
  )
  const r = pickViewers(members, SID, 'u1')
  eq(r.shown.length, MAX_VISIBLE_VIEWERS)
  eq(r.extra, 2)
  eq(r.total, 6)
  // ★ allNames 要是**全部** 6 个 —— 悬停提示里不能只剩前面几个
  eq(r.allNames.length, 6)
})

check('刚好 4 个 → extra 是 0（不显示 +0）', () => {
  const members = ['u2', 'u3', 'u4', 'u5'].map((id, i) => m(id, `人${i + 1}`, { watch: SID, joinedAt: i }))
  eq(pickViewers(members, SID, 'u1').extra, 0)
})

check('max 可以调小（界面上万一窄了）', () => {
  const members = ['u2', 'u3', 'u4'].map((id, i) => m(id, `人${i + 1}`, { watch: SID, joinedAt: i }))
  const r = pickViewers(members, SID, 'u1', 1)
  eq(r.shown.length, 1)
  eq(r.extra, 2)
})

console.log('\n【顺序和重名】')

check('★ 按进频道的先后排（不排的话头像每轮轮询都在跳）', () => {
  const members = [
    m('u3', '晚来的', { watch: SID, joinedAt: 3000 }),
    m('u2', '早来的', { watch: SID, joinedAt: 1000 }),
  ]
  eq(pickViewers(members, SID, 'u1').allNames, ['早来的', '晚来的'])
})

check('重名时 display 带后缀，但 allNames 用原始名字', () => {
  const members = [
    m('u2', '小明', { watch: SID, joinedAt: 1 }),
    m('u3', '小明', { watch: SID, joinedAt: 2 }),
  ]
  const r = pickViewers(members, SID, 'u1')
  // 悬停提示里给后缀是噪音 —— 那是给头像区分用的
  eq(r.allNames, ['小明', '小明'])
  const displays = r.shown.map((v) => v.display)
  if (displays[0] === displays[1]) throw new Error(`重名的显示名应该不一样：${displays}`)
})

check('头像原样带出来（喂给 <Avatar raw=…>）', () => {
  const av = '{"color":"#5865f2","emoji":"🐱"}'
  const r = pickViewers([m('u2', '小红', { watch: SID, avatar: av })], SID, 'u1')
  eq(r.shown[0].avatar, av)
})

check('每个人都带稳定 key（做 React key 用）', () => {
  const r = pickViewers([m('u2', '小红', { watch: SID }), m('u3', '小刚', { watch: SID })], SID, 'u1')
  eq(r.shown.map((v) => v.key), ['u2', 'u3'])
})

console.log('\n【★ 唤醒区：鼠标划到哪里，控制条 + 叠头像才出来】')

// 舞台矩形：从 (100, 50) 到 (1100, 650)
const RECT = { left: 100, top: 50, right: 1100, bottom: 650 }
const BL = { x: 130, y: 620 } // 左下角
const TL = { x: 130, y: 80 } // 左上角
const BR = { x: 1050, y: 620 } // 右下角
const MID = { x: 600, y: 350 } // 正中间

check('顶部：靠上就算', () => {
  eq(inTopZone(50, false), true)
  eq(inTopZone(CONTROLS_SHOW_AT, false), true)
})

check('顶部：离得远就不算', () => {
  eq(inTopZone(CONTROLS_SHOW_AT + 1, false), false)
  eq(inTopZone(400, false), false)
})

check('★ 顶部有迟滞（不然鼠标停在边界上会一闪一闪）', () => {
  const between = CONTROLS_SHOW_AT + 10 // 90 和 130 之间
  eq(inTopZone(between, false), false, '本来没显示 → 要求更严，不唤醒')
  eq(inTopZone(between, true), true, '本来已经显示 → 更宽松，别急着藏')
  // 超出宽松阈值，无论如何都藏
  eq(inTopZone(CONTROLS_HIDE_AT + 1, true), false)
})

check('左下角：贴着左下角算', () => {
  eq(inCornerZone(BL.x, BL.y, RECT, false), true)
})

check('★ 左上角不算（只判"靠左"的话这里也会唤醒，很怪）', () => {
  eq(inCornerZone(TL.x, TL.y, RECT, false), false)
})

check('★ 右下角不算（只判"靠下"的话这里也会唤醒）', () => {
  eq(inCornerZone(BR.x, BR.y, RECT, false), false)
})

check('正中间不算', () => {
  eq(inCornerZone(MID.x, MID.y, RECT, false), false)
})

check('★ 左下角也有迟滞', () => {
  const x = RECT.left + CORNER_SHOW_AT + 10
  const y = RECT.bottom - CORNER_SHOW_AT - 10
  eq(inCornerZone(x, y, RECT, false), false, '本来没显示 → 不唤醒')
  eq(inCornerZone(x, y, RECT, true), true, '已经显示 → 别急着藏')
})

check('矩形有偏移时按偏移算（不是拿屏幕坐标硬比）', () => {
  // 同一个屏幕坐标，在左边距不同的两个矩形里结论应该相反
  const wide = { left: 0, top: 0, right: 1000, bottom: 600 }
  const narrow = { left: 400, top: 0, right: 1000, bottom: 600 }
  eq(inCornerZone(100, 560, wide, false), true, `到左边 100px，在 ${CORNER_SHOW_AT} 以内，算`)
  eq(
    inCornerZone(100, 560, narrow, false),
    false,
    '换一个左边距 400 的矩形，这个点跑到舞台外面去了，不算'
  )
})

check('★ 舞台外面的坐标不算（负数不该当成"靠左"）', () => {
  // 实际 mousemove 只挂在舞台上，不会跑到外面；
  // 但契约写清楚比"反正不会发生"稳
  eq(inCornerZone(-300, 560, RECT, false), false, '左边很远')
  eq(inCornerZone(130, 900, RECT, false), false, '下边很远')
})

check('舞台高度为 0（还没渲染出来）也不会崩', () => {
  const flat = { left: 0, top: 0, right: 0, bottom: 0 }
  eq(typeof inCornerZone(0, 0, flat, false), 'boolean')
})

console.log(`\n${'─'.repeat(48)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
