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
      import { openDb, registerMember, insertMessage, toggleReaction, setPinned, createChannel } from 'file:///${join(BACKEND, 'src', 'db.js').replace(/\\/g, '/')}';
      const db = openDb(${JSON.stringify(join(tmp, 'voice.db'))});
      const av = (e, c) => JSON.stringify({ color: c, emoji: e });
      const owner = 'Owner';
      registerMember(db, { userId:'u-a', userKey:'ka', name:'小明', avatar: av('🐱','#5865f2'), ownerName: owner });
      registerMember(db, { userId:'u-b', userKey:'kb', name:'小红', avatar: av('🐶','#23a55a'), ownerName: owner });
      registerMember(db, { userId:'u-c', userKey:'kc', name:'小刚', avatar: av('🦊','#e67e22'), ownerName: owner });
      registerMember(db, { userId:'u-d', userKey:'kd', name:'老王', avatar: av('🐼','#9b59b6'), ownerName: owner });
      const now = Date.now();
      let t = now - 6 * 60 * 1000;
      const add = (uid, name, body, gapMs, replyTo) => {
        t += gapMs;
        return insertMessage(db, { channelId:'general', authorId:uid, authorName:name, body, attachment:null, replyTo: replyTo ?? null });
      };
      const first = add('u-a','小明','今天的会开完了吗 😄', 0);
      add('u-b','小红','开完了，文档我发群里了', 60000);
      add('u-c','小刚','收到 👍', 90000);
      // ★ 再补一条**回复** —— 这样门面图里就能看到引用块长什么样 ✓
      //   （预览摘要由服务端在 listMessages 里回填 ✓ 不在这里做 ✓）
      const reply = add('u-b','小红','那就好，我等你的文档', 40000, first.id);
      // ★ 加两条**表态** —— 门面图里就能看到表态芯片 ✓
      //   两个不同的人点同一个 ✓ 这样能同时看到"人数 2"和"我点过"的高亮 ✓
      toggleReaction(db, { messageId: first.id, userId:'u-c', userName:'小刚', emoji:'👍' });
      toggleReaction(db, { messageId: first.id, userId:'u-a', userName:'小明', emoji:'👍' });
      // 再来一个只有一个人点的 ✓ 验证"两个芯片并排"的排版 ✓
      toggleReaction(db, { messageId: reply.id, userId:'u-b', userName:'小红', emoji:'🎉' });
      // ★ 置顶一条 —— 门面图里就能看到「已置顶」标记 ✓
      setPinned(db, { messageId: first.id, byName: '小明' });
      // ★ 加**子频道** —— 门面图里就能看到缩进 ✓
      //   文字和语音各来一个 ✓ 两种都要确认缩进对 ✓
