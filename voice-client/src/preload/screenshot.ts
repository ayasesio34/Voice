import { contextBridge, ipcRenderer } from 'electron'

/**
 * 截图浮层的 preload。
 *
 * 故意和主界面的 preload 分开 —— 浮层是个"临时工"，只该能拿到
 * 它需要的那张图，不该顺便拿到打开链接、切设备、装更新这些能力。
 */
contextBridge.exposeInMainWorld('shotApi', {
  /** 主进程等页面加载好之后，把要框选的那张全屏截图发过来 */
  onInit: (cb: (payload: { dataUrl: string }) => void): void => {
    ipcRenderer.on('shot:init', (_event, payload: { dataUrl: string }) => cb(payload))
  },

  /** 图已经解码并画好了 —— 主进程收到才显示窗口，避免黑屏闪一下 */
  ready: (): void => ipcRenderer.send('shot:ready'),

  /** 框选完成，把裁好的 PNG 交回去 */
  done: (result: { dataUrl: string; width: number; height: number }): Promise<boolean> =>
    ipcRenderer.invoke('shot:done', result),

  /** 用户按了 Esc 或点了取消 */
  cancel: (): Promise<boolean> => ipcRenderer.invoke('shot:cancel'),
})

export type ShotApi = {
  onInit: (cb: (payload: { dataUrl: string }) => void) => void
  ready: () => void
  done: (result: { dataUrl: string; width: number; height: number }) => Promise<boolean>
  cancel: () => Promise<boolean>
}
