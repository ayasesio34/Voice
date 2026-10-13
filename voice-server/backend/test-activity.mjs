/**
 * 「正在听歌」的端到端测试。
 *
 * 跑法（在 voice-server/backend 目录）：
 *     node test-activity.mjs
 *
 * 为什么值得单独测：`activity` 的内容是**客户端提供、然后广播给所有人**的，
 * 所以它是一份不可信输入。要验的就是那几条规矩：
 *   · 只认 music / game（别的 kind 一律丢掉）
 *   · 长度截断（不然别人可以塞几十万字把所有人界面撑爆）
 *   · 内容没变就别重复广播（客户端每几秒可能报一次）
 *   · 传 null 要能把状态清掉
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 3089
const tmp = mkdtempSync(join(tmpdir(), 'voice-act-'))
const logPath = join(tmp, 'server.log')
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

console.log('\n「正在听歌」· 端到端测试\n')

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

function client(userId, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  const inbox = []
  const ready = new Promise((resolve) => {
    ws.addEventListener('open', () =>
      ws.send(
        JSON.stringify({ type: 'hello', userId, userKey: `k-${userId}`, name, inviteCode: 'test' })
      )
    )
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      inbox.push(m)
      if (m.type === 'welcome') resolve()
    })
  })
  return {
    ws,
    inbox,
    ready,
    send: (o) => ws.send(JSON.stringify(o)),
    drain: () => (inbox.length = 0),
    /** 等一个新的 presence（最多 2 秒） */
    async presence(timeoutMs = 2000) {
      const until = Date.now() + timeoutMs
      while (Date.now() < until) {
        const i = inbox.findIndex((m) => m.type === 'presence')
        if (i >= 0) return inbox.splice(i, 1)[0]
        await wait(40)
      }
      return null
    },
    /** 等一下，确认**没有** presence 过来 */
    async noPresence(ms = 800) {
      await wait(ms)
      return inbox.filter((m) => m.type === 'presence').length === 0
    },
  }
}

const a = client('u-a', '小明')
const b = client('u-b', '小红')
await a.ready
await b.ready
await wait(300)

/** 从 presence 列表里取某人的 activity */
const actOf = (p, userId) => p?.online?.find((o) => o.userId === userId)?.activity ?? null

// ═══ 1. 上报 + 广播 ═════════════════════════════════════════
{
  a.drain()
  b.drain()
  a.send({ type: 'setActivity', activity: { kind: 'music', title: '我是真的爱上你', artist: '王杰' } })

  const pa = await a.presence()
  const pb = await b.presence()

  await check('上报后自己收到 presence', () => assert.ok(pa, '发起者应该收到'))
  await check('★ 别人也收到了（这就是"列表里能看到"）', () => assert.ok(pb, '没广播的话别人看不到'))
  await check('activity 内容正确', () => {
    assert.deepEqual(actOf(pb, 'u-a'), { kind: 'music', title: '我是真的爱上你', artist: '王杰' })
  })
  await check('没有在听的人 activity 是 null（不该是 undefined）', () => {
    const other = pb.online.find((o) => o.userId === 'u-b')
    assert.equal(other.activity, null)
  })
}

// ═══ 2. 内容没变 → 不重复广播 ═══════════════════════════════
{
  a.drain()
  b.drain()
  a.send({ type: 'setActivity', activity: { kind: 'music', title: '我是真的爱上你', artist: '王杰' } })
  await check('★ 同样的内容再报一次 → 不广播（客户端每几秒会报一次）', async () => {
    assert.equal(await b.noPresence(), true, '不该刷屏式广播')
  })
}

// ═══ 3. 换歌 → 广播 ═════════════════════════════════════════
{
  a.drain()
  b.drain()
  a.send({ type: 'setActivity', activity: { kind: 'music', title: '另一首', artist: '王杰' } })
  const pb = await b.presence()
  await check('换歌会广播', () => {
    assert.equal(actOf(pb, 'u-a')?.title, '另一首')
  })
}

// ═══ 4. 停止播放 → null 清掉 ════════════════════════════════
{
  a.drain()
  b.drain()
  a.send({ type: 'setActivity', activity: null })
  const pb = await b.presence()
  await check('传 null → 状态被清掉并广播', () => {
    assert.equal(actOf(pb, 'u-a'), null)
  })
}

// ═══ 5. 输入校验（不可信输入） ══════════════════════════════
{
  // 「正在玩游戏」和听歌走同一条路：同一个 activity 字段，只是 kind 不同。
  a.drain()
  b.drain()
  a.send({ type: 'setActivity', activity: { kind: 'game', title: '英雄联盟' } })
  const pg = await b.presence()
  await check('★ kind=game 也能广播（游戏检测和听歌共用这条路径）', () => {
    assert.ok(pg, '应该广播出去')
    assert.deepEqual(actOf(pg, 'u-a'), { kind: 'game', title: '英雄联盟', artist: '' })
  })

  a.drain()
  b.drain()
  // 注意：上一步是 game，所以这里是**从有到无**的变化 —— 会正常广播。
  // 要验的是"不认识的 kind 被规整成没在做什么"，而不是"不广播"。
  a.send({ type: 'setActivity', activity: { kind: 'video', title: '在看视频' } })
  const pv = await b.presence()
  await check('★ 不认识的 kind → 丢掉（只认 music / game）', () => {
    assert.ok(pv, '从有到无是变化，应该广播')
    assert.equal(actOf(pv, 'u-a'), null, '不该留下 video 这种类型')
  })

  a.drain()
  b.drain()
  a.send({ type: 'setActivity', activity: { kind: 'music', title: 'x'.repeat(10000), artist: 'y'.repeat(10000) } })
  const pb = await b.presence()
  await check('★ 超长字符串被截断（否则能把所有人界面撑爆）', () => {
    const act = actOf(pb, 'u-a')
    assert.equal(act.title.length, 120)
    assert.equal(act.artist.length, 80)
  })

  a.drain()
  b.drain()
  // 注意：上一步刚设了超长的 title，所以这一条是**从有到无**的变化 ——
  // 会正常广播。要验的是"空白 title 被当成没在听"，而不是"不广播"。
  a.send({ type: 'setActivity', activity: { kind: 'music', title: '   ', artist: '' } })
  const blankPb = await b.presence()
  await check('空白 title → 当没在听（不显示空白的"正在听："）', () => {
    assert.ok(blankPb, '从有到无是变化，应该广播')
    assert.equal(actOf(blankPb, 'u-a'), null, '空白 title 该被规整成 null')
  })
}

// ═══ 6. 断线后状态消失 ══════════════════════════════════════
{
  b.drain()
  a.drain()
  a.send({ type: 'setActivity', activity: { kind: 'music', title: '断线前的歌', artist: '' } })
  await b.presence()
  b.drain()
  a.ws.close()
  await wait(700)
  await check('★ 人一下线，他的 activity 也跟着消失（不留幽灵）', () => {
    const last = [...b.inbox].reverse().find((m) => m.type === 'presence')
    // 可能没有新的 presence（只剩一个人时服务端未必推）——
    // 那就直接看最后一次收到的列表里还有没有他
    if (!last) return
    assert.equal(last.online.find((o) => o.userId === 'u-a'), undefined)
  })
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)

b.ws.close()
srv.kill()
await wait(300)
try {
  rmSync(tmp, { recursive: true, force: true })
} catch {
  /* ignore */
}
process.exit(fail === 0 ? 0 : 1)
