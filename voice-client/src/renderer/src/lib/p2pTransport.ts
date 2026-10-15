/**
 * 投屏的 P2P 直连传输。
 *
 * ── 为什么要有它 ✗ ──────────────────────────────────────────
 * 投屏现在全走 LiveKit（SFU）✓ 而 SFU 是"**收一份、发 N-1 份**" ✗
 * 服务器出口只有 6 Mbps ✓ 4 Mbps 一档就只够**一个人**看 ✓
 * 改成两端直连之后，画面**根本不经过服务器** ✓
 * 服务器只帮忙交换几百字节的 SDP / ICE ✓ 出口可以忽略 ✓
 *
 * ── 分工 ✓ ──────────────────────────────────────────────────
 *   信令        → api.ts 的 p2p() ✓ 服务端只转发不解析 ✓
 *   画面        → 本模块的 RTCPeerConnection ✓ 端到端加密（DTLS-SRTP）✓
 *   语音        → **继续走 LiveKit** ✗ 5 个人才 1 Mbps ✓ 不值得为它重做 ✓
 *   投屏的声音   → **也继续走 LiveKit** ✗ 它只有几十~一百多 kbps ✓
 *                  （只把画面搬走就够拿到全部收益 ✓ 少搬一路少一份风险 ✓）
 *
 * ── 兜底 ✓ ──────────────────────────────────────────────────
 * 打不通的时候**不是没救** ✗ —— 上层会在超时之后退回原来的 LiveKit 路径 ✓
 * 所以这里只负责如实报状态 ✓ 不自己做回退决策 ✓
 * （`hasFailed()` 就是给上层看的信号 ✓）
 *
 * ── 为什么 Viewer 要先说"我要看" ✗ ──────────────────────────
 * 分享端如果无脑给房间里每个人发 offer ✓
 * 那不想看的人也会被建一条连接 ✗ 白费对端的上行 ✓
 * 所以由观看端发 `want` ✓ 分享端才回 offer ✓
 */

/** 信令载荷。只有这几种，别的都当没看见 ✓ */
export type P2PSignal =
  | { t: 'want' }
  | { t: 'offer'; sdp: string }
  | { t: 'answer'; sdp: string }
  | { t: 'ice'; c: string; mid: string | null; mline: number }
  | { t: 'bye' }

export type P2PState = 'idle' | 'connecting' | 'connected' | 'failed'

/**
 * 默认 STUN 列表。
 *
 * ⚠️ 这几台是**实测可达**的 ✓（项目里的 `/p2p-check` 诊断页逐台测过）
 *    Google 的 STUN 在国内时通时不通 ✓ 所以放最后当兜底 ✓
 *    以后可以让服务端下发一份"当前可用的列表" ✓ 现在先写死 ✓
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
  { urls: 'stun:stun.hitv.com:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
]

/** 打不通的判定时间 ✓ 到点报 failed 让上层回退 ✓ */
const DEFAULT_TIMEOUT_MS = 6000

export type TransportOpts = {
  /** 我自己的 userId ✓ 用来过滤"发给我自己"的信令 ✓ */
  selfId: string
  /** 发一条定向信令 —— 通常直接接 api 的 p2p() ✓ */
  send: (to: string, payload: P2PSignal) => boolean
  iceServers?: RTCIceServer[]
  timeoutMs?: number
  log?: (line: string) => void
}

/** 把服务端转发过来的 unknown 收窄成 P2PSignal ✓ 形状不对就丢掉 ✓ */
export function parseSignal(x: unknown): P2PSignal | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  switch (o.t) {
    case 'want':
    case 'bye':
      return { t: o.t }
    case 'offer':
    case 'answer':
      return typeof o.sdp === 'string' ? { t: o.t, sdp: o.sdp } : null
    case 'ice':
      return typeof o.c === 'string'
        ? {
            t: 'ice',
            c: o.c,
            mid: typeof o.mid === 'string' ? o.mid : null,
            mline: typeof o.mline === 'number' ? o.mline : 0,
          }
        : null
    default:
      return null
  }
}

/** 每个观众/分享端一条连接，这个对象把连接和它的状态绑在一起 ✓ */
type PeerLink = {
  pc: RTCPeerConnection
  state: P2PState
  timer: ReturnType<typeof setTimeout> | null
}

