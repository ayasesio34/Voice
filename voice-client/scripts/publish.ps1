<#
  打包产物上传 + 清理服务器上的旧安装包。

  用法：
     npm run dist              # 先打包
     npm run publish:update    # 再上传（并顺手清理）

  或者直接：
     .\scripts\publish.ps1
     .\scripts\publish.ps1（默认发布到 YOUR_SERVER_IP ✓ 想发别处用 -Server/-Port 覆盖 ✓）
     .\scripts\publish.ps1 -NoPrune        # 这次不清理旧包

  上传的是三个东西（**只传当前版本，不会把历史版本重传一遍**）：
     latest.yml                        版本清单。客户端靠它判断要不要更新
     Voice-vX.Y.Z-setup.exe            安装包本体
     Voice-vX.Y.Z-setup.exe.blockmap   差分更新的索引

  注意：latest.yml 必须和 exe 一起传，而且清单里的 sha512 对应那个 exe。
        只传 exe 不传 yml，客户端不会知道有新版本。

  ── 关于密码 ────────────────────────────────────────────────
  正常情况问 **2 次**：
     ① scp 上传
     ② ssh 清理旧包
  远端目录不存在时会多问一次（先建目录再重传），但那只需要发生一次。
  想彻底不问就配 SSH 密钥，见 README。
#>
param(
  [string]$Server = "root@YOUR_SERVER_IP",
  # 普通 VPS：SSH 走默认 22 ✓（ssh 用 -p，scp 用 -P ✗）
  [int]$Port = 22,
  [string]$RemoteDir = "/opt/voice-server/updates",
  [string]$PruneScript = "/opt/voice-server/scripts/prune-updates.sh",
  [switch]$NoPrune
)

$ErrorActionPreference = "Stop"

$projectDir = Split-Path $PSScriptRoot -Parent
$releaseDir = Join-Path $projectDir "release"

if (-not (Test-Path $releaseDir)) {
  throw "找不到 $releaseDir -- 先跑 npm run dist"
}

# 从 package.json 取当前版本，只挑这个版本的产物。
# release 目录里会堆着历史版本的 exe（electron-builder 不会清理），
# 不按版本号过滤的话每次都要把几百 MB 的历史包重传一遍。
#
# ⚠️ `-Encoding UTF8` **必须写**。
#
#    Windows PowerShell 5.1 的 `Get-Content` 默认按**系统 ANSI 代码页**读文件
#    （除非文件带 BOM），而 npm 写出来的 package.json 是 **UTF-8 无 BOM**。
#    于是中文 description 被解成乱码 —— 而且不只是"显示难看"：
#    UTF-8 的「端」(E7 AB AF) 被按 GBK 解出来时会**顺带吃掉后面那个引号**，
#    结果 JSON 字符串没闭合，ConvertFrom-Json 直接报
#    「传入的对象无效，应为":"或"}"」。
#
#    pwsh 7 默认就是 UTF-8，所以这个坑只在 5.1 上出现 —— 而 .cmd 里
#    优先用的是 pwsh、退回 powershell，正好两条路都有可能走到。
$pkg = Get-Content (Join-Path $projectDir "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version

Write-Host "当前版本: $version" -ForegroundColor Cyan

$latest = Join-Path $releaseDir "latest.yml"
if (-not (Test-Path $latest)) {
  throw "找不到 latest.yml -- 先跑 npm run dist（版本清单是它生成的）"
}

# 校验清单里的版本和 package.json 一致。
# 对不上说明 dist 之后又改过版本号，这时候传上去会让所有人收到错误版本的清单。
# 同样显式按 UTF-8 读 —— 和上面一个道理，别赌它一定是纯 ASCII
$manifest = Get-Content $latest -Raw -Encoding UTF8
$pattern = "(?m)^version:\s*" + [regex]::Escape($version) + "\s*$"
if ($manifest -notmatch $pattern) {
  Write-Host "latest.yml 里的版本和 package.json 不一致！" -ForegroundColor Yellow
  Write-Host "说明 dist 之后又改过版本号 —— 请重新跑一次 npm run dist" -ForegroundColor Yellow
  throw "版本不一致，已中止"
}

$versionTag = "v$version"
$files = @(Get-Item $latest) + @(
  Get-ChildItem -Path $releaseDir -File | Where-Object {
    $_.Name -like "*$versionTag*.exe" -or $_.Name -like "*$versionTag*.blockmap"
  }
)

if ($files.Count -lt 2) {
  throw "只找到 latest.yml，没找到 $versionTag 的安装包 -- 先跑 npm run dist"
}

Write-Host "将要上传:" -ForegroundColor Cyan
$files | ForEach-Object {
  Write-Host ("  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB))
}

# ── 上传 ────────────────────────────────────────────────────
# 不先 mkdir，直接传 —— 目录绝大多数时候都在，这样能省一次密码。
# 真失败了（第一次发布、或者目录被删了）再建目录重传一次。
Write-Host ""
Write-Host "上传中（会问一次密码）..." -ForegroundColor Cyan
scp -P $Port $files.FullName "${Server}:${RemoteDir}/"

if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "上传失败 —— 远端目录可能还不存在，建一下再试。" -ForegroundColor Yellow
  ssh -p $Port $Server "mkdir -p $RemoteDir"
  scp -P $Port $files.FullName "${Server}:${RemoteDir}/"
  if ($LASTEXITCODE -ne 0) { throw "上传仍然失败，请检查上面的报错" }
}

Write-Host "上传完成。" -ForegroundColor Green

# ── 清理旧包 ────────────────────────────────────────────────
# 客户端只会下最新版，历史安装包是纯粹的死重量（每个约 80 MB，只涨不减）。
# 清理脚本在服务器上，见 voice-server/scripts/prune-updates.sh
if ($NoPrune) {
  Write-Host "（-NoPrune：跳过了旧包清理）" -ForegroundColor DarkGray
} else {
  Write-Host ""
  Write-Host "清理服务器上的旧安装包（会再问一次密码）..." -ForegroundColor Cyan
  ssh -p $Port $Server "bash $PruneScript --yes"

  if ($LASTEXITCODE -ne 0) {
    # 清理失败**不该**让这次发布算失败 —— 新版本已经传上去了，那边是好的
    Write-Host ""
    Write-Host "清理没成功，但这次发布是好的（新版本已经传上去了）。" -ForegroundColor Yellow
    Write-Host "多半是清理脚本还没放到服务器上。传一次就行：" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  scp -P $Port voice-server\scripts\prune-updates.sh ${Server}:/opt/voice-server/scripts/" -ForegroundColor White
    Write-Host ""
  }
}

Write-Host ""
Write-Host "全部完成。" -ForegroundColor Green
Write-Host ""
Write-Host "服务器上确认清单："
Write-Host "  curl -s http://127.0.0.1:3005/updates/latest.yml"
