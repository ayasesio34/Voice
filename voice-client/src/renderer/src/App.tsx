import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { Track, type Participant, type RemoteAudioTrack } from 'livekit-client'

import { ChannelList, type Channel } from './components/ChannelList'
import { ChannelCreateDialog } from './components/ChannelCreateDialog'
import { ChatPanel } from './components/ChatPanel'
import { CloudFilesDialog } from './components/CloudFilesDialog'
import { SettingsDialog, type ShareSettings } from './components/SettingsDialog'
import { ServerSettingsDialog } from './components/ServerSettingsDialog'
import { SourcePicker } from './components/SourcePicker'
import { UpdateBanner, type UpdateStatus } from './components/UpdateBanner'
import { VideoTile } from './components/VideoTile'
import {
  DEFAULT_MIC_OPTIONS,
  useVoiceRoom,
  type MicOptions,
} from './hooks/useVoiceRoom'
import {
  deleteFile as apiDeleteFile,
  fetchMessages,
  searchMessages,
  fileUrl,
  openChat,
  uploadFile,
  type ChatConnection,
  type ChatMessage,
  type CloudFile,
  type DmInfo,
  type FileRef,
  type FilesStats,
  type ServerInfo,
} from './lib/api'
import { serializeAvatar } from './lib/avatar'
import {
  playDeafenSound,
  playJoinSound,
  playLeaveSound,
  playMuteSound,
  playUndeafenSound,
  playUnmuteSound,
} from './lib/sounds'
import {
  defaultNickname,
  ensureIdentity,
  loadConfig,
  saveConfig,
  type AppConfig,
} from './lib/config'
import { presetByKey } from './lib/livekit'
import { MIC_AUDIO_PRESET } from './lib/livekit'
import {
  byJoinOrder,
  canManage,
  ROLE_LABEL,
  voiceKey,
  voiceNameSet,
  withSuffixes,
  type MemberInfo,
  type MemberRef,
  type Role,
  type VoiceRooms,
} from './lib/names'
import { pickViewers } from './lib/viewers'
import { inCornerZone, inTopZone } from './lib/stageHover'
import { Avatar } from './components/Avatar'
import { GearIcon, MicIcon, PhoneOffIcon, ScreenIcon, SpeakerIcon } from './components/icons'
import { applyTheme, loadTheme, type Theme } from './lib/theme'

// ── 左右两栏的宽度 ───────────────────────────────────────
// 名字长了侧栏就不够用（成员列表里全是省略号），所以两边都能拖。
const LEFT_MIN = 180
const LEFT_MAX = 460
const RIGHT_MIN = 180
const RIGHT_MAX = 460
/** 中间区域至少留这么宽 —— 别把聊天挤没了 */
const MAIN_MIN = 420

/** 音量上限。1 = 原始音量，2 = 200% 增益（给麦克风特别小的人用） */
const MAX_VOLUME = 2

// ── 全屏时控制条的唤醒区域 ────────────────────────────────
//
// 鼠标移到屏幕**顶部**、或者划到**左下角**，控制条和那叠观看者头像一起出来。
//
// ⚠️ 阈值和坐标算术都在 `lib/stageHover.ts` 里（纯函数，有单测）——
//    那段只有真的开投屏、进全屏、把鼠标划过去才看得到效果，
//    截图验证不了，所以必须能单测。常量也放那边，免得两处各写一份。

/** 鼠标多久不动就把光标藏起来 */
const POINTER_IDLE_MS = 2500

/**
 * 左下角面板里显示的**音质规格**。
 *
 * 从实际用的编码预设算出来，不写死 —— 以后调了 `MIC_AUDIO_PRESET`，
 * 界面上显示的数字会自己跟着变，不会出现"界面说 48、实际是别的"。
 */
const AUDIO_SPEC = `${Math.round(MIC_AUDIO_PRESET.maxBitrate / 1000)} kbps`

/**
 * 共享的 AudioContext。
 *
 * ⚠️ 必须**共用一个** —— Chromium 对每个页面能创建的 AudioContext 数量有硬限制
 *    （大约 6 个）。每人一个的话，人一多后面的就创建失败，**直接没声音**。
 */
let sharedAudioCtx: AudioContext | null = null

/** 真正接上 Web Audio 的轨道。重复接会重建音频图，滑块一拖就爆音 */
const webAudioLive = new WeakSet<object>()

/**
 * 设置远端音频音量，**支持超过 100% 的增益**。
 *
 * LiveKit 的 setVolume 内部有两条路：
 *   · 设过 AudioContext → source → GainNode → destination，增益能超过 1
 *   · 没设             → 直接写 el.volume，而 HTMLMediaElement.volume 封顶 1
 *
 * ⚠️⚠️ 这里有个 SDK 的坑，踩过一次，现象是"所有人都像在浴室里说话"：
 *
 *   attach() 在接 Web Audio 时**会**把 <audio> 元素静音：
 *       element.volume = 0; element.muted = true;
 *   但 setAudioContext() **不会** —— 它只连音频图，元素照常在响。
 *
 *   而我们的顺序恰恰是「UI 先 attach 元素 → 再 setAudioContext」，
 *   于是同一条音轨被播了两遍：元素一次、Web Audio 一次。
 *   两条路径的缓冲延迟不同 → **梳状滤波** → 听上去就是在浴室里说话。
 *
 *   而且 setVolume() 在 Web Audio 模式下只动 gainNode（见 SDK），
 *   根本不会纠正元素音量，所以这个重音会一直存在。
 *
 *   修法：设完 AudioContext 后**自己把已挂上的元素静音**。
 *
 * 另一个决定：**只在需要超过 100% 时才走 Web Audio**。
 * 默认音量下用元素直接播放 —— 延迟最低，也没有 AudioContext 被自动播放策略
 * 挂起的风险（那个会直接导致没声音）。接过之后就不再拆，因为反复重建音频图
 * 会在拖动滑块时爆音。
 */
function applyTrackVolume(track: RemoteAudioTrack, volume: number): void {
  const v = Math.max(0, Math.min(MAX_VOLUME, volume))

  if (v > 1 && !webAudioLive.has(track)) {
    try {
      const t = track as unknown as { setAudioContext?: (ctx: AudioContext) => void }
      if (typeof t.setAudioContext === 'function') {
        if (!sharedAudioCtx) sharedAudioCtx = new AudioContext()
        t.setAudioContext(sharedAudioCtx)
        webAudioLive.add(track)
      }
    } catch {
      /* AudioContext 建不起来 —— 下面会退回元素音量，只是增益不到 100% 以上 */
    }
  }

  // ★ 补上 SDK 漏掉的那次静音。
  //   setVolume() 在 Web Audio 模式下不碰元素，所以静音一次就稳定了。
  //   新挂上的元素由 attach() 自己处理（那时 audioContext 已经有了）。
  if (webAudioLive.has(track)) {
    for (const el of track.attachedElements ?? []) {
      el.volume = 0
      el.muted = true
    }
  }

  try {
    track.setVolume(v)
  } catch {
    try {
      track.setVolume(Math.min(1, v))
    } catch {
      /* ignore */
    }
  }
}

function readWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
  } catch {
    return fallback
  }
}

const SHARE_KEY = 'voice.share.v1'
const DEFAULT_SHARE: ShareSettings = {
  presetKey: '1080p60',
  codec: 'h264',
  contentHint: 'text',
}

function loadShare(): ShareSettings {
  try {
    const raw = localStorage.getItem(SHARE_KEY)
    return raw ? { ...DEFAULT_SHARE, ...(JSON.parse(raw) as Partial<ShareSettings>) } : DEFAULT_SHARE
  } catch {
    return DEFAULT_SHARE
  }
}

