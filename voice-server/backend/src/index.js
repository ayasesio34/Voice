import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import {
  openDb,
  listChannels,
  createChannel,
  deleteChannel,
  insertMessage,
  getMessage,
  deleteMessage,
  listMessages,
  searchMessages,
  getMember,
  hasOwner,
  listMembers,
  registerMember,
  setMemberRole,
  removeMember,
  listGames,
  upsertGame,
  getServerInfo,
  setServerInfo,
  insertFile,
  getFile,
  listFiles,
  deleteFile,
  filesStats,
  getChannel,
  findOrCreateDm,
  listDmsFor,
  isDmMember,
  dmMembers,
} from './db.js';
import { createAccessToken, createRoomService } from './livekit.js';
import { createLeaveWatcher } from './voice-chime.js';
import { SERVER_VERSION } from './version.js';

// ─────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH ?? './data/voice.db';

const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: DB_PATH,
  apiKey: process.env.LIVEKIT_API_KEY,
  apiSecret: process.env.LIVEKIT_API_SECRET,
  livekitUrl: process.env.LIVEKIT_URL ?? '',
  // 后端查询 LiveKit 用的地址。必须走本地环回 —— 后端和 LiveKit 在同一台机器上，
  // 而且对外的 ws:// 地址是给客户端用的，服务端调用不该绕公网。
  livekitApiUrl: process.env.LIVEKIT_API_URL ?? 'http://127.0.0.1:7880',
  inviteCode: process.env.INVITE_CODE ?? '',
  /**
   * 频道主的昵称（可选）。
   *
   * 填了之后：谁用这个昵称连上服务器，谁就自动成为频道主 —— 跟本地身份无关。
   * 所以清缓存、换电脑、重装服务器、重建数据库，只要昵称对得上就自动拿回频道主。
   * 留空则退回"先到先得"（第一个连上的人成为频道主）。
   */
  ownerName: process.env.OWNER_NAME ?? '',

  /**
   * 上传文件的存放目录。文件本体存磁盘，元信息存数据库。
   * 默认放在数据库旁边的 uploads/ —— 备份时拷一个目录就够了。
   */
  uploadsDir: process.env.UPLOADS_DIR ?? join(dirname(DB_PATH), 'uploads'),

  /**
   * 单个文件的大小上限。
   *
   * 100 MB：够传高清截图、文档、几分钟的录屏。
   *
   * ⚠️ 上传时文件会**整个读进内存**再落盘（不用 multipart，省一个依赖），
   *    所以真正的风险不是单个文件多大，而是**同时有几个上传**：
   *    3 个人同时传 100 MB 就是 300 MB 内存。2 GB 内存的机器上仍然安全，
   *    但别设得更大。要改就动 .env 里的 MAX_UPLOAD_BYTES。
   *
   * 另外下载会走公网出口流量，注意月度额度。
   */
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024),
};

for (const [key, value] of Object.entries({
  LIVEKIT_API_KEY: config.apiKey,
  LIVEKIT_API_SECRET: config.apiSecret,
  INVITE_CODE: config.inviteCode,
})) {
  if (!value || value.startsWith('change-me') || value === 'REPLACE') {
    console.error(
      `[fatal] ${key} 没有配置或仍是占位值。请先运行 scripts/init.sh，或检查 .env`
    );
    process.exit(1);
  }
}

const db = openDb(config.dbPath);

if (config.ownerName) {
  console.log(
    `[info] OWNER_NAME = ${config.ownerName} —— 用这个昵称连上的人自动成为频道主`
  );
} else {
  console.log('[info] 未配置 OWNER_NAME —— 频道主采用"先到先得"（第一个连上服务器的人）');
}

// 启动时把上传配置打出来 —— 排查"为什么传不上去"时第一眼就看这里
console.log(
  `[info] 上传上限 ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB · ` +
    `文件目录 ${resolve(config.uploadsDir)}`
);

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

/** 定长时间比较，避免用 === 比邀请码时被逐字节计时攻击摸出来 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 把昵称变成安全的 identity 前缀（LiveKit 的 identity 只做唯一性要求，但别塞奇怪字符） */
function slugify(name) {
  const s = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]/g, '');
  return (s || 'user').slice(0, 24);
}

/**
 * 读 /proc/net/dev 拿网卡累计字节数。
 * 容器用 host 网络，所以这里读到的是宿主机真实的收发量 ——
 * 用来盯住"按流量计费"的出口流量很实用。
 */
