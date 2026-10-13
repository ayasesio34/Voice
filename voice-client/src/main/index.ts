import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  Tray,
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getNowPlaying,
  getNowPlayingGame,
  onNowPlaying,
  onNowPlayingGame,
  setCustomGames,
  setSharedGames,
  startGameWatch,
  startMediaWatch,
  stopGameWatch,
  stopMediaWatch,
} from './mediaSession'

// ─────────────────────────────────────────────────────────────
// 主进程的持久化设置
//
// 只放"窗口还没建立时就得知道"的东西（关闭行为、开机自启、全局快捷键）。
// 界面相关的偏好（头像、昵称、服务器地址）走渲染进程的 localStorage。
// ─────────────────────────────────────────────────────────────
type CloseAction = 'ask' | 'tray' | 'quit'

/** 可以绑快捷键的动作 */
type ShortcutAction = 'mute' | 'deafen'

type MainSettings = {
  /** 点窗口 × 时的行为。ask = 每次弹窗问 */
  closeAction: CloseAction
  /**
   * 全局快捷键（Electron accelerator 格式）。
   *
   * 存在主进程是因为它们必须**在窗口建立之前**就注册好 ——
   * 否则启动后那几秒按了没反应。空字符串表示没绑。
   */
  shortcuts: Record<ShortcutAction, string>
  /**
   * 「正在听歌」检测。**默认开**。
   *
   * 存主进程是因为检测本身跑在主进程（一个常驻的 PowerShell 读 SMTC）——
   * 关掉时**连子进程都不启动**，而不是"检测了但不上报"。
   * 那样隐私是假的：进程还在跑、数据还在读，只是没发出去而已。
   *
   * 游戏检测是另一件事（要枚举进程），开关会**和它一起加** ——
   * 现在放一个点了没反应的开关只会让人以为坏了。
   */
  mediaDetect: boolean
  /**
   * 「正在玩游戏」检测。**默认开**。
   *
   * 和 mediaDetect 是**两个独立的开关**，各自只管自己的子进程 ——
   * 关掉音乐不该把游戏也关了。
   *
   * 检测只做「白名单里的进程在不在」，不碰游戏进程本身
   * （不读内存、不注入、不装键盘钩子、不做 overlay）。详见 mediaSession.ts。
   */
  gameDetect: boolean
  /**
   * 用户自己上报的游戏：进程名（小写，不带 .exe）→ 显示名。
   *
   * 内置表里没有的游戏走这里。**存在本地**就够了 ——
   * 别人看到的是解析后的显示名（客户端上报的是名字，不是进程名），
   * 所以你加一条，朋友那边照样显示得对。
   */
  customGames: Record<string, string>
}

/** 深拷贝一份默认值。shortcuts 是嵌套对象，浅拷贝会几个实例共用同一份 */
function defaultMainSettings(): MainSettings {
  return {
    closeAction: 'ask',
    // 沿用 Discord 的习惯用法，多数人不用改
    shortcuts: { mute: 'Control+Shift+M', deafen: 'Control+Shift+D' },
    mediaDetect: true,
    gameDetect: true,
    customGames: {},
  }
}

let mainSettings: MainSettings = defaultMainSettings()

/** 置为 true 之后 close 事件不再拦截 —— 真正要退出了 */
let isQuitting = false
let tray: Tray | null = null

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function loadMainSettings(): MainSettings {
  const fallback = defaultMainSettings()

  try {
    const parsed = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Partial<MainSettings>
    const action = parsed.closeAction
    // 老版本的 settings.json 里没有 shortcuts 这一项 —— 用 Partial 兜住
    const sc = (parsed.shortcuts ?? {}) as Partial<Record<ShortcutAction, string>>

    return {
      closeAction: action === 'tray' || action === 'quit' ? action : 'ask',
      shortcuts: {
        mute: typeof sc.mute === 'string' ? sc.mute : fallback.shortcuts.mute,
        deafen: typeof sc.deafen === 'string' ? sc.deafen : fallback.shortcuts.deafen,
      },
      // 老版本的 settings.json 里没有这一项 —— 缺省是**开**（和默认值一致）
      mediaDetect: typeof parsed.mediaDetect === 'boolean' ? parsed.mediaDetect : true,
      gameDetect: typeof parsed.gameDetect === 'boolean' ? parsed.gameDetect : true,
      // 老配置里没有这一项 —— 缺省就是空表
      customGames:
        parsed.customGames && typeof parsed.customGames === 'object' && !Array.isArray(parsed.customGames)
          ? (parsed.customGames as Record<string, string>)
          : {},
    }
  } catch {
    // 文件不存在 / 坏了 —— 用默认值，不影响启动
    return fallback
  }
}

function saveMainSettings(next: MainSettings): void {
  try {
    writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    console.error('保存主进程设置失败：', err)
  }
}

/**
 * 重新注册全部全局快捷键。
 *
 * ⚠️ 必须**先全部注销再注册**：`globalShortcut` 对同一个 accelerator
 *    重复注册会直接返回 false，看起来像"被别的程序占了"，
 *    其实是自己占着自己。
 *
 * 注册失败不抛错，只打日志 —— 被别人占走是常见情况，
 * 设置界面会通过 `globalShortcut.isRegistered()` 把结果告诉用户。
 */
