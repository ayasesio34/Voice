/**
 * 投屏的 P2P 编排。
 *
 * ── 它和 p2pTransport 的分工 ✗ ──────────────────────────────
 *   p2pTransport  管**一条连接**（建 offer、换 ICE、收流 ✓）
 *   这个 hook     管**什么时候该有连接**（我在共享吗 ✓ 我在看谁 ✓）
 *   前者是纯逻辑、已经在浏览器里测过 ✓
 *   后者全是"跟着 React 状态走"的胶水 ✓
 *
 * ── ★ 为什么**不需要**写回退逻辑 ✗ ──────────────────────────
 *   这是整个设计里最省事的一点 ✓
 *
 *   分享端**照旧发布到 LiveKit** ✓ 另外再开一条 P2P ✓
 *   观看端拿到 P2P 流就渲染它 ✓ 于是 LiveKit 那个 <video> **被卸载** ✓
 *   → LiveKit 的 adaptiveStream 发现那一路没人看了 ✓
 *     于是**自动停掉订阅** ✓ 服务器出口归零 ✓✓
 *
 *   而 P2P 打不通的时候就什么都不做 ✓ 照旧渲染 LiveKit 那条 ✓
 *   → **"回退"是默认行为** ✓ 不需要超时、不需要判断、不需要取消发布 ✓✓
 *
 *   ⚠️ 代价：分享端仍然往服务器传一份（1× 上行 ✓）
 *      但服务器**出口**从 N× 降到 0 ✓ 而 6 Mbps 那个瓶颈正是出口 ✓
 *      （彻底不传需要"6 秒窗口 + 中途取消发布"✓ 风险大得多 ✓ 以后再说不迟 ✓）
 *
 * ── ⚠️ 现在测不到的部分 ✗ ───────────────────────────────────
 *   p2pTransport 本身有浏览器级测试 ✓（真的建连接、真的数帧 ✓）
 *   而这个 hook 的验证只能靠 typecheck + 真实两台机器联调 ✗
 *   因为门面图脚本里的 fixture 用的是**假 LiveKit 地址**（`ws://127.0.0.1:9` ✓）
 *   根本没有语音房间 ✓ 也就没有投屏可测 ✗
 *   → 这一点必须写在 CHANGELOG 里 ✓ 不能假装它验过了 ✓
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MsgKey } from './i18n'
import {
  ScreenShareBroadcaster,
  ScreenShareReceiver,
  type P2PState,
} from './p2pTransport'

export type ShareP2PStatus =
  /** 没在共享也没在看 ✓ */
  | 'idle'
  /** 有连接正在建立 ✓ */
  | 'connecting'
  /** 全都直连上了 ✓ 服务器出口是 0 ✓✓ */
  | 'p2p'
  /** 有打不通的 ✓ 那些人在走服务器 ✓ */
  | 'relay'
  /**
   * 用户在设置里**主动关掉了直连** ✓
   *
   * ⚠️ 这个和上面四个是**两个维度** ✗
   *   上面四个说的是"直连搞得怎么样" ✓
   *   这个说的是"根本没打算搞直连" ✓
   *   所以单独一个值 ✓ 不能借用 relay ✗
   *   （relay = 试过了、没打通 ✓ 而这里是压根没试 ✓
   *     两者对用户的行动建议完全不同：一个要去查网络 ✓ 一个是自己关的 ✓）
   */
  | 'off'

