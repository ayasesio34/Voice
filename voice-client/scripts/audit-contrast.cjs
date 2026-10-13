/**
 * 按钮对比度审计。
 *
 * 跑法（在 voice-client 目录）：
 *     node scripts/audit-contrast.cjs
 *
 * ── 它解决的是什么 ────────────────────────────────────────────
 * 这个项目已经**三次**踩同一类坑：
 *
 *     button         { background: var(--accent); color: var(--on-accent); }  // 蓝底白字
 *     .server-header { background: transparent; }                             // 只改底！
 *     button.ghost   { background: var(--chip); }                             // 只改底！
 *     .member-action { background: var(--chip); }                             // 只改底！
 *
 * 症状都一样：**深色主题看着完全正常，浅色主题下白字配浅底 → 字没了**。
 *
 * 靠肉眼找是不可靠的（前两次都漏了），所以改成机器扫：
 * 把真实界面渲染出来，遍历**每一个** button，算出实际的前景色/背景色对比度，
 * 低于阈值就报出来。
 *
 * 关键是"实际"两个字：
 *   · 颜色要从 getComputedStyle 读**计算后**的值 ——
 *     这样才能抓到"从 button 继承来的白字"这种间接情况
 *   · 背景要**往上找** —— 很多按钮自己是 transparent，
 *     真正的底色在祖先元素上
 *
 * 两套主题各扫一遍。
 */

const { app, BrowserWindow } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const BACKEND = path.join(ROOT, '..', 'voice-server', 'backend')
const PORT = 3097

/** WCAG 对小字号文本的最低要求是 4.5:1；按钮文字按 3:1 兜底（大多数是 12~13px，偏小） */
const MIN_RATIO = 3

const out = (s) => console.log(s)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const NODE = ['C:\\Program Files\\nodejs\\node.exe'].find((p) => fs.existsSync(p)) ?? 'node'

/** 相对亮度 → 对比度（WCAG 2.x） */
function luminance([r, g, b]) {
  const f = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

const parseRgb = (s) => (String(s).match(/\d+/g) || []).slice(0, 3).map(Number)

/**
 * 页面里跑的探针。
 *
 * ⚠️ 这段是**字符串**，会被送进渲染进程执行 —— 所以它不能引用外面的任何变量。
 */
const PROBE = `
(() => {
  const rows = []
  const parse = (s) => (String(s).match(/\\d+/g) || []).slice(0, 3).map(Number)
  const isOpaque = (s) => s && s !== 'transparent' && !/rgba\\(.*,\\s*0\\)$/.test(s)

  for (const el of document.querySelectorAll('button')) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue

    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) continue

    // 往上找第一层真正有底色的祖先（上限 20 层，别写成死循环）
    let bg = cs.backgroundColor
    let node = el
    for (let i = 0; i < 20 && !isOpaque(bg); i++) {
      node = node.parentElement
      if (!node) break
      bg = getComputedStyle(node).backgroundColor
    }

    const text = (el.textContent || '').trim()

    // 只审"真的有文字"的按钮。三类要排除：
    //   · 纯图标（里面是 svg）—— 没有"文字颜色"这回事
    //   · 纯 emoji —— 它们是**彩色字形**，CSS 的 color 管不着，
    //     报出来的"白字配浅底"是假警报
    //   · 完全没有内容的（色块）—— 同理
    //
    // ⚠️ 反斜杠要写**两层**：这段在 Node 里是个模板字符串，
    //    单层的 \\p 会被当成"身份转义"直接吃成 p，
    //    于是正则变成 [p{L}] —— 什么按钮都匹配不上（踩过）。
    const stripped = text.replace(/[\\p{Extended_Pictographic}\\uFE0F\\u200D\\s]/gu, '')
    const hasRealText = /[\\p{L}\\p{N}]/u.test(stripped)
    if (!hasRealText) continue

    const label = text.slice(0, 12) || '(无标签)'

    rows.push({
      label,
      cls: (el.className || '').toString().slice(0, 40),
      fg: cs.color,
      bg,
      fontSize: cs.fontSize,
    })
  }
  return rows
})()
`

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return true
    } catch {
      /* 还没起来 */
    }
    await wait(250)
  }
  return false
}

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-audit-'))
  const dbPath = path.join(tmp, 'voice.db')
  const logFd = fs.openSync(path.join(tmp, 'server.log'), 'a')

  const srv = spawn(NODE, ['src/index.js'], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DB_PATH: dbPath,
      UPLOADS_DIR: path.join(tmp, 'uploads'),
      UPDATES_DIR: path.join(tmp, 'updates'),
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'devsecret',
      INVITE_CODE: 'test',
    },
    stdio: ['ignore', logFd, logFd],
  })

  const up = await waitForServer()
  if (!up) out('后端没起来 —— 界面会缺一大半，审计结果不可信')

  const win = new BrowserWindow({ show: true, width: 1280, height: 820 })

  // 先加载一次，等 React 挂载完再写 localStorage
  // （App 挂载时的 applyTheme 会把主题写回去，抢在它前面写会被覆盖）
  await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'))
  await wait(1200)
  await win.webContents.executeJavaScript(`
    localStorage.setItem('voice.config.v2', JSON.stringify({
      nickname: '小明', apiUrl: 'http://127.0.0.1:${PORT}', livekitUrl: 'ws://127.0.0.1:9',
      inviteCode: 'test', userId: 'u1', userKey: 'k1', avatar: ''
    })); true
  `)

  let problems = 0
  let checked = 0

  for (const theme of ['dark', 'light']) {
    await win.webContents.executeJavaScript(
      `localStorage.setItem('voice.theme', ${JSON.stringify(theme)}); true`
    )
    await new Promise((resolve) => {
      win.webContents.once('did-finish-load', resolve)
      win.webContents.reload()
    })
    await wait(2400)

    /** 打开各个弹窗，把藏在里面的按钮也扫进来 */
    const surfaces = [
      ['主界面', 'true'],
      [
        '设置',
        `(() => {
           const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '设置')
           if (b) { b.click(); return true }
           return false
         })()`,
      ],
    ]

    out(`\n──── ${theme} ────`)

    for (const [name, openExpr] of surfaces) {
      try {
        const opened = await win.webContents.executeJavaScript(openExpr)
        if (opened === false) {
          out(`  （${name}：打不开，跳过）`)
          continue
        }
        await wait(500)

        const rows = await win.webContents.executeJavaScript(PROBE)
        out(`  ${name}：扫到 ${rows.length} 个按钮`)

        for (const r of rows) {
          checked++
          const ratio = contrast(parseRgb(r.fg), parseRgb(r.bg))
          if (ratio < MIN_RATIO) {
            problems++
            out(
              `    ⚠️ 对比度 ${ratio.toFixed(2)}  字=${r.fg}  底=${r.bg}  ` +
                `「${r.label}」 class="${r.cls}"`
            )
          }
        }
      } catch (err) {
        out(`  （${name}：出错 ${err.message}）`)
      }
    }
  }

  // 收尾：关掉设置弹窗再退
  try {
    await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop')?.click(); true`)
  } catch {
    /* ignore */
  }

  out(`\n${'─'.repeat(52)}`)
  out(`检查了 ${checked} 个按钮，发现 ${problems} 处对比度不足（阈值 ${MIN_RATIO}:1）`)
  if (problems === 0) out('✅ 没有"字和底撞色"的按钮')

  srv.kill()
  await wait(300)
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  app.exit(problems === 0 ? 0 : 1)
})
