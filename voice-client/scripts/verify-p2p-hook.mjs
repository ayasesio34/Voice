/**
 * 浏览器级验证 **投屏 P2P 的编排层**（`useScreenShareP2P`）。
 *
 * 跑法（在 voice-client 目录）：node scripts/verify-p2p-hook.mjs
 *
 * ── 为什么需要它 ✗ ──────────────────────────────────────────
 *   之前的状态是：
 *     p2pTransport         ✓ 有浏览器级测试（真建连接、真数帧）
 *     verdict/mergeStates  ✓ 有单元测试
 *     **中间那层编排**      ✗ **只有 typecheck 兜着**
 *
 *   而那一层是**胶水** ✓ 恰恰是"看着对、跑起来不对"的高发区 ✗
 *   （依赖数组写错 → 无限重连 ✓ 清理没做 → 停掉共享后连接还在 ✓
 *     状态表不删 → 徽章永远卡在"直连中" ✓ —— 最后这条真出过 ✓）
 *
 * ── 和 verify-p2p-transport 的区别 ✗ ────────────────────────
 *   那个直接把 `ScreenShareBroadcaster` / `ScreenShareReceiver` 拿来用 ✓
 *   这个走**完整一层**：真的用 React root 挂组件 ✓ 真的走 hook ✓
 *   信令走**真后端**的 `{type:'p2p'}` 通道 ✓ 不是模拟的 ✓
 *
 * ── 怎么把 TSX 跑起来 ✓ ─────────────────────────────────────
 *   esbuild 用 **stdin** 现场编一个驱动 ✓
 *     · resolveDir 指到 renderer/src ✓ 这样 `./lib/screenShareP2P` 能解析 ✓
 *     · 连 React 一起打进去 ✓ 页面里什么都不用引 ✓
 *
 * ── 验什么 ✓ ────────────────────────────────────────────────
 *   ① 分享端一有画面，观看端就能收到 —— 而且**真的在出帧** ✗
 *   ② 两边 status 都变 'p2p'（界面徽章就靠它 ✓）
 *   ③ ★ 分享端**停掉共享**之后：观看端的流被清空 ✓ status 回到 idle ✓
 *        —— 这条同时验证 `mergeStates` 那个修复 ✓
 *        （修之前 idle 被跳过 ✓ 状态表留着旧值 ✓ 徽章永久卡住 ✗）
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, openSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = join(ROOT, '..', 'voice-server', 'backend')
const SRC = join(ROOT, 'src', 'renderer', 'src')
const PORT = 3086
const HARNESS_PORT = 3087
const INVITE = 'testcode'

const NODE = ['C:\\Program Files\\nodejs\\node.exe'].find((p) => existsSync(p)) ?? 'node'
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = mkdtempSync(join(tmpdir(), 'voice-p2phook-'))

let srv = null
let harness = null
const browsers = []
let pass = 0
let fail = 0

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  ← ' + extra : ''}`) }
}

function cleanup() {
  for (const b of browsers) { try { b.kill() } catch {} }
  try { srv?.kill() } catch {}
  try { harness?.close() } catch {}
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
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
    setTimeout(() => reject(new Error(`${method} 超时`)), 30000)
  })
}

/**
 * 现场编一个 TSX 驱动 ✓
 *
 * ⚠️ 组件必须用 **JSX 渲染**（`<Probe />`）✗ 不能当函数调（`Probe()`）✓
 *    当函数调的话 hooks 会挂到**调用方**身上 ✓
 *    这次恰好只有一个组件所以看不出来 ✓ 但那是错的 ✓
 */
