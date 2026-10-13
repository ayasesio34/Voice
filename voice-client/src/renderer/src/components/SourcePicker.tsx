import { useEffect, useMemo, useState } from 'react'
import { presetByKey } from '../lib/livekit'
import { screenAudioSupport } from '../lib/screenAudio'
import type { ShareSettings } from './SettingsDialog'

export type SourceInfo = {
  id: string
  name: string
  isScreen: boolean
  thumbnail: string
}

type Props = {
  open: boolean
  /** 默认是否带上系统声音（来自设置里的勾选） */
  defaultWithAudio: boolean
  /**
   * 当前的投屏规格（画质档位 / 编码器 / 内容提示），来自设置。
   *
   * 从这里读、只做展示 —— 不改。因为"规格"和"这次共享哪个窗口"是两件事：
   * 规格是长期偏好（放设置里），选源是每次都要做的。
   * 但**必须在这儿显示出来**：开了共享才发现画质不对、又得停下来去翻设置，
   * 是很烦的一件事。
   */
  share: ShareSettings
  onCancel: () => void
  onPick: (sourceId: string, withAudio: boolean) => void
}

/**
 * 屏幕/窗口选择器。
 *
 * 为什么要自己做这个而不是用系统的：Electron 里拿不到浏览器那种原生
 * getDisplayMedia 选择器（除非用 setDisplayMediaRequestHandler + 平台选择器），
 * 而 desktopCapturer 给的源本来就带缩略图 —— 自己渲染一个网格，
 * 体验反而更接近 Discord。
 *
 * 顺带在这里放「是否共享系统声音」的开关：它是**每次共享单独决定**的，
 * 有时候要连游戏声一起给，有时候只想给人看代码、一点声音都不想要。
 */
export function SourcePicker({ open, defaultWithAudio, share, onCancel, onPick }: Props) {
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [withAudio, setWithAudio] = useState(defaultWithAudio)

  // 原生捕获插件能不能用，决定下面提示是"好消息"还是"警告"。
  // useMemo 是因为它每次调用都要过一趟 contextBridge。
  const loopback = useMemo(() => screenAudioSupport(), [])

  // 每次打开都重置成设置里的默认值
  useEffect(() => {
    if (open) setWithAudio(defaultWithAudio)
  }, [open, defaultWithAudio])

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setErr(null)

    const load = async () => {
      if (!window.desktop) {
        setErr('桌面接口不可用（preload 没加载？）')
        setLoading(false)
        return
      }
      try {
        const list = await window.desktop.listSources()
        if (!alive) return
        setSources(list)
      } catch (e) {
        if (alive) setErr(`枚举屏幕失败：${(e as Error).message}`)
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()

    return () => {
      alive = false
    }
  }, [open])

  if (!open) return null

  const screens = sources.filter((s) => s.isScreen)
  const windows = sources.filter((s) => !s.isScreen)

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal source-picker" onClick={(e) => e.stopPropagation()}>
        <h2>选择要共享的内容</h2>

        {/* 投屏规格。以前这个显示在底部状态条上 ——
            但那是"我正在语音里"的位置，跟投屏画质没关系；
            放这儿才是你真正会关心它的时候（马上要开共享了）。 */}
        <div className="source-spec">
          <span className="muted">投屏规格</span>
          <strong>{presetByKey(share.presetKey).label}</strong>
          <span className="muted">· {share.codec}</span>
          <div className="spacer" />
          <span className="muted small">在「设置 → 屏幕共享」里改</span>
        </div>

        {/* 声音开关放在最上面 —— 先决定要不要声音，再挑画面 */}
        <div className="source-audio-row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={withAudio}
              onChange={(e) => setWithAudio(e.target.checked)}
            />
            同时共享系统声音
          </label>

          {/* 原来这里有两段长说明（绿的一段"不含通话声"、橙的一段"会听到自己"）。
              正常情况（原生插件可用）下那段绿字纯属自我表扬 —— 拿掉了。
              橙色那段只在插件加载失败时出现，那是**真会踩的坑**（对方听到自己），
              所以压成一句留着。 */}
          {withAudio && !loopback.available && (
            <p className="hint echo-warning">
              ⚠️ 这一路声音里会包含通话声，对方能听到自己说话。
              <span className="muted">（本机没能加载原生捕获插件：{loopback.reason}）</span>
            </p>
          )}
        </div>

        {loading && <p className="muted">正在枚举…</p>}
        {err && <p className="error">{err}</p>}

        {!loading && !err && (
          <>
            {screens.length > 0 && (
              <>
                <h3>整个屏幕</h3>
                <div className="source-grid">
                  {screens.map((s) => (
                    <button
                      key={s.id}
                      className="source-card"
                      onClick={() => onPick(s.id, withAudio)}
                    >
                      {s.thumbnail ? (
                        <img src={s.thumbnail} alt="" />
                      ) : (
                        <div className="source-placeholder" />
                      )}
                      <span>{s.name}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {windows.length > 0 && (
              <>
                <h3>窗口</h3>
                <div className="source-grid">
                  {windows.map((s) => (
                    <button
                      key={s.id}
                      className="source-card"
                      onClick={() => onPick(s.id, withAudio)}
                    >
                      {s.thumbnail ? (
                        <img src={s.thumbnail} alt="" />
                      ) : (
                        <div className="source-placeholder" />
                      )}
                      <span>{s.name}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {sources.length === 0 && <p className="muted">没有找到可共享的内容。</p>}
          </>
        )}

        <div className="modal-actions">
          <button className="ghost" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