function registerShortcuts(): void {
  globalShortcut.unregisterAll()

  const entries = Object.entries(mainSettings.shortcuts) as [ShortcutAction, string][]

  for (const [action, accel] of entries) {
    if (!accel) continue

    try {
      const ok = globalShortcut.register(accel, () => {
        // 窗口可能藏在托盘里（甚至完全不可见）—— 快捷键照样要管用，
        // 所以这里**刻意不检查可见性**
        const [win] = BrowserWindow.getAllWindows()
        if (win && !win.isDestroyed()) win.webContents.send('shortcut:trigger', action)
      })
      if (!ok) {
        console.warn(`[warn] 全局快捷键 ${accel}（${action}）注册失败，多半被别的程序占了`)
      }
    } catch (err) {
      console.warn(`[warn] 全局快捷键 ${accel}（${action}）注册出错：`, err)
    }
  }
}

function getOpenAtLogin(): boolean {
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────
// 管理员权限
//
// 为什么需要：**很多游戏（英雄联盟、无畏契约等）以管理员权限运行**，
// 而 Windows 的 UIPI（用户界面特权隔离）会挡住普通权限程序的全局热键 ——
// `RegisterHotKey` 在高权限窗口处于前台时**根本不触发**。
//
// 这不是 Electron 的 bug，是 Windows 的设计：低完整性进程不能截获
// 发给高完整性窗口的输入。Discord、AutoHotkey 都有同样的坑，
// 标准解法就是**让本程序也以管理员身份运行**。
//
// 所以这里做两件事：查当前是不是管理员 + 提供"以管理员重启"。
// ─────────────────────────────────────────────────────────────

/** 当前进程是不是以管理员在跑。非 Windows 一律返回 false（那边没这个问题） */
function isElevated(): boolean {
  if (process.platform !== 'win32') return false
  try {
    // `net session` 需要管理员权限才能跑通 —— 用它当探针，
    // 比自己解析 token 简单得多。stdio 设成 ignore，不要管道。
    execFileSync('net', ['session'], { stdio: 'ignore', timeout: 4000 })
    return true
  } catch {
    return false
  }
}

/**
 * 以管理员身份重启自己。
 *
 * 走 PowerShell 的 `Start-Process -Verb RunAs` —— 只有它会弹 UAC 提权框。
 *
 * ⚠️ 顺序很关键：**先退出自己，再拉起提权的新实例**。
 *
 *    本程序有单实例锁（`requestSingleInstanceLock`），而那个锁
 *    **按会话共享、不区分完整性级别**。如果先启动新实例，
 *    它会因为拿不到锁而立刻自杀；我们再一退 —— 两个就都没了。
 *
 *    所以把启动挂在 `will-quit` 上（那时锁即将释放），并让 PowerShell
 *    先睡 700ms，兜住"锁还没完全释放"的那一点点竞态。
 */
function relaunchElevated(): boolean {
  if (process.platform !== 'win32') return false

  const exe = app.getPath('exe')

  try {
    app.once('will-quit', () => {
      spawn(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Start-Sleep -Milliseconds 700; Start-Process -FilePath "${exe}" -Verb RunAs`,
        ],
        { detached: true, stdio: 'ignore' }
      ).unref()
    })

    // 稍微延迟一下再退：让 IPC 的返回值能先回到渲染进程
    setTimeout(() => app.quit(), 50)
    return true
  } catch {
    return false
  }
}

/**
 * 用户在应用内的选择器里挑中的屏幕/窗口 id。
 * getDisplayMedia（以及 Electron 的 display-media 请求处理器）触发时用它。
 *
 * 注意：正常情况下我们走的是「应用内选择器 + chromeMediaSource 约束」这条路
 * （见 renderer 的 lib/livekit.ts），这套机制只是一个安全网 —— 万一将来
 * LiveKit 或某个依赖内部直接调用了 getDisplayMedia，也不会直接抛错。
 */
let pickedSourceId: string | null = null

/**
 * 版本号只有一个来源：package.json 的 `version`。
 *
 * 标题栏、安装包文件名（artifactName 里的 ${version}）都从这里取，
 * 所以不会出现"标题写 0.1 但安装包叫 0.2"这种不一致。
 *
 * ⚠️ 每次发新版**只改 package.json 里的 version**，并在 CHANGELOG.md 里记一条。
 */
const APP_VERSION = app.getVersion()

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 560,
    backgroundColor: '#313338',
    title: `Voice v${APP_VERSION}`,
    // 窗口和任务栏图标。打包后 Windows 会用 exe 内嵌的图标（electron-builder
    // 从 build.win.icon 写进去），这个主要用于开发模式下也有图标可看。
    icon: resourcePath('icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 渲染进程要直接用 WebRTC / getUserMedia，sandbox 开着会限制一部分能力
      sandbox: false,
      // 屏幕共享的 WebRTC 采集在某些平台上需要关掉这个
      webSecurity: true,
    },
  })

  // ⚠️ 页面加载后 <title> 会把窗口标题覆盖掉，必须拦一下 ——
  //    否则标题栏又变回光秃秃的 "Voice"，版本号就没了。
  win.on('page-title-updated', (event) => event.preventDefault())

  // ── 关闭按钮的行为 ───────────────────────────────────────
  //   quit —— 直接退出
  //   tray —— 隐藏到托盘（语音不断），点托盘图标能回来
  //   ask  —— 弹窗问一次，可以勾"记住我的选择"
  win.on('close', (event) => {
    if (isQuitting) return
    if (mainSettings.closeAction === 'quit') return

    event.preventDefault()

    if (mainSettings.closeAction === 'tray') {
      win.hide()
      return
    }

    void dialog
      .showMessageBox(win, {
        type: 'question',
        buttons: ['隐藏到托盘', '直接关闭'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: '关闭 Voice',
        message: '要直接关闭，还是隐藏到托盘继续挂着？',
        detail:
          '隐藏到托盘：语音不会断，还能继续和别人通话。点托盘图标可以重新打开。\n' +
          '直接关闭：退出程序，语音会断开。',
        checkboxLabel: '记住我的选择，以后不再询问',
        checkboxChecked: false,
      })
      .then(({ response, checkboxChecked }) => {
        const action: CloseAction = response === 0 ? 'tray' : 'quit'

        if (checkboxChecked) {
          mainSettings = { ...mainSettings, closeAction: action }
          saveMainSettings(mainSettings)
          // 通知界面刷新 —— 否则设置里那个下拉框还显示"每次询问"
          if (!win.isDestroyed()) win.webContents.send('app:closeAction', action)
        }

        if (action === 'tray') {
          win.hide()
        } else {
          isQuitting = true
          app.quit()
        }
      })
  })

  // 外部链接交给系统浏览器，不要在应用窗口里打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    // 开发模式：electron-vite 起了 Vite dev server，带热更新
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ─────────────────────────────────────────────────────────────
// 托盘
//
// "隐藏到托盘"必须有办法回来 —— 不然窗口一藏就再也打不开了。
// 托盘菜单里也放一个「退出」，因为关闭按钮已经被改造成"隐藏"了。
// ─────────────────────────────────────────────────────────────
function showWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * resources/ 下某个文件的绝对路径。
 *
 *   开发时 __dirname = <项目>/out/main              → <项目>/resources
 *   打包后 __dirname = <app>/out/main（在 asar 里）  → <app>/resources
 *
 * 两种情况 '../../resources' 都成立，所以不用区分 dev / prod。
 * （前提是 electron-builder 的 files 里包含 resources/ —— 见 package.json）
 */
function resourcePath(name: string): string {
  return join(__dirname, '../../resources', name)
}

/**
 * 托盘图标。
 *
 * ⚠️ 之前用的是 nativeImage.createFromPath(process.execPath) —— 从 exe 里抠图标。
 *    但开发模式下 execPath 指向 node_modules 里的 electron.exe，
 *    抠出来是**空的**，托盘于是变成一个"占着地方却看不见"的空格子。
 *
 * 现在用随应用一起打包的 tray.png（16×16）。同目录下还有 tray@2x.png（32×32），
 * Electron 会按 @2x 约定在高 DPI 屏上自动选用，不用手动缩放。
 */
function trayIcon(): Electron.NativeImage {
  const img = nativeImage.createFromPath(resourcePath('tray.png'))
  if (!img.isEmpty()) return img

  // 文件被删之类的极端情况：退回从 exe 抠，实在没有才用空图
  const fromExe = nativeImage.createFromPath(process.execPath)
  return fromExe.isEmpty() ? nativeImage.createEmpty() : fromExe
}

function createTray(win: BrowserWindow): void {
  if (tray) return

  try {
    tray = new Tray(trayIcon())
  } catch (err) {
    // 某些 Linux 桌面环境没有托盘支持 —— 不该因此让应用起不来
    console.error('创建托盘图标失败：', err)
    return
  }

  tray.setToolTip('Voice')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主界面', click: () => showWindow(win) },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ])
  )

  // 单击托盘图标直接唤起窗口 —— 大多数人不会去点右键菜单
  tray.on('click', () => showWindow(win))
}

// ─────────────────────────────────────────────────────────────
// 屏幕共享：安全网
// ─────────────────────────────────────────────────────────────
function installDisplayMediaHandler(): void {
  // Electron 30+ 才需要/支持这个；老版本上这个 API 不存在，忽略即可
  const target = session.defaultSession as unknown as {
    setDisplayMediaRequestHandler?: (
      handler: (req: { audioRequested?: boolean }, cb: (streams: unknown) => void) => void,
      opts?: { useSystemPicker?: boolean }
    ) => void
  }
  if (typeof target.setDisplayMediaRequestHandler !== 'function') return

  target.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
      const chosen =
        sources.find((s) => s.id === pickedSourceId) ??
        sources.find((s) => s.id.startsWith('screen:')) ??
        sources[0]

      if (!chosen) {
        callback({ video: undefined, audio: undefined })
        return
      }

      callback({
        video: chosen,
        // Windows 上 'loopback' 能把系统声音一起捕获（共享视频/音乐的关键）
        audio:
          _request?.audioRequested && process.platform === 'win32' ? 'loopback' : undefined,
      })
    },
    { useSystemPicker: false }
  )
}

// ─────────────────────────────────────────────────────────────
// 截图（框选区域）
//
// 流程：
//   1. 把主窗口藏起来 —— 否则截出来的图里会带着聊天界面
//   2. 用 desktopCapturer 抓**每块屏幕**的完整缩略图
//   3. 给每块屏幕开一个无边框浮层，盖在上面显示那张冻结图
//   4. 用户在浮层上拖出选区，前端用 canvas 裁出原生分辨率的 PNG
//   5. 收回浮层、恢复主窗口，把 PNG 交给聊天窗口
//
// "先把画面冻住再框选"是关键 —— 否则框选过程中底下的画面还在动，
// 截出来的和看到的不一样。
// ─────────────────────────────────────────────────────────────
type ShotResult = { dataUrl: string; width: number; height: number }

/** 正在进行的截图。非空表示"已经在截了"，不该重入 */
let shotFinish: ((result: ShotResult | null) => void) | null = null
let shotOverlays: BrowserWindow[] = []

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function closeShotOverlays(): void {
  const list = shotOverlays
  shotOverlays = []
  for (const w of list) {
    if (!w.isDestroyed()) w.destroy()
  }
}

/** 结束这次截图：收浮层、兑现 Promise。result 为 null 表示用户取消 */
function finishShot(result: ShotResult | null): void {
  const resolve = shotFinish
  shotFinish = null
  closeShotOverlays()
  resolve?.(result)
}

async function captureRegion(parent: BrowserWindow): Promise<ShotResult | null> {
  if (shotFinish) return null // 已经在截了

  const displays = screen.getAllDisplays()
  if (displays.length === 0) return null

  const wasVisible = parent.isVisible()
  if (wasVisible) parent.hide()

  // 等窗口真的从屏幕上消失。Windows 上隐藏动画要一两百毫秒，
  // 不等的话截出来的图里会留着半个窗口。
  await delay(300)

  // 缩略图按"最大那块屏幕的原生分辨率"要 —— 这是能拿到的最高画质。
  // 传 0 是"不要缩略图"，不要搞混。
  const maxW = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)))
  const maxH = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)))

  let sources: Electron.DesktopCapturerSource[]
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: maxW, height: maxH },
    })
  } catch (err) {
    console.error('截图失败：', err)
    if (wasVisible && !parent.isDestroyed()) parent.show()
    return null
  }

  const ready = new Promise<ShotResult | null>((resolve) => {
    shotFinish = resolve
  })

  const restore = () => {
    if (wasVisible && !parent.isDestroyed()) {
      parent.show()
      parent.focus()
    }
  }

  displays.forEach((display, index) => {
    // display_id 是 Electron 用来把 source 和 display 对上的字段
    const source =
      sources.find((s) => s.display_id === String(display.id)) ?? sources[index]
    if (!source || source.thumbnail.isEmpty()) return

    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      show: false, // 等图解码好再显示，避免闪黑
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#000000',
      webPreferences: {
        preload: join(__dirname, '../preload/screenshot.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    // 盖在所有窗口之上，包括任务栏
    overlay.setAlwaysOnTop(true, 'screen-saver')
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    // 浮层里没有链接，但还是防一手
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    shotOverlays.push(overlay)

    overlay.webContents.once('did-finish-load', () => {
      if (overlay.isDestroyed()) return
      overlay.webContents.send('shot:init', { dataUrl: source.thumbnail.toDataURL() })
      overlay.focus()
    })

    overlay.on('closed', () => {
      shotOverlays = shotOverlays.filter((w) => w !== overlay)
      // 浮层被外部关掉了（而且没有别的浮层）—— 当作取消，别把 Promise 挂着
      if (shotOverlays.length === 0 && shotFinish) finishShot(null)
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      void overlay.loadURL(`${process.env.ELECTRON_RENDERER_URL}/screenshot.html`)
    } else {
      void overlay.loadFile(join(__dirname, '../renderer/screenshot.html'))
    }
  })

  if (shotOverlays.length === 0) {
    finishShot(null)
    restore()
    return null
  }

  const result = await ready
  restore()
  return result
}

// ─────────────────────────────────────────────────────────────
// 自动更新
//
// 走 electron-updater 的 generic provider：它去
//     <publish.url>/latest.yml
// 拉一个清单，比对版本号，需要的话下载安装包并校验哈希。
//
// 更新文件就放在**你自己的 ECS** 上（后端顺带提供一个 /updates 静态目录），
// 不依赖 GitHub Releases —— 那个国内拉不动。
//
// ⚠️ 只在**打包安装之后**才生效。开发模式下 app.isPackaged 为 false，直接跳过，
//    否则 electron-updater 会抛 "application is not packed"。
// ─────────────────────────────────────────────────────────────
function setupAutoUpdate(win: BrowserWindow): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = false // 下载与否交给用户决定
  autoUpdater.autoInstallOnAppQuit = true // 但用户直接关窗口时，退出前装上

  const send = (channel: string, payload?: unknown) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }

  autoUpdater.on('update-available', (info) =>
    send('update:available', { version: info.version })
  )
  autoUpdater.on('update-not-available', () => send('update:none'))
  autoUpdater.on('download-progress', (p) => send('update:progress', { percent: p.percent }))
  autoUpdater.on('update-downloaded', (info) =>
    send('update:downloaded', { version: info.version })
  )
  autoUpdater.on('error', (err) => send('update:error', String((err as Error)?.message ?? err)))

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      send('update:error', String((err as Error)?.message ?? err))
    })
  }

  // 启动后等 8 秒再查 —— 别和"连接服务器 + 加入语音"抢启动时间
  setTimeout(check, 8000)
  // 之后每 6 小时查一次，长时间挂着也能收到更新
  setInterval(check, 6 * 60 * 60 * 1000)
}

// ─────────────────────────────────────────────────────────────
// IPC
// ─────────────────────────────────────────────────────────────
ipcMain.handle('screen:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    // 给选择器用的缩略图。不用太大，省 CPU 和内存。
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  })

  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    isScreen: s.id.startsWith('screen:'),
    thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
  }))
})

ipcMain.handle('screen:pick', (_event, id: string) => {
  pickedSourceId = typeof id === 'string' ? id : null
  return true
})

// ── 截图 ───────────────────────────────────────────────────
ipcMain.handle('screen:captureRegion', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return null
  return captureRegion(win)
})

/** 浮层里的图已经解码画好了 —— 这时候才显示窗口，避免先闪一下黑屏 */
ipcMain.on('shot:ready', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
  }
})

ipcMain.handle('shot:done', (_event, result: unknown) => {
  const r = result as Partial<ShotResult> | undefined

  // 只接受 PNG dataURL —— 别的一律当取消，免得把乱七八糟的东西传下去
  if (!r || typeof r.dataUrl !== 'string' || !r.dataUrl.startsWith('data:image/png;base64,')) {
    finishShot(null)
    return false
  }

  copyShotToClipboard(r.dataUrl)

  finishShot({
    dataUrl: r.dataUrl,
    width: typeof r.width === 'number' ? r.width : 0,
    height: typeof r.height === 'number' ? r.height : 0,
  })
  return true
})

/**
 * 截图顺手放进系统剪贴板。
 *
 * 为什么放在**主进程**而不是渲染进程：这里拿到的是成品 dataURL，
 * 而且不依赖渲染进程的状态 —— 就算后面的上传失败了，
 * 图也已经在剪贴板上，随手就能粘到别处，不会白截一张。
 *
 * （渲染进程也能用 `navigator.clipboard.write`，但那要走权限、
 *   还可能被 CSP 拦；主进程的 `clipboard.writeImage` 一步到位。）
 */
function copyShotToClipboard(dataUrl: string): void {
  try {
    const img = nativeImage.createFromDataURL(dataUrl)
    if (img.isEmpty()) return
    clipboard.writeImage(img)
  } catch {
    // 剪贴板被别的程序占着之类的偶发情况 —— 不影响截图本身，不该让流程失败
  }
}

ipcMain.handle('shot:cancel', () => {
  finishShot(null)
  return true
})

ipcMain.handle('app:openExternal', async (_event, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) await shell.openExternal(url)
  return true
})

/**
 * 把文件**下载到本地**，弹系统原生的「另存为」对话框。
 *
 * 和 `app:openExternal` 的区别很关键：
 *   · openExternal  → 把 URL 丢给系统浏览器。图片会跑到浏览器里看，
 *                     想存下来也得在浏览器里再操作一次 —— 用起来像"跳出应用"。
 *   · downloadURL   → 走 Electron 自己的下载流程，直接弹原生保存对话框，
 *                     存完还在应用里。
 *
 * 默认文件名来自服务端的 `Content-Disposition`（那边设了 `filename*=UTF-8''…`，
 * 中文名也能正确带上），所以这里不用自己猜名字、也不用手动设 savePath ——
 * **不设 savePath 时 Electron 才会弹对话框**，设了就直接静默写盘了。
 */
ipcMain.handle('app:download', (event, url: unknown) => {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return false
  try {
    event.sender.downloadURL(url)
    return true
  } catch {
    return false
  }
})

// ─────────────────────────────────────────────────────────────
// 「以后都自动以管理员启动」—— 靠一个计划任务
//
// 每次启动都弹 UAC 太烦。而 Windows 允许**中等权限的进程触发一个
// 已注册的高权限任务**，任务自己以高权限启动、全程不弹 UAC。
// 代价只是"建任务"这一次要授权。
// ─────────────────────────────────────────────────────────────

/** 计划任务的名字。注册/查询/触发都用它，别改 */
const ELEVATE_TASK = 'Voice-Elevated'

/** 从计划任务里启动时带上的标记 —— 用来**防止无限重启** */
const FROM_TASK_FLAG = '--from-task'

/** 这个计划任务注册过没有 */
function elevateTaskExists(): boolean {
  if (process.platform !== 'win32') return false
  try {
    execFileSync('schtasks', ['/Query', '/TN', ELEVATE_TASK], { stdio: 'ignore', timeout: 6000 })
    return true
  } catch {
    return false
  }
}

/**
 * 注册那个计划任务（会弹**唯一**一次 UAC）。
 *
 * ⚠️ 命令写进一个临时 .cmd 再提权执行，而不是拼 PowerShell 命令行 ——
 *    exe 路径可能有空格、还要嵌引号，穿过 PowerShell 再到 cmd 两层转义
 *    极容易错。写文件是"所见即所得"的。
 */
function registerElevateTask(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const exe = app.getPath('exe')
    const cmdPath = join(app.getPath('temp'), 'voice-register-elevate.cmd')

    // schtasks 的 /TR 里嵌引号写成 `\"...\"`，cmd 和 schtasks 都认这个形式。
    // /SD 01/01/2000 = 一个早就过去的日期 —— 任务**永远不会自己触发**，
    // 只在我们显式 /Run 时才跑。
    writeFileSync(
      cmdPath,
      [
        '@echo off',
        `schtasks /Create /TN "${ELEVATE_TASK}" /TR "\\"${exe}\\" ${FROM_TASK_FLAG}" ` +
          `/SC ONCE /ST 00:00 /SD 01/01/2000 /RL HIGHEST /F`,
        'exit /b %ERRORLEVEL%',
      ].join('\r\n'),
      'ascii'
    )

    spawn(
      'powershell',
      ['-NoProfile', '-Command', `Start-Process -FilePath '${cmdPath}' -Verb RunAs -Wait`],
      { detached: true, stdio: 'ignore' }
    ).unref()
    return true
  } catch {
    return false
  }
}

/** 删掉那个计划任务（用户反悔时用） */function unregisterElevateTask(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const cmdPath = join(app.getPath('temp'), 'voice-unregister-elevate.cmd')
    writeFileSync(
      cmdPath,
      ['@echo off', `schtasks /Delete /TN "${ELEVATE_TASK}" /F`, 'exit /b %ERRORLEVEL%'].join('\r\n'),
      'ascii'
    )
    spawn(
      'powershell',
      ['-NoProfile', '-Command', `Start-Process -FilePath '${cmdPath}' -Verb RunAs -Wait`],
      { detached: true, stdio: 'ignore' }
    ).unref()
    return true
  } catch {
    return false
  }
}

/**
 * 靠计划任务**静默**重启自己（不弹 UAC）。
 *
 * ⚠️ 顺序和 relaunchElevated 一样：**先退自己再触发任务**。
 *    单实例锁按会话共享、不区分权限级别 —— 先起新实例会被它自己挡掉，
 *    然后我们再一退，两个就都没了。
 */
function relaunchViaTask(): boolean {
  if (process.platform !== 'win32') return false
  if (!elevateTaskExists()) return false

  app.once('will-quit', () => {
    spawn(
      'powershell',
      ['-NoProfile', '-Command', `Start-Sleep -Milliseconds 700; schtasks /Run /TN "${ELEVATE_TASK}"`],
      { detached: true, stdio: 'ignore' }
    ).unref()
  })

  setTimeout(() => app.quit(), 50)
  return true
}

ipcMain.handle('app:version', () => app.getVersion())

/** 设置页要显示"当前是不是管理员" —— 决定了游戏里快捷键灵不灵 */
ipcMain.handle('app:isElevated', () => isElevated())

/** 以管理员身份重启（会弹 UAC）。返回 false = 没起来（用户点了"否"或非 Windows） */
ipcMain.handle('app:relaunchElevated', () => relaunchElevated())

/** 「以后都自动以管理员启动」这个计划任务注册过没有 */
ipcMain.handle('app:elevateTaskExists', () => elevateTaskExists())

/** 注册那个计划任务（弹一次 UAC，之后静默提权） */
ipcMain.handle('app:registerElevateTask', () => registerElevateTask())

/** 删掉那个计划任务 */
ipcMain.handle('app:unregisterElevateTask', () => unregisterElevateTask())

/**
 * 把主进程 PID 给渲染进程。
 *
 * 屏幕共享要排除「我们自己这棵进程树」，好让投屏里不含通话声。
 * 树的根是**主进程** —— Chromium 的音频是独立 AudioService 子进程播的，
 * 而它是主进程的直接子进程，排除主进程才能把它一起排掉。
 * 渲染进程自己的 pid 不行：它和 AudioService 是兄弟。
 *
 * 用 sendSync：只在 preload 加载时调一次，开销可以忽略，
 * 但换来了"渲染进程随时都能同步拿到它"。
 */
ipcMain.on('app:mainPid', (event) => {
  event.returnValue = process.pid
})

ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) return { ok: false, reason: '开发模式下不检查更新' }
  try {
    await autoUpdater.checkForUpdates()
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: String((err as Error)?.message ?? err) }
  }
})

