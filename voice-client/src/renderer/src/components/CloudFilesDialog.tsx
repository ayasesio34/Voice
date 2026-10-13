import { useRef, useState } from 'react'
import { formatBytes, isImageMime, type CloudFile, type FilesStats } from '../lib/api'
import { canManage, type Role } from '../lib/names'

type Props = {
  open: boolean
  files: CloudFile[]
  stats: FilesStats
  /** 当前用户的 id，用来判断"这是我自己传的" */
  myUserId: string
  myRole: Role
  fileHref: (id: string) => string
  onClose: () => void
  onUpload: (file: File) => Promise<void>
  onDelete: (file: CloudFile) => Promise<void>
  onOpenFile: (id: string) => void
}

/**
 * 云端文件。
 *
 * 和聊天附件共用同一张表、同一套上传接口 —— 区别只是这里是个"文件柜"，
 * 不像聊天那样会被消息流冲走。
 */
export function CloudFilesDialog({
  open,
  files,
  stats,
  myUserId,
  myRole,
  fileHref,
  onClose,
  onUpload,
  onDelete,
  onOpenFile,
}: Props) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  if (!open) return null

  const pick = async (file: File | undefined) => {
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      await onUpload(file)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const remove = async (file: CloudFile) => {
    if (!window.confirm(`确定删除「${file.name}」？\n删掉之后聊天里引用它的地方也会失效。`)) {
      return
    }
    setBusyId(file.id)
    setError(null)
    try {
      await onDelete(file)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal cloud-files" onClick={(e) => e.stopPropagation()}>
        <div className="cloud-header">
          <h2>📁 云端文件</h2>
          <span className="muted small">
            {stats.count} 个 · 共 {formatBytes(stats.bytes)}
          </span>
          <div className="spacer" />

          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={(e) => {
              void pick(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <button disabled={uploading} onClick={() => fileInputRef.current?.click()}>
            {uploading ? '上传中…' : '上传文件'}
          </button>
        </div>

        {error && <p className="error">{error}</p>}

        {files.length === 0 ? (
          <p className="muted" style={{ padding: '24px 0', textAlign: 'center' }}>
            还没有文件。点右上角「上传文件」放一个上去，所有人都能下载。
          </p>
        ) : (
          <div className="cloud-list">
            {files.map((f) => {
              // 管理员能删任何文件；普通成员只能删自己传的 —— 和服务器端的规则一致
              const mayDelete = canManage(myRole) || f.uploaderId === myUserId

              return (
                <div key={f.id} className="cloud-row">
                  <span className="cloud-thumb">
                    {isImageMime(f.mime) ? (
                      <img src={fileHref(f.id)} alt="" loading="lazy" />
                    ) : (
                      <span className="cloud-icon">📄</span>
                    )}
                  </span>

                  <span className="cloud-info">
                    <button
                      className="cloud-name"
                      onClick={() => onOpenFile(f.id)}
                      title={`${f.name} · 点击打开 / 下载`}
                    >
                      {f.name}
                    </button>
                    <span className="muted small">
                      {formatBytes(f.size)} · {f.uploaderName || '匿名'} ·{' '}
                      {new Date(f.createdAt).toLocaleString('zh-CN', { hour12: false })}
                    </span>
                  </span>

                  <button
                    className="ghost small-btn"
                    onClick={() => onOpenFile(f.id)}
                    title="用系统程序打开 / 下载"
                  >
                    下载
                  </button>

                  {mayDelete && (
                    <button
                      className="danger small-btn"
                      disabled={busyId === f.id}
                      onClick={() => void remove(f)}
                      title={
                        canManage(myRole) && f.uploaderId !== myUserId
                          ? '以管理员身份删除'
                          : '删除自己上传的文件'
                      }
                    >
                      {busyId === f.id ? '删除中…' : '删除'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
