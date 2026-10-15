/**
 * 验证生产环境的 P2P 信令转发（`{type:'p2p', to, payload}`）。
 *
 * 跑法（在 voice-server/backend 目录）：node test-p2p-signal.mjs
 *
 * ── 它守什么 ✗ ──────────────────────────────────────────────
 *   投屏改成 P2P 之后，两端要靠服务器交换 SDP / ICE 候选 ✓
 *   这条通道只转发、不解析 ✓ 所以它必须：
 *     · 真的把消息送到**指定的那一个人** ✓ 不是广播 ✓
 *     · 带上正确的 from ✓ 否则对端不知道是谁要连它 ✓
 *     · 对方不在线时**静默丢弃** ✓ 不能抛错、不能卡住 ✓
 *     · 挡掉超大载荷 ✓ 它是信令通道，不是文件通道 ✓
 *     · 挡掉发给自己的消息 ✓ 否则会自己连自己 ✓
 *
 * ⚠️ 这些边界全是"线上才暴露"的那类 ✗
 *    本地跑一遍很便宜 ✓ 放出去出了问题很难查 ✓
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 3097
const INVITE = 'test'
const NODE = ['C:\\Program Files\\nodejs\\node.exe'].find((p) => existsSync(p)) ?? 'node'

const tmp = mkdtempSync(join(tmpdir(), 'voice-p2psig-'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let srv = null
const sockets = []

function cleanup() {
  for (const s of sockets) { try { s.close() } catch {} }
  try { srv?.kill() } catch {}
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}

let passed = 0
let failed = 0
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name}${extra ? '  ← ' + extra : ''}`) }
}

/** 连上一个成员，返回句柄 */
function connect(userId, userKey, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    sockets.push(ws)
    const inbox = []
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', userId, userKey, name }))
    })
    ws.addEventListener('message', (e) => {
      try { inbox.push(JSON.parse(e.data)) } catch {}
    })
    // 等到收到 welcome 才算加入成功
    const t0 = Date.now()
    const poll = setInterval(() => {
      if (inbox.some((m) => m.type === 'welcome')) { clearInterval(poll); resolve({ ws, inbox }) }
      else if (Date.now() - t0 > 8000) { clearInterval(poll); reject(new Error(name + ' 没等到 welcome')) }
    }, 100)
    ws.addEventListener('error', () => reject(new Error(name + ' 连接出错')))
  })
}

/** 等 inbox 里出现某个谓词的消息 */
async function waitFor(inbox, pred, ms = 3000) {
  const t0 = Date.now()
  for (;;) {
    const hit = inbox.find(pred)
    if (hit) return hit
    if (Date.now() - t0 > ms) return null
    await wait(50)
  }
}

async function main() {
  console.log('')
  const logFd = openSync(join(tmp, 'server.log'), 'a')
  srv = spawn(NODE, ['src/index.js'], {
    cwd: HERE,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      DB_PATH: join(tmp, 'voice.db'), UPLOADS_DIR: join(tmp, 'up'), UPDATES_DIR: join(tmp, 'upd'),
      LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'devsecret',
      INVITE_CODE: INVITE, OWNER_NAME: 'Owner',
    },
    stdio: ['ignore', logFd, logFd],
  })
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break } catch {}
    await wait(250)
  }

  const A = await connect('u-a', 'ka', '甲')
  const B = await connect('u-b', 'kb', '乙')
  const C = await connect('u-c', 'kc', '丙')   // 用来验证"不是广播"

  console.log('  三个成员已上线（甲 / 乙 / 丙）')
  console.log('')

  // ① 定向转发
  A.ws.send(JSON.stringify({ type: 'p2p', to: 'u-b', payload: { t: 'offer', sdp: 'FAKE_SDP' } }))
  const gotB = await waitFor(B.inbox, (m) => m.type === 'p2p')
  const gotC = await waitFor(C.inbox, (m) => m.type === 'p2p', 800)

  check('乙 收到了转发', !!gotB, JSON.stringify(gotB))
  check('载荷原样送达', gotB?.payload?.sdp === 'FAKE_SDP', JSON.stringify(gotB?.payload))
  check('from 是甲（不是 null/undefined）', gotB?.from === 'u-a', String(gotB?.from))
  check('丙 **没有**收到（说明是定向，不是广播 ✗）', !gotC)

  // ② 对方不在线 → 静默丢弃
  const before = A.inbox.length
  A.ws.send(JSON.stringify({ type: 'p2p', to: 'u-does-not-exist', payload: { t: 'offer' } }))
  await wait(600)
  check('发给不在线的人不报错也不崩', A.ws.readyState === 1)

  // ③ 超大载荷被挡掉
  const huge = 'x'.repeat(200 * 1024)
  A.ws.send(JSON.stringify({ type: 'p2p', to: 'u-b', payload: { blob: huge } }))
  const gotHuge = await waitFor(B.inbox, (m) => m.type === 'p2p' && m.payload?.blob, 900)
  check('200 KB 的载荷被挡掉（信令通道不该传大包 ✗）', !gotHuge)

  // ④ 发给自己被挡掉
  const selfBefore = A.inbox.filter((m) => m.type === 'p2p').length
  A.ws.send(JSON.stringify({ type: 'p2p', to: 'u-a', payload: { t: 'offer' } }))
  await wait(500)
  const selfAfter = A.inbox.filter((m) => m.type === 'p2p').length
  check('发给自己被挡掉（否则自己连自己 ✗）', selfAfter === selfBefore)

  // ⑤ 没 hello 就发 → 不能转发
  const raw = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  sockets.push(raw)
  await new Promise((res) => raw.addEventListener('open', res))
  raw.send(JSON.stringify({ type: 'p2p', to: 'u-b', payload: { t: 'offer', evil: 1 } }))
  const gotRaw = await waitFor(B.inbox, (m) => m.type === 'p2p' && m.payload?.evil === 1, 800)
  check('没 hello 的连接发不出信令', !gotRaw)

  // ⑥ 反向也要通
  B.ws.send(JSON.stringify({ type: 'p2p', to: 'u-a', payload: { t: 'answer', sdp: 'FAKE_ANS' } }))
  const gotA = await waitFor(A.inbox, (m) => m.type === 'p2p' && m.payload?.sdp === 'FAKE_ANS')
  check('反向（乙 → 甲）也通', !!gotA && gotA.from === 'u-b', JSON.stringify(gotA))

  console.log('')
  // ⚠️ 必须**顶格** ✗
  //    项目的其它测试都是 `通过 N / 失败 M` 顶格输出 ✓
  //    外面那套批量跑测试 / deploy 复核都是按 `^通过` 去解析的 ✓
  //    多两个空格就解析不到 ✓ 表现成"这个测试没有通过行" ✗（真踩过 ✓）
  console.log(`通过 ${passed} / 失败 ${failed}`)
  console.log('')

  cleanup()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.log('  ❌ ' + e.message)
  cleanup()
  process.exit(1)
})