ipcMain.handle('update:download', async () => {
  if (!app.isPackaged) return false
  try {
    await autoUpdater.downloadUpdate()
    return true
  } catch {
    return false
  }
})

ipcMain.handle('update:install', () => {
  if (!app.isPackaged) return false
  autoUpdater.quitAndInstall()
  return true
})

ipcMain.handle('app:getPrefs', () => ({
  closeAction: mainSettings.closeAction,
  openAtLogin: getOpenAtLogin(),
  shortcuts: mainSettings.shortcuts,
  mediaDetect: mainSettings.mediaDetect,
  gameDetect: mainSettings.gameDetect,
  customGames: mainSettings.customGames,
}))

/**
 * 开/关「正在听歌」检测。
 *
 * ⚠️ 关掉时是**真的停掉检测子进程**，不是"继续读但不发"。
 *    "读了不发"那种实现，隐私是假的 —— 进程还在跑、数据还在拿。
 */
ipcMain.handle('app:setMediaDetect', (_event, enabled: boolean) => {
  const on = enabled === true
  mainSettings = { ...mainSettings, mediaDetect: on }
  saveMainSettings(mainSettings)

  if (on) startMediaWatch()
  else stopMediaWatch()

  return on
})

/** 渲染进程挂载后先问一次当前状态（免得等下一次变化才显示） */
ipcMain.handle('app:getNowPlaying', () => getNowPlaying())

