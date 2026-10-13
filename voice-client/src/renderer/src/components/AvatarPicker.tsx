import { AVATAR_COLORS, AVATAR_EMOJIS, initial, type Avatar } from '../lib/avatar'

type Props = {
  value: Avatar
  /** 没选 emoji 时，预览圆圈里显示这个文本的首字母 */
  fallbackText: string
  onChange: (a: Avatar) => void
}

/** 底色 + emoji 的头像选择器。个人设置和服务器设置共用。 */
export function AvatarPicker({ value, fallbackText, onChange }: Props) {
  return (
    <>
      <div className="avatar-row">
        <span className="avatar avatar-lg" style={{ background: value.color }}>
          {value.emoji || initial(fallbackText)}
        </span>
        <span className="muted small">选一个底色和图案</span>
      </div>

      <label>底色</label>
      <div className="swatch-row">
        {AVATAR_COLORS.map((c) => (
          <button
            key={c}
            className={`swatch ${value.color === c ? 'selected' : ''}`}
            style={{ background: c }}
            onClick={() => onChange({ ...value, color: c })}
            title={c}
          />
        ))}
      </div>

      <label>图案（留空则显示首字母）</label>
      <div className="emoji-grid">
        <button
          className={`emoji-cell ${value.emoji === '' ? 'selected' : ''}`}
          onClick={() => onChange({ ...value, emoji: '' })}
          title="用首字母"
        >
          A
        </button>
        {AVATAR_EMOJIS.map((e) => (
          <button
            key={e}
            className={`emoji-cell ${value.emoji === e ? 'selected' : ''}`}
            onClick={() => onChange({ ...value, emoji: e })}
          >
            {e}
          </button>
        ))}
      </div>
    </>
  )
}
