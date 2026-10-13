/**
 * 验证成员行里「名字、（我）、角色徽章」是不是**同一条基线**，
 * 以及加了「正在听 / 正在玩」那一行之后，整块还塞不塞得进头像。
 *
 * 跑法（在 voice-client 目录）：node scripts/verify-name-baseline.mjs
 *
 * ── 为什么要这么测 ──────────────────────────────────────────
 * 原来 `.member-name` 用的是 `align-items: center` —— 那是让**盒子**居中 ✗
 * 名字是个 16px 行高的文本框、徽章是个 10px 字加内边距的小盒子，
 * 两个盒高不一样 → "盒子居中"之后**里面的字**不在一条线上 ✗
 * 看着就是三个东西有点漂移 ✓
 *
 * 而"字的对齐"用肉眼在截图上量不准 ✓ 所以这里量**基线**：
 * 往元素里插一个零高度的 inline-block，它的 bottom 就是基线位置 ✓
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = join(ROOT, '..', 'voice-server', 'backend')
const PORT = 3076
const CDP_PORT = 9233
const PROFILE = join(tmpdir(), `voice-verify-profile-${CDP_PORT}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const NODE = ['C:\\Program Files\\nodejs\\node.exe'].find((p) => existsSync(p)) ?? 'node'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const tmp = mkdtempSync(join(tmpdir(), 'voice-baseline-'))
let srv = null
let appProc = null
const cleanup = () => {
  for (const p of [srv, appProc]) {
    try {
      p?.kill()
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

function cdp(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      const m = JSON.parse(e.data)
      if (m.id !== id) return
      ws.removeEventListener('message', onMsg)
      if (m.error) reject(new Error(m.error.message))
      else resolve(m.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => reject(new Error(`${method} 超时`)), 15000)
  })
}

/** 在页面里量一行：基线 + 高度。这段会被注入到渲染进程里执行 */
const measureOne = (match) => `
(() => {
  // 零高度的 inline-block：它的 bottom 边就是**基线**位置
  const baselineOf = (el) => {
    if (!el) return null
    const probe = document.createElement('span')
    probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
    el.appendChild(probe)
    const b = probe.getBoundingClientRect().bottom
    probe.remove()
    return b
  }

  const rows = [...document.querySelectorAll('.member')]
  const row = rows.find(r => r.textContent.includes(${JSON.stringify(match)}))
  if (!row) return { err: '名册里找不到「' + ${JSON.stringify(match)} + '」' }

  const nameEl = row.querySelector('.member-name-text')
  const badgeEl = row.querySelector('.role-badge')
  const textEl = row.querySelector('.member-text')
  const avatarEl = row.querySelector('.avatar')
  const activityEl = row.querySelector('.member-activity')

  const rect = (el) => { const r = el?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, h: r.height, cy: r.top + r.height / 2 } : null }

  /**
   * 文字**本身**的盒子（不是行盒）。
   *
   * ⚠️ 这里用 Range 而不是 getBoundingClientRect：
   *    后者给的是**行盒**（16px），而我们要比的是"**字**看起来在哪儿" ——
   *    Range 覆盖的是文本节点，拿到的是**字体内容盒**（ascent+descent），
   *    它的中心才接近眼睛判断的"字心" ✓
   *
   * ⚠️ 上一版我量的是**基线**，结果虽然 0.00px 完全对齐，
   *    你看着还是"徽章靠下" ✗ —— 因为 13px 和 10px 的字基线一样时，
   *    小字的**视觉中心反而更低** ✓ 基线不是这个场景该用的尺子。
   */
  const textBox = (el) => {
    if (!el) return null
    const r = document.createRange()
    r.selectNodeContents(el)
    const b = r.getBoundingClientRect()
    return { top: b.top, bottom: b.bottom, h: b.height, cy: b.top + b.height / 2 }
  }

  return {
    hasBadge: !!badgeEl,
    hasActivity: !!activityEl,
    activityText: activityEl ? activityEl.textContent : null,
    // 字心（Range）
    nameText: textBox(nameEl),
    badgeText: textBox(badgeEl),
    // 药丸盒子（getBoundingClientRect）
    badgeBox: rect(badgeEl),
    textBox: rect(textEl),
    avatarBox: rect(avatarEl),
    nameFontSize: nameEl ? getComputedStyle(nameEl).fontSize : null,
    badgeFontSize: badgeEl ? getComputedStyle(badgeEl).fontSize : null,
    badgeHeight: badgeEl ? getComputedStyle(badgeEl).height : null,
    align: row.querySelector('.member-name') ? getComputedStyle(row.querySelector('.member-name')).alignItems : null,
  }
})()
`