export default function App() {
  // ── 配置 ────────────────────────────────────────────────
  const [cfg, setCfg] = useState<AppConfig>(loadConfig)
  const [share, setShare] = useState<ShareSettings>(loadShare)
  const [settingsOpen, setSettingsOpen] = useState(false)

  /**
   * 麦克风处理开关（降噪 / 回声消除 / 自动增益），三个都默认开着。
   *
   * 声明在这么靠前的位置是因为「加入语音」的回调要用它。
   * 改的时候如果正在开麦，applyMicOptions 会重新采集一次才生效
   * （浏览器只在 getUserMedia 那一刻读这些约束）。
   */
  const [micOptions, setMicOptions] = useState<MicOptions>(() => {
    try {
      const raw = localStorage.getItem('voice.micOptions')
      if (raw) {
        return { ...DEFAULT_MIC_OPTIONS, ...(JSON.parse(raw) as Partial<MicOptions>) }
      }

      // 0.13 / 0.14 只存了降噪一项（voice.noiseSuppression），带过来别丢
      const legacy = localStorage.getItem('voice.noiseSuppression')
      return legacy === null
        ? { ...DEFAULT_MIC_OPTIONS }
        : { ...DEFAULT_MIC_OPTIONS, noiseSuppression: legacy !== '0' }
    } catch {
      return { ...DEFAULT_MIC_OPTIONS }
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('voice.micOptions', JSON.stringify(micOptions))
    } catch {
      /* ignore */
    }
  }, [micOptions])
  const [pickerOpen, setPickerOpen] = useState(false)

  // ── 界面主题 ─────────────────────────────────────────────
  /**
   * 深色 / 浅色。
   *
   * 初始值来自 localStorage，而 index.html 里那段内联脚本**在首屏绘制之前**
   * 已经把 `data-theme` 写好了 —— 所以这里再设一次是一样的值，
   * 不会出现"先深后浅"闪一下。
   */
  const [theme, setTheme] = useState<Theme>(loadTheme)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // ── 自动更新事件 ─────────────────────────────────────────
  // 主进程把几个 channel 合并成一条事件流（见 preload 的 onUpdate）。
  // 开发模式下主进程根本不发事件，所以这里什么都不用特判。
  useEffect(() => {
    if (!window.desktop?.onUpdate) return
    return window.desktop.onUpdate((e) => {
      switch (e.type) {
        case 'available':
          setUpdate({ kind: 'available', version: e.version })
          break
        case 'none':
          setUpdate({ kind: 'idle' })
          break
        case 'progress':
          setUpdate({ kind: 'downloading', percent: e.percent })
          break
        case 'downloaded':
          setUpdate({ kind: 'downloaded', version: e.version })
          break
        case 'error':
          setUpdate({ kind: 'error', message: e.message })
          break
      }
    })
  }, [])

  // ── 投屏区域的大小 ───────────────────────────────────────
  // 投屏区占主区域高度的比例（0~1），由中间的拖拽手柄调整。
  // 关键是投屏和聊天**共存**：投屏占上面一截，聊天永远在下面可见可打字。
  const [stageRatio, setStageRatio] = useState(0.5)
  const [stageCollapsed, setStageCollapsed] = useState(false)
  const mainRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  // ── 全屏看投屏 ───────────────────────────────────────────
  const stageRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  /**
   * 全屏时控制条要不要显示 —— **鼠标移到屏幕上方才出来**。
   *
   * 一开始做的是"鼠标一动就出来"，但那样太吵：全屏看别人操作或者看视频时，
   * 鼠标稍微碰一下，顶上就滑下来一条，很跳。
   * 现在只有**移到顶部**才唤醒 —— 和视频播放器顶部菜单栏一个思路。
   *
   * 光标仍然是"闲置就藏"，但**鼠标一动就回来**：
   * 光标藏起来之后你根本找不到自己在哪，也就谈不上"移到顶部"了。
   * 所以「光标」和「控制条」是**两件独立的事**，判断条件也不同。
   */
  const [nearTop, setNearTop] = useState(false)
  /** 鼠标是不是在**左下角**（那叠观看者头像就在那儿，要和它对应上） */
  const [nearCorner, setNearCorner] = useState(false)
  const [pointerIdle, setPointerIdle] = useState(false)
  /** 刚进全屏时先亮一下，否则用户不知道顶部有这些东西 */
  const [introVisible, setIntroVisible] = useState(false)

  const idleTimerRef = useRef<number | null>(null)

  const onStageMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // 迟滞：已经显示时用宽松的 HIDE_AT，已经隐藏时用严格的 SHOW_AT
    setNearTop((wasNear) => inTopZone(e.clientY, wasNear))

    // 左下角那一块也一样。用**舞台**的矩形来算（头像就贴在它的左下角）。
    const rect = e.currentTarget.getBoundingClientRect()
    setNearCorner((wasNear) => inCornerZone(e.clientX, e.clientY, rect, wasNear))

    // 光标：一动就亮出来，然后重新开始"闲置"计时
    setPointerIdle(false)
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current)
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null
      setPointerIdle(true)
    }, POINTER_IDLE_MS)
  }, [])

  useEffect(() => {
    const clearIdleTimer = () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }
    }

    // 退出全屏 → 全部复位。窗口模式下控制条本来就一直显示，光标也不该藏
    if (!isFullscreen) {
      clearIdleTimer()
      setNearTop(false)
      setNearCorner(false)
      setPointerIdle(false)
      setIntroVisible(false)
      return clearIdleTimer
    }

    setIntroVisible(true)
    const introTimer = window.setTimeout(() => setIntroVisible(false), POINTER_IDLE_MS)

    return () => {
      clearIdleTimer()
      window.clearTimeout(introTimer)
    }
  }, [isFullscreen])

  /**
   * 控制条和那叠观看者头像**共用**这一个信号 —— 它们要同进同出。
   * 鼠标在顶部、或者在左下角，都算"要操作了"。
   */
  const controlsVisible = nearTop || nearCorner || introVisible
  // 光标只在"鼠标闲着"时藏 —— 但如果正停在顶部（要操作控制条），别藏
  const cursorHidden = pointerIdle && !nearTop

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  const toggleFullscreen = useCallback(async () => {
    const el = stageRef.current
    if (!el) return
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await el.requestFullscreen()
    } catch (err) {
      setNotice({ text: `全屏失败：${(err as Error).message}`, kind: 'error' })
    }
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return
      const el = mainRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const ratio = (e.clientY - rect.top) / rect.height
      // 上下都留出余地：太小看不清画面，太大聊天区（标题 + 输入框 ≈ 100px）就没法用了
      setStageRatio(Math.min(0.75, Math.max(0.15, ratio)))
    }
    const onUp = () => {
      draggingRef.current = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // ── 文字频道 ─────────────────────────────────────────────
  const [channels, setChannels] = useState<Channel[]>([])
  const [chatChannel, setChatChannel] = useState<Channel | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  /**
   * 我的私聊会话。服务端只推给我自己 —— 别人看不到我有哪些私聊。
   * 界面上显示的是**对方这个人**，不是会话本身。
   */
  const [dms, setDms] = useState<DmInfo[]>([])
  /** 当前打开的私聊页。非空时它**取代**频道聊天占据主区域 */
  const [activeDm, setActiveDm] = useState<DmInfo | null>(null)
  const [online, setOnline] = useState<MemberRef[]>([])
  /** 每个语音频道里有哪些人。服务端轮询 LiveKit 后推送过来 */
  const [voiceRooms, setVoiceRooms] = useState<VoiceRooms>({})
  /** 全部成员（含离线）和各自的角色 */
  const [members, setMembers] = useState<MemberInfo[]>([])
  /** 我自己的角色。由服务端在 welcome 里下发 */
  const [myRole, setMyRole] = useState<Role>('member')
  const [createChannelOpen, setCreateChannelOpen] = useState(false)
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false)
  /** 服务器名字和头像。全局共享，存在服务端 */
  const [server, setServer] = useState<ServerInfo>({ name: '我的服务器', avatar: '' })

  /**
   * 云端文件。聊天附件和"云端文件"共用同一张表、同一套上传接口 ——
   * 区别只是聊天里的会被消息流冲走，文件柜里的不会。
   */
  const [files, setFiles] = useState<CloudFile[]>([])
  const [fileStats, setFileStats] = useState<FilesStats>({ count: 0, bytes: 0 })
  const [filesOpen, setFilesOpen] = useState(false)
  /** 自动更新状态。主进程会推事件上来 */
  const [update, setUpdate] = useState<UpdateStatus>({ kind: 'idle' })
  /** 应用版本，显示在设置的「关于」里。开发模式下会拿到 package.json 的版本 */
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    const api = window.desktop
    if (!api?.getVersion) return
    api
      .getVersion()
      .then(setAppVersion)
      .catch(() => {})
  }, [])

  // ── 音频设备列表 ─────────────────────────────────────────
  // ⚠️ 设备名（label）只有在**授权麦克风之后**才有值 —— 没授权时
  //    enumerateDevices 返回的 label 全是空字符串。所以打开设置时再刷一次。
  const [devices, setDevices] = useState<{
    inputs: MediaDeviceInfo[]
    outputs: MediaDeviceInfo[]
  }>({ inputs: [], outputs: [] })

  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      setDevices({
        inputs: list.filter((d) => d.kind === 'audioinput'),
        outputs: list.filter((d) => d.kind === 'audiooutput'),
      })
    } catch {
      /* 拿不到就保持空列表，界面里会提示先去语音频道开一次麦 */
    }
  }, [])

  useEffect(() => {
    void refreshDevices()
    const md = navigator.mediaDevices
    md.addEventListener?.('devicechange', refreshDevices)
    return () => md.removeEventListener?.('devicechange', refreshDevices)
  }, [refreshDevices])

  // 插拔耳机、或刚授权完麦克风 —— 打开设置时再刷一次，这样设备名才是有意义的
  useEffect(() => {
    if (settingsOpen) void refreshDevices()
  }, [settingsOpen, refreshDevices])

  // ── 启动与关闭偏好 ───────────────────────────────────────
  // 存在主进程（settings.json）：关闭行为必须在窗口建立前就生效，
  // 开机自启要在 app ready 时注册。
  const [prefs, setPrefs] = useState<{
    closeAction: 'ask' | 'tray' | 'quit'
    openAtLogin: boolean
    shortcuts: { mute: string; deafen: string }
    /** 「正在听歌」检测。默认开。关掉时主进程**连子进程都停掉** */
    mediaDetect: boolean
    /** 「正在玩游戏」检测。默认开，和上面那个互相独立 */
    gameDetect: boolean
    /** 用户自己上报的游戏：进程名（小写不带 .exe）→ 显示名 */
    customGames: Record<string, string>
  }>({
    closeAction: 'ask',
    openAtLogin: false,
    shortcuts: { mute: '', deafen: '' },
    mediaDetect: true,
    gameDetect: true,
    customGames: {},
  })

  const refreshPrefs = useCallback(async () => {
    const api = window.desktop
    if (!api?.getPrefs) return
    try {
      setPrefs(await api.getPrefs())
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void refreshPrefs()
  }, [refreshPrefs])

  useEffect(() => {
    if (settingsOpen) void refreshPrefs()
  }, [settingsOpen, refreshPrefs])

  // 用户在系统弹窗里勾了「记住我的选择」时，主进程会把新值推上来
  useEffect(() => {
    const api = window.desktop
    if (!api?.onCloseActionChanged) return
    return api.onCloseActionChanged((action) => {
      setPrefs((p) => ({ ...p, closeAction: action }))
    })
  }, [])

  const [chatReady, setChatReady] = useState(false)

  // ── 「正在听歌」「正在玩游戏」────────────────────────────
  //
  // 主进程有两个**互相独立**的常驻 PowerShell 探测器：
  //   · detect.ps1      —— 读 Windows 的 SMTC（系统媒体控制）
  //   · detect-game.ps1 —— 比对一张游戏进程白名单（只查进程在不在）
  //
  // ⚠️ 关掉设置里对应的开关时，主进程**把那个子进程停掉** ——
  //    所以这里根本收不到东西，也就不会上报。
  const [nowPlaying, setNowPlaying] = useState<{
    app: string
    title: string
    artist: string
  } | null>(null)
  const [nowGame, setNowGame] = useState<{ exe: string; name: string } | null>(null)

  useEffect(() => {
    if (!window.desktop?.onNowPlaying) return
    return window.desktop.onNowPlaying(setNowPlaying)
  }, [])

  useEffect(() => {
    if (!window.desktop?.onNowPlayingGame) return
    return window.desktop.onNowPlayingGame(setNowGame)
  }, [])

  /**
   * 把当前状态报给服务端。
   *
   * ⚠️ **游戏优先于音乐**：开着游戏听歌时显示"正在玩"。
   *    不然列表里会是"正在听：某个 BGM"，而实际上你在打排位 ——
   *    对朋友来说哪个信息更有用很明显。
   */
  useEffect(() => {
    if (!chatReady) return
    chatRef.current?.setActivity(
      nowGame
        ? { kind: 'game' as const, title: nowGame.name, artist: '' }
        : nowPlaying
          ? { kind: 'music' as const, title: nowPlaying.title, artist: nowPlaying.artist }
          : null
    )
  }, [nowGame, nowPlaying, chatReady])

  // 刚连上时补报一次当前状态。
  // 不补的话：如果开机时歌已经在放、而且一直不换歌，
  // 主进程那条"变化才推送"就永远不会触发 —— 别人一直看不到。
  useEffect(() => {
    if (!chatReady) return
    void window.desktop?.getNowPlaying?.().then((np) => np && setNowPlaying(np))
    void window.desktop?.getNowPlayingGame?.().then((g) => g && setNowGame(g))
  }, [chatReady])

  /**
   * 提示条。
   *
   * 分两种：error 是红的，info 是蓝的。
   * 之前只有一种红色 —— 于是"已上传 xxx"也显示成红色，看着像出错了。
   */
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'info' } | null>(null)

  const notify = useCallback(
    (text: string, kind: 'error' | 'info' = 'error') => setNotice({ text, kind }),
    []
  )

  // info 提示自动消失；error 留着，让用户有机会看清（点一下才关）
  useEffect(() => {
    if (notice?.kind !== 'info') return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  /**
   * 全局快捷键的处理函数。
   *
   * 用 ref 转一手是必须的：`voice` 每次渲染都是新对象，
   * 直接把它放进下面的订阅 effect 依赖里，会导致监听每渲染一次就重挂一次。
   */
  const shortcutHandlerRef = useRef<(action: 'mute' | 'deafen') => void>(() => {})

  /**
   * 用户又双击了一次应用图标。
   *
   * 主进程用单实例锁把那个新进程挡掉了，并已把本窗口唤到前面 ——
   * 这里补一句提示，免得用户以为双击没反应。
   */
  useEffect(() => {
    const api = window.desktop
    if (!api?.onAlreadyRunning) return
    return api.onAlreadyRunning(() => {
      setNotice({ text: 'Voice 已经在运行了，已经帮你切回这个窗口', kind: 'info' })
    })
  }, [])

  const chatRef = useRef<ChatConnection | null>(null)
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null)

  const voice = useVoiceRoom()

  /** 头像序列化后既发给聊天服务端（presence），也写进 LiveKit attributes */
  const avatarRaw = useMemo(() => serializeAvatar(cfg.avatar), [cfg.avatar])

  // 第一次启动：补上默认昵称，并把本地生成的身份标识**落盘**。
  // loadConfig 已经在内存里保证了 userId/userKey 存在，这里负责持久化 ——
  // 必须赶在第一次连接之前完成，否则 StrictMode 的双次 effect 会造出两个身份。
  useEffect(() => {
    const withId = ensureIdentity(cfg)
    const next = { ...withId }
    let changed = false

    if (!next.nickname) {
      next.nickname = defaultNickname()
      changed = true
    }
    if (next.userId !== cfg.userId || next.userKey !== cfg.userKey) changed = true

    if (changed) {
      setCfg(next)
      saveConfig(next)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 连上后端文字频道 ─────────────────────────────────────
  //
  // ⚠️ 依赖里**故意不放** cfg.userId / cfg.userKey：服务端首次连接会下发这两个值、
  //    我们在 onWelcome 里写回配置，如果它们是依赖就会触发重连 → 再下发 → 死循环。
  /**
   * 我**现在**在哪个语音房间。
   *
   * 必须用 ref：下面的 WS 回调只在连接建立时创建一次，
   * 直接闭包捕获 voiceJoinedRoomId 会永远拿到连接那一刻的值（null）。
   */
  const voiceRoomNowRef = useRef<string | null>(null)

  useEffect(() => {
    if (!cfg.nickname) return

    const conn = openChat(
      cfg,
      {
        name: cfg.nickname,
        avatar: avatarRaw,
        userId: cfg.userId,
        userKey: cfg.userKey,
      },
      {
        onOpen: () => setNotice(null),
        onWelcome: (info) => {
          const list = info.channels as Channel[]
          setChannels(list)
          setOnline(info.online)
          setMembers(info.members ?? [])
          setMyRole(info.role ?? 'member')
          if (info.server) setServer(info.server)
          setVoiceRooms(info.voice ?? {})
          if (info.files) setFiles(info.files)
          if (info.fileStats) setFileStats(info.fileStats)
          if (info.dms) setDms(info.dms)
          // 全服共享的游戏表 —— 交给主进程更新检测白名单
          if (info.games) void window.desktop?.setSharedGames?.(info.games)
          setChatReady(true)
          setChatChannel((cur) => cur ?? list.find((c) => c.kind === 'text') ?? null)

          // 服务端下发的 userId 必须存下来 —— 角色（频道主/管理员）就记在它上面。
          // 只在服务端给了新东西时才写，避免每次都触发一次 state 更新。
          if (info.userId && (info.userId !== cfg.userId || info.userKey)) {
            const next: AppConfig = {
              ...cfg,
              userId: info.userId,
              userKey: info.userKey ?? cfg.userKey,
            }
            setCfg(next)
            saveConfig(next)
          }
        },
        onMessage: (m) =>
          setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m])),
        /**
         * 有人删了消息 —— 从列表里摘掉。
         *
         * 服务端是**广播**给所有人的（私聊只给会话里的两个人），
         * 所以自己删和看别人删走的是同一条路，不用在本地另外做一遍。
         * 顺便把搜索结果里的同一条也摘掉，否则搜着搜着它还挂在那儿。
         */
        onMessageDeleted: (id) => {
          setMessages((prev) => prev.filter((x) => x.id !== id))
          setSearchResults((prev) => (prev ? prev.filter((x) => x.id !== id) : prev))
        },
        onPresence: setOnline,
        onVoice: setVoiceRooms,
        onChannels: setChannels,
        onMembers: setMembers,
        onServer: setServer,
        onFiles: (next, stats) => {
          setFiles(next)
          setFileStats(stats)
        },
        onDms: setDms,
        // 服务端确认私聊已建立（可能是新建的）—— 直接把页面打开
        onDmOpen: (dm) => {
          setActiveDm(dm)
          setDms((prev) => (prev.some((d) => d.id === dm.id) ? prev : [dm, ...prev]))
        },
        // 有人进出语音频道。
        //
        // ⚠️ 服务端是**广播给所有人**的 —— 它靠 3 秒一轮的轮询才知道谁在哪个房间，
        //    让它精准投递的话提示音最多会慢 3 秒。而"叮"一声要的就是即时。
        //    所以**过滤放在这里**：「我在不在这个频道」本来就只有客户端知道。
        //
        //    不认识的房间一律不放 —— 不然人在大厅坐着，别的频道进进出出全在响。
        onChime: (kind, _name, room) => {
          if (room !== voiceRoomNowRef.current) return
          if (kind === 'join') playJoinSound()
          else playLeaveSound()
        },
        onError: (text) => setNotice({ text, kind: 'error' }),
        onClose: () => setChatReady(false),
        // 被频道主移出服务器。这里没有自动重连，所以断开后不会自己回来 ——
        // 但用户重启应用还是会以新身份进来（身份被删了，服务端当新用户处理）。
        onRemoved: () =>
          setNotice({ text: '你已被移出这个服务器', kind: 'error' }),
        // 别人上报了新游戏 —— 立刻让主进程用上新白名单
        onGames: (games) => {
          void window.desktop?.setSharedGames?.(games)
        },
      }
    )

    chatRef.current = conn
    return () => {
      conn.close()
      chatRef.current = null
    }
  }, [cfg.nickname, cfg.apiUrl, avatarRaw])

  // ── 切换会话时拉历史 ─────────────────────────────────────
  // 频道和私聊走同一个接口 —— 服务端把私聊也存成"频道"了。
  // 私聊带身份头是必须的：服务端要靠它判断你是不是会话里的人。
  useEffect(() => {
    const id = activeDm ? activeDm.id : chatChannel?.kind === 'text' ? chatChannel.id : null
    if (!id) return
    let alive = true

    fetchMessages(cfg, id)
      .then((history) => {
        if (!alive || history.length === 0) return
        setMessages((prev) => {
          const byId = new Map(prev.map((m) => [m.id, m]))
          for (const m of history) byId.set(m.id, m)
          return [...byId.values()].sort((a, b) => a.id - b.id)
        })
      })
      .catch(() => {
        /* 历史拉不到不影响实时聊天 */
      })

    return () => {
      alive = false
    }
    // 刻意只依赖"会话 id"和身份，不依赖整个 cfg ——
    // cfg 每次改名/换头像都是新对象，那样会白白重拉一遍历史
  }, [activeDm?.id, chatChannel?.id, cfg.apiUrl, cfg.inviteCode, cfg.userId, cfg.userKey])

  // ── 频道选择 ─────────────────────────────────────────────
  const selectChannel = useCallback(
    async (c: Channel) => {
      setActiveChannelId(c.id)
      // 点频道就退出私聊页 —— 否则私聊会一直盖着频道聊天
      setActiveDm(null)
      if (c.kind === 'text') {
        setChatChannel(c)
        return
      }
      // 语音频道：用频道 id 当房间名，直接进
      await voice.connect(cfg, c.id, {
        preset: presetByKey(share.presetKey),
        codec: share.codec,
        avatar: avatarRaw,
        mic: micOptions,
      })
    },
    [cfg, share.presetKey, share.codec, voice, avatarRaw, micOptions]
  )

  /**
   * 打开和某人的私聊。
   *
   * 已经有会话的话本地直接打开，不用等服务端往返；
   * 没有的话让服务端建一个，它会推一条 `dm` 回来（见 onDmOpen）。
   */
  const openDmWith = useCallback(
    (userId: string, name: string) => {
      const existing = dms.find((d) => d.peerId === userId)
      if (existing) {
        setActiveDm(existing)
        return
      }
      if (!chatRef.current?.openDm(userId)) {
        notify(`还没连上服务端，暂时不能私聊 ${name}`)
      }
    },
    [dms, notify]
  )

  // ── 成员列表的右键菜单 ───────────────────────────────────
  const [memberMenu, setMemberMenu] = useState<{
    x: number
    y: number
    userId: string
    name: string
    isMe: boolean
    /** 目标当前的角色。升管/撤管的菜单项靠它决定显示哪个 */
    role: Role
  } | null>(null)

  useEffect(() => {
    if (!memberMenu) return
    const close = () => setMemberMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMemberMenu(null)
    }
    // 和频道那个菜单同样的讲究：冒泡阶段 + 菜单自己 stopPropagation，
    // 否则点菜单项的瞬间就被关掉了
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
      window.removeEventListener('wheel', close)
    }
  }, [memberMenu])

  const openMemberMenu = (e: React.MouseEvent, m: { userId: string; name: string; role: Role }) => {
    e.preventDefault()
    e.stopPropagation()
    setMemberMenu({
      x: Math.max(4, Math.min(e.clientX, window.innerWidth - 200 - 8)),
      // 菜单现在最多四项（私聊 / 升管或撤管 / 移除成员），
      // 高度按 4 项 + 标题留足，否则最后一项会被窗口底部裁掉
      y: Math.max(4, Math.min(e.clientY, window.innerHeight - 176 - 8)),
      userId: m.userId,
      name: m.name,
      isMe: m.userId === cfg.userId,
      role: m.role,
    })
  }

  // ── 从 room 里读出参与者与轨道 ───────────────────────────
  // 依赖 voice.tick 强制重算：LiveKit 的轨道状态变化太快，
  // 手工维护镜像 state 极容易不同步。
  const participants = useMemo<Participant[]>(() => {
    if (!voice.room) return []
    return [voice.room.localParticipant, ...voice.room.remoteParticipants.values()]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.room, voice.tick])

  /**
   * 所有正在共享的画面。
   *
   * ⚠️ 之前这里写的是"找到第一个就 return"，而 participants[0] **永远是自己** ——
   *    所以只要自己在共享，就永远看不到别人的画面。现在全部收集起来，让用户切。
   */
  const screenShares = useMemo(() => {
    const out: {
      sid: string
      identity: string
      /** 和 screenAudio 里同一个口径的稳定标识 —— 用来把"画面"和"那一份声音"对上 */
      key: string
      name: string
      isLocal: boolean
      track: Track
    }[] = []

    for (const p of participants) {
      const pub = p.getTrackPublication(Track.Source.ScreenShare)
      if (pub?.track) {
        out.push({
          sid: pub.track.sid ?? p.identity,
          identity: p.identity,
          key: voiceKey(p),
          name: p.name || p.identity,
          isLocal: p.isLocal,
          track: pub.track,
        })
      }
    }
    return out
  }, [participants])

  /** 用户手动选了哪一路。null = 还没选过 */
  const [watchingSid, setWatchingSid] = useState<string | null>(null)

  /**
   * 要不要**真的看**投屏。默认不看。
   *
   * 以前是自动播放的：一有人共享就占掉整个上半屏，而且不管你感不感兴趣，
   * 都会去订阅那一路视频。改成"点一下才看"有两个好处：
   *
   *   · **不打扰** —— 大多数时候大家在聊天，根本没人看画面
   *   · **省流量** —— 不订阅时 LiveKit 的 dynacast 会让分享者**停止发那一路**，
   *     服务器出口直接掉到 0。1080p60 可是 8 Mbps，一个小时 3.6 GB
   *
   * 关掉观看（或离开频道）时组件被卸载、轨道被 detach，订阅自然就停了。
   */
  const [watching, setWatching] = useState(false)

  /** 正在观看的那一路。没在看、或没人在共享时是 null */
  const watchingShare = useMemo(() => {
    if (!watching || screenShares.length === 0) return null

    // ⚠️ 选过就以**选的那一路**为准，它结束了也**不自动切到别人**。
    //    以前这里会"退而求其次"挑一路，结果是：你正看着 A 的投屏，
    //    A 停了、B 恰好也在共享 —— 你没点任何东西，画面就跳到 B 去了。
    if (watchingSid) return screenShares.find((s) => s.sid === watchingSid) ?? null

    // 还没选过（点了「点击观看」但只有一路）才自动挑：
    // 优先看别人的 —— 自己的画面自己心里有数
    return screenShares.find((s) => !s.isLocal) ?? screenShares[0]
  }, [watching, screenShares, watchingSid])

  /** 邀请按钮上显示谁在共享。同样优先别人 */
  const inviteShare = useMemo(
    () => screenShares.find((s) => !s.isLocal) ?? screenShares[0] ?? null,
    [screenShares]
  )

  // 告诉别人"我在看哪一路" —— 别人界面上的"👁 N 人在看"就靠这个
  const { setWatchTarget } = voice
  useEffect(() => {
    setWatchTarget(watchingShare?.sid ?? null)
  }, [watchingShare?.sid, setWatchTarget])

  /**
   * 远端音频分两路：
   *   · 麦克风 —— 跟「关闭喇叭」走，另外**每个人还能单独调**
   *   · 共享的系统声音 —— 一个全局音量
   * 分开是因为它们需求不同：人声要能逐个人调（有人麦克风爆音、有人太小声），
   * 而内容声（游戏/视频）是整体的。
   *
   * key 用"稳定标识"而不是 LiveKit 的 identity —— 后者每次连接都变，
   * 今天调好的音量明天就对不上了。见 lib/names.ts 的 voiceKey。
   */
  const { micAudio, screenAudio } = useMemo(() => {
    // 用 RemoteAudioTrack 而不是 RemoteTrack —— 只有前者有 setVolume /
    // setAudioContext（增益就靠它们）
    type Sink = { track: RemoteAudioTrack; key: string }
    const mic: Sink[] = []
    const screen: Sink[] = []

    for (const p of participants) {
      if (p.isLocal) continue
      // ⚠️ 这里必须和 screenShares 里用的**完全同一个函数** ——
      //    画面和它那份声音要靠这个 key 对上，口径差一点就对不上了
      const key = voiceKey(p)

      for (const pub of p.trackPublications.values()) {
        const t = pub.track
        if (!t || t.kind !== 'audio') continue
        if (pub.source === Track.Source.ScreenShareAudio) {
          screen.push({ track: t as RemoteAudioTrack, key })
        } else {
          mic.push({ track: t as RemoteAudioTrack, key })
        }
      }
    }
    return { micAudio: mic, screenAudio: screen }
  }, [participants])

  /**
   * 每个人的音量，0~1。只影响麦克风，共享声音有自己的全局音量。
   * 100% 是默认值，所以存的时候直接删掉那条记录，localStorage 不会越攒越大。
   */
  const [volumes, setVolumes] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem('voice.volumes')
      const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : null
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('voice.volumes', JSON.stringify(volumes))
    } catch {
      /* ignore */
    }
  }, [volumes])

  const setUserVolume = useCallback((key: string, value: number) => {
    setVolumes((prev) => {
      const next = { ...prev }
      // 100% 就是默认值，不留记录 —— localStorage 不会越攒越大
      if (value === 1) delete next[key]
      else next[key] = Math.max(0, Math.min(MAX_VOLUME, value))
      return next
    })
  }, [])

  // 把音量真正写到每条远端音频轨道上。见 applyTrackVolume 的说明 ——
  // 超过 100% 的增益走的是 Web Audio，元素自身的 volume 到不了那里。
  useEffect(() => {
    for (const { track, key } of micAudio) {
      applyTrackVolume(track, voice.deafened ? 0 : (volumes[key] ?? 1))
    }
  }, [micAudio, volumes, voice.deafened])

  /** 共享声音的音量（0~1）。持久化，免得每次重开都要重调 */
  const [screenVolume, setScreenVolume] = useState(() => {
    const raw = localStorage.getItem('voice.screenVolume')
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1
  })

  useEffect(() => {
    try {
      localStorage.setItem('voice.screenVolume', String(screenVolume))
    } catch {
      /* ignore */
    }
  }, [screenVolume])

  /**
   * 某一路共享声音**实际**该用的音量。
   *
   * 只有「**正在观看的那一路**」才出声。这修掉两个毛病：
   *
   *   ① 点了「退出投屏」之后画面没了、**声音还在响**
   *   ② 两个人同时共享时，两路声音**同时**播出来
   *
   * 关闭喇叭时一切归零（和麦克风那条一样）。
   *
   * 注意这里只是**静音**、没有退订 —— 共享声音只有 64 kbps，
   * 退订再重订反而会带来重新协商的延迟，不值当。画面那边是真的断开了（省的是 8 Mbps）。
   */
  const screenAudioVolume = useCallback(
    (key: string): number => {
      if (voice.deafened) return 0
      if (!watching || watchingShare?.key !== key) return 0
      return screenVolume
    },
    [voice.deafened, watching, watchingShare, screenVolume]
  )

  // 音量要写到轨道上 —— 静音、调滑块都得实时生效。
  // 这里封顶就是 1，所以**不会**触发 Web Audio 增益那条路，延迟最低。
  useEffect(() => {
    for (const { track, key } of screenAudio) {
      applyTrackVolume(track, screenAudioVolume(key))
    }
  }, [screenAudio, screenAudioVolume])

  /**
   * 当前会话的 id。私聊页打开时**它取代频道聊天** ——
   * 私聊是"临时进来看看"的东西，不该把频道也挤掉一半。
   */
  const activeChatId = activeDm ? activeDm.id : (chatChannel?.id ?? null)

  /** 这个会话的正常历史（搜索时它被"覆盖"，但不丢） */
  const historyMessages = useMemo(
    () => (activeChatId ? messages.filter((m) => m.channel_id === activeChatId) : []),
    [messages, activeChatId]
  )

  /**
   * 搜索结果。**null = 没在搜索** —— 用 null 而不是空数组，
   * 是为了把"搜完一条都没有"和"没在搜索"分开，
   * 界面上这两种情况的提示完全不同。
   */
  const [searchResults, setSearchResults] = useState<ChatMessage[] | null>(null)

  const doSearch = useCallback(
    async (opts: { q?: string; authorId?: string }) => {
      if (!activeChatId) return []
      try {
        const found = await searchMessages(cfg, activeChatId, opts)
        setSearchResults(found)
        return found
      } catch {
        setSearchResults([])
        return []
      }
    },
    [cfg, activeChatId]
  )

  const clearSearch = useCallback(() => setSearchResults(null), [])

  // 换会话时把搜索状态清掉 —— 否则新频道一打开就显示着上个频道的搜索结果
  useEffect(() => {
    setSearchResults(null)
  }, [activeChatId])

  /** 可以筛选的人。从**已加载的历史**里归纳 —— 也就是最近说过话的人 */
  const searchAuthors = useMemo(() => {
    const seen = new Map<string, string>()
    for (const m of historyMessages) {
      if (m.author_id) seen.set(m.author_id, m.author_name)
    }
    return [...seen.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }, [historyMessages])

  const visibleMessages = searchResults ?? historyMessages

  // ── 成员列表 ─────────────────────────────────────────────
  //
  // 布局按 Discord 来：
  //   · 右侧 = 所有**在线**的人（聊天 WebSocket 的 presence）
  //   · 左侧语音频道下方 = 那个频道里正在语音的人（服务端轮询 LiveKit 推来的）
  // 同一个人会同时出现在两处 —— 这是 Discord 的行为，两处的语境不同：
  // 一个是"谁在线"，一个是"谁在这个语音频道里"。

  const onlineList = useMemo(() => withSuffixes(online), [online])

  // 哪些昵称正在语音里，用来在在线列表里加个 🔊 标记。
  // ⚠️ 只能按昵称匹配：聊天 WebSocket 和 LiveKit 是两套 identity，对不上。
  const inVoiceNames = useMemo(() => voiceNameSet(voiceRooms), [voiceRooms])

  /**
   * 在线 / 离线两组。
   *
   * 分开显示是惯例，也有实际用途：离线的人只是**占位** ——
   * 你真正会去找的是在线那批，他们不该被一堆灰名字稀释掉。
   *
   * 顺序沿用服务端给的原顺序（不重排）—— 排来排去反而会让人找不到。
   */
  const onlineMembers = useMemo(
    () => members.filter((m) => online.some((o) => o.userId === m.userId)),
    [members, online]
  )
  const offlineMembers = useMemo(
    () => members.filter((m) => !online.some((o) => o.userId === m.userId)),
    [members, online]
  )

  /** 成员列表里的一行。两组共用 —— 抽出来免得同一段 JSX 写两遍 */
  const renderMember = (m: MemberInfo, isOnline: boolean) => {
    const isMe = m.userId === cfg.userId
    const inVoice = inVoiceNames.has(m.name.trim().toLowerCase())

    // ⚠️「正在听」在 **presence**（online）里，不在成员表里 ——
    //    它是实时的在线状态，成员表那份是长期数据（离线的人也在里面）。
    const activity = online.find((o) => o.userId === m.userId)?.activity ?? null

    /**
     * 整行的悬停提示。**分多行**，不是一行用 `·` 串起来。
     *
     * ⚠️ 为什么要分两行：名字和歌名都在一条长句里的话，
     *    歌名一长整条提示就横到屏幕外面去了，很难扫。
     *    原生 `title` 里放真的换行符（`\n`）就会渲染成换行。
     *
     * ⚠️ 歌名**必须也在这里**。
     *    以前只有名字那一层挂了 `title={m.name}` —— 而**里层的 title 会盖住
     *    外层的**，于是鼠标停在名字上只能看到名字，看不到完整歌名。
     *
     * 名字那一层现在**故意不挂 title**，统一由这一条负责 ——
     * 它以名字开头，所以停在名字上依然能看到全名。
     */
    const lines = [
      `${m.name}${isMe ? '（我）' : ''}`,
      `${ROLE_LABEL[m.role]} · ${isOnline ? '在线' : '离线'} · 右键更多`,
    ]
    if (activity) {
      lines.push(
        `${activity.kind === 'game' ? '正在玩' : '正在听'}：${activity.title}${
          activity.artist ? `\n${activity.artist}` : ''
        }`
      )
    }
    const rowTitle = lines.join('\n')

    return (
      <div
        key={m.userId}
        className={`member ${isOnline ? '' : 'offline'}`}
        title={rowTitle}
        onContextMenu={(e) => openMemberMenu(e, { userId: m.userId, name: m.name, role: m.role })}
      >
        {/* ⚠️ 30 而不是 26：名字和「正在听/正在玩」两行加起来是 29px
            （见 styles.css 里那两个固定的 line-height），
            头像得比它高一点，两行才不会看起来"冒出"头像的上下边界。 */}
        <Avatar raw={m.avatar} name={m.name} size={30} />
        {/* 名字 + "正在听"竖着排。
            ⚠️ `flex: 1` 在这个外层而不是名字上 —— 它要负责把右边那些
            （语音图标、角色徽章）推到行尾。 */}
        <span className="member-text">
          {/* 名字 + 角色徽章在**同一行**，徽章紧跟在（我）后面。
              ⚠️ 名字自己要能收窄：它是 flex 里唯一可压缩的那一项，
              这样名字过长时截断的是**名字**，徽章不会被挤出去。
              ⚠️ 这里**故意不挂 title** —— 挂了会盖住整行的提示（见上面的 rowTitle）。 */}
          <span className="member-name">
            <span className="member-name-text">
              {m.name}
              {isMe && <span className="muted"> （我）</span>}
            </span>
            {m.role !== 'member' && (
              <span className={`role-badge role-badge-${m.role}`}>{ROLE_LABEL[m.role]}</span>
            )}
          </span>

          {activity && (
            <span
              className="member-activity"
              /* 歌名/游戏名和歌手分两行 —— 名字二三十个字时，
                 一行会横到屏幕外面去 */
              title={`${activity.kind === 'game' ? '正在玩' : '正在听'}：${activity.title}${
                activity.artist ? `\n${activity.artist}` : ''
              }`}
            >
              {activity.kind === 'game' ? '正在玩' : '正在听'}：{activity.title}
            </span>
          )}
        </span>

        {inVoice && (
          <span className="member-icon" title="正在语音频道里">
            🔊
          </span>
        )}

        {/* 「升管 / 撤管」原来就贴在这儿 —— 每行名字右边都挂一个按钮，
            整列看着很花。挪进右键菜单了（低频操作不该占着一行的位置）。 */}
      </div>
    )
  }

  /** 当前真正加入的语音房间名（= 频道 id）。用 room.name 最准确 */
  const voiceJoinedRoomId = voice.room?.name ?? null

  /**
   * 谁在看当前这一路投屏（显示用的名字，第一个是"你"）。
   *
   * 数据来源：每个观看者把自己正在看的 track sid 写进 participant attribute
   * （`watch`），而服务端的语音快照**本来就会把 attributes 一起带回来** ——
   * 所以不用新增任何接口或消息类型。
   *
   * 代价是最多 3 秒延迟（服务端轮询周期）。"有谁在看"这种事 3 秒完全够，
   * 不值得为它单开一条实时的通道。
   *
   * ⚠️ 挑选逻辑在 `lib/viewers.ts` 里（纯函数，有单测）——
   *    它**不把自己算进去**：共享画面的人自己的客户端也在"看"自己那一路，
   *    但那不是观众。以前硬塞了个「你」进去，于是一个人都没来时
   *    也显示"1 人在看"，等于没说。
   */
  const viewers = useMemo(
    () =>
      pickViewers(
        voiceJoinedRoomId ? voiceRooms[voiceJoinedRoomId] ?? [] : [],
        watchingShare?.sid,
        cfg.userId
      ),
    [voiceRooms, voiceJoinedRoomId, watchingShare?.sid, cfg.userId]
  )

  /**
   * 进/出语音频道时通知服务端，让它广播出去放提示音。
   *
   * 为什么由客户端上报而不是服务端自己判断：服务端是每 3 秒轮询一次
   * LiveKit 才知道谁在哪个房间的，靠它触发的话提示音最多会慢 3 秒，
   * 而"叮"一声要的就是即时。
   *
   * 服务端仍然是**广播给所有人**的，但每个客户端只放**自己所在频道**的
   * —— 过滤在 onChime 里做，见那里的说明。
   */
  const prevVoiceRoomRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevVoiceRoomRef.current
    const next = voiceJoinedRoomId
    if (prev === next) return
    prevVoiceRoomRef.current = next

    // 必须先同步这个 ref：下面发出的广播可能马上就回来，
    // 而 onChime 要靠它判断"这是不是我所在的频道"
    voiceRoomNowRef.current = next

    // 换频道时先报"离开旧的"，再报"进入新的"
    if (prev && prev !== next) {
      chatRef.current?.voiceChime(prev, false)

      // ★ 自己退出的那一声**本地直接放**。
      //
      //   服务端广播回来的时候，我已经不在那个房间了，会被 onChime 的过滤挡掉。
      //   但"我退出了频道"这件事本身该有个即时反馈。
      //
      //   不会和广播重复 —— 那一条正好被过滤掉了。
      playLeaveSound()
    }
    if (next) chatRef.current?.voiceChime(next, true)
  }, [voiceJoinedRoomId])

  /** 我在语音频道里吗。投屏的整套界面都以此为前提 ——
   *  人都不在频道里，别人的画面跟你没有任何关系 */
  const inVoice = Boolean(voiceJoinedRoomId)

  /**
   * 共享结束、或我离开了频道 → 自动退出观看。
   *
   * 不这么做的话会留在一个空画面上：人都走了、轨道也没了，
   * 界面却还挂着一个黑框。
   */
  useEffect(() => {
    if (screenShares.length === 0) setWatching(false)
  }, [screenShares.length])

  useEffect(() => {
    if (!inVoice) setWatching(false)
  }, [inVoice])

  /**
   * 闭麦 / 开麦。
   *
   * 包一层是为了**先出声再切** —— 音效按"即将变成什么状态"来选：
   * 现在开着麦说明这一下是去闭麦，就放闭麦音。
   * 这样即使切换失败，音效也和用户按下时看到的状态一致。
   *
   * 音效**只有自己听得见**（本地播放），不会走麦克风传给别人。
   */
  const toggleMicWithSound = useCallback(() => {
    // 不在语音频道里就什么都不做 —— **连音效也不放**。
    // 放了音效却什么都没发生，比没声音更让人困惑
    // （按钮上本来就有 disabled，快捷键这条路上得自己挡）
    if (!voice.room) return

    const wasOn = voice.room.localParticipant.isMicrophoneEnabled ?? false
    if (wasOn) playMuteSound()
    else playUnmuteSound()
    void voice.toggleMic()
  }, [voice])

  /**
   * 关喇叭 / 开喇叭。
   *
   * 和 toggleMicWithSound 一个套路：**先出声、再切**，音效按"即将变成什么状态"来选。
   *
   * 关喇叭会**顺带闭麦**（Discord 的规矩），但这里**不**放闭麦音 ——
   * 两个音叠在一起只会糊成一团。喇叭自己的双音已经说明"整个都不出声了"。
   *
   * 音效也是**只有自己听得见**：它走的是 sounds.ts 自己的 AudioContext，
   * 而关喇叭只压低远端音轨的音量，不会把这个音效也吞掉。
   */
  const toggleDeafenWithSound = useCallback(() => {
    // 同 toggleMicWithSound：不在频道里就不放音效，免得"响了但没事发生"
    if (!voice.room) return

    if (voice.deafened) playUndeafenSound()
    else playDeafenSound()
    void voice.toggleDeafen()
  }, [voice])

  // 让快捷键始终调到最新的处理函数（见上面 shortcutHandlerRef 的说明）
  useEffect(() => {
    shortcutHandlerRef.current = (action) => {
      // 两条路都走和点按钮**完全一样**的函数 ——
      // 不然音效和状态会对不上（快捷键换了音效，按钮没有）
      if (action === 'mute') toggleMicWithSound()
      else toggleDeafenWithSound()
    }
  }, [toggleMicWithSound, toggleDeafenWithSound])

  /**
   * 订阅全局快捷键。
   * 依赖是空的：真正的处理逻辑在上面的 ref 里，订阅本身只做一次。
   */
  useEffect(() => {
    const api = window.desktop
    if (!api?.onShortcut) return
    return api.onShortcut((action) => shortcutHandlerRef.current(action))
  }, [])

  // ── 屏幕共享 ─────────────────────────────────────────────
  // ── 文件 ─────────────────────────────────────────────────
  /** 用系统程序打开 / 下载。走主进程的 shell.openExternal，不在应用窗口里打开 */
  const openFile = useCallback(
    (id: string) => {
      const url = fileUrl(cfg, id)
      if (window.desktop?.openExternal) void window.desktop.openExternal(url)
      else window.open(url, '_blank')
    },
    [cfg]
  )

  /**
   * 用系统浏览器打开聊天里的一条链接。
   *
   * 主进程的 `openExternal` 自己会校验 `^https?://` ——
   * 所以就算这里漏了，`javascript:` 之类也过不去。两层都拦。
   */
  const openLink = useCallback((url: string) => {
    if (!/^https?:\/\//i.test(url)) return
    if (window.desktop?.openExternal) void window.desktop.openExternal(url)
    else window.open(url, '_blank')
  }, [])

  /** 上传后先把结果并进本地列表 —— 服务端也会广播，但不该让界面慢半拍 */
  const mergeFile = useCallback((uploaded: CloudFile) => {
    setFiles((prev) => (prev.some((f) => f.id === uploaded.id) ? prev : [uploaded, ...prev]))
  }, [])

  /** 聊天里点 📎 / 截图之后走这个。返回元信息给 ChatPanel 当待发附件 */
  const uploadForChat = useCallback(
    async (file: File): Promise<FileRef> => {
      // scope='chat'，而且**故意不 mergeFile** ——
      // 本地那份 files 列表就是「云端文件」面板，聊天附件不该混进去。
      // 附件靠 id 照样取得到（服务端 GET /api/files/:id 不看 scope）。
      return uploadFile(cfg, file, 'chat')
    },
    [cfg]
  )

  /** 云端文件面板里的上传 */
  const cloudUpload = useCallback(
    async (file: File) => {
      const uploaded = await uploadFile(cfg, file, 'cloud')
      mergeFile(uploaded)
      setNotice({
        text: `已上传 ${uploaded.name}`,
        kind: 'info',
      })
    },
    [cfg, mergeFile]
  )

  const cloudDelete = useCallback(
    async (file: CloudFile) => {
      await apiDeleteFile(cfg, file.id)
      setFiles((prev) => prev.filter((f) => f.id !== file.id))
      setNotice({ text: `已删除 ${file.name}`, kind: 'info' })
    },
    [cfg]
  )

  const onPickSource = useCallback(
    async (sourceId: string, withAudio: boolean) => {
      setPickerOpen(false)

      // 记住这次的选择，当作下次打开选择器时的默认值。
      // 设置里**刻意不再放**这个开关 —— 同一个开关出现在两处只会让人犹豫点哪个；
      // 而"要不要声音"本来就是每次共享单独决定的。
      setDefaultWithAudio(withAudio)
      try {
        localStorage.setItem('voice.shareWithAudio', withAudio ? '1' : '0')
      } catch {
        /* ignore */
      }

      await voice.startScreen({
        sourceId,
        preset: presetByKey(share.presetKey),
        contentHint: share.contentHint,
        withAudio,
      })

      // ⚠️ **刻意不自动打开观看**。
      //
      // 以前这里会 setWatching(true)，本意是"让你确认共享成功了没有"。
      // 但那意味着**只要开共享，上半屏就被自己的画面占掉** ——
      // 而开着共享的人往往正在做别的事（演示、放视频），
      // 自己的画面自己心里有数，不需要再看一遍。
      //
      // 现在统一成"谁都要点一下才看"：共享成功与否看底部那条按钮
      // 有没有变成红色的「停止共享」就够了。
    },
    [voice, share]
  )

  /**
   * 共享时要不要带系统声音。
   *
   * 只在**每次点「共享屏幕」时**决定（选择器里那个勾），设置里不再重复放一个。
   * 这里记住上次的选择，当作下次的默认值。
   */
  const [defaultWithAudio, setDefaultWithAudio] = useState(
    () => localStorage.getItem('voice.shareWithAudio') !== '0'
  )

  // ── 左右栏宽度（可拖动，记在本地）────────────────────────
  const [leftWidth, setLeftWidth] = useState(() =>
    readWidth('voice.leftWidth', 236, LEFT_MIN, LEFT_MAX)
  )
  const [rightWidth, setRightWidth] = useState(() =>
    readWidth('voice.rightWidth', 232, RIGHT_MIN, RIGHT_MAX)
  )
  const [dragging, setDragging] = useState<'left' | 'right' | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem('voice.leftWidth', String(leftWidth))
    } catch {
      /* ignore */
    }
  }, [leftWidth])

  useEffect(() => {
    try {
      localStorage.setItem('voice.rightWidth', String(rightWidth))
    } catch {
      /* ignore */
    }
  }, [rightWidth])

  // 拖动中的闭包要靠它读"另一侧"的当前宽度。放 ref 里是为了让下面那个
  // effect 的依赖只有 [dragging] —— 否则鼠标每动一下都会重新挂一次监听。
  const leftWidthRef = useRef(leftWidth)
  const rightWidthRef = useRef(rightWidth)

  useEffect(() => {
    leftWidthRef.current = leftWidth
    rightWidthRef.current = rightWidth
  }, [leftWidth, rightWidth])

  /**
   * 拖动改栏宽。
   *
   * ⚠️ 监听挂在 **document** 上而不是把手上 —— 鼠标拖快了会跑出那条 5px 的窄条，
   *    挂在把手上会立刻丢事件，拖动就"断"在半路。
   */
  useEffect(() => {
    if (!dragging) return

    const onMove = (e: MouseEvent) => {
      e.preventDefault()

      // 上限还要受窗口限制 —— 别把中间区域挤没
      if (dragging === 'left') {
        const limit = window.innerWidth - rightWidthRef.current - MAIN_MIN
        setLeftWidth(Math.max(LEFT_MIN, Math.min(LEFT_MAX, e.clientX, limit)))
      } else {
        const limit = window.innerWidth - leftWidthRef.current - MAIN_MIN
        setRightWidth(
          Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, window.innerWidth - e.clientX, limit))
        )
      }
    }

    const stop = () => setDragging(null)

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', stop)
    document.body.classList.add('col-resizing')

    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', stop)
      document.body.classList.remove('col-resizing')
    }
  }, [dragging])

  const micOn = voice.room?.localParticipant.isMicrophoneEnabled ?? false
  const voiceChannel = channels.find((c) => c.id === activeChannelId && c.kind === 'voice')
  const screenName = watchingShare?.name ?? ''

  // ── 渲染 ────────────────────────────────────────────────

  /**
   * 左下角的语音面板。三行：状态 / 麦克风与喇叭 / 投屏与设置。
   *
   * 为什么从左下角而不是横在底部：
   *   原来它横跨整个中间区域，**把聊天和投屏挤掉一条**。
   *   挪到左边之后，中间就只剩聊天和投屏这两件事了。
   *
   * 音质那项显示的是**麦克风**的编码规格（48 kbps）——
   * 以前这里显示的是**投屏画质**（1080p60 之类），
   * 那个信息跟"我在语音里"没关系，现在挪到了选投屏源的界面里。
   */
  const voicePanel = (
    <div className="voice-panel">
      <div className="voice-panel-row">
        <span className={`dot ${voice.status === 'connected' ? 'on' : 'off'}`} />
        {/* 状态 / 频道 / 人数 / 音质，**全挤在同一行**。
            拆成两行会把面板撑高，而这一块本来就该紧凑 ——
            宽度不够时靠省略号截断，而不是换行。 */}
        <span className="voice-panel-text">
          {/* 连接过程一定要有可见反馈。否则用户以为没点上、再点一次，
              而两次点击会各自建立一条连接 —— 成员列表里就出现两个自己。 */}
          {voice.status === 'connecting' ? (
            <>正在连接…</>
          ) : voice.status === 'reconnecting' ? (
            <>重连中…</>
          ) : voiceChannel ? (
            <>🔊 {voiceChannel.name}</>
          ) : voice.status === 'connected' ? (
            <>已连接语音</>
          ) : (
            <>未加入语音频道</>
          )}
          {voice.room && (
            <>
              {' · '}
              {participants.length} 人 · {AUDIO_SPEC}
              {voice.deafened ? ' · 已关喇叭' : ''}
            </>
          )}
        </span>
      </div>

      {/* 三个**纯图标**按钮。
          麦克风 / 喇叭的开关状态由图标（多一道斜杠）+ 颜色表示 ——
          文字标签反而会让它们和下面那排"投屏 / 设置"抢注意力，
          而且字数怎么排都别扭。 */}
      <div className="voice-panel-row">
        <button
          className={`voice-btn icon ${micOn ? 'on' : 'off'}`}
          disabled={!voice.room || voice.deafened}
          onClick={toggleMicWithSound}
          title={
            voice.deafened ? '关闭喇叭时无法单独开麦' : micOn ? '闭麦（开麦中）' : '开麦（已闭麦）'
          }
        >
          <MicIcon off={!micOn} />
        </button>

        {/* 关喇叭：Discord 的规矩 —— 关喇叭时顺带闭麦，
            取消时恢复关之前那个麦克风状态（见 useVoiceRoom.toggleDeafen） */}
        <button
          className={`voice-btn icon ${voice.deafened ? 'off' : 'on'}`}
          disabled={!voice.room}
          onClick={toggleDeafenWithSound}
          title={voice.deafened ? '恢复收听（当前已静音）' : '静音 —— 关掉所有别人的声音（会同时闭麦）'}
        >
          <SpeakerIcon off={voice.deafened} />
        </button>

        {/* 退出语音频道。红色 + 挂断图标。
            以前只能点频道旁边那个 ×，现在这里也有一条路 ——
            而且它就在"我在哪个频道"那一行的正下方，位置对得上。 */}
        <button
          className="voice-btn icon danger-fill"
          disabled={!voice.room}
          onClick={() => void voice.disconnect()}
          title="退出语音频道"
        >
          <PhoneOffIcon />
        </button>
      </div>

      <div className="voice-panel-row">
        {voice.isSharing ? (
          <button
            className="voice-btn danger"
            onClick={() => void voice.stopScreen()}
            title="停止共享屏幕"
          >
            <ScreenIcon />
            停止
          </button>
        ) : (
          <button
            className="voice-btn"
            disabled={!voice.room}
            onClick={() => setPickerOpen(true)}
            title="共享屏幕"
          >
            <ScreenIcon />
            投屏
          </button>
        )}

        <button className="voice-btn" onClick={() => setSettingsOpen(true)} title="设置">
          <GearIcon />
          设置
        </button>
      </div>
    </div>
  )

  return (
    <div
      className="app"
      style={
        {
          // 宽度交给 CSS 变量，这样拖动时只更新一个变量，
          // 不用把 grid-template-columns 整个字符串重新拼一遍
          '--left-w': `${leftWidth}px`,
          '--right-w': `${rightWidth}px`,
        } as CSSProperties
      }
    >
      {/* 左列 = 频道列表 + 底部语音面板。
          包一层是为了让面板能**钉在底部**：.channel-list 自己是滚动的，
          面板放进它里面会跟着滚走。 */}
      <div className="left-col">
        <ChannelList
          server={server}
          channels={channels}
          activeChannelId={activeChannelId}
          voiceRooms={voiceRooms}
          joinedRoomId={voiceJoinedRoomId}
          myUserId={cfg.userId}
          speakingKeys={voice.speakingKeys}
          canManage={canManage(myRole)}
          connected={chatReady}
          onlineCount={onlineList.length}
          fileCount={fileStats.count}
          onOpenFiles={() => setFilesOpen(true)}
          volumes={volumes}
          onSetVolume={setUserVolume}
          onSelect={(c) => void selectChannel(c)}
          onCreateChannel={() => setCreateChannelOpen(true)}
          onOpenServerSettings={() => setServerSettingsOpen(true)}
          onDeleteChannel={(id) => {
            if (window.confirm('删除这个频道？频道里的聊天记录会一起删掉，无法恢复。')) {
              chatRef.current?.deleteChannel(id)
            }
          }}
        />
        {voicePanel}
      </div>

      {/* 左把手：拖动改左侧宽度。
          名字长了侧栏就不够用（成员列表里全是省略号），所以两边都能拖 */}
      <div
        className={`col-resizer ${dragging === 'left' ? 'active' : ''}`}
        title="拖动调整左侧宽度"
        onMouseDown={(e) => {
          e.preventDefault()
          setDragging('left')
        }}
      />

      <main className="main-area" ref={mainRef}>
        <UpdateBanner
          status={update}
          onCheck={() => {
            setUpdate({ kind: 'checking' })
            void window.desktop?.checkUpdate()
          }}
          onDownload={() => {
            setUpdate({ kind: 'downloading', percent: 0 })
            void window.desktop?.downloadUpdate()
          }}
          onInstall={() => {
            void window.desktop?.installUpdate()
          }}
          onDismiss={() => setUpdate({ kind: 'idle' })}
        />

        {/* 有人共享、我在频道里、但**还没点观看** —— 只给一个按钮。
            不自动播放是有意的（不打扰 + 省流量），见 watching 那段说明。 */}
        {inVoice && !watchingShare && inviteShare && (
          <button
            className="stage-invite"
            onClick={() => {
              // 顺手把"上次选的那一路"清掉 —— 它多半已经结束了。
              // 不清的话 watchingShare 会一直返回 null（因为找不到那个 sid），
              // 点了「点击观看」也打不开，看起来像按钮坏了。
              setWatchingSid(null)
              setWatching(true)
            }}
          >
            <span className="stage-invite-icon">🖥</span>
            <span className="stage-invite-text">
              <strong>{inviteShare.name}</strong>
              {inviteShare.isLocal ? '（我）' : ''} 正在共享屏幕
              {screenShares.length > 1 ? `（共 ${screenShares.length} 路）` : ''}
            </span>
            <span className="stage-invite-cta">点击观看</span>
          </button>
        )}

        {watchingShare && !stageCollapsed && (
          <>
            <div
              className={
                'stage' +
                (isFullscreen ? ' is-fullscreen' : '') +
                (isFullscreen && !controlsVisible ? ' controls-hidden' : '') +
                (isFullscreen && cursorHidden ? ' cursor-hidden' : '')
              }
              ref={stageRef}
              // 只有全屏才需要跟踪鼠标位置；窗口模式下控制条一直显示
              onMouseMove={isFullscreen ? onStageMouseMove : undefined}
              style={{ flexBasis: `${Math.round(stageRatio * 100)}%` }}
            >
              <div className="stage-header">
                {/* 多路共享时用标签页切换 —— 之前只显示第一路，而第一路永远是
                    自己，所以两个人同时共享时你只能看到自己的画面 */}
                {screenShares.length > 1 ? (
                  <div className="stage-tabs">
                    {screenShares.map((s) => (
                      <button
                        key={s.sid}
                        className={`stage-tab ${s.sid === watchingShare.sid ? 'active' : ''}`}
                        onClick={() => setWatchingSid(s.sid)}
                        title={s.name + (s.isLocal ? '（我）' : '')}
                      >
                        {s.name}
                        {s.isLocal ? '（我）' : ''}
                      </button>
                    ))}
                  </div>
                ) : (
                  <strong>{screenName}</strong>
                )}

                <span className="muted small">
                  正在共享{screenShares.length > 1 ? ` · 共 ${screenShares.length} 路` : ''}
                </span>

                {/* 谁在看这一路 —— 已经挪到画面左下角的叠头像上了
                    （见下面 .stage-video 里那块）。这里不再重复显示。 */}

                <div className="spacer" />

                {/* 共享声音的独立音量。对方外放导致你听到自己的回音时，
                    把这个拉小就行，不用整个静音。

                    ⚠️ **全屏时也要有** ✓ —— 全屏看投屏恰恰是最需要调音量的时候
                    （画面占满屏幕 ✓ 别人外放的杂音最烦 ✓）
                    它归控制条管 ✓ 鼠标移开时跟着一起藏 ✓ 不会一直杵在画面上 ✓ */}
                {screenAudio.length > 0 && (
                  <span className="stage-volume" title="共享声音的音量">
                    {screenVolume === 0 ? '🔇' : '🔊'}
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(screenVolume * 100)}
                      onChange={(e) => setScreenVolume(Number(e.target.value) / 100)}
                    />
                  </span>
                )}

                {/* ⚠️ 全屏时右上角**只留「退出全屏」**。
                    收起 / 退出投屏 / 停止共享在全屏下都收起来了 ——
                    全屏是"专心看画面"的模式，多几个按钮反而容易误点
                    （尤其是"停止共享"，手一抖就把自己的投屏掐了）。 */}
                <button
                  className="ghost small-btn"
                  onClick={() => void toggleFullscreen()}
                  title={isFullscreen ? '退出全屏（也可以按 Esc）' : '全屏观看'}
                >
                  {isFullscreen ? '退出全屏' : '⛶ 全屏'}
                </button>

                {!isFullscreen && (
                  <>
                    <button
                      className="ghost small-btn"
                      onClick={() => setStageCollapsed(true)}
                      title="画面收起来，聊天区变大（还在接收画面）"
                    >
                      收起
                    </button>
                    {/* 不看了。和「收起」的区别：收起只是藏起来，这个**断开画面接收**，
                        分享者那边也会跟着停发（省流量）。 */}
                    <button
                      className="small-btn stage-exit"
                      onClick={() => {
                        setWatching(false)
                        setStageCollapsed(false)
                      }}
                      title="不看这个投屏了 —— 同时停止接收画面，省流量"
                    >
                      退出投屏
                    </button>
                  </>
                )}
              </div>
              <div className="stage-video">
                <VideoTile track={watchingShare.track} muted className="stage-player" />

                {/* 谁在看 —— 叠在画面**左下角**。
                    放这儿而不是标题栏：看投屏时视线本来就在画面上，
                    左下角是"观看者"最自然的位置，也省得和标题、按钮抢地方。
                    一个人都没有时**什么都不渲染**（不显示"0 人在看"那种废话）。 */}
                {viewers.total > 0 && (
                  <div
                    className="viewer-stack"
                    title={`正在观看：${viewers.allNames.join('、')}`}
                  >
                    {viewers.shown.map((v) => (
                      <span className="viewer-avatar" key={v.key}>
                        <Avatar raw={v.avatar} name={v.name} size={22} />
                      </span>
                    ))}
                    {viewers.extra > 0 && (
                      <span className="viewer-avatar viewer-more">+{viewers.extra}</span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* 拖动这个手柄上下调整画面大小 */}
            <div
              className="stage-divider"
              onMouseDown={(e) => {
                e.preventDefault()
                draggingRef.current = true
              }}
              title="拖动调整画面大小"
            />
          </>
        )}

        {/* 收起后的细条。
            ⚠️ 这里也放一个「退出投屏」—— 不然收起之后那个按钮跟着头部一起藏起来了，
               想不看得先展开，多一步。 */}
        {watchingShare && stageCollapsed && (
          <div className="stage-mini">
            <button className="stage-mini-open" onClick={() => setStageCollapsed(false)}>
              🖥 {screenName} 正在共享屏幕
              {screenShares.length > 1 ? `（还有 ${screenShares.length - 1} 路）` : ''} ·
              点击展开
            </button>
            <button
              className="small-btn stage-exit"
              onClick={() => {
                setWatching(false)
                setStageCollapsed(false)
              }}
              title="不看这个投屏了 —— 同时停止接收画面，省流量"
            >
              退出投屏
            </button>
          </div>
        )}

        {/* 聊天永远在，投屏再大也不影响打字。
            私聊页和频道聊天共用这一个组件 —— 消息、附件、截图完全一样，
            区别只在标题栏和"往哪个会话发"。 */}
        <ChatPanel
          channelName={chatChannel?.name ?? ''}
          dmPeer={activeDm ? { name: activeDm.peerName } : null}
          onCloseDm={() => setActiveDm(null)}
          messages={visibleMessages}
          connected={chatReady}
          fileHref={(id) => fileUrl(cfg, id)}
          onSend={(body, attachment) => {
            if (activeChatId) chatRef.current?.send(activeChatId, body, attachment)
          }}
          onUpload={uploadForChat}
          onOpenFile={openFile}
          onSearch={doSearch}
          onClearSearch={clearSearch}
          searching={searchResults !== null}
          searchAuthors={searchAuthors}
          /* 只有频道主 / 管理员能删。不传这个回调 = 界面里没有删除入口。
             服务端也会再判一次 —— 界面藏起来只是"不给出会失败的操作"，
             不能当成权限控制。 */
          onDeleteMessage={
            canManage(myRole) ? (id) => chatRef.current?.deleteMessage(id) : undefined
          }
          onOpenLink={openLink}
          /**
           * 聊天里的头像。
           *
           * ⚠️ 消息本身**不带头像** —— 只有作者 id 和名字 ✓
           *    头像是**成员**的属性 ✓ 所以在这里查 ✓
           *    查不到（比如那个人已经被移除 ✗）就返回空串 ✓
           *    `<Avatar>` 会退回到"名字首字母" ✓ 不会变成空白 ✓
           */
          avatarOf={(userId) => members.find((x) => x.userId === userId)?.avatar ?? ''}
        />

      </main>

      {/* 右把手 */}
      <div
        className={`col-resizer ${dragging === 'right' ? 'active' : ''}`}
        title="拖动调整右侧宽度"
        onMouseDown={(e) => {
          e.preventDefault()
          setDragging('right')
        }}
      />

      {/* 成员列表 */}
      <aside className="member-list">
        <div className="member-group-title">
          成员 · {onlineMembers.length} 在线 / {members.length} 总计
        </div>

        {onlineMembers.map((m) => renderMember(m, true))}

        {/* 在线 / 离线之间。
            ⚠️ 人数**不写在横线上** —— 那样它看起来像在线那组的收尾。
            横线只负责"分开"这一件事，人数作为**下面那组**的标题。 */}
        {offlineMembers.length > 0 && (
          <>
            <div className="member-divider" />
            <div className="member-offline-title">离线 — {offlineMembers.length}</div>
          </>
        )}

        {offlineMembers.map((m) => renderMember(m, false))}

        {members.length === 0 && (
          <div className="muted small" style={{ padding: '4px 14px' }}>
            还没有成员
          </div>
        )}
      </aside>

      {/* 远端音频播放。分两路是为了让「人声」和「内容声」各有各的音量控制：
          · 麦克风     —— 由「关闭喇叭」统一控制，另外每个人还能单独调
          · 共享声音   —— 自己的全局音量；关喇叭或拉到 0 时静音
          muted 是最可靠的静音方式：直接让 <video> 不输出声音，
          不需要去动每条轨道。 */}
      <div className="audio-sinks">
        {micAudio.map(({ track, key }) => (
          <VideoTile
            key={track.sid}
            track={track}
            muted={voice.deafened}
            volume={volumes[key] ?? 1}
          />
        ))}
        {screenAudio.map(({ track, key }) => (
          <VideoTile
            key={track.sid}
            track={track}
            // 音量归零时直接把元素静音 —— applyTrackVolume 那条路已经设了 0，
            // 这里是双保险（Web Audio 用不上时也一定不出声）
            muted={screenAudioVolume(key) === 0}
            volume={screenAudioVolume(key)}
          />
        ))}
      </div>

      {/* 提示 */}
      {(notice || voice.error) && (
        <div
          // ⚠️ 类名要**加了前缀**，不能用裸的 `error` ——
          //    全局那条 `.error { color: var(--err) }` 会把文字也染成红色，
          //    配上红色的底就成了"红底红字"，什么都看不见。
          //    加前缀之后是另一个类名，撞不上。
          className={`toast ${notice ? `toast-${notice.kind}` : 'toast-error'}`}
          onClick={() => {
            setNotice(null)
            voice.clearError()
          }}
        >
          {notice ? notice.text : voice.error}
        </div>
      )}

      <ServerSettingsDialog
        open={serverSettingsOpen}
        server={server}
        onCancel={() => setServerSettingsOpen(false)}
        onSave={(name, avatarRaw) => {
          chatRef.current?.updateServer(name, avatarRaw)
          setServerSettingsOpen(false)
        }}
      />

      <ChannelCreateDialog
        open={createChannelOpen}
        onCancel={() => setCreateChannelOpen(false)}
        onCreate={(name, kind) => {
          chatRef.current?.createChannel(name, kind)
          setCreateChannelOpen(false)
        }}
      />

      <SourcePicker
        open={pickerOpen}
        defaultWithAudio={defaultWithAudio}
        share={share}
        onCancel={() => setPickerOpen(false)}
        onPick={(id, withAudio) => void onPickSource(id, withAudio)}
      />

      {/* 成员列表的右键菜单。和频道那个一样放在滚动容器外面 */}
      {memberMenu && (
        <div
          className="context-menu"
          style={{ left: memberMenu.x, top: memberMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="context-menu-title">{memberMenu.name}</div>

          {memberMenu.isMe ? (
            <div className="context-menu-note">这是你自己</div>
          ) : (
            <>
              <button
                className="context-menu-item"
                onClick={() => {
                  const { userId, name } = memberMenu
                  setMemberMenu(null)
                  openDmWith(userId, name)
                }}
              >
                私聊
              </button>

              {/* 升管 / 撤管。只有频道主能动别人，而且动不了其他频道主。
                  放在这儿而不是成员行上：这是**低频**操作，
                  而一行一个按钮会让整列看着很花。 */}
              {myRole === 'owner' && memberMenu.role !== 'owner' && (
                <button
                  className="context-menu-item"
                  onClick={() => {
                    const { userId, role } = memberMenu
                    setMemberMenu(null)
                    chatRef.current?.setRole(userId, role === 'admin' ? 'member' : 'admin')
                  }}
                >
                  {memberMenu.role === 'admin' ? '取消管理员' : '设为管理员'}
                </button>
              )}

              {/* 移除成员。只有频道主能动别人，而且动不了其他频道主。
                  ⚠️ 界面藏起来只是**不给入口**，真正拦住的是服务端
                     （伪造一条 removeMember 消息会被 deny('forbidden')）。
                  ⚠️ 用 confirm 拦一道：这是不可逆的（成员记录直接删掉）。 */}
              {myRole === 'owner' && memberMenu.role !== 'owner' && (
                <button
                  className="context-menu-item danger"
                  onClick={() => {
                    const { userId, name } = memberMenu
                    setMemberMenu(null)
                    if (
                      !window.confirm(
                        `把「${name}」移出服务器？\n\n` +
                          '他会立刻断开，成员记录被删除。\n' +
                          '他发过的消息会保留（聊天记录不会出现空洞）。\n\n' +
                          '注意这是踢出，不是封禁 —— 他清掉本地配置重新打开，\n' +
                          '会以一个新身份再进来。'
                      )
                    ) {
                      return
                    }
                    chatRef.current?.removeMember(userId)
                  }}
                >
                  移除成员
                </button>
              )}
            </>
          )}
        </div>
      )}

      <CloudFilesDialog
        open={filesOpen}
        files={files}
        stats={fileStats}
        myUserId={cfg.userId}
        myRole={myRole}
        fileHref={(id) => fileUrl(cfg, id)}
        onClose={() => setFilesOpen(false)}
        onUpload={cloudUpload}
        onDelete={cloudDelete}
        onOpenFile={openFile}
      />

      <SettingsDialog
        open={settingsOpen}
        config={cfg}
        share={share}
        version={appVersion}
        devices={devices}
        activeInputId={voice.activeInput}
        activeOutputId={voice.activeOutput}
        hasVoiceRoom={Boolean(voice.room)}
        theme={theme}
        onSetTheme={setTheme}
        micOptions={micOptions}
        onSetMicOption={(key, value) => {
          const next = { ...micOptions, [key]: value }
          setMicOptions(next)
          // 正在开麦的话要重新采集才生效；没开麦就只记下设置
          void voice.applyMicOptions(next)
        }}
        prefs={prefs}
        onSwitchDevice={(kind, id) => void voice.switchDevice(kind, id)}
        onSetCloseAction={(action) => {
          void window.desktop?.setCloseAction(action).then(refreshPrefs)
        }}
        onSetOpenAtLogin={(enabled) => {
          void window.desktop?.setOpenAtLogin(enabled).then(refreshPrefs)
        }}
        onSetMediaDetect={(enabled) => {
          void window.desktop?.setMediaDetect(enabled).then(refreshPrefs)
        }}
        onSetGameDetect={(enabled) => {
          void window.desktop?.setGameDetect(enabled).then(refreshPrefs)
        }}
        onPrefsChanged={refreshPrefs}
        onReportGame={(exe, name) => {
          // ① 发给服务端 —— 这一步才让"一个人报过，所有人受益"成立
          chatRef.current?.reportGame(exe, name)
          // ② 同时存本地：离线时、或者服务端还没部署这功能时，自己也能用
          void window.desktop?.addCustomGame?.(exe, name).then(refreshPrefs)
        }}
        onSetShortcut={async (action, accelerator) => {
          const api = window.desktop
          if (!api?.setShortcut) return { ok: false, reason: 'unavailable' }
          const result = await api.setShortcut(action, accelerator)
          // 无论成败都刷一次 —— 界面上要显示实际生效的值
          await refreshPrefs()
          return result
        }}
        onClose={() => setSettingsOpen(false)}
        onCheckUpdate={() => {
          // 先关掉弹窗，否则更新提示条被它盖住看不见
          setSettingsOpen(false)
          setUpdate({ kind: 'checking' })
          void window.desktop?.checkUpdate()
        }}
        onSaveConfig={(next) => {
          setCfg(next)
          saveConfig(next)
          // 改头像/昵称后立刻同步：昵称靠重连聊天 WebSocket 生效（见上面的 effect），
          // 头像则直接更新 LiveKit 的 participant attribute，不用断开语音
          void voice.updateAvatar(serializeAvatar(next.avatar))
        }}
        onSaveShare={(next) => {
          setShare(next)
          try {
            localStorage.setItem(SHARE_KEY, JSON.stringify(next))
          } catch {
            /* ignore */
          }
        }}
      />
    </div>
  )
}
