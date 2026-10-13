/**
 * 「谁在看这一路投屏」的挑选逻辑。
 *
 * ── 为什么单独拆出来 ────────────────────────────────────────
 * 这一段**不好截图验证** —— 要真的开一路投屏、再让第二个人真的去看，
 * 才能看到界面。而这里挑错了（把自己算进去、漏掉人、超出上限）
 * 全都是"看起来能用"的错误。
 *
 * 所以把「谁能算观看者」抽成纯函数，用单测钉住；
 * 界面那层只剩摆放和样式，出错的余地小得多。
 *
 * ── 数据从哪来 ──────────────────────────────────────────────
 * 每个客户端会把自己"正在看哪一路"写进 LiveKit 的 participant
 * attribute（`watch` = 那路投屏的 sid）。服务端轮询 LiveKit 时把它带回来 ——
 * 所以有**几秒延迟**，但"有谁在看"本来就不需要毫秒级。
 */

import { byJoinOrder, voiceKey, withSuffixes, type VoiceMember } from './names'

/** 界面上最多叠几个头像，多出来的收成「+N」 */
export const MAX_VISIBLE_VIEWERS = 4

export type Viewer = {
  /** 稳定 key（用来做 React key 和去重） */
  key: string
  name: string
  /** 带去重后缀的显示名（重名时才有 #尾号） */
  display: string
  /** 序列化后的头像，直接喂给 <Avatar raw=…> */
  avatar: string
}

export type ViewerSummary = {
  /** 要叠出来的头像（已经截到上限） */
  shown: Viewer[]
  /** 被折叠掉的人数（0 表示全显示得下） */
  extra: number
  /** 全部观看者的名字，去掉后缀 —— 悬停提示用 */
  allNames: string[]
  /** 一共几个人在看 */
  total: number
}

const EMPTY: ViewerSummary = { shown: [], extra: 0, allNames: [], total: 0 }

/**
 * 挑出正在看某一路投屏的**其他人**。
 *
 * ⚠️ **自己不算**。共享画面的人自己的客户端也会"在看"自己那一路
 *    （不然本地预览就得另走一套），但那不是"观众" ✗
 *    以前把一个「你」硬塞进名单，于是"1 人在看"永远至少是 1 ——
 *    一个人都没来的时候也显示"1 人在看"，等于没说。
 *
 * ⚠️ 返回 **`EMPTY`（空）** 时调用方应该**什么都不渲染**，
 *    不要显示「0 人在看」那种废话。
 */
export function pickViewers(
  members: VoiceMember[] | undefined,
  sharingSid: string | null | undefined,
  myUserId: string | undefined,
  max = MAX_VISIBLE_VIEWERS
): ViewerSummary {
  if (!sharingSid || !members?.length) return EMPTY

  const others = members
    .filter((m) => m.attributes?.watch === sharingSid)
    // 自己不算观众
    .filter((m) => !myUserId || voiceKey(m) !== myUserId)

  if (others.length === 0) return EMPTY

  // 按进频道的先后排，这样头像的顺序是稳定的 ——
  // 不排的话每轮轮询都可能换个位置，看着像在乱跳
  const ordered = withSuffixes(byJoinOrder(others))

  const viewers: Viewer[] = ordered.map((m) => ({
    key: voiceKey(m),
    name: m.name,
    display: m.display,
    avatar: typeof m.avatar === 'string' ? m.avatar : '',
  }))

  return {
    shown: viewers.slice(0, Math.max(0, max)),
    extra: Math.max(0, viewers.length - max),
    // 提示里用**原始名字**：后缀（#a1b2）是给同名的人区分用的，
    // 悬停看名单时反而是噪音
    allNames: viewers.map((v) => v.name),
    total: viewers.length,
  }
}
