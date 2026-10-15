import { useCallback, useEffect, useState } from 'react'
import type { AppConfig } from '../lib/config'
import { CODECS, PRESETS, type ContentHint, type VideoCodecChoice } from '../lib/livekit'
import { acceleratorHint, captureAccelerator, formatAccelerator } from '../lib/shortcuts'
import type { Theme } from '../lib/theme'
import type { MicOptions } from '../hooks/useVoiceRoom'
import { AvatarPicker } from './AvatarPicker'
import { LANGS, useLang, useSetLang, useT, type Lang, type MsgKey } from '../lib/i18n'

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
const SECTIONS: { key: SectionKey; labelKey: MsgKey }[] = [
  { key: 'profile', labelKey: 'settings.tab.profile' },
  { key: 'appearance', labelKey: 'settings.tab.appearance' },
  { key: 'voice', labelKey: 'settings.tab.voice' },
  { key: 'screen', labelKey: 'settings.tab.screen' },
  { key: 'general', labelKey: 'settings.tab.general' },
  { key: 'advanced', labelKey: 'settings.tab.advanced' },
  { key: 'about', labelKey: 'settings.tab.about' },
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
  /** 界面文案 ✓（设置面板目前只搬了分页标签和语言那一块 ✓ 其余还是写死的中文 ✗） */
  const t = useT()
  const lang = useLang()
  const setLang = useSetLang()
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
        <h2>{t('settings.title')}</h2>

        <div className="settings-body">
          <nav className="settings-nav">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                className={`settings-nav-item ${tab === s.key ? 'active' : ''}`}
                onClick={() => setTab(s.key)}
              >
                {s.labelKey ? t(s.labelKey) : s.key}
              </button>
            ))}
          </nav>

          <div className="settings-pane">
            {tab === 'profile' && (
              <>
                <label>
                  {t('settings.nickname')}
                  <input
                    value={cfg.nickname}
                    onChange={(e) => setCfg({ ...cfg, nickname: e.target.value })}
                    placeholder={t('settings.nicknamePlaceholder')}
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
              <>
                <label>
                  {t('settings.theme')}
                  <select
                    value={theme}
                    onChange={(e) => onSetTheme(e.target.value === 'light' ? 'light' : 'dark')}
                  >
                    <option value="dark">{t('settings.themeDark')}</option>
                    <option value="light">{t('settings.themeLight')}</option>
                  </select>
                </label>

                {/* 界面语言 ✓
                    ⚠️ 它放在「外观」而不是「通用」✗
                       语言和主题一样是"看着舒不舒服"这一类的 ✓
                       而且是**立刻生效**的 ✓ 和主题的行为也一致 ✓ */}
                <label>
                  {t('settings.language')}
                  <select
                    value={lang}
                    onChange={(e) => {
                      // ⚠️ 不要直接 `as Lang` 糊过去 ✗
                      //    选项是我们自己渲染的 ✓ 理论上一定合法 ✓
                      //    但校验一次是免费的 ✓ 而它挡住的是一整类
                      //    "将来有人加了选项忘了同步"的 bug ✓
                      const v = e.target.value
                      if (v in LANGS) setLang(v as Lang)
                    }}
                  >
                    {Object.entries(LANGS).map(([code, info]) => (
                      <option key={code} value={code}>
                        {info.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="note-line">{t('settings.languageHint')}</p>
              </>
            )}

            {tab === 'voice' && (
              <>
                <h3>{t('settings.audioDevices')}</h3>
                <label>
                  {t('settings.inputDevice')}
                  <select
                    value={activeInputId}
                    disabled={!hasVoiceRoom}
                    onChange={(e) => onSwitchDevice('audioinput', e.target.value)}
                  >
                    <option value="">{t('settings.systemDefault')}</option>
                    {devices.inputs.map((d, i) => (
                      <option key={d.deviceId || i} value={d.deviceId}>
                        {d.label || t('settings.micN', { n: i + 1 })}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('settings.outputDevice')}
                  <select
                    value={activeOutputId}
                    disabled={!hasVoiceRoom}
                    onChange={(e) => onSwitchDevice('audiooutput', e.target.value)}
                  >
                    <option value="">{t('settings.systemDefault')}</option>
                    {devices.outputs.map((d, i) => (
                      <option key={d.deviceId || i} value={d.deviceId}>
                        {d.label || t('settings.speakerN', { n: i + 1 })}
                      </option>
                    ))}
                  </select>
                </label>

                <h3>{t('settings.micProcessing')}</h3>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={micOptions.noiseSuppression}
                    onChange={(e) => onSetMicOption('noiseSuppression', e.target.checked)}
                  />
                  {t('settings.noiseSuppression')}
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={micOptions.echoCancellation}
                    onChange={(e) => onSetMicOption('echoCancellation', e.target.checked)}
                  />
                  {t('settings.echoCancellation')}
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={micOptions.autoGainControl}
                    onChange={(e) => onSetMicOption('autoGainControl', e.target.checked)}
                  />
                  {t('settings.autoGain')}
                </label>
              </>
            )}

            {tab === 'screen' && (
              <>
                <label>
                  {t('settings.quality')}
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
                  {t('settings.codec')}
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
                  {t('settings.contentHint')}
                  <select
                    value={sh.contentHint}
                    onChange={(e) =>
                      setSh({ ...sh, contentHint: e.target.value as ShareSettings['contentHint'] })
                    }
                  >
                    <option value="text">{t('settings.hintText')}</option>
                    <option value="motion">{t('settings.hintMotion')}</option>
                    <option value="detail">{t('settings.hintDetail')}</option>
                    <option value="">{t('settings.hintNone')}</option>
                  </select>
                </label>
                {/* ⚠️ 这一条是**操作指引**，不是解释 —— 选错了症状很明显：
                    「文字优先」放视频 = **卡顿** ✓（编码器一直在保清晰、压帧率）
                    「视频优先」放文档 = **发虚** ✓（缺带宽时降分辨率）
                    把它写出来，用户才知道该选哪个 ✓ */}
                <p className="note-line">
                  {t('settings.hintTip')}
                </p>
                {/* 这一条**必须留着** —— 不写的话用户改完档位发现没变化，
                    会以为设置坏了。它不是"解释"，是操作后果。 */}
                <p className="note-line">{t('settings.shareRestartNote')}</p>
              </>
            )}

            {tab === 'general' && (
              <>
                <h3>{t('settings.startup')}</h3>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={prefs.openAtLogin}
                    onChange={(e) => onSetOpenAtLogin(e.target.checked)}
                  />
                  {t('settings.openAtLogin')}
                </label>
                <label>
                  {t('settings.closeAction')}
                  <select
                    value={prefs.closeAction}
                    onChange={(e) => onSetCloseAction(e.target.value as 'ask' | 'tray' | 'quit')}
                  >
                    <option value="ask">{t('settings.closeAsk')}</option>
                    <option value="tray">{t('settings.closeTray')}</option>
                    <option value="quit">{t('settings.closeQuit')}</option>
                  </select>
                </label>

                <h3>{t('settings.shortcuts')}</h3>
                <ShortcutRow
                  label={t('settings.shortcutMic')}
                  value={prefs.shortcuts.mute}
                  onSet={(accel) => onSetShortcut('mute', accel)}
                />
                <ShortcutRow
                  label={t('settings.shortcutDeafen')}
                  value={prefs.shortcuts.deafen}
                  onSet={(accel) => onSetShortcut('deafen', accel)}
                />
                <p className="note-line">
                  {t('settings.shortcutNote')}
                </p>

                <h3>{t('settings.statusDisplay')}</h3>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={prefs.mediaDetect}
                    onChange={(e) => onSetMediaDetect(e.target.checked)}
                  />
                  {t('settings.showListening')}
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={prefs.gameDetect}
                    onChange={(e) => onSetGameDetect(e.target.checked)}
                  />
                  {t('settings.showPlaying')}
                </label>
                <p className="note-line">
                  {t('settings.statusNote')}
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
                  {t('settings.reportGameCta')}
                </button>

                {Object.keys(prefs.customGames ?? {}).length > 0 && (
                  <div className="custom-games">
                    <div className="custom-games-title">{t('settings.customGames')}</div>
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
                          {t('settings.remove')}
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
                      <h3>{t('settings.reportTitle')}</h3>
                      <p className="note-line">
                        {t('settings.reportHint')}
                        <br />
                        {t('settings.reportSync')}
                      </p>

                      <div className="report-window-list">
                        {wins.length === 0 && (
                          <div className="context-menu-note">
                            {t('settings.reportLoading')}
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
                        {t('settings.reportName')}
                        <input
                          value={gameName}
                          maxLength={40}
                          placeholder={t('settings.reportNamePlaceholder')}
                          onChange={(e) => setGameName(e.target.value)}
                        />
                      </label>

                      <div className="modal-actions">
                        <button className="ghost" onClick={() => setReportOpen(false)}>
                          {t('settings.cancel')}
                        </button>
                        <button
                          className="primary"
                          disabled={!picked || !gameName.trim()}
                          onClick={saveReport}
                        >
                          {t('settings.save')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <h3>{t('settings.gameCompat')}</h3>                <div className="about-row">
                  <span className="muted small">
                    {elevated === null
                      ? t('settings.checking')
                      : elevated
                        ? t('settings.adminRunning')
                        : t('settings.normalRunning')}
                  </span>
                  <div className="spacer" />
                  {elevated === false && (
                    <button
                      className="ghost small-btn"
                      onClick={() => void window.desktop?.relaunchElevated?.()}
                    >
                      {t('settings.restartAsAdmin')}
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
                        {taskExists ? t('settings.adminDefaultOn') : t('settings.adminDefaultOff')}
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
                          {t('settings.adminUnset')}
                        </button>
                      ) : (
                        <button
                          className="ghost small-btn"
                          onClick={() => {
                            void window.desktop?.registerElevateTask?.()
                            setTimeout(refreshTask, 3500)
                          }}
                        >
                          {t('settings.adminSet')}
                        </button>
                      )}
                    </div>
                    <p className="note-line">
                      {t('settings.adminNote')}
                    </p>
                  </>
                )}
              </>
            )}

            {tab === 'advanced' && (
              <>
                <label>
                  {t('settings.livekitUrl')}
                  <input
                    value={cfg.livekitUrl}
                    onChange={(e) => setCfg({ ...cfg, livekitUrl: e.target.value })}
                    placeholder="ws://你的公网IP:7880"
                  />
                </label>
                <label>
                  {t('settings.apiUrl')}
                  <input
                    value={cfg.apiUrl}
                    onChange={(e) => setCfg({ ...cfg, apiUrl: e.target.value })}
                    placeholder="http://你的公网IP:3005"
                  />
                </label>
                <label>
                  {t('settings.inviteCode')}
                  <input
                    value={cfg.inviteCode}
                    onChange={(e) => setCfg({ ...cfg, inviteCode: e.target.value })}
                    placeholder={t('settings.invitePlaceholder')}
                  />
                </label>
                <p className="note-line">{t('settings.inviteNote')}</p>
              </>
            )}

            {tab === 'about' && (
              <div className="about-row">
                <span className="muted small">
                  Voice {version ? `v${version}` : t('settings.devMode')}
                </span>
                <div className="spacer" />
                <button className="ghost small-btn" onClick={onCheckUpdate}>
                  {t('settings.checkUpdate')}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            {t('settings.cancel')}
          </button>
          <button
            onClick={() => {
              onSaveConfig(cfg)
              onSaveShare(sh)
              onClose()
            }}
          >
            {t('settings.save')}
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
  /**
   * ⚠️ 子组件要**自己取一次** t ✗
   *    它不在主组件的作用域里 ✓ 从外面传进来只会多一层没用的参数 ✓
   *    （漏了这一步的话 typecheck 会立刻报 "Cannot find name 't'" ✓
   *      真报了 6 处 ✓ —— 这就是为什么"漏翻译/漏接线"不用靠人眼去查 ✓）
   */
  const t = useT()

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
            ? t('settings.shortcutConflict')
            : t('settings.shortcutTaken')
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
          title={recording ? t('settings.shortcutRecordTip') : t('settings.shortcutClickTip')}
        >
          {recording ? t('settings.shortcutRecording') : formatAccelerator(value)}
        </button>
        {value && (
          <button
            className="ghost tiny"
            onClick={() => void onSet('')}
            title={t('settings.shortcutClear')}
          >
            ×
          </button>
        )}
      </div>
      {error && <p className="shortcut-error">{error}</p>}
    </div>
  )
}
