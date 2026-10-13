/**
 * 把聊天记录按「同一个人连续发的几条」合并成块。
 *
 * ── 为什么要合并 ────────────────────────────────────────────
 * 一个人连发三句话时，如果每条都重复一遍头像和名字 ✗
 * 屏幕上会有一半是重复信息 ✓ 合并之后只在**第一条**显示头像和名字 ✓
 * 三条共用一个气泡 ✓ 看着干净很多 ✓
 *
 * ── 拆出来的理由 ────────────────────────────────────────────
 * 纯函数、好单测 ✓ 而且"什么时候该合并、什么时候不该"的边界
 * （时间隔太久 ✗ 别人插了一句 ✗）很容易写错 ✓
 * 错了的表现是"两条风马牛不相及的话被塞进一个框" ✗ —— 很难一眼看出来 ✓
 */

import type { ChatMessage } from './api'

/**
 * 同一个人的相邻两条消息，间隔超过这个就不合并了。
 *
 * ⚠️ 光判"作者相同"是不够的 ✗ —— 一个人上午说一句、下午再说一句 ✓
 *    中间没人插话（小圈子里很常见 ✓）→ 会被并成一个框 ✗
 *    那个框里的两句话可能隔了六个小时 ✓ 看着莫名其妙 ✓
 *
 * 5 分钟是习惯值（Discord 是 7 分钟）—— 正常连续发言远用不了这么久 ✓
 */
export const GROUP_WINDOW_MS = 5 * 60 * 1000

export type ChatBlock = {
  /** React key：用第一条消息的 id（稳定 ✓ 不会因为后面追加而变 ✓） */
  key: string
  authorId: string
  authorName: string
  /** 这一块的时间 —— 用**第一条**的 ✓ 组里只显示这一个时间 ✓ */
  createdAt: number
  items: ChatMessage[]
}

/**
 * 分组。
 *
 * 规则：**同一个作者** 且 **和上一条挨得够近**，就并进上一块 ✓
 * 否则开新块 ✓
 */
export function groupMessages(
  messages: ChatMessage[],
  windowMs = GROUP_WINDOW_MS
): ChatBlock[] {
  const blocks: ChatBlock[] = []

  for (const m of messages) {
    const last = blocks[blocks.length - 1]
    const first = last?.items[0]
    const newest = last?.items[last.items.length - 1]

    /**
     * ⚠️ 时间比的是**这一块的第一条**，不是"上一条"。
     *
     *    拿上一条比的话：一个人每 4 分钟说一句、连说五条 ✓
     *    每一段间隔都在窗口内 ✓ → 会被并成**一块** ✓
     *    而那一块横跨 16 分钟 ✗
     *
     *    问题是：**一块只显示一个时间**（每条都显示就白合并了 ✗）
     *    → 最后一条明明在 16 分钟后 ✗ 框上却写着开头那个时间 ✓ 会误导 ✓
     *
     *    拿"块的第一条"比，就把整块的跨度也压在了 5 分钟以内 ✓
     *    那个时间最多偏 5 分钟 ✓ 可以接受 ✓
     */
    const canJoin =
      last !== undefined &&
      first !== undefined &&
      newest !== undefined &&
      last.authorId === m.author_id &&
      m.created_at - first.created_at <= windowMs &&
      // 时间倒流（时钟不准 / 服务端乱序）时别硬并 ✓
      m.created_at >= newest.created_at

    if (canJoin) {
      last.items.push(m)
    } else {
      blocks.push({
        key: String(m.id),
        authorId: m.author_id,
        authorName: m.author_name,
        createdAt: m.created_at,
        items: [m],
      })
    }
  }

  return blocks
}

/**
 * 这一块要不要套气泡底。
 *
 * 原来的规矩：纯文字消息套气泡 ✓ 带附件的**不套** ✗
 * （图片和文件自己就有形状 ✓ 再套一层底色显得笨重、也浪费四周空间 ✓）
 *
 * 合并之后一块里可能既有文字又有附件 ✗ —— 那就：**只要有一条是纯文字的，就套** ✓
 * 全都是附件才不套 ✓
 */
export function blockWantsBubble(block: ChatBlock): boolean {
  return block.items.some((m) => !m.attachment)
}
