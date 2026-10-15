/**
 * 浏览器级验证 p2pTransport —— 投屏 P2P 直连的真端到端测试。
 *
 * 跑法（在 voice-client 目录）：node scripts/verify-p2p-transport.mjs
 *
 * ── 为什么必须用浏览器 ✗ ────────────────────────────────────
 *   这个模块的核心是 `RTCPeerConnection` ✓ Node 里没有 ✓
 *   所以 typecheck 过了**什么也不证明** ✓
 *   必须真开两个浏览器、真建连接、真收到画面 ✓
 *
 * ── 怎么做到"真收到画面" ✓ ──────────────────────────────────
 *   分享端不用真屏 ✓ 用 `canvas.captureStream()` 造一路**会动的**画面 ✓
 *   画布每 100ms 换一次颜色 ✓ 这样一定有帧在流 ✓
 *   观看端把这个流挂到 <video> 上 ✓ 再用 `requestVideoFrameCallback` **数帧** ✓
 *   帧数 > 0 才算真的通了 ✗ —— 光看 "connected" 是不够的 ✓
 *     （连接建起来但没画面，是这类代码最常见的失败方式 ✓）
 *
 * ── 走的是真信令 ✗ ──────────────────────────────────────────
 *   不是模拟的 ✓ 两个页面各自连后端的 /ws ✓
 *   走的就是生产那条 `{type:'p2p', to, payload}` 通道 ✓
 *
 * ── 验哪些边界 ✓ ────────────────────────────────────────────
 *   ① 观看端发 want → 分享端回 offer → answer → 连通
 *   ② 观看端真的收到**视频轨**，并且**真的在出帧**
 *   ③ 分享端 hasFailed() 为 false（没有需要回退的）
 *   ④ 没请求过的人发 offer → 被拒（回 bye）
 *   ⑤ unwatch 之后连接拆掉、对方也收到 bye
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
const PORT = 3098
const HARNESS_PORT = 3099
const INVITE = 'testcode'

const NODE = ['C:\\Program Files\\nodejs\\node.exe'].find((p) => existsSync(p)) ?? 'node'
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = mkdtempSync(join(tmpdir(), 'voice-p2ptx-'))

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

/** 造出测试用的页面：把打包好的模块 + 驱动脚本塞进去 ✓ */
function makeHtml(bundle, selfId, peerId, role) {
  const driver = `
    const SELF = ${JSON.stringify(selfId)};
    const PEER = ${JSON.stringify(peerId)};
    const ROLE = ${JSON.stringify(role)};
    const INVITE = ${JSON.stringify(INVITE)};
    const WSURL = ${JSON.stringify(`ws://127.0.0.1:${PORT}/ws`)};
    window.__R = { log: [], state: 'boot', err: null, frames: 0, tracks: [] };
    const L = (s) => { window.__R.log.push(s) };

    async function boot() {
      const ws = new WebSocket(WSURL);
      const waiters = [];
      await new Promise((res, rej) => {
        ws.addEventListener('open', res);
        ws.addEventListener('error', () => rej(new Error('ws 打不开')));
      });
      ws.send(JSON.stringify({ type:'hello', userId:SELF, userKey:'k'+SELF, name:SELF }));

      let onP2P = null;
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'welcome') L('welcome ✓');
        if (m.type === 'p2p' && onP2P) onP2P(m.from, m.payload);
      });
      const send = (to, payload) => { ws.send(JSON.stringify({ type:'p2p', to, payload })); return true; };

      // 等 welcome
      const t0 = Date.now();
      while (!window.__R.log.includes('welcome ✓')) {
        if (Date.now() - t0 > 8000) throw new Error('没等到 welcome');
        await new Promise((r) => setTimeout(r, 50));
      }

      if (ROLE === 'share') {
        // 造一路会动的画面 —— 必须真动，否则收不到帧 ✗
        const cv = document.createElement('canvas');
        cv.width = 640; cv.height = 360;
        const ctx = cv.getContext('2d');
        window.__tick = 0;
        setInterval(() => {
          window.__tick++;
          ctx.fillStyle = 'hsl(' + ((window.__tick * 7) % 360) + ',75%,50%)';
          ctx.fillRect(0, 0, 640, 360);
          ctx.fillStyle = '#fff';
          ctx.font = '48px sans-serif';
          ctx.fillText('t=' + window.__tick, 30, 200);
        }, 100);
        const stream = cv.captureStream(15);

        const bc = new P2P.ScreenShareBroadcaster({
          selfId: SELF, send, getStream: () => stream,
          onState: (id, s) => { L('peer ' + id + ' -> ' + s); window.__R.state = s; },
        });
        onP2P = (from, payload) => bc.handleSignal(from, payload);
        window.__bc = bc;
        window.__R.state = 'ready';
        window.__bcHasFailed = () => bc.hasFailed();
        window.__bcStates = () => bc.states();
      } else {
        const rc = new P2P.ScreenShareReceiver({
          selfId: SELF, send,
          onStream: (id, st) => {
            // ⚠️ 收到 null 时必须把 tracks 一起清掉 ✗
            //    第一版只清了 stream ✓ 于是 tracks 里留着上一次的旧值 ✓
            //    最后那条断言就永远失败 ✗（是测试的 bug，不是模块的 ✓）
            if (!st) { window.__R.stream = null; window.__R.tracks = []; return; }
            window.__R.tracks = st.getVideoTracks().map((t) => t.kind + ':' + t.readyState);
            const v = document.createElement('video');
            v.muted = true; v.autoplay = true; v.playsInline = true;
            v.srcObject = st;
            document.body.appendChild(v);
            v.play().catch(() => {});
            // ★ 数帧 —— 这才是"真的通了"的证据 ✗
            const count = () => {
              window.__R.frames++;
              if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(count);
            };
            if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(count);
          },
          onState: (id, s) => { L('peer ' + id + ' -> ' + s); window.__R.state = s; },
        });
        onP2P = (from, payload) => rc.handleSignal(from, payload);
        window.__rc = rc;
        window.__R.state = 'ready';
        window.__watch = () => rc.watch(PEER);
        window.__unwatch = () => rc.unwatch();
        window.__rcStates = () => rc.states();
      }
    }
    boot().catch((e) => { window.__R.err = String(e && e.message || e); });
  `
  return `<!doctype html><meta charset="utf-8">
