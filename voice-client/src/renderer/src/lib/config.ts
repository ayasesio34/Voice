import { DEFAULT_AVATAR, type Avatar } from './avatar'

export type AppConfig = {
  /** LiveKit 信令地址，例如 ws://1.2.3.4:7880 */
  livekitUrl: string
  /** 后端地址，例如 http://1.2.3.4:3005 */
  apiUrl: string
  /** 邀请码：向后端换 token 的唯一口令 */
  inviteCode: string
  /** 昵称 */
  nickname: string
  /** 头像（颜色 + emoji） */
  avatar: Avatar
  /**
   * 服务端下发的稳定用户 id —— **角色（频道主/管理员）记在它上面**。
   * 不能用 LiveKit 的 identity：那玩意每次连接都重新生成随机后缀。
   */
  userId: string
  /**
   * 服务端下发的身份凭证。
   * ⚠️ 丢了就找不回角色了 —— 会以全新成员的身份重新登记。
   */
  userKey: string
}

// ⚠️ 改了默认值时记得把 v2 加一（v3、v4…）。
//    因为加载逻辑是「localStorage 覆盖默认值」，如果老配置里存着空字符串，
//    会把你新填的默认值又盖回空。
const STORAGE_KEY = 'voice.config.v2'

/**
 * 内置的默认配置。
 *
 * **服务端地址和邀请码都写死在这里** —— 装完就能用，不需要任何人手动输入。
 * 设置面板里那几个输入框被收进了「高级」折叠区，正常使用不会看到。
 *
 * ⚠️ 代价：任何拿到这个安装包的人都能接入你的服务器。
 *    小圈子自用可以接受；要对外开放的话，把 inviteCode 清空，
 *    并改成真正的账号体系（用户名密码 / OAuth）。
 */
export const DEFAULT_CONFIG: AppConfig = {
  livekitUrl: 'ws://YOUR_SERVER_IP:17707',
  apiUrl: 'http://YOUR_SERVER_IP:17706',
  inviteCode: 'your-invite-code',
  nickname: '',
  avatar: DEFAULT_AVATAR,
  // 这两个由服务端在首次连接时下发并保存，不要手填
  userId: '',
  userKey: '',
}

export function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return ensureIdentity({ ...DEFAULT_CONFIG, avatar: { ...DEFAULT_CONFIG.avatar } })

    const parsed = JSON.parse(raw) as Partial<AppConfig>
    return ensureIdentity({
      ...DEFAULT_CONFIG,
      ...parsed,
      // 头像要深拷贝，否则改了一个地方会影响默认值对象
      avatar: { ...DEFAULT_CONFIG.avatar, ...(parsed.avatar ?? {}) },
    })
  } catch {
    return ensureIdentity({ ...DEFAULT_CONFIG, avatar: { ...DEFAULT_CONFIG.avatar } })
  }
}

export function saveConfig(cfg: AppConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
  } catch {
    /* 隐私模式下可能写不了，无所谓 */
  }
}

/** 昵称没填时给个默认值，避免满屏"匿名" */
export function defaultNickname(): string {
  return '用户' + Math.floor(Math.random() * 9000 + 1000)
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // 极老运行时的兜底（正常用不到）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * 保证本地有一对身份标识。
 *
 * ⚠️ **必须由客户端自己生成**，而且要在第一次连接之前就生成好。
 *
 * 之前是让服务端在首次 hello 时下发，结果是：开发模式下 React StrictMode
 * 会把 effect 跑两遍 —— 第一个 WebSocket 用空 userId 连上去、服务端给它生成了
 * 身份 A（并让它当了频道主），紧接着 StrictMode 的清理把这个连接关掉，
 * 第二个 WebSocket 又用空的 userId 连上去、拿到身份 B。
 * 于是"频道主"就锁死在一个再也回不来的身份 A 上了。
 *
 * 客户端自己生成就没这个问题：两个连接用的是同一对 id + key，
 * 服务端只会认成同一个人。
 */
export function ensureIdentity(cfg: AppConfig): AppConfig {
  if (cfg.userId && cfg.userKey) return cfg
  return {
    ...cfg,
    userId: cfg.userId || uuid(),
    userKey: cfg.userKey || uuid().replace(/-/g, ''),
  }
}
