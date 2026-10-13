/**
 * 「正在听歌」的端到端验证 —— 跑**真实主进程**，用 CDP 从外面看它。
 *
 * 跑法（在 voice-client 目录）：
 *     node scripts/verify-nowplaying.mjs
 *
 * ── 为什么绕这么一圈 ────────────────────────────────────────
 * 前两次想"启动真应用再问它"都失败了：`electron .` 之后第二个参数会被忽略，
 * 我的探针脚本根本没被加载，进程就挂在那儿。
 *
 * 正确做法是 **CDP**：让应用开一个远程调试端口，从外面连上去读 DOM、截图。
 * 好处是不用往产品代码里塞任何测试钩子 ——
 * 而且这套办法对**打包后的 exe** 一样管用。
 *
 * ⚠️ 它验证的是**整条链路**：
 *     真实主进程起 PowerShell 读 SMTC
 *       → IPC 推给渲染进程
 *       → 渲染进程通过 WS 上报
 *       → 服务端广播 presence
 *       → 右侧成员列表显示出「正在听：歌名」
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = join(ROOT, '..', 'voice-server', 'backend')
const PORT = 3087
const CDP_PORT = 9223
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * ⚠️⚠️ **必须**给验证脚本一个独立的 user-data-dir。
 *
 * Chromium 把 `file://` 一律当成**同一个源** —— 也就是说，
 * 开发版和你装的那份**共用一份 localStorage**。
 * 这个脚本要往 localStorage 里写测试用的服务器地址，
 * 共用的话就会**把你装的那份的配置覆盖掉**（真出过这事，见 repair-config.mjs）。
 *
 * 加了 `--user-data-dir` 之后，写的东西只落在这个临时目录里，碰不到真实配置。
 */
const PROFILE = join(tmpdir(), `voice-verify-profile-${CDP_PORT}`)

const NODE = ['C:\\Program Files\\nodejs\\node.exe'].find((p) => existsSync(p)) ?? 'node'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const tmp = mkdtempSync(join(tmpdir(), 'voice-np-'))
let srv = null
let appProc = null

function cleanup() {
  try {
    srv?.kill()
  } catch {
    /* ignore */
  }
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

/** 极简 CDP 客户端：连上去、发一条命令、等它的结果 */
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
  const logFd = (await import('node:fs')).openSync(join(tmp, 'server.log'), 'a')
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
      /* 还没起来 */
    }
    await wait(250)
  }
  if (!up) throw new Error('本地后端起不来')
  console.log('  本地后端已就绪')

  // 真实主进程 + 远程调试端口
  //
  // ⚠️ `ELECTRON_RUN_AS_NODE` 必须**从环境里彻底删掉**，不能设成空字符串 ——
  //    Electron 只看这个变量**存不存在**，设成 '' 照样会退化成纯 Node，
  //    于是窗口根本不会创建、CDP 也连不上。
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  appProc = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`], {
    cwd: ROOT,
    env,
    stdio: 'ignore',
  })

  // 等 CDP 端口起来
  let targets = null
  for (let i = 0; i < 40; i++) {
    await wait(500)
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) {
        targets = page
        break
      }
    } catch {
      /* 还没起来 */
    }
  }
  if (!targets) throw new Error('连不上 CDP —— 应用没起来？')
  console.log('  已连上应用（CDP）')

  const ws = new WebSocket(targets.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连不上')))
  })

  let id = 1
  const evaluate = async (expr) => {
    const r = await cdp(ws, id++, 'Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    })
    return r.result?.value
  }

  // 把应用指到本地后端（它的配置在 localStorage 里）
  await evaluate(`
    localStorage.setItem('voice.config.v2', JSON.stringify({
      nickname:'小明', apiUrl:'http://127.0.0.1:${PORT}', livekitUrl:'ws://127.0.0.1:9',
      inviteCode:'test', userId:'u1', userKey:'k1', avatar:'' }));
    true`)
  await cdp(ws, id++, 'Page.enable')
  await cdp(ws, id++, 'Page.reload', { ignoreCache: false })

  // 等整条链路跑完：主进程起 PowerShell（~1s）→ 第一轮读取（~3s）
  // → IPC → WS → 服务端广播 → 列表渲染
  let text = null
  let hint = ''
  for (let i = 0; i < 30; i++) {
    await wait(1500)
    const r = await evaluate(`
      (() => {
        const el = document.querySelector('.member-activity')
        const row = document.querySelector('.member')
        return {
          activity: el ? el.textContent : null,
          memberText: row ? row.textContent : null,
          members: document.querySelectorAll('.member').length,
        }
      })()`)
    hint = r ? `成员 ${r.members} 个 · 第一行「${r.memberText ?? ''}」` : ''
    if (r?.activity) {
      text = r.activity
      break
    }
  }

  // 截图留证
  const shot = await cdp(ws, id++, 'Page.captureScreenshot', { format: 'png' })
  mkdirSync(join(ROOT, 'theme-preview'), { recursive: true })
  writeFileSync(join(ROOT, 'theme-preview', 'nowplaying.png'), Buffer.from(shot.data, 'base64'))

  console.log(`  ${hint}`)
  console.log('')
  if (text) {
    console.log(`  ✅ 成员列表里显示出来了：「${text}」`)
    console.log('     整条链路通了：真主进程读 SMTC → IPC → WS → 服务端 → 界面')
  } else {
    console.log('  ⚠️ 没显示出来 —— 要么当前真的没在放歌，要么链路有问题')
  }

  ws.close()
  cleanup()
  process.exit(text ? 0 : 1)
}

main().catch((err) => {
  console.log('  ❌ ' + err.message)
  cleanup()
  process.exit(1)
})
