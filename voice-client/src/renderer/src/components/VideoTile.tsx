import { useEffect, useRef } from 'react'
import type { Track } from 'livekit-client'

type Props = {
  track: Track
  muted?: boolean
  /** 0 ~ 1。超过 1 会被 HTMLMediaElement 截断，所以这里也夹一下 */
  volume?: number
  /** 镜像显示（摄像头通常要镜像，屏幕共享不要） */
  mirror?: boolean
  className?: string
}

/**
 * 把一个 LiveKit 轨道挂到 <video> 上。
 *
 * 用 track.attach() 而不是自己设 srcObject —— LiveKit 会在内部处理
 * 编码格式、自适应流的切换等情况，直接操作 srcObject 容易在切层时黑屏。
 */
export function VideoTile({ track, muted = true, volume = 1, mirror = false, className }: Props) {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    track.attach(el)
    return () => {
      track.detach(el)
    }
  }, [track])

  // 音量单独一个 effect：调音量不该把轨道重新 attach 一遍
  // （重新 attach 会有明显的断音和闪一下）
  useEffect(() => {
    const el = ref.current
    if (el) el.volume = Math.min(1, Math.max(0, volume))
  }, [volume])

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={className}
      style={mirror ? { transform: 'scaleX(-1)' } : undefined}
    />
  )
}
