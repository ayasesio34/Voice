import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatBytes, isImageMime, type ChatMessage, type FileRef } from '../lib/api'
import { blockWantsBubble, groupMessages } from '../lib/chatGroups'
import { CameraIcon, HashIcon, PaperclipIcon, PinIcon, SearchIcon, SmileIcon } from './icons'
import { Avatar } from './Avatar'
import { useT, useLang, type Lang, type TFn } from '../lib/i18n'
import { EmojiPicker } from './EmojiPicker'
import { ImageViewer } from './ImageViewer'

type Props = {
  channelName: string
  /**
   * 非空表示现在开的是**私聊**页。
   * 私聊和频道共用这一个组件 —— 消息、附件、截图那一整套逻辑完全一样，
   * 区别只在标题栏和输入框的提示文字。
   */
  dmPeer?: { name: string } | null
  /** 关闭私聊页，回到频道 */
  onCloseDm?: () => void
  messages: ChatMessage[]
  connected: boolean
  /** 由文件 id 拼出预览/下载地址 */
  fileHref: (id: string) => string
  /** 发消息。attachment 是已经上传好的文件，可以是 null */
  onSend: (body: string, attachment: FileRef | null, replyTo?: number | null) => void
  /** 上传文件。失败时抛异常，异常信息显示在输入框上方 */
  onUpload: (file: File) => Promise<FileRef>
  /** 用系统程序打开（下载非图片附件、或看大图） */
  onOpenFile: (id: string) => void
  /**
   * 搜索聊天记录。返回匹配的消息。
   *
   * 搜索在**服务端**做 —— 客户端只加载了最近 50 条，
   * 在本地过滤的话"搜索聊天记录"实际只能搜到最后几页，很误导。
   */
  onSearch: (opts: { q?: string; authorId?: string }) => Promise<ChatMessage[]>
  /** 退出搜索结果，回到正常历史 */
  onClearSearch: () => void
  /** 当前是不是在显示搜索结果 */
  searching: boolean
  /** 可以筛选的人（从已加载的历史里归纳出来） */
  searchAuthors: { id: string; name: string }[]
  /**
   * 删一条消息。**不传 = 不能删**（普通成员）。
   *
   * 权限判断在服务端做，这里只决定"要不要给出这个入口"——
   * 让每个人都能点、点了再被拒，体验更差。
   */
  onDeleteMessage?: (id: number) => void
  /**
   * 正在回复的那条消息。`null` = 没在回复 ✓
   *
   * ⚠️ 传的是**整条消息**不是 id ✗
   *    因为输入框上方那条提示要显示"回复 某某：原文" ✓
   *    只给 id 的话还得再回头去列表里找一次 ✓
   */
  replyTo?: ChatMessage | null
  /** 右键菜单点了「回复」 */
  onReply?: (m: ChatMessage) => void
  /** 取消回复（点输入框上方提示条里那个 × ✓） */
  onCancelReply?: () => void
  /**
   * 我自己的 userId。
   *
   * ⚠️ 表态芯片要判断"**我点过没有**" ✗
   *    服务端下发的是 `users: [{id,name}]` ✓ 只给事实 ✓
   *    不做成可选的（`?? ''`）是因为：为空时所有芯片都显示成"没点过" ✓
   *    那是一种**看起来正常、其实全错**的状态 ✓ 不如让类型强制传 ✓
   */
  myUserId: string
  /**
   * 给某条消息加/取消一个 emoji 表态。
   *
   * 不传就不显示任何表态入口 ✓（和 `onDeleteMessage` 一个套路 ✓）
   */
  onReact?: (messageId: number, emoji: string) => void
  /**
   * 置顶 / 取消置顶某条消息（同一个回调管两个方向 ✓ 服务端是 toggle ✓）
   */
  onPin?: (messageId: number) => void
  /**
   * 打开置顶面板时调它去**拉列表** ✗
   *
   * ⚠️ 为什么列表不由 ChatPanel 自己拉 ✗
   *    因为服务端广播 `pinned` 的时候，App 那边也要能顺手刷新它 ✓
   *    列表状态放在 App 里，两边才看得到同一份 ✓
   *    ChatPanel 只负责"开没开"这个纯界面状态 ✓
   */
  onLoadPinned?: () => void
  /** 置顶消息列表（App 拉的 ✓ 顺序是服务端排好的：按置顶时间倒序 ✓） */
  pinned?: ChatMessage[]
  /**
   * 置顶状态变化的**计数器**。App 每收到一次 `pinned` 广播就 +1 ✓
   *
   * ⚠️ 为什么不直接传回调进来在事件里调 ✗
   *    因为"面板开着没有"这个状态在 ChatPanel 里 ✓ App 看不到 ✓
   *    App 只知道"置顶状态变了" ✓ 该不该刷新得由面板自己决定 ✓
   *    所以用一个会变的数字当信号 ✓ 面板开着才响应 ✓
   */
  pinnedTick?: number
  /**
   * 用**系统浏览器**打开一个链接。
   *
   * 不在应用里开 —— 这是个聊天软件，链接该交给浏览器。
   * （和"点图片不该跳浏览器"是同一个道理的**反面**：图片是我们自己的内容，
   *   该在应用里看；外链不是，交给浏览器。） */
  onOpenLink: (url: string) => void
  /**
   * 按 userId 取头像（序列化后的字符串，喂给 `<Avatar raw=…>`）。
   *
   * 消息里只有作者的 id 和名字 ✓ 没有头像 ✗ —— 头像是**成员**的属性 ✓
   * 所以由外面（知道成员名单的那层）提供一个查询函数 ✓
   * 查不到就返回空串 ✓ Avatar 会退回到"名字首字母" ✓
   */
  avatarOf: (userId: string) => string
}

