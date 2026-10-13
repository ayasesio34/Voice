import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'text',   -- 'text' | 'voice'
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id   TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body        TEXT NOT NULL,
  -- 附件（图片或文件）的元信息，JSON：{id,name,size,mime}
  -- 存 JSON 而不是拆成列，是因为它就是"消息的一个属性"，
  -- 而且以后想加"多附件"只改这一处
  attachment  TEXT,
  created_at  INTEGER NOT NULL
);

-- 按频道倒序翻页是唯一的查询模式，索引就按这个建
CREATE INDEX IF NOT EXISTS idx_messages_channel
  ON messages (channel_id, id DESC);

-- ─────────────────────────────────────────────────────────────
-- 云端文件
--
-- 文件本体存在磁盘上（uploads/<id>），这里只记元信息。
-- id 是随机 UUID，**不用原始文件名当路径** —— 否则要处理重名、
-- 路径穿越、以及各种奇怪的字符。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  mime          TEXT NOT NULL DEFAULT '',
  uploader_id   TEXT NOT NULL DEFAULT '',
  uploader_name TEXT NOT NULL DEFAULT '',
  -- 这个文件是**从哪传上来的**：
  --   'chat'  = 聊天框里发的（截图、点回形针选的图/文件、待发附件）
  --   'cloud' = 从「云端文件」界面上传的
  --
  -- 为什么要分：云端文件是个"文件柜"，只该放**专门放进去**的东西；
  -- 聊天里随手发的截图不该在那儿堆着。
  scope         TEXT NOT NULL DEFAULT 'chat',
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_created ON files (created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- 成员与角色
--
-- ⚠️ 这里用 user_id（客户端本地生成、长期保存的 UUID），而不是 LiveKit 的
--    identity —— 后者每次连接都重新生成随机后缀，记不住角色。
--
-- user_key 是这个身份的凭证：客户端首次连接时服务端发一个，之后每次连接
-- 都要带上。这样别人光知道你的 userId 也没法冒充你（拿不到 key）。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS members (
  user_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  avatar     TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT 'member',   -- 'owner' | 'admin' | 'member'
  user_key   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_members_role ON members (role);

-- ─────────────────────────────────────────────────────────────
-- 服务器级别的设置（名字、头像等）
-- 用 key-value 而不是固定列：以后加别的设置不用改表结构
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────
-- 私聊
--
-- 为什么同时在 channels 表里建一行：messages.channel_id 有外键指向
-- channels(id)，而且 foreign_keys 是开着的。往 channels 里放一行
-- kind='dm'，就能**完整复用** insertMessage / listMessages / 附件那一整套，
-- 不用为私聊再写一遍。
--
-- 只是 listChannels 必须把它过滤掉 —— 私聊不该出现在左侧频道列表里。
-- 真正的参与者信息放在这张表，用于鉴权和"只发给这两个人"。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dm_channels (
  id         TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  user_a     TEXT NOT NULL,
  user_b     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dm_users ON dm_channels (user_a, user_b);

-- ─────────────────────────────────────────────────────────────
-- 大家上报的游戏：进程名 → 显示名。
--
-- **全服共享**：一个人上报过，所有人都不用再报 —— 客户端连上时
-- 会把这张表拉下来，合并进自己的检测白名单。
--
-- 这是新表，所以 CREATE TABLE IF NOT EXISTS 对老库也生效，不用走 migrate()。
--
-- ⚠️ exe 必须**小写、不带 .exe** —— 和 Windows 上「Get-Process」的
--    ProcessName 对齐。写入前一律规整，不然会出现
--    "同一个游戏有好几条"的情况。
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS games (
  exe        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/** 首次启动时建几个默认频道，免得空库看着一脸懵 */
const DEFAULT_CHANNELS = [
  ['general', '综合', 'text', 0],
  ['voice-1', '语音 1', 'voice', 1],
  ['voice-2', '语音 2', 'voice', 2],
];

export const ROLES = ['owner', 'admin', 'member'];

/**
 * 给**已经存在**的数据库补上后加的列。
 *
 * CREATE TABLE IF NOT EXISTS 只对新库生效 —— 老库的表已经建好了，
 * 新加的列不会自己出现。所以升级时要显式 ALTER。
 */
function migrate(db) {
  const messageCols = db
    .prepare('PRAGMA table_info(messages)')
    .all()
    .map((c) => c.name);

  if (!messageCols.includes('attachment')) {
    db.exec('ALTER TABLE messages ADD COLUMN attachment TEXT');
    console.log('[info] 数据库升级：messages 表新增 attachment 列');
  }

  const fileCols = db
    .prepare('PRAGMA table_info(files)')
    .all()
    .map((c) => c.name);

  if (!fileCols.includes('scope')) {
    // 老数据的归属已经无从考证（聊天和云端混在一起）。
    // 默认成 'chat' —— 这样**云端文件面板会变干净**（正是这次要的效果），
    // 而聊天里的历史附件靠 id 照样取得到，什么都没坏。
    db.exec(`ALTER TABLE files ADD COLUMN scope TEXT NOT NULL DEFAULT 'chat'`);
    console.log('[info] 数据库升级：files 表新增 scope 列（老数据都算作 chat）');
  }
}

/**
 * 打开（必要时创建）SQLite 数据库。
 * WAL 模式让读不阻塞写；小团队场景完全够用，且比 Postgres 省 300~500 MB 内存。
 */
export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(SCHEMA);
  migrate(db);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO channels (id, name, kind, position, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  const now = Date.now();

  db.exec('BEGIN');
  try {
    for (const [id, name, kind, position] of DEFAULT_CHANNELS) {
      insert.run(id, name, kind, position, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return db;
}

// ─────────────────────────────────────────────────────────────
// 频道
// ─────────────────────────────────────────────────────────────

/**
 * 列频道。
 * ⚠️ 私聊（kind='dm'）也在 channels 表里，但**绝不能列出来** ——
 *    它们是两个人的私密会话，不该出现在所有人的侧栏里。
 */
/**
 * 大家上报过的游戏。返回 `{ 进程名: 显示名 }` —— 和客户端那边的形状一致，
 * 省得两头转换。
 */
export function listGames(db) {
  const out = {};
  for (const r of db.prepare('SELECT exe, name FROM games ORDER BY created_at').all()) {
    out[r.exe] = r.name;
  }
  return out;
}

/**
 * 上报/更新一个游戏。
 *
 * ⚠️ 规整一律在这里做（小写、去掉 .exe、截断）——
 *    放调用方做的话，早晚有人漏掉，然后同一个游戏就会出现好几条。
 *
 * 返回 `{ ok, exe, changed }`：同名同 exe 再报一次算没变，
 * 这样调用方可以据此决定要不要广播。
 */
export function upsertGame(db, exe, name) {
  const key = String(exe ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, '')
    .slice(0, 80);
  const display = String(name ?? '').trim().slice(0, 40);

  if (!key || !display) return { ok: false, changed: false };

  const existing = db.prepare('SELECT name FROM games WHERE exe = ?').get(key);
  if (existing && existing.name === display) {
    return { ok: true, exe: key, changed: false };
  }

  db.prepare(
    `INSERT INTO games (exe, name, created_at) VALUES (?, ?, ?)
     ON CONFLICT(exe) DO UPDATE SET name = excluded.name`
  ).run(key, display, Date.now());

  return { ok: true, exe: key, changed: true };
}

export function listChannels(db) {  return db
    .prepare(
      `SELECT id, name, kind, position FROM channels
       WHERE kind != 'dm'
       ORDER BY position, id`
    )
    .all();
}

export function getChannel(db, id) {
  return db.prepare('SELECT id, name, kind FROM channels WHERE id = ?').get(id) ?? null;
}

export function channelExists(db, id) {
  return Boolean(db.prepare('SELECT 1 FROM channels WHERE id = ?').get(id));
}

export function createChannel(db, { id, name, kind }) {
  const row = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM channels').get();
  db.prepare(
    `INSERT INTO channels (id, name, kind, position, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, name, kind, Number(row?.pos ?? 0), Date.now());
  return db.prepare('SELECT id, name, kind, position FROM channels WHERE id = ?').get(id);
}

export function deleteChannel(db, id) {
  // messages 有 ON DELETE CASCADE，会一起删掉
  return db.prepare('DELETE FROM channels WHERE id = ?').run(id).changes > 0;
}

// ─────────────────────────────────────────────────────────────
// 消息
// ─────────────────────────────────────────────────────────────

/** attachment 在库里是 JSON 字符串，读出来时解析成对象 */
function mapMessage(row) {
  if (!row) return row;
  let attachment = null;
  if (row.attachment) {
    try {
      attachment = JSON.parse(row.attachment);
    } catch {
      attachment = null;
    }
  }
  return { ...row, attachment };
}

/**
 * 按 id 取一条消息。
 *
 * 删除时要先拿到它 —— 需要知道两件事：**属于哪个频道**（广播给谁）、
 * **有没有附件**（附件要连着一起删，不然磁盘上会留一堆孤儿文件）。
 */
export function getMessage(db, id) {
  return mapMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id)) ?? null;
}

export function deleteMessage(db, id) {
  return db.prepare('DELETE FROM messages WHERE id = ?').run(id).changes > 0;
}

export function insertMessage(db, { channelId, authorId, authorName, body, attachment }) {
  const info = db
    .prepare(
      `INSERT INTO messages (channel_id, author_id, author_name, body, attachment, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      channelId,
      authorId,
      authorName,
      body,
      attachment ? JSON.stringify(attachment) : null,
      Date.now()
    );

  // node:sqlite 在数值超出安全整数范围时会返回 BigInt，这里统一转成 Number
  return mapMessage(
    db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid))
  );
}

/**
 * 取某频道的最近消息。
 * 用 `id < before` 而不是 OFFSET —— 翻页时不会因为新消息插入而错位。
 */
export function listMessages(db, { channelId, before, limit = 50 }) {
  const rows = before
    ? db
        .prepare(
          `SELECT * FROM messages WHERE channel_id = ? AND id < ?
           ORDER BY id DESC LIMIT ?`
        )
        .all(channelId, before, limit)
    : db
        .prepare(
          `SELECT * FROM messages WHERE channel_id = ?
           ORDER BY id DESC LIMIT ?`
        )
        .all(channelId, limit);

  // 查询是倒序取的（为了拿"最近 N 条"），返回前翻正
  return rows.reverse().map(mapMessage);
}

// ─────────────────────────────────────────────────────────────
// 云端文件
//
// 文件本体躺在磁盘上（uploads/<id>），这里只存元信息。
// **不用原始文件名当路径** —— 否则要处理重名、路径穿越、奇怪字符。
// 原始文件名只在下载时用来生成 Content-Disposition。
// ─────────────────────────────────────────────────────────────

/** 列表上限。文件攒多了以后一次全推给客户端不合适 */
export const FILE_LIST_LIMIT = 300;

const FILE_COLS = `id, name, size, mime, scope,
                   uploader_id AS uploaderId, uploader_name AS uploaderName,
                   created_at AS createdAt`;

/** scope 只认这两个值，别的一律当 chat */
export const FILE_SCOPES = ['chat', 'cloud'];
const normScope = (s) => (FILE_SCOPES.includes(s) ? s : 'chat');

export function insertFile(db, { id, name, size, mime, uploaderId, uploaderName, scope }) {
  db.prepare(
    `INSERT INTO files (id, name, size, mime, uploader_id, uploader_name, scope, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    name,
    size,
    mime,
    uploaderId,
    uploaderName,
    normScope(scope),
    Date.now()
  );

  return getFile(db, id);
}

export function getFile(db, id) {
  return db.prepare(`SELECT ${FILE_COLS} FROM files WHERE id = ?`).get(id) ?? null;
}

/**
 * 文件列表，最新的排在前面。
 *
 * @param scope 只看某一类（'chat' / 'cloud'）。
 *              **云端文件面板传 'cloud'** —— 那是"文件柜"，
 *              只该放专门放进去的东西，聊天里随手发的截图不该堆在那儿。
 */
export function listFiles(db, { scope, limit = FILE_LIST_LIMIT } = {}) {
  if (scope) {
    return db
      .prepare(`SELECT ${FILE_COLS} FROM files WHERE scope = ? ORDER BY created_at DESC LIMIT ?`)
      .all(normScope(scope), limit);
  }
  return db
    .prepare(`SELECT ${FILE_COLS} FROM files ORDER BY created_at DESC LIMIT ?`)
    .all(limit);
}

export function deleteFile(db, id) {
  return db.prepare('DELETE FROM files WHERE id = ?').run(id).changes > 0;
}

/** 文件数量和总占用，用来在界面上显示"已用 XX MB"。同样按 scope 统计 */
export function filesStats(db, scope) {
  const row = scope
    ? db
        .prepare(
          'SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM files WHERE scope = ?'
        )
        .get(normScope(scope))
    : db
        .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM files')
        .get();
  return { count: Number(row?.count ?? 0), bytes: Number(row?.bytes ?? 0) };
}

// ─────────────────────────────────────────────────────────────
// 聊天记录搜索
// ─────────────────────────────────────────────────────────────

/** LIKE 里的通配符要转义，不然用户搜 `%` 会匹配到所有消息 */
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m);
}

/**
 * 在某个频道里搜消息。
 *
 * `q` 是关键词（匹配正文），`authorId` 是只看某个人发的。
 * 两个都给就是"某人说的、且包含这个词"。
 *
 * 返回**最近 N 条匹配**，按时间正序（和普通历史一样的顺序，
 * 前端可以直接复用同一套渲染）。
 */
export function searchMessages(db, { channelId, q, authorId, limit = 100 }) {
  const keyword = String(q ?? '').trim();
  const author = String(authorId ?? '').trim();

  // ⚠️ 一个条件都没有 → 返回**空**，不是"整个频道"。
  //
  //    这是"搜索"不是"列表"：无条件时把历史全倒出来，
  //    调用方十有八九是想错了（比如参数名拼错、或者筛选被清空）。
  //    返回空至少是显眼的"没结果"，返回全量会看起来"搜到了好多"。
  if (!keyword && !author) return [];

  const where = ['channel_id = ?'];
  const args = [channelId];

  if (keyword) {
    where.push(`body LIKE ? ESCAPE '\\'`);
    args.push(`%${escapeLike(keyword)}%`);
  }
  if (author) {
    where.push('author_id = ?');
    args.push(author);
  }

  // 倒序取"最近的 N 条匹配"，返回前翻正 —— 和 listMessages 一个套路
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE ${where.join(' AND ')}
       ORDER BY id DESC LIMIT ?`
    )
    .all(...args, limit);

  return rows.reverse().map(mapMessage);
}

// ─────────────────────────────────────────────────────────────
// 成员与角色
// ─────────────────────────────────────────────────────────────
export function getMember(db, userId) {
  return db.prepare('SELECT * FROM members WHERE user_id = ?').get(userId);
}

export function listMembers(db) {
  return db
    .prepare(
      `SELECT user_id AS userId, name, avatar, role, last_seen AS lastSeen
       FROM members
       ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, name`
    )
    .all();
}

export function hasOwner(db) {
  return Boolean(db.prepare(`SELECT 1 FROM members WHERE role = 'owner' LIMIT 1`).get());
}

/**
 * 把某人设为唯一的频道主，原来那个降为管理员。
 * 任何时刻只有一个 owner —— 权限判断因此可以很简单。
 */
export function makeOwner(db, userId) {
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE members SET role = 'admin' WHERE role = 'owner' AND user_id != ?`).run(
      userId
    );
    db.prepare(`UPDATE members SET role = 'owner' WHERE user_id = ?`).run(userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * 首次连接时登记成员，并在必要时分配角色。
 *
 * 频道主的确定方式有两种：
 *
 *   A. `.env` 里配了 `OWNER_NAME`（推荐）
 *      谁用这个昵称连上，谁就是频道主。**每次连接都会校正一次** ——
 *      所以清了缓存、换了电脑、重装服务器、甚至重建数据库，只要昵称对得上
 *      就能自动拿回频道主，不用再抢、也不用跑 admin.js。
 *      这种情况下**关闭"先到先得"**：没配 OWNER_NAME 的人不会因为先连上就成为频道主。
 *
 *   B. 没配 `OWNER_NAME`
 *      退回"先到先得"：库里还没有 owner 时，第一个连上来的人成为频道主。
 *      方便，但容易被临时连接（比如浏览器测试页）抢先。
 */
export function registerMember(db, { userId, userKey, name, avatar, ownerName = '' }) {
  const existing = getMember(db, userId);
  const now = Date.now();

  const wanted = String(ownerName).trim().toLowerCase();
  const isWantedOwner = Boolean(wanted) && String(name).trim().toLowerCase() === wanted;

  if (existing) {
    db.prepare('UPDATE members SET name = ?, avatar = ?, last_seen = ? WHERE user_id = ?').run(
      name,
      avatar,
      now,
      userId
    );

    // ⚠️ 配了 OWNER_NAME 也不能见名字就提拔。
    //
    //    原来的写法是「名字对上了就 makeOwner」—— 但**任何成员都能在设置里
    //    把昵称改成 OWNER_NAME**，于是谁都能把自己提成频道主，
    //    还会把真正的频道主降级。这是个提权漏洞。
    //
    //    现在只在**还没有频道主**时才认名字（首次搭起来那一次）。
    //    已经有频道主之后的"换电脑拿回频道主"走 `src/fix-member.mjs promote`。
    if (isWantedOwner && existing.role !== 'owner' && !hasOwner(db)) {
      makeOwner(db, userId);
    }
    return getMember(db, userId);
  }

  let role;
  if (isWantedOwner && !hasOwner(db)) {
    // A 路：昵称对上了**而且还没有频道主** —— 首次搭建
    role = 'owner';
  } else if (wanted) {
    role = 'member'; // A 路：配了 OWNER_NAME，别人不参与"先到先得"
  } else {
    role = hasOwner(db) ? 'member' : 'owner'; // B 路：先到先得
  }

  db.prepare(
    `INSERT INTO members (user_id, name, avatar, role, user_key, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, name, avatar, role, userKey, now, now);

  if (role === 'owner') {
    db.prepare(`UPDATE members SET role = 'admin' WHERE role = 'owner' AND user_id != ?`).run(
      userId
    );
  }

  return getMember(db, userId);
}

export function setMemberRole(db, userId, role) {
  if (!ROLES.includes(role)) throw new Error(`非法角色：${role}`);
  return db.prepare('UPDATE members SET role = ? WHERE user_id = ?').run(role, userId).changes > 0;
}

/**
 * 把一个成员从名册里删掉。
 *
 * ⚠️ **只删 members 这一行** —— 他发过的消息、上传的文件都留着。
 *    这是有意的，和 Discord 一样：人走了，聊天记录不该出现空洞
 *    （否则别人看到一段没头没尾的对话，比留着更难受）。
 *
 * ⚠️ 注意这是**踢出**，不是封禁 —— 他的身份没了，但清掉本地配置
 *    就会生成一个新身份，还能再进来。真要挡住人得换邀请码
 *    （`INVITE_CODE`），那才是这个自建服务的准入门槛。
 */
export function removeMember(db, userId) {
  return db.prepare('DELETE FROM members WHERE user_id = ?').run(userId).changes > 0;
}

/** 换名字/头像 */
export function updateMemberProfile(db, userId, { name, avatar }) {
  db.prepare('UPDATE members SET name = ?, avatar = ?, last_seen = ? WHERE user_id = ?').run(
    name,
    avatar,
    Date.now(),
    userId
  );
  return getMember(db, userId);
}

// ─────────────────────────────────────────────────────────────
// 服务器设置
// ─────────────────────────────────────────────────────────────
export const DEFAULT_SERVER_NAME = '我的服务器';

export function getSetting(db, key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

/** 服务器名字和头像。所有客户端都会看到同一份 */
export function getServerInfo(db) {
  return {
    name: getSetting(db, 'server.name', '') || DEFAULT_SERVER_NAME,
    avatar: getSetting(db, 'server.avatar', ''),
  };
}

export function setServerInfo(db, { name, avatar }) {
  if (typeof name === 'string' && name.trim()) {
    setSetting(db, 'server.name', name.trim().slice(0, 32));
  }
  if (typeof avatar === 'string') {
    setSetting(db, 'server.avatar', avatar.slice(0, 200));
  }
  return getServerInfo(db);
}

// ─────────────────────────────────────────────────────────────
// 私聊
// ─────────────────────────────────────────────────────────────

/**
 * 找到（或创建）两个人之间的私聊会话。
 *
 * id 用**排序后的两个 userId** 拼出来 —— 天然唯一，
 * 而且 A→B 和 B→A 拿到的是同一个会话，不会出现两条独立的私聊。
 *
 * 返回会话 id。它同时是 channels 的 id 和 messages 的 channel_id。
 */
export function findOrCreateDm(db, userA, userB) {
  const [a, b] = [userA, userB].sort();
  const id = `dm-${a}-${b}`;

  if (db.prepare('SELECT 1 FROM dm_channels WHERE id = ?').get(id)) return id;

  const now = Date.now();

  db.exec('BEGIN');
  try {
    // channels 那一行只是为了满足 messages.channel_id 的外键，
    // 名字不会被用到（界面上显示的是对方的昵称）
    db.prepare(
      `INSERT OR IGNORE INTO channels (id, name, kind, position, created_at)
       VALUES (?, '私聊', 'dm', 9999, ?)`
    ).run(id, now);

    db.prepare(
      `INSERT OR IGNORE INTO dm_channels (id, user_a, user_b, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(id, a, b, now);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return id;
}

/**
 * 我参与的所有私聊，附带对方的资料。
 * 对方的昵称/头像要实时取 —— 他改了名字，我这边得跟着变。
 */
export function listDmsFor(db, userId) {
  const rows = db
    .prepare(
      `SELECT id,
              CASE WHEN user_a = ? THEN user_b ELSE user_a END AS peer_id
       FROM dm_channels
       WHERE user_a = ? OR user_b = ?
       ORDER BY created_at DESC`
    )
    .all(userId, userId, userId);

  return rows.map((r) => {
    const peer = getMember(db, r.peer_id);
    return {
      id: r.id,
      peerId: r.peer_id,
      peerName: peer?.name ?? '（已注销）',
      peerAvatar: peer?.avatar ?? '',
    };
  });
}

/** 这个私聊里有没有这个人 —— 鉴权用 */
export function isDmMember(db, dmId, userId) {
  return Boolean(
    db
      .prepare('SELECT 1 FROM dm_channels WHERE id = ? AND (user_a = ? OR user_b = ?)')
      .get(dmId, userId, userId)
  );
}

/** 私聊的两个参与者。发消息时用它决定"只发给谁" */
export function dmMembers(db, dmId) {
  const row = db.prepare('SELECT user_a, user_b FROM dm_channels WHERE id = ?').get(dmId);
  return row ? [row.user_a, row.user_b] : [];
}
