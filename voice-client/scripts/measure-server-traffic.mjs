/**
 * 量服务器出口流量 —— 用来确认 P2P 投屏到底有没有生效。
 *
 * 跑法（在 voice-client 目录）：
 *   node scripts/measure-server-traffic.mjs http://<你的服务器>:<端口> [秒数]
 *
 * 例：
 *   node scripts/measure-server-traffic.mjs http://1.2.3.4:17706 10
 *
 * ── 为什么要这个 ✗ ──────────────────────────────────────────
 *   `/api/net/summary` 返回的是**开机以来的累计字节数** ✓
 *   单个读数**算不出任何东西** ✓（服务器跑了一天，那个数字永远很大 ✓）
 *   必须**前后两次相减、再除以间隔** ✓ 才得到"现在每秒多少" ✓
 *
 *   让人手动敲两次、自己心算相减 —— 那不是"能验"，那是"看运气" ✓
 *   所以做成一个命令：读两次 → 算速率 → 打印结论 ✓
 *
 * ── 怎么用它判断 P2P ✓ ──────────────────────────────────────
 *   ① 不投屏、正常聊天/语音时跑一次 → 记下这个基线 ✓
 *   ② 开始投屏、对方观看中、徽章显示「直连」时再跑一次 ✓
 *   ③ 比较两次的"发出"速率
 *        ≈ 基线                  → **P2P 生效了** ✓ 服务器没在转发画面 ✓✓
 *        多出约等于码率的量       → 还在走服务器 ✓（去看徽章是不是「经服务器」✓）
 *
 *   ⚠️ 别指望直连时是 0 ✗
 *      语音本身也在产生流量 ✓ 聊天、心跳、信令都在 ✓
 *      要和**基线比** ✓ 不是和 0 比 ✓
 *
 *   ⚠️ 码率参考：投屏预设大约 4 Mbps ≈ **0.5 MB/秒** ✓
 *      4K 屏那档更高 ✓ 具体看设置里的「屏幕共享」预设 ✓
 *
 * ── 这个脚本**故意**不写死服务器地址 ✗ ──────────────────────
 *   地址要当参数传 ✓ 这样这个文件可以**进仓库** ✓
 *   （不然又得和 `部署与联调清单.md` 一样放在工作区根目录 ✓）
 */

const url = process.argv[2]
const seconds = Number(process.argv[3] ?? 10)

if (!url) {
  console.log('')
  console.log('  用法：node scripts/measure-server-traffic.mjs <服务器地址> [秒数]')
  console.log('  例如：node scripts/measure-server-traffic.mjs http://1.2.3.4:17706 10')
  console.log('')
  process.exit(1)
}

const base = url.replace(/\/+$/, '')

async function read() {
  const res = await fetch(`${base}/api/net/summary`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j = await res.json()
  if (typeof j.totalTxBytes !== 'number') {
    throw new Error(`返回里没有 totalTxBytes：${JSON.stringify(j).slice(0, 120)}`)
  }
  return j
}

/** 字节 → 人看的单位 ✓ */
function fmt(bytes) {
  const mb = bytes / 1024 / 1024
  if (mb < 1) return `${(bytes / 1024).toFixed(1)} KB`
  if (mb < 1024) return `${mb.toFixed(2)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/** 速率 → 顺带给一个"Mbps" ✓ 因为码率都是用 Mbps 说的 ✓ */
function rate(bytes, sec) {
  const bps = bytes / sec
  const mbps = (bps * 8) / 1e6
  return `${fmt(bps)}/秒  （约 ${mbps.toFixed(2)} Mbps）`
}

console.log('')
console.log(`  服务器：${base}`)
console.log('')

let a
try {
  a = await read()
} catch (err) {
  console.log(`  ❌ 第一次读取失败：${err.message}`)
  console.log('     地址对不对？服务端在跑吗？（/health 能通吗 ✓）')
  console.log('')
  process.exit(1)
}

console.log(`  第一次：发出累计 ${fmt(a.totalTxBytes)} ✓ 收到累计 ${fmt(a.totalRxBytes)} ✓`)
console.log(`  ⏳ 等 ${seconds} 秒…（这段时间里**别停投屏** ✗）`)
console.log('')

await new Promise((r) => setTimeout(r, seconds * 1000))

let b
try {
  b = await read()
} catch (err) {
  console.log(`  ❌ 第二次读取失败：${err.message}`)
  console.log('')
  process.exit(1)
}

const dTx = b.totalTxBytes - a.totalTxBytes
const dRx = b.totalRxBytes - a.totalRxBytes
const realSec = (b.ts - a.ts) / 1000

if (dTx < 0 || dRx < 0) {
  console.log('  ⚠️ 计数变小了 —— 服务器可能刚重启过（计数归零 ✓）')
  console.log('     重新跑一次 ✓')
  console.log('')
  process.exit(1)
}

console.log(`  第二次：发出累计 ${fmt(b.totalTxBytes)} ✓ 收到累计 ${fmt(b.totalRxBytes)} ✓`)
console.log('')
console.log(`  ── 这 ${realSec.toFixed(1)} 秒里 ──────────────────────`)
console.log(`  服务器**发出**：${rate(dTx, realSec)}`)
console.log(`  服务器**收到**：${rate(dRx, realSec)}`)
console.log('')
console.log('  判读 ✓')
console.log('    · 和"不投屏时的基线"差不多 → P2P 生效了 ✓ 服务器没在转发画面 ✓')
console.log('    · 多出约 0.5 MB/秒（4 Mbps）→ 还在走服务器 ✓ 看徽章确认 ✓')
console.log('    · 语音本身也有流量 ✓ 要和**基线**比 ✓ 不是和 0 比 ✗')
console.log('')
