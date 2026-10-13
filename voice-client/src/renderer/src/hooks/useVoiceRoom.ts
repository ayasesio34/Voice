import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ConnectionState,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type AudioCaptureOptions,
} from 'livekit-client'
import { fetchToken } from '../lib/api'
import {
  createRoom,
  publishScreenFromSource,
  stopScreenShare,
  type ContentHint,
  type Preset,
  type VideoCodecChoice,
} from '../lib/livekit'
import { startScreenAudioTrack } from '../lib/screenAudio'
import { voiceKey } from '../lib/names'
import type { AppConfig } from '../lib/config'

export type RoomStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export type StartScreenOptions = {
  sourceId: string
  preset: Preset
  contentHint: ContentHint
  withAudio: boolean
}

/**
 * 读当前正在用的设备 id。
 * `getActiveDevice` 在个别 SDK 版本上可能不存在，兜一层免得整个界面崩掉。
 */
function getActiveDevice(room: Room | null, kind: MediaDeviceKind): string {
  if (!room) return ''
  const fn = (room as unknown as {
    getActiveDevice?: (k: MediaDeviceKind) => string | undefined
  }).getActiveDevice
  if (typeof fn !== 'function') return ''
  try {
    return fn.call(room, kind) ?? ''
  } catch {
    return ''
  }
}

/**
 * 断线原因 -> 界面文案。
 *
 * 协议层给的是 `CLIENT_INITIATED`、`SIGNAL_CLOSE` 这种枚举名 ——
 * 排查问题时很好用，对用户毫无意义。这里做一层翻译。
 *
 * 枚举名（@livekit/protocol 生成的，所以是 SCREAMING_SNAKE_CASE）
 * 依然会打到控制台，界面只显示人话。
 *
 * 表里没有的名字会退回「连接已断开」—— 以后 LiveKit 加了新原因码
 * 也不会显示成空白或者一串英文。
 */
/**
 * 「我们刚主动断开过」这个判断的有效期。
 *
 * 3 秒足够覆盖事件异步到达的延迟，又短到不会把"刚退出就真掉线"误判成预期内 ——
 * 而且那种情况下人已经不在频道里了，报不报错都无所谓。
 */
const EXPECTED_DISCONNECT_MS = 3000

const DISCONNECT_TEXT: Record<string, string> = {
  UNKNOWN: '连接已断开',
  // 自己点的「离开频道」—— 别说得像出了故障
  CLIENT_INITIATED: '连接已断开',
  // 同一个身份在两处登录：多半是另一台设备或另一个窗口抢了
  DUPLICATE_IDENTITY: '这个身份在别处连上了，这里已被挤下线',
  SERVER_SHUTDOWN: '服务器已关闭',
  PARTICIPANT_REMOVED: '你被移出了频道',
  ROOM_DELETED: '频道已被删除',
  STATE_MISMATCH: '连接状态异常，已断开',
  JOIN_FAILURE: '加入频道失败',
  MIGRATION: '服务器正在迁移，连接已断开',
  // 信令 WebSocket 意外断掉 —— 最常见的"网络问题"就是它
  SIGNAL_CLOSE: '网络错误',
  ROOM_CLOSED: '频道已关闭',
  USER_UNAVAILABLE: '对方暂时不可用',
  USER_REJECTED: '对方拒绝了连接',
  SIP_TRUNK_FAILURE: '语音中继失败',
  CONNECTION_TIMEOUT: '网络错误（连接超时）',
  MEDIA_FAILURE: '媒体传输出错',
}

