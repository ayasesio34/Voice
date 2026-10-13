/**
 * 文件归属（scope）和聊天搜索的单测。
 *
 * 跑法：
 *     cd voice-server/backend
 *     node test-files-search.mjs
 *
 * 为什么值得测：
 *   · scope 写错 → 聊天里的截图会跑进「云端文件」，或者反过来云端文件不显示
 *   · 搜索的 LIKE 转义写错 → 用户搜 `%` 会匹配到**所有**消息
 *   · 条件拼错 → "只看某人"变成"看所有人"，而且看起来还挺正常
 *
 * 这些都是跑起来才看得出来的。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  openDb,
  createChannel,
  insertMessage,
  listMessages,
  getMessage,
  deleteMessage,
  insertFile,
  getFile,
  deleteFile,
  listFiles,
  filesStats,
  searchMessages,
} from './src/db.js'

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const dir = mkdtempSync(join(tmpdir(), 'voice-db-test-'))
const db = openDb(join(dir, 'test.db'))

const CH = 'ch-general'

// 消息表对 channels 有外键约束 —— 不先建频道插不进去
createChannel(db, { id: CH, name: '综合', kind: 'text' })
createChannel(db, { id: 'ch-other', name: '另一个', kind: 'text' })

function addMsg(authorId, authorName, body, at) {
  const m = insertMessage(db, { channelId: CH, authorId, authorName, body, attachment: null })
  // created_at 由 insert 自己写，测试里不需要精确时间，顺序按自增 id 就够了
  assert.ok(m.id > 0)
  return m
}

// ── 准备数据 ────────────────────────────────────────────────

addMsg('u1', '小明', '今天打什么游戏')
addMsg('u2', '小红', '打游戏吗？我想玩那个')
addMsg('u1', '小明', '先说好，别又临时换游戏')
addMsg('u3', '小刚', '100% 同意')
addMsg('u2', '小红', '下划线_测试 和 反斜杠\\测试')

// ── 搜索 ────────────────────────────────────────────────────

console.log('\n文件归属 + 聊天搜索 单元测试\n')
console.log('【搜索：关键词】')

test('空条件返回空数组（不该把整个频道倒出来）', () => {
  assert.deepEqual(searchMessages(db, { channelId: CH, q: '', authorId: '' }), [])
  assert.deepEqual(searchMessages(db, { channelId: CH }), [])
})

test('关键词能搜到', () => {
  const r = searchMessages(db, { channelId: CH, q: '游戏' })
  assert.equal(r.length, 3, `应该 3 条，实际 ${r.length}`)
  assert.ok(r.every((m) => m.body.includes('游戏')))
})

test('结果按时间**正序**（和普通历史一样，前端能复用同一套渲染）', () => {
  const r = searchMessages(db, { channelId: CH, q: '游戏' })
  for (let i = 1; i < r.length; i++) assert.ok(r[i].id > r[i - 1].id, 'id 应该递增')
})

test('搜不到就是空数组', () => {
  assert.deepEqual(searchMessages(db, { channelId: CH, q: '四个字都没有的词' }), [])
})

console.log('\n【搜索：只看某人】')

test('按 authorId 过滤', () => {
  const r = searchMessages(db, { channelId: CH, authorId: 'u1' })
  assert.equal(r.length, 2)
  assert.ok(r.every((m) => m.author_id === 'u1'))
})

test('★ 关键词 + 作者 = "某人说的、且包含这个词"', () => {
  const r = searchMessages(db, { channelId: CH, q: '游戏', authorId: 'u1' })
  assert.equal(r.length, 2, `小红那条不该进来，实际 ${r.length} 条`)
  assert.ok(r.every((m) => m.author_id === 'u1' && m.body.includes('游戏')))
})

console.log('\n【搜索：LIKE 转义】')

test('★ 搜 `%` 不该匹配到所有消息', () => {
  const r = searchMessages(db, { channelId: CH, q: '%' })
  assert.equal(r.length, 1, '只有小刚那条含 %，不该把所有消息都带出来')
  assert.ok(r[0].body.includes('100%'))
})

test('★ 搜 `_` 不该匹配任意单字', () => {
  const r = searchMessages(db, { channelId: CH, q: '_' })
  assert.equal(r.length, 1)
  assert.ok(r[0].body.includes('下划线_测试'))
})

test('反斜杠也是普通字符', () => {
  const r = searchMessages(db, { channelId: CH, q: '\\' })
  assert.equal(r.length, 1)
})

console.log('\n【搜索：隔离性】')

test('不会搜到别的频道', () => {
  insertMessage(db, { channelId: 'ch-other', authorId: 'u1', authorName: '小明', body: '游戏 在别的频道', attachment: null })
  const r = searchMessages(db, { channelId: CH, q: '游戏' })
  assert.equal(r.length, 3, '别的频道那条不该进来')
})

// ── 文件归属 ────────────────────────────────────────────────

console.log('\n【文件的 scope】')

const mk = (id, name, scope) =>
  insertFile(db, { id, name, size: 10, mime: 'image/png', uploaderId: 'u1', uploaderName: '小明', scope })

test('没传 scope 默认算 chat（老客户端不带这个参数）', () => {
  const f = insertFile(db, { id: 'f-default', name: 'a.png', size: 1, mime: '', uploaderId: 'u1', uploaderName: 'x' })
  assert.equal(f.scope, 'chat')
})

test('不认识的 scope 也退回 chat（别让脏数据溜进去）', () => {
  const f = mk('f-bad', 'b.png', 'garbage')
  assert.equal(f.scope, 'chat')
})

test('★ 聊天里发的截图**不进**云端文件列表', () => {
  mk('f-chat', '截图.png', 'chat')
  const cloud = listFiles(db, { scope: 'cloud' })
  assert.ok(!cloud.some((f) => f.id === 'f-chat'), '聊天附件不该出现在云端文件里')
})

test('★ 云端上传的**在**列表里', () => {
  mk('f-cloud', '资料.zip', 'cloud')
  const cloud = listFiles(db, { scope: 'cloud' })
  assert.ok(cloud.some((f) => f.id === 'f-cloud'))
})

test('文件本身还在（聊天附件靠 id 照样取得到）', () => {
  const all = listFiles(db)
  assert.ok(all.some((f) => f.id === 'f-chat'), '只是不进面板，不是被删了')
})

test('stats 跟着 scope 走', () => {
  const cloud = filesStats(db, 'cloud')
  const all = filesStats(db)
  assert.ok(cloud.count < all.count, '云端的数量应该比总数少')
  assert.equal(cloud.count, listFiles(db, { scope: 'cloud' }).length)
})

// ── 删除消息 ────────────────────────────────────────────────

console.log('\n【删除消息】')

test('getMessage 能把 attachment 从 JSON 解出来', () => {
  const m = insertMessage(db, {
    channelId: CH, authorId: 'u1', authorName: '小明', body: '带图的',
    attachment: { id: 'f-att', name: 'x.png', size: 3, mime: 'image/png' },
  })
  const got = getMessage(db, m.id)
  assert.equal(got.attachment.id, 'f-att', 'attachment 应该是对象，不是字符串')
  assert.equal(got.channel_id, CH, '要知道属于哪个频道 —— 广播给谁靠它')
})

test('getMessage 对不存在的 id 返回 null（不是崩）', () => {
  assert.equal(getMessage(db, 999999), null)
})

test('deleteMessage 第一次成功、第二次返回 false（幂等）', () => {
  const m = insertMessage(db, { channelId: CH, authorId: 'u1', authorName: '小明', body: '待删', attachment: null })
  assert.equal(deleteMessage(db, m.id), true)
  assert.equal(deleteMessage(db, m.id), false, '重复删应该是 false，不该抛错')
})

test('删掉之后 listMessages 里就没有了', () => {
  const m = insertMessage(db, { channelId: CH, authorId: 'u1', authorName: '小明', body: 'ZZZ待删ZZZ', attachment: null })
  deleteMessage(db, m.id)
  const left = listMessages(db, { channelId: CH, limit: 200 })
  assert.ok(!left.some((x) => x.id === m.id))
})

test('★ 删消息**不会**自动删附件 —— 所以处理里必须显式删（这里把那个契约钉住）', () => {
  insertFile(db, { id: 'f-orphan', name: 'shot.png', size: 9, mime: 'image/png', uploaderId: 'u1', uploaderName: '小明', scope: 'chat' })
  const m = insertMessage(db, {
    channelId: CH, authorId: 'u1', authorName: '小明', body: '',
    attachment: { id: 'f-orphan', name: 'shot.png', size: 9, mime: 'image/png' },
  })
  deleteMessage(db, m.id)
  assert.ok(getFile(db, 'f-orphan'), '文件行还在 —— 这正是为什么要显式 deleteFile')
})

test('★ 按处理里的顺序删（消息 + 附件）之后，不留孤儿', () => {
  insertFile(db, { id: 'f-clean', name: 'a.png', size: 9, mime: 'image/png', uploaderId: 'u1', uploaderName: '小明', scope: 'chat' })
  const m = insertMessage(db, {
    channelId: CH, authorId: 'u1', authorName: '小明', body: '',
    attachment: { id: 'f-clean', name: 'a.png', size: 9, mime: 'image/png' },
  })

  // 模拟 index.js 里 deleteMessage 处理的顺序
  const row = getMessage(db, m.id)
  deleteMessage(db, row.id)
  deleteFile(db, row.attachment.id)

  assert.equal(getMessage(db, m.id), null, '消息没了')
  assert.equal(getFile(db, 'f-clean'), null, '附件也没了 —— 磁盘上那份由处理里 rmSync 负责')
})

test('私聊消息也是同一个频道维度（广播过滤靠 channel_id）', () => {
  const dm = insertMessage(db, { channelId: 'ch-other', authorId: 'u1', authorName: '小明', body: '悄悄话', attachment: null })
  const row = getMessage(db, dm.id)
  assert.equal(row.channel_id, 'ch-other')
  deleteMessage(db, dm.id)
  assert.equal(getMessage(db, dm.id), null)
})

// ── 执行 ────────────────────────────────────────────────────

let passed = 0
let failed = 0
for (const t of tests) {
  try {
    await t.fn()
    passed++
    console.log(`  \u2705 ${t.name}`)
  } catch (err) {
    failed++
    console.log(`  \u274c ${t.name}`)
    console.log(`     ${err.message}`)
  }
}

console.log(`\n${'─'.repeat(48)}`)
console.log(`通过 ${passed} / 失败 ${failed}`)

try {
  db.close()
  rmSync(dir, { recursive: true, force: true })
} catch {
  /* ignore */
}

process.exit(failed === 0 ? 0 : 1)
