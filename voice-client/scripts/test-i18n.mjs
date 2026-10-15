/**
 * 界面多语言的测试。
 *
 * 跑法（在 voice-client 目录）：node scripts/test-i18n.mjs
 *
 * ── 先说清楚：**最重要的一条护栏不在这里** ✗ ────────────────
 *   "漏翻译"是靠 **TypeScript** 拦的 ✓
 *   每种语言声明成 `Record<MsgKey, string>` ✓ 少一个键就编译不过 ✓
 *   （我真删过法语一个键试过 ✓ 立刻 1 个 error ✓ 还原就 0 ✓）
 *   那比这个文件强得多 ✓ 因为它**根本编译不出来** ✓
 *
 * ── 那这里验什么 ✗ ──────────────────────────────────────────
 *   编译期查不出来的两件事：
 *     ① 占位符替换 ✓（`{n}` 有没有真的换掉 ✓ 少给一个变量会怎样 ✓）
 *     ② 兜底 ✓（将来手滑传了个不存在的语言 ✓ 会不会白屏 ✓）
 *   外加几条**便宜但有用**的结构检查 ✓（空字符串 / 各语言键数一致 ✓）
 */

import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(join(tmpdir(), 'voice-i18n-'))

let pass = 0
let fail = 0
function check(name, fn) {
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

/** 把 i18n.ts 打包成一份能在 Node 里 import 的 ESM ✓ */
function loadI18n() {
  const built = buildSync({
    entryPoints: [join(ROOT, 'src', 'renderer', 'src', 'lib', 'i18n.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    target: 'node20',
    logLevel: 'silent',
  })
  const out = join(tmp, 'i18n.mjs')
  writeFileSync(out, built.outputFiles[0].text)
  return import(pathToFileURL(out).href)
}

async function main() {
  const m = await loadI18n()
  const { LANGS, translate, DEFAULT_LANG, isLang } = m
  const codes = Object.keys(LANGS)
  const ZH = LANGS[DEFAULT_LANG].dict
  const keys = Object.keys(ZH)

  console.log('')
  console.log(`  语言 ${codes.length} 种：${codes.join(' / ')}`)
  console.log(`  文案键 ${keys.length} 个`)
  console.log('')

  check('每种语言的键**完全一致**（不多不少 ✓）', () => {
    for (const c of codes) {
      const k = Object.keys(LANGS[c].dict).sort()
      assert.deepEqual(k, [...keys].sort(), `${c} 的键和中文那份对不上`)
    }
  })

  check('没有空文案（空的会显示成一片白 ✗）', () => {
    for (const c of codes) {
      for (const k of keys) {
        const v = LANGS[c].dict[k]
        assert.ok(typeof v === 'string' && v.trim().length > 0, `${c} 的 ${k} 是空的`)
      }
    }
  })

  check('中文那份里没有 `{` 占位符被漏掉翻译的痕迹', () => {
    // 各语言的占位符集合应该和中文一致 ✓
    // 不一样说明有人翻译时手滑删了 `{n}` ✓ 界面上那个数字就永远不会出现 ✗
    const ph = (s) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort()
    for (const c of codes) {
      for (const k of keys) {
        assert.deepEqual(
          ph(LANGS[c].dict[k]),
          ph(ZH[k]),
          `${c} 的 ${k} 占位符和中文不一致：「${LANGS[c].dict[k]}」vs「${ZH[k]}」`,
        )
      }
    }
  })

  check('插值真的换掉了 ✓', () => {
    const s = translate('en', 'channel.connected', { n: 3 })
    assert.ok(s.includes('3'), `应该带上数字，实际="${s}"`)
    assert.ok(!s.includes('{n}'), `不该留占位符，实际="${s}"`)
  })

  check('多个占位符都换 ✓', () => {
    const s = translate('zh-CN', 'channel.voiceTitle', { name: '开黑', hint: '点击加入' })
    assert.equal(s, '开黑（点击加入）')
  })

  check('★ 少给一个变量时占位符**原样保留** ✗（不要换成空白 ✓）', () => {
    const s = translate('zh-CN', 'channel.connected')
    // 保留 `{n}` 的话一眼能看出是哪儿错了 ✓
    // 换成空的话界面上会凭空少一块 ✓ 而看不出原因 ✗
    assert.ok(s.includes('{n}'), `应该保留 {n}，实际="${s}"`)
  })

  check('★ 传了个不存在的语言 → 退到中文 ✓ 不白屏 ✓', () => {
    const s = translate('xx-YY', 'settings.title')
    assert.equal(s, ZH['settings.title'])
    assert.ok(s.length > 0)
  })

  check('isLang 认得合法值、挡得住乱传的 ✓', () => {
    assert.equal(isLang('zh-CN'), true)
    assert.equal(isLang('en'), true)
    assert.equal(isLang('xx'), false)
    assert.equal(isLang(null), false)
    assert.equal(isLang(''), false)
    // ⚠️ 原型链上的东西不能算 ✗ `'toString' in LANGS` 是 true ✓
    //    所以 isLang 必须用 hasOwnProperty ✓（第一版差点用 in ✗）
    assert.equal(isLang('toString'), false)
  })

  check('每种语言都非空、且真的不一样（别是复制粘贴的）', () => {
    for (const c of codes) {
      if (c === DEFAULT_LANG) continue
      const same = keys.filter((k) => LANGS[c].dict[k] === ZH[k])
      // 允许极少数巧合（比如「音量」这种短词 ✓）但整体不能一样 ✓
      assert.ok(
        same.length < keys.length * 0.3,
        `${c} 有 ${same.length}/${keys.length} 条和中文一模一样 —— 像没翻`,
      )
    }
  })

  console.log('')
  console.log(`通过 ${pass} / 失败 ${fail}`)
  console.log('')

  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.log('  ❌ ' + err.message)
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(1)
})
