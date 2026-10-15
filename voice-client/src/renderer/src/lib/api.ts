import type { AppConfig } from './config'
import type { Activity, MemberInfo, MemberRef, Role, VoiceRooms } from './names'
import { loadLang, translate, type MsgKey } from './i18n'

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
  /**
   * 父频道 id。`null` / `undefined` = 顶层频道 ✓
   *
   * ⚠️ **只允许一层** ✗ —— 父频道自己一定也是顶层 ✓
   *    服务端会拦（`nest_too_deep` ✓）所以客户端拿到的一定是合法的 ✓
   *    但界面**仍然要只列顶层频道当候选项** ✓ 不是因为它危险，
   *    而是"不给会失败的操作"✓ 让人根本选不到错的 ✓
   */
  parent_id?: string | null
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

/**
 * 一条表态。
 *
 * ⚠️ **没有 `count`、也没有 `mine`** ✗ —— 这是刻意的 ✓
 *    `count` 就是 `users.length` ✓ 多存一份迟早会不一致 ✓
 *    而 `mine`（我点过没有）**对每个人都不一样** ✗
 *    服务端下发同一条广播给所有人 ✓ 它算不出一个对所有人都对的 `mine` ✓
 *    所以它只给 `users` ✓ 客户端自己 `users.some(u => u.id === myUserId)` ✓
 */
export type Reaction = {
  emoji: string
  users: { id: string; name: string }[]
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
  /**
   * 回复的目标消息 id。不是回复就是 null/undefined。
   *
   * ⚠️ 只有 id，**没有原文** ✗ —— 原文在 `reply_preview` 里 ✓
   */
  reply_to?: number | null
  /**
   * 被引用消息的摘要，由**服务端**解析好一起下发 ✓
   *
   * ⚠️ 为什么不能让客户端自己找 ✗
   *    被引用的消息很可能**不在已加载的那一页里** ✓
   *    （往前翻很久才引用得到的老消息就是这样）
   *    客户端自己找会找不到 ✓ 只能错误地显示"原消息不存在" ✓
   *
   * ⚠️ `reply_to` 有值但这里是 `null` 有**两种**可能 ✗：
   *    原消息被删了 ✓ 或者它**不属于这个频道**（服务端拒绝回填）✓
   *    两种情况界面都显示"原消息不存在" ✓ 不区分 ✓ 免得泄露"那里曾经有条消息" ✓
   */
  reply_preview?: { id: number; author_id?: string; author_name: string; body: string } | null
  /**
   * 这条消息上的 emoji 表态。
   *
   * ⚠️ 老消息可能**没有这个字段** ✗（服务端是后加的 ✓）
   *    所以界面上处处要按 `?? []` 处理 ✓ 不能直接 `.length` ✓
   */
  reactions?: Reaction[]
  /**
   * 置顶时间。`null` / `undefined` = 没置顶 ✓
   *
   * ⚠️ 它是消息的**属性**，放在消息这一行上 ✗（不是单独一张表 ✓）
   *    好处：消息被删时自动跟着走 ✓ 不用级联、不用 join ✓
   *    代价：**置顶列表要单独拉** ✓ 见 `fetchPinned()` ——
   *    置顶的往往是很老的消息 ✓ 不在客户端已加载的那一页里 ✓
   */
  pinned_at?: number | null
  /** 谁置顶的。展示用 */
  pinned_by?: string | null
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

  if (res.status === 401) throw new Error(tr('err.inviteWrong'))
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      tr('err.serverStatus', { code: res.status }) + (text ? ` — ${text.slice(0, 200)}` : '')
    )
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
  /**
   * 收到一条转发给**我**的 P2P 信令（投屏走直连时用）。
   *
   * ⚠️ 服务端只转发、不解析 ✗ —— 它看不懂 SDP，也不需要看懂 ✓
   *    所以 `payload` 到底是什么形状，由 `lib/p2pTransport.ts` 自己约定 ✓
   *
   * `from` 是对方的 userId ✓ 用它决定回给对方什么、以及把画面挂到哪一路 ✓
   */
  onP2P?: (from: string, payload: unknown) => void
  /**
   * 某条消息的 emoji 表态变了。
   *
   * ⚠️ 带 `channelId` 是因为**别的频道**的表态也会推过来 ✓
   *    客户端得知道该去哪个会话的消息列表里更新那一条 ✓
   *    （和 `onMessageDeleted` 是同一个理由 ✓）
   *
   * ⚠️ 这里收到的一定是**全量**列表、不是增量 ✗
   *    服务端每次都重读一遍再广播 ✓ 客户端直接替换即可 ✓
   *    自己算"加一个还是减一个"在并发下很容易和库里对不上 ✓
   */
  onReactions?: (channelId: string, messageId: number, reactions: Reaction[]) => void
  /**
   * 某条消息的置顶状态变了。
   *
   * ⚠️ 广播里**只有 id 和时间**，没有整条消息 ✗
   *    因为那条消息可能根本没被加载过 ✓ 客户端也不好往哪儿塞 ✓
   *    这里收到就：① 修补已加载的那条（如果在的话 ✓）
   *                  ② 置顶面板开着的话顺手重拉一遍 ✓
   */
  onPinned?: (channelId: string, messageId: number, pinnedAt: number | null) => void
}