export type ScreenShareP2POpts = {
  /** 我自己的 userId ✓ */
  myUserId: string
  /** 我加入语音了吗 ✓ 没加入就什么都不做 ✓（信令也发不出去 ✓） */
  inVoice: boolean
  /**
   * 允许尝试 P2P 直连吗 ✓（设置里的「启用 P2P 直连」✓）
   *
   * ⚠️ false 的含义是**完全不走直连** ✗ 不是"建了不用" ✓
   *    两条路都不建 ✓ 信令也不收 ✓
   *    于是画面只可能走 LiveKit ✓ 也就是服务器中转 ✓✓
   */
  enabled: boolean
  /** 发一条定向信令 ✓ 通常接 api 的 p2p() ✓ */
  sendP2P: (to: string, payload: unknown) => boolean
  /**
   * 我正在共享的那路画面 ✓
   *
   * ⚠️ 传的是**采集到的原始流**，不是 LiveKit 发出去的那条轨道 ✗
   *    同一条流既能交给 LiveKit 发布 ✓ 也能交给 RTCPeerConnection ✓
   *    不需要从 LiveKit 那边反向取 ✓（那样还得等发布完成 ✓ 更慢 ✓）
   */
  myStream: MediaStream | null
  /**
   * 我正在看谁（**对方的 userId** ✓）。
   *
   * ⚠️ 这个值能从 `screenShares[i].key` 直接拿到 ✗
   *    因为 `voiceKey()` 优先取 participant attributes 里的 userId ✓
   *    LiveKit 的 identity 带随机后缀、对不上 ✓ 但 attributes 里有真的 ✓
   */
  watchTarget: string | null
}

export type ScreenShareP2P = {
  /** 收到的 P2P 画面。key 是分享者的 userId ✓ */
  streams: Record<string, MediaStream>
  /** 每一路的连接状态 ✓ 界面要显示 ✓ */
  states: Record<string, P2PState>
  /** 我这边整体是什么情况 ✓ */
  status: ShareP2PStatus
  /** 把 api 收到的信令转进来 ✓ */
  handleSignal: (from: string, payload: unknown) => void
}

/**
 * 按 key 合并两个状态表，空的那些丢掉 ✓（不然会越积越多 ✗）
 *
 * ⚠️ 导出是为了**能单独测** ✗
 *    这个文件整体要 React + 浏览器才能跑 ✓ 没法在 Node 里测 ✓
 *    但这两个函数是纯的 ✓ 而它们恰好决定了**界面上那个徽章显示什么** ✓
 *    那是最该测对的地方（标错了用户就会去查根本不存在的问题 ✓）
 */
export function mergeStates(
  a: Record<string, P2PState>,
  b: Record<string, P2PState>
): Record<string, P2PState> {
  const out: Record<string, P2PState> = {}
  for (const src of [a, b]) {
    for (const [k, v] of Object.entries(src)) {
      // ⚠️⚠️ `idle` 的语义是「**把这一项删掉**」✗ 不是「跳过」✗
      //
      //   第一版写的是 `if (v !== 'idle') out[k] = v` ✓ —— 跳过 ✓
      //   于是旧状态**留了下来** ✗：
      //     mergeStates({a:'connected'}, {a:'idle'})  →  {a:'connected'}  ✗
      //   后果：拆掉的连接永远留在表里 ✓ verdict() 一直算上它 ✓
      //   → 徽章**再也回不到 idle** ✓ 用户会看到一个"直连中…"永远卡着 ✗
      //
      //   （这是测试抓出来的 ✓ 而且正是那段注释预告过的失败模式 ✓）
      if (v === 'idle') delete out[k]
      else out[k] = v
    }
  }
  return out
}

/**
 * 从一堆状态里算整体结论 ✓（界面上的徽章就是它 ✓）
 *
 * ⚠️ 优先级：只要**有一个人**打不通就报 relay ✗
 *    不能报"直连" ✓ —— 那个人正在走服务器 ✓ 而他那边可能画质不一样 ✓
 *    报成直连的话他永远不知道自己是例外 ✓
 */
export function verdict(states: Record<string, P2PState>): ShareP2PStatus {
  const all = Object.values(states)
  if (all.length === 0) return 'idle'
  if (all.some((s) => s === 'failed')) return 'relay'
  if (all.every((s) => s === 'connected')) return 'p2p'
  return 'connecting'
}

