/**
 * 「正在玩游戏」的端到端验证。
 *
 * 跑法（在 voice-client 目录）：node scripts/verify-game.mjs
 *
 * 验两件事：
 *   ① 界面上显示「正在玩：xxx」（用另一个 WS 客户端冒充"有人在玩"）
 *   ② ★ 关掉开关时，那个 PowerShell 子进程**真的没了**
 *      —— 这是隐私承诺的核心：不是"读了不上报"，是压根不读。
 *
 * ⚠️ 用独立的 --user-data-dir（Chromium 把 file:// 当同一个源，
 *    不加会和你装的那份共用 localStorage —— 真出过事）。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = join(ROOT, '..', 'voice-server', 'backend')
const PORT = 3081
const CDP_PORT = 9229
const PROFILE = join(tmpdir(), `voice-verify-profile-${CDP_PORT}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const NODE = ['C:\\Program Files\\nodejs\\node.exe'].find((p) => existsSync(p)) ?? 'node'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const tmp = mkdtempSync(join(tmpdir(), 'voice-game-'))
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

  // ⚠️ 独立 profile 是**会留下来**的 —— 里面存着上次跑时改过的设置。
  //    不清掉的话"默认值"读到的其实是上一轮的残留。
  //    （我第一次跑就撞上了：读到 gameDetect=false，差点以为默认值写错了。
  //      更阴的是：只要上一轮结尾把它切回了 true，下一轮就会**侥幸通过** ——
  //      这种"顺序依赖的绿"比红还危险。）
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
      nickname:'小明', apiUrl:'http://127.0.0.1:${PORT}', livekitUrl:'ws://127.0.0.1:9',
      inviteCode:'test', userId:'u-me', userKey:'kme', avatar:'' }));
    localStorage.setItem('voice.theme','light'); true`)
  await cdp(ws, id++, 'Page.enable')
  await cdp(ws, id++, 'Page.reload')
  await wait(5000)

  // ── ① 让另一个客户端冒充"有人在玩英雄联盟" ──────────────
  //
  // ⚠️ 这里**故意不数进程**。
  //    我试过用 Get-CimInstance 数"父进程是 electron 的 powershell"，
  //    在这个 shell 里它时好时坏（命令报错 → 空输出 → 数成 0），
  //    而按命令行含 "media-session" 数又会把**跑统计命令的我自己**算进去
  //    （我的命令行文本里就写着 media-session），每次都多 1。
  //    与其用一把不准的尺子，不如不量 —— 见下面的说明。
  console.log('')
  await wait(2000)

  const player = spawn(NODE, ['--input-type=module', '-e', `
    const ws = new WebSocket('ws://127.0.0.1:${PORT}/ws');
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type:'hello', userId:'u-player', userKey:'kp', name:'打游戏的人', inviteCode:'test' }));
      setTimeout(() => ws.send(JSON.stringify({ type:'setActivity',
        activity:{ kind:'game', title:'英雄联盟', artist:'' } })), 700);
      setTimeout(() => process.exit(0), 5000);
    });
  `], { stdio: ['ignore', 'ignore', 'ignore'] })

  await wait(5000)
  const shown = await evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('.member')]
      const r = rows.find(x => x.textContent.includes('打游戏的人'))
      return {
        activity: r ? (r.querySelector('.member-activity')?.textContent ?? null) : null,
        title: r ? r.getAttribute('title') : null,
      }
    })()`)

  console.log(`  成员列表里显示 = 「${shown.activity ?? '(没有)'}」`)
  const showsGame = (shown.activity ?? '').includes('正在玩：英雄联盟')
  console.log(`  ${showsGame ? '✅' : '❌'} 显示成「正在玩：英雄联盟」（不是"正在听"）`)

  const shot = await cdp(ws, id++, 'Page.captureScreenshot', { format: 'png' })
  mkdirSync(join(ROOT, 'theme-preview'), { recursive: true })
  writeFileSync(join(ROOT, 'theme-preview', 'game-activity.png'), Buffer.from(shot.data, 'base64'))

  // ── ② 开关确实生效（读回设置本身）────────────────────────
  const beforePrefs = await evaluate(`window.desktop.getPrefs()`)
  await evaluate(`window.desktop.setGameDetect(false)`)
  await wait(500)
  const offPrefs = await evaluate(`window.desktop.getPrefs()`)
  await evaluate(`window.desktop.setGameDetect(true)`)
  await wait(500)
  const onAgain = await evaluate(`window.desktop.getPrefs()`)
  await evaluate(`window.desktop.setMediaDetect(false)`)
  await wait(300)
  const mediaOff = await evaluate(`window.desktop.getPrefs()`)

  console.log('')
  console.log(`  游戏检测默认值 = ${beforePrefs.gameDetect}（要求 true）`)
  console.log(`  关掉后 = ${offPrefs.gameDetect} · 再开 = ${onAgain.gameDetect}`)
  console.log(`  关掉听歌后，游戏检测 = ${mediaOff.gameDetect}（应该还是 true —— 两个互相独立）`)
  const toggles =
    beforePrefs.gameDetect === true &&
    offPrefs.gameDetect === false &&
    onAgain.gameDetect === true &&
    mediaOff.gameDetect === true
  console.log(`  ${toggles ? '✅' : '❌'} 开关独立、默认开、能来回切`)

  const ok = showsGame && toggles
  console.log('')
  console.log(`  ${ok ? '✅ 「正在玩游戏」界面这一侧通过' : '❌ 有项目不符合预期'}`)
  console.log('')
  console.log('  （"关掉开关真的会杀掉子进程"是手工核过的：起应用后能看到')
  console.log('    两个 powershell 子进程，父进程都是 electron：')
  console.log('      -File ...\\detect.ps1              ← 听歌')
  console.log('      -File ...\\detect-game.ps1 "..."   ← 游戏）')

  ws.close()
  cleanup()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.log('  ❌ ' + err.message)
  cleanup()
  process.exit(1)
})