/**
 * 麦克风采集约束。
 *
 * 三个都是**浏览器内置**的音频处理 —— 零下载、几乎零开销、免费：
 *   echoCancellation —— 回声消除。防止对方听到自己（外放时尤其重要）
 *   autoGainControl  —— 自动增益。把你忽大忽小的声音拉平
 *   noiseSuppression —— 降噪。滤掉风扇、键盘、空调这类稳态噪音
 *
 * 三个都默认开着。给开关是因为特殊情况确实存在：
 *   · 降噪会把稳态噪音和**人声一起削**，有些人声会变得发闷、像隔了层布
 *   · 外置声卡 / 调音台自己已经处理过了，浏览器再叠一层反而更糟
 *
 * ⚠️ 这些约束只有在 **getUserMedia 那一刻**才被读取。改参数必须重新采集，
 *    见下面的 applyMicOptions。
 */
export type MicOptions = {
  echoCancellation: boolean
  autoGainControl: boolean
  noiseSuppression: boolean
}

export const DEFAULT_MIC_OPTIONS: MicOptions = {
  echoCancellation: true,
  autoGainControl: true,
  noiseSuppression: true,
}

/** 转成 LiveKit / getUserMedia 认的形态 */
function captureOptions(opts: MicOptions): AudioCaptureOptions {
  return {
    echoCancellation: opts.echoCancellation,
    autoGainControl: opts.autoGainControl,
    noiseSuppression: opts.noiseSuppression,
  }
}

/**
 * 写 participant attributes。
 *
 * 两个 key，各有用途：
 *   avatar —— 头像。同一房间里的人能直接读到，后端 listParticipants
 *             也读得到，于是左侧"其它语音频道"里也能显示。
 *   userId —— **稳定标识**。LiveKit 的 identity 每次连接都会变，
 *             不能拿来记"我给他调过多少音量"。带上它，
 *             下次他重连音量设置还认得出。
 *
 * 用可选调用包住 —— 万一 SDK 版本没有 setAttributes，也不该让连接失败。
 */
async function applyAttributes(room: Room, attrs: Record<string, string>): Promise<void> {
  try {
    const lp = room.localParticipant as unknown as {
      setAttributes?: (a: Record<string, string>) => Promise<void>
    }
    if (typeof lp.setAttributes === 'function') {
      await lp.setAttributes(attrs)
    }
  } catch {
    /* 属性设置失败不影响通话本身 */
  }
}

/**
 * LiveKit 房间的 React 封装。
 *
 * 这里刻意不把「参与者列表」做成 state —— 而是在事件里 bump 一个计数器，
 * 组件渲染时直接从 room 对象读。原因是 LiveKit 的轨道/说话状态变化非常频繁，
 * 手工维护一份镜像 state 极容易和实际状态不同步（这类 bug 很难查）。
 */
