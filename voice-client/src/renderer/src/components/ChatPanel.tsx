import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatBytes, isImageMime, type ChatMessage, type FileRef } from '../lib/api'
import { blockWantsBubble, groupMessages } from '../lib/chatGroups'
import { CameraIcon, PaperclipIcon, SearchIcon, SmileIcon } from './icons'
import { Avatar } from './Avatar'
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
  onSend: (body: string, attachment: FileRef | null) => void
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
function formatStamp(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  // 只到分钟 —— 聊天的惯例，秒太啰嗦。要看精确时间可以悬停
  const time = d.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

  if (d.toDateString() === now.toDateString()) return time

  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  if (d.getFullYear() === now.getFullYear()) return `${md} ${time}`
  return `${d.getFullYear()}年${md} ${time}`
}

/** 悬停提示里给**完整**日期时间，把简写的歧义补掉 */
function fullStamp(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
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
function renderBody(text: string, onOpen: (url: string) => void): React.ReactNode[] {
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
        title={`${url}\n（点击用系统浏览器打开）`}
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
  onOpenLink,
  avatarOf,
}: Props) {
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
   * 不能删的人**直接不拦事件** —— 让浏览器该干嘛干嘛（选中文字之类），
   * 而不是弹一个只有"取消"的菜单。
   */
  const openMsgMenu = (e: React.MouseEvent, id: number) => {
    if (!onDeleteMessage) return
    e.preventDefault()
    e.stopPropagation()
    setMsgMenu({
      x: Math.max(4, Math.min(e.clientX, window.innerWidth - 160 - 8)),
      y: Math.max(4, Math.min(e.clientY, window.innerHeight - 60 - 8)),
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
    onSend(draft.trim(), pending)
    setDraft('')
    setPending(null)
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
      setUploadError('截图功能不可用（桌面接口没加载）')
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
      const file = new File([blob], `截图-${stamp}.png`, { type: 'image/png' })

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
            <span className="muted small">私聊</span>
            <div className="spacer" />
            <button
              className="ghost small-btn"
              onClick={onCloseDm}
              title="关闭私聊，回到频道"
            >
              ✕ 关闭
            </button>
          </>
        ) : (
          <>
            <span className="channel-hash">#</span>
            <strong>{channelName || '未选择频道'}</strong>
          </>
        )}

        {!dmPeer && <div className="spacer" />}

        {/* 搜索入口放在**最右边** —— 标题栏左边是身份信息，
            操作类的东西统一靠右，和别的界面一致 */}
        {!dmPeer && (
          <button
            className={`ghost small-btn ${searchOpen ? 'active' : ''}`}
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            disabled={!channelName}
            title="搜索聊天记录（关键词，或只看某个人说的）"
          >
            <SearchIcon />
          </button>
        )}
      </div>

      {/* ── 搜索栏 ─────────────────────────────────────
          关键词和"只看某人"可以一起用：两个都填就是
          "某人说的、且包含这个词" */}
      {searchOpen && (
        <div className="chat-search">
          <input
            autoFocus
            value={searchQ}
            placeholder="搜关键词…"
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch()
              if (e.key === 'Escape') closeSearch()
            }}
          />
          <select
            value={searchAuthor}
            onChange={(e) => setSearchAuthor(e.target.value)}
            title="只看某个人的发言"
          >
            <option value="">所有人</option>
            {searchAuthors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button className="small-btn" onClick={() => void runSearch()} disabled={searchBusy}>
            {searchBusy ? '搜索中…' : '搜索'}
          </button>
          <button className="ghost small-btn" onClick={closeSearch} title="退出搜索（Esc）">
            ✕
          </button>
        </div>
      )}

      {searching && (
        <div className="chat-search-hint">
          搜索结果 {messages.length} 条
          <button className="ghost tiny" onClick={closeSearch}>
            返回聊天
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
                ? '没有匹配的消息。换个词试试，或者点右上角的 ✕ 退出搜索。'
                : dmPeer
                  ? `还没有和 ${dmPeer.name} 的聊天记录。说点什么吧。`
                  : '还没有消息。说点什么吧。'}
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
                  <span className="chat-time" title={fullStamp(block.createdAt)}>
                    {formatStamp(block.createdAt)}
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
                    {/* 允许"只有附件没有文字"的消息 */}
                    {m.body && <div className="chat-body">{renderBody(m.body, onOpenLink)}</div>}

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
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

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
            <button className="ghost tiny" onClick={() => setPending(null)} title="移除附件">
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
                  ? '加一句说明（可留空直接发）'
                  : dmPeer
                    ? `发消息给 ${dmPeer.name}`
                    : `发消息到 #${channelName}`
                : '未连接到服务端'
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
                className={`ghost icon-btn ${emojiOpen ? 'active' : ''}`}
                disabled={!connected}
                title="表情"
                onClick={() => setEmojiOpen((v) => !v)}
              >
                <SmileIcon />
              </button>
              {emojiOpen && (
                <EmojiPicker onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />
              )}
            </div>

            <button
              className={`ghost icon-btn ${shooting ? 'busy' : ''}`}
              disabled={!connected || shooting}
              title="截图（框选区域后自动作为附件，同时复制到剪贴板）"
              onClick={() => void takeScreenshot()}
            >
              <CameraIcon />
            </button>

            <button
              className={`ghost icon-btn ${uploading ? 'busy' : ''}`}
              disabled={!connected || uploading}
              title="发送图片或文件"
              onClick={() => fileInputRef.current?.click()}
            >
              <PaperclipIcon />
            </button>

            <button className="composer-send" onClick={submit} disabled={!canSend}>
              发送
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
          <button
            className="context-menu-item danger"
            onClick={() => {
              const { id } = msgMenu
              setMsgMenu(null)
              onDeleteMessage?.(id)
            }}
          >
            删除消息
          </button>
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

  if (isImageMime(file.mime)) {
    if (broken) {
      return <p className="muted small">🖼 {file.name}（已被删除）</p>
    }
    return (
      <button className="chat-image" onClick={onView} title="点击在应用内查看大图">
        <img src={href} alt={file.name} loading="lazy" onError={() => setBroken(true)} />
      </button>
    )
  }

  return (
    <button className="chat-file" onClick={onOpen} title="点击下载">
      <span className="chat-file-icon">📄</span>
      <span className="chat-file-text">
        <span className="chat-file-name" title={file.name}>
          {file.name}
        </span>
        <span className="muted small">{formatBytes(file.size)}</span>
      </span>
      <span className="chat-file-action">下载</span>
    </button>
  )
}
