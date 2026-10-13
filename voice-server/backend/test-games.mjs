/**
 * 「上报游戏（全服共享）」的端到端测试。
 *
 * 跑法（在 voice-server/backend 目录）：
 *     node test-games.mjs
 *
 * 核心要验的是一句话：**一个人上报过，别人不用再报就能检测到。**
 * 所以最后一条专门新开一个连接，看它的 welcome 里有没有那张表。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 3078
const OWNER_NAME = 'Owner'
const tmp = mkdtempSync(join(tmpdir(), 'voice-games-'))
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

console.log('\n上报游戏（全服共享）· 端到端测试\n')

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

function client(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  const inbox = []
  const ready = new Promise((resolve) => {
    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ type: 'hello', name, inviteCode: 'test' }))
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
    send: (o) => ws.send(JSON.stringify(o)),
    drain: () => (inbox.length = 0),
    async waitFor(type, timeoutMs = 2500) {
      const until = Date.now() + timeoutMs
      while (Date.now() < until) {
        const i = inbox.findIndex((m) => m.type === type)
        if (i >= 0) return inbox.splice(i, 1)[0]
        await wait(40)
      }
      return null
    },
    async noMessage(type, ms = 800) {
      await wait(ms)
      return inbox.filter((m) => m.type === type).length === 0
    },
  }
}

const owner = client(OWNER_NAME)
const ownerWelcome = await owner.ready
const member = client('普通成员')
await member.ready
await wait(300)

// ═══ 1. 初始状态 ════════════════════════════════════════════
await check('① 新库里 games 是空表（不是 undefined）', () => {
  assert.deepEqual(ownerWelcome.games, {}, `期望 {}，实际 ${JSON.stringify(ownerWelcome.games)}`)
})

// ═══ 2. 普通成员就能报 ══════════════════════════════════════
await check('② ★ 普通成员（不是频道主）也能上报', async () => {
  member.drain()
  owner.drain()
  member.send({ type: 'reportGame', exe: 'MyGame.exe', name: '我的游戏', requestId: 'r1' })

  const ok = await member.waitFor('ok')
  assert.ok(ok, '应该收到 ok 回执')

  const g = await owner.waitFor('games')
  assert.ok(g, '★ 别人应该收到 games 广播 —— 这就是"共享"')
  assert.equal(g.games['mygame'], '我的游戏')
})

await check('③ exe 被规整：小写、去掉 .exe', async () => {
  assert.equal(ownerWelcome.games['MyGame.exe'], undefined, '键不该保留原样')
  const g = await (async () => {
    const c = client('看看的人')
    const w = await c.ready
    c.ws.close()
    return w.games
  })()
  assert.deepEqual(Object.keys(g), ['mygame'])
})

// ═══ 3. 重复上报不广播 ══════════════════════════════════════
await check('④ 同一个人再报一次同样的 → 不广播（省得所有人白刷新）', async () => {
  owner.drain()
  member.drain()
  // 大小写 + 带 .exe 也要认成同一个
  member.send({ type: 'reportGame', exe: 'MYGAME.EXE', name: '我的游戏' })
  assert.equal(await owner.noMessage('games'), true, '不该广播')
})

await check('⑤ 改名会广播（是有变化）', async () => {
  owner.drain()
  member.drain()
  member.send({ type: 'reportGame', exe: 'mygame', name: '改过的名字' })
  const g = await owner.waitFor('games')
  assert.ok(g, '改了名字应该广播')
  assert.equal(g.games['mygame'], '改过的名字')
})

// ═══ 4. 非法输入 ════════════════════════════════════════════
await check('⑥ 空名字 / 空 exe → bad_game，不写库', async () => {
  member.drain()
  member.send({ type: 'reportGame', exe: '', name: '没有进程名' })
  const e1 = await member.waitFor('error')
  assert.ok(e1, '应该报错')
  assert.equal(e1.error, 'bad_game')

  member.drain()
  member.send({ type: 'reportGame', exe: 'okgame', name: '   ' })
  const e2 = await member.waitFor('error')
  assert.equal(e2?.error, 'bad_game')
})

await check('⑦ ★ 超长名字被截断（这是所有人都会收到的数据）', async () => {
  owner.drain()
  member.drain()
  member.send({ type: 'reportGame', exe: 'longname', name: 'x'.repeat(500) })
  const g = await owner.waitFor('games')
  assert.equal(g.games['longname'].length, 40)
})

// ═══ 5. ★ 核心：后来的人不用再报 ════════════════════════════
await check('⑧ ★ 新连上的人，welcome 里直接就有全服的游戏表', async () => {
  const late = client('后进来的人')
  const w = await late.ready
  late.ws.close()

  assert.equal(w.games['mygame'], '改过的名字', '之前报的应该在里面')
  assert.equal(w.games['longname'].length, 40, '截断过的也在')
  assert.ok(Object.keys(w.games).length >= 2)
})

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
