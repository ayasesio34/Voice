import { DEFAULT_AVATAR, initial, parseAvatar } from '../lib/avatar'

type Props = {
  /** 序列化后的头像字符串（来自聊天 presence 或 LiveKit attributes） */
  raw?: string
  /** 没有头像时用它显示首字母 */
  name: string
  size?: number
}

/**
 * 头像圆圈。有 emoji 就显示 emoji，没有就回退到昵称首字母。
 */
export function Avatar({ raw, name, size = 26 }: Props) {
  const a = parseAvatar(raw) ?? DEFAULT_AVATAR
  const label = a.emoji || initial(name)

  return (
    <span
      className="avatar"
      style={{
        background: a.color,
        width: size,
        height: size,
        fontSize: Math.round(size * 0.52),
      }}
      title={name}
    >
      {label}
    </span>
  )
}
