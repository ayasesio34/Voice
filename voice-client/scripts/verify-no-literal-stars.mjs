/**
 * 找出界面上**真的显示出来**的 `**`。
 *
 * 跑法（在 voice-client 目录）：node scripts/verify-no-literal-stars.mjs
 *
 * ── 为什么需要这个 ──────────────────────────────────────────
 * 我在 JSX 里写注释式强调是习惯 ✓ 但**注释里**的 `**` 没事 ✓
 * 而**直接写在 JSX 文本里**的 `**` 会**原样显示给用户** ✗（JSX 不是 Markdown ✓）
 * grep 分不清这两种 ✓ —— 只有渲染出来才知道 ✓
 * 所以这里遍历每个页签、收集**可见文本**里含 `**` 的片段 ✓
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = join(ROOT, '..', 'voice-server', 'backend')
const PORT = 3073
const CDP_PORT = 9236
const PROFILE = join(tmpdir(), `voice-verify-profile-${CDP_PORT}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const NODE = ['C:\\Program Files\\nodejs\\node.exe'].find((p) => existsSync(p)) ?? 'node'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const tmp = mkdtempSync(join(tmpdir(), 'voice-stars-'))
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

/** 收集当前可见文本里含 ** 的片段 */
const SCAN = `
(() => {
  const out = []
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let n
  while ((n = walk.nextNode())) {
    const t = n.nodeValue
    if (!t || !t.includes('**')) continue
    const el = n.parentElement
    if (!el) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    if (!el.offsetParent && cs.position !== 'fixed') continue
    out.push({ text: t.trim().slice(0, 80), cls: el.className || el.tagName })
  }
  return out
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

  await evaluate(`
    localStorage.setItem('voice.config.v2', JSON.stringify({
      nickname:'看的人', apiUrl:'http://127.0.0.1:${PORT}', livekitUrl:'ws://127.0.0.1:9',
      inviteCode:'test', userId:'u-me', userKey:'kme', avatar:'' }));
    localStorage.setItem('voice.theme','light'); true`)
  await cdp(ws, id++, 'Page.enable')
  await cdp(ws, id++, 'Page.reload')
  await wait(5000)

  const found = []

  // ① 主界面（不打开设置）
  for (const hit of (await evaluate(SCAN)) ?? []) found.push({ where: '主界面', ...hit })

  // ② 打开设置，逐个页签扫
  await evaluate(`
    (() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '设置'); if (b) b.click(); return !!b })()`)
  await wait(1200)

  const tabs = (await evaluate(`
    (() => [...document.querySelectorAll('button')].map(b => b.textContent.trim())
      .filter(t => ['个人资料','外观','语音','屏幕共享','通用','高级','关于'].includes(t)))()`)) ?? []

  for (const tab of tabs) {
    await evaluate(`
      (() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(tab)}); if (b) b.click(); return !!b })()`)
    await wait(600)
    for (const hit of (await evaluate(SCAN)) ?? []) found.push({ where: `设置·${tab}`, ...hit })
  }

  console.log('')
  if (found.length === 0) {
    console.log('  ✅ 界面上没有任何地方显示字面的 **')
  } else {
    console.log(`  ❌ 有 ${found.length} 处会在界面上显示字面的 **：`)
    const seen = new Set()
    for (const f of found) {
      const key = f.where + f.text
      if (seen.has(key)) continue
      seen.add(key)
      console.log(`     [${f.where}] ${f.text}`)
    }
  }
  console.log('')

  const ok = found.length === 0
  ws.close()
  cleanup()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.log('  ❌ ' + err.message)
  cleanup()
  process.exit(1)
})
