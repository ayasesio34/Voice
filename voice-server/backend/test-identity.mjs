/**
 * 身份与角色安全的端到端测试。
 *
 * 跑法（在 voice-server/backend 目录）：
 *     node test-identity.mjs
 *
 * ── 为什么要有这个测试 ──────────────────────────────────────
 * 这里钉的是**一个真实发生过的提权漏洞**：
 *
 *   旧的 `registerMember` 是「昵称 == OWNER_NAME 就 makeOwner」。
 *   而任何成员都能在设置里把昵称改成 OWNER_NAME ——
 *   于是**谁都能把自己提成频道主，还会把真正的频道主降级** ✗
 *
 *   更糟的是配套的另一半：`userId` 对但 `userKey` 不对时，
 *   服务端**静默新建一个成员**，而且**采信客户端报上来的名字**。
 *   两条凑在一起：乱填 userId + 乱填 key + 名字填 OWNER_NAME，
 *   就能凭空造出一个频道主。
 *
 *   成员列表里"多出一堆同名的人"就是这么来的。
 *
 * 这个测试跑的是真服务端，用真 WebSocket 连。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 3084
const OWNER_NAME = 'Owner'
const tmp = mkdtempSync(join(tmpdir(), 'voice-ident-'))
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

console.log('\n身份 / 角色安全 · 端到端测试\n')

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

/** 连一次，拿到 welcome（也就是服务端认下来的身份和角色） */
function hello({ userId, userKey, name, avatar }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const t = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolve(null)
    }, 8000)
    ws.addEventListener('open', () =>
      ws.send(
        JSON.stringify({ type: 'hello', userId, userKey, name, avatar, inviteCode: 'test' })
      )
    )
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.type !== 'welcome') return
      clearTimeout(t)
      const me = m.members.find((x) => x.userId === m.userId)
      resolve({
        userId: m.userId,
        issuedKey: m.userKey, // 有值 = 服务端临时造的新身份
        role: me?.role,
        name: me?.name,
        members: m.members,
        close: () => ws.close(),
      })
    })
    ws.addEventListener('error', () => {
      clearTimeout(t)
      resolve(null)
    })
  })
}

let ownerId = ''
let ownerKey = ''

// ═══ 1. 首次搭建：第一个用 OWNER_NAME 连的人拿到频道主 ══════
await check('① 还没有频道主时，昵称对得上 → 拿到 owner（首次搭建）', async () => {
  const r = await hello({ name: OWNER_NAME })
  assert.equal(r.role, 'owner', '第一个该成为频道主')
  ownerId = r.userId
  ownerKey = r.issuedKey
  assert.ok(ownerKey, '服务端应该下发凭证')
  r.close()
})

// ═══ 2. ★ 已经有频道主了，别人再叫这个名字 → 只能是 member ══
await check('② ★ 已经有频道主了，另一个人也叫 Owner → 只能是 member', async () => {
  const r = await hello({ name: OWNER_NAME })
  assert.equal(r.role, 'member', '不该靠改名字就拿到频道主')
  r.close()
})

await check('③ 原来的频道主没被顶掉', async () => {
  const r = await hello({ userId: ownerId, userKey: ownerKey, name: OWNER_NAME })
  assert.equal(r.userId, ownerId, '不该被换成新身份')
  assert.equal(r.role, 'owner', '频道主还是他')
  r.close()
})

// ═══ 3. ★ 已有成员改昵称成 OWNER_NAME → 不提拔 ═════════════
await check('④ ★ 已有成员把昵称改成 Owner → 角色不变（这才是提权口子）', async () => {
  const a = await hello({ name: '蛋挞' })
  assert.equal(a.role, 'member')
  const aId = a.userId
  const aKey = a.issuedKey
  a.close()

  // 同一个人改昵称再连
  const b = await hello({ userId: aId, userKey: aKey, name: OWNER_NAME })
  assert.equal(b.userId, aId, '还是同一个人')
  assert.equal(b.role, 'member', '改个名字不该变成频道主')
  b.close()
})

// ═══ 4. ★ userId 对但 key 错 → 不能冒充名字 ════════════════
await check('⑤ ★ userId 对、key 错 → 不能顶掉频道主', async () => {
  const r = await hello({ userId: ownerId, userKey: 'wrong-key', name: OWNER_NAME })
  assert.notEqual(r.userId, ownerId, '不该拿到那个身份')
  assert.notEqual(r.role, 'owner', '更不该成为频道主')
  r.close()
})

await check('⑥ ★ 冒充时**名字不被采信**（否则又会多出一堆同名的人）', async () => {
  const r = await hello({ userId: ownerId, userKey: 'wrong-key', name: OWNER_NAME })
  assert.notEqual(r.name, OWNER_NAME, '名字不该是客户端传上来的那个')
  assert.match(r.name, /^用户\d{4}$/, `应该被换成中性名，实际是「${r.name}」`)
  r.close()
})

await check('⑦ 冒充进去的人角色是 member（不是 admin / owner）', async () => {
  const r = await hello({ userId: ownerId, userKey: 'wrong-key', name: OWNER_NAME })
  assert.equal(r.role, 'member')
  r.close()
})

// ═══ 5. 最终状态：全服只有一个频道主 ═══════════════════════
await check('⑧ ★ 不管怎么折腾，全服只有一个 owner', async () => {
  const r = await hello({ userId: ownerId, userKey: ownerKey, name: OWNER_NAME })
  const owners = r.members.filter((m) => m.role === 'owner')
  assert.equal(owners.length, 1, `owner 应该有且只有一个，实际 ${owners.length} 个`)
  assert.equal(owners[0].userId, ownerId, '而且应该是最初那个')
  r.close()
})

await check('⑨ 全服名册里没有重复的 OWNER_NAME', async () => {
  const r = await hello({ userId: ownerId, userKey: ownerKey, name: OWNER_NAME })
  const same = r.members.filter((m) => m.name === OWNER_NAME)
  assert.equal(same.length, 1, `叫「${OWNER_NAME}」的应该只有 1 个，实际 ${same.length} 个`)
  r.close()
})

console.log(`\n${'─'.repeat(52)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)

srv.kill()
await wait(300)
try {
  rmSync(tmp, { recursive: true, force: true })
} catch {
  /* ignore */
}
process.exit(fail === 0 ? 0 : 1)
