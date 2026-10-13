#!/usr/bin/env pwsh
# ─────────────────────────────────────────────────────────────
# 检查所有 .cmd / .bat 是不是**纯 ASCII**、且**没有 BOM**
#
# ── 为什么单独一个脚本 ──────────────────────────────────────
# check-bom.ps1 管的是 .ps1（必须有 BOM）和 .env/.sh/.yaml（必须没有）✓
# 这个管的是 .cmd —— 要求是"纯 ASCII + 无 BOM" ✓
# 分开是因为"要 BOM / 不要 BOM"的规则正好相反 ✓ 混在一起容易看错 ✓
#
# ── 为什么 .cmd 不能有中文 ──────────────────────────────────
# cmd.exe 按**控制台代码页**读批处理文件 ✓ 中文系统是 GBK ✓
# 而文件如果存成 UTF-8 ✗ 中文注释的字节就会被解成乱码 ✓
# 乱码里某些字节**正好凑成一个"命令"** ✗ → 把命令行**从中间截断** ✓
#
# 实际踩到的（2026-10）：release.cmd 里有中文注释 ✓
#   跑的时候报：
#       '敞鎰忥細濡傛灉鎶?..." 不是内部或外部命令
#       'tron-builder' 不是内部或外部命令        ← electron-builder 被截断了
#   结果：安装包**根本没打出来** ✓ 而命令看起来只是"报了个奇怪的错" ✓
#
# BOM 同理：有 BOM 的话**第一行** `@echo off` 前面多了三个字节 ✗
#   第一行就会报错 ✓
#
# 所以：.cmd 里的注释**一律写英文** ✓
#
# 用法：pwsh -NoProfile -File check-cmd-ascii.ps1
# 退出码：0 = 全部合格 ✓ 1 = 有违规 ✓
# ─────────────────────────────────────────────────────────────

$ErrorActionPreference = 'Stop'

# 从脚本所在目录往上找到工作区根（含 voice-server 和 voice-client 的那层）
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = $here
for ($i = 0; $i -lt 4; $i++) {
  if ((Test-Path (Join-Path $root 'voice-client')) -and (Test-Path (Join-Path $root 'voice-server'))) { break }
  $root = Split-Path -Parent $root
}
if (-not (Test-Path (Join-Path $root 'voice-client'))) {
  $root = Split-Path -Parent $here   # 退回上一级，至少还能扫到点东西
}

Write-Host ''
Write-Host "  扫描 .cmd / .bat（根目录：$root）" -ForegroundColor DarkGray

$bad = @()
$checked = 0

# ⚠️ **只扫我们这两个项目** ✗
#    工作区里还有别的项目（比如 market-sim）✓ 它们的 .bat 有中文是他们的事 ✗
#    全都扫的话，deploy.cmd 会因为**不相干的项目**而失败 ✓ 那就本末倒置了 ✓
Get-ChildItem $root -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object {
    ($_.FullName -like "$root\voice-server\*") -or ($_.FullName -like "$root\voice-client\*")
  } |
  Where-Object {
    $_.Extension -in '.cmd', '.bat' -and
    $_.FullName -notmatch '\\(node_modules|out|release|dist|\.git|\.venv)\\' -and
    $_.Length -lt 2MB
  } |
  ForEach-Object {
    $checked++
    $bytes = [System.IO.File]::ReadAllBytes($_.FullName)

    $nonAscii = 0
    foreach ($x in $bytes) { if ($x -gt 127) { $nonAscii++ } }

    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF

    if ($nonAscii -gt 0 -or $hasBom) {
      $why = @()
      if ($nonAscii -gt 0) { $why += "$nonAscii 个非 ASCII 字节" }
      if ($hasBom) { $why += '开头有 BOM' }
      $bad += [pscustomobject]@{
        File   = $_.FullName.Replace("$root\", '')
        Reason = ($why -join ' + ')
      }
    }
  }

if ($bad.Count -gt 0) {
  Write-Host ''
  Write-Host '  [FAIL] 这些批处理文件会读乱 —— cmd.exe 按 GBK 解释 UTF-8 中文：' -ForegroundColor Red
  foreach ($b in $bad) {
    Write-Host ("         {0}" -f $b.File) -ForegroundColor Red
    Write-Host ("           {0}" -f $b.Reason) -ForegroundColor DarkRed
  }
  Write-Host ''
  Write-Host '  修法：' -ForegroundColor Yellow
  Write-Host '    1. 把 .cmd 里所有中文注释改成**英文**' -ForegroundColor Gray
  Write-Host '    2. 另存为 UTF-8 **无 BOM**' -ForegroundColor Gray
  Write-Host ''
  Write-Host '  症状长这样（命令行被从中间截断）：' -ForegroundColor DarkGray
  Write-Host "    'tron-builder' is not recognized as an internal or external command" -ForegroundColor DarkGray
  Write-Host ''
  exit 1
}

Write-Host "  [OK]   $checked 个 .cmd / .bat 都是纯 ASCII 且无 BOM" -ForegroundColor Green
Write-Host ''
exit 0
