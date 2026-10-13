import { useState } from 'react'

type Props = {
  open: boolean
  onCancel: () => void
  onCreate: (name: string, kind: 'text' | 'voice') => void
}

export function ChannelCreateDialog({ open, onCancel, onCreate }: Props) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'text' | 'voice'>('text')

  if (!open) return null

  const submit = () => {
    const n = name.trim()
    if (!n) return
    onCreate(n, kind)
    setName('')
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <h2>创建频道</h2>

        <label>类型</label>
        <div className="kind-row">
          <button
            className={kind === 'text' ? '' : 'ghost'}
            onClick={() => setKind('text')}
          >
            # 文字频道
          </button>
          <button
            className={kind === 'voice' ? '' : 'ghost'}
            onClick={() => setKind('voice')}
          >
            🔊 语音频道
          </button>
        </div>

        <label>
          名字
          <input
            value={name}
            autoFocus
            maxLength={24}
            placeholder={kind === 'text' ? '例如：闲聊' : '例如：开黑'}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
        </label>

        <p className="hint">
          {kind === 'voice'
            ? '语音频道的名字会成为 LiveKit 的房间名，加入的人互相能听见。'
            : '文字频道的消息会存在服务端，历史消息随时能翻。'}
        </p>

        <div className="modal-actions">
          <button className="ghost" onClick={onCancel}>
            取消
          </button>
          <button onClick={submit} disabled={!name.trim()}>
            创建
          </button>
        </div>
      </div>
    </div>
  )
}
