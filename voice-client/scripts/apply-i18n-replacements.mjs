/**
 * 批量做字面量替换（给多语言搬运用）。
 *
 * 跑法：node scripts/apply-i18n-replacements.mjs
 *
 * ── ⚠️ 为什么不用 PowerShell 干这件事 ✗ ─────────────────────
 *   这一轮我用 PowerShell 做替换，被引号/转义坑了**三次**：
 *     ① `` `v `` 被当成垂直制表符 ✓
 *     ② `${m.pinned_by}` 被当成变量展开 ✓
 *     ③ `\"` 不是 PowerShell 的转义（要用 `` `" ``）✓
 *   每一次都表现为"某条没匹配到" ✓ 而**最难查的是第 ② 种**：
 *   它匹配到了、但**替换内容是错的** ✓ 会把代码写坏 ✗（真写坏过一次 ✓）
 *
 *   → 换成一个 Node 脚本 ✓ 里面全是普通字符串 ✓ 没有 shell 参与 ✓
 *     规则简单到不可能出错：**写得跟源码里一模一样**就行 ✓
 *
 * ── 安全设计（照抄之前 PowerShell 版本里那个好东西 ✓）──────
 *   任何一条匹配不到 → **整批不写文件** ✗ 并且把没中的列出来 ✓
 *   宁可这次白跑 ✓ 也不能改一半留一半 ✓
 *   （改一半的代码最难查：有的地方翻了、有的没翻 ✓ 而且 typecheck 可能是绿的 ✓）
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** [文件, [[原文, 替换后], …]] */
const BATCHES = [
  [
    'src/renderer/src/App.tsx',
    [
      // ── 语音面板 ──
      ['<>正在连接…</>', "<>{t('voice.connecting')}</>"],
      ['<>重连中…</>', "<>{t('voice.reconnecting')}</>"],
      ['<>已连接语音</>', "<>{t('voice.connected')}</>"],
      ['<>未加入语音频道</>', "<>{t('voice.notInChannel')}</>"],
      [
        '{participants.length} 人 · {AUDIO_SPEC}',
        "{t('voice.peopleCount', { n: participants.length })} · {AUDIO_SPEC}",
      ],
      ["{voice.deafened ? ' · 已关喇叭' : ''}", "{voice.deafened ? t('voice.deafenedSuffix') : ''}"],
      [
        "voice.deafened ? '关闭喇叭时无法单独开麦' : micOn ? '闭麦（开麦中）' : '开麦（已闭麦）'",
        "voice.deafened ? t('voice.micDeafened') : micOn ? t('voice.micOn') : t('voice.micOff')",
      ],
      [
        "title={voice.deafened ? '恢复收听（当前已静音）' : '静音 —— 关掉所有别人的声音（会同时闭麦）'}",
        "title={voice.deafened ? t('voice.unmuteTitle') : t('voice.muteTitle')}",
      ],
      ['title="退出语音频道"', "title={t('voice.leaveTitle')}"],
      ['title="停止共享屏幕"', "title={t('voice.stopShareTitle')}"],
      ['            停止\n', "            {t('voice.stop')}\n"],
      ['title="共享屏幕"', "title={t('voice.shareTitle')}"],
      ['            投屏\n', "            {t('voice.share')}\n"],
      [
        'onClick={() => setSettingsOpen(true)} title="设置">',
        "onClick={() => setSettingsOpen(true)} title={t('voice.settings')}>",
      ],
      ['          设置\n', "          {t('voice.settings')}\n"],

      // ── 成员列表 ──
      [
        '{isMe && <span className="muted"> （我）</span>}',
        '{isMe && <span className="muted">{t(\'member.meSuffix\')}</span>}',
      ],
      ['title="正在语音频道里"', "title={t('member.inVoice')}"],
      ['title="拖动调整左侧宽度"', "title={t('app.resizeLeft')}"],
      ['title="拖动调整右侧宽度"', "title={t('app.resizeRight')}"],
      [
        '          成员 · {onlineMembers.length} 在线 / {members.length} 总计\n',
        "          {t('members.header', { online: onlineMembers.length, total: members.length })}\n",
      ],
      [
        '<div className="member-offline-title">离线 — {offlineMembers.length}</div>',
        '<div className="member-offline-title">{t(\'members.offlineHeader\', { n: offlineMembers.length })}</div>',
      ],
      ['            还没有成员\n', "            {t('members.empty')}\n"],
      [
        '<div className="context-menu-note">这是你自己</div>',
        '<div className="context-menu-note">{t(\'members.thisIsYou\')}</div>',
      ],
      ['                私聊\n', "                {t('members.dm')}\n"],
      [
        "{memberMenu.role === 'admin' ? '取消管理员' : '设为管理员'}",
        "{memberMenu.role === 'admin' ? t('members.revokeAdmin') : t('members.makeAdmin')}",
      ],
      ['                  移除成员\n', "                  {t('members.remove')}\n"],

      // ── 投屏舞台 ──
      [
        "{screenShares.length > 1 ? `（共 ${screenShares.length} 路）` : ''}",
        "{screenShares.length > 1 ? t('stage.shareCount', { n: screenShares.length }) : ''}",
      ],
      [
        '<span className="stage-invite-cta">点击观看</span>',
        '<span className="stage-invite-cta">{t(\'stage.clickToWatch\')}</span>',
      ],
      [
        "正在共享{screenShares.length > 1 ? ` · 共 ${screenShares.length} 路` : ''}",
        "{t('stage.sharingLabel')}{screenShares.length > 1 ? ' ·' + t('stage.shareCount', { n: screenShares.length }) : ''}",
      ],
      [
        '<span className="stage-volume" title="共享声音的音量">',
        '<span className="stage-volume" title={t(\'stage.screenVolume\')}>',
      ],
      [
        "title={isFullscreen ? '退出全屏（也可以按 Esc）' : '全屏观看'}",
        "title={isFullscreen ? t('stage.exitFullscreenTitle') : t('stage.enterFullscreenTitle')}",
      ],
      [
        "{isFullscreen ? '退出全屏' : '⛶ 全屏'}",
        "{isFullscreen ? t('stage.exitFullscreen') : t('stage.enterFullscreen')}",
      ],
      ['title="画面收起来，聊天区变大（还在接收画面）"', "title={t('stage.collapseTitle')}"],
      ['                      收起\n', "                      {t('stage.collapse')}\n"],
      ['title="不看这个投屏了 —— 同时停止接收画面，省流量"', "title={t('stage.quitTitle')}"],
      ['                      退出投屏\n', "                      {t('stage.quit')}\n"],
      ['              退出投屏\n', "              {t('stage.quit')}\n"],
      [
        "title={`正在观看：${viewers.allNames.join('、')}`}",
        "title={t('stage.viewersTitle', { names: viewers.allNames.join('、') })}",
      ],
      ['title="拖动调整画面大小"', "title={t('stage.resize')}"],
      [
        '              🖥 {screenName} 正在共享屏幕\n',
        "              🖥 {screenName} {t('stage.sharingLabel')}\n",
      ],
      [
        "{screenShares.length > 1 ? `（还有 ${screenShares.length - 1} 路）` : ''} ·",
        "{screenShares.length > 1 ? t('stage.moreCount', { n: screenShares.length - 1 }) : ''} ·",
      ],
      ['              点击展开\n', "              {t('stage.clickToExpand')}\n"],

      // ── P2P 徽章 ──
      [
        "{ text: '直连', cls: 'ok', tip: '画面在你们两台机器之间直接传，不经过服务器' }",
        "{ text: t('p2p.direct'), cls: 'ok', tip: t('p2p.directTip') }",
      ],
      [
        "{ text: '经服务器', cls: 'warn', tip: '这一路打不通直连，走服务器中转（画面照常，只是费服务器流量）' }",
        "{ text: t('p2p.relay'), cls: 'warn', tip: t('p2p.relayTip') }",
      ],
      [
        "{ text: '直连中…', cls: '', tip: '正在尝试建立直连，还没成功前走服务器' }",
        "{ text: t('p2p.connecting'), cls: '', tip: t('p2p.connectingTip') }",
      ],

      // ── 通知 ──
      [
        "useState<ServerInfo>({ name: '我的服务器', avatar: '' })",
        "useState<ServerInfo>({ name: t('app.defaultServerName'), avatar: '' })",
      ],
      [
        "setNotice({ text: 'Voice 已经在运行了，已经帮你切回这个窗口', kind: 'info' })",
        "setNotice({ text: t('app.alreadyRunning'), kind: 'info' })",
      ],
      [
        "setNotice({ text: '你已被移出这个服务器', kind: 'error' })",
        "setNotice({ text: t('app.removedFromServer'), kind: 'error' })",
      ],
      [
        '`已上传 ${uploaded.name}`',
        "t('files.uploaded', { name: uploaded.name })",
      ],
      [
        "setNotice({ text: `已删除 ${file.name}`, kind: 'info' })",
        "setNotice({ text: t('files.deleted', { name: file.name }), kind: 'info' })",
      ],

      // ── 第二批：剩下的零散文案 ──
      [
        'setNotice({ text: `全屏失败：${(err as Error).message}`, kind: \'error\' })',
        "setNotice({ text: t('app.fullscreenFailed', { msg: (err as Error).message }), kind: 'error' })",
      ],
      [
        'notify(`还没连上服务端，暂时不能私聊 ${name}`)',
        "notify(t('app.dmNotConnected', { name }))",
      ],
      [
        "`${m.name}${isMe ? '（我）' : ''}`",
        "`${m.name}${isMe ? t('member.meSuffix') : ''}`",
      ],
      [
        "`${ROLE_LABEL[m.role]} · ${isOnline ? '在线' : '离线'} · 右键更多`",
        "`${ROLE_LABEL[m.role]} · ${isOnline ? t('member.online') : t('member.offline')} · ${t('member.rightClickMore')}`",
      ],
      // ⚠️ 这一条一次盖住三处 ✗（`split/join` 是**全部替换** ✓
      //    `正在玩` / `正在听` 那个三元在文件里出现三次 ✓ 一条就够 ✓）
      [
        "activity.kind === 'game' ? '正在玩' : '正在听'",
        "(activity.kind === 'game' ? t('member.playing') : t('member.listening'))",
      ],
      [
        "{inviteShare.isLocal ? '（我）' : ''} 正在共享屏幕",
        "{inviteShare.isLocal ? t('member.meSuffix') : ''} {t('stage.sharingLabel')}",
      ],
      [
        "title={s.name + (s.isLocal ? '（我）' : '')}",
        "title={s.name + (s.isLocal ? t('member.meSuffix') : '')}",
      ],
      ["{s.isLocal ? '（我）' : ''}", "{s.isLocal ? t('member.meSuffix') : ''}"],
    ],
  ],

  // ═══════════════════════════════════════════════════════════
  //  lib/api.ts —— 错误提示
  //
  //  ⚠️ 这里的文案是**模块级常量** ✗ 用不了 hook ✓
  //     所以拆成两半：
  //       · 一张「错误码 → 文案键」的表 ✓ 它和语言**无关** ✓ 可以放模块级 ✓
  //       · 真正取文案时调 translate ✓
  //     而 translate 用的是 `loadLang()` —— 它在**调用那一刻**读 localStorage ✓
  //     所以语言一变，之后产生的报错就是新语言的了 ✓ 不用重渲染 ✓
  //     （报错是**瞬时**的 toast ✓ 不需要跟着语言实时变 ✓ 这样就够 ✓）
  // ═══════════════════════════════════════════════════════════
  [
    'src/renderer/src/lib/api.ts',
    [
      [
        "import { blockWantsBubble, groupMessages } from './chatGroups'",
        "import { blockWantsBubble, groupMessages } from './chatGroups'",
      ],
      ["throw new Error('邀请码不对')", "throw new Error(tr('err.inviteWrong'))"],
      [
        'throw new Error(`服务端返回 ${res.status}${text ? `：${text.slice(0, 200)}` : \'\'}`)',
        "throw new Error(tr('err.serverStatus', { code: res.status }) + (text ? ` — ${text.slice(0, 200)}` : ''))",
      ],
    ],
  ],

  // hooks/useVoiceRoom.ts —— import + 那 5 条 setError
  [
    'src/renderer/src/hooks/useVoiceRoom.ts',
    [
      [
        "import type { AppConfig } from '../lib/config'",
        "import type { AppConfig } from '../lib/config'\nimport { useT, type MsgKey } from '../lib/i18n'",
      ],
      [
        'setError(`已加入频道，但麦克风没打开：${(err as Error).message}`)',
        "setError(t('voiceDrop.micFailed', { msg: (err as Error).message }))",
      ],
      [
        'setError(`麦克风切换失败：${(err as Error).message}`)',
        "setError(t('voiceDrop.switchFailed', { msg: (err as Error).message }))",
      ],
      [
        'setError(`降噪设置没生效：${(err as Error).message}`)',
        "setError(t('voiceDrop.noiseFailed', { msg: (err as Error).message }))",
      ],
      [
        'setError(`屏幕共享失败：${(err as Error).message}`)',
        "setError(t('voiceDrop.shareFailed', { msg: (err as Error).message }))",
      ],
      [
        'setError(`切换设备失败：${(err as Error).message}`)',
        "setError(t('voiceDrop.deviceFailed', { msg: (err as Error).message }))",
      ],
    ],
  ],
]

