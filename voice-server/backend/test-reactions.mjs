/**
 * 「消息 emoji 表态」的端到端测试。
 *
 * 跑法（在 voice-server/backend 目录）：node test-reactions.mjs
 *
 * ── 为什么必须端到端 ✗ ──────────────────────────────────────
 *   真正容易写错的不是"加一条记录" ✓ 而是这三件事：
 *     ★ 私聊消息的表态**不能广播给非会话成员** ✗
 *       不校验的话，任何人都能拿一条私聊消息的 id 发 react ✓
 *       服务端照常广播 ✓ 广播里带着**参与者昵称** ✓
 *       于是公开频道里每个人都能看到"某条你不认识的消息上有谁谁谁" ✓
 *       —— 和 replyTo 那条是**同一种疏忽** ✓
 *     · 再点一次要**取消**（不是又加一条 ✓）
 *     · 消息被删之后表态要**跟着走**（不然表会越积越大 ✓）
 *
 * ── 级联那一条怎么验 ✓ ──────────────────────────────────────
 *   界面层面看不出来（消息都没了 ✓ 谁会去看它的表态 ✓）
 *   所以直接**开库数行** ✓ —— 这是唯一能真正证明它没留孤儿的方法 ✓
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 3092
const tmp = mkdtempSync(join(tmpdir(), 'voice-react-'))
const dbPath = join(tmp, 'voice.db')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

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

const srv = spawn(process.execPath, ['src/index.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DB_PATH: dbPath,
    UPLOADS_DIR: join(tmp, 'uploads'),
    UPDATES_DIR: join(tmp, 'updates'),
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'devsecret',
    INVITE_CODE: 'test',
  },
  stdio: ['ignore', 'ignore', 'ignore'],
})

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
    async wait(pred, ms = 3000) {
      const t0 = Date.now()
      for (;;) {
        const hit = inbox.find(pred)
        if (hit) return hit
        if (Date.now() - t0 > ms) return null
        await wait(30)
      }
    },
    drain() {
      inbox.length = 0
    },
  }
}

async function main() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break
    } catch {
      /* 还没起来 */
    }
    await wait(250)
  }

  const A = client('u-a', 'ka', '甲')
  const B = client('u-b', 'kb', '乙')
  const C = client('u-c', 'kc', '丙') // 用来验"私聊表态不会漏给他" ✗
  const wA = await A.ready
  await B.ready
  await C.ready

  const text = wA.channels.find((c) => c.kind === 'text')
  assert.ok(text, '默认应该有一个文字频道')

  // 准备一条消息
  A.send({ type: 'message', channelId: text.id, body: '大家看这条' })
  const m = await A.wait((x) => x.type === 'message' && x.message.body === '大家看这条')
  assert.ok(m, '消息应该发出去')
  const mid = m.message.id

  console.log('')

  // ── ① 基本表态 ────────────────────────────────────────────
  await check('① 表一条 👍 → 广播里带上是谁点的（id + 名字）', async () => {
    A.drain(); B.drain()
    B.send({ type: 'react', messageId: mid, emoji: '👍' })
    const r = await B.wait((x) => x.type === 'reactions' && x.messageId === mid)
    assert.ok(r, '应该收到 reactions 广播')
    assert.equal(r.reactions.length, 1, '应该只有一个 emoji')
    assert.equal(r.reactions[0].emoji, '👍')
    assert.equal(r.reactions[0].users.length, 1, '应该有一个人')
    assert.equal(r.reactions[0].users[0].id, 'u-b', 'id 用于客户端判断"我在不在里面"')
    assert.equal(r.reactions[0].users[0].name, '乙', '名字用于悬停提示')
    // 别人也要收到 ✓
    const ra = await A.wait((x) => x.type === 'reactions' && x.messageId === mid)
    assert.ok(ra, '其他人也应该收到这条广播')
  })

  // ── ② 再点一次取消 ────────────────────────────────────────
  await check('② 同一个人再点同一个 emoji → 取消（不是又加一条）', async () => {
    B.drain()
    B.send({ type: 'react', messageId: mid, emoji: '👍' })
    const r = await B.wait((x) => x.type === 'reactions' && x.messageId === mid)
    assert.ok(r, '应该收到广播')
    assert.equal(r.reactions.length, 0, `取消之后应该空了，实际=${JSON.stringify(r.reactions)}`)
  })

  // ── ③ 一个人可以点多个不同的 emoji ────────────────────────
  await check('③ 一个人可以对同一条消息点多个不同的 emoji', async () => {
    B.drain()
    B.send({ type: 'react', messageId: mid, emoji: '👍' })
    await B.wait((x) => x.type === 'reactions' && x.reactions.length === 1)
    B.send({ type: 'react', messageId: mid, emoji: '🎉' })
    const r = await B.wait((x) => x.type === 'reactions' && x.reactions.length === 2)
    assert.ok(r, '应该有两个 emoji')
    // ⚠️ 两边都排序 ✗
    //    第一版只排了实际值、期望值写死 ['👍','🎉'] ✓
    //    而 sort() 是按 **UTF-16 码位**排的：🎉(U+1F389) < 👍(U+1F44D) ✓
    //    于是实际排出来是 ['🎉','👍'] ✓ 断言失败 ✓
    //    —— 那次是**测试的期望写错了**，代码是对的 ✓
    //    两边都排一次就没有这个假设了 ✓
    const emojis = r.reactions.map((x) => x.emoji).sort()
    assert.deepEqual(emojis, ['👍', '🎉'].sort())
  })

  // ── ④ 两个人点同一个 → 合并成一项、人数 2 ─────────────────
  await check('④ 两个人点同一个 emoji → 合并成一项，users 有两个', async () => {
    A.drain(); B.drain()
    A.send({ type: 'react', messageId: mid, emoji: '👍' })
    const r = await A.wait((x) => x.type === 'reactions' && x.messageId === mid)
    assert.ok(r, '应该收到广播')
    const like = r.reactions.find((x) => x.emoji === '👍')
    assert.ok(like, '👍 应该还在')
    assert.equal(like.users.length, 2, `👍 应该有两个人，实际=${JSON.stringify(like.users)}`)
    const ids = like.users.map((u) => u.id).sort()
    assert.deepEqual(ids, ['u-a', 'u-b'])
  })

  // ── ⑤ 人多的排前面 ────────────────────────────────────────
  await check('⑤ 排序：人数多的排前面（一眼就能点到常用的那个）', async () => {
    const r = await A.wait((x) => x.type === 'reactions' && x.messageId === mid)
    assert.ok(r)
    assert.equal(r.reactions[0].emoji, '👍', `👍 有 2 人应该排第一，实际=${r.reactions[0].emoji}`)
  })

  // ── ⑥ ★ 私聊表态不能漏给非会话成员 ────────────────────────
  //
  // 第二条泄露路径 ✗ 和 replyTo 那条是同一类疏忽 ✓
  console.log('')
  await check('⑥ ★ 私聊消息的表态不能广播给非会话成员（防泄露 ✗）', async () => {
    A.drain(); B.drain(); C.drain()

    A.send({ type: 'openDm', userId: 'u-b', requestId: 'dm1' })
    const dm = await A.wait((x) => x.type === 'dm')
    assert.ok(dm, '应该拿到私聊会话')
    const dmId = dm.dm.id

    A.send({ type: 'message', channelId: dmId, body: '私聊里的悄悄话' })
    const secret = await A.wait((x) => x.type === 'message' && x.message.body === '私聊里的悄悄话')
    assert.ok(secret, '私聊消息应该发出去')

    // 丙**不在**这个私聊里 ✓ 他强行对那条消息表态 ✗
    C.drain(); A.drain(); B.drain()
    C.send({ type: 'react', messageId: secret.message.id, emoji: '👍' })
    await wait(700)

    const leakedToA = A.inbox.some((x) => x.type === 'reactions' && x.messageId === secret.message.id)
    const leakedToB = B.inbox.some((x) => x.type === 'reactions' && x.messageId === secret.message.id)
    assert.ok(!leakedToA, '★ 会话成员不该看到一个外人点的表态 ✗')
    assert.ok(!leakedToB, '★ 会话成员不该看到一个外人点的表态 ✗')
    assert.ok(
      C.inbox.some((x) => x.type === 'error'),
      '丙应该收到 forbidden，而不是静默成功',
    )

    // 顺带确认他确实**没加进去** ✓（不是"加了但没广播"✗ 那就是脏数据 ✓）
    const raw = new DatabaseSync(dbPath)
    const row = raw
      .prepare("SELECT 1 FROM reactions WHERE message_id = ? AND user_id = 'u-c'")
      .get(secret.message.id)
    raw.close()
    assert.ok(!row, '★ 丙的那条表态根本不该写进库 ✗')
  })

  // ── ⑦ 表态一条不存在的消息 ────────────────────────────────
  await check('⑦ 表态一条不存在的消息 → 静默忽略，不报错', async () => {
    B.drain()
    B.send({ type: 'react', messageId: 99999999, emoji: '👍' })
    await wait(500)
    assert.ok(
      !B.inbox.some((x) => x.type === 'error'),
      '消息不存在是并发下的常态（刚被删 ✓）不该报错',
    )
  })

  // ── ⑧ 消息被删 → 表态级联删掉（直接开库数行 ✓）──────────
  await check('⑧ 消息被删之后，它的表态在库里也**跟着没了**（不留孤儿 ✓）', async () => {
    A.drain()
    A.send({ type: 'message', channelId: text.id, body: '这条马上删' })
    const doomed = await A.wait((x) => x.type === 'message' && x.message.body === '这条马上删')
    assert.ok(doomed)
    const dId = doomed.message.id

    A.send({ type: 'react', messageId: dId, emoji: '🎉' })
    await A.wait((x) => x.type === 'reactions' && x.messageId === dId)
    B.send({ type: 'react', messageId: dId, emoji: '🎉' })
    await wait(400)

    // 删之前应该有两行 ✓ 先确认这一点，否则下面的断言可能是"本来就 0 行"✓
    let raw = new DatabaseSync(dbPath)
    const before = raw.prepare('SELECT COUNT(*) AS c FROM reactions WHERE message_id = ?').get(dId).c
    raw.close()
    assert.equal(Number(before), 2, `删之前应该有 2 行，实际=${before}`)

    A.send({ type: 'deleteMessage', id: dId, requestId: 'd1' })
    await A.wait((x) => x.type === 'messageDeleted')
    await wait(400)

    raw = new DatabaseSync(dbPath)
    const after = raw.prepare('SELECT COUNT(*) AS c FROM reactions WHERE message_id = ?').get(dId).c
    raw.close()
    assert.equal(Number(after), 0, `★ 消息删了表态就该级联删掉，实际还剩 ${after} 行 ✗`)
  })

  console.log('')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  console.log('')

  try { A.ws.close(); B.ws.close(); C.ws.close() } catch { /* ignore */ }
  srv.kill()
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.log('  ❌ ' + err.message)
  try { srv.kill() } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(1)
})
