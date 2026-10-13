/**
 * 界面主题。
 *
 * ⚠️ **localStorage 的 key 在三个地方出现**，改的时候要一起改：
 *   · 这里（读写）
 *   · `src/renderer/index.html` 里那段防止闪屏的内联脚本
 *   · 没有了 —— 就这两处
 *
 * 主题**不经过主进程**：窗口外观是渲染进程自己的事，
 * 而且 Electron 的标题栏本来就跟随系统，存主进程也没用。
 */

export type Theme = 'dark' | 'light'

/** 和 index.html 里那段内联脚本必须一致 */
export const THEME_KEY = 'voice.theme'

/** 读主题。没设过、或者存储不可用 → 深色（一直是默认） */
export function loadTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/**
 * 应用主题：写进 `<html data-theme="...">`，CSS 靠这个属性选变量组。
 *
 * 同时存下来 —— 下次打开时 index.html 里的内联脚本会**在首屏绘制之前**
 * 把它读出来，所以不会先闪一下深色再变浅色。
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    /* 存储不可用就算了，本次会话仍然生效 */
  }
}
