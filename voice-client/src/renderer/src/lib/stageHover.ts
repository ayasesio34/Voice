/**
 * 「鼠标在不在唤醒区」的判断。
 *
 * ── 为什么单独拆出来 ────────────────────────────────────────
 * 这段是**坐标算术**，而且只有真的开了投屏、进了全屏、鼠标划到那个角落
 * 才看得到效果 —— 截图验证不了。算错了（正负号反了、x/y 弄混了、
 * 忘了迟滞）表现都是"有时候不出来"，很难复现。
 *
 * 所以抽成纯函数，用单测钉住；界面那层只负责把鼠标坐标喂进来。
 *
 * ── 两个唤醒区 ──────────────────────────────────────────────
 *   顶部     → 控制条在那儿
 *   左下角   → 那叠「谁在看」的头像在那儿
 * 两个区**共用同一个结果**（`controlsVisible`），所以控制条和头像同进同出 ——
 * 这是明确要的：鼠标划到左下角时控制条也要出来。
 */

/** 顶部唤醒区：显示用 90px、隐藏用 130px */
export const CONTROLS_SHOW_AT = 90
export const CONTROLS_HIDE_AT = 130

/** 左下角唤醒区：到左边和到下边都得在这个距离内 */
export const CORNER_SHOW_AT = 110
export const CORNER_HIDE_AT = 150

/** 只用到这几个字段 —— 方便单测直接塞个假矩形 */
export type StageRect = {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * 鼠标在不在**顶部**唤醒区。
 *
 * ⚠️ 迟滞是必须的：显示用 90、隐藏用 130。用同一个值的话，
 *    鼠标停在边界上轻微一抖，控制条就会反复横跳、一闪一闪。
 *    `wasNear` 就是"上一帧在不在"，用它选阈值。
 */
export function inTopZone(clientY: number, wasNear: boolean): boolean {
  return clientY <= (wasNear ? CONTROLS_HIDE_AT : CONTROLS_SHOW_AT)
}

/**
 * 鼠标在不在**左下角**唤醒区（观看者头像那一块）。
 *
 * ⚠️ 必须**同时**满足"靠左"和"靠下"。只判一个的话，
 *    屏幕左上角、右下角也会把头像唤醒出来，很怪。
 */
export function inCornerZone(
  clientX: number,
  clientY: number,
  rect: StageRect,
  wasNear: boolean
): boolean {
  const reach = wasNear ? CORNER_HIDE_AT : CORNER_SHOW_AT
  const fromLeft = clientX - rect.left
  const fromBottom = rect.bottom - clientY
  // ⚠️ 还要挡住**负数**（也就是鼠标在舞台外面）。
  //    实际上 mousemove 只挂在舞台上，坐标不会跑出去；
  //    但契约上"离左边 -300px"显然不该算"靠左下角"，
  //    写清楚比"反正不会发生"稳。
  if (fromLeft < 0 || fromBottom < 0) return false
  return fromLeft <= reach && fromBottom <= reach
}
