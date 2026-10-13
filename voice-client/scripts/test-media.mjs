/**
 * 本地状态检测的解析测试（听歌 + 玩游戏）。
 *
 * 跑法（在 voice-client 目录）：
 *     node scripts/test-media.mjs
 *
 * ── 为什么这样测 ────────────────────────────────────────────
 * 以前是手工从 .ts 源码里"抠"出某个函数再 eval ✗ —— 脆弱，
 * 而且抠出来的只是**副本**，源码改了结构测试就悄悄失效。
 *
 * 现在用 esbuild 把**整个模块**编译出来直接 import（把 `electron` 换成一个
 * 空壳，因为模块顶层只用到 `app` 的引用、不会真调用）。
 * 测的就是真正跑在应用里的那份代码。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { transformSync } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src', 'main', 'mediaSession.ts')

/** electron 的空壳 —— 模块顶层只引用 app，不会真调用它的方法 */
const ELECTRON_STUB =
  'data:text/javascript,' +
  encodeURIComponent(
    'export const app = { isPackaged: false, getAppPath: () => "", getPath: () => "" };' +
      'export const BrowserWindow = {};'
  )

const raw = readFileSync(SRC, 'utf8')
const js = transformSync(raw, { loader: 'ts', format: 'esm' }).code.replace(
  /from\s+['"]electron['"]/g,
  `from '${ELECTRON_STUB}'`
)
const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

const { parseWatchLine, parseGameLine, GAMES, watchList, setSharedGames, setCustomGames } = mod

let pass = 0
let fail = 0
const check = (name, fn) => {
  try {
    fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (err) {
    fail++
    console.log(`  ❌ ${name}`)
    console.log(`     ${err.message}`)
  }
}
const eq = (a, b) => {
  const A = JSON.stringify(a)
  const B = JSON.stringify(b)
  if (A !== B) throw new Error(`${A} != ${B}`)
}

console.log('\n本地检测解析测试\n')
console.log('【正在听歌】')

check('正常一行 → 对象', () =>
  eq(
    parseWatchLine(
      '{"active":true,"app":"cloudmusic.exe","title":"我是真的爱上你","artist":"王杰","state":"Playing"}'
    ),
    {
      app: 'cloudmusic.exe',
      title: '我是真的爱上你',
      artist: '王杰',
    }
  ))

check('active:false → null（播放器关了，才算没在听）', () =>
  eq(parseWatchLine('{"active":false}'), null))

check('★ 暂停时**照常有内容**（只要播放器还开着）', () => {
  // 这就是这次改的核心：以前只在 Playing 时才算数，一暂停别人那边就没了 ✗
  // 现在只有会话彻底关闭才是 false ✓
  const paused = parseWatchLine(
    '{"active":true,"app":"cloudmusic.exe","title":"某首歌","artist":"某人","state":"Paused"}'
  )
  eq(paused, { app: 'cloudmusic.exe', title: '某首歌', artist: '某人' })
})

check('state 是别的值（Stopped / Opened）也一样算数', () => {
  eq(
    parseWatchLine('{"active":true,"title":"A","artist":"","state":"Stopped"}').title,
    'A'
  )
  eq(
    parseWatchLine('{"active":true,"title":"B","artist":"","state":"Opened"}').title,
    'B'
  )
})

check('纯音乐（artist 空）也是有效状态', () =>
  eq(parseWatchLine('{"active":true,"title":"某个 BGM","artist":""}'), {
    app: '',
    title: '某个 BGM',
    artist: '',
  }))

check('没有 title → null（不该显示空白的"正在听："）', () =>
  eq(parseWatchLine('{"active":true,"title":""}'), null))

check('title 带首尾空格会 trim', () =>
  eq(parseWatchLine('{"active":true,"title":"  x  "}').title, 'x'))

check('active 是字符串 "true" 不算（只认布尔 true）', () =>
  eq(parseWatchLine('{"active":"true","title":"x"}'), null))

check('★ 老字段名 playing 不再被认（改了名就别留后门）', () => {
  // 脚本和解析要一起改；只改一边的话这里会红。
  eq(parseWatchLine('{"playing":true,"title":"x"}'), null)
})

check('乱七八糟的对象不抛异常', () => eq(parseWatchLine('{"active":true,"title":123}'), null))

console.log('\n【★ 解析失败不能当成"没在听"】')
// 以前这里返回 null，于是 PowerShell 混进来任何一行警告，
// 界面上就会闪一下"没在听" ✗ 只有解析失败时才该装死（undefined）。
check('半行 JSON → undefined（不是 null）', () => eq(parseWatchLine('{"active":tr'), undefined))
check('非 JSON（PowerShell 的警告）→ undefined', () => eq(parseWatchLine('WARNING: something'), undefined))
check('空行 → undefined', () => eq(parseWatchLine(''), undefined))

console.log('\n【正在玩游戏】')

check('白名单里的进程 → 给出显示名', () =>
  // ⚠️ 真实进程名是 `League of Legends`（**带空格**）——
  //    Get-Process 的 ProcessName 保留空格。表里的键必须和它对得上。
  eq(parseGameLine('{"exe":"League of Legends"}'), {
    exe: 'league of legends',
    name: '英雄联盟',
  }))

check('大小写不敏感', () =>
  eq(parseGameLine('{"exe":"LEAGUE OF LEGENDS"}').name, '英雄联盟'))

check('exe:null → null（没在玩）', () => eq(parseGameLine('{"exe":null}'), null))

check('白名单外的进程 → null（认不准就别报）', () => eq(parseGameLine('{"exe":"notepad"}'), null))

check('标了空串表示"忽略"的进程 → null', () =>
  eq(parseGameLine('{"exe":"riotclientservices"}'), null))

check('解析失败 → undefined（和听歌同一套约定）', () => {
  eq(parseGameLine('{"exe":'), undefined)
  eq(parseGameLine('warning'), undefined)
})

console.log('\n【白名单本身】')

check('表里的键都是小写、不带 .exe，值都是字符串', () => {
  for (const [exe, name] of Object.entries(GAMES)) {
    if (exe !== exe.toLowerCase()) throw new Error(`键不是小写：${exe}`)
    if (exe.endsWith('.exe')) throw new Error(`键带了 .exe：${exe}`)
    if (typeof name !== 'string') throw new Error(`显示名不是字符串：${exe}`)
  }
})

check('watchList() 去掉了"忽略"项，而且非空', () => {
  const list = watchList()
  if (list.includes('riotclientservices')) throw new Error('不该把忽略项传下去')
  if (list.length === 0) throw new Error('不该是空的')
  if (!list.includes('league of legends')) throw new Error('英雄联盟应该在名单里')
})

check('白名单规模合理（够用但不臃肿）', () => {
  const n = watchList().length
  if (n < 10) throw new Error(`太少了：${n}`)
  if (n > 100) throw new Error(`太多了，扫这么多不符合"只看白名单"的初衷：${n}`)
})

check('常见游戏都在表里', () => {
  for (const exe of ['league of legends', 'cs2', 'dota2', 'genshinimpact', 'b1-win64-shipping']) {
    if (!GAMES[exe]) throw new Error(`缺了 ${exe}`)
  }
})

console.log('\n【★ 白名单合并优先级：内置 < 服务端共享 < 本地自己报的】')

check('服务端共享的游戏能被认出来（别人报过，你就能检测到）', () => {
  setSharedGames({ sharedgame: '别人报的游戏' })
  eq(parseGameLine('{"exe":"sharedgame"}'), { exe: 'sharedgame', name: '别人报的游戏' })
  setSharedGames({})
})

check('本地自己报的盖过服务端共享的', () => {
  setSharedGames({ same: '服务端说叫这个' })
  setCustomGames({ same: '我自己起的名字' })
  eq(parseGameLine('{"exe":"same"}').name, '我自己起的名字')
  setCustomGames({})
  setSharedGames({})
})

check('服务端共享的盖过内置的', () => {
  setSharedGames({ cs2: '服务端改过的名字' })
  eq(parseGameLine('{"exe":"cs2"}').name, '服务端改过的名字')
  setSharedGames({})
})

check('共享/本地的键也会被规整（大小写、.exe）', () => {
  setSharedGames({ 'Weird.EXE': '奇怪的名字' })
  eq(parseGameLine('{"exe":"weird"}').name, '奇怪的名字')
  setSharedGames({})
})

check('★ 内置表里标了"忽略"的，共享/本地也不能把它翻出来', () => {
  // riotclientservices 在内置表里是空串（= 忽略）。
  // 用 `a || b || c` 的话空串会被跳过、落到共享表上，就又显示出来了。
  setSharedGames({ riotclientservices: '英雄联盟客户端' })
  setCustomGames({ riotclientservices: '我非要显示它' })
  eq(parseGameLine('{"exe":"riotclientservices"}'), null)
  setSharedGames({})
  setCustomGames({})
})

check('两边的表都清空后，没见过的进程还是 null', () => {
  eq(parseGameLine('{"exe":"sharedgame"}'), null)
})

console.log(`\n${'─'.repeat(48)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
