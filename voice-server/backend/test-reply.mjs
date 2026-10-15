/**
 * 「消息引用回复」的端到端测试。
 *
 * 跑法（在 voice-server/backend 目录）：node test-reply.mjs
 *
 * ── 为什么必须端到端 ✗ ──────────────────────────────────────
 *   db 层那两处改动很直白 ✓ 真正容易写错的是**处理里的一条规则**：
 *     ★ 被引用的消息**必须和当前频道一致** ✗
 *
 *   不校验的话这是一条真实的**信息泄露路径** ✗：
 *     任何人在**公开频道**里发一条 replyTo = 某条**私聊**消息的 id ✓
 *     服务端把摘要一填 ✓ 私聊内容就出现在公开频道里了 ✓
 *
 *   这种洞单测测不出来 ✓ 必须让两个真客户端连上来、真的发一遍 ✓
 *
 * ── 还验什么 ✓ ──────────────────────────────────────────────
 *   · 正常回复：reply_to 存住、reply_preview 带上原作者的昵称和正文
 *   · 跨频道引用 → **被静默忽略**（不是报错 ✓ 报错客户端还得处理新错误码 ✓）
 *   · 引用不存在的消息 → 同样被忽略
 *   · 原消息**被删之后** → reply_to 还在，但 reply_preview 变 null
 *     （界面显示"原消息不存在" ✓ 而不是崩掉或显示旧的副本 ✓）
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 3094
const tmp = mkdtempSync(join(tmpdir(), 'voice-reply-'))
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
    /** 等一条满足条件的消息 */
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
  const wA = await A.ready
  const wB = await B.ready
  void wB

  // 先连的那个人拿频道主（OWNER_NAME 没配时的"先到先得"）✓ 所以 A 能建频道 ✓
  const text = wA.channels.find((c) => c.kind === 'text')
  assert.ok(text, '默认应该有一个文字频道')

  console.log('')
  console.log('  准备一个第二个频道（用来验跨频道引用被拒）…')
  A.send({ type: 'createChannel', name: '回复测试频道', kind: 'text', requestId: 'c1' })
  const chMsg = await A.wait((m) => m.type === 'channels')
  const text2 = chMsg?.channels?.find((c) => c.name === '回复测试频道')
  assert.ok(text2, '新频道应该建出来了')

  // ── ① 正常回复 ────────────────────────────────────────────
  console.log('')
  await check('① 正常回复：reply_to 存住、预览带上原作者的昵称和正文', async () => {
    A.drain(); B.drain()
    A.send({ type: 'message', channelId: text.id, body: '这是原消息' })
    const m1 = await A.wait((m) => m.type === 'message' && m.message.body === '这是原消息')
    assert.ok(m1, 'A 应该收到自己那条消息的广播')

    B.send({ type: 'message', channelId: text.id, body: '这是回复', replyTo: m1.message.id })
    const m2 = await B.wait((m) => m.type === 'message' && m.message.body === '这是回复')
    assert.ok(m2, 'B 应该收到自己那条回复的广播')
    assert.equal(m2.message.reply_to, m1.message.id, 'reply_to 应该存住')
    assert.ok(m2.message.reply_preview, '应该带上被引用消息的摘要')
    assert.equal(m2.message.reply_preview.author_name, '甲', '摘要里应该是原作者')
    assert.equal(m2.message.reply_preview.body, '这是原消息', '摘要里应该是原文')
    // 不回复的消息不该有这个字段
    assert.ok(!m1.message.reply_to, '没回复的消息 reply_to 应该是空的')
  })

  // ── ② ★ 私聊消息不能被引用到公开频道 ──────────────────────
  //
  // 这条是整个功能里**最重要**的一条 ✗ 不通过就是信息泄露 ✓
  console.log('')
  await check('② ★ 私聊消息不能被引用到公开频道（防泄露 ✗）', async () => {
    A.drain(); B.drain()
    A.send({ type: 'openDm', userId: 'u-b', requestId: 'dm1' })
    const dm = await A.wait((m) => m.type === 'dm')
    assert.ok(dm, '应该拿到私聊会话')
    const dmId = dm.dm.id

    A.send({ type: 'message', channelId: dmId, body: '私聊里的秘密' })
    const secret = await A.wait((m) => m.type === 'message' && m.message.body === '私聊里的秘密')
    assert.ok(secret, '私聊消息应该发出去')

    // B 在**公开频道**里尝试引用那条私聊消息
    B.drain()
    B.send({ type: 'message', channelId: text.id, body: '试图引用私聊', replyTo: secret.message.id })
    const leak = await B.wait((m) => m.type === 'message' && m.message.body === '试图引用私聊')
    assert.ok(leak, '消息本身应该照常发出去（只是引用被忽略）')
    assert.ok(
      leak.message.reply_to == null,
      `★ 跨频道引用必须被忽略，实际 reply_to=${leak.message.reply_to}`,
    )
    assert.ok(
      !leak.message.reply_preview,
      `★ 绝不能把私聊内容塞进摘要，实际=${JSON.stringify(leak.message.reply_preview)}`,
    )
  })

  // ── ③ 第二个频道也不能引用 ────────────────────────────────
  await check('③ 另一个频道里的普通消息也不能跨频道引用', async () => {
    A.drain(); B.drain()
    A.send({ type: 'message', channelId: text2.id, body: '另一个频道的消息' })
    const other = await A.wait((m) => m.type === 'message' && m.message.body === '另一个频道的消息')
    assert.ok(other, '另一个频道的消息应该发出去')

    B.drain()
    B.send({ type: 'message', channelId: text.id, body: '跨频道引用试试', replyTo: other.message.id })
    const r = await B.wait((m) => m.type === 'message' && m.message.body === '跨频道引用试试')
    assert.ok(r, '消息应该发出去')
    assert.ok(r.message.reply_to == null, `跨频道引用要忽略，实际=${r.message.reply_to}`)
  })

  // ── ④ 引用不存在的消息 ────────────────────────────────────
  await check('④ 引用一条不存在的消息 → 忽略，不报错', async () => {
    B.drain()
    B.send({ type: 'message', channelId: text.id, body: '引用不存在', replyTo: 99999999 })
    const r = await B.wait((m) => m.type === 'message' && m.message.body === '引用不存在')
    assert.ok(r, '消息应该照常发出去')
    assert.ok(r.message.reply_to == null, `应该忽略，实际=${r.message.reply_to}`)
    // 同时不该冒出 error
    assert.ok(!B.inbox.some((m) => m.type === 'error'), '不该报错')
  })

  // ── ⑤ 原消息被删之后，预览应该变空 ────────────────────────
  await check('⑤ 原消息被删之后，历史里的 reply_preview 变 null（而 reply_to 还在）', async () => {
    A.drain(); B.drain()
    A.send({ type: 'message', channelId: text.id, body: '这条待会儿会被删' })
    const doomed = await A.wait((m) => m.type === 'message' && m.message.body === '这条待会儿会被删')
    assert.ok(doomed, '原消息应该发出去')

    B.send({ type: 'message', channelId: text.id, body: '回复一条将被删的', replyTo: doomed.message.id })
    const rep = await B.wait((m) => m.type === 'message' && m.message.body === '回复一条将被删的')
    assert.ok(rep?.message.reply_preview, '删之前摘要应该在')

    // 频道主删掉原消息
    A.send({ type: 'deleteMessage', id: doomed.message.id, requestId: 'd1' })
    await A.wait((m) => m.type === 'messageDeleted')
    await wait(300)

    // 走**历史接口**再看一遍 —— 这条路径用的是 listMessages ✓
    const res = await fetch(
      `http://127.0.0.1:${PORT}/api/channels/${encodeURIComponent(text.id)}/messages?limit=50`,
      { headers: { 'x-invite-code': 'test', 'x-user-id': 'u-b' } },
    )
    assert.equal(res.status, 200, `历史接口应该 200，实际 ${res.status}`)
    const data = await res.json()
    const found = (data.messages ?? data).find((m) => m.body === '回复一条将被删的')
    assert.ok(found, '历史里应该还有那条回复')
    assert.ok(found.reply_to != null, 'reply_to 应该还留着（它只是个 id ✓ 不存副本）')
    assert.equal(found.reply_preview, null, '原消息没了，摘要应该是 null')
  })

  console.log('')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  console.log('')

  try { A.ws.close(); B.ws.close() } catch { /* ignore */ }
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
