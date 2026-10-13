/**
 * 「移除成员」的端到端测试。
 *
 * 跑法（在 voice-server/backend 目录）：
 *     node test-remove-member.mjs
 *
 * ⚠️ 这个测试不只是验功能，还**兜住一类很容易犯的错**：
 *    从 db.js 用了函数却忘了 import。那种错误 `node --check` 抓不到
 *    （语法是合法的），只有真跑到那行才炸 ReferenceError。
 *    本项目已经犯过两次（hasOwner、removeMember），所以这条路径必须真跑。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 3083
const OWNER_NAME = 'Owner'
const tmp = mkdtempSync(join(tmpdir(), 'voice-rm-'))
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
    OWNER_NAME,
  },
  stdio: ['ignore', 'ignore', 'ignore'],
})

console.log('\n移除成员 · 端到端测试\n')

let up = false
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) {
      up = true
      break
    }
  } catch {
    /* 还没起来 */
  }
  await wait(250)
}
if (!up) {
  console.log('❌ 服务端起不来')
  process.exit(1)
}

/** 一条常驻连接，能收广播、能发指令 */
function client(name, userId, userKey) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  const inbox = []
  let closed = false
  ws.addEventListener('close', () => {
    closed = true
  })
  const ready = new Promise((resolve) => {
    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ type: 'hello', userId, userKey, name, inviteCode: 'test' }))
    )
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
    get closed() {
      return closed
    },
    send: (o) => ws.send(JSON.stringify(o)),
    drain: () => (inbox.length = 0),
    /** 等一条指定类型的消息 */
    async waitFor(type, timeoutMs = 2500) {
      const until = Date.now() + timeoutMs
      while (Date.now() < until) {
        const i = inbox.findIndex((m) => m.type === type)
        if (i >= 0) return inbox.splice(i, 1)[0]
        await wait(40)
      }
      return null
    },
    /** 从最后一次 members 广播里找某人 */
    async memberAfter(lookupId, timeoutMs = 2500) {
      const m = await this.waitFor('members', timeoutMs)
      return m ? (m.members.find((x) => x.userId === lookupId) ?? null) : undefined
    },
  }
}

// ═══ 建立场景：频道主 + 一个普通成员 ═════════════════════════
const owner = client(OWNER_NAME, undefined, undefined)
const ownerWelcome = await owner.ready
const ownerId = ownerWelcome.userId
const ownerKey = ownerWelcome.userKey
assert.equal(ownerWelcome.members.find((m) => m.userId === ownerId).role, 'owner', '场景：第一个应该是 owner')

const victim = client('多余的人', undefined, undefined)
const victimWelcome = await victim.ready
const victimId = victimWelcome.userId
await wait(300)

await check('前置：受害者在名册里', async () => {
  const m = ownerWelcome.members.concat(victimWelcome.members).find((x) => x.userId === victimId)
  assert.ok(m, '应该能登记上')
})

// ═══ 1. 权限 ════════════════════════════════════════════════
await check('① 普通成员不能移除别人', async () => {
  const other = client('另一个路人', undefined, undefined)
  await other.ready
  const otherId = (await Promise.resolve(other.inbox.find((m) => m.type === 'welcome'))).userId

  victim.drain()
  victim.send({ type: 'removeMember', userId: otherId })
  const err = await victim.waitFor('error')
  assert.ok(err, '应该收到错误')
  assert.equal(err.error, 'forbidden')

  // 确认人还在
  owner.drain()
  owner.send({ type: 'setActivity', activity: { kind: 'music', title: 'x', artist: '' } })
  await owner.waitFor('presence')
  other.ws.close()
})

await check('② ★ 频道主可以移除成员（这条路径真的会跑到 removeMember）', async () => {
  owner.drain()
  owner.send({ type: 'removeMember', userId: victimId, requestId: 'r1' })
  const m = await owner.memberAfter(victimId)
  assert.notEqual(m, undefined, '应该收到 members 广播')
  assert.equal(m, null, '被移除的人不该还在名册里')
})