/**
 * 开/关「正在玩游戏」检测。
 *
 * 和音乐那个**完全独立** —— 关掉音乐不该把游戏也关了。
 * 同样地，关掉时是**真的停掉子进程**。
 */
ipcMain.handle('app:setGameDetect', (_event, enabled: boolean) => {
  const on = enabled === true
  mainSettings = { ...mainSettings, gameDetect: on }
  saveMainSettings(mainSettings)

  if (on) startGameWatch()
  else stopGameWatch()

  return on
})

ipcMain.handle('app:getNowPlayingGame', () => getNowPlayingGame())

/**
 * 列出**当前有可见窗口**的进程，给"上报游戏"的对话框用。
 *
 * 用 PowerShell 现查，不缓存 —— 这个操作很偶尔（用户手动点开对话框），
 * 而且"窗口列表"过期了就没意义。
 *
 * 只要进程名和窗口标题。窗口标题对用户来说最好认
 * （「英雄联盟 (32位)」比 `League of Legends` 直观）。
 */
ipcMain.handle('app:listWindows', async () => {
  // ⚠️ 拼接必须用**换行**，空格和分号都不行：
  //    · 用空格 → 「设置编码」和「Get-Process」粘成一条语句，直接语法报错；
  //    · 用分号 → 变成 `... SilentlyContinue |; Where-Object ...`，
  //      管道后面跟分号 = 「空管道元素」，又是语法错误。
  //    这两种写法我都试过，界面上都表现为"一个窗口都没有"，
  //    完全看不出是脚本拼错了。（真想骂自己两句。）
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Get-Process -ErrorAction SilentlyContinue |',
    '  Where-Object { $_.MainWindowTitle } |',
    '  Select-Object ProcessName, MainWindowTitle |',
    '  ConvertTo-Json -Compress',
  ].join('\n')

  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          // 别静默失败 —— 这条命令出错的原因（编码、PowerShell 版本）
          // 从界面上完全看不出来，日志里留一句能省很多时间
          console.error('[listWindows] PowerShell 出错：', err.message)
          return resolve([])
        }
        try {
          const parsed = JSON.parse(String(stdout).trim() || '[]')
          // ConvertTo-Json 只有一个元素时返回对象而不是数组 —— 统一成数组
          const list = Array.isArray(parsed) ? parsed : [parsed]
          resolve(
            list
              .map((p: { ProcessName?: unknown; MainWindowTitle?: unknown }) => ({
                exe: typeof p.ProcessName === 'string' ? p.ProcessName : '',
                title: typeof p.MainWindowTitle === 'string' ? p.MainWindowTitle : '',
              }))
              .filter((p: { exe: string }) => p.exe)
          )
        } catch (parseErr) {
          console.error('[listWindows] 解析失败：', String(parseErr))
          resolve([])
        }
      }
    )
  })
})

