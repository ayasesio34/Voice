/**
 * 验证「上报没被认出来的游戏」对话框。
 *
 * 跑法（在 voice-client 目录）：node scripts/verify-report-game.mjs
 *
 * 验：能打开、能列出当前窗口、点一个会把名字预填上、保存后真的进了设置。
 * ⚠️ 用独立的 --user-data-dir（并且每次清掉 —— profile 会留下来）。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 3079
const CDP_PORT = 9231
const PROFILE = join(tmpdir(), `voice-verify-profile-${CDP_PORT}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const tmp = mkdtempSync(join(tmpdir(), 'voice-rep-'))
let appProc = null
const cleanup = () => {
  try {
    appProc?.kill()
  } catch {
    /* ignore */
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
    setTimeout(() => reject(new Error(`${method} 超时`)), 20000)
  })
}

async function main() {
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

  // 指向一个不存在的后端没关系 —— 这个功能纯本地
  await evaluate(`
    localStorage.setItem('voice.config.v2', JSON.stringify({
      nickname:'小明', apiUrl:'http://127.0.0.1:${PORT}', livekitUrl:'ws://127.0.0.1:9',
      inviteCode:'test', userId:'u-me', userKey:'kme', avatar:'' }));
    localStorage.setItem('voice.theme','light'); true`)
  await cdp(ws, id++, 'Page.enable')
  await cdp(ws, id++, 'Page.reload')
  await wait(4000)

  const clickText = (text) => evaluate(`
    (() => {
      const el = [...document.querySelectorAll('button, a, li, div')]
        .find(b => b.textContent.trim() === ${JSON.stringify(text)})
      if (!el) return false
      el.click()
      return true
    })()`)

  console.log('')
  const openedSettings = await clickText('设置')
  await wait(800)

  // ⚠️ 「状态显示」不在某个固定分页下 —— 别猜，把每个分页都点一遍找它。
  //    （我第一版直接点「个人资料」，结果按钮根本没渲染出来。
  //      头像色块在个人资料里、状态显示在另一个分页里，两回事。）
  const navLabels = await evaluate(`
    [...document.querySelectorAll('.settings-nav button, .settings-nav a, .settings-nav li')]
      .map(b => b.textContent.trim()).filter(Boolean)`)
  let foundOn = null
  for (const label of navLabels) {
    await clickText(label)
    await wait(400)
    const has = await evaluate(
      `[...document.querySelectorAll('button')].some(b => b.textContent.includes('上报一个'))`
    )
    if (has) {
      foundOn = label
      break
    }
  }

  const opened = await evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => b.textContent.includes('上报一个'))
      if (!btn) return 'no-button'
      btn.click()
      return 'clicked'
    })()`)
  await wait(2500)

  const info = await evaluate(`
    (() => {
      const dlg = document.querySelector('.report-game')
      if (!dlg) return { err: '对话框没出现' }
      const rows = [...dlg.querySelectorAll('.report-window')]
      return {
        rows: rows.length,
        first: rows[0] ? rows[0].textContent : null,
      }
    })()`)

  console.log(`  打开设置 = ${openedSettings} · 按钮在「${foundOn ?? '(没找到)'}」这一页`)
  console.log(`  点「上报一个」= ${opened}`)
  if (info.err) throw new Error(info.err)
  console.log(`  对话框里的窗口数 = ${info.rows}`)
  console.log(`  第一个窗口 = 「${(info.first ?? '').slice(0, 50)}」`)
  const listed = info.rows > 0
  console.log(`  ${listed ? '✅' : '❌'} 列出了当前开着的窗口`)

  const picked = await evaluate(`
    (() => {
      const dlg = document.querySelector('.report-game')
      const row = dlg.querySelector('.report-window')
      if (!row) return 'no-row'
      row.click()
      return 'clicked'
    })()`)
  // ⚠️ 点完要等一下再读 —— React 的 state 更新是异步的，
  //    紧接着读 input.value 拿到的还是旧值（第一次跑就是这么假失败的）。
  await wait(500)
  const prefill = await evaluate(
    `document.querySelector('.report-game .report-name input')?.value ?? ''`
  )
  console.log('')
  console.log(`  点一个窗口后，名字框预填 = 「${String(prefill).slice(0, 40)}」`)
  const prefilled = typeof prefill === 'string' && prefill.length > 0
  console.log(`  ${prefilled ? '✅' : '❌'} 自动预填了窗口标题（省得从空白开始填）`)

  // 改个名字再保存
  await evaluate(`
    (() => {
      const inp = document.querySelector('.report-game .report-name input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, '我上报的游戏')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
  await wait(300)
  await evaluate(`
    (() => {
      const b = [...document.querySelectorAll('.report-game .modal-actions button')]
        .find(x => x.textContent.trim() === '保存')
      if (b) b.click()
      return true
    })()`)
  await wait(1500)

  const after = await evaluate(`window.desktop.getPrefs()`)
  const saved = after?.customGames ?? {}
  const keys = Object.keys(saved)
  console.log('')
  console.log(`  保存后 customGames = ${JSON.stringify(saved)}`)
  const okSaved = keys.length === 1 && saved[keys[0]] === '我上报的游戏'
  console.log(`  ${okSaved ? '✅' : '❌'} 真的存进设置了`)

  const shot = await cdp(ws, id++, 'Page.captureScreenshot', { format: 'png' })
  mkdirSync(join(ROOT, 'theme-preview'), { recursive: true })
  writeFileSync(join(ROOT, 'theme-preview', 'report-game.png'), Buffer.from(shot.data, 'base64'))

  const ok = listed && prefilled && okSaved
  console.log('')
  console.log(`  ${ok ? '✅ 上报功能可用' : '❌ 有项目不符合预期'}`)

  ws.close()
  cleanup()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.log('  ❌ ' + err.message)
  cleanup()
  process.exit(1)
})
