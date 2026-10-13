import { useEffect, useState } from 'react'
import {
  avatarOf,
  byJoinOrder,
  refKey,
  voiceKey,
  withSuffixes,
  type VoiceMember,
  type VoiceRooms,
} from '../lib/names'
import { Avatar } from './Avatar'

export type Channel = {
  id: string
  name: string
  kind: 'text' | 'voice'
}

export type ServerHeaderInfo = {
  name: string
  /** 序列化后的头像 */
  avatar: string
}

/** withSuffixes 之后的语音成员：多了个用于显示的 display */
type VoiceRow = VoiceMember & { display: string }

/**
 * 右键菜单。
 *
 * 两种目标：频道（删除）和人（音量）。用一个联合类型而不是两个 state ——
 * 同一时刻只可能开一个菜单。
 */
type MenuState =
  | { kind: 'channel'; x: number; y: number; channel: Channel }
  | { kind: 'member'; x: number; y: number; key: string; name: string }

type Props = {
  server: ServerHeaderInfo
  channels: Channel[]
  activeChannelId: string | null
  /** 房间名 -> 里面的人（含闭麦/共享状态）。由服务端轮询 LiveKit 后推送 */
  voiceRooms: VoiceRooms
  /** 客户端自己所在的房间，用来给自己加个标记 */
  joinedRoomId: string | null
  /** 我自己的 userId。用来认出"列表里哪一行是我" —— 对自己右键不该出音量菜单 */
  myUserId: string
  /**
   * 正在说话的 voiceKey 集合。
   *
   * ⚠️ 只有**你所在的**那个频道才有内容 —— 它来自 LiveKit 的
   *    ActiveSpeakersChanged，而客户端只连着自己那个房间。
   *    别的频道里的人自然是空的（你也听不见他们，显示灰色是对的）。
   */
  speakingKeys: Set<string>
  /** 管理员以上才能增删频道 / 改服务器信息 */
  canManage: boolean
  /** 和后端的连接状态 */
  connected: boolean
  /** 当前在线人数 */
  onlineCount: number
  /** 云端文件数量，显示在入口右边 */
  fileCount: number
  onSelect: (channel: Channel) => void
  onCreateChannel: () => void
  onDeleteChannel: (channelId: string) => void
  onOpenServerSettings: () => void
  onOpenFiles: () => void
  /** 每个人的音量（key 是 voiceKey，值 0~1）。没有条目就是默认 100% */
  volumes: Record<string, number>
  onSetVolume: (key: string, value: number) => void
}