function readNetDev() {
  const rows = [];
  try {
    const text = readFileSync('/proc/net/dev', 'utf8');
    for (const line of text.split('\n').slice(2)) {
      const m = line.match(/^\s*([^:]+):\s*(.*)$/);
      if (!m) continue;
      const nums = m[2].trim().split(/\s+/).map(Number);
      // /proc/net/dev 每行：rx_bytes ... (8 个) tx_bytes ...
      rows.push({ name: m[1].trim(), rxBytes: nums[0], txBytes: nums[8] });
    }
  } catch {
    // 非 Linux 或 /proc 不可读就返回空，不致命
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────
// Fastify
// ─────────────────────────────────────────────────────────────
const app = Fastify({
  logger: {
    level: 'info',
    // 日志走 stdout，交给 docker 的 json-file driver 轮转
  },
  trustProxy: false,
});

await app.register(cors, { origin: true });
await app.register(rateLimit, {
  max: 300,
  timeWindow: '1 minute',
});
await app.register(websocket);

// ─────────────────────────────────────────────────────────────
// 健康检查
// ─────────────────────────────────────────────────────────────
app.get('/health', async () => ({
  ok: true,
  // ★ 服务端版本 —— 用来确认"服务器上跑的到底是哪一版代码"，
  //   不用再去推断重启时间。来源是 backend/package.json（见 version.js）。
  serverVersion: SERVER_VERSION,
  uptimeSec: Math.round(process.uptime()),
  memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  livekitUrl: config.livekitUrl,
}));

/** 网卡流量快照。前端隔几秒读两次算差值即可得到实时速率。 */
app.get('/api/net', async () => ({
  ts: Date.now(),
  interfaces: readNetDev(),
}));

/** 出口流量累计（只看默认路由那张网卡，通常叫 eth0 或 ens5） */
app.get('/api/net/summary', async () => {
  const ifaces = readNetDev().filter((i) => i.name !== 'lo');
  return {
    ts: Date.now(),
    totalTxBytes: ifaces.reduce((s, i) => s + i.txBytes, 0),
    totalRxBytes: ifaces.reduce((s, i) => s + i.rxBytes, 0),
    interfaces: ifaces,
  };
});

// ─────────────────────────────────────────────────────────────
// 频道
// ─────────────────────────────────────────────────────────────
app.get('/api/channels', async () => ({ channels: listChannels(db) }));

app.get('/api/channels/:id/messages', async (req, reply) => {
  const id = String(req.params.id ?? '');

  // ⚠️ 私聊必须鉴权 —— 不然任何人只要猜到 id 就能读到别人的悄悄话。
  //    id 是 `dm-<idA>-<idB>`，而 userId 是 UUID，猜不到；
  //    但"猜不到"不是安全措施，该挡还是得挡。
  const channel = getChannel(db, id);
  if (!channel) {
    return reply.code(404).send({ error: 'channel_not_found' });
  }

  if (channel.kind === 'dm') {
    const auth = authenticate(req);
    if (auth.error) return reply.code(401).send({ error: auth.error });
    if (!isDmMember(db, id, auth.member.user_id)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  }

  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
  const before = req.query.before ? Number(req.query.before) : undefined;

  // 搜索模式：给了 q（关键词）或 author（只看某人）就走搜索。
  // 两个都给 = "某人说的、且包含这个词"。
  const q = String(req.query.q ?? '').trim();
  const author = String(req.query.author ?? '').trim();
  if (q || author) {
    return {
      messages: searchMessages(db, { channelId: id, q, authorId: author, limit: 200 }),
      search: true,
    };
  }

  return { messages: listMessages(db, { channelId: id, before, limit }) };
});

// ─────────────────────────────────────────────────────────────
// 自动更新的静态文件服务
//
// electron-updater 的 generic provider 会来拉：
//     /updates/latest.yml    ← 版本清单（含文件名和 sha512）
// 然后按清单里的文件名下载安装包。
//
// 挂在现有端口上，所以**不用新开端口、也不用加安全组规则**。
// ⚠️ 明文 http：electron-updater 不强制 https，而这个接口只提供"下载某个文件"，
//    没有任何凭据可泄露；安装包本身有 sha512 校验。
// ─────────────────────────────────────────────────────────────
const UPDATES_DIR = resolve(process.env.UPDATES_DIR ?? '/opt/voice-server/updates');

function contentTypeFor(file) {
  if (file.endsWith('.yml') || file.endsWith('.yaml')) return 'text/yaml; charset=utf-8';
  return 'application/octet-stream';
}

app.get('/updates/*', async (req, reply) => {
  const rel = String(req.params['*'] ?? '');

  // 防目录穿越：拼出来之后必须仍在 UPDATES_DIR 里面
  const full = resolve(join(UPDATES_DIR, rel));
  if (full !== UPDATES_DIR && !full.startsWith(UPDATES_DIR + sep)) {
    return reply.code(403).send({ error: 'forbidden' });
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    return reply.code(404).send({ error: 'not_found' });
  }

  const stat = statSync(full);
  reply.header('Content-Type', contentTypeFor(full));
  reply.header('Content-Length', stat.size);
  reply.header('Cache-Control', 'no-cache');
  return reply.send(createReadStream(full));
});

// ─────────────────────────────────────────────────────────────
// 文件上传 / 下载 / 删除
//
// 上传走**裸二进制 body**，不是 multipart —— 客户端直接
//     fetch(url, { method:'POST', body: file })
// 就行，服务端也就不需要 @fastify/multipart 这个依赖。
//
// 代价是文件会整个读进内存再落盘。配合 MAX_UPLOAD_BYTES（默认 25 MB），
// 在 2 GB 内存的机器上是安全的。
// ─────────────────────────────────────────────────────────────
const UPLOADS_DIR = resolve(config.uploadsDir);
mkdirSync(UPLOADS_DIR, { recursive: true });

app.addContentTypeParser(
  'application/octet-stream',
  { parseAs: 'buffer', bodyLimit: config.maxUploadBytes },
  (_req, body, done) => done(null, body)
);

/**
 * 校验 HTTP 请求的身份。
 *
 * 聊天走 WebSocket，身份在 hello 里建立；HTTP 接口没有那个上下文，
 * 所以把三样东西放请求头带过来：
 *   x-invite-code  —— 门禁
 *   x-user-id      —— 谁
 *   x-user-key     —— 凭证（光知道 userId 冒充不了）
 */
function authenticate(req) {
  if (!safeEqual(req.headers['x-invite-code'] ?? '', config.inviteCode)) {
    return { error: 'invalid_invite_code' };
  }

  const userId = String(req.headers['x-user-id'] ?? '');
  const userKey = String(req.headers['x-user-key'] ?? '');
  const member = userId ? getMember(db, userId) : null;

  if (!member || member.user_key !== userKey) return { error: 'invalid_user' };
  return { member };
}

function canManageRole(member) {
  return Boolean(member && (member.role === 'owner' || member.role === 'admin'));
}

/**
 * 清理文件名。
 * **它只用于显示和下载**，不参与路径拼接（路径用的是随机 UUID），
 * 所以这里只需要去掉控制字符和路径分隔符，不用防穿越。
 */
function sanitizeFileName(name) {
  const cleaned = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim();
  return (cleaned || 'file').slice(0, 120);
}

/** 图片和 PDF 用 inline，这样在浏览器里点开能直接看，而不是被下载 */
function isInlineMime(mime) {
  return /^(image\/(png|jpeg|gif|webp|bmp|svg\+xml)|application\/pdf)$/.test(String(mime));
}

/**
 * 校验客户端提交的附件引用。
 * ⚠️ **必须回库确认文件真的存在** —— 否则客户端可以往消息里塞任意伪造的附件信息。
 */
function normalizeAttachment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const file = getFile(db, String(raw.id ?? ''));
  if (!file) return null;
  return { id: file.id, name: file.name, size: file.size, mime: file.mime };
}

app.post('/api/upload', async (req, reply) => {
  const auth = authenticate(req);
  if (auth.error) return reply.code(401).send({ error: auth.error });

  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return reply.code(400).send({ error: 'empty_body' });
  }
  if (body.length > config.maxUploadBytes) {
    return reply.code(413).send({ error: 'too_large', max: config.maxUploadBytes });
  }

  // 文件名走查询参数 —— 放请求头里的话非 ASCII 名字容易出问题
  const name = sanitizeFileName(req.query?.name);
  const mime = String(req.query?.mime ?? '').slice(0, 120);
  // 从哪传的：聊天框（chat）还是云端文件界面（cloud）。
  // 不传就当 chat —— 老客户端不发这个参数，行为保持"聊天附件"。
  const scope = String(req.query?.scope ?? 'chat') === 'cloud' ? 'cloud' : 'chat';

  const id = randomUUID();
  try {
    writeFileSync(join(UPLOADS_DIR, id), body);
  } catch (err) {
    req.log.error({ err }, '写文件失败');
    return reply.code(500).send({ error: 'write_failed' });
  }

  const file = insertFile(db, {
    id,
    name,
    size: body.length,
    mime,
    uploaderId: auth.member.user_id,
    uploaderName: auth.member.name,
    scope,
  });

  broadcastFiles();
  req.log.info({ id, name, size: body.length, scope, by: auth.member.user_id }, '上传文件');
  return { file, stats: filesStats(db, 'cloud') };
});

app.get('/api/files/:id', async (req, reply) => {
  const file = getFile(db, String(req.params.id ?? ''));
  if (!file) return reply.code(404).send({ error: 'not_found' });

  const full = join(UPLOADS_DIR, file.id);
  if (!existsSync(full)) {
    // 元信息还在但文件没了（手工清过 uploads 目录）
    return reply.code(410).send({ error: 'file_missing' });
  }

  const stat = statSync(full);
  reply.header('Content-Type', file.mime || 'application/octet-stream');
  reply.header('Content-Length', stat.size);
  reply.header(
    'Content-Disposition',
    `${isInlineMime(file.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`
  );
  return reply.send(createReadStream(full));
});

app.delete('/api/files/:id', async (req, reply) => {
  const auth = authenticate(req);
  if (auth.error) return reply.code(401).send({ error: auth.error });

  const file = getFile(db, String(req.params.id ?? ''));
  if (!file) return reply.code(404).send({ error: 'not_found' });

  // 频道主/管理员能删任何文件；普通成员只能删自己传的
  // （自己传错了还得去求管理员删，太别扭了）
  const isMine = file.uploaderId === auth.member.user_id;
  if (!canManageRole(auth.member) && !isMine) {
    return reply.code(403).send({ error: 'forbidden' });
  }

  deleteFile(db, file.id);
  try {
    rmSync(join(UPLOADS_DIR, file.id), { force: true });
  } catch (err) {
    // 元信息已经删了，磁盘上的残留不该让请求失败
    req.log.warn({ err }, '删除文件本体失败');
  }

  broadcastFiles();
  req.log.info({ id: file.id, name: file.name, by: auth.member.user_id }, '删除文件');
  return { ok: true, stats: filesStats(db, 'cloud') };
});

// ─────────────────────────────────────────────────────────────
// 签发 LiveKit token
// ─────────────────────────────────────────────────────────────
app.post(
  '/api/token',
  {
    config: {
      // 邀请码是唯一的口令，限制暴力尝试速度
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
    schema: {
      body: {
        type: 'object',
        required: ['inviteCode', 'room'],
        properties: {
          inviteCode: { type: 'string', maxLength: 128 },
          room: { type: 'string', minLength: 1, maxLength: 64 },
          name: { type: 'string', maxLength: 40 },
          identity: { type: 'string', maxLength: 64 },
        },
      },
    },
  },
  async (req, reply) => {
    const { inviteCode, room, name, identity } = req.body;

    if (!safeEqual(inviteCode, config.inviteCode)) {
      req.log.warn({ ip: req.ip }, '邀请码错误');
      return reply.code(401).send({ error: 'invalid_invite_code' });
    }

    // identity 相同的人会被 LiveKit 踢掉旧的连接，所以强制加随机后缀
    const finalIdentity = identity
      ? `${slugify(identity)}-${randomUUID().slice(0, 8)}`
      : `${slugify(name)}-${randomUUID().slice(0, 8)}`;

    try {
      const token = await createAccessToken({
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        identity: finalIdentity,
        name: name || finalIdentity,
        room,
      });

      return {
        token,
        url: config.livekitUrl,
        room,
        identity: finalIdentity,
      };
    } catch (err) {
      req.log.error({ err }, '签发 token 失败');
      return reply.code(500).send({ error: 'token_sign_failed' });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// 文字频道：WebSocket
//
// 协议（全部是 JSON 文本帧）：
//   客户端 → 服务端
//     { type: 'hello',   name }                      加入
//     { type: 'message', channelId, body }           发言
//     { type: 'typing',  channelId }                 正在输入
//   服务端 → 客户端
//     { type: 'welcome', channels, online }          握手完成
//     { type: 'message', message }                   新消息（含自己发的）
//     { type: 'typing',  channelId, name }
//     { type: 'presence', online }
//     { type: 'error',   error, detail }
// ─────────────────────────────────────────────────────────────

/**
 * 当前在线的人：userId -> { name, avatar, role, sockets }
 * 按 userId 聚合 —— 同一个人开两个设备也只算一个。
 */
const online = new Map();
/**
 * 每个语音房间里当前有哪些人。形如：
 *   { 'voice-1': [{ identity, name }], 'voice-2': [] }
 *
 * 由下面的轮询从 LiveKit 拉取。客户端自己只能看到**它加入的那个**房间，
 * 别的语音频道里是谁，只有服务端问得到。
 */
let voiceSnapshot = {};
let lastVoiceJson = '';

/**
 * 广播给所有在线连接。
 *
 * filter 收到 (userId, entry, ws) 三个参数 —— 需要按"人"筛的时候用得上，
 * 私聊就是靠它做到"只发给会话里的两个人"。
 */
function broadcast(payload, filter) {
  const text = JSON.stringify(payload);
  for (const [userId, entry] of online.entries()) {
    for (const ws of entry.sockets) {
      if (filter && !filter(userId, entry, ws)) continue;
      if (ws.readyState === 1 /* OPEN */) {
        try {
          ws.send(text);
        } catch {
          // 单个连接发失败不该影响其他人
        }
      }
    }
  }
}

/**
 * 规整客户端报上来的"正在做什么"。
 *
 * ⚠️ 这个字段的内容**由客户端提供、然后广播给所有人**，
 *    所以必须当成不可信输入：类型校验 + 长度截断 + 只留认识的字段。
 *    不然别人可以塞一个几十万字的字符串，把所有人的界面撑爆。
 */
function normalizeActivity(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.kind !== 'music' && a.kind !== 'game') return null;

  const title = typeof a.title === 'string' ? a.title.trim().slice(0, 120) : '';
  if (!title) return null;

  return {
    kind: a.kind,
    title,
    // 游戏没有"歌手"这一项；音乐里纯音乐也可能是空串
    artist: typeof a.artist === 'string' ? a.artist.trim().slice(0, 80) : '',
  };
}

/**
 * 当前在线的人。
 * 按 **userId** 而不是连接来聚合 —— 同一个人开两个设备也只算一个。
 */
function presenceList() {
  return [...online.entries()].map(([userId, v]) => ({
    userId,
    name: v.name,
    avatar: v.avatar ?? '',
    role: v.role ?? 'member',
    // 正在听什么。没有就是 null —— 客户端据此决定要不要显示那一行
    activity: v.activity ?? null,
  }));
}

function broadcastPresence() {
  broadcast({ type: 'presence', online: presenceList() });
}

/** 角色变了要广播全量成员表（包括离线成员，他们下次连上还是有角色） */
function broadcastMembers() {
  broadcast({ type: 'members', members: listMembers(db) });
}

/** 频道增删后广播新的频道列表 */
function broadcastChannels() {
  broadcast({ type: 'channels', channels: listChannels(db) });
}

/** 服务器名字/头像改了 */
function broadcastServer() {
  broadcast({ type: 'server', server: getServerInfo(db) });
}

/** 文件列表变了（有人上传或删除）。
 *
 *  ⚠️ 只广播 **scope='cloud'** 的那批 —— 客户端这个列表就是「云端文件」面板。
 *     聊天里发的截图归 'chat'，不进这个面板（但靠 id 照样取得到）。 */
function broadcastFiles() {
  broadcast({ type: 'files', files: listFiles(db, { scope: 'cloud' }), stats: filesStats(db, 'cloud') });
}

/**
 * 把某个人的私聊列表推给他**自己**（其他人不该看到）。
 * 新建私聊、或者对方改了昵称/头像时用得上。
 */
function broadcastDms(userId) {
  broadcast({ type: 'dms', dms: listDmsFor(db, userId) }, (id) => id === userId);
}

// ─────────────────────────────────────────────────────────────
// 语音房间占用情况
//
// 为什么用轮询 Room Service API，而不是 LiveKit 的 webhook：
//   webhook 要改 livekit.yaml、要保留原始 body、要校验签名，
//   为了这点信息不值得。轮询只在**有聊天客户端在线时**才跑，
//   一次 listRooms + 每房间一次 listParticipants，开销可以忽略。
// ─────────────────────────────────────────────────────────────

// LiveKit proto 里 TrackSource 的数值。直接用数字，免得依赖 SDK 是否导出了这个枚举。
//   0 UNKNOWN / 1 CAMERA / 2 MICROPHONE / 3 SCREEN_SHARE / 4 SCREEN_SHARE_AUDIO
const SRC_MICROPHONE = 2;
const SRC_SCREEN_SHARE = 3;

/**
 * 把 LiveKit 的 ParticipantInfo 转成客户端要的形态。
 *
 * 客户端**必须**知道谁闭麦了、谁在共享屏幕 —— 这些信息只在 LiveKit 那边。
 * 光靠聊天的 presence 只能知道"谁在线"。
 */
/**
 * 把一个值转成 number。
 *
 * ⚠️ LiveKit 的 `joinedAt` 是 protobuf 的 **Timestamp**（`{seconds, nanos}`），
 *    而 seconds 是 int64 —— 依 SDK / protobuf 运行时版本，
 *    它可能是 number、string、BigInt 或者 Long 对象。
 *    直接拿去做算术会在其中几种下悄悄变成 NaN。所以统一先过这里。
 */
function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(typeof v?.toString === 'function' ? v.toString() : v);
  return Number.isFinite(n) ? n : 0;
}

/** 加入房间的时间，毫秒。拿不到就是 0（排在并列里最前面，靠 identity 兜底定序） */
function joinTimeMs(p) {
  const j = p?.joinedAt;
  if (!j) return 0;
  if (typeof j === 'object' && 'seconds' in j) {
    return toNum(j.seconds) * 1000 + Math.floor(toNum(j.nanos) / 1e6);
  }
  // 万一哪天 SDK 直接给个"秒"的数字
  return toNum(j) * 1000;
}

function describeParticipant(p) {
  const tracks = p.tracks ?? [];

  const micTrack = tracks.find((t) => t.source === SRC_MICROPHONE);
  const screenTrack = tracks.find((t) => t.source === SRC_SCREEN_SHARE);

  return {
    identity: p.identity,
    name: p.name || p.identity,
    // 有麦克风轨道且没被静音 = 他说话你能听见
    mic: Boolean(micTrack) && !micTrack.muted,
    sharing: Boolean(screenTrack) && !screenTrack.muted,
    // 头像等自定义信息走 participant attributes（客户端连接后自己设置）
    attributes: p.attributes ?? {},
    // ★ 客户端靠它把成员列表**固定**成"进频道的先后顺序"。
    //   不加这个的话列表每轮轮询都会重排，看着像在乱跳（见下面的排序注释）。
    joinedAt: joinTimeMs(p),
  };
}

/**
 * 「离开」提示音的兜底检测。
 *
 * 客户端正常退出时会主动上报（即时），但**关窗口 / 强杀 / 断网**时它没机会上报，
 * 频道里就听不到那一声。轮询顺手做差集来补上。
 *
 * 详细的来龙去脉和去重规则都在 voice-chime.js 里 ——
 * 那个模块是纯逻辑、不直接依赖 broadcast，所以能单测（test-chime-diff.mjs）。
 */
const leaveWatcher = createLeaveWatcher({ broadcast });

const roomService = createRoomService(
  config.livekitApiUrl,
  config.apiKey,
  config.apiSecret
);

async function refreshVoiceRooms() {
  try {
    const rooms = await roomService.listRooms();
    const next = {};

    await Promise.all(
      rooms.map(async (room) => {
        try {
          const participants = await roomService.listParticipants(room.name);

          // ★ **必须排序**。LiveKit 返回参与者列表的顺序不保证稳定
          //   （既不是加入顺序，也不保证两次调用一致）—— 不排的话，
          //   每 3 秒一轮的推送会让同一个房间的人前后跳一次，看着像在乱动。
          //
          //   按加入时间升序 = "谁先进来谁在上面"，而且**永远不变**。
          //   时间相同的（理论上不会）用 identity 兜底，保证结果确定。
          const list = participants.map(describeParticipant);
          list.sort(
            (a, b) =>
              a.joinedAt - b.joinedAt ||
              String(a.identity).localeCompare(String(b.identity))
          );

          next[room.name] = list;
        } catch {
          next[room.name] = [];
        }
      })
    );

    // 内容没变就别广播，省得客户端每 3 秒白重渲染一次
    const json = JSON.stringify(next);
    if (json === lastVoiceJson) return;

    // ★ 必须赶在 voiceSnapshot 被覆盖**之前**做差集 ——
    //   这里 voiceSnapshot 还是上一轮的值，正好拿来做对比。
    leaveWatcher.diff(voiceSnapshot, next);

    lastVoiceJson = json;
    voiceSnapshot = next;
    broadcast({ type: 'voice', rooms: next });
  } catch {
    // LiveKit 没起来 / 暂时不可达 —— 下一轮再试，不致命
  }
}

setInterval(() => {
  if (online.size === 0) return; // 没人在线就不轮询了
  void refreshVoiceRooms();
}, 3000).unref?.();

app.get('/ws', { websocket: true }, (conn, req) => {
  // @fastify/websocket v11 直接给 WebSocket；v8 及更早要给 conn.socket。
  // 两种都兼容一下，免得锁版本。
  const socket = typeof conn?.send === 'function' ? conn : conn?.socket;
  if (!socket) {
    req.log.error('拿不到 WebSocket 句柄，检查 @fastify/websocket 版本');
    return;
  }

  /** 这条连接属于哪个成员（hello 之后才知道） */
  let myUserId = null;
  let joined = false;

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return socket.send(JSON.stringify({ type: 'error', error: 'bad_json' }));
    }
    if (!msg || typeof msg.type !== 'string') return;

    // ── 必须先 hello ────────────────────────────────────────
    if (msg.type === 'hello') {
      if (joined) return;

      // 身份由**客户端**生成并长期保存（见客户端 lib/config.ts 的 ensureIdentity）。
      //
      // ⚠️ 不能让服务端下发。开发模式下 React StrictMode 会把 effect 跑两遍：
      //    第一个 WebSocket 用空 userId 连上来 → 服务端给它造了身份 A（并让它当了频道主）
      //    → StrictMode 清理把它关掉 → 第二个 WebSocket 又用空 userId 连上来 → 造出身份 B。
      //    结果"频道主"锁死在一个再也回不来的身份 A 上。
      //    客户端自己生成就没这问题：两次连接用的是同一对 id + key。
      let userId = typeof msg.userId === 'string' ? msg.userId.slice(0, 64) : '';
      let userKey = typeof msg.userKey === 'string' ? msg.userKey.slice(0, 128) : '';
      let serverIssued = false;

      if (!userId || !userKey) {
        // 没带身份的请求（老客户端、手写的 curl）—— 只能临时发一套
        userId = randomUUID();
        userKey = randomUUID().replace(/-/g, '');
        serverIssued = true;
      }

      let existing = getMember(db, userId);
      // ⚠️ 这里是本次安全修复的核心，改动前后差别很大。
      //
      //    旧行为：userId 对、key 不对 → **静默新建一个成员**，而且
      //    名字**采信客户端传上来的那个**。后果：
      //      · 任何人乱填 userId + 乱填 key + 名字填成 OWNER_NAME，
      //        就能凭空造出一个成员，并且在旧的角色逻辑下直接变成频道主、
      //        把真的频道主降级 —— 这是个提权漏洞；
      //      · 成员列表里会多出一堆同名的人（"多出好几个 Owner"就是这么来的）。
      //
      //    新行为：还是给一个新身份（**不把人卡在外面** —— 直接拒绝连接的话，
      //    配置坏掉的人会看到一个连不上的白屏，很难自己查），但是：
      //      · 名字**不采信客户端**，给一个中性的「用户XXXX」
      //        （和客户端自己生成匿名名是同一套写法）；
      //      · 角色一定是 member，不可能靠这条路拿到频道主。
      if (existing && existing.user_key !== userKey) {
        req.log.warn({ userId }, 'userKey 不匹配，按新用户处理（名字不采信）');
        userId = randomUUID();
        userKey = randomUUID().replace(/-/g, '');
        serverIssued = true;
        existing = null;
        // 覆盖掉客户端报上来的名字，别让它冒充别人
        msg.name = `用户${Math.floor(1000 + Math.random() * 9000)}`;
      }

      const isNewMember = !existing;
      const previousRole = existing?.role;

      // ⚠️ 名字是**客户端说了算**的，所以要在这里收一道。
      //
      //    「频道主叫什么」是名单里最重要的一条信息。如果谁都能把自己改成
      //    那个名字，列表里就会冒出一堆同名的人，分不出哪个是真的 ——
      //    这正是之前那个提权漏洞留下的现象，角色堵住了，名字还得单独堵。
      //
      //    规矩：**频道主的名字由频道主独占**。别人（不管是新来的还是
      //    老成员改昵称）报了同一个名字，就换成一个中性的「用户XXXX」。
      let name = String(msg.name ?? '匿名').slice(0, 40);
      const ownerName = String(config.ownerName ?? '').trim().toLowerCase();
      if (ownerName && name.trim().toLowerCase() === ownerName) {
        // 只有**本来就是频道主**的那个身份可以叫这个名字
        const isOwnerIdentity = existing?.role === 'owner';
        // ⚠️ `hasOwner` 这个条件是**必须**的：
        //    还没有频道主的时候，靠"名字对上"来认领频道主是**唯一**的途径
        //    （首次搭建）。要是这里也拦，就永远没人能叫这个名字、
        //    也就永远没有频道主了 —— 我第一版就写漏了这个条件，测试当场抓到。
        if (!isOwnerIdentity && hasOwner(db)) {
          req.log.warn({ userId, claimed: name }, '有人想用频道主的名字，改成中性名');
          name = `用户${Math.floor(1000 + Math.random() * 9000)}`;
        }
      }

      // 头像是客户端序列化成字符串传上来的（形如 {"color":"#5865f2","emoji":"🐱"}）
      const avatar = typeof msg.avatar === 'string' ? msg.avatar.slice(0, 200) : '';

      const member = registerMember(db, {
        userId,
        userKey,
        name,
        avatar,
        ownerName: config.ownerName,
      });

      joined = true;
      myUserId = member.user_id;

      const entry = online.get(member.user_id) ?? { sockets: new Set() };
      entry.name = member.name;
      entry.avatar = member.avatar;
      entry.role = member.role;
      entry.sockets.add(socket);
      online.set(member.user_id, entry);

      socket.send(
        JSON.stringify({
          type: 'welcome',
          userId: member.user_id,
          // 只有服务端临时造的身份才需要回传；客户端自己生成的那种它本地已经有了
          userKey: serverIssued ? userKey : undefined,
          name: member.name,
          role: member.role,
          channels: listChannels(db),
          members: listMembers(db),
          online: presenceList(),
          /**
           * 大家上报过的游戏（进程名 → 显示名）。
           *
           * 客户端连上时拉一份、合并进自己的检测白名单 ——
           * 这样**一个人上报过，所有人都能检测到**，不用各报各的。
           */
          games: listGames(db),
          // 服务器名字/头像是全局的，所有客户端应该看到同一份
          server: getServerInfo(db),
          // 连上时先把当前每个语音频道里有哪些人告诉客户端，
          // 不用等下一次轮询
          voice: voiceSnapshot,
          // 云端文件列表（最新的前 300 个）和总占用。
          // 只看 scope='cloud' —— 聊天里发的截图不算"云端文件"
          files: listFiles(db, { scope: 'cloud' }),
          fileStats: filesStats(db, 'cloud'),
          // 我的私聊（只有我自己的，别人看不到）
          dms: listDmsFor(db, member.user_id),
        })
      );

      broadcastPresence();
      broadcastMembers();

      // 角色发生变化时（首次分配、或配了 OWNER_NAME 被自动校正）记一条日志。
      // 万一频道主落到了意外的人身上，从日志就能看出来是谁。
      if (member.role === 'owner' && previousRole !== 'owner') {
        req.log.warn(
          {
            userId: member.user_id,
            name: member.name,
            ownerName: config.ownerName || '（未配置 OWNER_NAME，先到先得）',
            isNewMember,
          },
          '已把这个人设为频道主'
        );
      }

      req.log.info(
        { userId: member.user_id, name: member.name, role: member.role },
        'ws 加入'
      );
      return;
    }

    if (!joined) {
      return socket.send(JSON.stringify({ type: 'error', error: 'not_joined' }));
    }

    const actor = getMember(db, myUserId);
    const canManage = Boolean(actor && (actor.role === 'owner' || actor.role === 'admin'));
    const deny = (error) =>
      socket.send(JSON.stringify({ type: 'error', error, requestId: msg.requestId }));

    // ── 文字消息（频道 + 私聊）────────────────────────────────
    if (msg.type === 'message') {
      const channelId = String(msg.channelId ?? '');
      const body = String(msg.body ?? '').trim();
      const attachment = normalizeAttachment(msg.attachment);

      // 允许"只有附件、没有文字"的消息（直接拖张图发出去）
      if (!body && !attachment) return;
      if (body.length > 4000) {
        return socket.send(JSON.stringify({ type: 'error', error: 'message_too_long' }));
      }

      const target = getChannel(db, channelId);
      if (!target) {
        return socket.send(JSON.stringify({ type: 'error', error: 'channel_not_found' }));
      }

      // 私聊：先确认自己确实是会话里的人
      const isDm = target.kind === 'dm';
      if (isDm && !isDmMember(db, channelId, myUserId)) {
        return deny('forbidden');
      }

      const row = insertMessage(db, {
        channelId,
        authorId: myUserId,
        authorName: actor?.name ?? '匿名',
        body,
        attachment,
      });

      if (isDm) {
        // ⚠️ 私聊**绝不能**用全体广播 —— 只发给会话里的两个人。
        //    这里是整个私聊功能里最容易写漏、后果也最严重的一行。
        const members = new Set(dmMembers(db, channelId));
        broadcast({ type: 'message', message: row }, (userId) => members.has(userId));
      } else {
        broadcast({ type: 'message', message: row });
      }
      return;
    }

    // ── 删除一条消息 ────────────────────────────────────────
    //
    // 权限：
    //   · 频道消息 —— 只有频道主 / 管理员
    //   · 私聊消息 —— **不看角色**，只有会话里的两个人
    //
    //   私聊那条很重要：不然管理员能翻着别人的悄悄话一条条删，
    //   而私聊的全部意义就是"别人看不到"。
    if (msg.type === 'deleteMessage') {
      const id = Number(msg.id);
      if (!Number.isInteger(id)) return deny('bad_request');

      const row = getMessage(db, id);
      // 已经被删掉了（比如两个管理员同时点）—— 幂等，直接当成功
      if (!row) return;

      const target = getChannel(db, row.channel_id);
      if (!target) return;

      const isDm = target.kind === 'dm';
      if (isDm) {
        if (!isDmMember(db, row.channel_id, myUserId)) return deny('forbidden');
      } else if (!canManage) {
        return deny('forbidden');
      }

      deleteMessage(db, id);

      // ★ 附件要**连着一起删**。
      //   只删消息行的话，uploads/ 里会攒下一堆再也没人引用的文件 ——
      //   它们既不在聊天里显示，也不在云端文件面板里（scope='chat'），
      //   但磁盘照样被占着。删了消息还留着文件，等于"删除"没生效。
      if (row.attachment?.id) {
        deleteFile(db, row.attachment.id);
        try {
          rmSync(join(UPLOADS_DIR, row.attachment.id), { force: true });
        } catch {
          // 元信息已经删了，磁盘上的残留不该让整个删除失败
        }
        broadcastFiles();
      }

      const payload = { type: 'messageDeleted', id, channelId: row.channel_id };
      if (isDm) {
        const members = new Set(dmMembers(db, row.channel_id));
        broadcast(payload, (userId) => members.has(userId));
      } else {
        broadcast(payload);
      }
      return;
    }

    // ── 「正在听歌」─────────────────────────────────────────
    //
    // 客户端**本地**检测（读 Windows 的 SMTC），只有开着开关才上报。
    // 关掉开关时客户端连这条消息都不发 —— 服务端这边什么都收不到，
    // 而不是"收了但不广播"。那样隐私是假的。
    if (msg.type === 'setActivity') {
      const entry = online.get(myUserId);
      if (!entry) return;

      const next = normalizeActivity(msg.activity);
      const prev = entry.activity ?? null;

      // 没变就别广播。客户端每几秒可能报一次，不比对的话
      // 整个在线列表会被无意义地刷新一遍。
      if (JSON.stringify(prev) === JSON.stringify(next)) return;

      entry.activity = next;
      broadcastPresence();
      return;
    }

    // ── 上报没被认出来的游戏（**全服共享**）──────────────────
    //
    // 和"正在玩什么"不是一回事：那条是**实时状态**（只给在线的人看），
    // 这条是**长期数据** —— 一个人报过，所有人以后都能检测到。
    //
    // ⚠️ 任何已加入的成员都能报，不需要管理员。这是有意的：
    //    游戏库本来就该由用的人一起补，而且最坏情况也只是多一条
    //    名字不太对的映射，删掉就是了。
    if (msg.type === 'reportGame') {
      // 规整和校验都在 upsertGame 里（小写、去 .exe、截断）——
      // 放这里做的话早晚会和别处不一致。
      const r = upsertGame(db, msg.exe, msg.name);
      if (!r.ok) return deny('bad_game');

      // 同名同 exe 再报一次算没变 —— 不广播，省得所有人白刷新一遍
      if (r.changed) {
        broadcast({ type: 'games', games: listGames(db) });
        req.log.info({ exe: r.exe, by: myUserId }, '上报游戏');
      }

      socket.send(
        JSON.stringify({ type: 'ok', requestId: msg.requestId, games: listGames(db) })
      );
      return;
    }

    if (msg.type === 'typing') {      broadcast(
        {
          type: 'typing',
          channelId: String(msg.channelId ?? ''),
          name: actor?.name ?? '匿名',
        },
        (_userId, entry) => entry.sockets.has(socket) === false // 不回给自己
      );
      return;
    }

    // ── 私聊 ────────────────────────────────────────────────
    if (msg.type === 'openDm') {
      const peerId = String(msg.userId ?? '');
      if (!peerId || peerId === myUserId) return deny('invalid_target');

      const peer = getMember(db, peerId);
      if (!peer) return deny('member_not_found');

      const id = findOrCreateDm(db, myUserId, peerId);

      // 对方的列表也要更新 —— 他可能正开着客户端，得立刻看到这个新会话
      broadcastDms(peerId);
      broadcastDms(myUserId);

      // 额外给发起方一条 dm 消息，客户端收到就直接把私聊页打开
      socket.send(
        JSON.stringify({
          type: 'dm',
          requestId: msg.requestId,
          dm: {
            id,
            peerId,
            peerName: peer.name,
            peerAvatar: peer.avatar ?? '',
          },
        })
      );
      req.log.info({ dm: id, by: myUserId, peer: peerId }, '打开私聊');
      return;
    }

    // ── 进出语音频道的提示音 ────────────────────────────────
    // 客户端自己知道什么时候进了/出了语音房间（那是 LiveKit 的事，
    // 但要等下一次轮询才知道，最多慢 3 秒），所以由它主动上报。
    //
    // 服务端只负责**广播给所有人** —— 提示音得让所有人都听得见，
    // 而不是从进频道那个人的麦克风里传出来（那样他一闭麦别人就听不到了）。
    if (msg.type === 'voiceChime') {
      const room = String(msg.room ?? '').slice(0, 64);

      // 记一笔给轮询那边去重 —— 它最多 3 秒后也会发现这个人不见了，
      // 不标记的话留在频道里的人会听到两声"离开"。
      // 反过来，"重新进来"要把标记清掉，否则下次真掉线会被旧标记误吞。
      if (actor) {
        if (msg.joined) leaveWatcher.noteRejoined(room, actor.user_id);
        else leaveWatcher.noteReported(room, actor.user_id);
      }

      broadcast({
        type: 'chime',
        kind: msg.joined ? 'join' : 'leave',
        name: actor?.name ?? '匿名',
        room,
      });
      return;
    }

    // ── 移除成员（只有频道主）────────────────────────────────
    //
    // 放在服务端而不是"客户端藏着按钮"：藏按钮只是不给入口，
    // 伪造一条消息照样能删人。所以权限判断必须在这儿。
    if (msg.type === 'removeMember') {
      if (!actor || actor.role !== 'owner') return deny('forbidden');

      const targetId = String(msg.userId ?? '');
      const target = getMember(db, targetId);
      if (!target) return deny('not_found'); // 已经不在了
      // ⚠️ 自己这条要放在**前面**：频道主也是 owner，
      //    顺序反了的话"移除自己"会命中下面那条、报出
      //    "不能移除频道主"这种看不出问题的提示。
      if (targetId === myUserId) return deny('cannot_remove_self');
      if (target.role === 'owner') return deny('cannot_remove_owner');

      removeMember(db, targetId);

      // ⚠️ 光删库不够 —— 他的 WebSocket 还连着，会一直挂在在线列表里，
      //    直到他自己关掉应用为止。得把连接也踢掉。
      const entry = online.get(targetId);
      if (entry) {
        for (const s of entry.sockets) {
          try {
            s.send(JSON.stringify({ type: 'removed' }));
            s.close();
          } catch {
            /* 已经断了 */
          }
        }
        online.delete(targetId);
      }

      broadcastMembers();
      broadcastPresence();
      req.log.info({ target: targetId, name: target.name, by: myUserId }, '移除成员');
      broadcast({ type: 'ok', requestId: msg.requestId });
      return;
    }

    // ── 频道管理（管理员以上）──────────────────────────────
    if (msg.type === 'createChannel') {
      if (!canManage) return deny('forbidden');

      const rawName = String(msg.name ?? '').trim().slice(0, 24);
      const kind = msg.kind === 'voice' ? 'voice' : 'text';
      if (!rawName) return deny('empty_name');

      // 频道 id 同时也是 LiveKit 的房间名，所以用「名字 slug + 短随机后缀」
      const id = `${slugify(rawName) || 'ch'}-${randomUUID().slice(0, 4)}`;
      const channel = createChannel(db, { id, name: rawName, kind });

      broadcastChannels();
      broadcast({ type: 'ok', requestId: msg.requestId, channel });
      req.log.info({ id, name: rawName, kind, by: myUserId }, '创建频道');
      return;
    }

    if (msg.type === 'deleteChannel') {
      if (!canManage) return deny('forbidden');

      const id = String(msg.channelId ?? '');
      if (id === 'general') return deny('cannot_delete_default'); // 至少留一个文字频道

      // 私聊会话也在 channels 表里，但**不能通过这个入口删** ——
      // 界面上根本不会列出它们，能走到这里就说明是构造的请求
      const target = getChannel(db, id);
      if (target?.kind === 'dm') return deny('forbidden');

      if (!deleteChannel(db, id)) return deny('channel_not_found');

      broadcastChannels();
      broadcast({ type: 'ok', requestId: msg.requestId });
      req.log.info({ id, by: myUserId }, '删除频道');
      return;
    }

    // ── 服务器名字 / 头像（管理员以上）─────────────────────
    if (msg.type === 'updateServer') {
      if (!canManage) return deny('forbidden');

      const server = setServerInfo(db, {
        name: typeof msg.name === 'string' ? msg.name : undefined,
        avatar: typeof msg.avatar === 'string' ? msg.avatar : undefined,
      });

      broadcastServer();
      broadcast({ type: 'ok', requestId: msg.requestId, server });
      req.log.info({ server, by: myUserId }, '更新服务器信息');
      return;
    }

    // ── 角色管理（仅频道主）────────────────────────────────
    if (msg.type === 'setRole') {
      if (!actor || actor.role !== 'owner') return deny('owner_only');

      const targetId = String(msg.userId ?? '');
      const role = String(msg.role ?? '');
      const target = getMember(db, targetId);

      if (!target) return deny('member_not_found');
      if (target.role === 'owner') return deny('cannot_change_owner');
      if (role !== 'admin' && role !== 'member') return deny('invalid_role');

      setMemberRole(db, targetId, role);
      broadcastMembers();
      broadcast({ type: 'ok', requestId: msg.requestId });
      req.log.info({ targetId, role, by: myUserId }, '变更角色');
      return;
    }
  });

  socket.on('close', () => {
    if (!myUserId) return;
    const entry = online.get(myUserId);
    if (entry) {
      entry.sockets.delete(socket);
      if (entry.sockets.size === 0) online.delete(myUserId);
    }
    if (joined) {
      broadcastPresence();
      req.log.info({ userId: myUserId }, 'ws 离开');
    }
  });

  socket.on('error', (err) => {
    req.log.warn({ err, userId: myUserId }, 'ws 出错');
  });
});

// ─────────────────────────────────────────────────────────────
// 启动 / 优雅退出
// ─────────────────────────────────────────────────────────────
await app.listen({ port: config.port, host: config.host });

// 启动时把版本号打出来 —— journalctl 里能直接看到"这次起的是哪一版"
app.log.info(
  { serverVersion: SERVER_VERSION, port: config.port },
  `voice-backend v${SERVER_VERSION} 已启动`
);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    app.log.info(`收到 ${signal}，正在关闭…`);
    try {
      await app.close();
      db.close();
    } finally {
      process.exit(0);
    }
  });
}
