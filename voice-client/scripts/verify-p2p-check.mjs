/**
 * 验证 P2P 诊断页：信令中继 + 直连 + 吞吐测试能不能跑通。
 *
 * 跑法（在 voice-client 目录）：node scripts/verify-p2p-check.mjs
 *
 * ── 为什么用 Chrome 而不是 Electron ✗ ──────────────────────
 * 客户端有**单实例锁**（见 main/index.ts 的注释：
 * 第二个实例会直接退出并把已有窗口唤到前面）✓
 * 而这个测试需要**两个完全独立的浏览器实例** ✓
 * 所以用系统里的 Chrome ✓ 它和 Electron 是同一套 Chromium/WebRTC ✓
 *
 * ── 验证什么 ✓ ─────────────────────────────────────────────
 *   ① 后端新加的 /p2p-check 页面能打开
 *   ② 后端新加的 /p2p-signal 房间中继能配对、能报出加入顺序
 *   ③ 两个浏览器之间能建立真正的 WebRTC 直连
 *   ④ DataChannel 吞吐测试能跑出数字，并且两边都能看到
 *   ⑤ 成功路径会给出结论（这里最容易漏 ✗ 之前就漏过 ✓）
 *
 * ⚠️ 本机两个实例之间的直连会走 host 候选（同一个内网 ✓）
 *    所以它验证的是"管道通不通" ✓ 不是"NAT 能不能打洞" ✗
 *    真实网络下的打洞率要在用户的机器上量 ✓
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = join(ROOT, '..', 'voice-server', 'backend')
const PORT = 3095
const INVITE = 'testcode'
const PAGE = `http://127.0.0.1:${PORT}/p2p-check?code=${INVITE}&room=t1`

const NODE = ['C:\\Program Files\\nodejs\\node.exe'].find((p) => existsSync(p)) ?? 'node'
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = mkdtempSync(join(tmpdir(), 'voice-p2p-'))

let srv = null
const browsers = []

function cleanup() {
  for (const b of browsers) { try { b.kill() } catch {} }
  try { srv?.kill() } catch {}
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
    setTimeout(() => reject(new Error(`${method} 超时`)), 20000)
  })
}

async function launchBrowser(cdpPort, profile) {
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    // ⚠️ 必须关掉 mDNS 候选混淆 ✗
    //    Chromium 默认把本地 IP 藏成 xxxx.local 的 mDNS 名字 ✓
    //    但它的 mDNS responder 要占 UDP 5353 ✓ 同一台机器上两个实例抢不到 ✓
    //    结果互相解析不出 host 候选 → 本机之间反而连不上 ✗（踩过 ✓）
    //    真实机器上两个人在两台电脑，不冲突 ✓ 所以这只是测试环境的问题 ✓
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    PAGE,
  ], { stdio: 'ignore' })
  browsers.push(proc)

  let page = null
  for (let i = 0; i < 60; i++) {
    await wait(400)
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes('p2p-check'))
      if (page) break
    } catch { /* 还没起来 */ }
  }
  if (!page) throw new Error(`实例 ${cdpPort} 连不上 CDP 或没打开页面`)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', () => rej(new Error('CDP 连不上')))
  })

  let id = 1
  const evaluate = async (expr) => {
    const r = await cdp(ws, id++, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('页面里报错：' + (r.exceptionDetails.exception?.description ?? ''))
    return r.result?.value
  }
  return { ws, evaluate, port: cdpPort }
}

async function until(fn, ms, label) {
  const t0 = Date.now()
  for (;;) {
    let v
    try { v = await fn() } catch { v = false }
    if (v) return true
    if (Date.now() - t0 > ms) throw new Error(`超时（${ms}ms）：${label}`)
    await wait(300)
  }
}