async function main() {
  const logFd = openSync(join(tmp, 'server.log'), 'a')
  srv = spawn(NODE, ['src/index.js'], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DB_PATH: join(tmp, 'voice.db'),
      UPLOADS_DIR: join(tmp, 'uploads'),
      UPDATES_DIR: join(tmp, 'updates'),
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'devsecret',
      INVITE_CODE: 'test',
      OWNER_NAME: 'Owner',
    },
    stdio: ['ignore', logFd, logFd],
  })
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break
    } catch {
      /* wait */
    }
    await wait(250)
  }

  // 预先种两个身份 —— **顺序很重要**：
  //
  //   ⚠️ 第一版我先种了「唱歌的人」✗ —— 那时**还没有频道主**，
  //      结果他按"先到先得"成了 owner ✓ 应用自己反倒变成普通成员、
  //      **没有徽章** ✗ 于是什么都量不到 ✓（跑出来 badgeFontSize = null）
  //
  //   现在：① 先种一个叫 Owner 的 → 他成为频道主（有徽章 ✓）
  //         ② 再种「唱歌的人」→ 已经有频道主了，只能是 member ✗
  //            手动提成 admin ✓ 这样他也有徽章 ✓
  await new Promise((resolve) => {
    const p = spawn(NODE, ['--input-type=module', '-e', `
      import { openDb, registerMember, setMemberRole } from 'file:///${join(BACKEND, 'src', 'db.js').replace(/\\/g, '/')}';
      const db = openDb(${JSON.stringify(join(tmp, 'voice.db'))});
      // ① 频道主（应用自己用这个身份登录）
      registerMember(db, { userId:'u-me', userKey:'kme', name:'Owner', avatar:'', ownerName:'Owner' });
      // ② 管理员（用来量"有徽章 + 有两行"的组合）
      registerMember(db, { userId:'u-singer', userKey:'ks', name:'唱歌的人', avatar:'', ownerName:'Owner' });
      setMemberRole(db, 'u-singer', 'admin');
      db.close();`], { stdio: ['ignore', 'ignore', 'ignore'] })
    p.on('exit', resolve)
  })

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  rmSync(PROFILE, { recursive: true, force: true })
  appProc = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`], {
    cwd: ROOT,
    env,
    stdio: 'ignore',
  })

  let page = null
  for (let i = 0; i < 40; i++) {
    await wait(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) break
    } catch {
      /* 还没起来 */
    }
  }
  if (!page) throw new Error('连不上 CDP')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', () => rej(new Error('CDP 连不上')))
  })
  let id = 1
  const evaluate = async (expr) => {
    const r = await cdp(ws, id++, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    return r.result?.value
  }

  // 用**预先种好的频道主身份**进 —— 自己那一行一定带「频道主」徽章 ✓
  await evaluate(`
    localStorage.setItem('voice.config.v2', JSON.stringify({
      nickname:'Owner', apiUrl:'http://127.0.0.1:${PORT}', livekitUrl:'ws://127.0.0.1:9',
      inviteCode:'test', userId:'u-me', userKey:'kme', avatar:'' }));
    localStorage.setItem('voice.theme','light'); true`)
  await cdp(ws, id++, 'Page.enable')
  await cdp(ws, id++, 'Page.reload')
  await wait(4500)

  // ── 先量自己那一行（有徽章、没有第二行）──────────────────
  console.log('')
  const before = await evaluate(measureOne('（我）'))
  if (before.err) throw new Error(before.err)

  console.log(`  【只有一行】align-items = ${before.align}`)
  console.log(`    名字字心 = ${before.nameText?.cy.toFixed(2)}  字号 ${before.nameFontSize}`)
  console.log(`    徽章字心 = ${before.badgeText?.cy.toFixed(2)}  字号 ${before.badgeFontSize}`)
  console.log(`    药丸盒心 = ${before.badgeBox?.cy.toFixed(2)}  盒高 ${before.badgeHeight}`)
  const delta = Math.abs((before.nameText?.cy ?? 0) - (before.badgeText?.cy ?? 0))
  console.log(`    字心差 = ${delta.toFixed(2)}px`)
  const aligned = before.hasBadge && delta <= 0.75
  console.log(`  ${aligned ? '✅' : '❌'} 名字和徽章的**字心**在同一高度（眼睛看的就是这个）`)
  console.log(`  ${before.align === 'center' ? '✅' : '❌'} 用的是 center 对齐（药丸徽章要的是盒心重合）`)

  // ── 再量那个**既有徽章、又有第二行**的人 ────────────────
  //
  // ⚠️ 一开始我量的是自己那一行 ✗ —— 而「正在听」属于别人 ✗
  //    于是"两行还是不是对齐"这条断言等于没测 ✓ 这是修正后的版本。
  spawn(NODE, ['--input-type=module', '-e', `
    const ws = new WebSocket('ws://127.0.0.1:${PORT}/ws');
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type:'hello', userId:'u-singer', userKey:'ks', name:'唱歌的人', inviteCode:'test' }));
      setTimeout(() => ws.send(JSON.stringify({ type:'setActivity',
        activity:{ kind:'music', title:'一首歌', artist:'某歌手' } })), 700);
      setTimeout(() => process.exit(0), 6000);
    });
  `], { stdio: ['ignore', 'ignore', 'ignore'] })
  await wait(5000)

  const after = await evaluate(measureOne('唱歌的人'))
  console.log('')
  console.log(`  【两行 + 徽章】${after.err ? after.err : ''}`)
  if (!after.err) {
    console.log(`    第二行 = 「${after.activityText}」`)
    console.log(`    名字字心 = ${after.nameText?.cy.toFixed(2)} · 徽章字心 = ${after.badgeText?.cy.toFixed(2)}`)
    console.log(`    两行合计 = ${after.textBox?.h.toFixed(1)}px · 头像 = ${after.avatarBox?.h.toFixed(1)}px`)
  }
  const d2 = Math.abs((after.nameText?.cy ?? 0) - (after.badgeText?.cy ?? 0))
  const stillAligned = !after.err && after.hasActivity && after.hasBadge && d2 <= 0.75
  const stillFits = !after.err && (after.textBox?.h ?? 99) <= (after.avatarBox?.h ?? 0) + 0.5
  console.log(`  ${stillAligned ? '✅' : '❌'} 加了第二行之后字心**依然**对齐（差 ${d2.toFixed(2)}px）`)
  console.log(`  ${stillFits ? '✅' : '❌'} 两行仍然塞得进头像（没有因为改对齐把行高撑开）`)

  const shot = await cdp(ws, id++, 'Page.captureScreenshot', { format: 'png' })
  mkdirSync(join(ROOT, 'theme-preview'), { recursive: true })
  writeFileSync(join(ROOT, 'theme-preview', 'name-baseline.png'), Buffer.from(shot.data, 'base64'))

  const ok = aligned && before.align === 'center' && stillAligned && stillFits
  console.log('')
  console.log(`  ${ok ? '✅ 通过' : '❌ 有项目不符合预期'}`)

  ws.close()
  cleanup()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.log('  ❌ ' + err.message)
  cleanup()
  process.exit(1)
})