function makePc(opts: TransportOpts, onIce: (c: RTCIceCandidate) => void): RTCPeerConnection {
  const pc = new RTCPeerConnection({
    iceServers: opts.iceServers ?? DEFAULT_ICE_SERVERS,
    // 收集快一点 ✓ 直连不需要攒很多候选 ✓
    iceCandidatePoolSize: 2,
  })
  pc.onicecandidate = (e) => {
    if (e.candidate) onIce(e.candidate)
  }
  return pc
}

// ═══════════════════════════════════════════════════════════
//  分享端
// ═══════════════════════════════════════════════════════════

/**
 * 把本机屏幕画面直连推给若干个观众。
 *
 * ⚠️ 采集**不归它管** ✗
 *    采集还是走原来那套（`chromeMediaSource` + `desktopCapturer`）✓
 *    这里只负责"把已经拿到的 MediaStream 送出去" ✓
 *    这样采集逻辑一行都不用改 ✓ 风险小很多 ✓
 */
export class ScreenShareBroadcaster {
  private readonly opts: TransportOpts
  private readonly getStream: () => MediaStream | null
  private readonly links = new Map<string, PeerLink>()
  /** 说过 want 但还没给 offer 的人（等画面准备好）✓ */
  private readonly waiting = new Set<string>()
  private readonly onState?: (peerId: string, state: P2PState) => void

  constructor(
    opts: TransportOpts & {
      getStream: () => MediaStream | null
      onState?: (peerId: string, state: P2PState) => void
    },
  ) {
    this.opts = opts
    this.getStream = opts.getStream
    this.onState = opts.onState
  }

  private log(line: string): void {
    this.opts.log?.(line)
  }

  private setState(peerId: string, state: P2PState): void {
    const link = this.links.get(peerId)
    if (link) link.state = state
    this.onState?.(peerId, state)
  }

  /** 有人打不通 → 上层据此决定要不要整体回退到 LiveKit ✓ */
  hasFailed(): boolean {
    for (const link of this.links.values()) if (link.state === 'failed') return true
    return false
  }

  states(): Record<string, P2PState> {
    const out: Record<string, P2PState> = {}
    for (const [id, link] of this.links) out[id] = link.state
    return out
  }

  /** 把已经拿到的画面推给一个观众 ✓ 失败会走 failed 而不是抛错 ✓ */
  private async offer(peerId: string): Promise<void> {
    const stream = this.getStream()
    if (!stream) {
      this.log(`还没有画面，先记下 ${peerId} 等一会儿`)
      this.waiting.add(peerId)
      return
    }

    // 已经连上/正在连就不重复建 ✓
    const exist = this.links.get(peerId)
    if (exist && exist.state !== 'failed') return

    this.waiting.delete(peerId)
    const pc = makePc(this.opts, (c) => {
      void this.opts.send(peerId, {
        t: 'ice',
        c: c.candidate,
        mid: c.sdpMid,
        mline: c.sdpMLineIndex ?? 0,
      })
    })

    const link: PeerLink = { pc, state: 'connecting', timer: null }
    this.links.set(peerId, link)

    // ⚠️ 只加**视频轨** ✗
    //    投屏的声音继续走 LiveKit ✓ 见文件顶部说明 ✓
    //    两路都塞进 P2P 的话，同一条音频在两条链路上跑 ✓ 反而容易出怪问题 ✓
    const video = stream.getVideoTracks()[0]
    if (video) pc.addTrack(video, stream)

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      if (st === 'connected') {
        if (link.timer) { clearTimeout(link.timer); link.timer = null }
        this.setState(peerId, 'connected')
        this.log(`直连成功：${peerId}`)
      } else if (st === 'failed') {
        // ⚠️⚠️ 这里**不能**把 'closed' 也算成失败 ✗（真机上栽过 ✓）
        //
        //   connectionState === 'closed' **只可能**来自我们**自己**调了 pc.close() ✓
        //   （对端断开不会变成 closed ✓ 那是 failed 或 disconnected ✓）
        //   而 pc.close() 恰恰是 unwatch() / stop() 里在拆连接时做的事 ✓
        //
        //   把它当失败的话：**每次正常拆除都会在界面上留下一条"直连失败"** ✗
        //   → 徽章变成「经服务器」✓ 而实际上那是我自己拆的 ✓
        //   → 真机上表现为"先显示直连、然后迅速变成经服务器" ✓✓
        if (link.timer) { clearTimeout(link.timer); link.timer = null }
        this.setState(peerId, 'failed')
        this.log(`直连失败：${peerId}`)
      }
    }

