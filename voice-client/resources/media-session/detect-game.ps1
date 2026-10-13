# 「正在玩游戏」探测器 —— 常驻进程，按间隔枚举进程名并与白名单比对。
#
# ── 它做什么 ────────────────────────────────────────────────
# 只做一件事：看名单里那几个进程**有没有在跑**。
# 然后输出一行 JSON，**只在变化时**输出。
#
#     {"exe":"LeagueOfLegends.exe"}
#     {"exe":null}
#
# ── 它**不做**什么（这条很重要，和反外挂有关）────────────────
#   · 不读游戏内存        · 不注入 DLL / 不 hook 游戏进程
#   · 不往游戏里发输入    · 不做 overlay（不画在游戏画面上）
#   · 不装键盘钩子
# 只查"某个进程在不在"—— 这是**任务管理器**在做的事，
# Discord / Steam / OBS / 微星小飞机全都在做，和反外挂共存多年。
#
# ⚠️ **只比对传进来的白名单**，不去分析全部进程 ——
#    有些恶意软件也用同样的 API 枚举进程，扫全表更容易被安全软件盯上。
#
# ── 用法 ────────────────────────────────────────────────────
#   powershell -File detect-game.ps1 "leagueoflegends,cs2,dota2"
#
# 白名单从命令行传进来（而不是写死在这里），是为了让**匹配逻辑只有一份**：
# 表在 TypeScript 里，测试能直接测它，脚本只管报"哪个进程在跑"。
#
# ⚠️ 这个文件必须是 **UTF-8 带 BOM**（中文注释 + PS 5.1 按 ANSI 解析的坑）。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 白名单：逗号分隔的进程名（不带 .exe，小写）
$raw = if ($args.Count -gt 0) { [string]$args[0] } else { '' }
$watch = @{}
foreach ($n in ($raw -split ',')) {
  $t = $n.Trim().ToLowerInvariant()
  if ($t) { $watch[$t] = $true }
}

if ($watch.Count -eq 0) {
  Write-Output '{"exe":null,"error":"empty_watchlist"}'
  exit 1
}

$last = ''

while ($true) {
  $hit = $null
  try {
    # Get-Process 拿到的 ProcessName **不带 .exe**，所以两边都按不带处理。
    # 系统里有些受保护进程会抛，用 -ErrorAction SilentlyContinue 跳过。
    foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
      $name = $null
      try { $name = $p.ProcessName } catch { continue }
      if (-not $name) { continue }
      if ($watch.ContainsKey($name.ToLowerInvariant())) {
        $hit = $name
        break
      }
    }
  }
  catch {
    # 枚举整体失败（极少见）—— 当作没在玩，下一轮再试
    $hit = $null
  }

  $json = if ($hit) {
    # 转义一下再拼 —— 进程名不该有引号，但拼 JSON 就别赌
    $safe = $hit -replace '\\', '\\\\' -replace '"', '\"'
    '{"exe":"' + $safe + '"}'
  } else {
    '{"exe":null}'
  }

  if ($json -ne $last) {
    $last = $json
    Write-Output $json
    [Console]::Out.Flush()
  }

  Start-Sleep -Seconds 3
}
