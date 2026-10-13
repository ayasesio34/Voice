import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * 「正在听歌」和「正在玩游戏」的本地检测。
 *
 * ── 为什么用 PowerShell 而不是原生模块 ──────────────────────
 * SMTC（系统媒体控制）是 WinRT API，Node 碰不到；进程枚举倒是 Node 能做，
 * 但**两件事都不该为它单独写原生模块** —— 那要处理 MSVC + Windows SDK，
 * 是这个项目里唯一需要编译环境的地方，能避就避。
 * PowerShell 5.1 能直接投影 WinRT 类型，也能读进程列表，够用了。
 *
 * 每个探测器都是**常驻一个子进程**：PowerShell 启动要 200~500ms 且吃 CPU，
 * 几秒起一个太浪费。
 *
 * ── 隐私边界 ────────────────────────────────────────────────
 * · **只在本地检测**。关掉开关时主进程**真的把子进程停掉** ——
 *   不是"读了不上报"。后者隐私是假的：进程还在跑、数据还在拿。
 * · 两个开关**互相独立**：关了音乐不影响游戏，反之亦然。
 * · 非 Windows 直接不启动。
 */

// ════════════════════════════════════════════════════════════
// 游戏白名单
// ════════════════════════════════════════════════════════════

/**
 * 进程名（小写，**不带 .exe**，和 `Get-Process` 的 `ProcessName` 一致）
 * → 显示名。
 *
 * ⚠️ **只查这张表里的进程**，不去分析全部进程。两个原因：
 *    · 扫全表更容易被安全软件盯上（有些恶意软件也用同样的 API 枚举进程）；
 *    · 白名单外的东西认不准，报错了比不报更烦。
 *
 * ⚠️ 关于反外挂：这里只做「某个进程在不在」这一件事 ——
 *    **不读游戏内存、不注入、不 hook、不装键盘钩子、不做 overlay**。
 *    这是任务管理器在做的事，Discord / Steam / OBS 都在做。
 *    想加新游戏，往这里加一行就行。
 */
export const GAMES: Record<string, string> = {
  // ── 竞技 / 网游 ──
  'league of legends': '英雄联盟',
  'riotclientservices': '', // 客户端后台进程，不当作在玩（空串 = 忽略）
  cs2: 'Counter-Strike 2',
  'valorant-win64-shipping': '无畏契约',
  'narakabladepoint': '永劫无间',
  tslgame: '绝地求生',
  'dota2': 'Dota 2',
  'r5apex': 'Apex 英雄',
  'rainbowsix': '彩虹六号：围攻',
  'escapefromtarkov': '逃离塔科夫',
  'bf2042': '战地 2042',
  'deltaforceclient-win64-shipping': '三角洲行动',
  'wow': '魔兽世界',
  'hearthstone': '炉石传说',
  'overwatch': '守望先锋',
  'genshinimpact': '原神',
  'starrail': '崩坏：星穹铁道',
  'zenlesszonezero': '绝区零',
  'wuthering waves': '鸣潮',
  'gta5': 'GTA 5',
  'rdr2': '荒野大镖客 2',
  'left4dead2': '求生之路 2',

  // ── 单机 / 联机 ──
  'b1-win64-shipping': '黑神话：悟空',
  'eldenring': '艾尔登法环',
  'cyberpunk2077': '赛博朋克 2077',
  'monsterhunterwilds': '怪物猎人：荒野',
  'ittakestwo': '双人成行',
  'overcooked2': '胡闹厨房 2',
  'stardew valley': '星露谷物语',
  'terraria': '泰拉瑞亚',
  'hollow_knight': '空洞骑士',
  'slaythespire': '杀戮尖塔',
  'baldurs gate 3': '博德之门 3',
  'palworld-win64-shipping': '幻兽帕鲁',
  'vrising': '夜族崛起',
  'among us': 'Among Us',
}

/** 真正要盯的进程名列表（去掉空串那些"忽略"项） */
export function watchList(): string[] {
  return Object.entries(GAMES)
    .filter(([, display]) => display !== '')
    .map(([exe]) => exe)
}

// ════════════════════════════════════════════════════════════
// 用户自己上报的游戏
// ════════════════════════════════════════════════════════════

