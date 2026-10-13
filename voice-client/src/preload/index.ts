import { contextBridge, ipcRenderer } from 'electron'
import { join } from 'node:path'

/** 主进程推上来的更新事件 */
export type UpdateEvent =
  | { type: 'available'; version: string }
  | { type: 'none' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }

/** 点窗口关闭按钮时的行为 */
export type CloseAction = 'ask' | 'tray' | 'quit'

// ══════════════════════════════════════════════════════════════════
//  系统声音捕获（原生插件）
//
//  为什么放在 **preload** 而不是主进程：
//      渲染进程开了 sandbox: false，preload 有完整 Node 能力。
//      在这里直接 require 原生插件，采集线程的回调就直接进渲染进程，
//      **一次 IPC 都不用走**。
//      走主进程的话每秒要搬 200 条消息，白白多一层拷贝和序列化。
// ══════════════════════════════════════════════════════════════════

/** 原生插件的最小接口形状 */
type NativeCapture = {
  start: (
    opts: { pid: number; mode: 'exclude' | 'include' },
    onData: (buf: unknown) => void
  ) => void
  stop: () => void
}
type NativeModule = {
  available: boolean
  reason: string
  create: () => NativeCapture | null
}

/**
 * 要排除的进程树根 = **Electron 主进程**。
 *
 * 不能用自己的 process.pid —— 那是渲染进程，它和 Chromium 的
 * AudioService（真正出声的那个）是**兄弟**，排除渲染进程的树排不掉音频。
 *
 * 用 sendSync：只在 preload 加载时调一次，开销可以忽略，
 * 但换来了"渲染进程随时都能同步拿到它"。
 */
const mainPid: number = (() => {
  try {
    return Number(ipcRenderer.sendSync('app:mainPid')) || 0
  } catch {
    return 0
  }
})()

/**
 * 加载原生插件。
 *
 * 路径是**运行时拼的**，rollup 静态分析不出来，所以会原样保留成 require ——
 * 这正是我们要的：插件是编译好的二进制，不能被 bundle。
 *
 * 开发时：   <项目根>/out/preload  →  <项目根>/native/process-loopback
 * 打包后：   app.asar/out/preload  →  app.asar/native/process-loopback
 *            （.node 会被 electron-builder 解到 app.asar.unpacked，
 *              Electron 的 require 会自动改道过去）
 */
const nativeModule: NativeModule = (() => {
  const fallback: NativeModule = {
    available: false,
    reason: '',
    create: () => null,
  }
  try {
    const dir = join(__dirname, '..', '..', 'native', 'process-loopback')
    const mod = require(dir) as NativeModule
    return mod
  } catch (err) {
    return {
      ...fallback,
      reason: `原生捕获插件加载失败：${(err as Error).message}`,
    }
  }
})()

let capture: NativeCapture | null = null

const screenAudio = {
  /** 插件能不能用。false 时渲染层要退回 Chromium 的整系统捕获 */
  available: nativeModule.available,

  /** 不可用的原因，空串表示能用 */
  reason: nativeModule.reason || (nativeModule.available ? '' : '原生捕获插件不可用'),

  /** 采集时排除的进程树根（Electron 主进程 PID），0 表示没拿到 */
  mainPid,

  /**
   * 开始采集系统声音。
   *
   * `onData` 收到的是**交错的 16 位有符号 / 48kHz / 立体声** PCM
   * （Uint8Array，跨 contextBridge 会从 Buffer 变成 Uint8Array）。
   * `onError` 在采集出问题时被叫一次。
   */
  start(onData: (pcm: Uint8Array) => void, onError: (message: string) => void): void {
    if (!nativeModule.available) {
      onError(nativeModule.reason || '原生捕获插件不可用')
      return
    }
    if (!mainPid) {
      onError('没拿到主进程 PID，无法确定要排除哪棵进程树')
      return
    }

    // 同一时间只留一路采集，重复调用先停掉旧的
    try {
      capture?.stop()
    } catch {
      /* ignore */
    }
    capture = null

    const cap = nativeModule.create()
    if (!cap) {
      onError('创建捕获器失败')
      return
    }
    capture = cap

    try {
      cap.start({ pid: mainPid, mode: 'exclude' }, (buf: unknown) => {
        // 出错时回调收到的是 Error 对象
        if (buf instanceof Error) {
          onError(buf.message)
          return
        }
        onData(buf as Uint8Array)
      })
    } catch (err) {
      capture = null
      onError((err as Error).message)
    }
  },

  /** 停止采集。没在跑时什么也不做 */
  stop(): void {
    if (!capture) return
    const c = capture
    capture = null
    try {
      c.stop()
    } catch {
      /* 停的时候出错没什么可做的 */
    }
  },
}

