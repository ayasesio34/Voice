/**
 * 验证聊天区的「头像 + 连续消息合并」。
 *
 * 跑法（在 voice-client 目录）：node scripts/verify-chat-blocks.mjs
 *
 * 验：
 *   · 每条**块**的第一条前有头像和名字
 *   · 块内后续消息**没有**重复的头像和名字
 *   · 分组数正确（A×3 / B×1 / A×1 → 3 块）
 *   · 头像真的是那个人的（不是所有人的都一样）
 *
 * ⚠️ 独立 --user-data-dir + 每次清掉（profile 会留下来）。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = join(ROOT, '..', 'voice-server', 'backend')
const PORT = 3075
const CDP_PORT = 9234
const PROFILE = join(tmpdir(), `voice-verify-profile-${CDP_PORT}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const NODE = ['C:\\Program Files\\nodejs\\node.exe'].find((p) => existsSync(p)) ?? 'node'
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const tmp = mkdtempSync(join(tmpdir(), 'voice-chat-'))
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

  // 种两个成员（带不同 emoji 头像）+ 一批消息
  //   A×3（挨着）→ 一块
  //   B×1        → 一块
  //   A×1        → 一块（别人插过话了）
  await new Promise((resolve) => {
    const p = spawn(NODE, ['--input-type=module', '-e', `
      import { openDb, registerMember, insertMessage } from 'file:///${join(BACKEND, 'src', 'db.js').replace(/\\/g, '/')}';
      const db = openDb(${JSON.stringify(join(tmp, 'voice.db'))});
      const av = (e, c) => JSON.stringify({ color: c, emoji: e });
      registerMember(db, { userId:'u-a', userKey:'ka', name:'小明', avatar: av('🐱','#5865f2'), ownerName:'Owner' });
      registerMember(db, { userId:'u-b', userKey:'kb', name:'小红', avatar: av('🐶','#23a55a'), ownerName:'Owner' });
      const now = Date.now();
      let t = now - 3 * 60 * 1000;
      const add = (uid, name, body, gapMs) => { t += gapMs; insertMessage(db, { channelId:'general', authorId:uid, authorName:name, body, attachment:null, createdAt: t }); };
      add('u-a','小明','第一句：连着发的第一条', 0);
      add('u-a','小明','第二句：接着上面', 15000);
      add('u-a','小明','第三句：还是我', 15000);
      add('u-b','小红','小红插一句', 20000);
      add('u-a','小明','别人说过了，我重新起一块', 20000);
      db.close();`], { stdio: ['ignore', 'ignore', 'ignore'] })
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
      nickname:'看的人', apiUrl:'http://127.0.0.1:${PORT}', livekitUrl:'ws://127.0.0.1:9',
      inviteCode:'test', userId:'u-me', userKey:'kme', avatar:'' }));
    localStorage.setItem('voice.theme','light'); true`)
  await cdp(ws, id++, 'Page.enable')
  await cdp(ws, id++, 'Page.reload')
  await wait(5000)

  const info = await evaluate(`
    (() => {
      const blocks = [...document.querySelectorAll('.chat-block')]
      return blocks.map(b => ({
        author: b.querySelector('.chat-author')?.textContent ?? null,
        // 块里有几条消息
        messages: b.querySelectorAll('.chat-message').length,
        // 块里有几个头像（应该**只有一个**）
        avatars: b.querySelectorAll('.chat-avatar, .chat-block-avatar .avatar').length,
        // 块里有几个名字（应该**只有一个**）
        authors: b.querySelectorAll('.chat-author').length,
        bubbles: b.querySelector('.chat-block-content')?.className.includes('chat-block-bubble') ? 1 : 0,
        text: b.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60),
        // 头像里的 emoji（用来确认不是所有人都同一个头像）
        avatarText: b.querySelector('.chat-block-avatar .avatar')?.textContent ?? '',
      }))
    })()`)

  console.log('')
  for (const [i, b] of info.entries()) {
    console.log(`  块${i + 1}: ${b.messages} 条 · 头像${b.avatars}个 · 名字${b.authors}个 · 气泡${b.bubbles} · 头像内容「${b.avatarText}」`)
    console.log(`        「${b.text}」`)
  }
  console.log('')

  const threeBlocks = info.length === 3
  const sizes = info.map((b) => b.messages).join(',') === '3,1,1'
  const oneEach = info.every((b) => b.avatars === 1 && b.authors === 1)
  const authors = info.map((b) => b.author).join(',') === '小明,小红,小明'
  const distinctAvatars = new Set(info.map((b) => b.avatarText)).size >= 2
  const allBubble = info.every((b) => b.bubbles === 1)

  console.log(`  ${threeBlocks ? '✅' : '❌'} 分成了 3 块（A×3 / B×1 / A×1），实际 ${info.length} 块`)
  console.log(`  ${sizes ? '✅' : '❌'} 每块的消息数是 3/1/1，实际 ${info.map((b) => b.messages).join('/')}`)
  console.log(`  ${oneEach ? '✅' : '❌'} 每块**只有一个**头像和一个名字`)
  console.log(`  ${authors ? '✅' : '❌'} 作者顺序是 小明/小红/小明`)
  console.log(`  ${distinctAvatars ? '✅' : '❌'} 不同的人头像不一样（不是同一个 emoji）`)
  console.log(`  ${allBubble ? '✅' : '❌'} 纯文字块都套了气泡`)

  const shot = await cdp(ws, id++, 'Page.captureScreenshot', { format: 'png' })
  mkdirSync(join(ROOT, 'theme-preview'), { recursive: true })
  writeFileSync(join(ROOT, 'theme-preview', 'chat-blocks.png'), Buffer.from(shot.data, 'base64'))

  const ok = threeBlocks && sizes && oneEach && authors && distinctAvatars && allBubble
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