function buildDriver() {
  const driver = `
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { useScreenShareP2P } from './lib/screenShareP2P'

const cfg = window.__CFG
const R = { status: 'boot', keys: [], states: [], frames: 0, err: null, log: [], hasStream: false }
window.__R = R

const ws = new WebSocket(cfg.wsUrl)
let route = null
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.type === 'welcome') R.log.push('welcome')
  if (m.type === 'p2p' && route) route(m.from, m.payload)
})

function Probe() {
  const [myStream, setMyStream] = useState(null)
  const hookedRef = useRef(false)

  // 分享端造一路**会动的**画面 ✓ 不动的话收不到帧 ✗
  useEffect(() => {
    if (cfg.role !== 'share') return
    const cv = document.createElement('canvas')
    cv.width = 640; cv.height = 360
    const ctx = cv.getContext('2d')
    let n = 0
    const timer = setInterval(() => {
      n++
      ctx.fillStyle = 'hsl(' + ((n * 9) % 360) + ',75%,50%)'
      ctx.fillRect(0, 0, 640, 360)
      ctx.fillStyle = '#fff'
      ctx.font = '48px sans-serif'
      ctx.fillText('f' + n, 30, 200)
    }, 90)
    const s = cv.captureStream(15)
    setMyStream(s)
    // ⚠️ 停共享的开关 ✗ —— 停了轨道 + 把 state 置空 ✓
    //    只停轨道不置空的话，hook 依赖的 myStream 还是那个对象 ✓
    //    effect 不会重跑 ✓ 分享端不会拆 ✓ 测试就验不到清理那一段 ✗
    window.__stopShare = () => {
      clearInterval(timer)
      for (const t of s.getTracks()) { try { t.stop() } catch {} }
      setMyStream(null)
    }

    // ★★ 模拟真机上那个 bug ✗ —— 这是**唯一**能抓住它的测试 ✓
    //
    //   App 以前是这么算 myStream 的：
    //     useMemo(() => new MediaStream([track]), [screenShares])
    //   而 screenShares 是**每次 LiveKit 推送都变的新数组** ✗
    //   → 每几秒产生一个**新的 MediaStream 对象** ✓
    //     而里面的**轨道是同一条** ✓（这才是关键 ✓）
    //   → hook 的 effect 依赖整个流 → 每几秒重跑 ✓
    //   → 先把 broadcaster stop()（内部 pc.close）再新建 ✗
    //   → 刚建好的直连被反复拆掉 ✓ 徽章先闪「直连」再变「经服务器」✓
    //
    //   ⚠️ 这个开关**只换包装、不换轨道** ✗
    //      所以正确的实现**不应该**有任何反应 ✓
    //      有反应就说明它依赖错了东西 ✓✓
    //
    //   ⚠️⚠️ 这段注释里**不能出现反引号** ✗
    //      整个驱动页面是一个模板字符串 ✓ 里面的反引号会把它提前结束 ✓
    //      我为此栽了**第四次** ✗（前三次：迁移脚本、门面图探针、再是这里 ✓）
    window.__churn = () => {
      const track = s.getVideoTracks()[0]
      if (track) setMyStream(new MediaStream([track]))
      return true
    }
    return () => clearInterval(timer)
  }, [])

  const p2p = useScreenShareP2P({
    myUserId: cfg.selfId,
    inVoice: true,
    // ⚠️ 默认开 ✓ 场景可以显式给 false 来验"关掉直连"那条路 ✗
    //    写成「!== false」而不是直接读 cfg.p2pEnabled ✗ ——
    //    ⚠️⚠️ 这里**绝对不能出现反引号** ✗
    //      整个 driver 是一个**模板字符串** ✓ 反引号会把它提前截断 ✓
    //      （这个坑踩过 5 次了 ✓ 所以宁可写「」也不用反引号 ✓）
    //    后者在没写这个字段的场景里是 undefined ✓ 假值 ✓ 会被当成"关掉" ✓
    //    于是**所有**老场景都会悄无声息地退化成"直连已关" ✗
    enabled: cfg.p2pEnabled !== false,
    sendP2P: (to, payload) => { ws.send(JSON.stringify({ type: 'p2p', to, payload })); return true },
    myStream: cfg.role === 'share' ? myStream : null,
    watchTarget: cfg.role === 'view' ? cfg.peerId : null,
  })
  route = p2p.handleSignal

  // ⚠️ 每次渲染都刷一遍 ✗ 这样 CDP 读到的永远是最新的 ✓
  R.status = p2p.status
  R.keys = Object.keys(p2p.streams)
  // ⚠️ 连接状态表也要暴露 ✗ —— 用来验"关掉直连的人**根本没发起**连接" ✓
  //    光看 keys（收到的流）不够 ✗ 那只说明"没收到" ✓
  //    而"没发起"才是"完全不走直连"的证明 ✓
  R.states = Object.keys(p2p.states)
  const st = cfg.role === 'view' ? p2p.streams[cfg.peerId] : null
  R.hasStream = Boolean(st)

  useEffect(() => {
    if (!st) { hookedRef.current = false; R.frames = 0; return }
    if (hookedRef.current) return
    hookedRef.current = true
    const v = document.createElement('video')
    v.muted = true; v.autoplay = true; v.playsInline = true
    v.srcObject = st
    document.body.appendChild(v)
    v.play().catch(() => {})
    const count = () => { R.frames++; if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(count) }
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(count)
    return () => {
      v.srcObject = null
      v.remove()
    }
  }, [st])

  return null
}

const t0 = Date.now()
const boot = setInterval(() => {
  if (ws.readyState !== 1) {
    if (Date.now() - t0 > 10000) { clearInterval(boot); R.err = 'socket 打不开' }
    return
  }
  clearInterval(boot)
  ws.send(JSON.stringify({ type: 'hello', userId: cfg.selfId, userKey: 'k' + cfg.selfId, name: cfg.selfId }))
  // 等 welcome 落地再挂组件 ✓ 不然第一条信令会赶在握手之前 ✗
  setTimeout(() => {
    try {
      createRoot(document.getElementById('root')).render(<Probe />)
    } catch (e) {
      R.err = 'render 失败：' + (e && e.message)
    }
  }, 400)
}, 100)
`

  const built = buildSync({
    stdin: { contents: driver, resolveDir: SRC, loader: 'tsx' },
    bundle: true,
    format: 'iife',
    write: false,
    target: 'chrome120',
    // ⚠️ JSX 必须走 **automatic runtime** ✗
    //    esbuild 默认是 `React.createElement` ✓ 那要求驱动里 import React ✓
    //    不写这一行的话页面会报 "React is not defined" ✓（真踩了 ✓）
    //    项目自己也是 automatic（tsconfig 的 jsx 配置 ✓）所以这也和线上一致 ✓
    jsx: 'automatic',
    logLevel: 'silent',
  })
  return built.outputFiles[0].text
}