    // 超时兜底 ✓ 光靠 connectionState 有时会一直卡在 connecting ✓
    link.timer = setTimeout(() => {
      if (link.state === 'connecting') {
        this.setState(peerId, 'failed')
        this.log(`直连超时（${this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）：${peerId}`)
      }
    }, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    try {
      const o = await pc.createOffer()
      await pc.setLocalDescription(o)
    } catch (e) {
      this.setState(peerId, 'failed')
      this.log(`建 offer 失败：${(e as Error).message}`)
      return
    }

    this.setState(peerId, 'connecting')
    this.opts.send(peerId, { t: 'offer', sdp: pc.localDescription?.sdp ?? '' })
  }

  /** 画面准备好之后调用一次 ✓ 把之前记下的观众补上 ✓ */
  flushWaiting(): void {
    for (const id of [...this.waiting]) void this.offer(id)
  }

  /** 处理对端发来的信令 ✓ 只有 answer / ice / want / bye 四种和它有关 ✓ */
  handleSignal(from: string, payload: unknown): void {
    if (!from || from === this.opts.selfId) return
    const sig = parseSignal(payload)
    if (!sig) return

    if (sig.t === 'want') {
      void this.offer(from)
      return
    }

    const link = this.links.get(from)
    if (!link) return

    if (sig.t === 'bye') {
      this.removeViewer(from)
      return
    }

    if (sig.t === 'answer') {
      void link.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp }).catch((e) => {
        this.log(`设 answer 失败：${(e as Error).message}`)
      })
      return
    }

    if (sig.t === 'ice') {
      void link.pc
        .addIceCandidate({ candidate: sig.c, sdpMid: sig.mid, sdpMLineIndex: sig.mline })
        .catch(() => {
          /* 候选来晚了是常态 ✓ 忽略 */
        })
    }
  }

  removeViewer(peerId: string): void {
    const link = this.links.get(peerId)
    if (!link) return
    if (link.timer) clearTimeout(link.timer)
    try { link.pc.close() } catch { /* ignore */ }
    this.links.delete(peerId)
    this.waiting.delete(peerId)
    // ⚠️ 和观看端的 unwatch 对称：拆了就要报 idle ✗
    //    不然分享端的状态表里会永远留着那些 'connected' ✓
    this.onState?.(peerId, 'idle')
  }

  stop(): void {
    for (const id of [...this.links.keys()]) {
      this.opts.send(id, { t: 'bye' })
      this.removeViewer(id)
    }
    this.waiting.clear()
  }
}

// ═══════════════════════════════════════════════════════════
//  观看端
// ═══════════════════════════════════════════════════════════

/**
 * 接收某个分享端直连过来的画面。
 *
 * 只同时看**一路** ✓ —— 和现有界面一致（一次看一个人的投屏）✓
 * 想换人看就先 unwatch ✓ 省得同时挂好几条连接 ✓
 */
export class ScreenShareReceiver {
  private readonly opts: TransportOpts
  private readonly onStream?: (peerId: string, stream: MediaStream | null) => void
  private readonly onState?: (peerId: string, state: P2PState) => void
  private link: PeerLink | null = null
  private watching: string | null = null
  private remoteStream: MediaStream | null = null

  constructor(
    opts: TransportOpts & {
      onStream?: (peerId: string, stream: MediaStream | null) => void
      onState?: (peerId: string, state: P2PState) => void
    },
  ) {
    this.opts = opts
    this.onStream = opts.onStream
    this.onState = opts.onState
  }

  private log(line: string): void {
    this.opts.log?.(line)
  }

  private setState(peerId: string, state: P2PState): void {
    if (this.link) this.link.state = state
    this.onState?.(peerId, state)
  }

  /** 告诉分享端"我要看" ✓ 然后等它的 offer ✓ */
  watch(broadcasterId: string): void {
    if (this.watching === broadcasterId && this.link && this.link.state !== 'failed') return
    if (this.watching) this.unwatch()
    this.watching = broadcasterId
    this.log(`请求观看 ${broadcasterId}`)
    this.opts.send(broadcasterId, { t: 'want' })
  }

