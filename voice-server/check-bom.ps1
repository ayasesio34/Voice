# Guard: every .ps1 that contains non-ASCII MUST be saved as UTF-8 WITH a BOM.
#
# Why this exists
# ---------------
# Windows PowerShell 5.1 reads a .ps1 with NO BOM as ANSI (the OEM codepage).
# Chinese comments then turn into mojibake, and some byte combinations swallow
# quote characters -- so you get confusing parser errors like:
#
#     Token '||' is not a valid statement separator in this version.
#     The string is missing the terminator: ".
#
# Those errors look like the script logic is broken, but the script is fine --
# it is an ENCODING problem. This has bitten this project three times, always
# right after an editor rewrote the file without the BOM.
#
# So: check before deploying, and fail loudly with the actual cause.
#
# This file itself is PURE ASCII on purpose, so it does not need a BOM.

$ErrorActionPreference = 'Stop'

# Walk up to the workspace root (this file lives in <root>\voice-server)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

$skip = '\\(node_modules|out|dist|release|\.venv|\.git)\\'

$bad = @()
$checked = 0

Get-ChildItem $root -Recurse -File -Filter '*.ps1' -ErrorAction SilentlyContinue | ForEach-Object {
  $p = $_.FullName
  if ($p -match $skip) { return }

  $bytes = [System.IO.File]::ReadAllBytes($p)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)

  # Decode as UTF-8 and count non-ASCII characters
  $text = [System.Text.Encoding]::UTF8.GetString($bytes)
  $nonAscii = 0
  foreach ($ch in $text.ToCharArray()) {
    if ([int]$ch -gt 127) { $nonAscii++ }
  }

  if ($nonAscii -eq 0) { return }   # pure ASCII -- BOM not needed
  $checked++

  if (-not $hasBom) {
    $bad += [pscustomobject]@{ Path = $p; Chars = $nonAscii }
  }
}

# ─────────────────────────────────────────────────────────────
# 反向检查：有些文件**绝对不能**有 UTF-8 BOM
#
# 为什么：`.ps1` 需要 BOM（PowerShell 5.1 会按 ANSI 读无 BOM 的 UTF-8）
#   但 **bash 会 source 的文件**（.env）和 **yaml** 加了 BOM 就坏：
#     .env  → bash 把 BOM 当成命令的一部分 → "line 1: #: command not found"
#     yaml  → 解析器把 BOM 当内容 → 直接报错
#
# 踩过：改服务器 IP 时用带 BOM 的方式重写了 .env.example ✓
#       部署时 init.sh source 它就炸了 ✗
# ─────────────────────────────────────────────────────────────
$mustNotHaveBom = @()
Get-ChildItem $root -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object {
    $_.FullName -notmatch '\\(node_modules|out|release|dist|\.git|\.venv)\\' -and
    ($_.Name -like '.env*' -or $_.Extension -in '.sh', '.yaml', '.yml')
  } |
  ForEach-Object {
    $b = [System.IO.File]::ReadAllBytes($_.FullName)
    if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) {
      $mustNotHaveBom += $_.FullName.Replace("$root\", '')
    }
  }

if ($mustNotHaveBom.Count -gt 0) {
  Write-Host ''
  Write-Host '  [FAIL] 这些文件有 UTF-8 BOM，但**不能有**（bash/yaml 会读坏）:' -ForegroundColor Red
  $mustNotHaveBom | ForEach-Object { Write-Host "         $_" -ForegroundColor Red }
  Write-Host ''
  Write-Host '  修法（去掉 BOM）:' -ForegroundColor Yellow
  Write-Host '    $p = "path\to\file"' -ForegroundColor Gray
  Write-Host '    $c = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)' -ForegroundColor Gray
  Write-Host '    [IO.File]::WriteAllText($p, $c, (New-Object Text.UTF8Encoding $false))' -ForegroundColor Gray
  Write-Host ''
  exit 1
}
Write-Host '  [OK]   .env / .sh / .yaml 都没有 BOM（bash 和 yaml 解析器能正常读）'
Write-Host ''
if ($bad.Count -gt 0) {
  Write-Host ''
  Write-Host '  [FAIL] These .ps1 files contain non-ASCII text but have NO UTF-8 BOM:' -ForegroundColor Red
  foreach ($b in $bad) {
    $rel = $b.Path.Replace($root + '\', '')
    Write-Host ("         {0}   ({1} non-ASCII chars)" -f $rel, $b.Chars) -ForegroundColor Red
  }
  Write-Host ''
  Write-Host '  Windows PowerShell 5.1 will read them as ANSI and fail with' -ForegroundColor Yellow
  Write-Host '  confusing parser errors. Fix by re-saving as UTF-8 WITH BOM:' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '    $p = "path\to\file.ps1"' -ForegroundColor Gray
  Write-Host '    $c = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)' -ForegroundColor Gray
  Write-Host '    [IO.File]::WriteAllText($p, $c, (New-Object Text.UTF8Encoding $true))' -ForegroundColor Gray
  Write-Host ''
  exit 1
}

Write-Host ("  [OK]   {0} .ps1 file(s) with non-ASCII all have a UTF-8 BOM" -f $checked) -ForegroundColor Green

# Also check .cmd / .bat: they must be pure ASCII with no BOM.
# cmd.exe reads them in the OEM codepage (GBK on zh-CN), so UTF-8 Chinese
# comments get mis-decoded and can split a command in half. Real case:
# release.cmd reported the bogus error below and never built the installer.
#   'tron-builder' is not recognized as an internal or external command
# Kept as a separate script because the BOM rule is the OPPOSITE for .cmd.
$cmdGuard = Join-Path $PSScriptRoot 'check-cmd-ascii.ps1'
if (Test-Path $cmdGuard) {
  & $cmdGuard
  if ($LASTEXITCODE -ne 0) { exit 1 }
}
exit 0