/**
 * 消息时间戳。**按"离现在多远"决定要不要带日期**：
 *
 *     当天        →  14:32
 *     今年内      →  3月5日 14:32
 *     更早        →  2025年3月5日 14:32
 *
 * 为什么不全带日期：绝大多数消息都是当天发的，每条都挂个"2026年10月7日"
 * 只会把界面塞满噪声。
 *
 * 为什么当天之外**必须**带：聊天记录往往横跨好几天，
 * 只显示时间的话，"今天说的"和"上周说的"在界面上长得一模一样。
 */
function formatStamp(ts: number, t: TFn, lang: Lang): string {
  const d = new Date(ts)
  const now = new Date()
  // 只到分钟 —— 聊天的惯例，秒太啰嗦。要看精确时间可以悬停
  //
  // ⚠️ 区域不能再写死 `'zh-CN'` ✗
  //    之前是写死的 ✓ 于是切到英文之后时间还是中文格式 ✓
  //    （中文是 `2026/10/14` ✓ 英文该是 `10/14/2026` ✗）
  //    现在用当前语言 ✓ 跟着界面一起变 ✓
  const time = d.toLocaleTimeString(lang, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

  if (d.toDateString() === now.toDateString()) return time

  const md = t('chat.dateMd', { m: d.getMonth() + 1, d: d.getDate() })
  if (d.getFullYear() === now.getFullYear()) return `${md} ${time}`
  return t('chat.dateFull', { y: d.getFullYear(), md, time })
}

/** 悬停提示里给**完整**日期时间，把简写的歧义补掉 */
function fullStamp(ts: number, lang: Lang): string {
  return new Date(ts).toLocaleString(lang, { hour12: false })
}

/**
 * 消息正文里的链接。
 *
 * ⚠️ **只认 http / https**。别的协议（`javascript:`、`file:`、`data:`…）
 *    一概不当链接 —— 它们能借"点一下打开"干坏事。
 *    主进程的 `openExternal` 也会再拦一道，两层都要有。
 *
 * ⚠️ 字符集里**排除了中日韩文字和全角标点**。
 *    只写 `[^\s]+` 的话，「看这个 https://a.com/1，再看别的」会把
 *    `https://a.com/1，再看` 整个吞进去 —— 中文标点后面**没有空格**，
 *    靠"trim 结尾标点"根本救不回来（要吐回去的东西在中间）。
 *    URL 里出现裸中文本来就极罕见（IDN 在传输里是 punycode），
 *    所以宁可在这里收窄。
 */
const URL_RE = /https?:\/\/[^\s<>"'\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g

/**
 * 结尾的标点要吐回去。
 *
 * 「看这个 https://a.com/x。」—— `[^\s]+` 会把句号一起吞掉，
 * 于是链接变成 `https://a.com/x。`，点开就是 404。
 * 中文里标点紧贴链接太常见了，必须处理。
 *
 * ⚠️ ASCII 的 `)` **不 trim** —— 维基百科那类链接自带括号
 *    （`.../wiki/Foo_(bar)`），trim 掉反而打不开。
 *    全角的 `）` 是我们这边的标点，可以放心去掉。
 */
const TRAILING_PUNCT = /[.,;:!?，。；：！？）】》…、]+$/

/** 把一段纯文本切成「文本 / 链接 / 文本」的片段 */
function renderBody(
  text: string,
  onOpen: (url: string) => void,
  /**
   * ⚠️ `t` 要**当参数传进来** ✗
   *    这是个普通函数、不是组件 ✓ 用不了 hook ✓
   *    （和上面那两个时间格式化函数同一个道理 ✓）
   */
  t: TFn
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0

  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0
    if (start > last) out.push(text.slice(last, start))

    const raw = m[0]
    const url = raw.replace(TRAILING_PUNCT, '')
    const tail = raw.slice(url.length)

    out.push(
      <a
        key={`${start}-${url}`}
        className="chat-link"
        href={url}
        title={`${url}\n` + t('chat.openInBrowser')}
        onClick={(e) => {
          // 拦下来 —— 不然 Electron 会在**应用窗口里**导航过去，
          // 聊天界面就没了（这正是"点图片跳浏览器"那次的同类问题）
          e.preventDefault()
          onOpen(url)
        }}
      >
        {url}
      </a>
    )
    if (tail) out.push(tail)
    last = start + raw.length
  }

  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * dataURL → Blob。**自己解 base64，不要用 `fetch`。**
 *
 * ⚠️⚠️ 这里踩过一个很难查的坑：
 *
 *   最顺手的写法是
 *       const blob = await (await fetch(dataUrl)).blob()
 *   但 `fetch` 一个 `data:` URL 走的是 **`connect-src`** 这条 CSP 规则，
 *   而 index.html 的 CSP 里 `connect-src` 只放开了 `'self' http: https: ws: wss:`
 *   —— **没有 `data:`**。
 *
 *   结果就是被 CSP 直接挡掉，抛出来的是：
 *       TypeError: Failed to fetch
 *
 *   **这个错误信息完全看不出跟 CSP 有关系** —— 看起来就像网络挂了、
 *   或者服务器没起来，于是往那个方向查了半天。
 *
 *   （`img-src` 里那个 `data:` 只管 `<img>` 标签，**管不到 fetch**。
 *     两个指令长得像，很容易以为放开了就没事。）
 *
 * 自己解 base64 是纯计算，不经过网络栈，也就没有 CSP 什么事。
 */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  const head = comma >= 0 ? dataUrl.slice(0, comma) : ''
  const body = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl

  const mime = /^data:([^;,]+)/.exec(head)?.[1] || 'application/octet-stream'

  // 非 base64 的 dataURL（`data:text/plain,hello` 这种）直接当文本
  if (!/;base64/i.test(head)) {
    return new Blob([decodeURIComponent(body)], { type: mime })
  }

  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

export function ChatPanel({
  channelName,
  dmPeer,
  onCloseDm,
  messages,
  connected,
  fileHref,
  onSend,
  onUpload,
  onOpenFile,
  onSearch,
  onClearSearch,
  searching,
  searchAuthors,
  onDeleteMessage,
  replyTo,
  onReply,
  onCancelReply,
  myUserId,
  onReact,
  onPin,
  onLoadPinned,
  pinned = [],
  pinnedTick = 0,
  onOpenLink,
  avatarOf,
}: Props) {
  /** 界面文案 ✓ 语言一变这个组件自动重渲染 ✓ */
  const t = useT()
  const lang = useLang()

  const [draft, setDraft] = useState('')
  /** 已经传上服务器、还没发出去的那个附件 */
  const [pending, setPending] = useState<FileRef | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  /** 正在框选截图。这期间主窗口是隐藏的，回来之前不该再触发别的操作 */
  const [shooting, setShooting] = useState(false)

  /**
   * 正在**在应用内**看的那张图。null = 没在看。
   *
   * 之前点图片是丢给系统浏览器的 —— 看个截图还要切窗口、关标签页，
   * 想存下来还得在浏览器里再操作一次。这是个聊天软件，图片就该在这儿看。
   */
  const [viewing, setViewing] = useState<{ href: string; name: string } | null>(null)

  /**
   * 按「同一个人连续发的几条」分组 ✓
   *
   * 分组的规则和边界（时间窗口、别人插话）都在 `lib/chatGroups.ts` 里，
   * 有单测钉着 ✓ —— 那玩意儿错了的表现是"两句风马牛不相及的话被塞进一个框" ✗
   * 很难一眼看出来 ✓
   */
  const blocks = useMemo(() => groupMessages(messages), [messages])

  // ── 搜索聊天记录 ─────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [searchAuthor, setSearchAuthor] = useState('')
  /** 搜索中（转圈用）。搜索本身很快，但网络慢时得让用户知道在跑 */
  const [searchBusy, setSearchBusy] = useState(false)

  const runSearch = useCallback(async () => {
    const q = searchQ.trim()
    const authorId = searchAuthor
    if (!q && !authorId) {
      // 什么都没填 = 没在搜，回到正常历史
      onClearSearch()
      return
    }
    setSearchBusy(true)
    try {
      await onSearch({ q, authorId })
    } finally {
      setSearchBusy(false)
    }
  }, [searchQ, searchAuthor, onSearch, onClearSearch])

  /** 关掉搜索面板，并且**退出搜索结果**回到正常历史 */
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQ('')
    setSearchAuthor('')
    onClearSearch()
  }, [onClearSearch])

  const listRef = useRef<HTMLDivElement>(null)
  /** 消息的实际内容容器。列表高度变化要观察它 —— 滚动容器本身的高度是固定的 */
  const innerRef = useRef<HTMLDivElement>(null)
  /** 消息输入框。表情要**插在光标处**，所以得拿得到它和它的选区 */
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /**
   * 输入框随内容长高。
   *
   * 基准是 `rows={3}`（三行），内容超过三行才继续长，上限见 CSS 的 max-height。
   * 换句话说：`height: auto` 会退回 rows 定下的三行 —— 这正是我们要的下限，
   * 所以"删到只剩一行也保持三行高"不用额外写代码。
   *
   * 为什么必须先设成 auto：不重置的话 scrollHeight 只增不减，
   * 删字之后高度回不去。
   */
  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  // 发出去之后把高度收回来。这里靠 draft 变空来触发 ——
  // onChange 里拿不到"发送后"那一刻（那时 value 还是旧的）
  useEffect(() => {
    if (draft === '' && draftRef.current) draftRef.current.style.height = 'auto'
  }, [draft])

  const [emojiOpen, setEmojiOpen] = useState(false)
  /**
   * 正在给**哪一条消息**挑表态表情。`null` = 没在挑 ✓
   *
   * ⚠️ 它和 `emojiOpen` **互斥** ✗
   *    两个都复用同一个 `.emoji-wrap` 容器（定位是现成的 ✓ 不想再调一遍 ✗）
   *    同时开着的话两个选择器会**叠在一起** ✓ 点哪个都乱 ✓
   *    所以开一个必须先关另一个 ✓ 见下面那几个 onClick ✓
   */
  const [reactFor, setReactFor] = useState<number | null>(null)
  /**
   * 置顶面板开没开。
   *
   * ⚠️ 它和搜索栏**互斥** ✗
   *    两个都贴着标题栏下面展开 ✓ 同时开着会挤在一起 ✓
   *    所以开一个必须关另一个 ✓ 见下面两个 onClick ✓
   */
  const [pinnedOpen, setPinnedOpen] = useState(false)

  /**
   * 把 `onLoadPinned` 装进 ref ✓
   *
   * ⚠️ 不能直接把它写进下面那个 effect 的依赖数组 ✗
   *    App 每次渲染都会传一个**新的函数实例** ✓
   *    放进依赖里 effect 就会每次都跑 ✓ 而它里面又会 setState ✓
   *    → **无限循环** ✓
   *    用 ref 就没有这个问题：effect 只认 `pinnedOpen` 和 `pinnedTick` ✓
   */
  const loadPinnedRef = useRef(onLoadPinned)
  loadPinnedRef.current = onLoadPinned

  useEffect(() => {
    // 打开时拉一次 ✓ 开着的时候别人改了置顶也重拉 ✓ 关着就什么都不做 ✓
    if (pinnedOpen) loadPinnedRef.current?.()
  }, [pinnedOpen, pinnedTick])

  /**
   * 消息的右键菜单。只有能删的人（管理员以上）才可能被打开 ——
   * 普通成员右键不会有任何反应，而不是弹一个点不动的菜单。
   */
  const [msgMenu, setMsgMenu] = useState<{ x: number; y: number; id: number } | null>(null)

  useEffect(() => {
    if (!msgMenu) return
    const close = () => setMsgMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMsgMenu(null)
    }
    // 和别处的菜单一个套路：冒泡阶段关，菜单自己 stopPropagation
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [msgMenu])

  /**
   * 右键一条消息。
   *
   * ⚠️ 这里的早退条件改过 ✗
   *    原来写的是「不能删的人直接不拦」✓ 因为菜单里**只有删除** ✓
   *    现在菜单里加了「回复」✓ 而**所有人都该能回复** ✓
   *    继续用 `!onDeleteMessage` 早退的话，普通成员右键**什么都不会弹** ✗
   *    所以改成"两个能力都没有才早退" ✓
   */
  const openMsgMenu = (e: React.MouseEvent, id: number) => {
    if (!onDeleteMessage && !onReply && !onReact && !onPin) return
    e.preventDefault()
    e.stopPropagation()
    setMsgMenu({
      x: Math.max(4, Math.min(e.clientX, window.innerWidth - 160 - 8)),
      // 菜单高度按**四项**算 ✓ 每项约 38px ✓ 留点余量 ✓
      // ⚠️ 每加一项都要跟着改这个数 ✗ 不改的话贴底部的消息菜单会超出屏幕 ✓
      y: Math.max(4, Math.min(e.clientY, window.innerHeight - 160 - 8)),
      id,
    })
  }

  /**
   * 把表情插到**光标位置**，而不是无脑追加到末尾。
   *
   * 追加看着简单，但用起来很别扭：你想在句子中间补个表情，
   * 结果它跑到最后去了，还得手动剪贴。
   */
  const insertEmoji = (ch: string) => {
    const el = draftRef.current
    if (!el) {
      setDraft((d) => d + ch)
      return
    }
    const start = el.selectionStart ?? draft.length
    const end = el.selectionEnd ?? start
    setDraft(draft.slice(0, start) + ch + draft.slice(end))

    // 光标移到刚插入的表情之后 —— 连点几个表情要能按顺序接上。
    // 等一帧：setDraft 之后 React 才把新的 value 写进 DOM，
    // 立刻 setSelectionRange 会被随后的重渲染重置掉。
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + ch.length
      el.setSelectionRange(pos, pos)
    })
  }

  /**
   * 用户是不是贴着底部。
   *
   * 往上翻看历史时置 false —— 这时候**不能**把他拽回底部，
   * 不然来一条新消息、或者下面有张图加载出来，正在看的记录就跑了。
   */
  const stickRef = useRef(true)

  /** 上一次渲染的第一条消息 id。变了说明**换会话了**，要无条件回到底部 */
  const firstIdRef = useRef<number | null>(null)

  const scrollToBottom = useCallback(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stickRef.current = true
  }, [])

  /**
   * ⚠️ 修的是这个 bug：**每次打开软件都停在聊天框最上面**。
   *
   * 原因不在"没滚"，而在"滚的时间不对"：
   *
   *   图片是一个一个加载的。设置 scrollTop 的那一刻，
   *   还没加载出来的图片高度是 0；等它们陆续加载完，
   *   内容被顶高几百上千像素 —— 而滚动位置**不会跟着走**。
   *
   *   所以只在"消息条数变化"时滚一次是不够的，
   *   人会停在半路（图多的时候看起来就像在最上面）。
   *
   * 修法：用 ResizeObserver 盯着**内容高度**，只要还贴着底就跟着往下走。
   * 图片加载、字体切换、窗口变窄导致换行 —— 全都覆盖到了。
   */
  useEffect(() => {
    const inner = innerRef.current
    const el = listRef.current
    if (!inner || !el) return

    const pin = () => {
      if (!stickRef.current) return
      el.scrollTop = el.scrollHeight
    }

    const ro = new ResizeObserver(pin)
    ro.observe(inner)

    // ⚠️ **两个都要观察**，少一个就会出问题：
    //
    //   inner —— 内容变高（图片加载出来、换行变多）
    //   el    —— **容器本身变矮**（打开投屏时画面占掉了上半屏）
    //
    // 只观察 inner 的话，第二种情况完全不触发：
    // scrollTop 是个**像素值**，容器一变矮，同样的 scrollTop
    // 对应的位置就跑到中间去了 —— 看起来就是"聊天框自己跳到了中间"。
    ro.observe(el)

    return () => ro.disconnect()
  }, [])

  // 来新消息：贴底就跟下去，翻着历史就不打扰
  useEffect(() => {
    const firstId = messages[0]?.id ?? null

    // 换会话（或者刚打开、历史刚拉回来）→ 无条件回到底部
    if (firstIdRef.current !== firstId) {
      firstIdRef.current = firstId
      scrollToBottom()
      return
    }

    if (stickRef.current) scrollToBottom()
  }, [messages, scrollToBottom])

  const onListScroll = useCallback(() => {
    const el = listRef.current
    if (!el) return
    // 留 40px 容差：贴得够近就算"在底部"，不然一点点抖动就解除跟随了
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

  const canSend =
    connected && !uploading && !shooting && (Boolean(draft.trim()) || Boolean(pending))

  const submit = () => {
    if (!canSend) return
    // 把正在回复的那条一起带上 ✓ 服务端会校验它确实属于这个频道 ✗
    onSend(draft.trim(), pending, replyTo?.id ?? null)
    setDraft('')
    setPending(null)
    // 发完就退出回复态 ✓ 不然下一条也会跟着引用（很容易没注意到 ✗）
    onCancelReply?.()
  }

  const pickFile = async (file: File | undefined) => {
    if (!file) return
    setUploading(true)
    setUploadError(null)
    try {
      // 选完立刻上传，但**不自动发送** —— 让人有机会补一句说明，
      // 或者发现选错了直接点 × 移除
      setPending(await onUpload(file))
    } catch (err) {
      setUploadError((err as Error).message)
    } finally {
      setUploading(false)
    }
  }

  /**
   * 截图。
   *
   * 主进程会先藏起窗口、给每块屏幕盖一层浮层让你框选，然后把裁好的 PNG 交回来。
   * 拿到之后**走和 📎 完全一样的路径**：当文件上传 → 变成待发附件。
   * 所以截图不会绕过任何一条已有逻辑（大小限制、权限、广播都一样）。
   */
  const takeScreenshot = async () => {
    const api = window.desktop
    if (!api?.captureRegion) {
      setUploadError(t('chat.screenshotUnavailable'))
      return
    }

    setShooting(true)
    setUploadError(null)
    try {
      const shot = await api.captureRegion()
      if (!shot) return // 用户取消了

      // dataURL -> Blob -> File，然后复用上传流程。
      // 注意是**自己解 base64**，不是 fetch(dataUrl) —— 原因见 dataUrlToBlob 的说明
      const blob = dataUrlToBlob(shot.dataUrl)
      const stamp = new Date()
        .toLocaleString('zh-CN', { hour12: false })
        .replace(/[^\d]/g, '')
      const file = new File([blob], t('chat.screenshotName', { stamp }), { type: 'image/png' })

      setPending(await onUpload(file))
    } catch (err) {
      setUploadError((err as Error).message)
    } finally {
      setShooting(false)
    }
  }

  return (
    <div className="chat-panel">
      {/* 这里刻意只留频道名。
          连接状态挪到了左上角服务器名字下面，设置按钮统一放在底部状态条 ——
          同一个功能在两个地方出现会让人犹豫点哪个。 */}
      <div className="chat-header">
        {dmPeer ? (
          <>
            <span className="channel-hash">@</span>
            <strong>{dmPeer.name}</strong>
            <span className="muted small">{t('chat.dmTag')}</span>
            <div className="spacer" />
            <button
              className="ghost small-btn"
              onClick={onCloseDm}
              title={t('chat.closeDm')}
            >
              ✕ {t('chat.close')}
            </button>
          </>
        ) : (
          <>
            <span className="channel-hash">
              <HashIcon size={16} />
            </span>
            <strong>{channelName || t('chat.noChannel')}</strong>
          </>
        )}

        {!dmPeer && <div className="spacer" />}

        {/* 置顶入口。放在放大镜**左边** ✓
            搜索和置顶是同一类"对当前会话的操作" ✓ 所以并排放在最右 ✓
            而图钉在左、放大镜在右 —— 这是明确要求的位置 ✓ */}
        {!dmPeer && (
          <button
            className={`ghost small-btn ${pinnedOpen ? 'active' : ''}`}
            onClick={() => {
              // 和搜索栏互斥 ✗ 同时开会挤在一起 ✓
              setSearchOpen(false)
              // 拉列表交给上面那个 effect ✓ 它盯着 pinnedOpen ✓
              setPinnedOpen((v) => !v)
            }}
            disabled={!channelName}
            title={t('chat.pinnedHeader') + (pinned.length ? t('chat.pinBadge', { n: pinned.length }) : '')}
          >
            <PinIcon />
          </button>
        )}

        {/* 搜索入口放在**最右边** —— 标题栏左边是身份信息，
            操作类的东西统一靠右，和别的界面一致 */}
        {!dmPeer && (
          <button
            className={`ghost small-btn ${searchOpen ? 'active' : ''}`}
            onClick={() => {
              // 同上，和置顶面板互斥 ✗
              setPinnedOpen(false)
              if (searchOpen) closeSearch()
              else setSearchOpen(true)
            }}
            disabled={!channelName}
            title={t('chat.searchTitle')}
          >
            <SearchIcon />
          </button>
        )}
      </div>

      {/* ── 置顶消息面板 ───────────────────────────────
          ⚠️ 列表**必须从服务端拉** ✗ 不能在已加载的消息里筛 ✓
             置顶的往往是很久以前那条重要消息 ✓
             而客户端只有最近 50 条 ✓ 本地筛会显示成空的 ✗ */}
      {pinnedOpen && (
        <div className="chat-pinned">
          <div className="chat-pinned-head">
            <PinIcon size={14} />
            <span>{t('chat.pinnedHeader')}</span>
            {pinned.length > 0 && <span className="muted small">{pinned.length} / 50</span>}
            <div className="spacer" />
            <button
              className="ghost small-btn"
              onClick={() => setPinnedOpen(false)}
              title={t('chat.collapse')}
            >
              ✕
            </button>
          </div>

          {pinned.length === 0 ? (
            <div className="chat-pinned-empty">
              {t('chat.noPins')}
            </div>
          ) : (
            <div className="chat-pinned-list">
              {pinned.map((m) => (
                <div className="pinned-item" key={m.id}>
                  <div className="pinned-meta">
                    <strong>{m.author_name}</strong>
                    <span className="chat-time">
                      {formatStamp(m.pinned_at ?? m.created_at, t, lang)}
                    </span>
                    {m.pinned_by && (
                      <span className="muted small">{t('chat.pinnedBy', { name: m.pinned_by })}</span>
                    )}
                  </div>
                  {/* 引用块也一并显示 ✓ 不然置顶列表里的消息和聊天里长得不一样 ✗ */}
                  {m.reply_preview && (
                    <div className="chat-quote">
                      <span className="chat-quote-author">{m.reply_preview.author_name}</span>
                      <span className="chat-quote-text">{m.reply_preview.body}</span>
                    </div>
                  )}
                  <div className="pinned-body">{m.body || t('chat.attachment')}</div>
                  {onPin && (
                    <button
                      className="ghost small-btn pinned-unpin"
                      onClick={() => onPin(m.id)}
                      title={t('chat.unpin')}
                    >
                      {t('chat.unpin')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── 搜索栏 ─────────────────────────────────────
          关键词和"只看某人"可以一起用：两个都填就是
          "某人说的、且包含这个词" */}
      {searchOpen && (
        <div className="chat-search">
          <input
            autoFocus
            value={searchQ}
            placeholder={t('chat.searchPlaceholder')}
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch()
              if (e.key === 'Escape') closeSearch()
            }}
          />
          <select
            value={searchAuthor}
            onChange={(e) => setSearchAuthor(e.target.value)}
            title={t('chat.filterByAuthor')}
          >
            <option value="">{t('chat.everyone')}</option>
            {searchAuthors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button className="small-btn" onClick={() => void runSearch()} disabled={searchBusy}>
            {searchBusy ? t('chat.searching') : t('chat.searchAction')}
          </button>
          <button className="ghost small-btn" onClick={closeSearch} title={t('chat.exitSearch')}>
            ✕
          </button>
        </div>
      )}

      {searching && (
        <div className="chat-search-hint">
          {t('chat.searchResults', { n: messages.length })}
          <button className="ghost tiny" onClick={closeSearch}>
            {t('chat.backToChat')}
          </button>
        </div>
      )}

      <div className="chat-messages" ref={listRef} onScroll={onListScroll}>
        {/* 外面这层是滚动容器，里面这层才是"内容"。
            分开是必须的：ResizeObserver 观察的是元素的**边框盒**，
            而滚动容器本身高度是固定的（flex: 1），观察它什么也看不到。
            真正会长高的是里面的内容 —— 图片加载、换行都算。 */}
        <div className="chat-messages-inner" ref={innerRef}>
          {messages.length === 0 && (
            <p className="muted" style={{ padding: 16 }}>
              {searching
                ? t('chat.noMatch')
                : dmPeer
                  ? t('chat.noDmHistory', { name: dmPeer.name })
                  : t('chat.noMessages')}
            </p>
          )}

          {blocks.map((block) => (
            <div className="chat-block" key={block.key}>
              {/* 头像只在这一块的**第一条**上 ✓ 下面的消息靠左对齐到内容列 ✓ */}
              <div className="chat-block-avatar">
                <Avatar
                  raw={avatarOf(block.authorId)}
                  name={block.authorName}
                  size={32}
                />
              </div>

              <div
                className={`chat-block-content${
                  blockWantsBubble(block) ? ' chat-block-bubble' : ''
                }`}
              >
                <div className="chat-meta">
                  <span className="chat-author">{block.authorName}</span>
                  <span className="chat-time" title={fullStamp(block.createdAt, lang)}>
                    {formatStamp(block.createdAt, t, lang)}
                  </span>
                </div>

                {block.items.map((m) => (
                  <div
                    className="chat-message"
                    key={m.id}
                    /* 右键删除**逐条**生效 —— 一个框里可能有几条，
                       点的哪条删哪条 ✓ 不能删的人这里直接不拦（见 openMsgMenu） */
                    onContextMenu={(e) => openMsgMenu(e, m.id)}
                  >
                    {/* ⚠️ 引用块必须在**气泡内部** ✗（这是明确要求 ✓）
                        而且底色要比气泡**更深** ✓ —— 见 styles.css 里 .chat-quote 的说明
                        靠左那道竖线表示"这是一段被引用的话" ✓ 和正文区分开 ✓ */}
                    {m.reply_to != null && (
                      <div className="chat-quote" title={t('chat.quotedMessage')}>
                        {m.reply_preview ? (
                          <>
                            <span className="chat-quote-author">
                              {m.reply_preview.author_name}
                            </span>
                            <span className="chat-quote-text">{m.reply_preview.body}</span>
                          </>
                        ) : (
                          /* reply_to 有值、摘要却是 null ✗ 两种可能：
                             原消息**被删了** ✓ 或者它**不属于这个频道**（服务端拒绝回填）✓
                             两种情况都显示同一句 ✓ 不区分 —— 区分了就等于告诉别人
                             "那个 id 上曾经有条消息" ✓ 那正是要避免泄露的 ✓ */
                          <span className="chat-quote-gone">{t('chat.originalGone')}</span>
                        )}
                      </div>
                    )}

                    {/* 允许"只有附件没有文字"的消息 */}
                    {m.body && <div className="chat-body">{renderBody(m.body, onOpenLink, t)}</div>}

                    {m.attachment && (
                      <Attachment
                        file={m.attachment}
                        href={fileHref(m.attachment.id)}
                        onOpen={() => onOpenFile(m.attachment!.id)}
                        // 图片**在应用里看**，不丢给浏览器。
                        // 非图片附件还是走 onOpenFile（下载/用系统程序打开）
                        onView={() =>
                          setViewing({
                            href: fileHref(m.attachment!.id),
                            name: m.attachment!.name,
                          })
                        }
                      />
                    )}

                    {/* emoji 表态。放在消息内容**下面** ✓ 和正文分开 ✓
                        ⚠️ `m.reactions` 可能是 undefined ✗
                           服务端是后加的这个字段 ✓ 老消息、以及还没重新拉过的
                           历史消息都没有它 ✓ 直接 .length 会炸 ✓
                        ⚠️ "我点过没有"是**客户端算的** ✗
                           服务端只给 `users`（带 id 和名字 ✓）
                           因为同一条广播发给所有人 ✓ 它算不出一个对所有人都对的 mine ✓ */}
                    {(m.pinned_at != null || (m.reactions ?? []).length > 0) && (
                      <div className="chat-reactions">
                        {/* 「已置顶」标记。
                            ⚠️ 放在**这一行**而不是消息头 ✗
                               因为消息头（.chat-meta）是**按消息块**渲染的 ✓
                               一个块里可能有好几条消息 ✓ 挂在头上会让人
                               以为整块都置顶了 ✓
                               这一行是**逐条**的 ✓ 位置才对 ✓ */}
                        {m.pinned_at != null && (
                          <span
                            className="pinned-mark"
                            title={m.pinned_by ? t('chat.pinnedBy', { name: m.pinned_by }) : t('chat.pinned')}
                          >
                            <PinIcon size={12} />
                            <span>{t('chat.pinned')}</span>
                          </span>
                        )}
                        {(m.reactions ?? []).map((r) => {
                          const mine = r.users.some((u) => u.id === myUserId)
                          return (
                            <button
                              key={r.emoji}
                              className={`reaction-chip${mine ? ' mine' : ''}`}
                              title={r.users.map((u) => u.name).join('、')}
                              disabled={!connected || !onReact}
                              onClick={() => onReact?.(m.id, r.emoji)}
                            >
                              <span className="reaction-emoji">{r.emoji}</span>
                              <span className="reaction-count">{r.users.length}</span>
                            </button>
                          )
                        })}
                        {onReact && (
                          <button
                            className="reaction-chip add"
                            title={t('chat.addReaction')}
                            onClick={() => {
                              setEmojiOpen(false)
                              setReactFor(m.id)
                            }}
                          >
                            ＋
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 表态提示条。和回复提示条**共用一套样式** ✓
          两者不同时出现 ✓ 而且视觉上都是"我现在要对某条消息做点什么" ✓
          语义一样就没必要再写一套 CSS ✗ */}
      {reactFor != null && (
        <div className="reply-banner">
          <span className="reply-banner-label">{t('chat.reactionLabel')}</span>
          <span className="reply-banner-name">
            {messages.find((m) => m.id === reactFor)?.author_name ?? ''}
          </span>
          <span className="reply-banner-text">
            {messages.find((m) => m.id === reactFor)?.body || t('chat.attachment')}
          </span>
          <button className="reply-banner-x" onClick={() => setReactFor(null)} title={t('chat.cancel')}>
            ×
          </button>
        </div>
      )}

      {/* 回复提示条，贴在输入框正上方 ✓
          ⚠️ 必须一眼看出"我现在处于回复态" ✗
             不然发出去才发现在引用别人的话 ✓ 很尴尬 ✓
             而且它会在发完 / 点 × 之后消失 ✓ 不会粘住下一条 ✓ */}
      {replyTo && (
        <div className="reply-banner">
          <span className="reply-banner-label">{t('chat.replyLabel')}</span>
          <span className="reply-banner-name">{replyTo.author_name}</span>
          <span className="reply-banner-text">{replyTo.body || t('chat.attachment')}</span>
          <button className="reply-banner-x" onClick={onCancelReply} title={t('chat.cancelReply')}>
            ×
          </button>
        </div>
      )}

      <div className="chat-input-area">
        <input
          ref={fileInputRef}
          type="file"
          hidden
          onChange={(e) => {
            void pickFile(e.target.files?.[0])
            // 清空，否则连续选同一个文件不会触发 change
            e.target.value = ''
          }}
        />

        {uploadError && <p className="error small chat-upload-error">{uploadError}</p>}

        {pending && (
          <div className="pending-attachment">
            <span className="pending-name" title={pending.name}>
              {isImageMime(pending.mime) ? '🖼' : '📄'} {pending.name}
            </span>
            <span className="muted small">{formatBytes(pending.size)}</span>
            <div className="spacer" />
            <button className="ghost tiny" onClick={() => setPending(null)} title={t('chat.removeAttachment')}>
              ×
            </button>
          </div>
        )}

        {/* 输入框是个"输入区"：文字在上，按钮在**里面**右下角。
            以前是 [输入框][按钮][按钮][发送] 横着排一行 ——
            输入框被挤得又矮又窄，写两句就得左右滚，
            而且按钮在外面看着像另一排控件。
            现在整块是一个盒子，按钮贴着右下角，视线也收在一个地方。 */}
        <div className="composer">
          <textarea
            ref={draftRef}
            className="composer-input"
            value={draft}
            /* 默认就**三行高**。
               一行的话写两句就得在里面滚；三行是"随手打一段话"的舒服尺寸，
               而且不会像五行那样白占聊天记录的地方。
               内容更多时再跟着长（见 autoGrow）。 */
            rows={3}
            placeholder={
              connected
                ? pending
                  ? t('chat.captionPlaceholder')
                  : dmPeer
                    ? t('chat.sendToDm', { name: dmPeer.name })
                    : t('chat.sendToChannel', { name: channelName })
                : t('chat.notConnected')
            }
            disabled={!connected}
            onChange={(e) => {
              setDraft(e.target.value)
              autoGrow(e.currentTarget)
            }}
            onKeyDown={(e) => {
              // Enter 发送，Shift+Enter 换行 —— 聊天的通用约定。
              // 用 textarea 之后这条**必须**显式处理，否则回车只会换行
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />

          <div className="composer-actions">
            {/* 图标用 SVG 而不是 emoji：emoji 的字形偏移由字体决定，
                📷 和 📎 怎么调都对不齐（详见 components/icons.tsx）。
                忙碌状态不改图标，只加个脉冲动画 —— 换字形又会破坏对齐。 */}
            <div className="emoji-wrap">
              <button
                className={`ghost icon-btn ${emojiOpen || reactFor != null ? 'active' : ''}`}
                disabled={!connected}
                title={reactFor != null ? t('chat.pickReactionEmoji') : t('chat.emoji')}
                onClick={() => {
                  // 表态模式开着的时候，这个按钮变成"取消" ✗
                  // 不然点它会再弹一个选择器、和正开着的那个叠在一起 ✓
                  if (reactFor != null) {
                    setReactFor(null)
                    return
                  }
                  setEmojiOpen((v) => !v)
                }}
              >
                <SmileIcon />
              </button>
              {emojiOpen && (
                <EmojiPicker onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />
              )}
              {/* 表态选择器。**故意复用同一个容器** ✗
                  定位是现成的 ✓ 再放一个地方就得重新调一遍偏移 ✓
                  代价是两者必须互斥 ✓ 见 reactFor 的说明 */}
              {reactFor != null && (
                <EmojiPicker
                  onPick={(e) => {
                    const id = reactFor
                    setReactFor(null)
                    onReact?.(id, e)
                  }}
                  onClose={() => setReactFor(null)}
                />
              )}
            </div>

            <button
              className={`ghost icon-btn ${shooting ? 'busy' : ''}`}
              disabled={!connected || shooting}
              title={t('chat.screenshotTip')}
              onClick={() => void takeScreenshot()}
            >
              <CameraIcon />
            </button>

            <button
              className={`ghost icon-btn ${uploading ? 'busy' : ''}`}
              disabled={!connected || uploading}
              title={t('chat.attachTip')}
              onClick={() => fileInputRef.current?.click()}
            >
              <PaperclipIcon />
            </button>

            <button className="composer-send" onClick={submit} disabled={!canSend}>
              {t('chat.send')}
            </button>
          </div>
        </div>
      </div>

      {/* 看图器放在最外层、position: fixed 盖住整个窗口 ——
          不管它是在频道聊天还是私聊里点开的，都该盖满屏 */}
      {viewing && (
        <ImageViewer src={viewing.href} name={viewing.name} onClose={() => setViewing(null)} />
      )}

      {/* 消息右键菜单。fixed 定位，放在滚动容器外面免得被裁掉 */}
      {msgMenu && (
        <div
          className="context-menu"
          style={{ left: msgMenu.x, top: msgMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* 「回复」在前、「删除」在后 ✓
              删除是危险操作 ✓ 放最后、还带红色 ✓ 免得手滑点到 ✓
              而且回复**所有人都能点** ✓ 删除只有能删的人才渲染出来 ✓ */}
          {onReply && (
            <button
              className="context-menu-item"
              onClick={() => {
                const { id } = msgMenu
                setMsgMenu(null)
                const target = messages.find((m) => m.id === id)
                if (target) onReply(target)
              }}
            >
              {t('chat.reply')}
            </button>
          )}
          {onReact && (
            <button
              className="context-menu-item"
              onClick={() => {
                const { id } = msgMenu
                setMsgMenu(null)
                // 开表态选择器前先把写消息那个关掉 ✗ 两个会叠在一起 ✓
                setEmojiOpen(false)
                setReactFor(id)
              }}
            >
              {t('chat.addReactionMenu')}
            </button>
          )}
          {onPin && (
            <button
              className="context-menu-item"
              onClick={() => {
                const { id } = msgMenu
                setMsgMenu(null)
                onPin(id)
              }}
            >
              {/* 标签跟着**当前状态**走 ✓
                  已经是置顶的就显示"取消置顶" ✓
                  不然用户点之前根本不知道会发生什么 ✗ */}
              {messages.find((m) => m.id === msgMenu.id)?.pinned_at
                ? t('chat.unpin')
                : t('chat.pin')}
            </button>
          )}
          {onDeleteMessage && (
            <button
              className="context-menu-item danger"
              onClick={() => {
                const { id } = msgMenu
                setMsgMenu(null)
                onDeleteMessage(id)
              }}
            >
              {t('chat.deleteMessage')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 消息里的附件。
 *
 * 图片直接内联显示 —— 聊天里发截图是最常见的用法，要能一眼看到。
 * 其他类型给一个卡片，点了用系统程序打开（浏览器会下载）。
 */
function Attachment({
  file,
  href,
  onOpen,
  onView,
}: {
  file: FileRef
  href: string
  onOpen: () => void
  /** 在应用内的看图器里打开（只有图片会用到） */
  onView: () => void
}) {
  // 文件被删掉之后，老消息里还留着引用 —— 别显示成一个破图标
  const [broken, setBroken] = useState(false)
  /** ⚠️ 子组件要**自己取一次** t ✗ 它不在主组件的作用域里 ✓ */
  const t = useT()

  if (isImageMime(file.mime)) {
    if (broken) {
      return <p className="muted small">🖼 {t('chat.fileGone', { name: file.name })}</p>
    }
    return (
      <button className="chat-image" onClick={onView} title={t('chat.viewLarge')}>
        <img src={href} alt={file.name} loading="lazy" onError={() => setBroken(true)} />
      </button>
    )
  }

  return (
    <button className="chat-file" onClick={onOpen} title={t('chat.downloadTip')}>
      <span className="chat-file-icon">📄</span>
      <span className="chat-file-text">
        <span className="chat-file-name" title={file.name}>
          {file.name}
        </span>
        <span className="muted small">{formatBytes(file.size)}</span>
      </span>
      <span className="chat-file-action">{t('chat.download')}</span>
    </button>
  )
}