/**
 * 内置表里没有的游戏，用户可以自己加一条。
 *
 * 为什么放在本地而不是"提交到服务端"：这个自建服务没有后台审核，
 * 而且**别人看到的是解析后的显示名**（客户端上报的是 `title`，
 * 不是 exe）—— 所以你本地加一条，朋友那边照样能看到正确的名字。
 *
 * ⚠️ 键必须是小写、不带 `.exe`，和 `Get-Process` 的 `ProcessName` 对齐。
 */
let customGames: Record<string, string> = {}

export function setCustomGames(map: Record<string, string>): void {
  const clean: Record<string, string> = {}
  for (const [exe, name] of Object.entries(map ?? {})) {
    const k = String(exe).trim().toLowerCase().replace(/\.exe$/, '')
    const v = String(name).trim()
    if (k && v) clean[k] = v
  }
  customGames = clean
}

/** 自定义项也进白名单 —— 不然脚本根本不会去看那个进程 */
export function customWatchList(): string[] {
  return Object.keys(customGames)
}

// ════════════════════════════════════════════════════════════
// 服务端下发的共享游戏表
// ════════════════════════════════════════════════════════════

/**
 * **全服共享**的游戏表（服务端存着，连上时下发）。
 *
 * 别人上报过的东西从这里来 —— 不用你自己再报一遍。
 *
 * 优先级：**内置 < 共享 < 本地自己报的**。
 * 本地放最后是因为那是"我自己的选择"，应该盖过别人报的名字。
 */
let sharedGames: Record<string, string> = {}

export function setSharedGames(map: Record<string, string>): void {
  const clean: Record<string, string> = {}
  for (const [exe, name] of Object.entries(map ?? {})) {
    const k = String(exe).trim().toLowerCase().replace(/\.exe$/, '')
    const v = String(name).trim()
    if (k && v) clean[k] = v
  }
  sharedGames = clean
}

/** 共享项也要进白名单，不然脚本不会去看那些进程 */
export function sharedWatchList(): string[] {
  return Object.keys(sharedGames)
}

// ════════════════════════════════════════════════════════════
// 通用的常驻探测器
// ════════════════════════════════════════════════════════════

type Listener<T> = (value: T | null) => void

/**
 * `parse` 的返回值有**三种**，这是刻意的：
 *   · `T`         —— 有内容
 *   · `null`      —— 明确表示"没有"（例如 `{"playing":false}`）
 *   · `undefined` —— **没看懂**，忽略掉，保持上一次的状态
 *
 * ⚠️ 第三种是必须的。以前"没看懂"也当成 `null`，于是 PowerShell 混进来任何
 *    一行警告，界面上就会闪一下"没在听" ✗ 只有解析失败时才该装死。
 */
type Parse<T> = (line: string) => T | null | undefined

type Watcher<T> = {
  start: () => void
  stop: () => void
  get: () => T | null
  on: (fn: Listener<T>) => () => void
}