function makeHtml(bundle, cfg) {
  return `<!doctype html><meta charset="utf-8">
<title>p2p hook harness</title>
<body><div id="root"></div>
<script>window.__CFG = ${JSON.stringify(cfg)}</script>
<script>${bundle}</script>`
}

async function launch(cdpPort, profile, url) {
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    url,
  ], { stdio: 'ignore' })
  browsers.push(proc)

  let page = null
  for (let i = 0; i < 60; i++) {
    await wait(400)
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes(`${HARNESS_PORT}/`))
      if (page) break
    } catch { /* 还没起来 */ }
  }
  if (!page) throw new Error(`实例 ${cdpPort} 起不来`)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', () => rej(new Error('CDP 连不上')))
  })
  let id = 1
  const ev = async (expr) => {
    const r = await cdp(ws, id++, 'Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error('页面报错：' + (r.exceptionDetails.exception?.description ?? ''))
    return r.result?.value
  }
  return { ws, ev }
}

async function until(fn, ms, label) {
  const t0 = Date.now()
  for (;;) {
    let v = false
    try { v = await fn() } catch { v = false }
    if (v) return true
    if (Date.now() - t0 > ms) throw new Error(`超时（${ms}ms）：${label}`)
    await wait(250)
  }
}

async function main() {
  if (!CHROME) throw new Error('找不到 Chrome')
  console.log('')

  console.log('  打包驱动（含 React + 真实 hook）…')
  const bundle = buildDriver()
  console.log(`  [OK] ${(bundle.length / 1024).toFixed(0)} KB`)

  const logFd = openSync(join(tmp, 'server.log'), 'a')
  srv = spawn(NODE, ['src/index.js'], {
    cwd: BACKEND,
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

  const pages = {
    '/share': makeHtml(bundle, { role: 'share', selfId: 'u-share', peerId: 'u-view', wsUrl: `ws://127.0.0.1:${PORT}/ws` }),
    '/view': makeHtml(bundle, { role: 'view', selfId: 'u-view', peerId: 'u-share', wsUrl: `ws://127.0.0.1:${PORT}/ws` }),
    // ★ 第三个页面：**关掉了直连**的观看端 ✓
    //    它盯的是同一个人（u-share ✓）但设置里把 P2P 关了 ✓
    //    预期：状态 'off' ✓ 收不到流 ✓ 而且**从不发起连接** ✓
    '/off': makeHtml(bundle, { role: 'view', selfId: 'u-off', peerId: 'u-share', p2pEnabled: false, wsUrl: `ws://127.0.0.1:${PORT}/ws` }),
  }
  harness = createServer((req, res) => {
    const html = pages[req.url?.split('?')[0] ?? '']
    if (!html) { res.writeHead(404); res.end('nope'); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise((r) => harness.listen(HARNESS_PORT, '127.0.0.1', r))
  console.log(`  [OK] 测试页服务在 ${HARNESS_PORT}`)

  console.log('  启动三个 Chrome…')
  const S = await launch(9431, join(tmp, 'ps'), `http://127.0.0.1:${HARNESS_PORT}/share`)
  const V = await launch(9432, join(tmp, 'pv'), `http://127.0.0.1:${HARNESS_PORT}/view`)
  const O = await launch(9433, join(tmp, 'po'), `http://127.0.0.1:${HARNESS_PORT}/off`)

  await until(async () => (await S.ev(`window.__R && window.__R.log.includes('welcome')`)) === true, 25000, '分享端握手')
  await until(async () => (await V.ev(`window.__R && window.__R.log.includes('welcome')`)) === true, 25000, '观看端握手')
  await until(async () => (await O.ev(`window.__R && window.__R.log.includes('welcome')`)) === true, 25000, '关掉直连的观看端握手')
  const errS = await S.ev(`window.__R.err`)
  const errV = await V.ev(`window.__R.err`)
  check('两个页面都握手成功、没报错', !errS && !errV, String(errS || errV))
  console.log('')

  // ① 观看端收到 P2P 流 ✓
  await until(async () => (await V.ev(`window.__R.keys.length`)) > 0, 30000, '观看端收到 P2P 流')
  const keys = await V.ev(`window.__R.keys`)
  check('观看端拿到 P2P 流，key 是分享者的 userId', Array.isArray(keys) && keys.includes('u-share'), JSON.stringify(keys))

  // ② status 变 p2p ✓（徽章靠它 ✓）
  await until(async () => (await S.ev(`window.__R.status`)) === 'p2p', 30000, '分享端 status=p2p')
  await until(async () => (await V.ev(`window.__R.status`)) === 'p2p', 30000, '观看端 status=p2p')
  check('分享端 status = p2p（徽章显示「直连」✓）', (await S.ev(`window.__R.status`)) === 'p2p')
  check('观看端 status = p2p', (await V.ev(`window.__R.status`)) === 'p2p')

  // ③ ★ 真的出帧 ✗ —— 只有 status 是不够的 ✓
  await until(async () => (await V.ev(`window.__R.frames`)) > 3, 20000, '画面出帧')
  const frames = await V.ev(`window.__R.frames`)
  check('画面**真的在出帧**（不是只有连接 ✓）', frames > 3, `frames=${frames}`)

  // ══════════════════════════════════════════════════════════
  // ★★ ③.5 换掉 MediaStream 的**包装**，连接不许受影响 ✗
  //
  //   这是真机上那个 bug 的**唯一**回归测试 ✓
  //
  //   真机现象：徽章先显示「直连」然后**迅速**变成「经服务器」✓
  //   根因：App 每次 LiveKit 推送都 `new MediaStream([同一条轨道])` ✓
  //        → 流对象换新 ✓ → effect 重跑 → **把连接拆了重建** ✗
  //        → 而拆除时 `pc.close()` 被误判成"直连失败" ✓ → 徽章变「经服务器」✓
  //
  //   ⚠️ 已有的那几条断言**抓不到它** ✗
  //      它们只在"刚连上"那一刻断言 status = p2p ✓
  //      然后就再也没看过 ✓（这正是它一直绿着的原因 ✓✓）
  //      所以这里要**连上之后继续折腾它** ✓ 再看状态还在不在 ✓
  //
  //   ⚠️ `__churn` 只换包装、**不换轨道** ✗
  //      所以正确的实现**一点反应都不该有** ✓✓
  // ══════════════════════════════════════════════════════════
  console.log('')
  console.log('  反复替换 MediaStream 的包装（轨道不变 ✗）—— 模拟真机上那个 bug…')
  const framesBefore = await V.ev(`window.__R.frames`)
  for (let i = 0; i < 5; i++) {
    const r = await S.ev(`(window.__churn ? (window.__churn(), 'ok') : 'no-hook')`)
    if (r !== 'ok') {
      check('★ 换包装之后连接不许受影响', false, `驱动里没有 __churn（${r}）—— 这一条**没验到** ✗`)
      break
    }
    // ⚠️ 每次之间等够 ✗
    //    真机上 LiveKit 大约每几秒推一次 ✓ 这里也一样 ✓
    //    等太短的话测不出"被拆掉再重建"那个过程 ✓
    await wait(2200)
  }
  const stAfter = await S.ev(`window.__R.status`)
  const vstAfter = await V.ev(`window.__R.status`)
  const framesAfter = await V.ev(`window.__R.frames`)
  console.log(`  换包装 5 次之后：分享端 ${stAfter} / 观看端 ${vstAfter}`)
  console.log(`  帧数：${framesBefore} → ${framesAfter}`)
  check(
    '★ 换了 5 次包装之后分享端**仍然是 p2p** ✗（不能掉成 idle/relay ✓）',
    stAfter === 'p2p',
    `实际=${stAfter} —— 这就是"徽章先闪直连再变经服务器"那个 bug ✓`,
  )
  check('★ 观看端也仍然是 p2p', vstAfter === 'p2p', `实际=${vstAfter}`)
  check(
    '★ 画面**还在继续出帧**（连接没被拆掉重来 ✓）',
    framesAfter > framesBefore + 10,
    `frames ${framesBefore} → ${framesAfter}`,
  )

  // ══════════════════════════════════════════════════════════
  // ★★ ③.8 关掉直连的那个观看端 —— 必须**完全不走直连** ✗
  //
  //   这是设置里那个开关的**唯一**端到端验证 ✓
  //
  //   ⚠️ 三条断言缺一不可 ✗
  //     ① 状态是 'off'      → 徽章显示"经服务器（直连已关）"✓
  //                            而不是 idle 的"未建立直连"✗
  //                            （后者看起来像"还没连上、在等"✓ 会让人白等 ✓）
  //     ② 收不到流          → 画面只能走 LiveKit ✓ 也就是服务器中转 ✓
  //     ③ **从没发起过连接** → 这才是"完全不走直连"的证明 ✓
  //                            只看②的话，"发起了但没连上"也是收不到 ✓
  //                            那就不是用户要的行为了 ✗
  //       （断言③靠驱动里的 R.states ✓ 见上面的注释 ✓）
  //
  //   ⚠️ 断言③还有第二半 ✗：分享端的状态表里**也不该出现 u-off** ✓
  //      因为它是"收到 want 才建连接"✓ 而关掉的那边根本不发 want ✓
  // ══════════════════════════════════════════════════════════
  console.log('')
  console.log('  检查关掉直连的那个观看端…')
  await wait(3000) // 给它足够时间"犯错"✓（真关了的话这几秒什么都不会发生 ✓）
  const oStatus = await O.ev(`window.__R.status`)
  const oKeys = await O.ev(`window.__R.keys`)
  const oStates = await O.ev(`window.__R.states`)
  const oFrames = await O.ev(`window.__R.frames`)
  const sStates = await S.ev(`window.__R.states`)
  check('★ 关掉直连的观看端 status = off（不是 idle ✗ 不是 relay ✗）', oStatus === 'off', `实际=${oStatus}`)
  check('★ 它收不到任何 P2P 流（画面只能走服务器 ✓）', Array.isArray(oKeys) && oKeys.length === 0, JSON.stringify(oKeys))
  check('★ 它**从没发起过**连接（这才是"完全不走直连"✗）', Array.isArray(oStates) && oStates.length === 0, JSON.stringify(oStates))
  check('★ 它一张 P2P 画面都没出（frames=0 ✓）', oFrames === 0, `frames=${oFrames}`)
  check(
    '★ 分享端的状态表里也没有它 ✗（它没发 want ✓ 分享端就不该为它建连接 ✓）',
    Array.isArray(sStates) && !sStates.includes('u-off'),
    JSON.stringify(sStates),
  )

  // ④ ★ 停掉共享 → 观看端被清干净 ✓
  console.log('')
  console.log('  让分享端停掉共享…')
  const stopped = await S.ev(`(window.__stopShare ? (window.__stopShare(), 'ok') : 'no-hook')`)
  if (stopped !== 'ok') {
    check('★ 停掉共享后的清理', false, `驱动里没有 __stopShare（${stopped}）—— 这一条**没验到** ✗`)
  } else {
    await until(async () => (await V.ev(`window.__R.keys.length`)) === 0, 20000, '观看端流被清空')
    check('停掉共享后观看端的流被清空 ✓', (await V.ev(`window.__R.keys.length`)) === 0)

    await until(async () => (await V.ev(`window.__R.status`)) === 'idle', 20000, '观看端 status 回 idle')
    const st = await V.ev(`window.__R.status`)
    check('★ 停掉后 status 回到 idle（守的是 mergeStates 那个修复 ✓）', st === 'idle', `实际=${st}`)
  }

  console.log('')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  console.log('')

  S.ws.close(); V.ws.close(); O.ws.close()
  cleanup()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.log('  ❌ ' + e.message)
  cleanup()
  process.exit(1)
})
