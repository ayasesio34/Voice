/**
 * 「删除聊天消息」的端到端测试。
 *
 * 跑法（在 voice-server/backend 目录）：
 *     node test-delete-message.mjs
 *
 * 为什么要端到端：单测只能证明 db 层那两个函数对，
 * 而**真正容易写错的是处理里的那几条规则** ——
 *   · 普通成员删不动（权限）
 *   · 私聊不看角色，只看是不是会话成员
 *   · 删完要**广播**，不然别人那儿还挂着
 *   · 有附件的要把文件也删了，不留孤儿
 * 这些只有让两个真实客户端连上来才测得到。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 3093
const tmp = mkdtempSync(join(tmpdir(), 'voice-del-'))
const dbPath = join(tmp, 'voice.db')
const uploads = join(tmp, 'uploads')
const logPath = join(tmp, 'server.log')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * ⚠️ 断言必须**当场跑**，不能收集起来最后统一跑。
 *
 * 第一版就是收集起来最后跑的 —— 结果「被拒之后消息还在」这条
 * 是在后面的清理代码已经把它删掉之后才断言的，报了个假失败。
 * 凡是依赖"某一步当时的状态"的断言，延迟执行就失去意义了。
 */
let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (err) {
    fail++
    console.log(`  ❌ ${name}`)
    console.log(`     ${err.message}`)
  }
}

/** 把收件箱倒空 —— 上一轮测试留下的广播会污染这一轮 */
function drain(...clients) {
  for (const c of clients) c.inbox.length = 0
}

const srv = spawn(process.execPath, ['src/index.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DB_PATH: dbPath,
    UPLOADS_DIR: uploads,
    UPDATES_DIR: join(tmp, 'updates'),
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'devsecret',
    INVITE_CODE: 'test',
  },
  stdio: ['ignore', 'ignore', 'ignore'],
})

async function boot() {
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

/** 一个测试用的 WS 客户端：连上、握手、把收到的消息堆进 inbox */
function client(userId, userKey, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  const inbox = []
  const ready = new Promise((resolve) => {
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', userId, userKey, name, inviteCode: 'test' }))
    })
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      inbox.push(m)
      if (m.type === 'welcome') resolve(m)
    })
  })
  return {
    ws,
    inbox,
    ready,
    send: (o) => ws.send(JSON.stringify(o)),
    /** 等某类消息出现（最多 2 秒） */
    async take(type, timeoutMs = 2000) {
      const until = Date.now() + timeoutMs
      while (Date.now() < until) {
        const i = inbox.findIndex((m) => m.type === type)
        if (i >= 0) return inbox.splice(i, 1)[0]
        await wait(40)
      }
      return null
    },
  }
}

const ok = await boot()
console.log('\n删除消息 · 端到端测试\n')
if (!ok) {
  console.log('❌ 服务端起不来')
  process.exit(1)
}

// ── 两个客户端 ──────────────────────────────────────────────
// 第一个连上的会成为频道主（服务端就是这么定的）
const owner = client('u-owner', 'k-owner', '房主')
const member = client('u-member', 'k-member', '小弟')
const w1 = await owner.ready
const w2 = await member.ready

/** 管理员身份的客户端（owner）+ 普通成员 */
const CHANNEL = w1.channels?.[0]?.id ?? 'general'

/** 直接在库里塞一条带附件的消息，返回 id */
async function seedMessage(withAttachment) {
  const code = `
    import { openDb, insertMessage, insertFile } from './src/db.js';
    const db = openDb(${JSON.stringify(dbPath)});
    let att = null;
    if (${withAttachment}) {
      insertFile(db, { id: 'f-del', name: '图.png', size: 3, mime: 'image/png',
                       uploaderId: 'u-owner', uploaderName: '房主', scope: 'chat' });
      att = { id: 'f-del', name: '图.png', size: 3, mime: 'image/png' };
    }
    const m = insertMessage(db, { channelId: ${JSON.stringify(CHANNEL)}, authorId: 'u-owner',
                                  authorName: '房主', body: '要被删的', attachment: att });
    console.log(m.id);
    db.close();
  `
  const out = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'ignore'] })
  let buf = ''
  for await (const c of out.stdout) buf += c
  return Number(buf.trim())
}