export function ChannelList({
  server,
  channels,
  activeChannelId,
  voiceRooms,
  joinedRoomId,
  myUserId,
  speakingKeys,
  canManage,
  connected,
  onlineCount,
  fileCount,
  onSelect,
  onCreateChannel,
  onDeleteChannel,
  onOpenServerSettings,
  onOpenFiles,
  volumes,
  onSetVolume,
}: Props) {
  const text = channels.filter((c) => c.kind === 'text')
  const voice = channels.filter((c) => c.kind === 'voice')

  /**
   * 右键菜单。
   *
   * 为什么删除要挪到这里：悬停就冒出来的 × 离频道名太近，
   * 点频道的时候手一滑就删了 —— 而删频道是不可逆的。
   * 右键是"我要对这个东西做点什么"的明确表态，误触不了。
   */
  const [menu, setMenu] = useState<MenuState | null>(null)

  useEffect(() => {
    if (!menu) return

    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }

    // ⚠️ 用冒泡阶段而不是捕获阶段：菜单自己会 stopPropagation，
    //    用捕获的话点菜单项的瞬间就被关掉了，onClick 根本轮不到执行。
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    // 菜单是 fixed 定位，跟着滚动会飘走 —— 干脆滚了就关掉
    window.addEventListener('wheel', close, { passive: true })

    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
      window.removeEventListener('wheel', close)
    }
  }, [menu])

  /** 菜单大概占多大，用来做贴边收拢。按最高的那种（人 + 音量条）算 */
  const MENU_W = 200
  const MENU_H = 140

  /** 把鼠标位置换算成菜单左上角，并收进窗口内 */
  function menuPos(e: React.MouseEvent) {
    return {
      x: Math.max(4, Math.min(e.clientX, window.innerWidth - MENU_W - 8)),
      y: Math.max(4, Math.min(e.clientY, window.innerHeight - MENU_H - 8)),
    }
  }

  const openMenu = (e: React.MouseEvent, channel: Channel) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ kind: 'channel', ...menuPos(e), channel })
  }

  /**
   * 对自己右键**不出菜单**。
   *
   * 那个菜单里只有"调音量"一项 —— 而调自己的音量没有意义
   * （自己的声音本来就不会播给自己听，本地麦克风增益在设置里有）。
   * 弹出来只会让人以为坏了。
   */
  const openMemberMenu = (e: React.MouseEvent, m: VoiceRow) => {
    if (myUserId && voiceKey(m) === myUserId) return
    e.preventDefault()
    e.stopPropagation()
    setMenu({ kind: 'member', ...menuPos(e), key: voiceKey(m), name: m.display })
  }

  // 默认频道不给删 —— 删光了就没地方说话了
  const deletable = (id: string) => canManage && id !== 'general'

  return (
    <>
      <div className="channel-list">
      {/* 服务器身份 + 连接状态。点一下打开服务器设置（只有管理员以上能点） */}
      <button
        className="server-header"
        onClick={onOpenServerSettings}
        disabled={!canManage}
        title={
          canManage ? `${server.name} · 点击打开服务器设置` : server.name
        }
      >
        <Avatar raw={server.avatar} name={server.name} size={34} />

        <span className="server-header-text">
          <span className="server-header-name">{server.name}</span>
          {/* 连接状态左对齐贴在名字下面 */}
          <span className={`server-header-status ${connected ? 'on' : 'off'}`}>
            <span className={`dot ${connected ? 'on' : 'off'}`} />
            {connected ? `已连接 · ${onlineCount} 人在线` : '未连接'}
          </span>
        </span>

        {canManage && <span className="server-header-gear">⚙</span>}
      </button>

      {/* 云端文件。放在频道列表最上面 —— 它不属于任何频道，
          而是全服务器共用的一个"文件柜" */}
      <button className="cloud-entry" onClick={onOpenFiles} title="上传文件、下载别人传的文件">
        <span className="cloud-entry-icon">📁</span>
        <span className="cloud-entry-name">云端文件</span>
        {fileCount > 0 && <span className="cloud-entry-count">{fileCount}</span>}
      </button>

      {text.length > 0 && (
        <>
          <div className="channel-group-title">文字频道</div>
          {text.map((c) => (
            <div key={c.id} className="channel-row" onContextMenu={(e) => openMenu(e, c)}>
              <button
                className={`channel-item ${activeChannelId === c.id ? 'active' : ''}`}
                onClick={() => onSelect(c)}
                title={`#${c.name}`}
              >
                <span className="channel-hash">#</span>
                {c.name}
              </button>
              {/* 删除挪到右键菜单了 —— 悬停就冒出来的 × 离频道名太近，
                  点频道时手一滑就删了，而删频道不可逆 */}
            </div>
          ))}
        </>
      )}

      {voice.length > 0 && (
        <>
          <div className="channel-group-title">语音频道</div>
          {voice.map((c) => {
            {/* 按**进频道的先后**排，不按 LiveKit 返回的顺序 ——
                那个不保证稳定，会让列表每 3 秒重排一次、看着像在乱跳 */}
            const members = withSuffixes(byJoinOrder(voiceRooms[c.id] ?? []))
            const joined = joinedRoomId === c.id
            return (
              <div key={c.id} className="voice-channel-block">
                <div className="channel-row" onContextMenu={(e) => openMenu(e, c)}>
                  <button
                    className={`channel-item ${activeChannelId === c.id ? 'active' : ''}`}
                    onClick={() => onSelect(c)}
                    title={`${c.name}（${joined ? '你在这个频道里' : '点击加入'}）`}
                  >
                    <span className="channel-hash">🔊</span>
                    {c.name}
                  </button>

                  {/* 「离开频道」的 × 去掉了 —— 左下角面板里那个红色的
                      挂断图标现在就是这条路，而且位置也和"我在哪个频道"
                      那一行对得上。同一个动作放两处只会让人犹豫点哪个。 */}
                </div>

                {/* Discord 的做法：把这个频道里的人直接列在频道下面。
                    闭麦 / 共享状态只能由服务端提供 —— 客户端自己只看得见
                    它加入的那个房间。 */}
                {members.length > 0 && (
                  <div className="voice-members">
                    {members.map((m) => {
                      // 音量按"人"记，所以他自己那行也能看出调过没有
                      const vol = volumes[voiceKey(m)] ?? 1
                      const key = voiceKey(m)
                      const self = Boolean(myUserId) && key === myUserId

                      /**
                       * 麦克风灯的状态。四种，优先级从高到低：
                       *
                       *   deaf      红  —— 连喇叭也关了（这会顺带闭麦）
                       *   muted     黄  —— 只闭了麦
                       *   speaking  绿  —— 开着麦而且**正在说话**
                       *   idle      灰  —— 开着麦但没出声
                       *
                       * "正在说话"必须**实时**：走 LiveKit 的 ActiveSpeakersChanged，
                       * 不是服务端那 3 秒一轮的快照（那个最多只能告诉你"麦开着"）。
                       * 所以不在同一个频道里的人拿不到这个信息，一律显示灰 ——
                       * 这也是对的：你本来就听不见他。
                       */
                      const deaf = m.attributes?.deaf === '1'
                      const speaking = speakingKeys.has(key)
                      const micState = deaf
                        ? 'deaf'
                        : !m.mic
                          ? 'muted'
                          : speaking
                            ? 'speaking'
                            : 'idle'

                      const micTitle = {
                        deaf: '已闭麦，喇叭也关了',
                        muted: '已闭麦',
                        speaking: '正在说话',
                        idle: '麦克风开着',
                      }[micState]

                      return (
                        <div
                          key={refKey(m)}
                          className="voice-member"
                          onContextMenu={(e) => openMemberMenu(e, m)}
                          title={self ? m.display : `${m.display} · 右键调整音量`}
                        >
                          <Avatar raw={avatarOf(m)} name={m.display} size={20} />
                          <span className="voice-member-name" title={m.display}>
                            {m.display}
                          </span>

                          {/* 调过音量才显示，平时不占地方 */}
                          {vol !== 1 && (
                            <span
                              className="voice-member-vol"
                              title={`音量 ${Math.round(vol * 100)}%`}
                            >
                              {vol === 0 ? '🔇' : `${Math.round(vol * 100)}%`}
                            </span>
                          )}

                          {/* 投屏灯。**位置恒定** —— 不投屏时也占着那一格，
                              否则右边那个麦克风灯会被推来推去、各人之间对不齐。 */}
                          <span className="voice-member-share">
                            {m.sharing && <span className="led led-share" title="正在共享屏幕" />}
                          </span>

                          <span className={`led led-mic led-${micState}`} title={micTitle} />
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </>
      )}

      {canManage && (
        <button className="channel-add" onClick={onCreateChannel}>
          + 创建频道
        </button>
      )}

      {channels.length === 0 && (
        <div className="muted small" style={{ padding: '12px 16px' }}>
          还没连上服务端，连上后这里会显示频道列表。
        </div>
      )}
      </div>

      {/* 右键菜单。刻意放在滚动容器**外面** ——
          fixed 定位的元素待在 overflow 容器里容易被裁掉 */}
      {menu && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          // 菜单自己吞掉 mousedown，避免被"点别处就关"的监听顺手关掉，
          // 那样里面的按钮（尤其是音量滑块）根本轮不到触发
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="context-menu-title">{menu.kind === 'channel' ? menu.channel.name : menu.name}</div>

          {menu.kind === 'channel' ? (
            deletable(menu.channel.id) ? (
              <button
                className="context-menu-item danger"
                onClick={() => {
                  const id = menu.channel.id
                  setMenu(null)
                  onDeleteChannel(id)
                }}
              >
                删除频道
              </button>
            ) : (
              <div className="context-menu-note">
                {menu.channel.id === 'general'
                  ? '默认频道不能删除'
                  : '只有管理员以上能删除频道'}
              </div>
            )
          ) : (
            <VolumeSlider
              value={volumes[menu.key] ?? 1}
              onChange={(v) => onSetVolume(menu.key, v)}
              onReset={() => {
                onSetVolume(menu.key, 1)
                setMenu(null)
              }}
            />
          )}
        </div>
      )}
    </>
  )
}

/**
 * 音量滑块。
 *
 * 单独拆出来是因为它拖的时候会频繁 onChange，拆开后只有它自己重渲染，
 * 整个频道列表（含成员头像）不用跟着重画。
 *
 * 上限 200%：100% 以上是**增益**，给麦克风特别小的人用。
 * 增益走的是 Web Audio 的 GainNode（元素自身的 volume 规范上封顶 1），
 * 具体见 App.tsx 的 applyTrackVolume。
 */
function VolumeSlider({
  value,
  onChange,
  onReset,
}: {
  value: number
  onChange: (v: number) => void
  onReset: () => void
}) {
  return (
    <>
      <div className="context-menu-slider">
        <div className="context-menu-slider-head">
          <span>音量</span>
          <span className="muted">
            {value === 0 ? '静音' : `${Math.round(value * 100)}%`}
            {value > 1 ? '（增益）' : ''}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={200}
          value={Math.round(value * 100)}
          // 拖动时别把菜单关了 —— 用户常常要来回试几下
          onChange={(e) => onChange(Number(e.target.value) / 100)}
        />
      </div>

      {value !== 1 && (
        <button className="context-menu-item" onClick={onReset}>
          恢复默认音量
        </button>
      )}
    </>
  )
}
