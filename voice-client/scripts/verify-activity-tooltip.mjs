/**
 * 验证：歌名太长被截断时，**鼠标移上去能看到完整歌名**。
 *
 * 为什么要这么测：歌名是真实播放器给的，我控制不了它有多长 ——
 * 所以让一个独立的 WS 客户端冒充"另一个人在听一首超长名字的歌"。
 *
 * 跑法（在 voice-client 目录）：node scripts/verify-activity-tooltip.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = join(ROOT, '..', 'voice-server', 'backend')
const PORT = 3085
const CDP_PORT = 9225

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

const LONG_TITLE = '这是一首名字特别特别特别长的歌用来测试省略号和悬停提示到底能不能看全'
const ARTIST = '某个歌手'

const tmp = mkdtempSync(join(tmpdir(), 'voice-tip-'))
let srv = null
let appProc = null
let singer = null
const cleanup = () => {
  for (const p of [singer, srv, appProc]) { try { p?.kill() } catch { /* ignore */ } }
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
  await wait(3500)

  // 让一个独立 WS 客户端冒充"另一个人在听一首超长名字的歌"
  singer = spawn(NODE, ['--input-type=module', '-e', `
    const ws = new WebSocket('ws://127.0.0.1:${PORT}/ws');
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type:'hello', userId:'u-singer', userKey:'ks', name:'小唱', inviteCode:'test' }));
      setTimeout(() => ws.send(JSON.stringify({ type:'setActivity',
        activity:{ kind:'music', title:${JSON.stringify(LONG_TITLE)}, artist:${JSON.stringify(ARTIST)} } })), 600);
      setTimeout(() => process.exit(0), 4000);
    });
  `], { stdio: ['ignore', 'ignore', 'ignore'] })

  await wait(4000)

  const info = await evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('.member')]
      const r = rows.find(x => x.textContent.includes('小唱'))
      if (!r) return { err: '没找到小唱那一行' }
      const act = r.querySelector('.member-activity')
      const nameEl = r.querySelector('.member-name')
      const visible = act ? act.clientWidth : 0
      return {
        rowTitle: r.getAttribute('title'),
        actTitle: act ? act.getAttribute('title') : null,
        actText: act ? act.textContent : null,
        // 名字那一层**不该**有 title，否则会盖住整行的
        nameHasTitle: nameEl ? nameEl.hasAttribute('title') : null,
        truncated: act ? act.scrollWidth > act.clientWidth + 1 : null,
        visibleWidth: visible,
      }
    })()`)

  const shot = await cdp(ws, id++, 'Page.captureScreenshot', { format: 'png' })
  mkdirSync(join(ROOT, 'theme-preview'), { recursive: true })
  writeFileSync(join(ROOT, 'theme-preview', 'tooltip.png'), Buffer.from(shot.data, 'base64'))

  console.log('')
  if (info.err) throw new Error(info.err)
  console.log(`  行内显示  = 「${info.actText}」`)
  console.log(`  是否被截断 = ${info.truncated}（可视宽 ${info.visibleWidth}px）`)
  console.log(`  名字层有 title = ${info.nameHasTitle}（必须是 false，否则会盖住整行提示）`)
  console.log('')
  // 用 JSON.stringify 打出来 —— 换行会被显示成 \n，一眼看得出是不是真的分了行
  console.log(`  整行 title  = ${JSON.stringify(info.rowTitle)}`)
  console.log(`  歌名行 title = ${JSON.stringify(info.actTitle)}`)
  console.log('')

  const row = info.rowTitle ?? ''
  const act = info.actTitle ?? ''
  const rowHasSong = row.includes(LONG_TITLE)
  const actHasSong = act.includes(LONG_TITLE)
  const rowHasArtist = row.includes(ARTIST)
  const actHasArtist = act.includes(ARTIST)

  // ★ 名字和歌名必须在**不同行**上
  const rowLines = row.split('\n')
  const nameLine = rowLines.findIndex((l) => l.includes('小唱'))
  const songLine = rowLines.findIndex((l) => l.includes(LONG_TITLE))
  const splitLines = nameLine >= 0 && songLine >= 0 && nameLine !== songLine

  // 歌名那一条：歌名和歌手也分行
  const actLines = act.split('\n')

  console.log(`  ${rowHasSong ? '✅' : '❌'} 整行提示里含完整歌名（鼠标停在名字/头像上也看得到）`)
  console.log(`  ${rowHasArtist ? '✅' : '❌'} 整行提示里含歌手`)
  console.log(`  ${actHasSong && actHasArtist ? '✅' : '❌'} 歌名那一行自己的提示也是完整的`)
  console.log(`  ${info.nameHasTitle === false ? '✅' : '❌'} 名字层不再单独挂 title（否则会盖住整行）`)
  console.log(`  ${splitLines ? '✅' : '❌'} ★ 名字和歌名在**不同行**（名字第 ${nameLine + 1} 行、歌名第 ${songLine + 1} 行）`)
  console.log(`  ${actLines.length >= 2 ? '✅' : '❌'} ★ 歌名和歌手也分了行（共 ${actLines.length} 行）`)
  console.log('')
  console.log('  实际显示效果：')
  for (const l of rowLines) console.log(`    │ ${l}`)

  ws.close()
  cleanup()
  process.exit(
    rowHasSong && rowHasArtist && actHasSong && actHasArtist &&
      info.nameHasTitle === false && splitLines && actLines.length >= 2
      ? 0
      : 1
  )
}

main().catch((err) => {
  console.log('  ❌ ' + err.message)
  cleanup()
  process.exit(1)
})