/**
 * 上报一个内置表里没有的游戏。
 *
 * 存本地就够了 —— 别人看到的是解析后的**显示名**（客户端上报的是名字，
 * 不是进程名），所以你加一条，朋友那边照样显示得对。
 */
ipcMain.handle('app:addCustomGame', (_event, exe: string, name: string) => {
  const key = String(exe ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, '')
  const display = String(name ?? '').trim().slice(0, 40)
  if (!key || !display) return { ok: false, reason: 'empty' }

  mainSettings = {
    ...mainSettings,
    customGames: { ...mainSettings.customGames, [key]: display },
  }
  saveMainSettings(mainSettings)
  setCustomGames(mainSettings.customGames)

  // 白名单变了要重启探测器 —— 脚本的白名单是启动时通过命令行传进去的，
  // 不重启的话新加的游戏不会被盯上。
  if (mainSettings.gameDetect) {
    stopGameWatch()
    startGameWatch()
  }

  return { ok: true, customGames: mainSettings.customGames }
})

/**
 * **全服共享**的游戏表更新了（服务端下发的）。
 *
 * 优先级：内置 < 共享 < 本地自己报的。收到就重启探测器 ——
 * 白名单是启动时通过命令行传进脚本的，不重启新游戏不会被盯上。
 */
ipcMain.handle('app:setSharedGames', (_event, games: Record<string, string>) => {
  setSharedGames(games ?? {})

  if (mainSettings.gameDetect) {
    stopGameWatch()
    startGameWatch()
  }
  return true
})

