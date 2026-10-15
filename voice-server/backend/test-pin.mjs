/**
 * 「消息置顶」的端到端测试。
 *
 * 跑法（在 voice-server/backend 目录）：node test-pin.mjs
 *
 * ── 为什么必须端到端 ✗ ──────────────────────────────────────
 *   真正容易写错的不是"更新一列" ✓ 而是这几件事：
 *     ★ 私聊的**置顶列表接口**不能给非会话成员读 ✗
 *       置顶的往往正是"最重要、最不想外传"的消息 ✓
 *       漏了这条，比漏掉读历史的鉴权后果还严重 ✓
 *     ★ 列表顺序要按**置顶时间**倒序，不是按消息 id ✗
 *       按 id 排的话，新置顶一条三个月前的消息会掉到列表最底下 ✓
 *       用户根本找不到 ✓ —— 而这一点只有"**倒着**置顶两条"才测得出来 ✓
 *     · 再置顶一次要**取消**（不是又加一条 ✓）
 *     · 到上限（50）时要**明确报错** ✓ 不能"点了没反应" ✗
 *     · 消息被删之后要自动从列表里消失 ✓
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 3091
const tmp = mkdtempSync(join(tmpdir(), 'voice-pin-'))
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
    DB_PATH: join(tmp, 'voice.db'),
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

/** 带身份头去读置顶列表（照抄历史接口的鉴权方式 ✓） */
async function fetchPinned(channelId, userId, userKey) {
  const res = await fetch(
    `http://127.0.0.1:${PORT}/api/channels/${encodeURIComponent(channelId)}/pinned`,
    {
      headers: {
        'x-invite-code': 'test',
        'x-user-id': userId,
        'x-user-key': userKey,
      },
    },
  )
  return { status: res.status, body: await res.json().catch(() => null) }
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
  const C = client('u-c', 'kc', '丙')
  const wA = await A.ready
  await B.ready
  await C.ready

  const text = wA.channels.find((c) => c.kind === 'text')
  assert.ok(text, '默认应该有一个文字频道')

  console.log('')

  // ── ① 基本置顶 ────────────────────────────────────────────
  await check('① 置顶一条 → 广播带时间戳；置顶列表里能读到它', async () => {
    A.drain()
    A.send({ type: 'message', channelId: text.id, body: '这条要置顶' })
    const m = await A.wait((x) => x.type === 'message' && x.message.body === '这条要置顶')
    assert.ok(m, '消息应该发出去')

    A.drain()
    A.send({ type: 'pin', messageId: m.message.id })
    const ev = await A.wait((x) => x.type === 'pinned' && x.messageId === m.message.id)
    assert.ok(ev, '应该收到 pinned 广播')
    assert.ok(typeof ev.pinnedAt === 'number', `pinnedAt 应该是时间戳，实际=${ev.pinnedAt}`)

    const { status, body } = await fetchPinned(text.id, 'u-a', 'ka')
    assert.equal(status, 200, `置顶接口应该 200，实际 ${status}`)
    assert.equal(body.messages.length, 1, '列表里应该只有这一条')
    assert.equal(body.messages[0].body, '这条要置顶')
    assert.ok(body.messages[0].pinned_at, '消息上应该带 pinned_at')
  })

  // ── ② 再置顶一次 = 取消 ───────────────────────────────────
  await check('② 同一条再置顶一次 → 取消（pinnedAt 为 null，列表清空）', async () => {
    const { body: first } = await fetchPinned(text.id, 'u-a', 'ka')
    const id = first.messages[0].id

    A.drain()
    A.send({ type: 'pin', messageId: id })
    const ev = await A.wait((x) => x.type === 'pinned' && x.messageId === id)
    assert.ok(ev, '应该收到 pinned 广播')
    assert.equal(ev.pinnedAt, null, `取消时 pinnedAt 应该是 null，实际=${ev.pinnedAt}`)

    const { body } = await fetchPinned(text.id, 'u-a', 'ka')
    assert.equal(body.messages.length, 0, '取消之后列表应该空了')
  })

  // ── ③ ★ 顺序按"置顶时间"倒序，不是按消息 id ───────────────
  //
  // ⚠️ 这条**必须倒着置顶**才测得出来 ✗
  //    顺着一遍的话，按 id 排和按时间排的结果**一模一样** ✓ 测了等于没测 ✓
  await check('③ ★ 后置顶的排前面（哪怕它的消息 id 更小 ✗）', async () => {
    A.drain()
    A.send({ type: 'message', channelId: text.id, body: '较早的消息' })
    const old1 = await A.wait((x) => x.type === 'message' && x.message.body === '较早的消息')
    A.drain()
    A.send({ type: 'message', channelId: text.id, body: '较晚的消息' })
    const new1 = await A.wait((x) => x.type === 'message' && x.message.body === '较晚的消息')
    assert.ok(old1 && new1, '两条消息都要发出去')
    assert.ok(new1.message.id > old1.message.id, '第二条的 id 应该更大')

    // **先**置顶新的 ✓ **后**置顶旧的 ✗
    A.send({ type: 'pin', messageId: new1.message.id })
    await A.wait((x) => x.type === 'pinned' && x.messageId === new1.message.id)
    await wait(50)
    A.send({ type: 'pin', messageId: old1.message.id })
    await A.wait((x) => x.type === 'pinned' && x.messageId === old1.message.id)
    await wait(150)

    const { body } = await fetchPinned(text.id, 'u-a', 'ka')
    assert.equal(body.messages.length, 2, '应该有两条置顶')
    assert.equal(
      body.messages[0].body,
      '较早的消息',
      `★ 最后置顶的应该排第一（按 pinned_at 排 ✓）。实际第一是「${body.messages[0].body}」` +
        ` —— 如果是「较晚的消息」说明排的是消息 id ✗`,
    )
  })

  // ── ④ 置顶列表里也带引用摘要和表态 ────────────────────────
  await check('④ 置顶列表里的消息和聊天里一样：带引用摘要和表态', async () => {
    A.drain(); B.drain()
    A.send({ type: 'message', channelId: text.id, body: '被引用的原文' })
    const src = await A.wait((x) => x.type === 'message' && x.message.body === '被引用的原文')
    B.send({
      type: 'message', channelId: text.id, body: '引用了原文的回复', replyTo: src.message.id,
    })
    const rep = await B.wait((x) => x.type === 'message' && x.message.body === '引用了原文的回复')
    assert.ok(rep?.message.reply_preview, '回复应该带摘要')

    B.send({ type: 'react', messageId: rep.message.id, emoji: '📌' })
    await B.wait((x) => x.type === 'reactions' && x.messageId === rep.message.id)

    B.send({ type: 'pin', messageId: rep.message.id })
    await B.wait((x) => x.type === 'pinned' && x.messageId === rep.message.id)
    await wait(150)

    const { body } = await fetchPinned(text.id, 'u-a', 'ka')
    const found = body.messages.find((m) => m.id === rep.message.id)
    assert.ok(found, '那条回复应该出现在置顶列表里')
    assert.ok(found.reply_preview, '★ 置顶列表里也该有引用摘要（不然和聊天里长得不一样 ✗）')
    assert.equal(found.reply_preview.body, '被引用的原文')
    assert.ok(found.reactions?.length, '★ 置顶列表里也该有表态')
  })

  // ── ⑤ 消息被删 → 自动从置顶列表消失 ───────────────────────
  await check('⑤ 置顶的消息被删之后，自动从列表里消失', async () => {
    const before = (await fetchPinned(text.id, 'u-a', 'ka')).body.messages.length
    assert.ok(before > 0, '删之前应该有置顶')

    const victim = (await fetchPinned(text.id, 'u-a', 'ka')).body.messages[0]
    A.drain()
    A.send({ type: 'deleteMessage', id: victim.id, requestId: 'd1' })
    await A.wait((x) => x.type === 'messageDeleted')
    await wait(200)

    const after = (await fetchPinned(text.id, 'u-a', 'ka')).body.messages
    assert.equal(after.length, before - 1, `删掉一条置顶之后应该少一条，实际 ${before} → ${after.length}`)
    assert.ok(!after.some((m) => m.id === victim.id), '被删的那条不该还在列表里')
  })

  // ── ⑥ ★ 上限 50 ───────────────────────────────────────────
  await check('⑥ ★ 到 50 条上限时明确报错（不能"点了没反应" ✗）', async () => {
    A.drain()
    // 清掉现有的置顶，从零开始数 ✓
    for (const m of (await fetchPinned(text.id, 'u-a', 'ka')).body.messages) {
      A.send({ type: 'pin', messageId: m.id })
      await wait(20)
    }
    await wait(300)

    // 灌到刚好 50 条
    const ids = []
    for (let i = 0; i < 50; i++) {
      A.drain()
      A.send({ type: 'message', channelId: text.id, body: `灌水 ${i}` })
      const m = await A.wait((x) => x.type === 'message' && x.message.body === `灌水 ${i}`)
      ids.push(m.message.id)
      A.send({ type: 'pin', messageId: m.message.id })
      await wait(25)
    }
    await wait(400)

    const at50 = (await fetchPinned(text.id, 'u-a', 'ka')).body.messages.length
    assert.equal(at50, 50, `应该刚好 50 条，实际 ${at50}`)

    // 第 51 条必须**明确报错** ✓
    A.drain()
    A.send({ type: 'message', channelId: text.id, body: '第 51 条' })
    const extra = await A.wait((x) => x.type === 'message' && x.message.body === '第 51 条')
    A.drain()
    A.send({ type: 'pin', messageId: extra.message.id })
    const err = await A.wait((x) => x.type === 'error')
    assert.ok(err, '★ 超上限时必须有 error 回执 ✗ 不然用户只看到"点了没反应" ✗')
    assert.equal(err.error, 'pin_limit', `错误码应该是 pin_limit，实际=${err.error}`)

    const still = (await fetchPinned(text.id, 'u-a', 'ka')).body.messages.length
    assert.equal(still, 50, `超上限的那条不该被加进去，实际 ${still}`)

    // 已经置顶的可以正常取消 ✓（上限只挡"加" ✗ 不挡"减" ✓）
    A.drain()
    A.send({ type: 'pin', messageId: ids[0] })
    const un = await A.wait((x) => x.type === 'pinned' && x.messageId === ids[0])
    assert.ok(un, '到上限之后仍然要能取消置顶')
    assert.equal(un.pinnedAt, null)
  })

  // ── ⑦ ★ 私聊的置顶列表不能给非会话成员读 ──────────────────
  console.log('')
  await check('⑦ ★ 私聊的置顶列表：非会话成员读到 403（防泄露 ✗）', async () => {
    A.drain(); B.drain(); C.drain()
    A.send({ type: 'openDm', userId: 'u-b', requestId: 'dm1' })
    const dm = await A.wait((x) => x.type === 'dm')
    assert.ok(dm, '应该拿到私聊会话')
    const dmId = dm.dm.id

    A.send({ type: 'message', channelId: dmId, body: '私聊里要置顶的悄悄话' })
    const secret = await A.wait((x) => x.type === 'message' && x.message.body === '私聊里要置顶的悄悄话')
    A.send({ type: 'pin', messageId: secret.message.id })
    await A.wait((x) => x.type === 'pinned' && x.messageId === secret.message.id)

    // 会话成员读得到 ✓
    const okRead = await fetchPinned(dmId, 'u-a', 'ka')
    assert.equal(okRead.status, 200, `甲应该读得到，实际 ${okRead.status}`)
    assert.equal(okRead.body.messages.length, 1)
    assert.equal(okRead.body.messages[0].body, '私聊里要置顶的悄悄话')

    // ⚠️ 丙**不在**这个私聊里 ✗ 必须被挡住 ✓
    const denyRead = await fetchPinned(dmId, 'u-c', 'kc')
    assert.equal(
      denyRead.status,
      403,
      `★ 丙不该读得到私聊的置顶，实际状态码 ${denyRead.status} ✗`,
    )
  })

  // ── ⑧ ★ 非会话成员不能置顶私聊消息 ────────────────────────
  await check('⑧ ★ 非会话成员不能置顶私聊消息', async () => {
    // 先拿到那条私聊消息的 id
    A.drain()
    A.send({ type: 'openDm', userId: 'u-b', requestId: 'dm2' })
    const dm = await A.wait((x) => x.type === 'dm')
    const dmId = dm.dm.id
    const listed = await fetchPinned(dmId, 'u-a', 'ka')
    const targetId = listed.body.messages[0].id

    // 丙强行置顶 ✗
    C.drain()
    C.send({ type: 'pin', messageId: targetId })
    const err = await C.wait((x) => x.type === 'error')
    assert.ok(err, '★ 丙应该被拒 ✗')
    assert.equal(err.error, 'forbidden')

    // 而且**状态不能被改** ✓ 甲那边看还是置顶的 ✓
    const after = await fetchPinned(dmId, 'u-a', 'ka')
    assert.equal(after.body.messages.length, 1, '★ 丙那次操作不该真的取消掉甲的置顶 ✗')
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
