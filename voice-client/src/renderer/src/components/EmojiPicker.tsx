import { useEffect, useRef } from 'react'

/**
 * 表情选择器。
 *
 * 用一个**手挑的固定集合**，而不是完整的 Unicode 表情表（那有三千多个）：
 *   · 聊天里真正高频用到的就那么一两百个，铺满几千个只会让人翻不到
 *   · 完整表要几十 KB 的数据，为这个功能不值得
 * 不够用的话往下面的分组里加就行。
 */
const GROUPS: { title: string; items: string[] }[] = [
  {
    title: '常用',
    items: [
      '😀', '😂', '🤣', '😊', '😍', '🤔', '😅', '😭',
      '😡', '👍', '👎', '👏', '🙏', '💪', '🎉', '🔥',
      '❤️', '✨', '😴', '🤯', '🥳', '😎', '🤝', '✅',
    ],
  },
  {
    title: '表情',
    items: [
      '😃', '😄', '😁', '😆', '😉', '😋', '😜', '🤪',
      '😝', '🤗', '🤭', '🤫', '😐', '😑', '😶', '🙄',
      '😏', '😒', '😔', '😞', '😢', '😤', '😩', '😫',
      '🥺', '😱', '🤮', '🤧', '🥶', '🥵', '😇', '🤡',
      '👻', '💀', '👽', '🤖',
    ],
  },
  {
    title: '手势',
    items: [
      '👋', '🤚', '✋', '🖖', '👌', '🤌', '✌️', '🤞',
      '🤟', '🤘', '👈', '👉', '👆', '👇', '☝️', '✊',
      '👊', '🤛', '🤜', '🙌', '👐', '🤲', '🫡', '💅',
    ],
  },
  {
    title: '物件',
    items: [
      '💻', '🖥️', '⌨️', '🖱️', '📱', '🎮', '🎧', '🎤',
      '📷', '📁', '📄', '📌', '📎', '✏️', '🔍', '🔔',
      '⏰', '🎵', '🎬', '📢', '💡', '🔧', '🔑', '🗑️',
    ],
  },
  {
    title: '生活',
    items: [
      '🍕', '🍔', '🍜', '🍺', '☕', '🍰', '🎂', '🍎',
      '⚽', '🏀', '🎯', '🎲', '🚀', '✈️', '🚗', '🏠',
      '🌈', '☀️', '🌙', '⭐', '🌸', '🐱', '🐶', '🐟',
    ],
  },
]

type Props = {
  onPick: (emoji: string) => void
  onClose: () => void
}

export function EmojiPicker({ onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  // 点别处 / 按 Esc 关掉。
  // 用 mousedown 而不是 click：click 要等鼠标抬起，
  // 拖动选表情的过程中松手在别处会误关。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div className="emoji-pop" ref={ref}>
      {GROUPS.map((g) => (
        <div key={g.title}>
          <div className="emoji-group-title">{g.title}</div>
          <div className="emoji-grid">
            {g.items.map((e) => (
              <button key={e} className="emoji-cell" onClick={() => onPick(e)}>
                {e}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
