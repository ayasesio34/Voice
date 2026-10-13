/**
 * 验证：「移除成员」在界面上真的能用。
 *
 * 跑法（在 voice-client 目录）：node scripts/verify-remove-member.mjs
 *
 * ⚠️ 用独立的 --user-data-dir 起应用 —— Chromium 把 file:// 当成同一个源，
 *    不加这个参数的话开发版和你装的那份会**共用 localStorage**。
 *    （真出过事：把你装的那份的配置覆盖成了本地测试地址，见 repair-config.mjs）
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = join(ROOT, '..', 'voice-server', 'backend')
const PORT = 3082
const CDP_PORT = 9228
const PROFILE = join(tmpdir(), `voice-verify-profile-${CDP_PORT}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const NODE = ['C:\\Program Files\\nodejs\\node.exe'].find((p) => existsSync(p)) ?? 'node'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const tmp = mkdtempSync(join(tmpdir(), 'voice-rmui-'))
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
  let up = false
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) {
        up = true
        break
      }
    } catch {
      /* wait */
    }
    await wait(250)
  }
  if (!up) throw new Error('本地后端起不来')

  // 先在服务端塞两个成员：一个多余的人，一个真正要保留的
  await new Promise((resolve) => {
    const p = spawn(NODE, ['--input-type=module', '-e', `
      import { openDb, registerMember } from 'file:///${join(BACKEND, 'src', 'db.js').replace(/\\/g, '/')}';
      const db = openDb(${JSON.stringify(join(tmp, 'voice.db'))});
      registerMember(db, { userId:'u-owner-real', userKey:'k0', name:'Owner', avatar:'', ownerName:'Owner' });
      registerMember(db, { userId:'u-ghost', userKey:'k1', name:'多出来的幽灵', avatar:'', ownerName:'Owner' });
      registerMember(db, { userId:'u-keep', userKey:'k2', name:'正常的人', avatar:'', ownerName:'Owner' });
      db.close();`], { stdio: ['ignore', 'ignore', 'ignore'] })
    p.on('exit', resolve)
  })

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
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

  // 以「频道主本人」的身份进 —— 用服务端已经认过的那套凭证
  await evaluate(`
    localStorage.setItem('voice.config.v2', JSON.stringify({
      nickname:'Owner', apiUrl:'http://127.0.0.1:${PORT}', livekitUrl:'ws://127.0.0.1:9',
      inviteCode:'test', userId:'u-owner-real', userKey:'k0', avatar:'' }));
    localStorage.setItem('voice.theme','light'); true`)
  await cdp(ws, id++, 'Page.enable')
  await cdp(ws, id++, 'Page.reload')
  await wait(4500)

  const before = await evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('.member')]
      return { count: rows.length, names: rows.map(r => r.textContent) }
    })()`)
  console.log('')
  console.log(`  名册（${before.count} 人）：`)
  for (const n of before.names) console.log(`    ${n.slice(0, 40)}`)
  console.log('')

  // ── 右键那个幽灵 ────────────────────────────────────────
  const menuInfo = await evaluate(`
    (() => {
      const row = [...document.querySelectorAll('.member')].find(r => r.textContent.includes('多出来的幽灵'))
      if (!row) return { err: '没找到那一行' }
      const rc = row.getBoundingClientRect()
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true,
        clientX: Math.round(rc.left + 40), clientY: Math.round(rc.top + 8) }))
      return { ok: true }
    })()`)
  await wait(400)

  const items = await evaluate(`
    [...document.querySelectorAll('.context-menu .context-menu-item')].map(b => b.textContent.trim())`)
  console.log(`  右键菜单项 = [${items.join(', ')}]`)
  const hasRemove = items.includes('移除成员')
  console.log(`  ${hasRemove ? '✅' : '❌'} 频道主能看到「移除成员」`)
  console.log('')

  // ── 点它（把 confirm 换成自动确认）──────────────────────
  const clicked = await evaluate(`
    (() => {
      window.confirm = () => true          // 测试里不弹真对话框
      const b = [...document.querySelectorAll('.context-menu .context-menu-item')]
        .find(x => x.textContent.trim() === '移除成员')
      if (!b) return 'no-button'
      b.click()
      return 'clicked'
    })()`)
  await wait(2000)

  const after = await evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('.member')]
      return { count: rows.length, names: rows.map(r => r.textContent),
               ghost: rows.some(r => r.textContent.includes('多出来的幽灵')) }
    })()`)

  console.log(`  点按钮 = ${clicked}`)
  console.log(`  移除后名册（${after.count} 人）：`)
  for (const n of after.names) console.log(`    ${n.slice(0, 40)}`)
  console.log('')
  const ownerOk = hasRemove && !after.ghost && after.names.some((n) => n.includes('正常的人'))
  console.log(`  ${!after.ghost ? '✅' : '❌'} 幽灵从列表里消失了`)
  console.log(`  ${after.names.some((n) => n.includes('正常的人')) ? '✅' : '❌'} 别人没被误删`)
  console.log('')
  console.log(`  ${ownerOk ? '✅ 频道主这边：移除生效' : '❌ 频道主这边不符合预期'}`)

  // ── 换成一个**普通成员**再看一眼菜单 ────────────────────
  // 界面藏起来只是不给入口（真正拦住的是服务端），但不给入口也要真的不给。
  await evaluate(`
    localStorage.setItem('voice.config.v2', JSON.stringify({
      nickname:'正常的人', apiUrl:'http://127.0.0.1:${PORT}', livekitUrl:'ws://127.0.0.1:9',
      inviteCode:'test', userId:'u-keep', userKey:'k2', avatar:'' }));
    true`)
  await cdp(ws, id++, 'Page.reload')
  await wait(4500)

  await evaluate(`
    (() => {
      const row = [...document.querySelectorAll('.member')].find(r => r.textContent.includes('Owner'))
      if (!row) return
      const rc = row.getBoundingClientRect()
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true,
        clientX: Math.round(rc.left + 40), clientY: Math.round(rc.top + 8) }))
    })()`)
  await wait(400)
  const memberItems = await evaluate(`
    [...document.querySelectorAll('.context-menu .context-menu-item')].map(b => b.textContent.trim())`)
  const memberSees = memberItems.includes('移除成员')
  console.log(`  普通成员看到的菜单项 = [${memberItems.join(', ')}]`)
  console.log(`  ${!memberSees ? '✅' : '❌'} 普通成员**看不到**「移除成员」`)

  // 截图留证（这一张是普通成员的视角）
  const shot = await cdp(ws, id++, 'Page.captureScreenshot', { format: 'png' })
  mkdirSync(join(ROOT, 'theme-preview'), { recursive: true })
  writeFileSync(join(ROOT, 'theme-preview', 'remove-member.png'), Buffer.from(shot.data, 'base64'))

  console.log('')
  const ok = ownerOk && !memberSees
  console.log(`  ${ok ? '✅ 界面上「移除成员」可用，而且只有频道主看得到' : '❌ 不符合预期'}`)

  ws.close()
  cleanup()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.log('  ❌ ' + err.message)
  cleanup()
  process.exit(1)
})
