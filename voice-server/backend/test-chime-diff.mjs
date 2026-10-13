/**
 * voice-chime.js 的单元测试。
 *
 * 跑法：
 *     cd voice-server/backend
 *     node test-chime-diff.mjs
 *
 * 为什么值得单独测：差集 + 去重这段逻辑**错一个分支就是线上事故** ——
 *   · 去重没做对 → 频道里"离开"要响两声
 *   · 差集写错   → 关窗口的人消失了但**不响**（正是这次要修的问题）
 *   · 边界没挡   → LiveKit 重启时炸出一串幻听
 *
 * 这些用眼睛看不出来，得跑。
 */

import assert from 'node:assert/strict';
import { createLeaveWatcher, participantKey, LEAVE_DEDUP_MS } from './src/voice-chime.js';

// ── 测试脚手架 ──────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \u2705 ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  \u274c ${name}`);
    console.log(`     ${err.message}`);
  }
}

/** 造一个 participant。attrs 为 false 时模拟"还没设 attributes" */
function person(userId, name, withAttrs = true) {
  return {
    identity: `${name}-a1b2c3d4`,
    name,
    attributes: withAttrs ? { userId } : {},
  };
}

/** 造一个观察器，同时把广播出去的 chime 收集起来 */
function makeWatcher(opts = {}) {
  const sent = [];
  let clock = 1_000_000;
  const watcher = createLeaveWatcher({
    broadcast: (p) => sent.push(p),
    now: () => clock,
    ...opts,
  });
  return {
    watcher,
    sent,
    names: () => sent.map((c) => c.name),
    advance: (ms) => {
      clock += ms;
    },
  };
}

// ── 用例 ────────────────────────────────────────────────────

console.log('\nvoice-chime 单元测试\n');

console.log('【基本差集】');

test('首轮快照（之前是空的）不该发任何东西', () => {
  const { watcher, sent } = makeWatcher();
  assert.equal(watcher.diff({}, { 'voice-1': [person('u1', '小明')] }), 0);
  assert.equal(sent.length, 0);
});

test('没人离开时不发', () => {
  const { watcher, sent } = makeWatcher();
  const snap = { 'voice-1': [person('u1', '小明')] };
  assert.equal(watcher.diff(snap, { 'voice-1': [person('u1', '小明')] }), 0);
  assert.equal(sent.length, 0);
});

