import { useCallback, useEffect, useState } from 'react'
import type { AppConfig } from '../lib/config'
import { CODECS, PRESETS, type ContentHint, type VideoCodecChoice } from '../lib/livekit'
import { acceleratorHint, captureAccelerator, formatAccelerator } from '../lib/shortcuts'
import type { Theme } from '../lib/theme'
import type { MicOptions } from '../hooks/useVoiceRoom'
import { AvatarPicker } from './AvatarPicker'

export type ShareSettings = {
  presetKey: string
  codec: VideoCodecChoice
  contentHint: ContentHint
}

type Props = {
  open: boolean
  config: AppConfig
  share: ShareSettings
  version: string
  devices: { inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }
  activeInputId: string
  activeOutputId: string
  hasVoiceRoom: boolean
  micOptions: MicOptions
  onSetMicOption: (key: keyof MicOptions, value: boolean) => void
  theme: Theme
  onSetTheme: (theme: Theme) => void
  prefs: {
    openAtLogin: boolean
    closeAction: 'ask' | 'tray' | 'quit'
    shortcuts: { mute: string; deafen: string }
    mediaDetect: boolean
    gameDetect: boolean
    /** 用户自己上报的游戏：进程名（小写不带 .exe）→ 显示名 */
    customGames: Record<string, string>
  }
  onSetShortcut: (
    action: 'mute' | 'deafen',
    accel: string
  ) => Promise<{ ok: boolean; reason: string }>
  /** 开关「正在听歌」检测 */
  onSetMediaDetect: (enabled: boolean) => void
  /** 开关「正在玩游戏」检测（和上面那个互相独立） */
  onSetGameDetect: (enabled: boolean) => void
  /**
   * 设置被改了、需要重新读一遍。
   *
   * 上报/删除自定义游戏是在这个组件里发起的，但 `prefs` 是外面传进来的 ——
   * 所以改完得请外面刷新一下，否则界面上还是旧的。
   */
  onPrefsChanged: () => void
  /**
   * 上报一个游戏。**同时**发服务端（全服共享）和存本地（离线也能用）——
   * 由外面做，因为这个组件碰不到聊天连接。
   */
  onReportGame: (exe: string, name: string) => void
  onClose: () => void
  onSaveConfig: (cfg: AppConfig) => void
  onSaveShare: (s: ShareSettings) => void
  onCheckUpdate: () => void
  onSwitchDevice: (kind: 'audioinput' | 'audiooutput', deviceId: string) => void
  onSetCloseAction: (action: 'ask' | 'tray' | 'quit') => void
  onSetOpenAtLogin: (enabled: boolean) => void
}

type SectionKey =
  | 'profile'
  | 'appearance'
  | 'voice'
  | 'screen'
  | 'general'
  | 'advanced'
  | 'about'

/**
 * 左边那列分类。
 *
 * 原来设置是**一条长滚动**：七八节内容上下堆着，找一项得来回翻。
 * 拆成两栏之后每一屏只做一件事，也不用滚了。
 */
const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: 'profile', label: '个人资料' },
  { key: 'appearance', label: '外观' },
  { key: 'voice', label: '语音' },
  { key: 'screen', label: '屏幕共享' },
  { key: 'general', label: '通用' },
  { key: 'advanced', label: '高级' },
  { key: 'about', label: '关于' },
]

