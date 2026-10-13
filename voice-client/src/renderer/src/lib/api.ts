import type { AppConfig } from './config'
import type { Activity, MemberInfo, MemberRef, Role, VoiceRooms } from './names'

export type TokenResponse = {
  token: string
  url: string
  room: string
  identity: string
}

export type ChannelInfo = {
  id: string
  name: string
  kind: 'text' | 'voice'
}

/** 消息里的附件引用。服务端会回库确认它真的存在，客户端伪造不了 */
export type FileRef = {
  id: string
  name: string
  size: number
  mime: string
}

/** 云端文件列表里的一项 */
export type CloudFile = FileRef & {
  uploaderId: string
  uploaderName: string
  createdAt: number
}

export type FilesStats = {
  count: number
  bytes: number
}

export type ChatMessage = {
  id: number
  channel_id: string
  author_id: string
  author_name: string
  body: string
  /** 附件。纯文字消息和老消息都是 null */
  attachment?: FileRef | null
  created_at: number
}

/**
 * 向后端申请 LiveKit 接入 token。
 *
 * ⚠️ LIVEKIT_API_SECRET 只在服务端，绝对不要打包进客户端 ——
 *    客户端只拿这里返回的短期 token。
 */
export async function fetchToken(
  cfg: AppConfig,
  room: string,
  name: string
): Promise<TokenResponse> {
  const base = cfg.apiUrl.replace(/\/+$/, '')
  const res = await fetch(`${base}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inviteCode: cfg.inviteCode, room, name }),
  })

  if (res.status === 401) throw new Error('邀请码不对')
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`服务端返回 ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`)
  }

  return (await res.json()) as TokenResponse
}

export type ChatProfile = {
  name: string
  /** 序列化后的头像字符串 */
  avatar: string
  /** 服务端上次下发的用户 id，首次连接传空 */
  userId: string
  /** 服务端上次下发的凭证，首次连接传空 */
  userKey: string
}

export type ServerInfo = {
  name: string
  /** 序列化后的头像 */
  avatar: string
}

/**
 * 一个私聊会话。
 *
 * `id` 同时是 messages 表里的 channel_id（服务端复用频道那套存消息）。
 * `peer*` 是对方的资料 —— 界面上显示的是**人**，不是会话。
 */
export type DmInfo = {
  id: string
  peerId: string
  peerName: string
  peerAvatar: string
}

export type ChatHandlers = {
  onWelcome?: (info: {
    /** 服务端下发的稳定用户 id —— 必须存起来 */
    userId: string
    /** 只在首次登记时下发。丢了就找不回角色 */
    userKey?: string
    name: string
    role: Role
    channels: ChannelInfo[]
    members: MemberInfo[]
    online: MemberRef[]
    server: ServerInfo
    voice?: VoiceRooms
    files?: CloudFile[]
    fileStats?: FilesStats
    dms?: DmInfo[]
    /** 全服共享的游戏表（别人上报过的） */
    games?: Record<string, string>
  }) => void
  onMessage?: (msg: ChatMessage) => void
  /**
   * 一条消息被删了。
   *
   * 带上 channelId 是因为**别的频道**的消息也会推过来 ——
   * 客户端得知道该从哪个会话的列表里摘掉它。
   */
  onMessageDeleted?: (id: number, channelId: string) => void
  onPresence?: (online: MemberRef[]) => void
  /** 频道列表有变化（别人创建/删除了频道）*/
  onChannels?: (channels: ChannelInfo[]) => void
  /** 成员表有变化（有人被设成管理员、改了昵称/头像）*/
  onMembers?: (members: MemberInfo[]) => void
  /** 服务器名字/头像有变化 */
  onServer?: (server: ServerInfo) => void
  /** 云端文件列表有变化（有人上传或删除）*/
  onFiles?: (files: CloudFile[], stats: FilesStats) => void
  /** 我的私聊列表有变化。服务端只推给当事人 */
  onDms?: (dms: DmInfo[]) => void
  /** 有人发起了（或我发起了）一个私聊 —— 客户端据此把私聊页打开 */
  onDmOpen?: (dm: DmInfo) => void
  /**
   * 有人进出语音频道 —— **广播给所有人**，据此放提示音。
   * 进和出的音效不同，所以带上 kind。
   */
  onChime?: (kind: 'join' | 'leave', name: string, room: string) => void
  /** 语音频道占用情况有变化（服务端每 3 秒轮询 LiveKit，有变化才推） */
  onVoice?: (rooms: VoiceRooms) => void
  onError?: (text: string, requestId?: string) => void
  /** 管理操作成功的回执。requestId 是发起时给的，用来对上号 */
  onOk?: (requestId?: string) => void
  onOpen?: () => void
  onClose?: () => void
  /** 我被频道主移出服务器了（服务端随后会断开连接） */
  onRemoved?: () => void
  /**
   * 全服共享的游戏表（上报的）。
   * 来自 `welcome` 和后续的 `games` 广播 —— 两处都要接。
   */
  onGames?: (games: Record<string, string>) => void
}

export type ChatConnection = {
  close: () => void
  /** 发送一条聊天消息。attachment 是已经上传好的文件。返回 false 表示连接不可用。 */
  send: (channelId: string, body: string, attachment?: FileRef | null) => boolean
  /**
   * 删一条消息。
   *
   * 服务端会自己判权限（频道消息要管理员以上、私聊要会话成员），
   * 删完广播 `messageDeleted` —— **所有客户端同时消失**，不只是自己这儿。
   */
  deleteMessage: (id: number, requestId?: string) => boolean
  /** 创建频道（需要管理员以上权限）*/
  createChannel: (name: string, kind: 'text' | 'voice', requestId?: string) => boolean
  /** 删除频道（需要管理员以上权限）*/
  deleteChannel: (channelId: string, requestId?: string) => boolean
  /** 设置角色（仅频道主）*/
  setRole: (userId: string, role: 'admin' | 'member', requestId?: string) => boolean
  /** 改服务器名字/头像（需要管理员以上权限）*/
  updateServer: (name: string, avatar: string, requestId?: string) => boolean
  /**
   * 上报"我正在听什么"。
   *
   * 传 null 表示不听了。**关掉设置里的检测开关时客户端根本不会调它** ——
   * 服务端也就什么都收不到。
   */
  setActivity: (activity: Activity | null) => boolean

  /**
   * 把一个成员移出服务器（**只有频道主能调用**）。
   *
   * ⚠️ 这是踢出，不是封禁：他的身份被删了，但清掉本地配置重新
   *    连一次就会拿到新身份再进来。真要挡住人得换邀请码。
   */
  removeMember: (userId: string) => boolean

  /**
   * 上报一个没被认出来的游戏（**全服共享**）。
   *
   * 一个人报过，所有人以后都能检测到 —— 所以这是发到服务端的，
   * 不是只存本地。
   */
  reportGame: (exe: string, name: string) => boolean

  /** 打开和某人的私聊。
   * 会话不存在时服务端会建一个；成功后会推一条 `dm` 回来（见 onDmOpen）。
   */
  openDm: (userId: string, requestId?: string) => boolean
  /**
   * 上报"我进了/出了某个语音频道"。
   * 服务端会广播给所有人，让大家都听到提示音。
   */
  voiceChime: (room: string, joined: boolean) => boolean
}

const CLOSED: ChatConnection = {
  close: () => {},
  send: () => false,
  deleteMessage: () => false,
  setActivity: () => false,
  removeMember: () => false,
  reportGame: () => false,
  createChannel: () => false,
  deleteChannel: () => false,
  setRole: () => false,
  updateServer: () => false,
  openDm: () => false,
  voiceChime: () => false,
}

/** 错误码 -> 中文提示。服务端只回代码，措辞放在客户端，好改也好翻译 */
export const ERROR_TEXT: Record<string, string> = {
  bad_json: '发出去的数据格式不对',
  not_joined: '还没完成握手',
  message_too_long: '消息太长了',
  channel_not_found: '频道不存在',
  forbidden: '你没有权限做这个操作',
  empty_name: '名字不能为空',
  cannot_delete_default: '默认频道不能删除',
  owner_only: '只有频道主能做这个操作',
  member_not_found: '找不到这个成员',
  cannot_change_owner: '不能修改频道主的角色',
  invalid_role: '角色不合法',
  invalid_target: '不能和自己私聊',
}

export function errorText(code: string): string {
  return ERROR_TEXT[code] ?? `服务端返回错误：${code}`
}

/** 打开文字频道的 WebSocket。 */
export function openChat(
  cfg: AppConfig,
  profile: ChatProfile,
  handlers: ChatHandlers
): ChatConnection {
  const wsUrl =
    cfg.apiUrl.replace(/\/+$/, '').replace(/^http/, 'ws') +
    '/ws?name=' +
    encodeURIComponent(profile.name)

  let ws: WebSocket
  try {
    ws = new WebSocket(wsUrl)
  } catch (err) {
    handlers.onError?.(`聊天连接建立失败：${(err as Error).message}`)
    return CLOSED
  }

  const sendJson = (payload: unknown): boolean => {
    if (ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(payload))
    return true
  }

  ws.onopen = () => {
    // 头像跟着握手包一起上去，服务端存进成员表，别人的列表里就能看到
    sendJson({
      type: 'hello',
      name: profile.name,
      avatar: profile.avatar,
      userId: profile.userId,
      userKey: profile.userKey,
    })
    handlers.onOpen?.()
  }

  ws.onmessage = (ev) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    switch (msg.type) {
      case 'welcome':
        handlers.onWelcome?.(msg as never)
        break
      /**
       * **全服共享**的游戏表变了（有人上报了新的）。
       *
       * 拿到就交给主进程去更新检测白名单 —— 这样别人报过的游戏，
       * 你这边不用再做任何事就能被检测到。
       */
      case 'games':
        handlers.onGames?.(msg.games as Record<string, string>)
        break
      case 'message':
        handlers.onMessage?.(msg.message as ChatMessage)
        break
      case 'messageDeleted':
        handlers.onMessageDeleted?.(Number(msg.id), String(msg.channelId ?? ''))
        break
      case 'presence':
        handlers.onPresence?.(msg.online as MemberRef[])
        break
      case 'voice':
        handlers.onVoice?.(msg.rooms as VoiceRooms)
        break
      case 'channels':
        handlers.onChannels?.(msg.channels as ChannelInfo[])
        break
      case 'members':
        handlers.onMembers?.(msg.members as MemberInfo[])
        break
      case 'server':
        handlers.onServer?.(msg.server as ServerInfo)
        break
      case 'files':
        handlers.onFiles?.(msg.files as CloudFile[], msg.stats as FilesStats)
        break
      case 'dms':
        handlers.onDms?.(msg.dms as DmInfo[])
        break
      case 'dm':
        handlers.onDmOpen?.(msg.dm as DmInfo)
        break
      case 'chime':
        // room 一定要带出去 —— 上层只放**自己所在频道**的提示音。
        // 服务端是广播给所有人的（它靠轮询才知道谁在哪个房间，太慢），
        // 过滤只能在客户端做。
        handlers.onChime?.(
          msg.kind === 'leave' ? 'leave' : 'join',
          String(msg.name ?? ''),
          String(msg.room ?? '')
        )
        break
      case 'ok':
        handlers.onOk?.(msg.requestId as string | undefined)
        break
      /**
       * 我被移出服务器了。服务端紧接着就会断开连接。
       *
       * App 里没有自动重连，所以断开之后就不会自己回来 ——
       * 这正是"踢出"该有的效果。用户重启应用还是会以**新身份**进来
       * （身份被删了，服务端会当成新用户），那是踢出的固有边界。
       */
      case 'removed':
        handlers.onRemoved?.()
        break
      case 'error':
        handlers.onError?.(
          errorText(String(msg.error)),
          msg.requestId as string | undefined
        )
        break
    }
  }

  ws.onerror = () => handlers.onError?.('聊天连接出错（后端跑起来了吗？）')
  ws.onclose = () => handlers.onClose?.()

  return {
    close: () => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    },
    send: (channelId, body, attachment) =>
      sendJson({ type: 'message', channelId, body, attachment: attachment ?? undefined }),
    deleteMessage: (id, requestId) => sendJson({ type: 'deleteMessage', id, requestId }),
    setActivity: (activity) => sendJson({ type: 'setActivity', activity }),
    removeMember: (userId) => sendJson({ type: 'removeMember', userId }),
    reportGame: (exe, name) => sendJson({ type: 'reportGame', exe, name }),
    createChannel: (name, kind, requestId) =>
      sendJson({ type: 'createChannel', name, kind, requestId }),
    deleteChannel: (channelId, requestId) =>
      sendJson({ type: 'deleteChannel', channelId, requestId }),
    setRole: (userId, role, requestId) =>
      sendJson({ type: 'setRole', userId, role, requestId }),
    updateServer: (name, avatar, requestId) =>
      sendJson({ type: 'updateServer', name, avatar, requestId }),
    openDm: (userId, requestId) => sendJson({ type: 'openDm', userId, requestId }),
    voiceChime: (room, joined) => sendJson({ type: 'voiceChime', room, joined }),
  }
}

/**
 * 拉某个会话的历史消息。
 *
 * 频道和私聊走的是同一个接口 —— 服务端把私聊也存成"频道"了。
 * 带身份头是因为**私聊必须鉴权**：不带的话服务端读不到 userId，
 * 会直接回 401。
 */
export async function fetchMessages(
  cfg: AppConfig,
  channelId: string,
  limit = 50
): Promise<ChatMessage[]> {
  const url = `${apiBase(cfg)}/api/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}`
  const res = await fetch(url, { headers: authHeaders(cfg) })
  if (!res.ok) return []
  const data = (await res.json()) as { messages?: ChatMessage[] }
  return data.messages ?? []
}

/**
 * 搜索某个会话的聊天记录。
 *
 * `q` 是关键词（匹配正文），`authorId` 是只看某个人发的 ——
 * 两个都给就是"某人说的、且包含这个词"。至少给一个，否则没必要调这个接口。
 *
 * 搜索在**服务端**做，因为客户端只加载了最近 50 条 ——
 * 在本地过滤的话，"搜索聊天记录"实际只能搜到最后几页，很误导。
 */
export async function searchMessages(
  cfg: AppConfig,
  channelId: string,
  opts: { q?: string; authorId?: string }
): Promise<ChatMessage[]> {
  const qs = new URLSearchParams()
  if (opts.q?.trim()) qs.set('q', opts.q.trim())
  if (opts.authorId) qs.set('author', opts.authorId)
  if (![...qs.keys()].length) return []

  const url = `${apiBase(cfg)}/api/channels/${encodeURIComponent(channelId)}/messages?${qs.toString()}`
  const res = await fetch(url, { headers: authHeaders(cfg) })
  if (!res.ok) return []
  const data = (await res.json()) as { messages?: ChatMessage[] }
  return data.messages ?? []
}

// ─────────────────────────────────────────────────────────────
// 文件上传 / 下载 / 删除（走 HTTP，不走 WebSocket）
//
// 聊天是 WebSocket，身份在 hello 里建立。HTTP 接口没有那个上下文，
// 所以每次请求都带三个头：邀请码 + userId + userKey。
// ─────────────────────────────────────────────────────────────

function apiBase(cfg: AppConfig): string {
  return cfg.apiUrl.replace(/\/+$/, '')
}

function authHeaders(cfg: AppConfig): Record<string, string> {
  return {
    'x-invite-code': cfg.inviteCode,
    'x-user-id': cfg.userId,
    'x-user-key': cfg.userKey,
  }
}

/** 下载/预览地址。图片直接拿它当 <img src> 用 */
export function fileUrl(cfg: AppConfig, id: string): string {
  return `${apiBase(cfg)}/api/files/${encodeURIComponent(id)}`
}

const FILE_ERROR_TEXT: Record<string, string> = {
  invalid_invite_code: '邀请码不对',
  invalid_user: '身份校验失败 —— 重启一下客户端试试',
  empty_body: '文件是空的',
  write_failed: '服务器写文件失败（磁盘满了？）',
  not_found: '文件不存在（可能已被删除）',
  file_missing: '文件在服务器上不见了',
  forbidden: '你没有权限做这个操作',
  too_large: '文件太大',
}

/**
 * 上传一个文件。
 *
 * 直接 POST 裸二进制 —— 服务端为此注册了 application/octet-stream 解析器。
 * 所以不需要 multipart，也不需要引额外的库，客户端就是一行 body: file。
 */
/**
 * 上传一个文件。
 *
 * `scope` 决定它算哪一类：
 *   · 'chat'  —— 聊天框里发的（截图、点回形针选的图/文件）。
 *                **不进「云端文件」面板**，但聊天里靠 id 照样取得到。
 *   · 'cloud' —— 从「云端文件」界面上传的，会出现在那个面板里。
 */
export async function uploadFile(
  cfg: AppConfig,
  file: File,
  scope: 'chat' | 'cloud' = 'chat'
): Promise<CloudFile> {
  const qs = new URLSearchParams({ name: file.name, mime: file.type || '', scope })

  const res = await fetch(`${apiBase(cfg)}/api/upload?${qs.toString()}`, {
    method: 'POST',
    headers: { ...authHeaders(cfg), 'Content-Type': 'application/octet-stream' },
    body: file,
  })

  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as {
      error?: string
      max?: number
    } | null
    const code = detail?.error ?? ''

    if (code === 'too_large') {
      const mb = Math.round((detail?.max ?? 0) / 1024 / 1024)
      throw new Error(`文件太大，服务器限制 ${mb} MB`)
    }
    throw new Error(FILE_ERROR_TEXT[code] ?? `上传失败（HTTP ${res.status}）`)
  }

  return ((await res.json()) as { file: CloudFile }).file
}

export async function deleteFile(cfg: AppConfig, id: string): Promise<void> {
  const res = await fetch(`${apiBase(cfg)}/api/files/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(cfg),
  })

  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null
    const code = detail?.error ?? ''
    throw new Error(FILE_ERROR_TEXT[code] ?? `删除失败（HTTP ${res.status}）`)
  }
}

/** 人性化的文件大小 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  // 小数值保留一位小数，大数值取整 —— 免得显示成 "23.417 MB" 这种噪音
  return `${i > 0 && value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

/** 判断是不是能直接内联预览的图片 */
export function isImageMime(mime: string): boolean {
  return /^image\//.test(String(mime ?? ''))
}