// ─────────────────────────────────────────────────────────────
// 一些**整块替换**（不是一行一条那种 ✓）
//
// ⚠️ 单独放在这里，是因为它们改的是结构 ✗ 不是字面量 ✓
//    混在上面的 [原文, 替换后] 列表里会看不清到底动了什么 ✓
// ─────────────────────────────────────────────────────────────
const BLOCKS = [
  {
    file: 'src/renderer/src/lib/api.ts',
    // ① 加 import ✓
    find: "import { blockWantsBubble, groupMessages } from './chatGroups'",
    replace: [
      "import { blockWantsBubble, groupMessages } from './chatGroups'",
      "import { loadLang, translate, type MsgKey } from './i18n'",
    ].join('\n'),
  },
  {
    file: 'src/renderer/src/lib/api.ts',
    // ② 把那张写死中文的表换成「码 → 键」的表 ✓ 并加一个取文案的函数 ✓
    find: `const ERROR_TEXT: Record<string, string> = {
  bad_json: '发出去的数据格式不对',
  not_joined: '还没完成握手',
  message_too_long: '消息太长了',
  channel_not_found: '频道不存在',
  forbidden: '你没有权限做这个操作',
  empty_name: '名字不能为空',
  cannot_delete_default: '默认频道不能删除',
  owner_only: '只有频道主能做这个操作',
  member_not_found: '找不到这个成员',
  cannot_change_owner: '不能修改频道主的角色',
  invalid_role: '角色不合法',
  invalid_target: '不能和自己私聊',
}`,
    replace: `/**
 * 服务端错误码 → 文案键 ✓
 *
 * ⚠️ 这张表**和语言无关** ✗ 所以它能放在模块级 ✓
 *    以前这里直接写的是中文 ✓ 那样就没法翻译 ✓（也不能用 hook ✓ 这不是组件 ✓）
 */
const ERROR_KEYS: Record<string, MsgKey> = {
  bad_json: 'err.badJson',
  not_joined: 'err.notJoined',
  message_too_long: 'err.messageTooLong',
  channel_not_found: 'err.channelNotFound',
  forbidden: 'err.forbidden',
  empty_name: 'err.emptyName',
  cannot_delete_default: 'err.cannotDeleteDefault',
  owner_only: 'err.ownerOnly',
  member_not_found: 'err.memberNotFound',
  cannot_change_owner: 'err.cannotChangeOwner',
  invalid_role: 'err.invalidRole',
  invalid_target: 'err.invalidTarget',
}

/**
 * 取一条文案 ✓
 *
 * ⚠️ \`loadLang()\` 每次调用都去读 localStorage ✗
 *    所以语言一改，**之后**产生的报错就是新语言的了 ✓
 *    报错是瞬时的 toast ✓ 不需要跟着语言实时重渲染 ✓
 */
function tr(key: MsgKey, vars?: Record<string, string | number>): string {
  return translate(loadLang(), key, vars)
}`,
  },
  {
    file: 'src/renderer/src/lib/api.ts',
    // ③ 取错误文案的地方改成查键 ✓
    find: "  return ERROR_TEXT[code] ?? `服务端返回错误：${code}`",
    replace: "  return tr(ERROR_KEYS[code] ?? 'err.serverError', { code })",
  },
  {
    file: 'src/renderer/src/lib/api.ts',
    // ④ 连接失败的两条 ✓
    find: "handlers.onError?.(`聊天连接建立失败：${(err as Error).message}`)",
    replace: "handlers.onError?.(tr('err.chatConnectFailed', { msg: (err as Error).message }))",
  },
  {
    file: 'src/renderer/src/lib/api.ts',
    find: "ws.onerror = () => handlers.onError?.('聊天连接出错（后端跑起来了吗？）')",
    replace: "ws.onerror = () => handlers.onError?.(tr('err.chatConnectError'))",
  },
  {
    file: 'src/renderer/src/lib/api.ts',
    // ⑤ 文件那张表也一样 ✓
    find: `const FILE_ERROR_TEXT: Record<string, string> = {
  invalid_invite_code: '邀请码不对',
  invalid_user: '身份校验失败 —— 重启一下客户端试试',
  empty_body: '文件是空的',
  write_failed: '服务器写文件失败（磁盘满了？）',
  not_found: '文件不存在（可能已被删除）',
  file_missing: '文件在服务器上不见了',
  forbidden: '你没有权限做这个操作',
  too_large: '文件太大',
}`,
    replace: `const FILE_ERROR_KEYS: Record<string, MsgKey> = {
  invalid_invite_code: 'err.inviteWrong',
  invalid_user: 'err.invalidUser',
  empty_body: 'err.emptyFile',
  write_failed: 'err.writeFailed',
  not_found: 'err.fileNotFound',
  file_missing: 'err.fileMissing',
  forbidden: 'err.forbidden',
  too_large: 'err.fileTooLarge',
}`,
  },
  {
    file: 'src/renderer/src/lib/api.ts',
    find: "throw new Error(`文件太大，服务器限制 ${mb} MB`)",
    replace: "throw new Error(tr('err.fileTooLargeLimit', { mb }))",
  },
  {
    file: 'src/renderer/src/lib/api.ts',
    find: "throw new Error(FILE_ERROR_TEXT[code] ?? `上传失败（HTTP ${res.status}）`)",
    replace: "throw new Error(FILE_ERROR_KEYS[code] ? tr(FILE_ERROR_KEYS[code]) : tr('err.uploadFailed', { status: res.status }))",
  },
  {
    file: 'src/renderer/src/lib/api.ts',
    find: "throw new Error(FILE_ERROR_TEXT[code] ?? `删除失败（HTTP ${res.status}）`)",
    replace: "throw new Error(FILE_ERROR_KEYS[code] ? tr(FILE_ERROR_KEYS[code]) : tr('err.deleteFailed', { status: res.status }))",
  },
]

