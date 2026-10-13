#!/usr/bin/env node
/**
 * 服务端角色管理工具。
 *
 * 直接在服务器上跑，不用重启服务 —— 后端每次操作都会重新读数据库，
 * 所以改完立刻生效（客户端重载一下就能看到新角色）。
 *
 * 用法：
 *   node scripts/admin.js list                      列出所有成员和角色
 *   node scripts/admin.js owner Owner               把 Owner 设为频道主（原频道主降为管理员）
 *   node scripts/admin.js role Owner admin          设为管理员
 *   node scripts/admin.js role Owner member         降为普通成员
 *
 * 「Owner」可以是昵称（支持部分匹配），也可以直接给完整的 userId。
 *
 * 什么时候需要它：
 *   · 第一个连上服务器的人会自动成为频道主，但如果抢先连上的是个临时页面
 *     （比如浏览器测试页），频道主就落在那个用完就丢的身份上了
 *   · 换了电脑 / 清了 localStorage，userKey 丢了，就变成全新成员
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;

  const envFile = resolve(ROOT, '.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*DB_PATH\s*=\s*(.+?)\s*$/);
      if (m) return m[1];
    }
  }
  return resolve(ROOT, 'data/voice.db');
}

const dbPath = readDbPath();
if (!existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);

function listAll() {
  return db
    .prepare(
      `SELECT user_id, name, avatar, role, last_seen FROM members
       ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, name`
    )
    .all();
}

function findMember(needle) {
  if (!needle) return null;
  const rows = listAll();
  return (
    rows.find((r) => r.user_id === needle) ??
    rows.find((r) => r.name === needle) ??
    rows.find((r) => String(r.name).toLowerCase().includes(String(needle).toLowerCase())) ??
    null
  );
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === 'list' || cmd === 'ls') {
  const rows = listAll();
  if (rows.length === 0) {
    console.log('（还没有任何成员 —— 让客户端连一次就有了）');
  } else {
    console.log('角色      昵称            头像  最后在线                  userId');
    console.log('─'.repeat(100));
    for (const r of rows) {
      const when = r.last_seen
        ? new Date(Number(r.last_seen)).toLocaleString('zh-CN')
        : '—';
      // 头像能直接看出服务端到底存没存到
      const hasAvatar = r.avatar ? ' ✓  ' : ' —  ';
      console.log(
        `${String(r.role).padEnd(9)} ${String(r.name).padEnd(14)} ${hasAvatar} ${when.padEnd(24)} ${r.user_id}`
      );
    }
    console.log();
    console.log('说明：昵称和头像是客户端通过聊天 WebSocket 的 hello 包上传、存在这个表里的，');
    console.log('      然后广播给所有人 —— 所以别人看得见。头像列显示 ✓ 就说明服务端收到了。');
  }
  db.close();
  process.exit(0);
}

if (cmd === 'owner') {
  const target = findMember(rest[0]);
  if (!target) {
    console.error(`找不到成员：${rest[0]}`);
    process.exit(1);
  }
  db.exec('BEGIN');
  try {
    // 先降原频道主，再升新的 —— 保证任何时刻只有一个 owner
    db.prepare(`UPDATE members SET role = 'admin' WHERE role = 'owner' AND user_id != ?`).run(
      target.user_id
    );
    db.prepare(`UPDATE members SET role = 'owner' WHERE user_id = ?`).run(target.user_id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(`✓ ${target.name}（${target.user_id}）现在是频道主`);
  console.log('  客户端重载一下（Ctrl+R）就能看到徽标。');
  db.close();
  process.exit(0);
}

if (cmd === 'role') {
  const target = findMember(rest[0]);
  const role = rest[1];

  if (!['admin', 'member'].includes(role)) {
    console.error('角色只能是 admin 或 member。要转移频道主请用：admin.js owner <名字>');
    process.exit(1);
  }
  if (!target) {
    console.error(`找不到成员：${rest[0]}`);
    process.exit(1);
  }

  db.prepare('UPDATE members SET role = ? WHERE user_id = ?').run(role, target.user_id);
  console.log(`✓ ${target.name}（${target.user_id}）现在是 ${role}`);
  db.close();
  process.exit(0);
}

if (cmd === 'remove' || cmd === 'rm') {
  const target = findMember(rest[0]);
  if (!target) {
    console.error(`找不到成员：${rest[0]}`);
    process.exit(1);
  }
  if (target.role === 'owner') {
    console.error('不能删频道主。先把别人设成频道主，再删这个。');
    process.exit(1);
  }
  db.prepare('DELETE FROM members WHERE user_id = ?').run(target.user_id);
  console.log(`✓ 已删除成员 ${target.name}（${target.user_id}）`);
  console.log('  他发的消息不会被删，只是不能再以这个身份取回角色。');
  db.close();
  process.exit(0);
}

console.error(`未知命令：${cmd}`);
console.error('可用命令：');
console.error('  list                              列出成员和角色');
console.error('  owner <名字|userId>               设为频道主');
console.error('  role <名字|userId> <admin|member> 设为管理员 / 降为成员');
console.error('  remove <名字|userId>              删除成员（用于清理废弃身份）');
db.close();
process.exit(1);