/**
 * 暴露给渲染进程的桌面能力。
 * 渲染进程开了 sandbox: false，但仍然通过 contextBridge 显式白名单，
 * 不要把 ipcRenderer 整个丢出去。
 */
const desktop = {
  /** 列出可共享的屏幕和窗口（含缩略图 dataURL） */
  listSources: (): Promise<
    { id: string; name: string; isScreen: boolean; thumbnail: string }[]
  > => ipcRenderer.invoke('screen:list'),

  /** 记录用户选中的源，供 display-media 请求处理器使用 */
  pickSource: (id: string): Promise<boolean> => ipcRenderer.invoke('screen:pick', id),

  /**
   * 截图：主进程会把窗口藏起来、给每块屏幕盖一个浮层让你框选。
   *
   * 返回裁好的 PNG（dataURL）+ 原生像素尺寸；用户按 Esc 取消则返回 null。
   * 整个过程窗口是隐藏的 —— 但语音不会断，只是看不见界面。
   */
  captureRegion: (): Promise<{
    dataUrl: string
    width: number
    height: number
  } | null> => ipcRenderer.invoke('screen:captureRegion'),

  /** 用系统浏览器打开链接 */
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('app:openExternal', url),

  /**
   * 把文件下载到本地（弹系统「另存为」对话框）。
   *
   * 和 `openExternal` 的区别很关键：那个会把 URL 丢给浏览器，
   * 图片得在浏览器里再看一遍、想存还得再操作一次 —— 用起来像"跳出应用"。
   * 这个走应用自己的下载流程，存完还在应用里。
   */
  download: (url: string): Promise<boolean> => ipcRenderer.invoke('app:download', url),

  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),

  /**
   * 「正在听歌」。主进程有个常驻的 PowerShell 在读 Windows 的 SMTC
   * （系统媒体控制），拿到歌名/歌手后推过来。
   *
   * 关掉设置里的开关时**检测子进程直接停掉** —— 不是"读了不发"。
   */
  getNowPlaying: (): Promise<{ app: string; title: string; artist: string } | null> =>
    ipcRenderer.invoke('app:getNowPlaying'),

  onNowPlaying: (
    cb: (np: { app: string; title: string; artist: string } | null) => void
  ): (() => void) => {
    const h = (
      _e: Electron.IpcRendererEvent,
      np: { app: string; title: string; artist: string } | null
    ) => cb(np)
    ipcRenderer.on('app:nowPlaying', h)
    return () => ipcRenderer.off('app:nowPlaying', h)
  },

  /** 开关「正在听歌」检测 */
  setMediaDetect: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('app:setMediaDetect', enabled),

  /**
   * 「正在玩游戏」。和听歌那套**完全独立** —— 独立的脚本、独立的子进程、
   * 独立的开关。只比对一张内置的游戏进程白名单，不碰游戏进程本身。
   */
  getNowPlayingGame: (): Promise<{ exe: string; name: string } | null> =>
    ipcRenderer.invoke('app:getNowPlayingGame'),

  onNowPlayingGame: (
    cb: (g: { exe: string; name: string } | null) => void
  ): (() => void) => {
    const h = (
      _e: Electron.IpcRendererEvent,
      g: { exe: string; name: string } | null
    ) => cb(g)
    ipcRenderer.on('app:nowPlayingGame', h)
    return () => ipcRenderer.off('app:nowPlayingGame', h)
  },

  /** 开关「正在玩游戏」检测。默认开 */
  setGameDetect: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('app:setGameDetect', enabled),

  /**
   * 列出当前**有可见窗口**的进程（进程名 + 窗口标题）。
   * 给"上报游戏"的对话框用 —— 窗口标题比进程名好认多了。
   */
  listWindows: (): Promise<{ exe: string; title: string }[]> =>
    ipcRenderer.invoke('app:listWindows'),

  /** 上报一个内置表里没有的游戏（存本地，别人看到的是解析后的显示名） */
  addCustomGame: (
    exe: string,
    name: string
  ): Promise<{ ok: boolean; reason?: string; customGames?: Record<string, string> }> =>
    ipcRenderer.invoke('app:addCustomGame', exe, name),

  removeCustomGame: (
    exe: string
  ): Promise<{ ok: boolean; customGames?: Record<string, string> }> =>
    ipcRenderer.invoke('app:removeCustomGame', exe),

  /**
   * 把服务端下发的**全服共享**游戏表交给主进程。
   *
   * 主进程会合并进检测白名单（优先级：内置 < 共享 < 本地自己报的）
   * 并重启探测器。
   */
  setSharedGames: (games: Record<string, string>): Promise<boolean> =>
    ipcRenderer.invoke('app:setSharedGames', games),

  /**
   * 当前是不是以管理员权限在运行。
   *
   * 英雄联盟这类游戏以管理员权限运行时会**屏蔽普通权限程序的全局快捷键**
   * （Windows 的 UIPI）—— 设置页靠这一项提示用户要不要提权。
   */
  isElevated: (): Promise<boolean> => ipcRenderer.invoke('app:isElevated'),

  /** 以管理员身份重启自己（弹 UAC） */
  relaunchElevated: (): Promise<boolean> => ipcRenderer.invoke('app:relaunchElevated'),

  /**
   * 「以后都自动以管理员启动」。
   *
   * 靠一个"以最高权限运行"的计划任务：注册时弹**一次** UAC，
   * 之后每次启动都能静默提权，不再打扰。
   */
  elevateTaskExists: (): Promise<boolean> => ipcRenderer.invoke('app:elevateTaskExists'),
  registerElevateTask: (): Promise<boolean> => ipcRenderer.invoke('app:registerElevateTask'),
  unregisterElevateTask: (): Promise<boolean> => ipcRenderer.invoke('app:unregisterElevateTask'),

  // ── 启动与关闭偏好 + 全局快捷键 ──────────────────────────
  // 都存在主进程，因为它们必须在窗口建立之前就生效：
  // 关闭行为要在 close 事件里用，开机自启和快捷键要在 app ready 时就注册。
  getPrefs: (): Promise<{
    closeAction: CloseAction
    openAtLogin: boolean
    shortcuts: { mute: string; deafen: string }
    /** 「正在听歌」检测。默认开 */
    mediaDetect: boolean
    /** 「正在玩游戏」检测。默认开，和上面那个互相独立 */
    gameDetect: boolean
    /** 用户自己上报的游戏：进程名（小写不带 .exe）→ 显示名 */
    customGames: Record<string, string>
  }> => ipcRenderer.invoke('app:getPrefs'),

  /**
   * 设一个全局快捷键。accelerator 是 Electron 的写法（`Control+Shift+M`），
   * 传空字符串表示解绑。
   *
   * 返回 ok / reason —— 快捷键可能被别的程序占着，那种情况**必须告诉用户**，
   * 否则他按下去没反应，只会以为程序坏了。
   */
  setShortcut: (
    action: 'mute' | 'deafen',
    accelerator: string
  ): Promise<{ ok: boolean; reason: string }> =>
    ipcRenderer.invoke('shortcut:set', action, accelerator),

  /**
   * 全局快捷键被按下。**窗口不可见时也会触发** ——
   * 这正是它的意义：在游戏里也能一键闭麦。
   */
  onShortcut: (cb: (action: 'mute' | 'deafen') => void): (() => void) => {
    const handler = (_e: unknown, action: 'mute' | 'deafen') => cb(action)
    ipcRenderer.on('shortcut:trigger', handler)
    return () => {
      ipcRenderer.off('shortcut:trigger', handler)
    }
  },

  setCloseAction: (action: CloseAction): Promise<CloseAction> =>
    ipcRenderer.invoke('app:setCloseAction', action),

  setOpenAtLogin: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('app:setOpenAtLogin', enabled),

  /** 用户在系统弹窗里勾了「记住我的选择」时，主进程会把新值推上来 */
  onCloseActionChanged: (cb: (action: CloseAction) => void): (() => void) => {
    const handler = (_e: unknown, action: CloseAction) => cb(action)
    ipcRenderer.on('app:closeAction', handler)
    return () => {
      ipcRenderer.off('app:closeAction', handler)
    }
  },

  /**
   * 有人又双击了一次应用图标。
   *
   * 主进程已经拿单实例锁把那个新进程挡掉了、并把本窗口唤到了前面；
   * 这里只是给界面一个提示，让用户知道双击是**有效果的**，不是没反应。
   */
  onAlreadyRunning: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('app:alreadyRunning', handler)
    return () => {
      ipcRenderer.off('app:alreadyRunning', handler)
    }
  },

  // ── 自动更新 ────────────────────────────────────────────
  /**
   * 订阅更新事件。返回一个取消订阅的函数。
   *
   * 主进程发的是几个独立的 channel（available / none / progress / downloaded / error），
   * 这里合并成一个带 type 字段的事件流，渲染层就不用记那么多 channel 名了。
   */
  onUpdate: (cb: (event: UpdateEvent) => void): (() => void) => {
    const bindings: [string, (...args: unknown[]) => void][] = [
      [
        'update:available',
        (_e, info) => cb({ type: 'available', version: readVersion(info) }),
      ],
      ['update:none', () => cb({ type: 'none' })],
      [
        'update:progress',
        (_e, p) => cb({ type: 'progress', percent: readPercent(p) }),
      ],
      [
        'update:downloaded',
        (_e, info) => cb({ type: 'downloaded', version: readVersion(info) }),
      ],
      ['update:error', (_e, message) => cb({ type: 'error', message: String(message) })],
    ]

    for (const [channel, handler] of bindings) ipcRenderer.on(channel, handler)
    return () => {
      for (const [channel, handler] of bindings) ipcRenderer.off(channel, handler)
    }
  },

  /** 手动检查更新。开发模式下会返回 { ok: false, reason } */
  checkUpdate: (): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('update:check'),

  /** 开始下载（用户点了"下载"之后） */
  downloadUpdate: (): Promise<boolean> => ipcRenderer.invoke('update:download'),

  /** 退出并安装。会重启应用 */
  installUpdate: (): Promise<boolean> => ipcRenderer.invoke('update:install'),

  // ── 屏幕共享的系统声音（进程级回环，**不含通话声**）──────
  /**
   * 这套接口存在的意义：让投屏的系统声音里**不含通话声**。
   *
   * 详细原理见 src/renderer/src/lib/screenAudio.ts 顶部的说明。
   * `available` 为 false 时渲染层要退回 Chromium 的整系统捕获 ——
   * 功能降级比功能没有强。
   */
  screenAudio,

  platform: process.platform,
  isElectron: true as const,
}

function readVersion(info: unknown): string {
  const v = (info as { version?: unknown } | undefined)?.version
  return typeof v === 'string' ? v : ''
}

function readPercent(p: unknown): number {
  const n = (p as { percent?: unknown } | undefined)?.percent
  return typeof n === 'number' ? Math.round(n) : 0
}

contextBridge.exposeInMainWorld('desktop', desktop)

export type DesktopApi = typeof desktop
