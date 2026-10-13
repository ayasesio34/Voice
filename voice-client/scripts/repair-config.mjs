/**
 * 把被我覆盖掉的客户端配置**原样还原**。
 *
 * 事故：验证脚本为了让应用连本地测试后端，往 localStorage 写了
 * `http://127.0.0.1:308x`。而 **Chromium 把 `file://` 一律当成同一个源** ——
 * 开发运行和你装的那份共用一份 localStorage，所以你的配置被覆盖了。
 *
 * 好在 LevelDB 会把被覆盖的记录留在日志里（整理之前），
 * 所以可以从 `%APPDATA%\voice-client\Local Storage\leveldb\*.log`
 * 里把**原始 JSON 一字不差地**挖回来。
 *
 * 跑法（在 voice-client 目录）：
 *     node scripts/repair-config.mjs            # 只读，看看现在是什么
 *     node scripts/repair-config.mjs restore    # 还原
 *     node scripts/repair-config.mjs restore <userId>   # 指定还原哪一个
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = 'C:\\AAAsoftware\\Voice\\Voice.exe'
const LEVELDB = join(
  process.env.APPDATA ?? '',
  'voice-client',
  'Local Storage',
  'leveldb'
)
const CDP_PORT = 9226
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const mode = process.argv[2] ?? 'read'
const wantId = process.argv[3] ?? ''

/**
 * 从 LevelDB 日志里把所有 `voice.config.v2` 的历史值抠出来。
 *
 * ⚠️ 两种编码都要试：Chromium 里 localStorage 的值常见是 **UTF-16LE**，
 *    但早期的记录可能是 UTF-8。只搜一种会漏。
 *
 * ⚠️ **不能用「一路 `[^{}]` 到结尾」那种正则**：
 *    记录里有嵌套的大括号（`"avatar":{"color":...}`），
 *    那个字符集会停在嵌套的 `{` 上，匹配出来的是一段残片。
 *    所以这里定位 `{"livekitUrl"` 作为起点，然后**配平地扫到对应的 `}`**。
 */
export function extractConfigs(dir) {
  const found = []
  let files = []
  try {
    files = readdirSync(dir).filter((f) => /\.log$|\.ldb$/.test(f))
  } catch {
    return found
  }

  const START = '{"livekitUrl"'

  for (const f of files) {
    const bytes = readFileSync(join(dir, f))
    for (const enc of ['utf8', 'utf16le']) {
      const s = bytes.toString(enc)
      let from = 0
      for (;;) {
        const at = s.indexOf(START, from)
        if (at < 0) break
        from = at + 1

        // 从这里往后配平括号，找到这条记录的结尾
        let depth = 0
        let end = -1
        for (let i = at; i < s.length && i < at + 4000; i++) {
          if (s[i] === '{') depth++
          else if (s[i] === '}') {
            depth--
            if (depth === 0) {
              end = i + 1
              break
            }
          }
        }
        if (end < 0) continue

        const raw = s.slice(at, end)
        try {
          const o = JSON.parse(raw)
          // 只要真的指向我们服务器、而且带身份的那种
          if (o.apiUrl?.includes('YOUR_SERVER_IP') && o.userId) {
            found.push({ file: f, enc, raw, obj: o })
          }
        } catch {
          /* 不是完整记录，跳过 */
        }
      }
    }
  }
  return found
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

let appProc = null
const cleanup = () => {
  try {
    appProc?.kill()
  } catch {
    /* ignore */
  }
}

async function main() {
  // ── 先把候选身份列出来 ────────────────────────────────────
  const configs = extractConfigs(LEVELDB)
  console.log('')
  console.log('  === 从 LevelDB 里挖到的历史配置 ===')
  if (configs.length === 0) {
    console.log('  （没挖到）—— LevelDB 可能已经整理过了')
  }
  const seen = new Set()
  const uniq = []
  for (const c of configs) {
    if (seen.has(c.obj.userId)) continue
    seen.add(c.obj.userId)
    uniq.push(c)
    console.log(`  · nickname=${c.obj.nickname}  userId=${c.obj.userId}`)
    console.log(`    userKey=${c.obj.userKey}`)
  }
  console.log('')

  if (mode !== 'restore') {
    console.log('  （只读模式。要还原加参数：node scripts/repair-config.mjs restore [userId]）')
    return
  }

  const pick = wantId ? uniq.find((c) => c.obj.userId === wantId) : uniq.find((c) => c.obj.nickname === 'Owner') ?? uniq[0]
  if (!pick) throw new Error('没有可还原的配置')
  console.log(`  还原目标：nickname=${pick.obj.nickname}  userId=${pick.obj.userId}`)
  console.log('')

  if (!existsSync(EXE)) throw new Error(`找不到 ${EXE}`)

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  appProc = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`], { env, stdio: 'ignore' })

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
  if (!page) throw new Error('连不上应用（CDP）')

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

  console.log('  写入前：' + (await evaluate(`localStorage.getItem('voice.config.v2')`)))
  // 原样写回 —— 一个字节都不改（连头像里的 emoji 都保住）
  await evaluate(
    `localStorage.setItem('voice.config.v2', ${JSON.stringify(pick.raw)}); true`
  )
  console.log('  写入后：' + (await evaluate(`localStorage.getItem('voice.config.v2')`)))
  console.log('')

  await cdp(ws, id++, 'Page.enable')
  await cdp(ws, id++, 'Page.reload')
  console.log('  已刷新，等它连服务器…')
  await wait(9000)

  const after = await evaluate(`
    (() => {
      const t = document.querySelector('.toast')
      const body = document.body.textContent || ''
      return {
        toast: t ? t.textContent : null,
        notConnected: body.includes('未连接'),
        online: (body.match(/·\\s*(\\d+)\\s*人在线/) || [])[1] ?? null,
        me: (document.querySelector('.member-name-text') || {}).textContent ?? null,
        role: (document.querySelector('.role-badge') || {}).textContent ?? null,
      }
    })()`)

  console.log('')
  console.log(`  提示条    = ${after?.toast ?? '（没有）'}`)
  console.log(`  还显示未连接 = ${after?.notConnected}`)
  console.log(`  在线人数   = ${after?.online ?? '(没读到)'}`)
  console.log(`  我的名字   = ${after?.me ?? '(没读到)'}`)
  console.log(`  我的角色   = ${after?.role ?? '(没读到)'}`)
  console.log('')
  console.log(`  ${!after?.notConnected && !after?.toast ? '✅ 连上了' : '⚠️ 还有问题，看上面的输出'}`)

  ws.close()
}

main()
  .then(() => {
    cleanup()
    process.exit(0)
  })
  .catch((err) => {
    console.log('  ❌ ' + err.message)
    cleanup()
    process.exit(1)
  })