<title>p2p harness ${role}</title>
<body>
<script>${bundle}</script>
<script>${driver}</script>`
}

async function launch(cdpPort, profile, url) {
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
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
      // ⚠️ 匹配的是 **URL** ✗
      //    第一版找的是页面标题里的 'p2p harness' ✓
      //    但 `/json` 里能匹配的是 url ✓ 标题不在里面 ✓
      //    结果两个实例都"起不来" ✗（其实是找不到那个 tag ✓）
      page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes(`${HARNESS_PORT}/`),
      )
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

  // ① 打包被测模块（就是生产用的那个文件 ✓ 不是副本 ✓）
  console.log('  打包 p2pTransport.ts…')
  const built = buildSync({
    entryPoints: [join(ROOT, 'src', 'renderer', 'src', 'lib', 'p2pTransport.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'P2P',
    write: false,
    target: 'chrome120',
    logLevel: 'silent',
  })
  const bundle = built.outputFiles[0].text
  console.log(`  [OK] 打包完成，${(bundle.length / 1024).toFixed(1)} KB`)

  // ② 起后端
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

  // ③ 起一个极小的静态服务，把测试页发出去
  const pages = {
    '/share': makeHtml(bundle, 'u-share', 'u-view', 'share'),
    '/view': makeHtml(bundle, 'u-view', 'u-share', 'view'),
  }
  harness = createServer((req, res) => {
    const html = pages[req.url?.split('?')[0] ?? '']
    if (!html) { res.writeHead(404); res.end('nope'); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise((r) => harness.listen(HARNESS_PORT, '127.0.0.1', r))
  console.log(`  [OK] 测试页服务在 ${HARNESS_PORT}`)

  // ④ 两个浏览器
  console.log('  启动两个 Chrome…')
  const S = await launch(9421, join(tmp, 'ps'), `http://127.0.0.1:${HARNESS_PORT}/share`)
  const V = await launch(9422, join(tmp, 'pv'), `http://127.0.0.1:${HARNESS_PORT}/view`)

  await until(async () => (await S.ev(`window.__R.state`)) === 'ready', 15000, '分享端就绪')
  await until(async () => (await V.ev(`window.__R.state`)) === 'ready', 15000, '观看端就绪')
  const errS = await S.ev(`window.__R.err`)
  const errV = await V.ev(`window.__R.err`)
  check('两个页面都完成了 hello', !errS && !errV, String(errS || errV))
  console.log('')

  // ⑤ 观看端请求观看 → 分享端回 offer
  console.log('  观看端发 want…')
  await V.ev(`window.__watch(); true`)

  await until(async () => (await S.ev(`window.__R.state`)) === 'connected', 25000, '分享端连上')
  await until(async () => (await V.ev(`window.__R.state`)) === 'connected', 25000, '观看端连上')
  check('分享端连接成功', (await S.ev(`window.__R.state`)) === 'connected')
  check('观看端连接成功', (await V.ev(`window.__R.state`)) === 'connected')
  check('分享端没有需要回退的观众', (await S.ev(`window.__bcHasFailed()`)) === false)

  // ⑥ 真的收到画面 —— 数帧 ✓
  await until(async () => (await V.ev(`window.__R.tracks.length > 0`)) === true, 10000, '收到视频轨')
  const tracks = await V.ev(`window.__R.tracks`)
  check('观看端拿到了视频轨', Array.isArray(tracks) && tracks.some((t) => t.startsWith('video:')), JSON.stringify(tracks))

  await until(async () => (await V.ev(`window.__R.frames`)) > 3, 15000, '画面出帧')
  const frames = await V.ev(`window.__R.frames`)
  check('画面**真的在出帧**（不是只有连接）', frames > 3, `frames=${frames}`)

  // ⑦ 两边的状态快照
  const bcStates = await S.ev(`JSON.stringify(window.__bcStates())`)
  const rcStates = await V.ev(`JSON.stringify(window.__rcStates())`)
  console.log(`     分享端状态：${bcStates}`)
  console.log(`     观看端状态：${rcStates}`)

  // ⑧ unwatch → 连接拆掉、流清空
  //
  // ⚠️ 这条不能写成恒真 ✗
  //    第一版写的是 `afterReject !== 'connected' || true` ✓
  //    那个 `|| true` 让断言**永远通过** ✗ 等于没测 ✓
  console.log('')
  console.log('  测 unwatch…')
  await V.ev(`window.__unwatch(); true`)
  await wait(800)
  const vTracks = await V.ev(`window.__R.tracks.length`)
  check('unwatch 之后观看端的流被清掉', vTracks === 0, `tracks=${vTracks}`)

  // ⑨ unwatch 之后被硬塞 offer → 观看端应该回 bye，广播端不该留下这个观众
  await S.ev(`window.__bc.handleSignal('u-view', { t: 'want' }); true`)
  await wait(1800)
  const bcAfter = JSON.parse((await S.ev(`JSON.stringify(window.__bcStates())`)) || '{}')
  check(
    'unwatch 之后被硬塞 offer 会被拒（广播端没留下观众）',
    Object.keys(bcAfter).length === 0,
    JSON.stringify(bcAfter),
  )

  console.log('')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  console.log('')

  S.ws.close(); V.ws.close()
  cleanup()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.log('  ❌ ' + e.message)
  cleanup()
  process.exit(1)
})
