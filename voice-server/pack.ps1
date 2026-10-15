<#
  打包成一个 tar.gz，用来上传到服务器。

  ⚠️⚠️ 为什么必须用它，而不能直接 `scp -r voice-server root@IP:/opt/` ✗

    `backend/node_modules` 有 **3100+ 个文件**（约 17 MB）✓
    scp -r 是**一个文件一个文件**传的 ✗ 在 SSH 上慢得像卡死 ✓
    而且服务器上第 9 步会自己跑 `npm install --omit=dev` ✓
    → 传上去的依赖**完全没用** ✓ 白等十几分钟 ✗

  （真踩过：盯着进度条以为传完了 ✓ 其实才一半 ✓）

  打包之后是**一个文件**（约 0.15 MB ✓ 50 个条目 ✓）几秒钟传完 ✓

  用法：
      .\pack.ps1
  然后：
      scp ..\voice-server.tgz root@你的公网IP:/opt/
  服务器上：
      cd /opt && rm -rf voice-server && tar xzf voice-server.tgz && rm voice-server.tgz
#>

$ErrorActionPreference = "Stop"

$here = $PSScriptRoot
$parent = Split-Path $here -Parent
$name = Split-Path $here -Leaf
$out = Join-Path $parent "$name.tgz"

if (Test-Path $out) { Remove-Item $out -Force }

Write-Host ""
Write-Host "  打包 $name ..." -ForegroundColor Cyan

Push-Location $parent
try {
  & tar --exclude="$name/backend/node_modules" `
        --exclude="$name/node_modules" `
        --exclude="$name/.git" `
        --exclude="$name/*.tgz" `
        -czf "$name.tgz" "$name"
} finally {
  Pop-Location
}

if (-not (Test-Path $out)) { throw "打包失败：$out 没生成" }

$sizeMB = (Get-Item $out).Length / 1MB
$entries = (& tar -tzf $out | Measure-Object).Count
$nm = (& tar -tzf $out | Select-String 'node_modules').Count

Write-Host ""
Write-Host ("  产物: {0}" -f $out) -ForegroundColor Green
Write-Host ("  大小: {0:N2} MB ✓" -f $sizeMB)
Write-Host ("  条目: {0} 个" -f $entries)
if ($nm -gt 0) {
  Write-Host ("  ⚠️ 里面还有 {0} 条 node_modules ✗ 不该有 ✗" -f $nm) -ForegroundColor Yellow
} else {
  Write-Host "  ✅ node_modules 零残留 ✓" -ForegroundColor Green
}
Write-Host ""
Write-Host "  上传（在你电脑上）：" -ForegroundColor Cyan
Write-Host "    ⚠️ 产物在**上一层**目录 ✗ 所以路径要带 ..\" -ForegroundColor Yellow
Write-Host "    scp ..\$name.tgz root@你的公网IP:/opt/"
Write-Host ""
Write-Host "  或者用绝对路径（不会搞错 ✓）：" -ForegroundColor Cyan
Write-Host "    scp `"$out`" root@你的公网IP:/opt/"
Write-Host ""
Write-Host "  服务器上解开：" -ForegroundColor Cyan
Write-Host "    cd /opt && rm -rf $name && tar xzf $name.tgz && rm $name.tgz"
Write-Host ""