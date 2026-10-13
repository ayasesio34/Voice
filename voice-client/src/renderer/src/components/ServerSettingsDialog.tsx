import { useEffect, useState } from 'react'
import { DEFAULT_AVATAR, parseAvatar, serializeAvatar, type Avatar } from '../lib/avatar'
import { AvatarPicker } from './AvatarPicker'

export type ServerInfo = {
  name: string
  /** 序列化后的头像 */
  avatar: string
}

type Props = {
  open: boolean
  server: ServerInfo
  onCancel: () => void
  /** 把新的名字和「序列化后的头像」交给上层去发 */
  onSave: (name: string, avatarRaw: string) => void
}

export function ServerSettingsDialog({ open, server, onCancel, onSave }: Props) {
  const [name, setName] = useState(server.name)
  const [avatar, setAvatar] = useState<Avatar>(parseAvatar(server.avatar) ?? DEFAULT_AVATAR)

  // 每次打开时从最新的 server 同步一次 —— 别人可能刚改过
  useEffect(() => {
    if (!open) return
    setName(server.name)
    setAvatar(parseAvatar(server.avatar) ?? DEFAULT_AVATAR)
  }, [open, server.name, server.avatar])

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <h2>服务器设置</h2>

        <AvatarPicker value={avatar} fallbackText={name} onChange={setAvatar} />

        <label>
          服务器名字
          <input
            value={name}
            maxLength={32}
            placeholder="我的服务器"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <p className="hint">
          名字和头像会同步给所有人 —— 它们存在服务端，不是本地设置。
        </p>

        <div className="modal-actions">
          <button className="ghost" onClick={onCancel}>
            取消
          </button>
          <button
            disabled={!name.trim()}
            onClick={() => onSave(name.trim(), serializeAvatar(avatar))}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
