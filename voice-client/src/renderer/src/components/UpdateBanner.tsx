export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }

type Props = {
  status: UpdateStatus
  onDownload: () => void
  onInstall: () => void
  onCheck: () => void
  onDismiss: () => void
}

/**
 * 更新提示条。
 *
 * 只在「有新版本」「正在下载」「下载完成」「出错」这几种状态下出现，
 * 平时完全不占地方。
 */
export function UpdateBanner({ status, onDownload, onInstall, onCheck, onDismiss }: Props) {
  if (status.kind === 'idle' || status.kind === 'checking') return null

  return (
    // 类名带前缀 —— 裸的 `error` 会撞上全局的 `.error { color: var(--err) }`，
    // 把整条提示的文字染成红色
    <div className={`update-banner update-banner-${status.kind}`}>
      {status.kind === 'available' && (
        <>
          <span>🎉 发现新版本 v{status.version}</span>
          <div className="spacer" />
          <button className="small-btn" onClick={onDownload}>
            下载
          </button>
          <button className="ghost small-btn" onClick={onDismiss}>
            以后再说
          </button>
        </>
      )}

      {status.kind === 'downloading' && (
        <>
          <span>⬇️ 正在下载更新… {status.percent}%</span>
          <div className="update-progress">
            <div className="update-progress-bar" style={{ width: `${status.percent}%` }} />
          </div>
        </>
      )}

      {status.kind === 'downloaded' && (
        <>
          <span>✅ v{status.version} 已下载完成</span>
          <div className="spacer" />
          <button className="small-btn" onClick={onInstall}>
            立即重启安装
          </button>
          <button className="ghost small-btn" onClick={onDismiss}>
            退出时安装
          </button>
        </>
      )}

      {status.kind === 'error' && (
        <>
          <span title={status.message}>⚠️ 检查更新失败：{status.message.slice(0, 80)}</span>
          <div className="spacer" />
          <button className="ghost small-btn" onClick={onCheck}>
            重试
          </button>
          <button className="ghost small-btn" onClick={onDismiss}>
            关闭
          </button>
        </>
      )}
    </div>
  )
}