/** 删掉一条自己上报的 */ipcMain.handle('app:removeCustomGame', (_event, exe: string) => {
  const key = String(exe ?? '').trim().toLowerCase()
  const next = { ...mainSettings.customGames }
  delete next[key]

  mainSettings = { ...mainSettings, customGames: next }
  saveMainSettings(mainSettings)
  setCustomGames(next)

  if (mainSettings.gameDetect) {
    stopGameWatch()
    startGameWatch()
  }

  return { ok: true, customGames: next }
})

/**
 * 设置一个全局快捷键。accelerator 传空字符串表示解绑。
 *
 * 返回 { ok, reason }：
 *   taken     —— 注册失败，多半被别的程序占了
 *   duplicate —— 和另一个动作绑了同一个键
 *   invalid   —— 格式不认识
 */
ipcMain.handle('shortcut:set', (_event, action: string, accelerator: unknown) => {
  if (action !== 'mute' && action !== 'deafen') {
    return { ok: false, reason: 'invalid' }
  }

  const accel = typeof accelerator === 'string' ? accelerator.trim() : ''

  // 两个动作不能绑同一个键 —— 否则第二个会静默地注册失败
  const duplicate = Object.entries(mainSettings.shortcuts).some(
    ([key, value]) => key !== action && value && value === accel
  )
  if (accel && duplicate) return { ok: false, reason: 'duplicate' }

  mainSettings = {
    ...mainSettings,
    shortcuts: { ...mainSettings.shortcuts, [action]: accel },
  }
  saveMainSettings(mainSettings)
  registerShortcuts()

  // 注册完再问一次系统：isRegistered 能看出到底成没成
  const registered = accel === '' || globalShortcut.isRegistered(accel)
  return { ok: registered, reason: registered ? '' : 'taken' }
})