let failed = 0

// ── 先做整块替换 ✓ ──────────────────────────────────────────
// ⚠️ 整块替换**必须排在字面量之前** ✗
//    因为它们会先改掉表的结构 ✓
//    反过来的话，字面量那批会先命中旧文本 ✓ 然后整块替换就找不到目标了 ✓
for (const b of BLOCKS) {
  const file = join(ROOT, b.file)
  const original = readFileSync(file, 'utf8')
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  let text = original.split('\r\n').join('\n')

  if (text.includes(b.replace)) {
    console.log(`  ⏭  ${b.file}：这一段已经改过了 ✓`)
  } else if (text.includes(b.find)) {
    text = text.split(b.find).join(b.replace)
    writeFileSync(file, eol === '\r\n' ? text.split('\n').join('\r\n') : text, 'utf8')
    console.log(`  ✅ ${b.file}：整块替换 ✓（${b.find.split('\n')[0].slice(0, 46)}…）`)
  } else {
    failed++
    console.log(`  ❌ ${b.file}：整块替换**没找到目标** ✗`)
    console.log(`     ${JSON.stringify(b.find.split('\n')[0].slice(0, 80))}`)
  }
}

for (const [rel, pairs] of BATCHES) {
  const file = join(ROOT, rel)
  const original = readFileSync(file, 'utf8')

  // ⚠️ 换行符要先归一化 ✗
  //    这些文件是 **CRLF** ✓ 而模式里写的是 `\n` ✓
  //    于是 13 条带换行的模式全部匹配不到 ✓（脚本一次性就把它们列出来了 ✓）
  //    读进来换成 `\n` ✓ 写完再换回去 ✓ —— 这样模式不用关心平台 ✓
  //    而且**不能直接把 CRLF 改掉** ✗ 那会污染整个 diff ✓ 看不出真正改了什么 ✓
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  let text = original.split('\r\n').join('\n')

  const miss = []
  const applied = []
  const already = []

  for (const [from, to] of pairs) {
    // ⚠️⚠️ 幂等检查必须**先查 to** ✗
    //
    //   原来是先查 `from` ✓ 对**替换型**规则没问题 ✓
    //   但对**追加型**规则（比如"在 import 后面再加一行" ✓）就不行了：
    //     改完之后 `from` 那一行**还在** ✓ 于是第二次跑又追加一遍 ✗
    //     → 同一个 import 出现两次 → **Duplicate identifier** ✗（真发生了 ✓）
    //   先查 to 就没有这个洞 ✓ 因为"结果已经在里面了"就说明不用再做 ✓
    if (text.includes(to)) {
      already.push(from)
    } else if (text.includes(from)) {
      text = text.split(from).join(to)
      applied.push(from)
    } else if (false) {
      // ⚠️ 已经改过了 → **不算失败** ✗
      //    第一版把这种情况也当成"没匹配到" ✓ 于是**第二次跑必然全红** ✗
      //    而"跑第二遍"是**一定会发生**的事 ✓（我加了几条新规则想再跑一次 ✓
      //    结果整个批次都因为旧的 50 条而拒写 ✓ 新规则一条都没进去 ✗）
      //    → 批量脚本必须**可重入** ✓
      already.push(from)
    } else {
      miss.push(from)
    }
  }

  if (miss.length > 0) {
    // ⚠️ 一条不中 → **整批不写** ✗
    failed++
    console.log(`  ❌ ${rel}：有 ${miss.length} 条没匹配到 → **整批不写** ✗`)
    for (const m of miss) {
      console.log(`     ${JSON.stringify(m.slice(0, 90))}`)
    }
  } else {
    writeFileSync(file, eol === '\r\n' ? text.split('\n').join('\r\n') : text, 'utf8')
    console.log(
      `  ✅ ${rel}：这次改了 ${applied.length} 处 ✓` +
        (already.length ? `（另有 ${already.length} 处之前已经改过 ✓）` : '') +
        `（换行符 ${eol === '\r\n' ? 'CRLF' : 'LF'} 保持原样 ✓）`,
    )
  }
}

if (failed > 0) {
  console.log('')
  console.log('  ⚠️ 有文件没写 ✓ 先看清楚上面列的那些原文是不是抄错了 ✓')
  process.exit(1)
}