  unwatch(): void {
    const id = this.watching
    if (!id) return
    try { this.opts.send(id, { t: 'bye' }) } catch { /* ignore */ }
    if (this.link) {
      if (this.link.timer) clearTimeout(this.link.timer)
      try { this.link.pc.close() } catch { /* ignore */ }
    }
    this.link = null
    this.watching = null
    // ⚠️ 远端轨道要**显式停掉** ✗
    //    只把引用置空的话：
    //      · `<video>` 那边可能一直留着最后一帧 ✓ 看起来像没断开 ✓
    //      · 轨道不结束会一直占着解码资源 ✓ 反复换人看会越积越多 ✗
    if (this.remoteStream) {
      for (const t of this.remoteStream.getTracks()) {
        try { t.stop() } catch { /* ignore */ }
      }
    }
    this.remoteStream = null
    this.onStream?.(id, null)
    // ⚠️⚠️ 状态必须回落成 `idle` ✗
    //
    //   第一版**没写这一句** ✓ 于是连接拆了、流也清了 ✓
    //   但状态表里那条 `'connected'` 一直留着 ✓
    //   → 上层算出来的结论永远不是 idle ✓ 徽章会一直显示「直连」✗
    //   （哪怕早就没人共享了 ✓）
    //
    //   （这是 verify-p2p-hook 抓出来的 ✓ 而且它抓的方式很典型：
    //     "流清空了" 那一条**通过**了 ✓ 只有状态那一条是红的 ✓
    //     只看前一条的话会以为整个清理都没问题 ✗）
    this.onState?.(id, 'idle')
  }

  getStream(): MediaStream | null {
    return this.remoteStream
  }

  states(): Record<string, P2PState> {
    return this.watching ? { [this.watching]: this.link?.state ?? 'idle' } : {}
  }

  handleSignal(from: string, payload: unknown): void {
    if (!from || from === this.opts.selfId) return
    const sig = parseSignal(payload)
    if (!sig) return

    // 只处理"我正在看的那个人"的信令 ✓ 别人发来的一律忽略 ✓
    if (sig.t === 'offer') {
      if (this.watching !== from) {
        // 没请求过就发 offer —— 礼貌拒绝 ✓ 顺手让对方把连接关掉 ✓
        this.opts.send(from, { t: 'bye' })
        return
      }
      void this.acceptOffer(from, sig.sdp)
      return
    }

    if (!this.link || this.watching !== from) return

    if (sig.t === 'ice') {
      void this.link.pc
        .addIceCandidate({ candidate: sig.c, sdpMid: sig.mid, sdpMLineIndex: sig.mline })
        .catch(() => { /* 忽略迟到的候选 */ })
      return
    }

    if (sig.t === 'bye') {
      this.log(`分享端结束了：${from}`)
      this.unwatch()
    }
  }

  private async acceptOffer(from: string, sdp: string): Promise<void> {
    // 换人的话先把旧的收掉 ✓
    if (this.link) {
      if (this.link.timer) clearTimeout(this.link.timer)
      try { this.link.pc.close() } catch { /* ignore */ }
      this.link = null
    }

    const pc = makePc(this.opts, (c) => {
      void this.opts.send(from, {
        t: 'ice',
        c: c.candidate,
        mid: c.sdpMid,
        mline: c.sdpMLineIndex ?? 0,
      })
    })

    const link: PeerLink = { pc, state: 'connecting', timer: null }
    this.link = link

    // ⚠️ 必须用 ontrack 收流 ✗
    //    不能等 remoteDescription 设完就去读 pc.getReceivers() ✓
    //    那时候 track 可能还没挂上 ✓ 而且流是**逐轨到达**的 ✓
    const stream = new MediaStream()
    this.remoteStream = stream
    pc.ontrack = (e) => {
      stream.addTrack(e.track)
      this.log(`收到画面轨道（${e.track.kind}）来自 ${from}`)
      // 视频轨到了才算能看 ✓ 通知上层换源 ✓
      if (e.track.kind === 'video') this.onStream?.(from, stream)
    }

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      if (st === 'connected') {
        if (link.timer) { clearTimeout(link.timer); link.timer = null }
        this.setState(from, 'connected')
        this.log(`直连成功：${from}`)
      } else if (st === 'failed') {
        // ⚠️ 同上：'closed' 只可能是**我们自己** close 的 ✓ 不算失败 ✗
        if (link.timer) { clearTimeout(link.timer); link.timer = null }
        this.setState(from, 'failed')
        this.log(`直连失败：${from}`)
      }
    }

    link.timer = setTimeout(() => {
      if (link.state === 'connecting') {
        this.setState(from, 'failed')
        this.log(`直连超时：${from}`)
      }
    }, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp })
      const a = await pc.createAnswer()
      await pc.setLocalDescription(a)
      this.opts.send(from, { t: 'answer', sdp: pc.localDescription?.sdp ?? '' })
      this.setState(from, 'connecting')
    } catch (e) {
      this.setState(from, 'failed')
      this.log(`接 offer 失败：${(e as Error).message}`)
    }
  }

  stop(): void {
    this.unwatch()
  }
}
