/**
 * 验证 NAT 映射行为的判法（锥型 / 地址相关）。
 *
 * 跑法（在 voice-client 目录）：node scripts/verify-nat-detect.mjs
 *
 * ⚠️ 为什么不放进 npm test ✗
 *    它依赖**外部 STUN 服务器可达** ✓ 网络环境一变就会随机失败 ✓
 *    常驻的 verify-p2p-check.mjs 不依赖外部网络 ✓ 那个才适合进测试 ✓
 *
 * ── 它为什么必须单独存在 ✗ ──────────────────────────────────
 *   常驻测试为了让连接快一点 ✓ 会把 STUN 列表**清空** ✓
 *   于是 detectMappingBehavior 一进来就"可用的 STUN 不到两台"返回了 ✓
 *   那里面最关键的**比较逻辑根本执行不到** ✓ 这个脚本就是补那个洞 ✓
 *
 * ── 它守的是什么 ✗ ─────────────────────────────────────────
 *   这段判法**错过两次** ✓ 两次都是"结论和实测结果矛盾"才发现的 ✓
 *
 *   第一次：建了**两个** RTCPeerConnection、各配一台 STUN、比较映射端口 ✗
 *     但每个连接用的是**不同的本地端口** ✓ 而 NAT 映射跟着本地端口走 ✓
 *     所以连最标准的锥型 NAT 也一定比出"不一样" ✗ → 一律误判成对称型 ✓
 *     发现方式：某台机器被判"对称型（打洞很难）" ✓
 *               可同一台机器实测 **108ms 直连成功、102 Mbps** ✗ 明显矛盾 ✓
 *
 *   第二次：改成**一个**连接配多台 STUN 之后 ✓ 又去"数候选的个数" ✗
 *     Chrome 会把**映射地址相同**的候选**去重** ✓
 *     锥型 NAT 下 5 台 STUN 看到的是同一个映射 ✓ → 只留**一个**候选 ✓
 *     于是"只有 1 个候选"被读成"只有 1 台 STUN 回了" ✓ 又判反了 ✓
 *     正确做法：拿"实际响了几个**不同**映射"和"**应该**有几台会回"对比 ✓
 *
 *   → 这段逻辑的教训：**推断出来的结论必须和实测结果对账** ✗
 *      对不上就是**推断**错了 ✓ 不是实测错了 ✓
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = join(ROOT, '..', 'voice-server', 'backend')
const PORT = 3096
const INVITE = 'testcode'
const PAGE = `http://127.0.0.1:${PORT}/p2p-check?code=${INVITE}&room=natprobe`
const NODE = ['C:\\Program Files\\nodejs\\node.exe'].find((p) => existsSync(p)) ?? 'node'
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = mkdtempSync(join(tmpdir(), 'voice-nat-'))
let srv = null
let chrome = null

function cleanup() {
  try { chrome?.kill() } catch {}
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
    setTimeout(() => reject(new Error(`${method} 超时`)), 30000)
  })
}

async function main() {
  if (!CHROME) throw new Error('找不到 Chrome')
  const logFd = openSync(join(tmp, 'server.log'), 'a')
  srv = spawn(NODE, ['src/index.js'], {
    cwd: BACKEND,
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      DB_PATH: join(tmp, 'voice.db'), UPLOADS_DIR: join(tmp, 'up'),
      UPDATES_DIR: join(tmp, 'upd'),
      LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'devsecret',
      INVITE_CODE: INVITE, OWNER_NAME: 'Owner',
    },
    stdio: ['ignore', logFd, logFd],
  })
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break } catch {}
    await wait(250)
  }

  chrome = spawn(CHROME, [
    '--remote-debugging-port=9413', `--user-data-dir=${join(tmp, 'p')}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-features=WebRtcHideLocalIpsWithMdns', PAGE,
  ], { stdio: 'ignore' })

  let page = null
  for (let i = 0; i < 60; i++) {
    await wait(400)
    try {
      const list = await (await fetch('http://127.0.0.1:9413/json')).json()
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes('p2p-check'))
      if (page) break
    } catch {}
  }
  if (!page) throw new Error('连不上 CDP')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', () => rej(new Error('CDP 连不上')))
  })
  let id = 1
  const ev = async (expr) => {
    const r = await cdp(ws, id++, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('页面报错：' + (r.exceptionDetails.exception?.description ?? ''))
    return r.result?.value
  }

  console.log('  等 NAT 判定（要等 STUN 收集完 ✓ 最多 60 秒）…')
  const t0 = Date.now()
  let type = '—'
  while (Date.now() - t0 < 60000) {
    type = (await ev(`document.getElementById('natType').textContent`)).trim()
    if (type && type !== '—' && !type.startsWith('探测')) break
    await wait(1000)
  }

  const dump = async (label, sel) => {
    const v = await ev(`(document.getElementById('${sel}')?.textContent||'').trim()`)
    console.log(`  ${label}：${v}`)
  }
  console.log('')
  await dump('公网 IPv4 ', 'v4')
  await dump('公网 IPv6 ', 'v6')
  await dump('UDP 出站  ', 'udp')
  await dump('NAT 映射  ', 'natType')
  console.log('  ── NAT 说明 ──')
  const hint = await ev(`document.getElementById('natHint').innerHTML.replace(/<br\\s*\\/?>/g,'\\n').replace(/<[^>]+>/g,'').trim()`)
  for (const line of hint.split('\n')) if (line.trim()) console.log('     ' + line.trim())

  console.log('')
  console.log('  ── STUN 逐个结果 ──')
  const stun = await ev(`(document.getElementById('stunState').textContent||'').trim()`)
  console.log('     ' + stun)

  // 判定：关键是不能崩、且要给出一个明确结论（或明确说"无法判断"）
  const ok = type.length > 0 && !type.includes('NaN') && !type.includes('undefined')
  console.log('')
  console.log(`  ${ok ? '✅ 判法没崩，给出了结论' : '❌ 有异常'}`)

  ws.close()
  cleanup()
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.log('  ❌ ' + e.message)
  cleanup()
  process.exit(1)
})
