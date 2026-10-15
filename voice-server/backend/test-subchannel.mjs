/**
 * 「子频道」的端到端测试。
 *
 * 跑法（在 voice-server/backend 目录）：node test-subchannel.mjs
 *
 * ── 为什么必须端到端 ✗ ──────────────────────────────────────
 *   真正容易写错的是这几件事：
 *     ★ 「只允许一层」这条**只能**在服务端拦 ✗
 *       界面上可以只列顶层频道当候选项 ✓ 但那是"不给入口"✓
 *       构造一条带深层 parentId 的请求照样能发过来 ✓
 *     ★ 父频道和子频道必须**同类** ✗
 *     ★ 删父频道要**连坐**子频道 ✓ 而且新旧库行为必须一致 ✗
 *
 * ── 老库那条路径为什么单独跑一遍 ✓ ──────────────────────────
 *   表定义里写了 `parent_id REFERENCES channels(id) ON DELETE CASCADE` ✓
 *   但那只对**新建的库**有效 ✓
 *   老库的 parent_id 是 migrate() 里 ALTER TABLE 加上来的 ✓
 *   而 SQLite **不支持用 ALTER 加外键** ✗
 *   所以老库上删父频道时**一点级联都不会发生** ✓
 *   只靠外键的话会留下一堆孤儿子频道 ✓ 它们出现在列表里、
 *   点进去是个空壳 ✓ 而且再也删不掉（父频道已经没了 ✓）
 *
 *   → 所以这个测试**手工造一个老式 channels 表** ✓
 *     让服务端自己去 migrate() ✓ 然后再验一遍连坐 ✓
 *     这才是真的在测"升级上来的库" ✓ 而不是"刚建好的库" ✗
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'voice-sub-'))
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

const servers = []
function startServer(port, dbPath) {
  const srv = spawn(process.execPath, ['src/index.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: dbPath,
      UPLOADS_DIR: join(tmp, `up-${port}`),
      UPDATES_DIR: join(tmp, `upd-${port}`),
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'devsecret',
      INVITE_CODE: 'test',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  servers.push(srv)
  return srv
}

function client(port, userId, userKey, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
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

async function boot(port) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true
    } catch {
      /* 还没起来 */
    }
    await wait(250)
  }
  return false
}

/** 建一个频道（或子频道 ✓），返回它的 id */
async function makeChannel(c, name, kind, parentId) {
  c.drain()
  c.send({ type: 'createChannel', name, kind, parentId, requestId: `c-${name}` })
  const ev = await c.wait((x) => x.type === 'ok' && x.channel?.name === name)
  return ev?.channel ?? null
}

/** 从最近一条 channels 广播里找频道 */
async function latestChannels(c) {
  for (let i = c.inbox.length - 1; i >= 0; i--) {
    if (c.inbox[i].type === 'channels') return c.inbox[i].channels
  }
  // 没广播就等一条
  const ev = await c.wait((x) => x.type === 'channels')
  return ev?.channels ?? []
}

