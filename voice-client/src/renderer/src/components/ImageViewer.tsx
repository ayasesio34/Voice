import { useCallback, useEffect, useRef, useState } from 'react'

type Props = {
  /** 图片地址 */
  src: string
  /** 文件名，标题栏和下载时用 */
  name: string
  onClose: () => void
}

/** 缩放下限／上限。上限给得大一点 —— 截图里的小字要能怼到看得清 */
const MIN_SCALE = 0.2
const MAX_SCALE = 16

/** 滚轮每一格的缩放倍率 */
const WHEEL_STEP = 1.15
/** 按钮每一格的缩放倍率 */
const BUTTON_STEP = 1.4

const clamp = (v: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v))

/**
 * 应用内的看图器。
 *
 * ── 为什么不丢给系统浏览器 ──────────────────────────────────
 * 之前点图片走的是 `shell.openExternal` —— 图片跑到浏览器里去了。
 * 看个截图还要切窗口、关标签页，而且**下载也得在浏览器里再操作一次**。
 * 这是个聊天软件，图片就该在软件里看。
 *
 * ── 交互 ────────────────────────────────────────────────────
 *   · **滚轮缩放**，而且**以光标为中心** —— 鼠标指着哪就放大哪，
 *     这才是"放大镜"该有的手感（以画面中心缩放的话，想看的地方会跑掉）
 *   · **按住拖动**平移
 *   · **双击**在"适应窗口"和"原始大小"之间切换
 *   · Esc / 点背景 / 右上角 ✕ 关闭
 *
 * ── 关于百分比 ──────────────────────────────────────────────
 * 显示的是**真实像素比例**，不是"相对适应窗口的倍数"：
 * 一张 3840 宽的截图缩到窗口里显示时是 25%，放大到 100% 才是**一个像素对一个像素**。
 * 标注"相对倍数"的话用户没法知道什么时候该停 —— 而看截图的小字，
 * 要的正是"到 100% 了"这个明确的点。
 */
export function ImageViewer({ src, name, onClose }: Props) {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [failed, setFailed] = useState(false)

  /**
   * 图片"适应窗口"时相对原始尺寸的比例。
   * scale=1 是适应窗口，所以真实像素比例 = scale × fitRatio。
   */
  const [fitRatio, setFitRatio] = useState(1)

  const boxRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  /** 量一下"适应窗口"占原始尺寸的几成 —— 窗口大小变了要重算 */
  const measure = useCallback(() => {
    const box = boxRef.current
    const img = imgRef.current
    if (!box || !img || !img.naturalWidth || !img.naturalHeight) return
    const w = box.clientWidth
    const h = box.clientHeight
    if (!w || !h) return
    setFitRatio(Math.min(w / img.naturalWidth, h / img.naturalHeight, 1))
  }, [])

  useEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure, src])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /**
   * 以某个点为中心缩放。
   *
   * `cx / cy` 是相对**容器中心**的坐标（滚轮位置，或者 0,0 表示正中心）。
   *
   * 关键是让光标底下那个像素**待在原地**：
   *   屏幕上某点的位置 = offset + scale × 图上坐标
   *   反解出光标下的图上坐标，再让它在新的 scale 下映射回同一个屏幕位置。
   * 不做这一步的话，放大时内容会朝中心跑 —— 想看的地方越放越偏。
   */
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setScale((prev) => {
      const next = clamp(prev * factor)
      if (next === prev) return prev
      const k = next / prev
      setOffset((o) => ({ x: cx - (cx - o.x) * k, y: cy - (cy - o.y) * k }))
      return next
    })
  }, [])

  const zoomByButton = useCallback(
    (factor: number) => {
      zoomAt(factor, 0, 0) // 按钮没有光标位置，就以画面中心缩放
    },
    [zoomAt]
  )

  const resetFit = useCallback(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  /** 原始像素大小：一个图像像素对一个屏幕像素 */
  const actualSize = useCallback(() => {
    if (fitRatio <= 0) return
    setScale(clamp(1 / fitRatio))
    setOffset({ x: 0, y: 0 })
  }, [fitRatio])

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const box = boxRef.current
      if (!box) return
      const rect = box.getBoundingClientRect()
      const cx = e.clientX - rect.left - rect.width / 2
      const cy = e.clientY - rect.top - rect.height / 2
      zoomAt(e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, cx, cy)
    },
    [zoomAt]
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
      setDragging(true)
      e.currentTarget.setPointerCapture?.(e.pointerId)
    },
    [offset.x, offset.y]
  )

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) })
  }, [])

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    setDragging(false)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }, [])

  /** 真实像素比例。适应窗口时可能只有 25%，放大到 100% 才是一像素对一像素 */
  const pixelPercent = Math.round(scale * fitRatio * 100)

  return (
    <div
      className="viewer"
      // 点背景关闭；点在图或工具栏上不关
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="viewer-bar">
        <span className="viewer-name" title={name}>
          {name}
        </span>

        <span className="viewer-zoom">
          <button className="ghost small-btn" onClick={() => zoomByButton(1 / BUTTON_STEP)} title="缩小">
            −
          </button>
          <span className="viewer-percent" title="真实像素比例（100% = 一个图像像素对一个屏幕像素）">
            {pixelPercent}%
          </span>
          <button className="ghost small-btn" onClick={() => zoomByButton(BUTTON_STEP)} title="放大">
            ＋
          </button>
        </span>

        <button
          className="ghost small-btn"
          onClick={resetFit}
          title="缩到刚好放得下整张图"
        >
          适应窗口
        </button>
        <button className="ghost small-btn" onClick={actualSize} title="一个图像像素对一个屏幕像素（看小字用）">
          原始大小
        </button>

        <button
          className="ghost small-btn"
          onClick={() => void window.desktop?.download?.(src)}
          title="保存到本地（弹系统另存为）"
        >
          ⬇ 下载
        </button>
        <button className="ghost small-btn" onClick={onClose} title="关闭（Esc）">
          ✕
        </button>
      </div>

      <div
        className={`viewer-box${dragging ? ' dragging' : ''}`}
        ref={boxRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => (scale > 1.01 ? resetFit() : actualSize())}
      >
        {failed ? (
          <p className="muted">图片加载失败 —— 可能已经被删掉了</p>
        ) : (
          <img
            ref={imgRef}
            src={src}
            alt={name}
            className="viewer-img"
            draggable={false}
            onLoad={measure}
            onError={() => setFailed(true)}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              // 放大时不要插值 —— 看截图的小字，模糊的平滑缩放还不如硬边
              imageRendering: scale * fitRatio >= 1 ? 'pixelated' : 'auto',
            }}
          />
        )}
      </div>

      <div className="viewer-hint muted small">
        滚轮缩放（以光标为中心） · 按住拖动 · 双击在适应窗口／原始大小之间切换 · Esc 关闭
      </div>
    </div>
  )
}