/** 库里的消息/文件还在不在 */
async function inDb(kind, id) {
  const code = `
    import { openDb, getMessage, getFile } from './src/db.js';
    const db = openDb(${JSON.stringify(dbPath)});
    const v = ${kind === 'msg' ? `getMessage(db, ${id})` : `getFile(db, ${JSON.stringify(id)})`};
    console.log(v ? 'yes' : 'no');
    db.close();
  `
  const out = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'ignore'] })
  let buf = ''
  for await (const c of out.stdout) buf += c
  return buf.trim() === 'yes'
}

console.log(`频道: ${CHANNEL}\n`)

// ═══ 1. 普通成员删不动 ══════════════════════════════════════
{
  drain(owner, member)
  const id = await seedMessage(false)
  member.send({ type: 'deleteMessage', id })
  const err = await member.take('error')
  await check('普通成员删 → 被拒（forbidden）', () => {
    assert.ok(err, '应该收到一条 error')
    assert.equal(err.error, 'forbidden')
  })
  await check('被拒之后消息**还在**（权限没拦住就出大事了）', async () => {
    assert.equal(await inDb('msg', id), true)
  })

  // 清掉，免得影响后面
  drain(owner, member)
  owner.send({ type: 'deleteMessage', id })
  await owner.take('messageDeleted')
}

await wait(250)

// ═══ 2. 频道主能删，而且两个客户端都收到广播 ══════════════
{
  drain(owner, member)
  const id = await seedMessage(false)
  owner.send({ type: 'deleteMessage', id })
  const a = await owner.take('messageDeleted')
  const b = await member.take('messageDeleted')

  await check('频道主删 → 成功', () => assert.ok(a, '发起者应该收到广播'))
  await check('★ 别的客户端也收到 messageDeleted（这就是"别人那里也消失"）', () => {
    assert.ok(b, '没广播的话别人那儿还挂着')
    assert.equal(b.id, id)
  })
  await check('广播里带 channelId（客户端要靠它知道从哪个会话摘）', () => {
    assert.equal(a.channelId, CHANNEL)
  })
  /* ★ 这一条是**产品要求**，不是洁癖：
     别人只需要看见东西没了，**不该知道是频道主/管理员动的手**。
     所以广播里连一个"谁删的"字段都不能有 —— 不留痕迹才叫静默。 */
  await check('★ 广播里**不含**是谁删的（不留任何"有人动了手"的痕迹）', () => {
    assert.deepEqual(
      Object.keys(b).sort(),
      ['channelId', 'id', 'type'],
      '多出来的字段就可能泄露"是谁删的"'
    )
  })
  await check('库里的消息真没了', async () => {
    assert.equal(await inDb('msg', id), false)
  })
}

await wait(250)

// ═══ 3. 带附件的：文件和消息一起没 ══════════════════════════
{
  drain(owner, member)
  const id = await seedMessage(true)
  // 造一个真实的磁盘文件，验证它也被清掉
  const { mkdirSync } = await import('node:fs')
  mkdirSync(uploads, { recursive: true })
  writeFileSync(join(uploads, 'f-del'), 'abc')

  await check('（前置）消息和文件都建好了', async () => {
    assert.equal(await inDb('msg', id), true)
    assert.equal(await inDb('file', 'f-del'), true)
  })

  owner.send({ type: 'deleteMessage', id })
  await owner.take('messageDeleted')
  await wait(400)

  await check('★ 带附件的消息：文件行也删了（不留孤儿）', async () => {
    assert.equal(await inDb('file', 'f-del'), false, '附件行还在 = 磁盘上永远占着')
  })
  await check('★ 磁盘上的文件本体也删了', () => {
    assert.equal(existsSync(join(uploads, 'f-del')), false)
  })
}

// ═══ 4. 重复删 / 不存在的 id 不崩 ═══════════════════════════
{
  drain(owner, member)
  owner.send({ type: 'deleteMessage', id: 999999 })
  await wait(400)
  await check('删不存在的 id → 不报错、连接还活着', () => {
    assert.equal(owner.ws.readyState, 1, 'readyState 1 = OPEN')
    assert.equal(owner.inbox.filter((m) => m.type === 'error').length, 0, '不该回 error')
  })
}

// ═══ 收尾 ═══════════════════════════════════════════════════
console.log(`\n${'─'.repeat(52)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)

owner.ws.close()
member.ws.close()
srv.kill()
await wait(300)
try {
  rmSync(tmp, { recursive: true, force: true })
} catch {
  /* ignore */
}
process.exit(fail === 0 ? 0 : 1)