async function main() {
  if (!CHROME) throw new Error('找不到 Chrome 或 Edge')

  console.log('')
  console.log('  启动后端（临时库，邀请码 ' + INVITE + '）…')
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
      INVITE_CODE: INVITE,
      OWNER_NAME: 'Owner',
    },
    stdio: ['ignore', logFd, logFd],
  })

  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break } catch {}
    await wait(250)
  }

  // ① 页面本身能打开
  const pageRes = await fetch(`http://127.0.0.1:${PORT}/p2p-check`)
  const pageText = await pageRes.text()
  console.log(`  ${pageRes.ok ? '[OK]' : '[FAIL]'} /p2p-check 返回 ${pageRes.status}，${pageText.length} 字节`)

  // ①.5 拒绝路径 —— 最容易出问题的一段 ✓
  //
  // ⚠️ 这里专门覆盖"点一下就断开"那个症状 ✗
  //    服务端要是 send 完立刻 close ✓ 错误消息会被吞掉 ✓
  //    客户端就只剩一句"断开"，看不出真实原因（邀请码不对 / 房间满了）✓
  //    所以必须断言：**错误消息真的收到了** ✓ 而不只是断言连接被关掉 ✓
  console.log('\n  测信令的拒绝路径…')
  const trySignal = (qs) =>
    new Promise((resolve) => {
      const w = new WebSocket(`ws://127.0.0.1:${PORT}/p2p-signal?${qs}`)
      let got = null
      let settled = false
      const done = (why) => {
        if (settled) return
        settled = true
        try { w.close() } catch {}
        resolve(got ?? why)
      }
      w.onmessage = (e) => { try { got = JSON.parse(e.data) } catch { /* ignore */ } }
      w.onclose = () => done('(直接断开，一条消息都没收到)')
      w.onerror = () => { /* onclose 会跟着来 */ }
      setTimeout(() => done('(超时)'), 4000)
    })

  const badCode = await trySignal('room=t1&code=WRONG')
  const noRoom = await trySignal(`room=&code=${INVITE}`)
  const good = await trySignal(`room=t1&code=${INVITE}`)

  const okBadCode = badCode?.msg === 'bad_code'
  const okNoRoom = noRoom?.msg === 'no_room'
  const okGood = good?.t === 'peers' && good?.idx === 0
  console.log(`  ${okBadCode ? '[OK]' : '[FAIL]'} 邀请码错误 → ${JSON.stringify(badCode)}`)
  console.log(`  ${okNoRoom ? '[OK]' : '[FAIL]'} 没填房间号 → ${JSON.stringify(noRoom)}`)
  console.log(`  ${okGood ? '[OK]' : '[FAIL]'} 邀请码正确 → ${JSON.stringify(good)}`)

  // 让 gatherIce 快一点：本机测连不需要 STUN
  console.log('\n  启动两个 Chrome 实例…')
  const A = await launchBrowser(9411, join(tmp, 'pa'))
  const B = await launchBrowser(9412, join(tmp, 'pb'))
  console.log('  [OK] 两个实例都打开了诊断页')

  await until(() => A.evaluate(`!!document.getElementById('btnConn')`), 10000, '页面就绪')
  await B.evaluate(`document.getElementById('stunList').value=''; true`)
  await A.evaluate(`document.getElementById('stunList').value=''; true`)

  // ② 信令配对
  console.log('\n  连信令…')
  await A.evaluate(`document.getElementById('btnConn').click(); true`)
  await B.evaluate(`document.getElementById('btnConn').click(); true`)

  await until(async () => (await A.evaluate(`document.getElementById('peerState').textContent`)).includes('1'), 15000, 'A 看到对端')
  await until(async () => (await B.evaluate(`document.getElementById('peerState').textContent`)).includes('1'), 15000, 'B 看到对端')
  const connA = await A.evaluate(`document.getElementById('connState').textContent`)
  const connB = await B.evaluate(`document.getElementById('connState').textContent`)
  console.log(`  [OK] 信令已连（A="${connA}" B="${connB}"），两边都看到 1 个对端`)

  // 加入顺序 —— 决定谁是主叫
  const logA = await A.evaluate(`document.getElementById('log').textContent`)
  const idxA = /我是第 (\d+) 个加入的/.exec(logA)?.[1]
  const logB = await B.evaluate(`document.getElementById('log').textContent`)
  const idxB = /我是第 (\d+) 个加入的/.exec(logB)?.[1]
  console.log(`  加入顺序：A=${idxA} B=${idxB}${idxA !== idxB ? '  [OK] 不同，不会 glare' : '  [FAIL] 相同 ✗'}`)

  // ③ 直连
  console.log('\n  开始直连测试（两边都点 ✓ 只点一边接不住 offer ✗）…')
  await A.evaluate(`document.getElementById('btnP2P').click(); true`)
  await B.evaluate(`document.getElementById('btnP2P').click(); true`)

  // ⚠️ 失败时要把两边日志打出来 ✗ 不然只能靠猜 ✓（这次就靠它定位了 mDNS）
  const dumpLogs = async (why) => {
    console.log('\n  ---- 失败：' + why + ' ----')
    for (const [name, p] of [['A(主叫)', A], ['B(被叫)', B]]) {
      const lg = await p.evaluate(`document.getElementById('log').textContent`)
      const st = await p.evaluate(`document.getElementById('p2pState').textContent`)
      console.log(`  ── ${name}  状态="${st}"`)
      for (const line of lg.split('\n').slice(-14)) console.log('     ' + line)
    }
  }

  try {
    await until(async () => {
      const s = await A.evaluate(`document.getElementById('p2pState').textContent`)
      return s === '已直连' || s === '测吞吐中…' || s === '完成' || s === '连接失败'
    }, 25000, 'A 建立直连')
  } catch (e) {
    await dumpLogs('A 没能在 25 秒内建立直连')
    throw e
  }

  const stateA = await A.evaluate(`document.getElementById('p2pState').textContent`)
  if (stateA === '连接失败') {
    await dumpLogs('A 报连接失败')
    throw new Error('直连失败')
  }
  console.log(`  [OK] 直连建立：A 状态="${stateA}"`)

  // ④ 等吞吐测完（6 秒灌数据 + 余量）
  await until(async () => (await A.evaluate(`document.getElementById('p2pState').textContent`)) === '完成', 25000, '吞吐测试结束')

  const result = async (p) => ({
    state: await p.evaluate(`document.getElementById('p2pState').textContent`),
    time: await p.evaluate(`document.getElementById('rTime').textContent`),
    pair: await p.evaluate(`document.getElementById('rPair').textContent`),
    kind: await p.evaluate(`document.getElementById('rKind').textContent`),
    up: await p.evaluate(`document.getElementById('rUp').textContent`),
    verdict: await p.evaluate(`(document.getElementById('verdict').textContent||'').replace(/\\s+/g,' ').trim().slice(0,90)`),
    log: await p.evaluate(`document.getElementById('log').textContent`),
  })
  const rA = await result(A)
  const rB = await result(B)

  console.log('')
  console.log('  ┌─ 主叫（A）' + '─'.repeat(46))
  for (const [k, v] of Object.entries({ 状态: rA.state, 用时: rA.time, 候选对: rA.pair, 链路: rA.kind, 上行: rA.up })) {
    console.log(`  │ ${k}：${v}`)
  }
  console.log('  │ 结论：' + rA.verdict)
  console.log('  └' + '─'.repeat(56))
  console.log('  ┌─ 被叫（B）' + '─'.repeat(46))
  for (const [k, v] of Object.entries({ 状态: rB.state, 用时: rB.time, 候选对: rB.pair, 链路: rB.kind, 上行: rB.up })) {
    console.log(`  │ ${k}：${v}`)
  }
  console.log('  │ 结论：' + rB.verdict)
  console.log('  └' + '─'.repeat(56))

  // ⑤ 判定
  const mbpsA = parseFloat(rA.up) || 0
  const mbpsB = parseFloat(rB.up) || 0
  const bothSawThroughput = mbpsA > 0 && mbpsB > 0
  const bothSucceeded = rA.state === '完成' && rB.state === '完成'
  const hasPair = rA.pair !== '—' && rA.pair.includes('→')
  const hasVerdict = rA.verdict.length > 0 && rB.verdict.length > 0

  console.log('')
  console.log(`  ${pageRes.ok ? '✅' : '❌'} 诊断页能打开（${pageText.length} 字节）`)
  console.log(`  ${okBadCode ? '✅' : '❌'} 邀请码错误时**收到了明确原因**（不是静默断开）`)
  console.log(`  ${okNoRoom ? '✅' : '❌'} 没填房间号时有明确提示`)
  console.log(`  ${okGood ? '✅' : '❌'} 参数正确时能进房间并拿到加入顺序`)
  console.log(`  ${idxA && idxB && idxA !== idxB ? '✅' : '❌'} 信令中继能配对，并区分了加入顺序`)
  console.log(`  ${bothSucceeded ? '✅' : '❌'} 两边都跑到「完成」`)
  console.log(`  ${hasPair ? '✅' : '❌'} 拿到了选中的候选对（${rA.pair}）`)
  console.log(`  ${bothSawThroughput ? '✅' : '❌'} 两边都看到吞吐数字（主叫 ${mbpsA} / 被叫 ${mbpsB} Mbps）`)
  console.log(`  ${hasVerdict ? '✅' : '❌'} 成功路径给出了结论`)

  const ok = pageRes.ok && okBadCode && okNoRoom && okGood && bothSucceeded && hasPair &&
    bothSawThroughput && hasVerdict && idxA !== idxB
  console.log('')
  console.log(`  ${ok ? '✅ 通过' : '❌ 有项目不符合预期'}`)

  A.ws.close(); B.ws.close()
  cleanup()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.log('  ❌ ' + err.message)
  cleanup()
  process.exit(1)
})