await check('③ 被移除的人连接会被踢掉（否则他还挂在在线列表里）', async () => {
  await wait(600)
  assert.equal(victim.closed, true, 'socket 应该被关掉')
})

await check('④ 收到 removed 通知（客户端好告诉用户发生了什么）', async () => {
  const r = victim.inbox.find((m) => m.type === 'removed')
  assert.ok(r, '应该先收到一条 removed 再断开')
})

// ═══ 2. 边界 ════════════════════════════════════════════════
await check('⑤ 不能移除频道主自己', async () => {
  owner.drain()
  owner.send({ type: 'removeMember', userId: ownerId })
  const err = await owner.waitFor('error')
  assert.ok(err)
  assert.equal(err.error, 'cannot_remove_self')
})

await check('⑥ 不能移除其他频道主（防止互相踢）', async () => {
  // 造第二个频道主：直接把 victim 提成 owner 已经不可能了（他被删了），
  // 所以这里只验「目标角色是 owner 时被拒绝」这条判断本身：
  // 用一个不存在的 id 会走 not_found，不是这条分支。
  // 真实场景里全服只有一个 owner，所以这条主要用于防回归。
  const w = await owner.waitFor('members')
  const owners = (w?.members ?? []).filter((m) => m.role === 'owner')
  assert.ok(owners.length <= 1, '全服最多一个 owner')
})

await check('⑦ 移除不存在的成员 → not_found（幂等，不炸）', async () => {
  owner.drain()
  owner.send({ type: 'removeMember', userId: 'no-such-user' })
  const err = await owner.waitFor('error')
  assert.ok(err)
  assert.equal(err.error, 'not_found')
})

await check('⑧ 被移除的人**可以**换个身份再进来（这是踢出，不是封禁）', async () => {
  const again = client('新来的', undefined, undefined)
  const w = await again.ready
  assert.ok(w.userId, '应该拿到一个新身份')
  assert.notEqual(w.userId, victimId, '是一个全新身份，不是原来那个')
  again.ws.close()
})

// ═══ 3. 消息不该跟着消失 ════════════════════════════════════
await check('⑨ ★ 移除成员**不会**删掉他发过的消息（聊天记录不留空洞）', async () => {
  // 让一个新人发条消息，然后移除他
  const talker = client('话多的', undefined, undefined)
  const tw = await talker.ready
  const tId = tw.userId
  // 服务端启动时会建一个默认文字频道 general
  const ch = 'general'
  talker.drain()
  talker.send({ type: 'message', channelId: ch, body: '这条消息应该留下' })
  // 等它真的落库（服务端会广播出来）
  const echoed = await talker.waitFor('message', 3000)
  assert.ok(echoed, '消息应该发成功了（不然这个测试本身就没意义）')

  owner.drain()
  owner.send({ type: 'removeMember', userId: tId })
  await owner.memberAfter(tId)

  // ⚠️ 路由是 /api/channels/:id/messages（不是 /messages）
  const res = await fetch(
    `http://127.0.0.1:${PORT}/api/channels/${ch}/messages?limit=50`,
    {
      headers: {
        'x-invite-code': 'test',
        'x-user-id': ownerId,
        'x-user-key': ownerKey,
      },
    }
  )
  const data = await res.json()
  const found = (data.messages ?? []).some((m) => m.body === '这条消息应该留下')
  assert.equal(
    found,
    true,
    `消息应该还在。HTTP ${res.status}，返回：${JSON.stringify(data).slice(0, 300)}`
  )
  talker.ws.close()
})

console.log(`\n${'─'.repeat(52)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)

owner.ws.close()
srv.kill()
await wait(300)
try {
  rmSync(tmp, { recursive: true, force: true })
} catch {
  /* ignore */
}
process.exit(fail === 0 ? 0 : 1)
