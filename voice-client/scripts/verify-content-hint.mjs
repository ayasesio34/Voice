/**
 * 验证设置里那个「内容提示」下拉出现了**视频优先**这一档。
 *
 * 跑法（在 voice-client 目录）：node scripts/verify-content-hint.mjs
 *
 * 为什么值得单独验：这个选项是治"看视频卡顿"的 ✓
 * 但它藏在设置弹窗的折叠区里 ✗ 光看代码不能确定它真的渲染出来了 ✓
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = join(ROOT, '..', 'voice-server', 'backend')
const PORT = 3074
const CDP_PORT = 9235
const PROFILE = join(tmpdir(), `voice-verify-profile-${CDP_PORT}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const NODE = ['C:\\Program Files\\nodejs\\node.exe'].find((p) => existsSync(p)) ?? 'node'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const tmp = mkdtempSync(join(tmpdir(), 'voice-hint-'))
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

  // 点开「设置」
  const opened = await evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '设置')
      if (!btn) return false
      btn.click(); return true
    })()`)
  if (!opened) throw new Error('找不到「设置」按钮')
  await wait(1200)

  // ⚠️ 「内容提示」在**「屏幕共享」那个页签**里 ✗ 默认页签是「个人资料」✓
  //    不先切页签就找不到它 ✓（第一版就是这么失败的 ✓）
  const tabbed = await evaluate(`
    (() => {
      const tab = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '屏幕共享')
      if (!tab) return false
      tab.click(); return true
    })()`)
  if (!tabbed) throw new Error('设置里找不到「屏幕共享」页签')
  await wait(800)

  // 找到写着「内容提示」的那个 label 里的 select
  const info = await evaluate(`
    (() => {
      const labels = [...document.querySelectorAll('label')]
      const lab = labels.find(l => l.textContent.includes('内容提示'))
      if (!lab) {
        return { err: '设置里找不到「内容提示」这一项', seen: labels.map(l => l.textContent.trim().slice(0, 14)) }
      }
      const sel = lab.querySelector('select')
      if (!sel) return { err: '「内容提示」旁边没有下拉框' }
      return {
        options: [...sel.options].map(o => ({ value: o.value, text: o.textContent.trim() })),
        current: sel.value,
      }
    })()`)

  if (info.err) {
    console.log('  看到的其它项：' + JSON.stringify(info.seen))
    throw new Error(info.err)
  }

  console.log('')
  console.log(`  「内容提示」当前值 = ${JSON.stringify(info.current)}`)
  for (const o of info.options) {
    console.log(`    value=${JSON.stringify(o.value).padEnd(10)} ${o.text}`)
  }
  console.log('')

  const values = info.options.map((o) => o.value)
  const hasMotion = values.includes('motion')
  const motionLabel = info.options.find((o) => o.value === 'motion')?.text ?? ''
  const hasText = values.includes('text')
  const mentionsVideo = motionLabel.includes('视频')

  console.log(`  ${hasMotion ? '✅' : '❌'} 有 value="motion" 这一档（治"看视频卡顿"的就是它）`)
  console.log(`  ${mentionsVideo ? '✅' : '❌'} 它的文案里写了「视频」，用户能对上号：${JSON.stringify(motionLabel)}`)
  console.log(`  ${hasText ? '✅' : '❌'} 「文字优先」还在（文档场景仍然要它）`)

  const shot = await cdp(ws, id++, 'Page.captureScreenshot', { format: 'png' })
  mkdirSync(join(ROOT, 'theme-preview'), { recursive: true })
  writeFileSync(join(ROOT, 'theme-preview', 'content-hint.png'), Buffer.from(shot.data, 'base64'))

  const ok = hasMotion && mentionsVideo && hasText
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