export function useVoiceRoom() {
  const [room, setRoom] = useState<Room | null>(null)
  const [status, setStatus] = useState<RoomStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  /**
   * 「关闭喇叭」状态。
   *
   * 按 Discord 的规矩：关喇叭会**顺带闭麦**（都听不见了，说话也没意义），
   * 取消关喇叭时**恢复**关之前那个麦克风状态。
   * 所以这里要记住关之前的开麦状态，不能用固定的 true/false。
   */
  const [deafened, setDeafened] = useState(false)
  const preDeafenMicRef = useRef(false)

  const roomRef = useRef<Room | null>(null)

  /**
   * 我们**主动**断开的时刻。
   *
   * 需要它是因为 LiveKit 的 `Disconnected` 事件在"主动退出"和"掉线"
   * 两种情况下都会触发，但这两件事对用户的含义完全不同：
   *   · 主动退出 / 换频道 → 什么都不用说（本来就有退出音效）
   *   · 掉线             → 必须明确告诉他，否则他会以为"突然没声音了"
   *
   * ⚠️ 用**时间戳**而不是布尔标志：布尔标志挡不住**异步到达**的事件 ——
   *    `await room.disconnect()` 返回时标志早就复位了，事件才慢悠悠地到。
   *    时间戳记的是"我们刚主动断开过"，不管事件什么时候来都认得出。
   */
  const expectedDisconnectAtRef = useRef(0)

  const bump = useCallback(() => setTick((t) => t + 1), [])

  // ── 事件订阅 ──────────────────────────────────────────────
  //
  // ⚠️ 卸载时用 room.off(事件, 具名处理函数) 逐个摘掉，
  //    **不要**用 removeAllListeners() —— 那会把 LiveKit 内部自己注册的
  //    监听器一起清掉，导致断开/清理流程出问题。
  useEffect(() => {
    if (!room) return

    const onState = (state: ConnectionState) => {
      if (state === ConnectionState.Connected) setStatus('connected')
      else if (state === ConnectionState.Connecting) setStatus('connecting')
      else if (state === ConnectionState.Reconnecting) setStatus('reconnecting')
      else if (state === ConnectionState.Disconnected) setStatus('idle')
      bump()
    }

    // 枚举名留控制台就够了 —— 排查"连一会儿就掉"时全靠它，
    // 能直接区分是网络超时、被服务端踢、还是自己主动退的。
    // 界面只显示翻译过的人话（见上面的 DISCONNECT_TEXT）。
    const onDisconnected = (reason?: DisconnectReason) => {
      const name =
        reason !== undefined ? (DisconnectReason[reason] ?? String(reason)) : 'UNKNOWN'
      console.info('[voice] 连接已断开，原因：', name)

      // ★ 掉线也必须把房间状态清干净。
      //
      //   之前这里只改 status，`room` 还留着 —— 于是界面停在上一个房间的样子：
      //   成员列表、**投屏画面**都还挂着，但那些轨道早就死了。
      //   用户看到的现象就是"我已经不在频道里了，却还能看到投屏"。
      roomRef.current = null
      roomNameRef.current = null
      connectingRef.current = null
      setRoom(null)
      setDeafened(false)
      preDeafenMicRef.current = false
      setStatus('idle')

      // 主动退出 / 换频道之后紧接着来的 Disconnected 都算预期内的
      const expected = Date.now() - expectedDisconnectAtRef.current < EXPECTED_DISCONNECT_MS
      if (!expected) {
        setError(DISCONNECT_TEXT[name] ?? '连接已断开')
      }

      bump()
    }

    const onReconnecting = () => {
      setStatus('reconnecting')
      bump()
    }

    const onReconnected = () => {
      setStatus('connected')
      bump()
    }

    const BUMP_EVENTS = [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.ActiveSpeakersChanged,
      RoomEvent.ConnectionQualityChanged,
    ] as const

    room.on(RoomEvent.ConnectionStateChanged, onState)
    room.on(RoomEvent.Disconnected, onDisconnected)
    room.on(RoomEvent.Reconnecting, onReconnecting)
    room.on(RoomEvent.Reconnected, onReconnected)
    for (const ev of BUMP_EVENTS) room.on(ev, bump)

    return () => {
      room.off(RoomEvent.ConnectionStateChanged, onState)
      room.off(RoomEvent.Disconnected, onDisconnected)
      room.off(RoomEvent.Reconnecting, onReconnecting)
      room.off(RoomEvent.Reconnected, onReconnected)
      for (const ev of BUMP_EVENTS) room.off(ev, bump)
    }
  }, [room, bump])

  // ── 连接 ──────────────────────────────────────────────────
  const roomNameRef = useRef<string | null>(null)
  /**
   * 正在连接中的房间名。
   *
   * ⚠️ 这个标记必须在**任何 await 之前**同步设置，这正是它的全部意义。
   *
   * 只用 roomRef.current 判断是不够的：从"发起连接"到"roomRef 被赋值"
   * 中间隔着 fetchToken 和 room.connect 两个 await，这期间 roomRef 一直是 null。
   * 用户因为网络延迟以为没反应、又点了一次，两次点击就都通过了检查，
   * 各自建立一条连接 —— 成员列表里于是出现两个自己。
   */
  const connectingRef = useRef<string | null>(null)

  /**
   * 当前的麦克风采集参数。
   * 放 ref 里是因为好几个调用点都要用它（连接时自动开麦、手动开麦、
   * 关喇叭恢复），但都不该因此重新创建回调。
   */
  const micOptsRef = useRef<AudioCaptureOptions>(captureOptions(DEFAULT_MIC_OPTIONS))

  const connect = useCallback(
    async (
      cfg: AppConfig,
      roomName: string,
      opts: {
        preset: Preset
        codec: VideoCodecChoice
        avatar: string
        /** 麦克风处理开关（降噪 / 回声消除 / 自动增益），见 MicOptions */
        mic: MicOptions
      }
    ) => {
      // 已经在同一个房间里，或正在连同一个房间 —— 都不重复发起
      if (roomRef.current && roomNameRef.current === roomName) return
      if (connectingRef.current === roomName) return

      connectingRef.current = roomName
      setError(null)
      setStatus('connecting')

      try {
        // 先清理旧连接（换频道时）
        if (roomRef.current) {
          // 换频道也是"我说了算"的断开 —— 别让 onDisconnected
          // 弹一个"连接已断开"的错误（那个提示是给意外掉线用的）
          expectedDisconnectAtRef.current = Date.now()
          try {
            await roomRef.current.disconnect()
          } catch {
            /* ignore */
          }
          roomRef.current = null
          roomNameRef.current = null
        }

        const { token } = await fetchToken(cfg, roomName, cfg.nickname)

        // 等待 token 的这段时间里，用户可能已经改点别的频道了
        if (connectingRef.current !== roomName) return

        const r = createRoom({ codec: opts.codec, preset: opts.preset })
        await r.connect(cfg.livekitUrl, token)

        // 连上之后立刻把头像和 userId 广播出去
        await applyAttributes(r, { avatar: opts.avatar, userId: cfg.userId })

        // 连上的瞬间再检查一次：期间又发起了新连接的话，把这条丢掉，
        // 否则它就成了没人管的幽灵参与者
        if (connectingRef.current !== roomName) {
          void r.disconnect().catch(() => {})
          return
        }

        roomRef.current = r
        roomNameRef.current = roomName
        setRoom(r)
        setStatus('connected')

        // 连上就默认开麦 —— 不然每次进频道都得先点一下「开麦」，很烦。
        //
        // 单独 try 住：麦克风打不开（权限被拒、设备被别的程序独占）不该
        // 把刚建立的连接弄断 —— 那样连听都听不成了。
        micOptsRef.current = captureOptions(opts.mic)
        try {
          await r.localParticipant.setMicrophoneEnabled(true, micOptsRef.current)
        } catch (err) {
          setError(`已加入频道，但麦克风没打开：${(err as Error).message}`)
        }
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err)
        setError(msg)
        setStatus('error')
      } finally {
        // 只清理"属于自己的"那一笔，别把后来者的标记抹掉
        if (connectingRef.current === roomName) connectingRef.current = null
      }
    },
    []
  )

  const disconnect = useCallback(async () => {
    const r = roomRef.current
    if (!r) return

    // 先记时刻再断开 —— Disconnected 事件可能立刻到，也可能慢几秒才到
    expectedDisconnectAtRef.current = Date.now()
    try {
      await r.disconnect()
    } catch {
      /* ignore */
    }

    // 监听器的摘除交给上面那个 effect 的 cleanup ——
    // setRoom(null) 会触发它。这里不要手动 removeAllListeners()。
    roomRef.current = null
    roomNameRef.current = null
    connectingRef.current = null
    setDeafened(false)
    preDeafenMicRef.current = false
    setRoom(null)
    setStatus('idle')
    // 主动退出不该留着上一条错误提示（比如之前掉线报的"连接已断开"）
    setError(null)
  }, [])

  // 窗口关闭 / 组件卸载时断开，别把幽灵留在服务器上
  useEffect(() => {
    return () => {
      const r = roomRef.current
      roomRef.current = null
      roomNameRef.current = null
      connectingRef.current = null
      if (r) void r.disconnect().catch(() => {})
    }
  }, [])

  // ── 麦克风 ────────────────────────────────────────────────
  const toggleMic = useCallback(async () => {
    const r = roomRef.current
    if (!r) return
    // 关着喇叭的时候不允许单独开麦 —— 界面上按钮也会禁用，这里再兜一层
    if (deafened) return
    const on = r.localParticipant.isMicrophoneEnabled
    try {
      if (on) {
        await r.localParticipant.setMicrophoneEnabled(false)
      } else {
        // 开麦时要带上采集参数，否则降噪设置会被默认值顶掉
        await r.localParticipant.setMicrophoneEnabled(true, micOptsRef.current)
      }
    } catch (err) {
      setError(`麦克风切换失败：${(err as Error).message}`)
    }
    bump()
  }, [bump, deafened])

  /**
   * 改麦克风采集参数（降噪开关）。
   *
   * ⚠️ 必须**重新采集**才生效 —— 浏览器只在 getUserMedia 那一刻读这些约束，
   *    改完直接调 setMicrophoneEnabled 是不会重新协商的。
   *    所以这里先关掉再打开。麦克风本来就是关的就不用折腾。
   */
  const applyMicOptions = useCallback(
    async (opts: MicOptions) => {
      micOptsRef.current = captureOptions(opts)

      const r = roomRef.current
      if (!r) return
      const lp = r.localParticipant
      if (!lp.isMicrophoneEnabled) return

      try {
        await lp.setMicrophoneEnabled(false)
        await lp.setMicrophoneEnabled(true, micOptsRef.current)
      } catch (err) {
        setError(`降噪设置没生效：${(err as Error).message}`)
      }
      bump()
    },
    [bump]
  )

  // ── 关闭喇叭（deafen）────────────────────────────────────
  const toggleDeafen = useCallback(async () => {
    const r = roomRef.current
    if (!r) return

    const next = !deafened
    if (next) {
      // 记住当前的麦克风状态，取消关喇叭时要恢复回去
      preDeafenMicRef.current = r.localParticipant.isMicrophoneEnabled
      try {
        await r.localParticipant.setMicrophoneEnabled(false)
      } catch {
        /* ignore */
      }
    } else if (preDeafenMicRef.current) {
      try {
        await r.localParticipant.setMicrophoneEnabled(true, micOptsRef.current)
      } catch {
        /* ignore */
      }
    }

    setDeafened(next)
    // 把"关了喇叭"也广播出去 —— 频道列表里那个红灯就靠它。
    // attributes 是**增量合并**的，所以只写这一项，别的不会被抹掉。
    void applyAttributes(r, { deaf: next ? '1' : '' })
    bump()
  }, [bump, deafened])

  // ── 屏幕共享 ──────────────────────────────────────────────
  const startScreen = useCallback(
    async (opts: StartScreenOptions) => {
      const r = roomRef.current
      if (!r) return
      try {
        // 告诉主进程"用户选了哪个源"，供 display-media 请求处理器兜底使用
        await window.desktop?.pickSource(opts.sourceId)

        // 系统声音优先走原生插件 —— 它能**排除本软件的进程树**，
        // 也就是投屏里不含通话声。这正是"对方听到自己说话"那个问题的根治办法。
        //
        // 拿不到插件时返回 null，下面自动退回 Chromium 的整系统捕获（含通话声）。
        let externalAudio: MediaStreamTrack | null = null
        if (opts.withAudio) {
          externalAudio = await startScreenAudioTrack()
        }

        await publishScreenFromSource(
          r,
          opts.sourceId,
          opts.preset,
          opts.contentHint,
          // 插件已经拿到声音了就别再让 Chromium 采一份 ——
          // 那样通话声会绕一圈又回来
          opts.withAudio && !externalAudio,
          externalAudio
        )
      } catch (err) {
        setError(`屏幕共享失败：${(err as Error).message}`)
      }
      bump()
    },
    [bump]
  )

  const stopScreen = useCallback(async () => {
    const r = roomRef.current
    if (!r) return
    await stopScreenShare(r)
    bump()
  }, [bump])

  /** 用户在设置里改了头像 —— 如果正在语音里，实时同步给同房间的人 */
  const updateAvatar = useCallback(async (raw: string) => {
    const r = roomRef.current
    if (!r) return
    // setAttributes 是**增量合并**的，所以这里只写 avatar，
    // 连接时写的 userId 不会被抹掉
    await applyAttributes(r, { avatar: raw })
  }, [])

  /**
   * 切换音频设备。
   *
   * LiveKit 会把细节处理掉：输入设备影响采集链路；输出设备它会自动给
   * 所有音频元素设 setSinkId —— 不用我们自己去遍历 <audio>。
   */
  const switchDevice = useCallback(
    async (kind: 'audioinput' | 'audiooutput', deviceId: string) => {
      const r = roomRef.current
      if (!r) return
      try {
        await r.switchActiveDevice(kind, deviceId)
      } catch (err) {
        setError(`切换设备失败：${(err as Error).message}`)
      }
      bump()
    },
    [bump]
  )

  /**
   * 广播"我正在看哪一路投屏"。传 track sid；不看了传 null。
   *
   * ⚠️ 用 **participant attribute** 而不是新开一条 WebSocket 消息：
   *    服务端的语音快照本来就会把 attributes 一起带回来，
   *    等于白捡一个"谁在看"的同步通道，不用加接口、不用加消息类型。
   *    代价只是最多 3 秒延迟 —— "有谁在看"这种事完全够。
   */
  const setWatchTarget = useCallback((sid: string | null) => {
    const r = roomRef.current
    if (!r) return
    void applyAttributes(r, { watch: sid ?? '' })
  }, [])

  const isSharing = Boolean(
    room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)
  )

  /**
   * 正在说话的 voiceKey 集合。
   *
   * ⚠️ **不能从服务端拿**。服务端的语音快照是 3 秒一轮的轮询 ——
   *    拿它做"正在说话"会把状态拖成幻灯片。
   *    LiveKit 有专门的 `ActiveSpeakersChanged`（几百毫秒级），所以直接读 room。
   *
   * 代价：只覆盖**你自己所在的房间**。别的语音频道里谁在说话拿不到 ——
   * 那也没关系，你本来就听不见他，显示灰色是诚实的。
   *
   * `tick` 是依赖项：所有房间事件都会 bump 它，说话状态一变就重算。
   */
  const speakingKeys = useMemo(() => {
    const s = new Set<string>()
    if (!room) return s
    for (const p of room.remoteParticipants.values()) {
      if (p.isSpeaking) s.add(voiceKey(p))
    }
    if (room.localParticipant.isSpeaking) s.add(voiceKey(room.localParticipant))
    return s
  }, [room, tick])

  return {
    room,
    status,
    error,
    tick,
    isSharing,
    speakingKeys,
    /** 是否已关闭喇叭（此时所有远端音频都不播放） */
    deafened,
    connect,
    disconnect,
    toggleMic,
    toggleDeafen,
    startScreen,
    stopScreen,
    updateAvatar,
    /**
     * 告诉别人"我正在看哪一路投屏"。
     *
     * 传 track sid；不看了传 null。
     * 走 participant attribute，别人能从服务端的语音快照里读到 ——
     * 于是"谁在看投屏"不需要任何新接口。
     */
    setWatchTarget,
    /** 改麦克风采集参数（降噪开关）。正在开麦的话会自动重新采集 */
    applyMicOptions,
    /** 当前正在用的麦克风 / 扬声器 id。空字符串表示"系统默认" */
    activeInput: getActiveDevice(room, 'audioinput'),
    activeOutput: getActiveDevice(room, 'audiooutput'),
    switchDevice,
    clearError: () => setError(null),
  }
}
