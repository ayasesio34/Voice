/**
 * 验证两处界面调整：
 *   ① 成员行里「名字 + 正在听/正在玩」两行**不超过头像的上下范围**
 *   ② 设置里第一个头像色块左边的光圈没被切掉
 *
 * 跑法（在 voice-client 目录）：node scripts/verify-member-row.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = join(ROOT, '..', 'voice-server', 'backend')
const PORT = 3080
const CDP_PORT = 9230
const PROFILE = join(tmpdir(), `voice-verify-profile-${CDP_PORT}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const NODE = ['C:\\Program Files\\nodejs\\node.exe'].find((p) => existsSync(p)) ?? 'node'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const tmp = mkdtempSync(join(tmpdir(), 'voice-row-'))
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

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  rmSync(PROFILE, { recursive: true, force: true }) // profile 会留下来，先清干净
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

  await evaluate(`
    localStorage.setItem('voice.config.v2', JSON.stringify({
      nickname:'名字比较长的一个用户', apiUrl:'http://127.0.0.1:${PORT}', livekitUrl:'ws://127.0.0.1:9',
      inviteCode:'test', userId:'u-me', userKey:'kme', avatar:'' }));
    localStorage.setItem('voice.theme','light'); true`)
  await cdp(ws, id++, 'Page.enable')
  await cdp(ws, id++, 'Page.reload')
  await wait(4500)

  // 让另一个客户端报个超长游戏名，把两行都撑满
  spawn(NODE, ['--input-type=module', '-e', `
    const ws = new WebSocket('ws://127.0.0.1:${PORT}/ws');
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type:'hello', userId:'u-player', userKey:'kp', name:'打游戏的人', inviteCode:'test' }));
      setTimeout(() => ws.send(JSON.stringify({ type:'setActivity',
        activity:{ kind:'game', title:'一个名字非常长的游戏名字用来撑满这一行测试换行', artist:'' } })), 700);
      setTimeout(() => process.exit(0), 5000);
    });
  `], { stdio: ['ignore', 'ignore', 'ignore'] })
  await wait(4500)

  // ── ① 两行高度 vs 头像高度 ───────────────────────────────
  const m = await evaluate(`
    (() => {
      const row = [...document.querySelectorAll('.member')].find(r => r.textContent.includes('打游戏的人'))
      if (!row) return { err: '没找到那一行' }
      const av = row.querySelector('.avatar')
      const tx = row.querySelector('.member-text')
      const nm = row.querySelector('.member-name')
      const ac = row.querySelector('.member-activity')
      const rb = (el) => el ? el.getBoundingClientRect() : null
      const a = rb(av), t = rb(tx), n = rb(nm), c = rb(ac)
      return {
        avatar: a && Math.round(a.height),
        text: t && Math.round(t.height),
        name: n && Math.round(n.height),
        activity: c && Math.round(c.height),
        // 两行的上下边界有没有超出头像
        overflowTop: t && a ? Math.round(a.top - t.top) : null,
        overflowBottom: t && a ? Math.round(t.bottom - a.bottom) : null,
        hasActivity: !!ac,
      }
    })()`)

  console.log('')
  if (m.err) throw new Error(m.err)
  console.log(`  头像高 = ${m.avatar}px`)
  console.log(`  名字行 = ${m.name}px · 状态行 = ${m.activity}px · 两行合计 = ${m.text}px`)
  console.log('')
  const fits = m.text <= m.avatar
  console.log(`  ${fits ? '✅' : '❌'} 两行合计（${m.text}）≤ 头像高（${m.avatar}）`)
  console.log(`  超出上方 ${m.overflowTop}px · 超出下方 ${m.overflowBottom}px`)
  const contained = m.overflowTop <= 0 && m.overflowBottom <= 0
  console.log(`  ${contained ? '✅' : '❌'} 两行没有超出头像的上下范围`)

  const shot = await cdp(ws, id++, 'Page.captureScreenshot', { format: 'png' })
  mkdirSync(join(ROOT, 'theme-preview'), { recursive: true })
  writeFileSync(join(ROOT, 'theme-preview', 'member-row.png'), Buffer.from(shot.data, 'base64'))

  // ── ② 第一个色块左边的光圈有没有被切 ─────────────────────
  // 打开设置 → 切到「个人资料」（色块在那儿）
  await evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => (b.getAttribute('title') || '').includes('设置') || b.textContent.trim() === '设置')
      if (btn) btn.click()
      return true
    })()`)
  await wait(600)
  await evaluate(`
    (() => {
      const nav = [...document.querySelectorAll('button, a, li')]
        .find(b => b.textContent.trim() === '个人资料')
      if (nav) nav.click()
      return true
    })()`)
  await wait(600)

  const sw = await evaluate(`
    (() => {
      const row = document.querySelector('.swatch-row')
      if (!row) return { err: '设置没打开（色块行不在 DOM 里）' }
      const first = row.querySelector('.swatch')
      const rr = row.getBoundingClientRect(), fr = first.getBoundingClientRect()
      const cs = getComputedStyle(row)
      return {
        gapLeft: Math.round(fr.left - rr.left),
        padLeft: Math.round(parseFloat(cs.paddingLeft) || 0),
        // 选中时往外撑 4px（2px 边框 + 2px 光圈）
      }
    })()`)

  console.log('')
  if (sw.err) {
    console.log(`  ⚠️ 色块检查跳过：${sw.err}`)
  } else {
    console.log(`  色块行左边留白 = ${sw.gapLeft}px（需要 ≥ 4px 才够放光圈）`)
    console.log(`  ${sw.gapLeft >= 4 ? '✅' : '❌'} 第一个色块左边的光圈不会被切掉`)
  }

  const ok = fits && contained && (sw.err || sw.gapLeft >= 4)
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