async function main() {
  // ═══════════════════════════════════════════════════════
  //  第一段：全新库（带外键 ✓）
  // ═══════════════════════════════════════════════════════
  const P1 = 3089
  startServer(P1, join(tmp, 'fresh.db'))
  assert.ok(await boot(P1), '服务端应该起来')

  const A = client(P1, 'u-a', 'ka', '甲')
  const wA = await A.ready
  const text = wA.channels.find((c) => c.kind === 'text')
  assert.ok(text, '默认应该有文字频道')

  console.log('')
  await check('① 建子频道 → 广播里带 parent_id', async () => {
    const child = await makeChannel(A, '子频道甲', 'text', text.id)
    assert.ok(child, '应该建成功')
    assert.equal(child.parent_id, text.id, `parent_id 应该是父频道，实际=${child.parent_id}`)

    const list = await latestChannels(A)
    const found = list.find((c) => c.id === child.id)
    assert.ok(found, '新频道应该出现在 channels 广播里')
    assert.equal(found.parent_id, text.id, '广播里也要带 parent_id（客户端靠它建树 ✓）')
  })

  await check('② ★ 只允许一层：给子频道再挂子频道 → nest_too_deep', async () => {
    const list = await latestChannels(A)
    const child = list.find((c) => c.parent_id === text.id)
    assert.ok(child, '上一轮那个子频道应该在')

    A.drain()
    A.send({ type: 'createChannel', name: '孙频道', kind: 'text', parentId: child.id, requestId: 'x' })
    const err = await A.wait((x) => x.type === 'error')
    assert.ok(err, '★ 应该被拦住 ✗ 不然树上就有第三层了 ✓')
    assert.equal(err.error, 'nest_too_deep', `错误码应该是 nest_too_deep，实际=${err.error}`)

    // 而且真的没建出来 ✓
    const after = await latestChannels(A)
    assert.ok(!after.some((c) => c.name === '孙频道'), '★ 被拒之后不该真的建出频道 ✗')
  })

  await check('③ ★ 父子必须同类：文字父 + 语音子 → parent_kind_mismatch', async () => {
    A.drain()
    A.send({ type: 'createChannel', name: '混类子', kind: 'voice', parentId: text.id, requestId: 'x' })
    const err = await A.wait((x) => x.type === 'error')
    assert.ok(err, '应该被拦住')
    assert.equal(err.error, 'parent_kind_mismatch', `实际=${err.error}`)
  })

  await check('④ 父频道不存在 → parent_not_found', async () => {
    A.drain()
    A.send({ type: 'createChannel', name: '野孩子', kind: 'text', parentId: 'nope-1234', requestId: 'x' })
    const err = await A.wait((x) => x.type === 'error')
    assert.ok(err, '应该被拦住')
    assert.equal(err.error, 'parent_not_found', `实际=${err.error}`)
  })

  await check('⑤ 语音频道也能挂子频道 ✓（同类 ✓）', async () => {
    const v = await makeChannel(A, '语音甲', 'voice', null)
    assert.ok(v, '语音频道应该建成功')
    const vc = await makeChannel(A, '语音子', 'voice', v.id)
    assert.ok(vc, '语音子频道应该建成功')
    assert.equal(vc.parent_id, v.id)
  })

  await check('⑥ ★ 删父频道 → 子频道一起删掉，并回报连坐数量', async () => {
    // ⚠️ 不能拿 text.id 去删 ✗ —— 那就是默认频道 general ✓
    //    服务端**故意**不让删它（cannot_delete_default ✓ 至少留一个文字频道 ✓）
    //    第一版就是这么写的 ✓ 于是收到的是 error 而不是 ok ✓
    //    那次是**测试用错了对象**，代码是对的 ✓
    const parent = await makeChannel(A, '父频道乙', 'text', null)
    assert.ok(parent, '应该能建一个可删的父频道')
    const child = await makeChannel(A, '父频道乙的子', 'text', parent.id)
    assert.ok(child, '子频道应该建成功')

    // 给子频道发一条消息 ✓ 待会儿要验它也一起没了 ✓
    A.drain()
    A.send({ type: 'message', channelId: child.id, body: '子频道里的消息' })
    const m = await A.wait((x) => x.type === 'message' && x.message.body === '子频道里的消息')
    assert.ok(m, '消息应该发得出去')

    A.drain()
    A.send({ type: 'deleteChannel', channelId: parent.id, requestId: 'del' })
    const ok = await A.wait((x) => x.type === 'ok' && x.requestId === 'del')
    assert.ok(ok, '删除应该成功')
    assert.equal(ok.removedChildren, 1, `★ 应该回报连坐了 1 个子频道，实际=${ok.removedChildren}`)

    const after = await latestChannels(A)
    assert.ok(!after.some((c) => c.id === parent.id), '父频道应该没了')
    assert.ok(!after.some((c) => c.id === child.id), '★ 子频道也该没了 ✗ 不然会留下个空壳 ✓')

    // 子频道的消息也要跟着走 ✓
    const raw = new DatabaseSync(join(tmp, 'fresh.db'))
    const n = raw.prepare('SELECT COUNT(*) AS c FROM messages WHERE channel_id = ?').get(child.id).c
    raw.close()
    assert.equal(Number(n), 0, `★ 子频道的消息也该级联删掉，实际还剩 ${n} 条 ✗`)
  })

  await check('⑥b 默认频道删不掉（至少留一个文字频道 ✓）', async () => {
    const list = await latestChannels(A)
    const def = list.find((c) => c.kind === 'text' && !c.parent_id)
    assert.ok(def, '应该还有一个顶层文字频道')
    A.drain()
    A.send({ type: 'deleteChannel', channelId: 'general', requestId: 'deldef' })
    const err = await A.wait((x) => x.type === 'error')
    assert.ok(err, '应该被拦住')
    assert.equal(err.error, 'cannot_delete_default', `实际=${err.error}`)
  })

  // ═══════════════════════════════════════════════════════
  //  第二段：**手工造一个老式库**（parent_id 是 ALTER 加的 ✓ 没有外键 ✗）
  // ═══════════════════════════════════════════════════════
  const P2 = 3088
  const oldDb = join(tmp, 'old.db')
  {
    // ⚠️ 这就是关键 ✗ —— 手工建一个**没有 parent_id、也没有外键**的 channels 表 ✓
    //    服务端的 CREATE TABLE IF NOT EXISTS 会跳过它 ✓
    //    然后 migrate() 用 ALTER 把 parent_id 加上 ✓ —— 那条路**加不上外键** ✓
    //    这正是所有已经部署过的库的样子 ✓
    const raw = new DatabaseSync(oldDb)
    raw.exec(`
      CREATE TABLE channels (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'text',
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
      );
    `)
    raw.close()
  }
  startServer(P2, oldDb)
  assert.ok(await boot(P2), '老库上的服务端应该也能起来')

  console.log('')
  console.log('  ── 老库（parent_id 是 ALTER 加的，没有外键 ✗）──')

  /**
   * ⚠️ 老库那边的**频道主**要留下来复用 ✗
   *    建频道需要管理员以上权限 ✓
   *    而这个服务端里第一个连上的成员才是频道主（OWNER_NAME 没配 ✓）
   *    也就是 ⑦ 里的 `乙` ✓
   *    ⑧ 里再新建一个客户端就只是普通成员了 ✓ 建频道会被拒 ✓
   *    （第一版就是这么错的 ✓ 收到的是 forbidden ✓ 不是代码的问题 ✓）
   */
  let ownerB = null

  await check('⑦ 老库能正常 migrate，并且照样能建子频道', async () => {
    const raw = new DatabaseSync(oldDb)
    const cols = raw.prepare('PRAGMA table_info(channels)').all().map((c) => c.name)
    raw.close()
    assert.ok(cols.includes('parent_id'), '★ migrate 应该补上 parent_id ✗')

    const B = client(P2, 'u-b', 'kb', '乙')
    const wB = await B.ready
    const t = wB.channels.find((c) => c.kind === 'text')
    assert.ok(t, '老库里应该也有默认文字频道')
    const child = await makeChannel(B, '老库子频道', 'text', t.id)
    assert.ok(child, '老库上应该也能建子频道')
    assert.equal(child.parent_id, t.id)
    ownerB = B // ← 留着给 ⑧ 用 ✓ 不关
  })

  await check('⑧ ★★ 老库上删父频道，子频道**也必须**一起走（没有外键兜底 ✗）', async () => {
    assert.ok(ownerB, '⑦ 应该留下了频道主的连接')
    // ⚠️ 不能用默认频道 ✗（那是 general ✓ 删不掉 ✓）
    //    自己建一个父频道 + 两个子频道 ✓ 连坐数量 2 ✓ 更严一点 ✓
    const parent = await makeChannel(ownerB, '老库父频道', 'text', null)
    assert.ok(parent, '老库上应该能建父频道')
    const k1 = await makeChannel(ownerB, '老库子一', 'text', parent.id)
    const k2 = await makeChannel(ownerB, '老库子二', 'text', parent.id)
    assert.ok(k1 && k2, '两个子频道都该建成功')

    const C = client(P2, 'u-c', 'kc', '丙')
    await C.ready

    // ⚠️ 删频道**必须由频道主发** ✗（canManage 才放行 ✓）
    //    让普通成员 u-c 去删会被拒 ✓ —— 第一版就是这么错的 ✓
    //    C 留着只当**旁观者** ✓ 用来确认广播也发给了别人 ✓
    C.drain()
    ownerB.drain()
    ownerB.send({ type: 'deleteChannel', channelId: parent.id, requestId: 'del-old' })
    const ok = await ownerB.wait((x) => x.type === 'ok' && x.requestId === 'del-old')
    assert.ok(ok, '删除应该成功（由频道主发起 ✓）')
    assert.equal(ok.removedChildren, 2, `连坐数量应该是 2，实际=${ok.removedChildren}`)

    const after = await latestChannels(C)
    assert.ok(after.length > 0, '普通成员也应该收到 channels 广播 ✓')
    for (const k of [k1, k2]) {
      assert.ok(
        !after.some((c) => c.id === k.id),
        `★★ 老库上子频道 ${k.name} 没被删掉 ✗ —— 说明只靠了外键、没有显式删 ✓`,
      )
    }
    // 直接开库确认，不信广播 ✓
    //
    // ⚠️「孤儿」的定义要问对 ✗
    //    第一版写的是 `WHERE parent_id IS NOT NULL` ✓
    //    —— 那问的是"**有父频道的**"✓ 不是"**父频道没了的**" ✗
    //    于是 ⑦ 里挂在默认频道 general 下面的那个子频道被算成了孤儿 ✓
    //    而 general 好好地还在 ✓ 它明明是个正常子频道 ✗
    //
    //    孤儿 = **它的父已经不存在了** ✓ 所以必须 LEFT JOIN 一下 ✓
    const raw = new DatabaseSync(oldDb)
    const orphans = raw
      .prepare(
        `SELECT c.id, c.name FROM channels c
         LEFT JOIN channels p ON p.id = c.parent_id
         WHERE c.parent_id IS NOT NULL AND p.id IS NULL`
      )
      .all()
    // 顺带看一眼"正常的子频道"还剩几个 ✓ 确认不是"把所有子频道都删了"
    const alive = raw
      .prepare(
        `SELECT c.id, c.name FROM channels c
         JOIN channels p ON p.id = c.parent_id`
      )
      .all()
    raw.close()

    assert.equal(
      orphans.length,
      0,
      `★★ 老库里还剩 ${orphans.length} 个**父频道已不存在**的子频道 ✗` +
        `（${orphans.map((o) => o.name).join('、')}）` +
        ` —— 这就是"只靠外键"在老库上的真实后果 ✓`,
    )
    // ⚠️ 这一条是在防止"上面那条通过得**太容易**" ✗
    //    如果代码把**所有**子频道都删了 ✓ 上面那条也会通过 ✓
    //    而 general 下面的那个子频道是**不该被删**的 ✓ 它得还在 ✓
    assert.ok(
      alive.length >= 1,
      '★ 不该把不相干的子频道也一起删了（general 下面那个应该还在 ✓）',
    )
    console.log(`         （正常子频道还剩 ${alive.length} 个：${alive.map((a) => a.name).join('、')} ✓）`)
    ownerB.ws.close()
    C.ws.close()
  })

  console.log('')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  console.log('')

  for (const s of servers) { try { s.kill() } catch { /* ignore */ } }
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.log('  ❌ ' + err.message)
  for (const s of servers) { try { s.kill() } catch { /* ignore */ } }
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(1)
})
