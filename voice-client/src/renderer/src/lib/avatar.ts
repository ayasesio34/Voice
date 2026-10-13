/**
 * 头像。
 *
 * 刻意做成「颜色 + emoji」而不是上传图片：
 *   · 不需要任何存储、CDN、图片压缩
 *   · 不需要在服务端做文件上传和鉴权
 *   · 数据只有几十字节，可以塞进 participant attributes 和聊天握手包
 * 对小圈子来说，这已经够用了，而且比默认的首字母好看得多。
 */

export type Avatar = {
  /** 圆形底色，例如 #5865f2 */
  color: string
  /** 显示在圆圈里的 emoji。留空则回退到昵称首字母 */
  emoji: string
}

export const AVATAR_COLORS = [
  '#5865f2',
  '#23a55a',
  '#f0b232',
  '#f23f43',
  '#eb459e',
  '#00a8fc',
  '#e67e22',
  '#9b59b6',
  '#1abc9c',
  '#949ba4',
]

export const AVATAR_EMOJIS = [
  '🐱', '🐶', '🦊', '🐼', '🐸', '🐵', '🦉', '🐙',
  '🦄', '🐧', '🐢', '🐝', '🍀', '⭐', '🔥', '🌙',
  '🍕', '🎧', '🎮', '🚀', '🎸', '📚', '☕', '🌸',
]

export const DEFAULT_AVATAR: Avatar = { color: '#5865f2', emoji: '' }

/** 序列化成字符串，用于 participant attributes / 聊天握手包 */
export function serializeAvatar(a: Avatar): string {
  return JSON.stringify({ color: a.color, emoji: a.emoji })
}

/** 解析。任何异常都返回 null，绝不让坏数据把界面搞崩 */
export function parseAvatar(raw?: string | null): Avatar | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Partial<Avatar>
    if (o && typeof o.color === 'string' && typeof o.emoji === 'string') {
      return { color: o.color, emoji: o.emoji }
    }
  } catch {
    /* 不是合法 JSON —— 忽略 */
  }
  return null
}

/** 取名字首字母做兜底 */
export function initial(name: string): string {
  return (name || '?').trim().slice(0, 1).toUpperCase() || '?'
}
