#Requires -Version 5.1
<#
  把服务端源码发到 ECS 上。

  为什么做成脚本，而不是让人手敲两行 scp/ssh：
    手敲时**工作目录一变**，`$src\index.js` 就解析不到，
    scp 静默失败，然后 ssh 那边报 "cannot stat '/opt/index.js'" ——
    真正的错误（本地文件没传上去）被后面那条命令的报错盖住了。
    这个脚本每一步都先校验再往下走，错在哪一眼就能看见。

  用法：
      cd voice-server
      .\deploy.cmd

  会提示两次密码（scp 一次、ssh 一次）。这是用户明确选择的方案（不用密钥）。
#>

$ErrorActionPreference = 'Stop'

$Server  = 'root@YOUR_SERVER_IP'
# ⚠️ 这台机器是 NAT 型 VPS ✓ 服务商把 SSH 映射到了 17705 ✗ 不是 22 ✓
#    所以 ssh 要 -p、scp 要 -P（大小写不一样 ✗ 这是经典坑 ✓）
$Port    = 17705
$Remote  = '/opt/voice-server/backend/src'
$Health  = 'http://YOUR_SERVER_IP:17706/health'

# 要发的文件 —— **自动列出 src 下所有 .js / .mjs**。
#
# ⚠️ 这里原来是手写的清单：@('index.js', 'db.js')，后来加了 fix-member.mjs。
#    结果 version.js / livekit.js / voice-chime.js **从来没被上传过** ✗
#    表现就是：代码明明改了、也"部署成功"了，服务器上跑的还是旧的 ——
#    版本号一直显示 1.0.0 就是这么来的。
#
#    手写清单迟早会和真实目录对不上（和之前那个写死的 mv 是同一个教训）。
#    能生成就别手写。
$Files = @(
  Get-ChildItem (Join-Path $PSScriptRoot 'backend\src') -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.js', '.mjs' } |
    Select-Object -ExpandProperty Name
)

if ($Files.Count -eq 0) {
  Write-Host '  [错误] backend\src 里一个文件都没找到' -ForegroundColor Red
  exit 1
}

# 本地版本号 —— 待会儿拿去和服务器上的比。
# ⚠️ 这一步是**关键**：以前复核只打印 serverVersion，不和本地比，
#    于是"文件根本没传上去"这种情况会被打印成一行绿油油的 [OK] ✗
$LocalVersion = ''
$verFile = Join-Path $PSScriptRoot 'backend\src\version.js'
if (Test-Path $verFile) {
  $m = [regex]::Match((Get-Content $verFile -Raw -Encoding UTF8), "SERVER_VERSION = '([^']+)'")
  if ($m.Success) { $LocalVersion = $m.Groups[1].Value }
}

function Say($msg)  { Write-Host $msg }
function Ok($msg)   { Write-Host "  [OK]   $msg" -ForegroundColor Green }
function Bad($msg)  { Write-Host "  [错误] $msg" -ForegroundColor Red }
function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }

# ── 0. 先站到脚本自己所在的目录 ────────────────────────────
# 这一步是关键：不管从哪里调用，路径都能解析对
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

Step '检查本地文件'
$src = Join-Path $here 'backend\src'
if (-not (Test-Path $src)) {
  Bad "找不到目录：$src"
  exit 1
}

$missing = @()
foreach ($f in $Files) {
  $p = Join-Path $src $f
  if (Test-Path $p) {
    $item = Get-Item $p
    Ok ("{0,-12} {1,8:N0} 字节   {2}" -f $f, $item.Length, $item.LastWriteTime.ToString('MM-dd HH:mm'))
  } else {
    Bad "缺少 $f"
    $missing += $f
  }
}
if ($missing.Count -gt 0) {
  Bad "本地文件不全，先别传。缺：$($missing -join ', ')"
  exit 1
}

# ── 1. 记录当前线上状态（好对比重启前后）─────────────────
Step '重启前的线上状态'
try {
  $before = Invoke-RestMethod $Health -TimeoutSec 12
  Say "  serverVersion = $($before.serverVersion)"
  Say "  uptimeSec     = $([math]::Round($before.uptimeSec))  （重启后会归零）"
} catch {
  Bad "读不到 /health：$($_.Exception.Message)"
  Say '  （不一定是坏事 —— 服务本来就挂了的话也得能部署。继续。）'
}

# ── 2. 先把要发往服务器的脚本拼好 ─────────────────────────
#
# ⚠️ 拼装放在**上传之前**，是为了支持 -DryRun：
#    把「将会发到服务器的脚本」原样打出来然后退出，一个密码都不用输。
#    没有它就只能真跑一遍才知道要发生什么 —— 出错时已经付出一次密码了。
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# ⚠️ 远程命令里的文件名**必须从 $Files 生成**，不能写死。
#
#    这里踩过一次：$Files 里加了 fix-member.mjs、scp 也传上去了，
#    但远程那段还是 `mv /tmp/index.js /tmp/db.js $Remote/` ——
#    于是新文件停在 /tmp，部署"成功"了但工具根本不在位置上。
#    教训：手写的清单迟早和真正的清单对不上，能生成就别手写。
$tmpList = ($Files | ForEach-Object { "/tmp/$_" }) -join ' '
$destDir = $Remote
$curList = ($Files | ForEach-Object { "$Remote/$_" }) -join ' '
# 只对 JS / MJS 做语法自检（node --check 两种都认）
$checks = ($Files | Where-Object { $_ -match '\.m?js$' } | ForEach-Object { "node --check $_" }) -join ' && '

