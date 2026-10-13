/**
 * 成员显示相关的共用逻辑。
 *
 * 为什么需要"同名区分"：
 *   LiveKit 的 identity 和聊天 WebSocket 的 identity 是两套独立生成的
 *   （后端都给加了随机后缀），所以**同一个昵称出现多条连接是完全合法的** ——
 *   比如你在桌面客户端用 Owner，又在浏览器测试页用 Owner。
 *   不加区分的话，成员列表里就是两个一模一样的名字，看起来像出了 bug。
 */

/**
 * 一个"人"的最小信息。
 *
 * ⚠️ 两个来源用的标识不同：
 *   · 聊天 presence 用 userId（稳定，服务端下发）
 *   · 语音列表用 LiveKit 的 identity（每次连接都会变）
 * 所以两个字段都是可选的 —— 展示逻辑只依赖 name，这样就够了。
 */
export type MemberRef = {
  identity?: string
  userId?: string
  name: string
  /** 序列化后的头像 */
  avatar?: string
  role?: Role
  /**
   * 他正在听什么。
   *
   * 由**他自己的客户端**在本地检测（读 Windows 的 SMTC）后上报 ——
   * 关掉设置里的开关就完全不报，别人看不到。
   * 现在是 null 就是没在听（或者他关了）。
   */
  activity?: Activity | null
}

/** 「正在做什么」。music = 正在听歌，game = 正在玩游戏 */
export type Activity = {
  kind: 'music' | 'game'
  /** 歌名或游戏名 */
  title: string
  /** 歌手。游戏没有这项，是空串 */
  artist: string
}

/** 取一个稳定的键，用于 React key 和重名后缀 */
export function refKey(m: MemberRef): string {
  return m.identity ?? m.userId ?? m.name
}

// ─────────────────────────────────────────────────────────────
// 角色
// ─────────────────────────────────────────────────────────────

export type Role = 'owner' | 'admin' | 'member'

export const ROLE_LABEL: Record<Role, string> = {
  owner: '频道主',
  admin: '管理员',
  member: '成员',
}

/** 成员表里的一个人。注意用的是 userId，不是 LiveKit 的 identity */
export type MemberInfo = {
  userId: string
  name: string
  avatar: string
  role: Role
}

/** 有管理权限（能增删频道）*/
export function canManage(role: Role | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

/**
 * 语音房间里的成员。
 *
 * `mic` / `sharing` 只能来自服务端 —— 客户端自己只能看到它加入的那个房间，
 * 别的语音频道里谁闭了麦，只有服务端问得到 LiveKit。
 */
export type VoiceMember = MemberRef & {
  /** 有麦克风轨道且没静音 = 他说话你能听见 */
  mic?: boolean
  sharing?: boolean
  /** LiveKit 的 participant attributes，头像存在这里（attributes.avatar） */
  attributes?: Record<string, string>
  /** 加入频道的时间（毫秒，服务端从 LiveKit 拿）。用来固定列表顺序 */
  joinedAt?: number
}

/**
 * 按"**进频道的先后**"排序。
 *
 * ⚠️ 为什么必须排：LiveKit 返回参与者列表的顺序**不保证稳定** ——
 *    既不是加入顺序，也不保证两次调用一致。不排的话，服务端每 3 秒推一次
 *    快照，同一个房间的人在列表里就会前后跳，看着像在乱动。
 *
 * 时间相同（或者服务端还没提供 `joinedAt`）时用 `refKey` 兜底 ——
 * 这一步很关键：**光按时间排而时间是 0 的话，顺序还是随机的**。
 * 有了确定性的兜底，至少"不再变"，这正是要的效果。
 */
export function byJoinOrder<T extends MemberRef & { joinedAt?: number }>(list: T[]): T[] {
  return [...list].sort(
    (a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0) || refKey(a).localeCompare(refKey(b))
  )
}

/** 房间名 -> 该房间里的人 */
export type VoiceRooms = Record<string, VoiceMember[]>

export type DisplayMember = MemberRef & {
  /** 用于显示的名字。重名时带 #xxxx 后缀 */
  display: string
}

function norm(name: string): string {
  return (name || '').trim().toLowerCase()
}

/**
 * 给同名的人补一个短后缀（取 identity 末 4 位）。
 * 只有真的重名时才加，平时不显示，不干扰。
 */
export function withSuffixes<T extends MemberRef>(list: T[]): (T & { display: string })[] {
  const counts = new Map<string, number>()
  for (const m of list) {
    const key = norm(m.name) || refKey(m)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return list.map((m) => {
    const label = m.name || refKey(m)
    const key = norm(m.name) || refKey(m)
    const dup = (counts.get(key) ?? 0) > 1
    return {
      ...m,
      display: dup ? `${label} #${refKey(m).slice(-4)}` : label,
    }
  })
}

/** 从两个可能的来源里取头像字符串（聊天 presence 用 avatar，LiveKit 用 attributes.avatar） */
export function avatarOf(m: {
  avatar?: string
  attributes?: Record<string, string>
}): string {
  return m.avatar || m.attributes?.avatar || ''
}

/**
 * 语音成员的**稳定标识**，用来记住"我给他调过多大音量"。
 *
 * ⚠️ 不能用 identity —— LiveKit 的 identity 每次连接都会变（服务端加了随机后缀），
 *    今天调好的音量明天就对不上了。
 *    所以客户端加入语音时会把 userId 一起写进 participant attributes，
 *    这里优先用它。老客户端没写就退回 identity —— 至少同一次通话内是准的。
 *
 * 参数故意写成**结构类型**而不是 `VoiceMember`：
 * LiveKit 的 `Participant` 也要用它 —— 而且**必须是同一个函数**。
 * 投屏画面和它那份声音就靠这个 key 对上（见 App.tsx 的 screenAudioVolume），
 * 两边算出来不一样的话声音就配错人了。
 * `Participant.name` 是可选的，套不进 `VoiceMember`，所以这里不能收窄。
 */
export function voiceKey(m: {
  attributes?: Record<string, string>
  userId?: string
  identity?: string
  name?: string
}): string {
  return m.attributes?.userId || m.userId || m.identity || m.name || ''
}

/**
 * 收集"正在语音里的人"的昵称集合。
 *
 * ⚠️ 只能按昵称匹配：聊天 WebSocket 和 LiveKit 是两套 identity，
 *    没法互相对上。小圈子里昵称基本不会撞，这个近似够用。
 */
export function voiceNameSet(rooms: VoiceRooms): Set<string> {
  const s = new Set<string>()
  for (const list of Object.values(rooms)) {
    for (const m of list) s.add(norm(m.name))
  }
  return s
}