ipcMain.handle('app:setCloseAction', (_event, action: string) => {
  mainSettings = {
    ...mainSettings,
    closeAction: action === 'tray' || action === 'quit' ? action : 'ask',
  }
  saveMainSettings(mainSettings)
  return mainSettings.closeAction
})

ipcMain.handle('app:setOpenAtLogin', (_event, enabled: boolean) => {
  // Windows 上会往注册表的 Run 项写一条；NSIS 安装版指向 Voice.exe。
  // 开发模式下指向 electron.exe —— 能生效但没意义，属于正常现象。
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) })
  return getOpenAtLogin()
})

// ─────────────────────────────────────────────────────────────
// 单实例锁
//
// ⚠️ 必须在 app ready **之前**调用。
//
// 不加这个会出大问题 —— 而且是**丢身份**这种最难查的问题：
//   两个进程共用同一个 userData 目录，而 Chromium 的 localStorage
//   底层是 LevelDB，**同一时刻只允许一个进程打开**。
//   第二个进程读不到配置 → loadConfig() 拿到空值 → ensureIdentity()
//   生成一个全新的 userId → 服务端就凭空多出一个"新用户"。
//   更糟的是 OWNER_NAME 是按**昵称**认人的，于是它还顺手把频道主抢了过去。
//
// 现在第二个实例会直接退出，并把已有窗口唤到前面。
// ─────────────────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  // 已经有实例在跑 —— 本进程立刻退出。
  // 该做的事（把窗口显示出来）由**已在运行的那个实例**负责，见下面的 second-instance
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (!win || win.isDestroyed()) return

    // 从托盘里被藏起来的话，这一步会把它重新显示出来
    showWindow(win)

    // 告诉界面"已经在运行了" —— 否则用户双击图标后什么都没发生，
    // 只会以为程序没启动，接着再点几次
    win.webContents.send('app:alreadyRunning')
  })
}