$remote = @"
set -e
echo '--- 收到的文件 ---'
ls -l $tmpList

echo '--- 确认目标目录存在 ---'
ls -ld $destDir

echo '--- 备份现有文件到 /opt/voice-backup-$stamp ---'
sudo mkdir -p /opt/voice-backup-$stamp
sudo cp $curList /opt/voice-backup-$stamp/ 2>/dev/null || echo '(老文件不存在，跳过备份)'

echo '--- 就位 ---'
sudo mv $tmpList $destDir/

echo '--- 语法自检（不通过就别重启，免得把服务搞挂）---'
cd $destDir && $checks

echo '--- 重启 ---'
sudo systemctl restart voice-backend
sleep 3

echo '--- 重启后 /health ---'
curl -s $Health; echo
"@

# ── 干跑开关 ─────────────────────────────────────────────
# deploy.cmd -DryRun → 只打印要发生什么，不连服务器、不问密码
if ($args -contains '-DryRun') {
  Step '干跑（-DryRun）：不会上传、不会连服务器、不会问密码'
  Say '  会 scp 这些文件：'
  foreach ($f in $Files) { Say "    $src\$f" }
  Say "    →  ${Server}:/tmp/"
  Say ''
  Say '  然后在服务器上执行：'
  Say '  ┌─────────────────────────────────────────────────'
  $remote -split "`n" | ForEach-Object { Write-Host "  │ $_" }
  Say '  └─────────────────────────────────────────────────'
  Say ''
  Say '  什么都没做。去掉 -DryRun 才会真的部署。'
  exit 0
}

# ── 3. 上传到 /tmp ───────────────────────────────────────
# 传 /tmp 而不是直接传 /opt：/tmp 一定存在、一定可写，
# 少一个"目标目录到底在不在"的变量
Step "上传到 $Server （第 1 次密码）"
$scpArgs = @()
foreach ($f in $Files) { $scpArgs += (Join-Path $src $f) }
$scpArgs += "${Server}:/tmp/"

& scp -P $Port @scpArgs
if ($LASTEXITCODE -ne 0) {
  Bad "scp 失败（退出码 $LASTEXITCODE）"
  Say '  常见原因：网络不通、密码错、或者上面的文件路径没解析到。'
  exit 1
}
Ok '上传完成'

# ── 4. 备份 → 就位 → 重启 → 自检 ─────────────────────────
Step "在服务器上安装并重启 （第 2 次密码）"

& ssh -p $Port $Server $remote
if ($LASTEXITCODE -ne 0) {
  Bad "远程命令失败（退出码 $LASTEXITCODE）"
  Say "  已备份在 /opt/voice-backup-$stamp/，要回滚："
  Say "    ssh -p $Port $Server `"sudo cp /opt/voice-backup-$stamp/* $Remote/ && sudo systemctl restart voice-backend`""
  exit 1
}

# ── 4. 从本地确认一遍 ────────────────────────────────────
#
# ⚠️ 复核**必须和本地比**，不能只把服务器的值打印出来。
#    以前就是只打印，于是"version.js 根本没传上去"被显示成一行绿色的
#    [OK] serverVersion = 1.0.0 ✗ 看着像成功，其实什么都没更新 ✓
Step '复核'
Start-Sleep -Seconds 2
try {
  $after = Invoke-RestMethod $Health -TimeoutSec 12

  $remoteVersion = "$($after.serverVersion)"
  $uptime = [math]::Round($after.uptimeSec)

  if ($LocalVersion -and $remoteVersion -ne $LocalVersion) {
    Bad "serverVersion 对不上！服务器上是 $remoteVersion，本地是 $LocalVersion"
    Say '  说明有文件没真正就位。常见原因：'
    Say '    · 清单里漏了文件（现在改成自动列出了，应该不会再有）'
    Say '    · scp 传了但 mv 没执行'
    Say '  去服务器上看看文件时间戳：'
    Say "    ssh -p $Port $Server `"ls -l --time-style=+%F_%T $Remote/`""
    exit 1
  }
  if ($LocalVersion) {
    Ok "serverVersion = $remoteVersion  （和本地一致 ✓）"
  } else {
    Ok "serverVersion = $remoteVersion  （本地读不到版本号，没法比）"
  }

  Ok "uptimeSec     = $uptime  （比刚才小很多 = 确实重启了）"

  if ($uptime -gt [math]::Round($before.uptimeSec)) {
    Write-Host '  [注意] uptime 反而变大了，可能没重启成功' -ForegroundColor Yellow
  }
} catch {
  Bad "重启后读不到 /health：$($_.Exception.Message)"
  Say "  去看日志：ssh -p $Port $Server `"journalctl -u voice-backend -n 40 --no-pager`""
  exit 1
}

Say ''
Say '部署完成。' -ForegroundColor Green
Say '（这一版数据库会自动迁移，不用手工改库）'