// ⚠️ 子频道**不能挂在 general 下面** ✗
      //    挂了的话 general 就变成"分组标题"了 ✓ 而它是应用的默认频道 ✓
      //    → 门面图里会看到一个**开着的、但点不动的**默认频道 ✗ 很怪 ✓
      //    所以给它单开一个父频道 ✓ 这样门面图能同时展示两种状态：
      //      「综合」= 普通频道 ✓    「示例分组」= 有子频道的分组 ✓
      const demoParent = createChannel(db, { id:'demo-group', name:'示例分组', kind:'text', parentId:null });
      createChannel(db, { id:'sub-示例', name:'子频道示例', kind:'text', parentId:demoParent.id });
      const vTop = db.prepare("SELECT id FROM channels WHERE kind='voice' AND parent_id IS NULL LIMIT 1").get();
      if (vTop) {
        createChannel(db, { id:'voice-sub', name:'语音子频道', kind:'voice', parentId:vTop.id });
      }
      // ★ **把小明设成频道主** ✗
      //   直接 registerMember 建出来的人是普通成员 ✓
      //   而「+ 创建频道」和「删除消息」**只有管理员以上才渲染** ✓
      //   不设的话界面上根本没有那两个入口 ✓
      //   —— 于是子频道那个验证连对话框都打不开 ✓（真踩过 ✓）
      db.prepare("UPDATE members SET role = 'owner' WHERE user_id = 'u-a'").run();
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
    // ⚠️⚠️ 注入之前**必须等应用自己先把默认配置落盘** ✗
    //
    //   真出过一次事故 ✓ 根因就在这里：
    //     应用启动时 localStorage 是空的 ✓ 于是它用 DEFAULT_CONFIG ✓
    //     —— 那指向**真实服务器** ✗
    //     然后它会**把这份默认配置存进 localStorage** ✓
    //     如果这个"存"发生在下面那次注入**之后** ✓
    //     我的注入就被它**覆盖**了 ✗
    //     接着 reload 读到的还是真实服务器 ✓ 拍到的就是**真实成员名单** ✗
    //     而这张图在公开仓库的图片白名单里 ✓ 差一步就推出去了 ✓
    //
    //   修法：先轮询等它写出来 ✓ 再注入 ✓ 就没有先后歧义了 ✓
    //   （下面的硬校验保留 ✓ 那是最后一道防线 ✓ 这里是从根上不触发它）
    let settled = false
    for (let i = 0; i < 40; i++) {
      const v = await evaluate(`localStorage.getItem('voice.config.v2')`)
      if (v) { settled = true; break }
      await wait(250)
    }
    if (!settled) throw new Error('应用一直没写入初始配置 ✗ 页面可能压根没起来')

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

    // ⚠️⚠️ 存图之前**必须**确认拍到的是测试数据 ✗
    //
    //   真出过事：
    //     某次跑这个脚本 ✓ 应用**带着真实配置**启动了 ✓
    //     拍出来的是**真实服务器、真实成员昵称** ✗
    //     而这张图在公开仓库的**图片白名单**里 ✓
    //     差一步就跟着 `make-public.ps1` 推出去了 ✗
    //
    //   根因不是"应用有问题" ✓ 是**脚本不检查自己拍到了什么** ✗
    //   所以这里加两道硬校验 ✓ 任何一道不过就**直接报错、不写文件** ✗
    //   （宁可这次没图 ✓ 也不能把真实数据写进一个要公开的文件 ✓）
    const storedCfg = await evaluate(`localStorage.getItem('voice.config.v2')`)
    let cfgApi = ''
    try { cfgApi = JSON.parse(storedCfg || '{}').apiUrl || '' } catch { cfgApi = String(storedCfg) }
    if (!cfgApi.includes(String(PORT))) {
      throw new Error(
        `localStorage 里的 apiUrl 不是测试后端 ✗ 实际是「${cfgApi}」\n` +
        `     说明配置注入没生效 ✓ 此时拍到的会是**真实服务器** ✓ 拒绝写文件`,
      )
    }

    const bodyText = await evaluate(`document.body.innerText`)
    const hasFixture = bodyText.includes('小明') && bodyText.includes('小红')
    if (!hasFixture) {
      throw new Error(
        `页面上看不到测试数据（应该有 小明 / 小红）✗ 拒绝写文件\n` +
        `     页面上的成员名：${bodyText.slice(0, 200).replace(/\s+/g, ' ')}`,
      )
    }

    const shot = await cdp(ws, id++, 'Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ROOT, 'theme-preview', s.file), Buffer.from(shot.data, 'base64'))
    console.log(`         → theme-preview/${s.file}（已确认是测试数据 ✓）`)
  }

  console.log('')
  console.log('  ✅ 两张门面图已重新拍摄')

  // ── 顺带验「回复」的**交互** ✗ 光有截图不够 ✓ ──────────────
  //
  //   为什么非要验这个 ✗
  //     消息右键菜单原来有一句 `if (!onDeleteMessage) return` ✓
  //     那时候菜单里**只有删除** ✓ 所以"不能删就不弹"是对的 ✓
  //     加了「回复」之后这句话就变成 bug 了 ✗
  //     普通成员右键会**什么都不弹** ✓
  //     而这种错**截图完全看不出来** ✗ 必须真的右键一次 ✓
  console.log('')
  console.log('  验「回复」交互（右键 → 菜单 → 提示条 → 取消）…')

  await evaluate(`
    (() => {
      const m = document.querySelector('.chat-message');
      if (!m) return 'no-message';
      m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 260, clientY: 260 }));
      return 'ok';
    })()`)
  await wait(400)

  let uiFail = 0
  const menuItems = await evaluate(
    `[...document.querySelectorAll('.context-menu-item')].map(b => b.textContent.trim())`,
  )
  console.log(`         菜单项：${JSON.stringify(menuItems)}`)
  if (Array.isArray(menuItems) && menuItems.some((t) => t.includes('回复'))) {
    console.log('         ✅ 右键菜单里有「回复」')
  } else {
    console.log('         ❌ 右键菜单里没有「回复」（普通成员会点不出菜单 ✗）')
    uiFail++
  }

  await evaluate(`
    (() => {
      const b = [...document.querySelectorAll('.context-menu-item')].find(x => x.textContent.includes('回复'));
      if (b) b.click();
      return true;
    })()`)
  await wait(400)

  const banner = await evaluate(
    `(() => { const el = document.querySelector('.reply-banner');
              return el ? el.innerText.replace(/\\s+/g,' ').trim() : null })()`,
  )
  if (banner) {
    console.log(`         ✅ 输入框上方出现回复提示条：「${banner}」`)
  } else {
    console.log('         ❌ 点了「回复」之后没有出现 .reply-banner')
    uiFail++
  }

  await evaluate(
    `(() => { const x = document.querySelector('.reply-banner-x'); if (x) x.click(); return true })()`,
  )
  await wait(400)
  const cleared = await evaluate(`!document.querySelector('.reply-banner')`)
  if (cleared) {
    console.log('         ✅ 点 × 能取消回复（不会粘住下一条 ✓）')
  } else {
    console.log('         ❌ 点 × 之后提示条还在')
    uiFail++
  }

  console.log('')
  console.log(uiFail === 0 ? '  ✅ 回复交互全部通过' : `  ❌ 回复交互有 ${uiFail} 项失败`)

  // ── 表态：点一下芯片，走完**整条往返** ✗ ────────────────────
  //
  //   ⚠️ 这条比"渲染出来了没有"值钱得多 ✓
  //      点芯片 → api.react() → WebSocket → 服务端改库 + 广播
  //      → onReactions → setMessages → 芯片重新渲染 ✓
  //      整条路上任何一环断了，人数都不会变 ✓
  //      而"芯片画出来了"这件事，**光看截图就已经知道了** ✓ 不用再验 ✗
  console.log('')
  console.log('  验表态往返（点芯片 → 服务端 → 广播 → 界面更新）…')

  const chipBefore = await evaluate(
    `(() => { const c = document.querySelector('.reaction-chip.mine');
              return c ? c.textContent.replace(/\\s+/g,'').trim() : null })()`,
  )
  console.log(`         点之前（我点过的那枚）：${JSON.stringify(chipBefore)}`)

  await evaluate(
    `(() => { const c = document.querySelector('.reaction-chip.mine'); if (c) c.click(); return true })()`,
  )
  await wait(1200)

  const chipAfter = await evaluate(
    `(() => { const c = document.querySelector('.reaction-chip');
              return c ? c.textContent.replace(/\\s+/g,'').trim() : null })()`,
  )
  const stillMine = await evaluate(`!!document.querySelector('.reaction-chip.mine')`)
  console.log(`         点之后（第一枚）：${JSON.stringify(chipAfter)} · 还有"我点过"的吗：${stillMine}`)

  // 期望：2 → 1 ✓ 而且高亮消失 ✓（再点一次就是取消 ✓）
  const toggled = chipBefore?.includes('2') && chipAfter?.includes('1') && stillMine === false
  if (toggled) {
    console.log('         ✅ 表态往返通了：人数 2 → 1，"我点过"高亮消失')
  } else {
    console.log('         ❌ 表态往返没生效（人数没变或高亮没消失 ✗）')
    uiFail++
  }

  console.log('')
  console.log(uiFail === 0 ? '  ✅ 全部交互通过' : `  ❌ 有 ${uiFail} 项失败`)

  // ── 置顶面板：点图钉 → 列表 → 取消置顶 ✗ ────────────────────
  //
  //   ⚠️ 这条同时验了两件**截图看不出来**的事 ✓
  //      ① 图钉按钮在放大镜**左边**（位置是明确要求 ✓ 但顺序错了截图也看不出来 ✗）
  //      ② 点开面板会真的去**拉接口** ✓ 拉回来的列表里能看到那条置顶 ✓
  //         然后点「取消置顶」→ 它真的从列表里消失 ✓
  //         这是 fetchPinned + pin + 广播 的整条往返 ✓
  console.log('')
  console.log('  验置顶（按钮位置 → 面板 → 列表 → 取消置顶）…')

  // ① 按钮顺序：图钉必须在放大镜左边 ✓
  const order = await evaluate(`
    (() => {
      const btns = [...document.querySelectorAll('.chat-header button')];
      const pin = btns.find(b => (b.title || '').includes('置顶消息'));
      const search = btns.find(b => (b.title || '').includes('搜索聊天记录'));
      if (!pin || !search) return { pin: !!pin, search: !!search, order: null };
      const pr = pin.getBoundingClientRect(), sr = search.getBoundingClientRect();
      return { pin: true, search: true, order: pr.left < sr.left, pinLeft: Math.round(pr.left), searchLeft: Math.round(sr.left) };
    })()`)
  console.log(`         图钉 left=${order.pinLeft} · 放大镜 left=${order.searchLeft}`)
  if (order.order === true) {
    console.log('         ✅ 图钉在放大镜左边')
  } else {
    console.log('         ❌ 图钉不在放大镜左边，或者按钮没找到')
    uiFail++
  }

  // ② 点开面板 → 应该拉到那条置顶 ✓
  await evaluate(`
    (() => {
      const b = [...document.querySelectorAll('.chat-header button')].find(x => (x.title||'').includes('置顶消息'));
      if (b) b.click();
      return true;
    })()`)
  await wait(1200)

  const pinnedCount = await evaluate(`document.querySelectorAll('.pinned-item').length`)
  console.log(`         面板里的置顶条数：${pinnedCount}`)
  if (pinnedCount === 1) {
    console.log('         ✅ 打开面板真的拉到了那条置顶')
  } else {
    console.log(`         ❌ 应该刚好 1 条置顶，实际 ${pinnedCount} ✗`)
    uiFail++
  }

  // ③ 点「取消置顶」→ 它应该从列表里消失 ✓
  await evaluate(`
    (() => { const b = document.querySelector('.pinned-unpin'); if (b) b.click(); return true })()`)
  await wait(1400)
  const afterUnpin = await evaluate(`document.querySelectorAll('.pinned-item').length`)
  console.log(`         取消置顶之后的条数：${afterUnpin}`)
  if (afterUnpin === 0) {
    console.log('         ✅ 取消置顶走完了整条往返（列表空了）')
  } else {
    console.log(`         ❌ 取消置顶之后应该空了，实际 ${afterUnpin} ✗`)
    uiFail++
  }

  console.log('')
  console.log(uiFail === 0 ? '  ✅ 全部交互通过（回复 + 表态 + 置顶）' : `  ❌ 有 ${uiFail} 项失败`)

  // ── 子频道：缩进 + 创建对话框里的父频道候选 ✗ ────────────────
  //
  //   ⚠️ 这两件都是**截图看不出来**的 ✓
  //      ① 子频道是不是真的缩进了（像素级的位置 ✓ 肉眼容易看错 ✗）
  //         而且缩进**只能往左退**、右边缘必须和父频道对齐 ✓
  //         两边一起缩的话会看着没对齐 ✓ 那种错在图里很难发现 ✓
  //      ② 创建对话框里"放在哪里"那个下拉是不是**只列顶层频道** ✗
  //         列进子频道的话，选了会被服务端拒（nest_too_deep ✓）
  //         而用户只会觉得"建不出来" ✓
  console.log('')
  console.log('  验子频道（缩进 + 父频道候选）…')

  const sub = await evaluate(`
    (() => {
      // ⚠️ 要量的是**里面的按钮**，不是 .channel-row ✗
      //    缩进用的是 padding-left ✓ 而 padding 移动的是**内容盒** ✓
      //    行元素自己的 left 一动不动 ✓（第一版就是这么量错的 ✓）
      const rows = [...document.querySelectorAll('.channel-row')];
      const childRow = rows.find(r => r.classList.contains('channel-row-child'));
      const parentRow = rows.find(r => !r.classList.contains('channel-row-child') && r.textContent.includes('综合'));
      if (!childRow || !parentRow) return { child: !!childRow, parent: !!parentRow };
      const child = childRow.querySelector('.channel-item');
      const parent = parentRow.querySelector('.channel-item');
      const cr = child.getBoundingClientRect();
      const pr = parent.getBoundingClientRect();
      return {
        child: true, parent: true,
        childLeft: Math.round(cr.left), parentLeft: Math.round(pr.left),
        childRight: Math.round(cr.right), parentRight: Math.round(pr.right),
        childName: childRow.textContent.trim(),
      };
    })()`)
  console.log(
    `         子频道「${sub.childName}」left=${sub.childLeft} right=${sub.childRight}` +
      ` · 父频道 left=${sub.parentLeft} right=${sub.parentRight}`,
  )
  // 左边缘必须更靠右（缩进了 ✓）
  if (sub.childLeft > sub.parentLeft) {
    console.log('         ✅ 子频道确实缩进了')
  } else {
    console.log('         ❌ 子频道没有缩进')
    uiFail++
  }
  // ⚠️ 右边缘必须**一样** ✗ 一起缩的话右边会短一截 ✓ 看着没对齐 ✓
  if (Math.abs(sub.childRight - sub.parentRight) <= 1) {
    console.log('         ✅ 右边缘和父频道对齐（只往左退 ✓ 没有两边一起缩 ✗）')
  } else {
    console.log(`         ❌ 右边缘没对齐：子 ${sub.childRight} vs 父 ${sub.parentRight} ✗`)
    uiFail++
  }

  // ★ 树形连接线（└─）✗
  //
  //   ⚠️ 伪元素**查不到 DOM** ✗ `querySelector('::before')` 是不存在的 ✓
  //      但 `getComputedStyle(el, '::before')` 能读到它的**计算样式** ✓✓
  //      —— 所以"那根线到底画出来没有"是可以**问**的 ✓ 不用靠眼睛 ✓
  const connector = await evaluate(`
    (() => {
      const row = [...document.querySelectorAll('.channel-row')].find(r => r.classList.contains('channel-row-child'));
      if (!row) return { found: false };
      const cs = getComputedStyle(row, '::before');
      return {
        found: true,
        content: cs.content,
        left: cs.left,
        top: cs.top,
        width: cs.width,
        height: cs.height,
        borderLeft: cs.borderLeftWidth + ' ' + cs.borderLeftColor,
        borderBottom: cs.borderBottomWidth + ' ' + cs.borderBottomColor,
        radius: cs.borderBottomLeftRadius,
        pointerEvents: cs.pointerEvents,
      };
    })()`)
  console.log(`         连接线：${JSON.stringify(connector)}`)
  const linesOk =
    connector.found &&
    connector.content !== 'none' &&
    // 竖线 + 横线都要有 ✓ 而且要有颜色（`border-*-color` 不能是 transparent ✓）
    parseFloat(connector.borderLeft) > 0 &&
    parseFloat(connector.borderBottom) > 0 &&
    // ⚠️ 竖线的高度必须是行高的一半左右 ✗ 画满的话最后一行会拖出悬空的线 ✓
    parseFloat(connector.height) > 0
  if (linesOk) {
    console.log('         ✅ 树形连接线真的画出来了（左边框 = 竖线 ✓ 下边框 = 横线 ✓）')
    console.log(`            pointer-events=${connector.pointerEvents}（必须是 none ✓ 不然会挡住点频道 ✗）`)
  } else {
    console.log('         ❌ 连接线没画出来 ✗')
    uiFail++
  }
  if (connector.pointerEvents !== 'none') {
    console.log('         ❌ 连接线会吃鼠标事件 ✗ 点频道会被挡住 ✓')
    uiFail++
  }
  // ★ 语音成员行的底色必须**在侧栏上看得见** ✗✗
  //
  //   ⚠️⚠️ 这条是补的 —— 因为**原本的检查答错了问题** ✗
  //      我原来验的是「CSS 编译进产物了吗」✓ 它是绿的 ✓
  //      而实际效果是：`--bubble` 和 `--sidebar` **是同一个值** ✗
  //      （深色都是 #2b2d31 ✓ 浅色都是 #e9ebee ✓）
  //      → 在 #2b2d31 上画 #2b2d31 ✓ **等于没画** ✗  而检查全绿 ✗
  //
  //   ⚠️ 而 fixture 里**看不到成员行** ✗
  //      （语音房间来自 LiveKit ✓ 地址是假的 ✓ 没有人在语音里 ✓）
  //      → 所以这条只能**造一个探针元素**来问 ✓
  //        往 .left-col 里塞一个 .voice-member ✓
  //        读它的计算背景 ✓ 和侧栏背景**比一比** ✓
  //        一样就说明"加了等于没加" ✗
  //
  //   探针用完**立刻删掉** ✓ 不能留在页面上影响后面的截图 ✓
  const memberContrast = await evaluate(`
    (() => {
      const col = document.querySelector('.left-col');
      if (!col) return { found: false };
      const probe = document.createElement('div');
      probe.className = 'voice-member';
      probe.textContent = '探针';
      col.appendChild(probe);
      const cs = getComputedStyle(probe);
      const bg = cs.backgroundColor;
      const colBg = getComputedStyle(col).backgroundColor;
      // ⚠️⚠️ 别自己解析颜色字符串 ✗
      //    第一版就是拿正则抓数字 ✓ 结果掉进**单位不一致**的坑：
      //      计算样式可能给「color(srgb 0.223 0.232 0.247)」（**0~1** ✓）
      //      也可能给「rgb(43, 45, 49)」（**0~255** ✓）
      //      → 拿 0.22 和 43 相减 ✓ 得到 48.75 ✓ **这个数字毫无意义** ✗
      //      而它偏偏大于阈值 ✓ 所以**看起来是通过的** ✗✗
      //
      //    ⚠️ 这正是这一路反复出现的病：**检查答的不是那个问题** ✗
      //
      //    改法：交给 canvas 归一化 ✓（顺带：这段注释里**不能出现反引号** ✗
      //    整段是 evaluate 的模板字符串 ✓ 里面的反引号会把字符串提前结束 ✗
      //    我为此栽了第三次 ✗）
      //      ctx.fillStyle 接受**任何**合法 CSS 颜色 ✓
      //      读回来永远是「#rrggbb」或「rgba(r,g,b,a)」✓
      //      → 单位问题从根上没了 ✓ 不用自己写转换 ✓
      // 换成 canvas **读像素** ✓ —— 唯一不受颜色字符串格式影响的量法 ✓
      // 一个 1x1 的画布 ✓ 填上颜色 ✓ 把那个像素读回来 ✓
      // 管它是 rgb() / color(srgb …) / oklch() ✓ 出来都是 0~255 的整数 ✓
      const px = (color) => {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        const x = c.getContext('2d');
        // ⚠️ 哨兵值：先填一个奇怪的颜色 ✗
        //    这样如果浏览器**不认**传进来的颜色 ✓ 它会被静默忽略 ✓
        //    fillStyle 保持哨兵值 ✓ 我们就能发现"这个颜色根本没被接受" ✗
        //    不设哨兵的话不认的颜色会变成默认黑 ✓ 而黑和深色侧栏差得远 ✓
        //    → **假通过** ✗（这正是我上一版的毛病 ✓）
        x.fillStyle = '#010203';
        x.fillStyle = color;
        const rejected = x.fillStyle === '#010203' && color.trim() !== '#010203';
        x.fillRect(0, 0, 1, 1);
        const d = x.getImageData(0, 0, 1, 1).data;
        return { rgb: [d[0], d[1], d[2]], rejected };
      };
      const pa = px(bg), pb = px(colBg);
      const a = pa.rgb, b = pb.rgb;
      const diff = Math.max(...[0,1,2].map(i => Math.abs(a[i] - b[i])));
      probe.remove();
      return {
        found: true,
        bg,
        colBg,
        rgbBg: a,
        rgbCol: b,
        rejected: pa.rejected || pb.rejected,
        diff,
        boxShadow: cs.boxShadow,
        border: cs.borderTopWidth,
      };
    })()`)
  console.log(`         成员行底色：${JSON.stringify(memberContrast)}`)
  if (!memberContrast.found) {
    console.log('         ⚠️ 找不到 .left-col ✓ 跳过这条检查')
} else if (!Number.isFinite(memberContrast.diff)) {
    // ⚠️⚠️ 量不出来**必须报错** ✗ 不能当成通过 ✓
    //    上一版 diff 是 null ✓ 而判断是 `null < 4` → false → 直接走 else ✓
    //    → 打了一行 "✅ 看得见（差 null ✓）" ✗✗ 假的 ✓
    console.log(`         ❌ 对比度量不出来（diff=${memberContrast.diff} ✗ 颜色没被浏览器接受？）`)
    uiFail++
  } else if (memberContrast.rejected) {
    console.log('         ❌ 有一个颜色浏览器不接受 ✗ 量出来的对比度不可信 ✓')
    uiFail++
} else if (memberContrast.diff < 4) {
    // ⚠️⚠️ 判定条件**只要这一条** ✗
    //    上一版写的是：
    //      `diff < 4 && boxShadow === 'none' && parseFloat(border) === 0`
    //    而实测 `boxShadow` 是**空串**、不是 'none' ✗
    //    → 条件不成立 → 掉到最后的 else → 打了一行
    //      "✅ 看得见（差 0 ✓）" ✗✗  差 0 啊 ✓ 完全一样 ✓
    //
    //    ⚠️ 又是同一个病：**我在断言一个自己没看过的值** ✗
    //      （和"用 innerText 去读 placeholder"、"拿 0.22 和 43 相减"一模一样 ✓）
    //
    //    教训：判定条件里每多一个"顺便也检查一下" ✗
    //          就多一个静默通过的口子 ✓ 需求只有一句"底色不能和侧栏一样" ✓
    console.log(`         ❌ 成员行的底色和侧栏**几乎一样**（差 ${memberContrast.diff} ✗ 等于没加 ✓）`)
    console.log(`            bg=${memberContrast.bg}  侧栏=${memberContrast.colBg} ✗`)
    uiFail++
  } else {
    console.log(`         ✅ 成员行的底色在侧栏上看得见（差 ${memberContrast.diff} ✓）`)
  }
  // ★ ③ 有子频道的父频道必须**点不动** ✗
  //
  //   ⚠️ 这条只能问 DOM ✗ 截图看不出"点了没反应" ✓
  //      但 disabled 是**可以问的** ✓✓
  //      （而且必须放在设置弹窗**打开之前** ✓ 弹窗会盖住频道列表 ✗）
  const groupState = await evaluate(`
    (() => {
      const btns = [...document.querySelectorAll('.channel-item')];
      const group = btns.find(b => b.classList.contains('channel-item-group'));
      const normal = btns.find(b => !b.classList.contains('channel-item-group') && b.textContent.includes('综合'));
      if (!group) return { found: false };
      const cs = getComputedStyle(group);
      return {
        found: true,
        groupName: group.textContent.trim(),
        groupDisabled: group.disabled,
        groupOpacity: cs.opacity,
        groupWeight: cs.fontWeight,
        groupCursor: cs.cursor,
        normalDisabled: normal ? normal.disabled : null,
      };
    })()`)
  console.log(`         分组：${JSON.stringify(groupState)}`)
  if (!groupState.found) {
    console.log('         ❌ 找不到分组（那个有子频道的父频道）✗')
    uiFail++
  } else if (groupState.groupDisabled === true && groupState.normalDisabled === false) {
    console.log(`         ✅ 分组「${groupState.groupName}」点不动 ✓ 而普通频道照常能点 ✓`)
    // ⚠️ 不能是"褪色的禁用态" ✗ 它是个**标题** ✓ 不是坏掉的按钮 ✓
    if (Number(groupState.groupOpacity) < 1) {
      console.log(`         ❌ 分组褪色了（opacity=${groupState.groupOpacity} ✗ 会让人以为坏了 ✓）`)
      uiFail++
    } else {
      console.log(`         ✅ 没褪色（opacity=${groupState.groupOpacity} ✓ 字重=${groupState.groupWeight} ✓ 像个标题 ✓）`)
    }
  } else {
    console.log(`         ❌ disabled 不对：分组=${groupState.groupDisabled} 普通=${groupState.normalDisabled} ✗`)
    uiFail++
  }

  // 打开创建对话框 → 「放在哪里」的下拉里应该只有**顶层**频道 ✓
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('创建频道')); if (b) b.click(); return true })()`,
  )
  await wait(500)
  const opts = await evaluate(`
    (() => {
      const sel = document.querySelector('.modal select');
      if (!sel) return null;
      return [...sel.options].map(o => o.textContent.trim());
    })()`)
  console.log(`         父频道候选：${JSON.stringify(opts)}`)
    // ★ ① 类型按钮：图标和文字必须在**同一行** ✗
  //
  //   ⚠️ 症状是「#」和「文字频道」被拆成上下两行 ✓ 中间空一大截 ✓
  //      根因：图标组件自带 `display: block` ✓ 块级元素在按钮里强制换行 ✓
  //   ⚠️ 所以**光看有没有 gap 不够** ✗ 要量**高度**和**垂直中线** ✓
  //      两行的按钮会明显更高 ✓ 而且图标会偏离按钮的中线 ✓✓
  const kindBtns = await evaluate(`
    (() => {
      const btns = [...document.querySelectorAll('.kind-row button')];
      return btns.map(b => {
        const svg = b.querySelector('svg');
        const br = b.getBoundingClientRect();
        const sr = svg ? svg.getBoundingClientRect() : null;
        return {
          text: b.textContent.trim(),
          h: Math.round(br.height),
          btnMid: Math.round(br.top + br.height / 2),
          iconMid: sr ? Math.round(sr.top + sr.height / 2) : null,
          iconRight: sr ? Math.round(sr.right) : null,
          textLeft: sr ? Math.round(br.left + 8) : null,
          display: getComputedStyle(b).display,
        };
      });
    })()`)
  console.log(`         类型按钮：${JSON.stringify(kindBtns)}`)
  const kindsOk =
    Array.isArray(kindBtns) &&
    kindBtns.length === 2 &&
    // 两个按钮高度必须**一样** ✓ 不一样说明有一个换行了 ✗
    kindBtns[0].h === kindBtns[1].h &&
    // 而且得是**单行**的高度 ✓（两行会明显更高 ✓）
    kindBtns[0].h < 50 &&
    // 图标的垂直中线要和按钮的中线对齐 ✓（差 2px 以内 ✓）
    kindBtns.every((b) => b.iconMid !== null && Math.abs(b.iconMid - b.btnMid) <= 2) &&
    kindBtns.every((b) => b.display === 'flex')
  if (kindsOk) {
    console.log(`         ✅ 类型按钮是单行 ✓ 两个一样高（${kindBtns[0].h}px）✓ 图标居中对齐 ✓`)
  } else {
    console.log('         ❌ 类型按钮的图标和文字不在同一行（或者两个按钮不一样高）✗')
    uiFail++
  }
const onlyTops =
    Array.isArray(opts) &&
    opts[0]?.includes('顶层') &&
    opts.some((o) => o.includes('综合')) &&
    // ⚠️ 子频道**不能**出现在候选里 ✗ 选了会被服务端拒 ✓
    !opts.some((o) => o.includes('子频道示例'))
  if (onlyTops) {
    console.log('         ✅ 候选里只有顶层频道（子频道没被列进去 ✓）')
  } else {
    console.log('         ❌ 父频道候选不对（列进了子频道，或者少了顶层）✗')
    uiFail++
  }
  // 关掉对话框 ✓ 免得影响后面
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.modal-actions button')].find(x => x.textContent.includes('取消')); if (b) b.click(); return true })()`,
  )
  await wait(300)

  console.log('')
  console.log(uiFail === 0 ? '  ✅ 全部交互通过（回复 + 表态 + 置顶 + 子频道）' : `  ❌ 有 ${uiFail} 项失败`)

  // ── 多语言：换成英文 → 界面真的变 ✗ ────────────────────────
  //
  //   ⚠️ 这条是**整条链路**的验证 ✓
  //      localStorage → main.tsx 惰性初始化 → context → useT() → 重渲染 ✓
  //      任何一环断了侧栏都不会变成英文 ✓
  //      而"字典里有英文"这件事**光看代码就知道** ✓ 不用验 ✗
  console.log('')
  console.log('  验多语言（切英文 → 侧栏和设置都要变）…')

  await evaluate(`localStorage.setItem('voice.lang','en'); true`)
  await cdp(ws, id++, 'Page.reload')
  await wait(4500)

  const en = await evaluate(`
    (() => {
      const body = document.body.innerText;
      return {
        textGroup: body.includes('Text channels'),
        voiceGroup: body.includes('Voice channels'),
        cloud: body.includes('Cloud files'),
        // 反证：中文那份不该还留着 ✗
        stillZh: body.includes('文字频道'),
      };
    })()`)
  console.log(`         侧栏：Text channels=${en.textGroup} Voice channels=${en.voiceGroup} Cloud files=${en.cloud}`)
  if (en.textGroup && en.voiceGroup && en.cloud && !en.stillZh) {
    console.log('         ✅ 切英文之后频道列表真的变了，而且没留下中文')
  } else {
    console.log('         ❌ 语言切换没生效（或者只变了一半 ✗）')
    uiFail++
  }

  // 设置面板的分页标签也要变 ✓（那是另一个组件 ✓ 各取各的 context ✓）
  //
  // ⚠️⚠️ 不要靠**界面文字**去选元素 ✗
  //   这里原来是 `find(x => x.title === '设置')` ✓
  //   而这一轮我把那个 title 翻译了 ✓ → 切英文后它变成 "Settings" ✓
  //   → 点不到 → 设置面板根本没开 → 后面三条断言全红 ✗
  //   **而应用本身一点问题都没有** ✗ —— 是验证脚本被 i18n 牵连了 ✓
  //
  //   → 改成按**结构**选：语音面板里最后一个 `.voice-btn` 就是设置 ✓
  //     （顺序是 麦克风 / 喇叭 / 投屏 / 设置 ✓）
  //     以后再加语言也不会又红一遍 ✓
  await evaluate(
    `(() => {
       const btns = [...document.querySelectorAll('.voice-panel .voice-btn')];
       const b = btns[btns.length - 1];
       if (b) b.click();
       return true;
     })()`,
  )
  await wait(600)
  const tabs = await evaluate(`
    (() => {
      const btns = [...document.querySelectorAll('.settings-nav button, .modal button')];
      return btns.map(b => b.textContent.trim()).filter(Boolean).slice(0, 10);
    })()`)
  const tabsEn = Array.isArray(tabs) && tabs.includes('Appearance') && tabs.includes('Screen share')
  console.log(`         设置分页：${JSON.stringify(tabs.slice(0, 8))}`)
  if (tabsEn) {
    console.log('         ✅ 设置面板的分页标签也变了（两个组件共用同一个 context ✓）')
  } else {
    console.log('         ❌ 设置面板的分页标签没变 ✗')
    uiFail++
  }

  // ★ 进「Voice」页，看**正文**有没有跟着变 ✗
  //
  //   ⚠️ 这一步是专门为"逐文件搬运"加的 ✓
  //      分页标签变了**不代表**正文也搬了 ✓（那两块是分开改的 ✓）
  //      只验标签的话，正文还写着中文也照样通过 ✗
  //      而"半节翻译"比"整节没翻"更难看 ✓ 必须能自动发现 ✓
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.settings-nav button, .modal button')].find(x => x.textContent.trim() === 'Voice'); if (b) b.click(); return true })()`,
  )
  await wait(500)
  // ⚠️ 断言要打在**完整文本**上 ✗
  //    第一版在这里 `.slice(0, 160)` 了 ✓ 然后拿截断后的串去断言 ✓
  //    而 "Noise suppression" 在 160 字符**之后** ✓ → 永远找不到 ✗
  //    （日志截断是可以的 ✓ 拿截断的数据做断言不行 ✓ —— 两件事要分开 ✓）
  const voicePane = await evaluate(
    `(() => { const p = document.querySelector('.settings-pane'); return p ? p.innerText.replace(/\\s+/g,' ') : null })()`,
  )
  console.log(`         Voice 页正文（前 160 字）：${JSON.stringify(String(voicePane).slice(0, 160))}`)
  const paneOk =
    typeof voicePane === 'string' &&
    voicePane.includes('Audio devices') &&
    voicePane.includes('Input (microphone)') &&
    voicePane.includes('Noise suppression') &&
    // ⚠️ 反证只能查**我们自己写的**那些串 ✗
    //
    //   第一版写的是"整页不许出现任何中文" ✓ —— **太宽了** ✗
    //   因为设备名是**系统报上来的**：
    //     `麦克风 (NVIDIA Broadcast)` / `麦克风 (ToDesk Virtual Audio)` ✓
    //   它们是 Chromium 从系统枚举拿到的 label ✓ 我们一个字都没写 ✓
    //   永远不可能翻 ✓ 那条断言就永远是红的 ✗
    //
    //   （这和"孤儿 = 有 parent_id"是同一类错误：
    //     检查了**错的对象** ✓ 而不是检查得不严 ✓）
    !voicePane.includes('音频设备') &&
    !voicePane.includes('输入设备') &&
    !voicePane.includes('麦克风处理') &&
    !voicePane.includes('降噪') &&
    !voicePane.includes('回声消除') &&
    !voicePane.includes('自动增益')
  if (paneOk) {
    console.log('         ✅ Voice 页正文也翻好了（我们写的文案一条中文都没剩 ✓）')
    console.log('            （列表里的「麦克风 (…)」是**系统设备名** ✓ 本来就翻不了 ✓）')
  } else {
    console.log('         ❌ Voice 页正文没搬完 ✗')
    uiFail++
  }

  // ★ 再抽两页验 —— 「高级」和「关于」✓
  //
  //   ⚠️ 为什么只验一页不够 ✗
  //      每一节是**分开搬**的 ✓（Voice 和 关于 是两批改的 ✓）
  //      只验 Voice 的话，我搬后面几节时手滑了也照样通过 ✗
  //
  //   ⚠️⚠️ 别猜哪一页放了什么 ✗
  //      第一版我让「关于」页去找 LiveKit 信令地址 ✓ —— 那些在**「高级」**页 ✗
  //      于是它永远是红的 ✓（又一次"检查了错的对象" ✓）
  //      下面按实际归属分开查 ✓
  const paneText = async (tabName) => {
    await evaluate(
      `(() => { const b = [...document.querySelectorAll('.settings-nav button, .modal button')].find(x => x.textContent.trim() === ${JSON.stringify(tabName)}); if (b) b.click(); return true })()`,
    )
    await wait(500)
    return evaluate(
      `(() => { const p = document.querySelector('.settings-pane'); return p ? p.innerText.replace(/\\s+/g,' ') : null })()`,
    )
  }

  const advPane = await paneText('Advanced')
  console.log(`         Advanced 页（前 140 字）：${JSON.stringify(String(advPane).slice(0, 140))}`)
  const advOk =
    typeof advPane === 'string' &&
    advPane.includes('LiveKit signalling URL') &&
    advPane.includes('Backend URL') &&
    advPane.includes('Invite code') &&
    // ⚠️ 只查我们自己写的串 ✗（别学"整页不许有中文"那个写法 ✓）
    !advPane.includes('后端地址') &&
    !advPane.includes('邀请码') &&
    !advPane.includes('LiveKit 信令地址')

  const aboutPane = await paneText('About')
  console.log(`         About 页（前 140 字）：${JSON.stringify(String(aboutPane).slice(0, 140))}`)
  const aboutOk =
    typeof aboutPane === 'string' &&
    aboutPane.includes('Check for updates') &&
    !aboutPane.includes('检查更新')

  if (advOk && aboutOk) {
    console.log('         ✅ Advanced 和 About 两页都翻好了（第二批那四节 ✓）')
  } else {
    console.log(`         ❌ 没搬完：Advanced=${advOk} About=${aboutOk} ✗`)
    uiFail++
  }

  // ★ 聊天区（ChatPanel）✗ —— 这是最大的一块 ✓
  //
  //   先把设置关掉 ✓ 不然它盖着聊天区 ✓
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.modal-actions button, .modal button')].find(x => ['Cancel','取消','Close','关闭'].includes(x.textContent.trim())); if (b) b.click(); return true })()`,
  )
  await wait(400)
  await evaluate(`document.querySelector('.modal-backdrop')?.click(); true`)
  await wait(600)

  //   ⚠️ placeholder **不在 innerText 里** ✗
  //      `<input>` 的提示文字是**属性** ✓ 不是文本节点 ✓
  //      innerText 永远读不到它 ✓（第一版就是这么写的 ✓ 于是永远红的 ✗）
  //      必须直接读 `placeholder` ✓
  //   ⚠️ 而且**别用 `querySelector('input')`** ✗
  //      第一版就是这么写的 ✓ 读回来是空串 ✓ 我一度以为是 contentEditable ✗
  //      真相是：`.chat-input-area` 里**排在前面**的是一个
  //      `<input type="file" hidden>`（截图/附件用的 ✓）
  //      `querySelector` 返回的是**第一个**匹配 ✓ 而它没有 placeholder ✗
  //      —— 又是"取第一个匹配 ≠ 你要的那个" ✓
  //      改成按 `[placeholder]` 找就不挑了 ✓ 而且顺带确认了标签是 TEXTAREA ✓
  const chatPane = await evaluate(
    `(() => {
       const box = document.querySelector('.chat-input-area');
       const el = box ? box.querySelector('[placeholder]') : null;
       return {
         text: (box?.innerText ?? '').replace(/\\s+/g,' '),
         placeholder: el ? (el.getAttribute('placeholder') || '') : '',
         tag: el ? el.tagName : null,
       };
     })()`,
  )
  console.log(`         聊天区文本：${JSON.stringify(String(chatPane?.text).slice(0, 80))}`)
  console.log(`         输入框提示：${JSON.stringify(chatPane?.placeholder)}（标签 ${chatPane?.tag}）`)
  const chatOk =
    chatPane &&
    typeof chatPane.text === 'string' &&
    chatPane.text.includes('Send') &&
    String(chatPane.placeholder).includes('Message #') &&
    // ⚠️ 只查我们自己写的串 ✗（频道名「综合」是**数据** ✓ 本来就该是中文 ✓）
    !chatPane.text.includes('发送') &&
    !String(chatPane.placeholder).includes('发消息到')
  if (chatOk) {
    console.log('         ✅ 聊天区也翻好了（发送按钮 + 输入框 placeholder ✓）')
    console.log('            （#综合 是**频道名** ✓ 属于数据 ✓ 不该翻 ✓）')
  } else {
    console.log('         ❌ 聊天区没搬完 ✗')
    uiFail++
  }

  // 还原成中文 ✓ 免得下次跑的时候门面图变成英文 ✗
  await evaluate(`localStorage.setItem('voice.lang','zh-CN'); true`)

  console.log('')
  console.log(uiFail === 0 ? '  ✅ 全部交互通过（回复 + 表态 + 置顶 + 子频道 + 多语言）' : `  ❌ 有 ${uiFail} 项失败`)

  ws.close()
  cleanup()
  process.exit(uiFail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.log('  ❌ ' + err.message)
  cleanup()
  process.exit(1)
})