export function SettingsDialog({
  open,
  config,
  share,
  version,
  devices,
  activeInputId,
  activeOutputId,
  hasVoiceRoom,
  micOptions,
  onSetMicOption,
  theme,
  onSetTheme,
  prefs,
  onClose,
  onSaveConfig,
  onSaveShare,
  onCheckUpdate,
  onSwitchDevice,
  onSetCloseAction,
  onSetOpenAtLogin,
  onSetShortcut,
  onSetMediaDetect,
  onSetGameDetect,
  onPrefsChanged,
  onReportGame,
}: Props) {
  const [cfg, setCfg] = useState<AppConfig>(config)
  const [sh, setSh] = useState<ShareSettings>(share)
  const [tab, setTab] = useState<SectionKey>('profile')

  /**
   * 当前是否以管理员运行。
   * `null` = 还没查出来（避免先闪一下"普通权限"再变成"管理员"）。
   */
  const [elevated, setElevated] = useState<boolean | null>(null)

  /** 「默认以管理员启动」那个计划任务注册了没有 */
  const [taskExists, setTaskExists] = useState(false)
  const refreshTask = useCallback(() => {
    void window.desktop?.elevateTaskExists?.().then(setTaskExists)
  }, [])

  // ── 上报没被认出来的游戏 ──────────────────────────────────
  const [reportOpen, setReportOpen] = useState(false)
  const [wins, setWins] = useState<{ exe: string; title: string }[]>([])
  const [picked, setPicked] = useState<{ exe: string; title: string } | null>(null)
  const [gameName, setGameName] = useState('')

  const openReport = useCallback(() => {
    setPicked(null)
    setGameName('')
    setWins([])
    setReportOpen(true)
    // 现查 —— 窗口列表过期了就没意义，不缓存
    void window.desktop?.listWindows?.().then((list) => setWins(list ?? []))
  }, [])

  const saveReport = useCallback(() => {
    if (!picked || !gameName.trim()) return
    // 发服务端（共享）+ 存本地（离线也能用），外面一起做
    onReportGame(picked.exe, gameName.trim())
    setReportOpen(false)
    onPrefsChanged()
  }, [picked, gameName, onReportGame, onPrefsChanged])

  useEffect(() => {
    if (!open) return
    setElevated(null)
    void window.desktop?.isElevated?.().then(setElevated)
    refreshTask()
  }, [open, refreshTask])

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>

        <div className="settings-body">
          <nav className="settings-nav">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                className={`settings-nav-item ${tab === s.key ? 'active' : ''}`}
                onClick={() => setTab(s.key)}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="settings-pane">
            {tab === 'profile' && (
              <>
                <label>
                  昵称
                  <input
                    value={cfg.nickname}
                    onChange={(e) => setCfg({ ...cfg, nickname: e.target.value })}
                    placeholder="随便取一个"
                    maxLength={24}
                  />
                </label>
                <AvatarPicker
                  value={cfg.avatar}
                  fallbackText={cfg.nickname}
                  onChange={(a) => setCfg({ ...cfg, avatar: a })}
                />
              </>
            )}

            {tab === 'appearance' && (
              <label>
                界面主题
                <select
                  value={theme}
                  onChange={(e) => onSetTheme(e.target.value === 'light' ? 'light' : 'dark')}
                >
                  <option value="dark">深色</option>
                  <option value="light">浅色</option>
                </select>
              </label>
            )}

            {tab === 'voice' && (
              <>
                <h3>音频设备</h3>
                <label>
                  输入设备（麦克风）
                  <select
                    value={activeInputId}
                    disabled={!hasVoiceRoom}
                    onChange={(e) => onSwitchDevice('audioinput', e.target.value)}
                  >
                    <option value="">系统默认</option>
                    {devices.inputs.map((d, i) => (
                      <option key={d.deviceId || i} value={d.deviceId}>
                        {d.label || `麦克风 ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  输出设备（听声音用）
                  <select
                    value={activeOutputId}
                    disabled={!hasVoiceRoom}
                    onChange={(e) => onSwitchDevice('audiooutput', e.target.value)}
                  >
                    <option value="">系统默认</option>
                    {devices.outputs.map((d, i) => (
                      <option key={d.deviceId || i} value={d.deviceId}>
                        {d.label || `扬声器 ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </label>

                <h3>麦克风处理</h3>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={micOptions.noiseSuppression}
                    onChange={(e) => onSetMicOption('noiseSuppression', e.target.checked)}
                  />
                  降噪
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={micOptions.echoCancellation}
                    onChange={(e) => onSetMicOption('echoCancellation', e.target.checked)}
                  />
                  回声消除
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={micOptions.autoGainControl}
                    onChange={(e) => onSetMicOption('autoGainControl', e.target.checked)}
                  />
                  自动增益
                </label>
              </>
            )}

            {tab === 'screen' && (
              <>
                <label>
                  画质档位
                  <select
                    value={sh.presetKey}
                    onChange={(e) => setSh({ ...sh, presetKey: e.target.value })}
                  >
                    {PRESETS.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  编码器
                  <select
                    value={sh.codec}
                    onChange={(e) => setSh({ ...sh, codec: e.target.value as VideoCodecChoice })}
                  >
                    {CODECS.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  内容提示
                  <select
                    value={sh.contentHint}
                    onChange={(e) =>
                      setSh({ ...sh, contentHint: e.target.value as ShareSettings['contentHint'] })
                    }
                  >
                    <option value="text">文字优先（看代码/网页）</option>
                    <option value="motion">★ 视频优先（看视频/游戏）</option>
                    <option value="detail">细节优先</option>
                    <option value="">不设置</option>
                  </select>
                </label>
                {/* ⚠️ 这一条是**操作指引**，不是解释 —— 选错了症状很明显：
                    「文字优先」放视频 = **卡顿** ✓（编码器一直在保清晰、压帧率）
                    「视频优先」放文档 = **发虚** ✓（缺带宽时降分辨率）
                    把它写出来，用户才知道该选哪个 ✓ */}
                <p className="note-line">
                  放视频/游戏时一定要选「视频优先」—— 选「文字优先」会一直压帧率，看着卡顿。
                  反过来看代码、网页就用「文字优先」，文字才够锐利。
                </p>
                {/* 这一条**必须留着** —— 不写的话用户改完档位发现没变化，
                    会以为设置坏了。它不是"解释"，是操作后果。 */}
                <p className="note-line">改动要停止共享再重新共享才生效。</p>
              </>
            )}

            {tab === 'general' && (
              <>
                <h3>启动与关闭</h3>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={prefs.openAtLogin}
                    onChange={(e) => onSetOpenAtLogin(e.target.checked)}
                  />
                  开机自动启动
                </label>
                <label>
                  点窗口关闭按钮（×）时
                  <select
                    value={prefs.closeAction}
                    onChange={(e) => onSetCloseAction(e.target.value as 'ask' | 'tray' | 'quit')}
                  >
                    <option value="ask">每次询问我</option>
                    <option value="tray">隐藏到托盘（语音不断）</option>
                    <option value="quit">直接退出程序</option>
                  </select>
                </label>

                <h3>快捷键</h3>
                <ShortcutRow
                  label="一键闭麦 / 开麦"
                  value={prefs.shortcuts.mute}
                  onSet={(accel) => onSetShortcut('mute', accel)}
                />
                <ShortcutRow
                  label="一键闭音响 / 开音响"
                  value={prefs.shortcuts.deafen}
                  onSet={(accel) => onSetShortcut('deafen', accel)}
                />
                <p className="note-line">
                  全局快捷键，游戏里也生效。字母和数字要搭配 Ctrl / Alt / Shift。
                </p>

                <h3>状态显示</h3>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={prefs.mediaDetect}
                    onChange={(e) => onSetMediaDetect(e.target.checked)}
                  />
                  让别人看到我在听什么
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={prefs.gameDetect}
                    onChange={(e) => onSetGameDetect(e.target.checked)}
                  />
                  让别人看到我在玩什么
                </label>
                <p className="note-line">
                  在右侧成员列表里显示「正在听：歌名」或「正在玩：游戏名」，
                  玩游戏时优先显示游戏。检测只在本机做，关掉就完全不检测、也不上报。
                </p>

                {/* ── 上报没被认出来的游戏 ──────────────────────
                    内置表不可能覆盖所有游戏，所以留一个入口：
                    从**当前开着的窗口**里挑一个，再起个名字。
                    存本地就够了 —— 别人看到的是解析后的显示名
                    （客户端上报的是名字，不是进程名）。 */}
                <button
                  className="ghost"
                  style={{ marginTop: 4 }}
                  onClick={openReport}
                >
                  没看到你在玩的游戏？上报一个
                </button>

                {Object.keys(prefs.customGames ?? {}).length > 0 && (
                  <div className="custom-games">
                    <div className="custom-games-title">你自己上报的：</div>
                    {Object.entries(prefs.customGames).map(([exe, name]) => (
                      <div className="custom-game-row" key={exe}>
                        <span className="custom-game-name">{name}</span>
                        <span className="muted">{exe}</span>
                        <button
                          className="context-menu-item danger"
                          onClick={() => {
                            void window.desktop?.removeCustomGame(exe).then(onPrefsChanged)
                          }}
                        >
                          删掉
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {reportOpen && (
                  <div className="modal-backdrop" onMouseDown={() => setReportOpen(false)}>
                    <div
                      className="modal report-game"
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      <h3>上报一个游戏</h3>
                      <p className="note-line">
                        从**当前开着的窗口**里挑一个，再给它起个名字。
                        <br />
                        上报会**同步给所有人** —— 谁报过一次，大家以后就都能检测到它了。
                      </p>

                      <div className="report-window-list">
                        {wins.length === 0 && (
                          <div className="context-menu-note">
                            正在读取窗口列表…（列表里只会有**有可见窗口**的程序）
                          </div>
                        )}
                        {wins.map((w) => (
                          <button
                            key={`${w.exe}|${w.title}`}
                            className={`report-window ${picked?.exe === w.exe && picked?.title === w.title ? 'selected' : ''}`}
                            onClick={() => {
                              setPicked(w)
                              // 默认拿窗口标题当名字 —— 用户多半只要改一改，
                              // 比从空白开始填省事
                              setGameName(w.title)
                            }}
                          >
                            <span className="report-window-title">{w.title}</span>
                            <span className="muted">{w.exe}</span>
                          </button>
                        ))}
                      </div>

                      <label className="report-name">
                        显示成什么名字
                        <input
                          value={gameName}
                          maxLength={40}
                          placeholder="例如：英雄联盟"
                          onChange={(e) => setGameName(e.target.value)}
                        />
                      </label>

                      <div className="modal-actions">
                        <button className="ghost" onClick={() => setReportOpen(false)}>
                          取消
                        </button>
                        <button
                          className="primary"
                          disabled={!picked || !gameName.trim()}
                          onClick={saveReport}
                        >
                          保存
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <h3>游戏兼容</h3>                <div className="about-row">
                  <span className="muted small">
                    {elevated === null
                      ? '检查中…'
                      : elevated
                        ? '已以管理员权限运行'
                        : '普通权限运行'}
                  </span>
                  <div className="spacer" />
                  {elevated === false && (
                    <button
                      className="ghost small-btn"
                      onClick={() => void window.desktop?.relaunchElevated?.()}
                    >
                      以管理员重启
                    </button>
                  )}
                </div>

                {/* 「以后都自动」这一档。
                    每次启动都弹 UAC 太烦；Windows 允许中等权限的进程触发
                    一个已注册的高权限任务 —— 所以授权一次之后就能静默提权。 */}
                {elevated === false && (
                  <>
                    <div className="about-row" style={{ marginTop: 8 }}>
                      <span className="muted small">
                        {taskExists ? '已设为默认以管理员启动' : '默认以普通权限启动'}
                      </span>
                      <div className="spacer" />
                      {taskExists ? (
                        <button
                          className="ghost small-btn"
                          onClick={() => {
                            void window.desktop?.unregisterElevateTask?.()
                            setTimeout(refreshTask, 2500)
                          }}
                        >
                          取消默认
                        </button>
                      ) : (
                        <button
                          className="ghost small-btn"
                          onClick={() => {
                            void window.desktop?.registerElevateTask?.()
                            setTimeout(refreshTask, 3500)
                          }}
                        >
                          设为默认
                        </button>
                      )}
                    </div>
                    <p className="note-line">
                      游戏以管理员权限运行时，Windows 会屏蔽普通权限程序的全局快捷键。
                      「设为默认」只需要授权一次，之后每次启动自动提权、不再弹窗。
                    </p>
                  </>
                )}
              </>
            )}

            {tab === 'advanced' && (
              <>
                <label>
                  LiveKit 信令地址
                  <input
                    value={cfg.livekitUrl}
                    onChange={(e) => setCfg({ ...cfg, livekitUrl: e.target.value })}
                    placeholder="ws://你的公网IP:7880"
                  />
                </label>
                <label>
                  后端地址
                  <input
                    value={cfg.apiUrl}
                    onChange={(e) => setCfg({ ...cfg, apiUrl: e.target.value })}
                    placeholder="http://你的公网IP:3005"
                  />
                </label>
                <label>
                  邀请码
                  <input
                    value={cfg.inviteCode}
                    onChange={(e) => setCfg({ ...cfg, inviteCode: e.target.value })}
                    placeholder="服务端 .env 里的 INVITE_CODE"
                  />
                </label>
                <p className="note-line">已经内置在安装包里，换服务器时才需要改。</p>
              </>
            )}

            {tab === 'about' && (
              <div className="about-row">
                <span className="muted small">
                  Voice {version ? `v${version}` : '（开发模式）'}
                </span>
                <div className="spacer" />
                <button className="ghost small-btn" onClick={onCheckUpdate}>
                  检查更新
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button
            onClick={() => {
              onSaveConfig(cfg)
              onSaveShare(sh)
              onClose()
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 一行快捷键设置。
 *
 * 点按钮进入录制状态，之后按下什么就绑什么 —— 比让用户手写
 * `Control+Shift+M` 这种写法友好得多，也不会写错。
 *
 * ⚠️ 录制时的 keydown 监听挂在 **document 的捕获阶段**：
 *    要抢在别的监听之前拿到事件并 `stopPropagation`，
 *    否则按 Esc 想取消录制，结果把整个设置弹窗也关了。
 */
function ShortcutRow({
  label,
  value,
  onSet,
}: {
  label: string
  value: string
  onSet: (accel: string) => Promise<{ ok: boolean; reason: string }>
}) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!recording) return

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'Escape') {
        setRecording(false)
        setError(null)
        return
      }

      // 组合还没打完（只按住了修饰键）—— 继续等
      const hint = acceleratorHint(e)
      if (hint) {
        setError(hint)
        return
      }

      const accel = captureAccelerator(e)
      if (!accel) return

      setRecording(false)
      setError(null)

      void onSet(accel).then((res) => {
        if (res.ok) return
        setError(
          res.reason === 'duplicate'
            ? '和另一个快捷键重了，换一个'
            : '这个组合被别的程序占用了，换一个试试'
        )
      })
    }

    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [recording, onSet])

  return (
    <div className="shortcut-block">
      <div className="shortcut-row">
        <span>{label}</span>
        <div className="spacer" />
        <button
          className={recording ? 'ok' : 'ghost'}
          onClick={() => {
            setRecording(true)
            setError(null)
          }}
          title={recording ? '按下组合键，Esc 取消' : '点击后按下新的组合键'}
        >
          {recording ? '按下按键…' : formatAccelerator(value)}
        </button>
        {value && (
          <button
            className="ghost tiny"
            onClick={() => void onSet('')}
            title="清除这个快捷键"
          >
            ×
          </button>
        )}
      </div>
      {error && <p className="shortcut-error">{error}</p>}
    </div>
  )
}
