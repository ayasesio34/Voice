/**
 * 快捷键的录入与显示。
 *
 * 存的是 **Electron 的 accelerator 格式**（`Control+Shift+M`）——
 * 主进程的 `globalShortcut` 直接吃这个字符串，不用再转换一层。
 * 显示给用户时才换成 `Ctrl + Shift + M`。
 */

const MOD_LABEL: Record<string, string> = {
  Control: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
  Super: 'Win',
}

/** 给用户看的写法 */
export function formatAccelerator(accel: string): string {
  if (!accel) return '未设置'
  return accel
    .split('+')
    .map((p) => MOD_LABEL[p] ?? p)
    .join(' + ')
}

/** KeyboardEvent.key -> Electron accelerator 里的键名。没列到的走通用规则 */
const KEY_ALIAS: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Return',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
}

const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/

/**
 * 「打字键」—— 单独绑会把整个系统的输入废掉，所以这几个**必须**带修饰键。
 *
 * ⚠️ 只该列真正用来打字的键。之前我一刀切要求"所有键都必须带修饰键"，
 *    结果 PageUp、F1~F24 这类明明很常用的语音快捷键也被挡掉了 ——
 *    那是过度保护：PageUp 根本打不出字，绑它不会影响输入。
 */
const TYPING_KEY = /^([a-zA-Z]|[0-9]|Space|Tab|Return|Backspace)$/

/** KeyboardEvent.key -> Electron accelerator 键名。认不出来返回 null */
function normalizeKey(key: string): string | null {
  const alias = KEY_ALIAS[key]
  if (alias) return alias
  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase()
  if (/^[0-9]$/.test(key)) return key
  if (FUNCTION_KEY.test(key)) return key
  return null
}

/**
 * 把一次按键变成 accelerator。
 *
 * 返回 null 表示"这个组合不能用"，两种原因：
 *   1. 认不出的键（媒体键、输入法组合键之类）
 *   2. **打字键 + 没带修饰键** —— 那会让所有程序里都打不出字，
 *      宁可不让设，也不能让用户把键盘废掉
 *
 * 其余情况都放行，包括 PageUp / PageDown / Home / End / 方向键 / F1~F24
 * 这些**单独按也允许** —— 很多语音软件的习惯用法就是这样。
 * 代价是那个键不会再传给别的程序，这一点在设置界面里会提示。
 */
export function captureAccelerator(e: KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')

  // 只按住了修饰键 —— 组合还没打完，不算一次完整录入
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null

  const key = normalizeKey(e.key)
  if (!key) return null
  if (mods.length === 0 && TYPING_KEY.test(key)) return null

  return [...mods, key].join('+')
}

/** 这个组合为什么不能用 —— 用来给用户一句人话 */
export function acceleratorHint(e: KeyboardEvent): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null // 还在组合中
  if (captureAccelerator(e)) return null

  if (!normalizeKey(e.key)) return '这个键不支持（媒体键、输入法组合键之类），换一个试试'

  // 能走到这里只剩一种情况：打字键 + 没修饰键
  return '字母和数字要带上 Ctrl / Alt / Shift，否则会把系统里的普通打字吃掉'
}