/**
 * 徽章该显示什么 ✓（**纯函数** ✓ 不碰 React ✓ 不碰 DOM ✓）
 *
 * ⚠️⚠️ 这里修的是一个真 bug ✗
 *
 *   原来徽章的**存在与否**取决于 `verdict` 的结果：
 *     `idle` → 返回 null → 徽章**消失** ✗
 *   而 `verdict` 在没有 P2P 连接时就是 `idle` ✓
 *   于是：接收端一 `unwatch()` ✓ 那个键被删掉 ✓
 *        → `states` 空了 → `idle` → **徽章闪一下就没了** ✗✗
 *   用户看到的正是这个 ✓
 *
 *   ⚠️ 而那个"idle 就删除"是**我为了修另一个 bug 加的** ✗
 *      （停掉共享之后徽章卡在"直连"上不动 ✓）
 *      两个需求撞在一起了 ✓→ 不能靠"删不删键"来同时满足 ✓
 *
 *   正确的切分 ✓：
 *     · 徽章**存不存在** → 看「画面上有没有投屏」✓（在 App 里判断 ✓）
 *     · 徽章**写什么**   → 看这里 ✓
 *   于是 `idle` 也要给出一个说法 ✓ 而不是"没有徽章" ✗
 *
 *   ⚠️ 那 `idle` 该说什么 ✗
 *      它 = **一条 P2P 连接都没有** ✓
 *      → 此刻画面（如果有的话）走的**就是服务器** ✓
 *      → 所以它就是 relay ✓✓ 这不是猜测 ✓ 是当时的事实 ✓
 *
 *     （`relay` 与 `idle` 的区别只在提示语上 ✓
 *      `relay` 是"试过了、没打通" ✓ `idle` 是"还没有直连" ✓
 *       两者对用户的实际影响一样：画面走服务器 ✓）
 *
 * 返回 null 只表示"**现在根本不该有投屏**" ✗ —— 由调用方判断 ✓
 */
export function badgeFor(status: ShareP2PStatus): {
  textKey: MsgKey
  tipKey: MsgKey
  cls: 'ok' | 'warn' | ''
} {
  switch (status) {
    case 'p2p':
      return { textKey: 'p2p.direct', tipKey: 'p2p.directTip', cls: 'ok' }
    case 'connecting':
      return { textKey: 'p2p.connecting', tipKey: 'p2p.connectingTip', cls: '' }
    case 'relay':
      return { textKey: 'p2p.relay', tipKey: 'p2p.relayTip', cls: 'warn' }
    case 'idle':
    default:
      // ⚠️ idle 也**必须给出徽章** ✗ 不能返回 null ✓
      //    返回 null 就是"闪一下就没了"那个 bug ✓
      //
      // ⚠️⚠️ 但**正文不能借用 relay 的**「经服务器」✗
      //    idle 有两种完全不同的情形 ✓ 而它们对用户的意义相反：
      //      ① 没人在看          → 根本没有画面在传 ✓
      //                            说"经服务器"会让人以为流量在跑 ✗
      //      ② 有人在看但没走直连 → 这时候服务器**会**多出约一个码率的量 ✓
      //
      //    真事：用户量出来 2.54 Mbps（基线 3.00 ✓ 比基线还低 ✓）
      //    也就是服务器**没在转发画面** ✓ 而徽章写着"经服务器" ✗
      //    → 他合理地以为 P2P 没生效 ✓ 其实那一轮根本没人观看 ✓
      //
      //    所以 idle 说**「未建立直连」** ✓ —— 这句话在两种情形下都成立 ✓✓
      //    想去分清楚"到底有没有人在看"得知道观看人数 ✗
      //    而观看端可能是旧版客户端（根本不会发 P2P 信令 ✓）→ 分不出来 ✓
      //    → 那就**别假装分得出来** ✗ 说一句两者都真的话 ✓
      return { textKey: 'p2p.notDirect', tipKey: 'p2p.idleTip', cls: 'warn' }
    case 'off':
      // ⚠️ 用户**自己**在设置里关的 ✗ 这不是故障 ✓
      //    所以：
      //      · 不能说 relay 的「经服务器」✗ —— 那句配的提示语是"打不通"
      //        会让用户以为网络有问题、跑去排查一个不存在的问题 ✓
      //      · 也不能说 idle 的「未建立直连」✗ —— 那句听起来像"还没连上、在等"
      //        而实际上**永远不会连** ✓ 会让人白等 ✓
      //      · 颜色用**无色** ✗ 不是 warn ✓ —— warn 是"有事要你注意"
      //        而这是他自己的选择 ✓ 没有需要注意的 ✓
      return { textKey: 'p2p.off', tipKey: 'p2p.offTip', cls: '' }
  }
}