export type ChatConnection = {
  close: () => void
  /** 发送一条聊天消息。attachment 是已经上传好的文件。返回 false 表示连接不可用。 */
  send: (
    channelId: string,
    body: string,
    attachment?: FileRef | null,
    /** 回复某条消息时传它的 id ✓ 服务端会校验"它确实属于这个频道" ✗ */
    replyTo?: number | null,
  ) => boolean
  /**
   * 删一条消息。
   *
   * 服务端会自己判权限（频道消息要管理员以上、私聊要会话成员），
   * 删完广播 `messageDeleted` —— **所有客户端同时消失**，不只是自己这儿。
   */
  deleteMessage: (id: number, requestId?: string) => boolean
  /** 创建频道（需要管理员以上权限）。parentId 非空就是建子频道 ✓ */
  createChannel: (
    name: string,
    kind: 'text' | 'voice',
    /** 父频道 id。null / 不传 = 顶层频道 ✓ **只允许一层** ✗ */
    parentId?: string | null,
    requestId?: string,
  ) => boolean
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
  /**
   * 给**某一个人**发一条 P2P 信令（投屏走直连时交换 SDP / ICE 候选）。
   *
   * ⚠️ 这是**定向**的，不是广播 ✗ —— 传的是对方的 userId ✓
   *    服务端只在校验"对方在线 + 载荷不超过 64 KB"之后原样转发 ✓
   *
   * 载荷只有几百字节 ✓ 别拿它传画面 ✗ 画面走 RTCPeerConnection ✓
   */
  p2p: (to: string, payload: unknown) => boolean
  /**
   * 给一条消息加/取消一个 emoji 表态。
   *
   * 同一个 emoji 再调一次就是**取消** ✓ 客户端不需要先查状态 ✓
   * （库里主键是"消息+人+表情" ✓ 这件事天然幂等 ✓）
   */
  react: (messageId: number, emoji: string) => boolean
  /**
   * 置顶 / 取消置顶某条消息。同一条再来一次就是取消 ✓
   *
   * 服务端会校验频道可见性 ✓ 到 50 条上限时会回 `pin_limit` ✓
   */
  pin: (messageId: number) => boolean
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
  p2p: () => false,
  react: () => false,
  pin: () => false,
}

/** 错误码 -> 中文提示。服务端只回代码，措辞放在客户端，好改也好翻译 */
export /**
 * 服务端错误码 → 文案键 ✓
 *
 * ⚠️ 这张表**和语言无关** ✗ 所以它能放在模块级 ✓
 *    以前这里直接写的是中文 ✓ 那样就没法翻译 ✓（也不能用 hook ✓ 这不是组件 ✓）
 */
const ERROR_KEYS: Record<string, MsgKey> = {
  bad_json: 'err.badJson',
  not_joined: 'err.notJoined',
  message_too_long: 'err.messageTooLong',
  channel_not_found: 'err.channelNotFound',
  forbidden: 'err.forbidden',
  empty_name: 'err.emptyName',
  cannot_delete_default: 'err.cannotDeleteDefault',
  owner_only: 'err.ownerOnly',
  member_not_found: 'err.memberNotFound',
  cannot_change_owner: 'err.cannotChangeOwner',
  invalid_role: 'err.invalidRole',
  invalid_target: 'err.invalidTarget',
}

/**
 * 取一条文案 ✓
 *
 * ⚠️ `loadLang()` 每次调用都去读 localStorage ✗
 *    所以语言一改，**之后**产生的报错就是新语言的了 ✓
 *    报错是瞬时的 toast ✓ 不需要跟着语言实时重渲染 ✓
 */
function tr(key: MsgKey, vars?: Record<string, string | number>): string {
  return translate(loadLang(), key, vars)
}

