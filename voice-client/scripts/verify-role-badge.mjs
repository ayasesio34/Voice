/**
 * 验证：角色徽章跟在名字后面，而且名字过长时**徽章不会被挤掉**。
 *
 * 用 CDP 观察真实主进程（和 verify-nowplaying.mjs 同一套办法）。
 * 跑法（在 voice-client 目录）：node scripts/verify-role-badge.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = join(ROOT, '..', 'voice-server', 'backend')
const PORT = 3086
const CDP_PORT = 9224

/**
 * ⚠️⚠️ **必须**给验证脚本一个独立的 user-data-dir。
 *
 * Chromium 把 `file://` 一律当成**同一个源** —— 开发版和你装的那份
 * **共用一份 localStorage**。这个脚本要往里面写测试用的服务器地址，
 * 共用的话就会**把你装的那份的配置覆盖掉**（真出过这事，见 repair-config.mjs）。
 */
const PROFILE = join(tmpdir(), `voice-verify-profile-${CDP_PORT}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const NODE = ['C:\\Program Files\\nodejs\\node.exe'].find((p) => existsSync(p)) ?? 'node'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const tmp = mkdtempSync(join(tmpdir(), 'voice-badge-'))
let srv = null
let appProc = null
const cleanup = () => {
  try { srv?.kill() } catch { /* ignore */ }
  try { appProc?.kill() } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
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
      PORT: String(PORT), HOST: '127.0.0.1',
      DB_PATH: join(tmp, 'voice.db'),
      UPLOADS_DIR: join(tmp, 'uploads'), UPDATES_DIR: join(tmp, 'updates'),
      LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'devsecret', INVITE_CODE: 'test',
    },
    stdio: ['ignore', logFd, logFd],
  })

  let up = false
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) { up = true; break } } catch { /* wait */ }
    await wait(250)
  }
  if (!up) throw new Error('本地后端起不来')

  // 塞两个带角色的人：一个普通管理员、一个**名字特别长的**管理员
  const dbUrl = 'file:///' + join(BACKEND, 'src', 'db.js').replace(/\\/g, '/')
  const seed = spawn(NODE, ['--input-type=module', '-e', `
    import { openDb, registerMember, setMemberRole } from ${JSON.stringify(dbUrl)};
    const db = openDb(${JSON.stringify(join(tmp, 'voice.db'))});
    registerMember(db, { userId:'u-admin', userKey:'k1', name:'小红', avatar:'', ownerName:'' });
    setMemberRole(db, 'u-admin', 'admin');
    registerMember(db, { userId:'u-long', userKey:'k2', name:'一个名字特别特别长的管理员用来测试省略号', avatar:'', ownerName:'' });
    setMemberRole(db, 'u-long', 'admin');
    db.close();`], { stdio: ['ignore', logFd, logFd] })
  await new Promise((r) => seed.on('exit', r))

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  appProc = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`], { cwd: ROOT, env, stdio: 'ignore' })

  let page = null
  for (let i = 0; i < 40; i++) {
    await wait(500)
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) break
    } catch { /* 还没起来 */ }
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
      nickname:'小明', apiUrl:'http://127.0.0.1:${PORT}', livekitUrl:'ws://127.0.0.1:9',
      inviteCode:'test', userId:'u-me', userKey:'kme', avatar:'' }));
    localStorage.setItem('voice.theme','light'); true`)
  await cdp(ws, id++, 'Page.enable')
  await cdp(ws, id++, 'Page.reload')

  await wait(4000)

  const info = await evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('.member')]
      return rows.map(r => {
        const nameEl = r.querySelector('.member-name')
        const badge = r.querySelector('.role-badge')
        const txt = r.querySelector('.member-name-text')
        return {
          // .member-name 的直接子元素顺序 —— 徽章必须是**最后一个**（紧跟名字）
          children: nameEl ? [...nameEl.children].map(c => c.className.split(' ')[0]) : [],
          badgeInsideName: Boolean(badge && nameEl && nameEl.contains(badge)),
          badgeText: badge ? badge.textContent : null,
          nameTruncated: txt ? txt.scrollWidth > txt.clientWidth + 1 : null,
          // 徽章有没有被挤出可视区
          badgeVisible: badge ? badge.getBoundingClientRect().right <= r.getBoundingClientRect().right + 1 : null,
          text: r.textContent,
        }
      })
    })()`)

  const shot = await cdp(ws, id++, 'Page.captureScreenshot', { format: 'png' })
  mkdirSync(join(ROOT, 'theme-preview'), { recursive: true })
  writeFileSync(join(ROOT, 'theme-preview', 'rolebadge.png'), Buffer.from(shot.data, 'base64'))

  console.log('')
  for (const r of info) {
    console.log(`  「${r.text}」`)
    console.log(`     名字行子元素 = [${r.children.join(', ')}] · 徽章在名字行内 = ${r.badgeInsideName} · 名字被截断 = ${r.nameTruncated} · 徽章可见 = ${r.badgeVisible}`)
  }
  console.log('')

  const allInside = info.every((r) => r.badgeInsideName || !r.badgeText)
  const allVisible = info.every((r) => r.badgeVisible !== false)
  console.log(`  ${allInside ? '✅' : '❌'} 徽章都在名字行内（紧跟名字，不是推到行尾）`)
  console.log(`  ${allVisible ? '✅' : '❌'} 名字再长，徽章也没被挤掉`)

  ws.close()
  cleanup()
  process.exit(allInside && allVisible ? 0 : 1)
}

main().catch((err) => {
  console.log('  ❌ ' + err.message)
  cleanup()
  process.exit(1)
})