test('★ 有人消失且没上报 → 补发一条 leave', () => {
  const { watcher, sent, names } = makeWatcher();
  const emitted = watcher.diff({ 'voice-1': [person('u1', '小明')] }, { 'voice-1': [] });
  assert.equal(emitted, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(names(), ['小明']);
  assert.equal(sent[0].kind, 'leave');
  assert.equal(sent[0].room, 'voice-1');
});

test('两个人一起掉线 → 补发两条', () => {
  const { watcher, sent } = makeWatcher();
  const before = { 'voice-1': [person('u1', '小明'), person('u2', '小红')] };
  assert.equal(watcher.diff(before, { 'voice-1': [] }), 2);
  assert.equal(sent.length, 2);
});

test('整个房间消失（LiveKit 把空房间回收了）也算离开', () => {
  const { watcher } = makeWatcher();
  const before = { 'voice-1': [person('u1', '小明')] };
  // after 里房间整个不见了，但**别的房间还在** —— 不是 LiveKit 重启
  assert.equal(watcher.diff(before, { 'voice-2': [person('u9', '路人')] }), 1);
});

console.log('\n【去重：客户端已经报过了就不重复发】');

test('★ 上报过后，轮询看到同一个人消失 → **不补发**（否则响两声）', () => {
  const { watcher, sent } = makeWatcher();
  watcher.noteReported('voice-1', 'u1');
  const emitted = watcher.diff({ 'voice-1': [person('u1', '小明')] }, { 'voice-1': [] });
  assert.equal(emitted, 0, '应该被去重掉');
  assert.equal(sent.length, 0);
});

test('一个报了一个没报 → 只补没报的那个', () => {
  const { watcher, sent, names } = makeWatcher();
  watcher.noteReported('voice-1', 'u1');
  const before = { 'voice-1': [person('u1', '小明'), person('u2', '小红')] };
  assert.equal(watcher.diff(before, { 'voice-1': [] }), 1);
  assert.deepEqual(names(), ['小红']);
});

test('去重只在自己那个房间生效（别的房间同名不受影响）', () => {
  const { watcher, sent } = makeWatcher();
  watcher.noteReported('voice-1', 'u1');
  // 同一个 userId 在 voice-2 里消失，没上报过 → 应该补发
  assert.equal(watcher.diff({ 'voice-2': [person('u1', '小明')] }, { 'voice-2': [] }), 1);
  assert.equal(sent.length, 1);
});

console.log('\n【关键回归：重新加入要清掉旧标记】');

test('★ 报过离开 → 又进来 → 再掉线（没上报）→ 必须补发', () => {
  const { watcher, sent } = makeWatcher();
  const inRoom = { 'voice-1': [person('u1', '小明')] };

  // ① 正常退出，上报了
  watcher.noteReported('voice-1', 'u1');
  watcher.diff(inRoom, { 'voice-1': [] });
  assert.equal(sent.length, 0, '第一次应该被去重');

  // ② 他又进来了，客户端会上报 join
  watcher.noteRejoined('voice-1', 'u1');

  // ③ 这次是关窗口，没机会上报
  const emitted = watcher.diff(inRoom, { 'voice-1': [] });
  assert.equal(emitted, 1, '重新加入后必须能补发 —— 否则这个兜底就废了');
  assert.equal(sent.length, 1);
});

test('标记用过一次就删掉，不会误吞后续的', () => {
  const { watcher } = makeWatcher();
  watcher.noteReported('voice-1', 'u1');
  assert.equal(watcher.diff({ 'voice-1': [person('u1', '小明')] }, { 'voice-1': [] }), 0);
  // 第二个人（同一个 userId 理论上不会，但逻辑上应该是干净的）
  assert.equal(watcher.diff({ 'voice-1': [person('u1', '小明')] }, { 'voice-1': [] }), 1);
});

test('标记超过去重窗口后失效，该补发就补发', () => {
  const { watcher, advance, sent } = makeWatcher();
  watcher.noteReported('voice-1', 'u1');
  advance(LEAVE_DEDUP_MS + 1000);
  assert.equal(watcher.diff({ 'voice-1': [person('u1', '小明')] }, { 'voice-1': [] }), 1);
  assert.equal(sent.length, 1);
});

console.log('\n【防幻听：LiveKit 重启】');

test('★ 快照整体变空（LiveKit 重启）→ 一条都不发', () => {
  const { watcher, sent } = makeWatcher();
  const before = {
    'voice-1': [person('u1', '小明'), person('u2', '小红')],
    'voice-2': [person('u3', '小刚')],
  };
  assert.equal(watcher.diff(before, {}), 0, '这不是"所有人同时退出"，是 LiveKit 挂了');
  assert.equal(sent.length, 0);
});

test('本来就是空的 → 也不发', () => {
  const { watcher } = makeWatcher();
  assert.equal(watcher.diff({}, {}), 0);
});

console.log('\n【换频道 / 边界】');

test('A 换到 B：A 那边算离开，B 不补发（加入由客户端自己上报）', () => {
  const { watcher, sent } = makeWatcher();
  const before = { A: [person('u1', '小明')] };
  const after = { B: [person('u1', '小明')] };
  assert.equal(watcher.diff(before, after), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].room, 'A');
});

test('没设 attributes 的人靠 identity 也能正确判断"他没走"', () => {
  const { watcher, sent } = makeWatcher();
  const p = person('u1', '小明', false); // attributes 是空的
  assert.equal(watcher.diff({ 'voice-1': [p] }, { 'voice-1': [p] }), 0);
  assert.equal(sent.length, 0);
});

test('没设 attributes 的人走了，照样能补发', () => {
  const { watcher, sent } = makeWatcher();
  const p = person('u1', '小明', false);
  assert.equal(watcher.diff({ 'voice-1': [p] }, { 'voice-1': [] }), 1);
  assert.equal(sent.length, 1);
});

test('participantKey：优先 userId，没有才退回 identity', () => {
  assert.equal(participantKey(person('u1', '小明')), 'u1');
  assert.equal(participantKey(person('u1', '小明', false)), '小明-a1b2c3d4');
  assert.equal(participantKey(null), '');
});

test('名字缺失时用「匿名」兜底，不会发 undefined', () => {
  const { watcher, sent } = makeWatcher();
  const p = { identity: 'x-1', name: '', attributes: { userId: 'u1' } };
  watcher.diff({ 'voice-1': [p] }, { 'voice-1': [] });
  assert.equal(sent[0].name, '匿名');
});

console.log('\n【构造参数校验】');

test('没给 broadcast 直接抛错（而不是悄悄什么都不做）', () => {
  assert.throws(() => createLeaveWatcher({}), TypeError);
});

// ── 结果 ────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`通过 ${passed} / 失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
