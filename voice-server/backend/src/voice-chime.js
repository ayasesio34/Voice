/**
 * 语音频道「离开」提示音的兜底检测。
 *
 * ── 为什么需要兜底 ──────────────────────────────────────────
 * 提示音本来完全靠**客户端主动上报**（客户端一发现自己离开了房间就发一条
 * voiceChime 给服务端）。这对"点退出按钮"是够的，但下面这些情况压根没机会上报：
 *
 *   · 直接关掉客户端窗口 —— React 是**卸载**，那个依赖 voiceJoinedRoomId
 *     **变化**的 effect 根本不会触发
 *   · 强杀进程 / 断网 / 断电
 *
 * 结果就是：人从成员列表里消失了，但频道里**没响那一声**。
 *
 * 服务端本来就在每 3 秒轮询 LiveKit（为了知道谁在哪个房间），
 * 顺手对比两轮快照就能发现"谁不见了"，补一声提示音。
 *
 * ── 为什么要去重 ────────────────────────────────────────────
 * 正常退出时客户端会即时上报（快），轮询 3 秒后也会看到（慢）。
 * 不去重的话，**留在频道里的人会听到两声"离开"**。
 *
 * 所以按 `房间|用户` 记下"刚刚主动报过"的标记，轮询撞上就跳过。
 *
 * ── 为什么用 userId 而不是 LiveKit identity ─────────────────
 * LiveKit 的 identity 后面缀了随机串（防止同名互踢），而且换一次连接就变，
 * 拿它做对比会把"同一个人重连"误判成"走了一个、来了一个"。
 * 客户端连上后会把自己的 userId 写进 participant attributes，那个才是稳定的。
 *
 * ── 一个已知的窄缺口（影响很小，先记着）────────────────────
 *
 * 如果一个人**刚进频道 3 秒内就退出**（还没轮到下一轮轮询、attributes 里
 * 还没有 userId），那么：
 *   · 上报用的是 userId
 *   · 轮询看到的 key 是 LiveKit identity（后缀随机串）
 *   · 两者对不上 → 去重失效 → 频道里会**响两声**
 *
 * 要根治得让客户端把 LiveKit identity 也一起上报（服务端两个 key 都记）。
 * 但窗口只有 3 秒、后果只是一声多余的"叮"，暂时不值得为它加一个字段。
 *
 * ⚠️ 这个模块**故意不直接调用 broadcast**，而是从外面注入 ——
 *    这样它是纯逻辑，可以单测（见 test-chime-diff.mjs）。
 */

/**
 * 上报过的离开，多久之内认为"轮询看到的是同一件事"。
 *
 * 12 秒 = 4 个轮询周期，足以覆盖"上报很快、轮询很慢"的情况。
 *
 * 这个窗口之所以能开得比较宽，是因为**重新加入时会主动清掉标记**
 * （见 noteRejoined）—— 否则一个人"报过离开 → 又进来 → 被强杀"时，
 * 轮询会被旧标记误吞，那就永远不响了。
 */
export const LEAVE_DEDUP_MS = 12000;

/**
 * 从 participant 里取一个**稳定的**人标识，用来对比两轮快照。
 *
 * 优先 attributes.userId —— 那是客户端本地生成、长期保存的 UUID。
 */
export function participantKey(p) {
  const uid = p?.attributes?.userId;
  if (typeof uid === 'string' && uid) return uid;
  return String(p?.identity ?? '');
}

/**
 * 造一个"离开观察器"。
 *
 * @param {object} opts
 * @param {(payload: object) => void} opts.broadcast  广播函数（注入，方便测试）
 * @param {number} [opts.dedupMs]                     去重窗口
 * @param {() => number} [opts.now]                   取当前时间（注入，方便测试过期）
 */
export function createLeaveWatcher({
  broadcast,
  dedupMs = LEAVE_DEDUP_MS,
  now = () => Date.now(),
}) {
  if (typeof broadcast !== 'function') {
    throw new TypeError('createLeaveWatcher 需要 broadcast 函数');
  }

  /** key = `${room}|${userId}`，值 = 上报时间戳 */
  const reported = new Map();

  /** 客户端主动报了"我离开了" */
  function noteReported(room, userId) {
    if (!room || !userId) return;
    reported.set(`${room}|${userId}`, now());
  }

  /** 客户端主动报了"我进来了" —— 把旧的离开标记清掉 */
  function noteRejoined(room, userId) {
    if (!room || !userId) return;
    reported.delete(`${room}|${userId}`);
  }

  /**
   * 对比两轮快照，给"没来得及上报就消失"的人补一声离开提示音。
   *
   * @param {Record<string, Array>} before 上一轮快照
   * @param {Record<string, Array>} after  这一轮快照
   * @returns {number} 实际补发了几条（方便测试和日志）
   */
  function diff(before, after) {
    const t = now();
    const prev = before ?? {};
    const next = after ?? {};

    // LiveKit 整体重启时会返回一个**空**列表 —— 那不是"所有人同时退出了"，
    // 别在这儿炸出一串幻听。
    // 真·全员退出时房间本身还会被列出（只是里面没人），所以不会走到这里。
    if (Object.keys(next).length === 0 && Object.keys(prev).length > 0) return 0;

    let emitted = 0;

    for (const [room, prevList] of Object.entries(prev)) {
      const stillThere = new Set((next[room] ?? []).map(participantKey));

      for (const p of prevList ?? []) {
        const key = participantKey(p);
        if (key && stillThere.has(key)) continue;

        const dedupKey = `${room}|${key}`;
        const reportedAt = reported.get(dedupKey);

        if (reportedAt !== undefined && t - reportedAt < dedupMs) {
          reported.delete(dedupKey); // 用掉就删，免得下次误吞
          continue;
        }

        broadcast({
          type: 'chime',
          kind: 'leave',
          name: p?.name || '匿名',
          room,
        });
        emitted += 1;
      }
    }

    // 顺手清掉过期的标记，免得这个 Map 一直长
    for (const [k, at] of reported) {
      if (t - at > dedupMs) reported.delete(k);
    }

    return emitted;
  }

  return {
    noteReported,
    noteRejoined,
    diff,
    /** 只给测试用：看当前还剩几条标记 */
    _size: () => reported.size,
  };
}
