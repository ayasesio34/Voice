/**
 * 维护工具：在**服务器上**改成员的名字，或者删掉多余的成员成员。
 *
 * 为什么需要它：客户端只能"以某个身份连上去、报上自己的名字"，
 * 而这需要那个身份的 userKey。如果 key 丢了（比如被误清掉的配置），
 * 就没办法从客户端改了 —— 只能直接动数据库。
 *
 * 用法（在服务器上，backend 目录里）：
 *
 *     node tools/fix-member.mjs list
 *     node tools/fix-member.mjs rename <userId> <新名字>
 *     node tools/fix-member.mjs delete <userId>
 *
 * ⚠️ 改之前会自动备份一份数据库到同目录（`voice.db.bak-<时间戳>`）。
 *
 * ⚠️ 数据库路径默认 `./data/voice.db`，和 index.js 一致；
 *    可以用 DB_PATH 环境变量覆盖。
 */

import { copyFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

/**
 * 找数据库。
 *
 * ⚠️ 不能只写死 `./data/voice.db` —— 那个路径**取决于当前工作目录**，
 *    而从 `/opt/voice-server` 跑和从 `/opt/voice-server/backend` 跑
 *    差一层，差一层就是"找不到数据库"。（真踩过。）
 *
 * 所以按顺序试几个候选，谁在就用谁。显式的 DB_PATH 优先。
 */
function findDb() {
  const candidates = [
    process.env.DB_PATH,
    './data/voice.db', // 从 /opt/voice-server 跑（member.cmd 就是这么跑的）
    '../data/voice.db', // 从 /opt/voice-server/backend 跑
    './backend/data/voice.db', // 从仓库根跑
    './voice.db', // 数据库就在当前目录
  ].filter(Boolean)

  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}

const DB = findDb()
const [cmd, ...rest] = process.argv.slice(2)

// ⚠️ 帮助要放在**数据库检查之前**。
//    以前在它后面 ✗ —— 于是在没有数据库的目录里（比如仓库根）
//    跑 `help` 只会看到"找不到数据库" ✗ 连怎么用都看不到 ✓
if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(`
用法（把示例里那个 id 换成「list」打出来的真实 id）：

  node src/fix-member.mjs list
  node src/fix-member.mjs rename  b2bc1d94-e8e9-4f30-8873-139d5a575bb5  新名字
  node src/fix-member.mjs promote b2bc1d94-e8e9-4f30-8873-139d5a575bb5
  node src/fix-member.mjs delete  b2bc1d94-e8e9-4f30-8873-139d5a575bb5

⚠️ 上面那串 uuid 只是**示例** —— 别照抄**尖括号或别的括号** ✗
   （有人写 \`delete <id>\` ✗ PowerShell 会把 < 当成重定向符号，直接报语法错 ✗）

数据库：${DB}
${existsSync(DB) ? '' : '⚠️ 这个位置现在**没有**数据库文件 —— 先 cd 到 /opt/voice-server 再跑'}

关于 promote：
  服务端现在**不再按昵称自动提拔频道主**了 —— 那是提权漏洞
  （任何成员把昵称改成 OWNER_NAME 就能抢走频道主，还会把真的降级）。
  所以换电脑之后：先连上去（会得到一个新身份），
  再在服务器上跑一次 promote 把新身份提成频道主。
`)
  process.exit(0)
}

if (!existsSync(DB)) {
  console.error(`找不到数据库：${DB}`)
  console.error('试过这些位置：')
  for (const c of [process.env.DB_PATH, './data/voice.db', './backend/data/voice.db', './voice.db'].filter(Boolean)) {
    console.error(`  ${c}`)
  }
  console.error('')
  console.error('从 /opt/voice-server 目录跑，或者用 DB_PATH 显式指定。')
  console.error('（只想看怎么用就跑：node src/fix-member.mjs help —— 那个不需要数据库）')
  process.exit(1)
}

/** 动库之前先备份 —— 这种一次性操作最容易手滑 */
function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dst = `${DB}.bak-${stamp}`
  copyFileSync(DB, dst)
  console.log(`已备份 → ${dst}`)
}

const db = new DatabaseSync(DB)

/** 把「多久之前」说成人话 */
function ago(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '从没上线过'
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 90) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  const d = Math.floor(s / 86400)
  if (d < 30) return `${d} 天前`
  return `${Math.floor(d / 30)} 个月前`
}

/**
 * 名册。
 *
 * ⚠️ 判断"谁才是真人"靠的是 **`last_seen` 和 `created_at` 的关系**，
 *    不是单看 `last_seen` ✗：
 *
 *      幽灵（服务端在凭证对不上时凭空造的 ✗）**只在被创建的那一刻上线过一次** ✓
 *      之后再也不来 ✓ → 两个时间几乎相同 ✓
 *
 *      真人会反复上线 ✓ → `last_seen` 明显晚于 `created_at` ✓
 *
 *    所以哪怕幽灵是**今天**才冒出来的 ✗，它的 last_seen 也是"刚刚" ✗ ——
 *    只看 last_seen 会把它和真人混在一起 ✓ 必须比这两个时间 ✓
 */