export function useScreenShareP2P(opts: ScreenShareP2POpts): ScreenShareP2P {
  const { myUserId, inVoice, sendP2P, myStream, watchTarget, enabled } = opts

  const [streams, setStreams] = useState<Record<string, MediaStream>>({})
  const [states, setStates] = useState<Record<string, P2PState>>({})

  /**
   * ⚠️ `enabled` 也要走 ref ✗ —— 给 `handleSignal` 用 ✓
   *    那个是 `useCallback(..., [])` ✓ 直接读闭包里的 enabled 会是**第一版**的值 ✓
   *    → 用户在设置里关掉之后，旧闭包还以为开着 ✓ 继续处理信令 ✗
   */
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  /**
   * ⚠️ 下面两个 sendP2P 都要走 ref ✗
   *    App 那边传进来的通常是个内联箭头函数 ✓ 每次渲染都是新的 ✓
   *    直接写进 effect 依赖 → 每次渲染都重建连接 → **无限重连** ✓
   */
  const sendRef = useRef(sendP2P)
  sendRef.current = sendP2P

  /**
   * ⚠️ `myStream` 也要走 ref ✗（配合上面那个"只依赖轨道"的 effect ✓）
   *   effect 不会因为"流对象换了个包装"而重跑 ✓
   *   但 `getStream()` 被调用时必须拿到**当前**那条流 ✓
   *   直接闭包捕获的话会拿到 effect 建立那一刻的旧对象 ✓
   *   （里面的轨道是同一条 ✓ 所以以前没暴露出来 ✓ 但这是错的 ✓）
   */
  const streamRef = useRef(myStream)
  streamRef.current = myStream

  const broadcasterRef = useRef<ScreenShareBroadcaster | null>(null)
  const receiverRef = useRef<ScreenShareReceiver | null>(null)
  /** 谁给我发过信令 ✓ 用来判断"要不要建分享端"（有人想看才建 ✓） */
  const [wantedBy, setWantedBy] = useState<string[]>([])

  // ── 分享端：我共享时才有它 ✓ ──────────────────────────────
  /**
   * ⚠️⚠️ effect 必须只依赖**那条视频轨道本身** ✗ 不能依赖整个 MediaStream ✓
   *
   *   真机上栽过：App 那边传进来的 `myStream` 是
   *   `useMemo(() => new MediaStream([track]), [screenShares])` ✓
   *   而 `screenShares` 是**每次 LiveKit 推送都变的新数组** ✗
   *   → 每几秒就有一个**新的 MediaStream 对象** ✓ 而里面的轨道是**同一条** ✓
   *   → 依赖 `myStream` 的话 effect 每几秒重跑一次 ✓
   *   → **先把 broadcaster stop() 掉（pc.close()）再新建** ✗✗
   *   → 刚建好的直连被反复拆掉 ✓ 徽章先闪「直连」再变「经服务器」✓
   *
   *   App 那边也一起修了 ✓ 但这里再挡一层 ✗ ——
   *   因为这个 hook 是**通用**的 ✓ 以后谁传个不稳定的 stream 进来都会踩同一个坑 ✓
   *
   *   ⚠️ 用「轨道」而不是「流」当依赖是安全的 ✓
   *      轨道换了 = 真的换了共享源 ✓ 那时重建才对 ✓
   *      流对象换了 = 只是包装变了 ✓ 没啥可重建的 ✓
   */
  const myVideoTrack = myStream?.getVideoTracks()[0] ?? null

  useEffect(() => {
    // ⚠️ 关掉直连 → 和"没共享"走**同一条**清理路径 ✗
    //    不能只写成"不新建" ✓ —— 那样用户中途关掉开关时
    //    已经建好的那条连接会一直留着 ✗ 别人还能连上来 ✓
    //    必须让它进来把 broadcaster stop() 掉 ✓
    //
    // ⚠️ 没共享 / 不在语音里 → 拆掉 ✓
    //    不拆的话停掉共享之后别人还能连上来 ✓ 连上来的是一条**已经没有轨道的空连接** ✗
    if (!enabled || !myVideoTrack || !inVoice) {
      broadcasterRef.current?.stop()
      broadcasterRef.current = null
      setWantedBy([])
      // ⚠️ 状态也要清 ✗ —— 见下面观看端那段的同款注释 ✓
      //    不清的话表里留着旧的 'connected' ✓
      //    → status 会算出 'p2p'（但开关明明关着 ✗）
      setStates((prev) =>
        mergeStates(prev, Object.fromEntries(Object.keys(prev).map((k) => [k, 'idle' as P2PState])))
      )
      return
    }

    const bc = new ScreenShareBroadcaster({
      selfId: myUserId,
      send: (to, payload) => sendRef.current(to, payload),
      // ⚠️ 这里要用**最新的** myStream ✗ 而 effect 不会因为流对象变了而重跑 ✓
      //    所以走 ref 取 ✓ 不能直接闭包捕获这一个 render 的 myStream ✓
      getStream: () => streamRef.current,
      onState: (peerId, state) => {
        setStates((prev) => mergeStates(prev, { [peerId]: state }))
      },
    })
    broadcasterRef.current = bc
    // 之前有人发过 want、但当时画面还没准备好 ✓ 补上 ✓
    bc.flushWaiting()

    return () => {
      // ⚠️ 退出时**发 bye** ✗
      //    只 close() 的话对端不会知道 ✓ 它会一直等在那儿、画面卡着不动 ✓
      bc.stop()
      broadcasterRef.current = null
      // ⚠️ 观众的连接状态也要清 ✗
      //    和观看端那边同一个道理：拆了不清理的话表里会留着 ✓
      //    用一个**函数式更新**把当前表里所有项都置 idle 就行 ✓
      //    不需要知道具体是哪些人 —— 分享端一拆，它认识的连接全都不作数了 ✓
      setStates((prev) =>
        mergeStates(
          prev,
          Object.fromEntries(Object.keys(prev).map((k) => [k, 'idle' as P2PState]))
        )
      )
    }
    // ⚠️ 依赖的是**轨道** ✓ 不是流 ✓ 见上面的长注释 ✗
    //    `enabled` 也要依赖 ✗ —— 开关一关就得把连接拆掉 ✓
  }, [enabled, myVideoTrack, inVoice, myUserId])

  // ── 观看端：我在看谁就有它 ✓ ──────────────────────────────
  useEffect(() => {
    // ⚠️ 关掉直连时 target 直接给 null ✗
    //    → 走下面那条清理路径把 receiver stop() 掉 ✓
    //    ⚠️ 关键：**不发 want 信令** ✓
    //      观看端是先发 want 才让分享端建连接的 ✓
    //      不发 = 分享端根本不知道有人想看 = 它那边也不会建 ✓✓
    //      （对端可能自己也开着直连 ✓ 但它收不到 want 就不会动 ✓）
    // 没看人 / 不在语音 / 看的是自己 → 不需要 ✓（自己看自己走本地就行 ✓）
    const target =
      enabled && watchTarget && watchTarget !== myUserId && inVoice ? watchTarget : null
    if (!target) {
      receiverRef.current?.stop()
      receiverRef.current = null
      // ⚠️ 这里也要清状态 ✗（原来是漏的 ✓ 见下面的长注释 ✓）
      if (!enabled && watchTarget) {
        setStates((prev) => mergeStates(prev, { [watchTarget]: 'idle' }))
      }
      return
    }

    const rc = new ScreenShareReceiver({
      selfId: myUserId,
      send: (to, payload) => sendRef.current(to, payload),
      onStream: (peerId, stream) => {
        setStreams((prev) => {
          const next = { ...prev }
          if (stream) next[peerId] = stream
          else delete next[peerId]
          return next
        })
      },
      onState: (peerId, state) => {
        setStates((prev) => mergeStates(prev, { [peerId]: state }))
      },
    })
    receiverRef.current = rc
    rc.watch(target)

    return () => {
      rc.stop()
      receiverRef.current = null
      // ⚠️ 拆掉时要把这条状态**删掉** ✗
      //
      //   `unwatch()` 内部只是 close 连接 + onStream(null) ✓
      //   它**不上报状态** ✓ 于是表里永远留着 'connected' ✓
      //   → verdict() 一直算上它 → status 再也回不到 'idle' ✗
      //   → 徽章会一直显示「直连」（哪怕早就没人共享了 ✓）
      //
      //   （这是 verify-p2p-hook 抓出来的 ✓
      //     和之前 mergeStates 那个是**同一类**：拆了之后没人清理 ✗）
      setStates((prev) => mergeStates(prev, { [target]: 'idle' }))
    }
  }, [enabled, watchTarget, inVoice, myUserId])

  // ── 信令路由 ✓ ────────────────────────────────────────────
  const handleSignal = useCallback((from: string, payload: unknown) => {
    if (!from) return
    // ⚠️ 关掉直连时**整条信令都忽略** ✗
    //    对端可能还开着直连、还在给我们发 want / offer ✓
    //    我们这边两个 ref 都是 null ✓ 所以本来也不会出事 ✓
    //    但显式挡掉更稳 ✗ —— 万一以后有"半边开着"的代码路径，
    //    这里能保证**关了就是完全不参与** ✓
    if (!enabledRef.current) return
    // ⚠️ 两边都要喂 ✗
    //    同一个 from 既可能是"想看我的"（分享端收 want ✓）
    //    也可能是"我在看的那个"（观看端收 offer ✓）
    //    谁认得就谁处理 ✓ 另一方看不懂会自己忽略 ✓（p2pTransport 里做了 ✓）
    if (payload && typeof payload === 'object' && (payload as { t?: string }).t === 'want') {
      setWantedBy((prev) => (prev.includes(from) ? prev : [...prev, from]))
    }
    broadcasterRef.current?.handleSignal(from, payload)
    receiverRef.current?.handleSignal(from, payload)
  }, [])

  // ⚠️ 我停掉共享时，boardcaster 已经拆了 ✓ 但 wantedBy 和 states 里
  //    还留着上一次的人 ✓ 那些状态会让界面一直显示"直连中"✗
  useEffect(() => {
    if (myStream) return
    setStreams({})
    setStates({})
    setWantedBy([])
  }, [myStream])

  void wantedBy

  return {
    streams,
    states,
    // ⚠️ 关掉直连时**不走 verdict** ✗
    //    verdict 是"从一堆连接状态里算结论" ✓ 而关掉时根本没有连接状态 ✓
    //    硬算的话 states 是空的 → 返回 'idle' ✓
    //    而 idle 的徽章写着「未建立直连」✗ —— 对"自己关掉的"是**误导** ✓
    //    （他一看"未建立"会以为是网络问题、去查一个不存在的问题 ✗）
    status: enabled ? verdict(states) : 'off',
    handleSignal,
  }
}