// ─────────────────────────────────────────────────────────────
// 生命周期
// ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // 拿不到锁说明已经有实例在跑了，本进程正在退出 —— 什么都别建，
  // 否则会闪出一个窗口再消失，更难理解
  if (!gotTheLock) return

  // ── 「以后都自动以管理员启动」────────────────────────────
  //
  // 开机自启拉起来的这一份是**普通权限**的，游戏里快捷键就不灵。
  // 如果用户注册过那个计划任务，这里靠它静默重启一份高权限的（不弹 UAC）。
  //
  // ⚠️ 三道保险，缺一不可，否则会**无限重启**：
  //   1. 已经从任务里启动了（带了 --from-task）→ 不再重启
  //   2. 已经在管理员权限下 → 不需要重启
  //   3. 任务压根没注册 → 没什么可触发的
  if (
    process.platform === 'win32' &&
    !process.argv.includes(FROM_TASK_FLAG) &&
    !isElevated() &&
    elevateTaskExists()
  ) {
    console.log('[info] 检测到计划任务，正在静默提权重启…')
    relaunchViaTask()
    return
  }

  // 关闭行为必须在建窗口**之前**读出来 —— close 事件里要用
  mainSettings = loadMainSettings()

  installDisplayMediaHandler()
  createWindow()

  const [win] = BrowserWindow.getAllWindows()
  if (win) {
    createTray(win)
    setupAutoUpdate(win)
  }

  // 全局快捷键要在窗口建好之后注册 —— 触发时得有个 webContents 可以发消息过去
  registerShortcuts()

  // ── 「正在听歌」────────────────────────────────────────────
  //
  // 用户开着这个功能才启动检测子进程。状态一变就推给渲染进程，
  // 由它通过 WS 上报给服务端（主进程不碰那条连接）。
  if (mainSettings.mediaDetect) {
    onNowPlaying((np) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('app:nowPlaying', np)
      }
    })
    startMediaWatch()
  }

  // 游戏检测是**另一个独立开关**，各管各的子进程
  if (mainSettings.gameDetect) {
    // ⚠️ 必须在 startGameWatch 之前灌进去 —— 白名单是启动时通过命令行
    //    传给脚本的，晚一步这次启动就漏掉了用户上报的游戏。
    setCustomGames(mainSettings.customGames)

    onNowPlayingGame((g) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('app:nowPlayingGame', g)
      }
    })
    startGameWatch()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 退出时一定要注销全局快捷键，否则系统里会留下幽灵绑定，
// 直到下次重启才能清掉（别的程序也用不了那几个键）
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  // 常驻的 PowerShell 子进程必须显式收掉 —— 不然它会一直挂在那儿
  // （虽然父进程退出后大多会跟着走，但别赌）
  stopMediaWatch()
  stopGameWatch()
})

// 走正常退出流程时（托盘菜单的「退出」、系统关机、macOS 的 Cmd+Q）
// 不再拦截 close —— 否则窗口会被"隐藏"而不是真正关掉，进程退不出去。
app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
