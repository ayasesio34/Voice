/**
 * 验证「一个人上报，所有人受益」的**最后一环**：
 * 别人上报的游戏，到我这边的**探测器命令行**里了吗？
 *
 * 前面已经证明：服务端会广播、后来的人 welcome 里直接有（test-games.mjs）。
 * 但「客户端收到 → IPC → 主进程合并白名单 → 重启探测器」这条链路
 * 只有看**子进程的命令行**才能确认 —— 那是白名单唯一的落点。
 *
 * 跑法（在 voice-client 目录）：node scripts/verify-shared-games.mjs
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = join(ROOT, '..', 'voice-server', 'backend')
const PORT = 3077
const CDP_PORT = 9232
const PROFILE = join(tmpdir(), `voice-verify-profile-${CDP_PORT}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const NODE = ['C:\\Program Files\\nodejs\\node.exe'].find((p) => existsSync(p)) ?? 'node'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const FAKE = 'reported-by-friend'

const tmp = mkdtempSync(join(tmpdir(), 'voice-shared-'))
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

/** 探测器子进程的命令行（白名单就在里面） */
function detectorCmdline() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | " +
          "Where-Object { $_.CommandLine -like '*detect-game.ps1*' } | " +
          'Select-Object -First 1 -ExpandProperty CommandLine)',
      ],
      { encoding: 'utf8' }
    )
    return String(out).trim()
  } catch {
    return ''
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

  // 先让"别人"报一个 —— 在应用启动**之前**，这样能顺便验 welcome 那条路
  await new Promise((resolve) => {
    const p = spawn(NODE, ['--input-type=module', '-e', `
      const ws = new WebSocket('ws://127.0.0.1:${PORT}/ws');
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type:'hello', userId:'u-friend', userKey:'kf', name:'朋友', inviteCode:'test' }));
        setTimeout(() => ws.send(JSON.stringify({ type:'reportGame', exe:'${FAKE}.exe', name:'朋友报的游戏' })), 600);
        setTimeout(() => process.exit(0), 3000);
      });
    `], { stdio: ['ignore', 'ignore', 'ignore'] })
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

  await evaluate(`
    localStorage.setItem('voice.config.v2', JSON.stringify({
      nickname:'我', apiUrl:'http://127.0.0.1:${PORT}', livekitUrl:'ws://127.0.0.1:9',
      inviteCode:'test', userId:'u-me', userKey:'kme', avatar:'' }));
    true`)
  await cdp(ws, id++, 'Page.enable')
  await cdp(ws, id++, 'Page.reload')

  // 等它连上、拿到 welcome、合并白名单、重启探测器
  await wait(9000)
  const cmd = detectorCmdline()

  console.log('')
  console.log(`  探测器命令行长度 = ${cmd.length}`)
  console.log(`  里面有没有「${FAKE}」= ${cmd.includes(FAKE)}`)
  const ok = cmd.includes(FAKE)
  console.log('')
  console.log(`  ${ok ? '✅ ★ 朋友上报的游戏，我这边不用做任何事就进了检测白名单' : '❌ 没进白名单'}`)
  if (!ok) console.log(`     命令行片段：${cmd.slice(0, 160)}`)

  ws.close()
  cleanup()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.log('  ❌ ' + err.message)
  cleanup()
  process.exit(1)
})
