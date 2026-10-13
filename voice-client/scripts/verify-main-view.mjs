/**
 * 拍 README 用的「主界面」门面图（浅色 + 深色各一张）。
 *
 * 跑法（在 voice-client 目录）：node scripts/verify-main-view.mjs
 *
 * 产出：
 *   theme-preview/light-main.png
 *   theme-preview/dark-main.png
 *
 * ── 为什么要单独写这个 ✗ ────────────────────────────────────
 * 别的 verify-* 脚本都是"验某个局部"✓ 顺带拍一张那个局部 ✓
 * 但 README 的门面图要**整窗** ✓ 而且要**两个主题各一张** ✓
 * 之前那两张是更早的手工产物 ✗ 布局改了之后没人重拍 ✓
 * 于是 README 里挂的是**老版本界面**（语音面板还横在底部那会儿）✓
 *
 * ── 数据从哪来 ──────────────────────────────────────────────
 * 起一个**本地后端 + 临时数据库** ✓ 种几个假成员和几条假消息 ✓
 * ★ 昵称一律用小明/小红/小刚 ✗ 绝不能用真实昵称 ✓
 *   （图要进公开仓库 ✓ 真实昵称会跟着泄露 ✓）
 * ★ 界面里**不能出现设置面板的「通用」页** ✗ 那一页有服务器地址 ✓
 *
 * ⚠️ 独立 --user-data-dir + 每次清掉（profile 会留下来）
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = join(ROOT, '..', 'voice-server', 'backend')
const PORT = 3081
const CDP_PORT = 9240
const PROFILE = join(tmpdir(), `voice-verify-profile-${CDP_PORT}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const NODE = ['C:\\Program Files\\nodejs\\node.exe'].find((p) => existsSync(p)) ?? 'node'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const tmp = mkdtempSync(join(tmpdir(), 'voice-mainview-'))
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
    setTimeout(() => reject(new Error(`${method} 超时`)), 20000)
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

  // 假成员 + 假消息
  //   ⚠️ 名字必须一眼看出是假的 ✗ 消息也必须是无意义的寒暄 ✓
  await new Promise((resolve) => {
    const p = spawn(
      NODE,
      [
        '--input-type=module',
        '-e',
        `
      import { openDb, registerMember, insertMessage } from 'file:///${join(BACKEND, 'src', 'db.js').replace(/\\/g, '/')}';
      const db = openDb(${JSON.stringify(join(tmp, 'voice.db'))});
      const av = (e, c) => JSON.stringify({ color: c, emoji: e });
      const owner = 'Owner';
      registerMember(db, { userId:'u-a', userKey:'ka', name:'小明', avatar: av('🐱','#5865f2'), ownerName: owner });
      registerMember(db, { userId:'u-b', userKey:'kb', name:'小红', avatar: av('🐶','#23a55a'), ownerName: owner });
      registerMember(db, { userId:'u-c', userKey:'kc', name:'小刚', avatar: av('🦊','#e67e22'), ownerName: owner });
      registerMember(db, { userId:'u-d', userKey:'kd', name:'老王', avatar: av('🐼','#9b59b6'), ownerName: owner });
      const now = Date.now();
      let t = now - 6 * 60 * 1000;
      const add = (uid, name, body, gapMs) => {
        t += gapMs;
        insertMessage(db, { channelId:'general', authorId:uid, authorName:name, body, attachment:null, createdAt: t });
      };
      add('u-a','小明','今天的会开完了吗 😄', 0);
      add('u-b','小红','开完了，文档我发群里了', 60000);
      add('u-c','小刚','收到 👍', 90000);
      db.close();`,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    )
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

  mkdirSync(join(ROOT, 'theme-preview'), { recursive: true })

  const shots = [
    { theme: 'light', file: 'light-main.png' },
    { theme: 'dark', file: 'dark-main.png' },
  ]

  for (const s of shots) {
    // 「我」就是小明 —— 这样成员列表里会出现「小明（我）」和频道主的徽章 ✓
    await evaluate(`
      localStorage.setItem('voice.config.v2', JSON.stringify({
        nickname:'小明', apiUrl:'http://127.0.0.1:${PORT}', livekitUrl:'ws://127.0.0.1:9',
        inviteCode:'test', userId:'u-a', userKey:'ka',
        avatar: JSON.stringify({ color:'#5865f2', emoji:'🐱' }) }));
      localStorage.setItem('voice.theme','${s.theme}'); true`)
    await cdp(ws, id++, 'Page.enable')
    await cdp(ws, id++, 'Page.reload')
    await wait(5000)

    // 拍之前先确认关键元素都在 ✓ 不然拍到的是半截界面 ✗
    const ok = await evaluate(`
      (() => {
        const has = (sel) => !!document.querySelector(sel);
        return {
          chat: has('.chat-block'),
          members: has('.member-row') || has('.member'),
          voicePanel: has('.voice-panel'),
          theme: document.documentElement.dataset.theme || document.body.className || '',
        };
      })()`)
    console.log(`  ${s.theme}: 聊天=${ok.chat} 成员=${ok.members} 语音面板=${ok.voicePanel} 主题标记="${ok.theme}"`)

    // ★ 语音面板的位置 —— 必须是**左下角**（在 .left-col 里）✗ 不是横跨底部 ✓
    const pos = await evaluate(`
      (() => {
        const vp = document.querySelector('.voice-panel');
        if (!vp) return null;
        const r = vp.getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
                 winW: window.innerWidth, winH: window.innerHeight, inLeftCol: !!vp.closest('.left-col') };
      })()`)
    if (pos) {
      const isLeft = pos.inLeftCol && pos.left < pos.winW * 0.35
      const isBottom = pos.top + pos.h > pos.winH * 0.75
      console.log(
        `         语音面板 x=${pos.left} y=${pos.top} ${pos.w}×${pos.h}（窗口 ${pos.winW}×${pos.winH}）` +
          ` · 在左栏=${pos.inLeftCol} · ${isLeft && isBottom ? '✅ 左下角' : '❌ 位置不对'}`,
      )
    } else {
      console.log('         ❌ 找不到 .voice-panel')
    }

    const shot = await cdp(ws, id++, 'Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ROOT, 'theme-preview', s.file), Buffer.from(shot.data, 'base64'))
    console.log(`         → theme-preview/${s.file}`)
  }

  console.log('')
  console.log('  ✅ 两张门面图已重新拍摄')

  ws.close()
  cleanup()
  process.exit(0)
}

main().catch((err) => {
  console.log('  ❌ ' + err.message)
  cleanup()
  process.exit(1)
})
