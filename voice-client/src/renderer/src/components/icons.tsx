type IconProps = {
  /** 边长（px）。默认 18，和按钮里的字号视觉重量相当 */
  size?: number
}

/**
 * 输入框里的两个图标用 SVG 而不是 emoji。
 *
 * ⚠️ 为什么不用 emoji：emoji 的字形在行盒里的上下位置由**字体**决定，
 * 📷（U+1F4F7）和 📎（U+1F4CE）即便来自同一个字体，基线偏移也不一样。
 * 所以无论怎么调 `line-height` 或 `align-items: center`，两个图标都会一高一低 ——
 * 因为居中的是"行盒"，不是"实际画出来的字形"。
 *
 * SVG 按 viewBox 的几何盒子绘制，两个图标的外框完全一致，天然对齐。
 * 想改大小只改 size，改颜色跟着按钮的 color 走（stroke: currentColor）。
 */

export function CameraIcon({ size = 18 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  )
}

export function PaperclipIcon({ size = 18 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

/** 放大镜。聊天标题栏最右边的搜索入口 */
export function SearchIcon({ size = 16 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.6-3.6" />
    </svg>
  )
}

/**
 * 语音控制用的图标。
 *
 * 都带一个 `off` 开关：**开启和关闭必须是两个不同的图形**，
 * 不能只靠颜色区分 —— 色盲用户、以及"关了喇叭"和"没关"在缩略尺寸下
 * 颜色差别很小，都会看不出状态。
 *
 * 关闭态统一加一道斜杠（业界惯例），同时由调用方把颜色换成警示色。
 */
type ToggleIconProps = IconProps & { off?: boolean }

/** 关闭态那道斜杠。所有图标共用，位置一致才不会看着参差不齐 */
function Slash() {
  return <path d="M4 20L20 4" />
}

export function MicIcon({ size = 16, off = false }: ToggleIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4" />
      {off && <Slash />}
    </svg>
  )
}

export function SpeakerIcon({ size = 16, off = false }: ToggleIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 5L6 9H2v6h4l5 4z" />
      {off ? <Slash /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />}
    </svg>
  )
}

/** 投屏。用一个带放射线的屏幕，和"显示器"区分开 */
export function ScreenIcon({ size = 16 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}

/**
 * 退出语音频道（挂断）。
 *
 * 用"电话 + 斜杠"而不是单纯的电话：单一个电话看着像"打电话/加入"，
 * 而这里是**离开**。斜杠和 MicIcon / SpeakerIcon 的关闭态是同一套语言。
 */
export function PhoneOffIcon({ size = 16 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
      <Slash />
    </svg>
  )
}

/**
 * 设置（齿轮）。
 *
 * ⚠️ 这里刻意**不用** Feather / Lucide 那个经典齿轮路径 ——
 *    它是一条几百个字符的连续曲线（每个齿都是一段贝塞尔），
 *    在 16px 下笔画全挤在一起，糊成一坨、"脏脏的"。
 *
 * 改用几何画法：**中心孔 + 齿根圆 + 8 根短齿**。
 *   · 三个元素各自独立，缩放时不会互相糊
 *   · 齿是直线，round 线帽，小尺寸下依然清清楚楚
 *   · 齿从 r=10.5 到 r=7.5（正好落在齿根圆上），长短一致
 *
 * 线宽用 1.7 而不是 2：这个图形元素多，2 会显得太黑、糊成一团。
 */
export function GearIcon({ size = 16 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* 齿根圆 + 中心孔 */}
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="3" />
      {/* 八根齿：四根沿轴，四根沿对角线 */}
      <path
        d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3
           M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1
           M19.4 4.6l-2.1 2.1M6.7 17.3l-2.1 2.1"
      />
    </svg>
  )
}
export function SmileIcon({ size = 18 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
      <path d="M9 9.5h.01M15 9.5h.01" />
    </svg>
  )
}