export function errorText(code: string): string {
  return tr(ERROR_KEYS[code] ?? 'err.serverError', { code })
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
    handlers.onError?.(tr('err.chatConnectFailed', { msg: (err as Error).message }))
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
      /**
       * 有人给我转发的 P2P 信令（投屏走直连）。
       *
       * 这条链路只承载 SDP 和 ICE 候选 ✓ 几百字节 ✓
       * 具体怎么用由 lib/p2pTransport.ts 决定 ✓ 这里只负责把消息交过去 ✓
       */
      case 'p2p':
        handlers.onP2P?.(String(msg.from ?? ''), msg.payload)
        break
      /**
       * 某条消息的表态变了（可能是**别的频道**里的 ✓ 所以带 channelId）✗
       * 服务端每次给的都是**全量**列表 ✓ 这里直接整批替换 ✓
       */
      case 'reactions':
        handlers.onReactions?.(
          String(msg.channelId ?? ''),
          Number(msg.messageId),
          (msg.reactions ?? []) as Reaction[],
        )
        break
      /** 某条消息被置顶/取消置顶 ✓ 只带 id 和时间，不带整条消息 ✗ */
      case 'pinned':
        handlers.onPinned?.(
          String(msg.channelId ?? ''),
          Number(msg.messageId),
          msg.pinnedAt == null ? null : Number(msg.pinnedAt),
        )
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

  ws.onerror = () => handlers.onError?.(tr('err.chatConnectError'))
  ws.onclose = () => handlers.onClose?.()

  return {
    close: () => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    },
    send: (channelId, body, attachment, replyTo) =>
      sendJson({
        type: 'message',
        channelId,
        body,
        attachment: attachment ?? undefined,
        replyTo: replyTo ?? undefined,
      }),
    deleteMessage: (id, requestId) => sendJson({ type: 'deleteMessage', id, requestId }),
    setActivity: (activity) => sendJson({ type: 'setActivity', activity }),
    removeMember: (userId) => sendJson({ type: 'removeMember', userId }),
    reportGame: (exe, name) => sendJson({ type: 'reportGame', exe, name }),
    createChannel: (name, kind, parentId, requestId) =>
      sendJson({
        type: 'createChannel',
        name,
        kind,
        // ⚠️ 空字符串要变成 undefined ✗
        //    传 '' 过去服务端会当成"给了个空的父频道 id" ✓
        //    虽然它现在会走"父频道不存在"那条 ✓ 但那是碰巧 ✓ 语义清楚更好 ✓
        parentId: parentId || undefined,
        requestId,
      }),
    deleteChannel: (channelId, requestId) =>
      sendJson({ type: 'deleteChannel', channelId, requestId }),
    setRole: (userId, role, requestId) =>
      sendJson({ type: 'setRole', userId, role, requestId }),
    updateServer: (name, avatar, requestId) =>
      sendJson({ type: 'updateServer', name, avatar, requestId }),
    openDm: (userId, requestId) => sendJson({ type: 'openDm', userId, requestId }),
    voiceChime: (room, joined) => sendJson({ type: 'voiceChime', room, joined }),
    p2p: (to, payload) => sendJson({ type: 'p2p', to, payload }),
    react: (messageId, emoji) => sendJson({ type: 'react', messageId, emoji }),
    pin: (messageId) => sendJson({ type: 'pin', messageId }),
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
 * 拉某个会话里被置顶的消息。
 *
 * ⚠️ 为什么**必须单独拉**、不能在已加载的消息里筛 ✗
 *    置顶的往往正是很久以前那条重要消息 ✓
 *    而客户端只加载了最近 50 条 ✓
 *    在本地筛的话用户会看到"置顶列表是空的" ✓ 而库里明明有 ✓
 *    （和搜索必须在服务端做是同一个理由 ✓）
 *
 * ⚠️ 顺序是服务端排好的：**按置顶时间**倒序 ✓
 *    刚置顶的排最前面 ✓ 哪怕那条消息本身很老 ✓
 */
export async function fetchPinned(cfg: AppConfig, channelId: string): Promise<ChatMessage[]> {
  const url = `${apiBase(cfg)}/api/channels/${encodeURIComponent(channelId)}/pinned`
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

const FILE_ERROR_KEYS: Record<string, MsgKey> = {
  invalid_invite_code: 'err.inviteWrong',
  invalid_user: 'err.invalidUser',
  empty_body: 'err.emptyFile',
  write_failed: 'err.writeFailed',
  not_found: 'err.fileNotFound',
  file_missing: 'err.fileMissing',
  forbidden: 'err.forbidden',
  too_large: 'err.fileTooLarge',
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
      throw new Error(tr('err.fileTooLargeLimit', { mb }))
    }
    throw new Error(FILE_ERROR_KEYS[code] ? tr(FILE_ERROR_KEYS[code]) : tr('err.uploadFailed', { status: res.status }))
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
    throw new Error(FILE_ERROR_KEYS[code] ? tr(FILE_ERROR_KEYS[code]) : tr('err.deleteFailed', { status: res.status }))
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