function list() {
  const rows = db
    .prepare('SELECT user_id, name, role, created_at, last_seen FROM members ORDER BY last_seen DESC')
    .all()

  const byName = new Map()
  for (const r of rows) byName.set(r.name, (byName.get(r.name) ?? 0) + 1)

  /** 上线过几次的替代信号：最后一次在线离创建时间有多久 */
  const lifespan = (r) => Number(r.last_seen) - Number(r.created_at)

  /**
   * 像是幽灵：名字是自动生成的「用户XXXX」、不是管理员、
   * 而且**创建之后基本没再上线过**（容差 10 分钟 —— 首次连接本身要几秒 ✓）
   */
  const looksGhost = (r) =>
    /^用户\d{4}$/.test(r.name) && r.role === 'member' && lifespan(r) < 10 * 60 * 1000

  const ghosts = rows.filter(looksGhost)

  console.log(`\n共 ${rows.length} 个成员（按最后在线时间排，最近的在上）\n`)
  for (const r of rows) {
    const dup = byName.get(r.name) > 1 ? ' ⚠️ 重名' : ''
    const ghost = looksGhost(r) ? ' 👻 疑似幽灵' : ''
    console.log(`  ${String(r.role).padEnd(7)} ${r.name}${dup}${ghost}`)
    console.log(`          ${r.user_id}`)
    console.log(`          创建于   ${ago(Number(r.created_at))}`)
    console.log(`          最后在线 ${ago(Number(r.last_seen))}`)
    if (!looksGhost(r) && /^用户\d{4}$/.test(r.name)) {
      console.log(`          ↑ 名字像自动生成的，但它**后来还上过线** —— 先别删 ✓`)
    }
  }
  console.log('')
  console.log('  判断真人的关键：**创建之后还回来过吗**')
  console.log('    · 「最后在线」明显晚于「创建于」  → 真人 ✓ 别删')
  console.log('    · 两个时间几乎相同 + 名字是「用户XXXX」→ 👻 基本可以删')
  if (ghosts.length > 0) {
    console.log('')
    console.log(`  标了 👻 的有 ${ghosts.length} 个，要删就一条条来（删前会备份）：`)
    for (const g of ghosts) {
      console.log(`    node src/fix-member.mjs delete ${g.user_id}   # ${g.name}`)
    }
  }
  console.log('')
}

if (cmd === 'list') {
  list()
} else if (cmd === 'rename') {
  const [userId, ...nameParts] = rest
  const name = nameParts.join(' ').trim()
  if (!userId || !name) {
    console.error('用法：rename <userId> <新名字>')
    process.exit(1)
  }

  const before = db.prepare('SELECT name, role FROM members WHERE user_id = ?').get(userId)
  if (!before) {
    console.error(`没有这个成员：${userId}`)
    process.exit(1)
  }

  backup()
  // ⚠️ 只动 name —— 角色不该因为改名而变化
  db.prepare('UPDATE members SET name = ? WHERE user_id = ?').run(name, userId)
  console.log(`\n  「${before.name}」 → 「${name}」`)
  console.log(`  角色保持 ${before.role} 不变\n`)
  list()
} else if (cmd === 'promote') {
  const userId = rest[0]
  if (!userId) {
    console.error('用法：promote <userId>')
    process.exit(1)
  }

  const before = db.prepare('SELECT name, role FROM members WHERE user_id = ?').get(userId)
  if (!before) {
    console.error(`没有这个成员：${userId}`)
    process.exit(1)
  }

  backup()
  db.prepare(`UPDATE members SET role = 'admin' WHERE role = 'owner' AND user_id != ?`).run(userId)
  db.prepare(`UPDATE members SET role = 'owner' WHERE user_id = ?`).run(userId)
  console.log(`\n  「${before.name}」 ${before.role} → owner`)
  console.log('  （原来的频道主已降为 admin）\n')
  list()
} else if (cmd === 'delete') {
  const userId = rest[0]
  if (!userId) {
    console.error('用法：delete <userId>')
    process.exit(1)
  }

  const before = db.prepare('SELECT name, role FROM members WHERE user_id = ?').get(userId)
  if (!before) {
    console.error(`没有这个成员：${userId}`)
    process.exit(1)
  }
  if (before.role === 'owner') {
    console.error(`拒绝删除频道主（${before.name}）。要删先把他降级。`)
    process.exit(1)
  }

  backup()
  db.prepare('DELETE FROM members WHERE user_id = ?').run(userId)
  console.log(`\n  已删除「${before.name}」（${userId}）\n`)
  list()
} else {
  console.error(`不认识的命令：${cmd}`)
  process.exit(1)
}

db.close()