function createWatcher<T>(
  scriptName: string,
  parse: Parse<T>,
  /** ⚠️ 传函数而不是数组：白名单可能会变（用户上报新游戏），
   *  每次启动时现取，省得为了换参数把整个探测器重建一遍。 */
  extraArgs: () => string[] = () => []
): Watcher<T> {
  let child: ChildProcess | null = null
  let current: T | null = null
  let stopped = true
  let restartTimer: NodeJS.Timeout | null = null
  const listeners = new Set<Listener<T>>()

  const scriptPath = (): string =>
    app.isPackaged
      ? join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'media-session', scriptName)
      : join(app.getAppPath(), 'resources', 'media-session', scriptName)

  const emit = (): void => {
    for (const fn of listeners) {
      try {
        fn(current)
      } catch {
        /* 监听者自己的问题，不该拖垮检测 */
      }
    }
  }

  const handleLine = (line: string): void => {
    const value = parse(line)
    if (value === undefined) return // 没看懂 —— 保持原状，别闪

    // 内容没变就别往渲染进程推（每几秒推一次一样的没意义）
    if (value === null && current === null) return
    if (value !== null && current !== null && JSON.stringify(value) === JSON.stringify(current)) {
      return
    }

    current = value
    emit()
  }

  const start = (): void => {
    if (process.platform !== 'win32') return
    if (child) return

    stopped = false

    let proc: ChildProcess
    try {
      proc = spawn(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath(), ...extraArgs()],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      )
    } catch {
      // PowerShell 起不来（组策略禁用之类）—— 当作没这个功能，不报错
      return
    }

    child = proc

    /** 按行切 —— stdout 是按块来的，一次可能给半行或者好几行 */
    let buf = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      buf += chunk
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) handleLine(line)
        nl = buf.indexOf('\n')
      }
    })

    proc.on('exit', () => {
      child = null
      // 进程没了就别再显示上一首/上一局 —— 否则会一直挂着早就不在的状态
      if (current !== null) {
        current = null
        emit()
      }
      // 意外退出（脚本崩了、被任务管理器杀了）→ 过一会儿重来一次
      if (!stopped && !restartTimer) {
        restartTimer = setTimeout(() => {
          restartTimer = null
          start()
        }, 5000)
      }
    })

    proc.on('error', () => {
      child = null
    })
  }

  const stop = (): void => {
    stopped = true
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (child) {
      child.kill()
      child = null
    }
    if (current !== null) {
      current = null
      emit()
    }
  }

  return {
    start,
    stop,
    get: () => current,
    on: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

// ════════════════════════════════════════════════════════════
// 解析（单独拆出来是为了能单测）
// ════════════════════════════════════════════════════════════

export type NowPlaying = {
  /** 来源程序的 AUMID，例如 `cloudmusic.exe` */
  app: string
  title: string
  artist: string
}

export function parseWatchLine(line: string): NowPlaying | null | undefined {
  let o: { active?: boolean; app?: unknown; title?: unknown; artist?: unknown }
  try {
    o = JSON.parse(line)
  } catch {
    return undefined // 半行、或者混进来的警告 —— 忽略，别清状态
  }
  if (!o || typeof o !== 'object') return undefined

  // ⚠️ 字段是 `active`（有正在听的东西），**不是** `playing`（正在播放）。
  //    暂停时它也是 true ✓ —— 播放器还开着、歌还在，那"我在听这个"就没变 ✓
  //    只有会话消失（播放器被关了）脚本才报 false ✓
  if (o.active !== true) return null

  const title = typeof o.title === 'string' ? o.title.trim() : ''
  if (!title) return null

  return {
    app: typeof o.app === 'string' ? o.app : '',
    title,
    // 纯音乐没有歌手，空串是正常的
    artist: typeof o.artist === 'string' ? o.artist.trim() : '',
  }
}

export type NowPlayingGame = {
  /** 进程名，小写不带 .exe */
  exe: string
  /** 显示名，取自 GAMES 表 */
  name: string
}

export function parseGameLine(line: string): NowPlayingGame | null | undefined {
  let o: { exe?: unknown }
  try {
    o = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!o || typeof o !== 'object') return undefined
  if (o.exe === null) return null
  if (typeof o.exe !== 'string' || !o.exe) return undefined

  const exe = o.exe.trim().toLowerCase()

  // ⚠️ 顺序有讲究，而且不能用简单的 `a || b || c`：
  //    内置表里有些项的值是**空串**，意思是"这个进程要忽略"
  //    （比如英雄联盟的启动器后台进程）。用 `||` 的话空串会被跳过、
  //    落到共享表上，就又会显示出来了。
  if (exe in GAMES) {
    const builtin = GAMES[exe]
    if (!builtin) return null // 明确标了"忽略"
    // 本地自己报的 > 服务端共享的 > 内置的
    return { exe, name: customGames[exe] || sharedGames[exe] || builtin }
  }

  const name = customGames[exe] || sharedGames[exe]
  if (!name) return null
  return { exe, name }
}

// ════════════════════════════════════════════════════════════
// 两个实例
// ════════════════════════════════════════════════════════════

const musicWatcher = createWatcher('detect.ps1', parseWatchLine)
const gameWatcher = createWatcher('detect-game.ps1', parseGameLine, () => [
  // 内置 + 服务端共享 + 用户自己上报的，合成一个参数传下去
  [...watchList(), ...sharedWatchList(), ...customWatchList()].join(','),
])

// ── 音乐 ────────────────────────────────────────────────────
export const onNowPlaying = musicWatcher.on
export const getNowPlaying = musicWatcher.get
export const startMediaWatch = musicWatcher.start
export const stopMediaWatch = musicWatcher.stop

// ── 游戏 ────────────────────────────────────────────────────
export const onNowPlayingGame = gameWatcher.on
export const getNowPlayingGame = gameWatcher.get
export const startGameWatch = gameWatcher.start
export const stopGameWatch = gameWatcher.stop
