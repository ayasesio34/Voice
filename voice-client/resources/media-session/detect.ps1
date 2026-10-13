# 「正在听歌」探测器 —— 常驻进程，按间隔读 Windows SMTC（系统媒体控制）。
#
# 为什么是**常驻**而不是每次轮询起一个：PowerShell 启动要 200~500ms 且吃 CPU，
# 几秒一次太浪费。常驻就只付一次启动成本。
#
# 输出：一行一个 JSON，**只在变化时**输出（省得跨进程刷屏）
#   {"active":true,"app":"cloudmusic.exe","title":"...","artist":"...","state":"Playing"}
#   {"active":false}
#
# ⚠️ `active` 的含义是「**当前有正在听的东西**」，不是「正在播放」——
#    暂停时它**也是 true** ✓ 只要那个音乐程序还开着、会话还在 ✓
#    会话消失（播放器被关了）才是 false ✓
#    `state` 里是真实的 PlaybackStatus（Playing / Paused / …），日志里好查。
#
# ⚠️ 三件必须做的事，少一件就出问题：
#   1. Add-Type -AssemblyName System.Runtime.WindowsRuntime
#      —— WindowsRuntimeSystemExtensions 在这个程序集里，不加载就找不到类型
#      （报错是 "Unable to find type [System.WindowsRuntimeSystemExtensions]"）
#   2. [Console]::OutputEncoding = UTF8
#      —— 不设的话中文歌名经管道出去会乱码（默认走 OEM 代码页）
#   3. 只在 PlaybackStatus = Playing 时才算数
#      —— 暂停了就不该显示"正在听"
#
# ⚠️ 这个文件必须是 **UTF-8 带 BOM**。
#    Windows PowerShell 5.1 读无 BOM 的 .ps1 会按系统 ANSI 解析 ——
#    下面的中文注释会变成乱码，某些字节组合还会把引号吃掉导致语法错误。
#    （这个坑在本项目里已经踩过好几次了。）

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]

# PowerShell 5.1 没法直接 await WinRT 的 IAsyncOperation，
# 得借 AsTask() 转成 .NET Task 再 Wait。
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($op, $type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]

try {
  $mgr = Await ($mgrType::RequestAsync()) $mgrType
}
catch {
  # 老版本 Windows 没有 SMTC —— 报一次就退，别空转
  Write-Output '{"active":false,"error":"smtc_unavailable"}'
  exit 1
}

$last = ''

# ⚠️ **只认这些播放器**，名单外的一律不报。
#
#    为什么要有这个名单：Windows 的 SMTC 面板里装的是"**当前活跃的媒体会话**"，
#    浏览器（Chrome / Edge）看过视频之后会**留一个会话在那儿** ✗
#    音乐软件一关，Windows 就把浏览器那个会话**提升成当前会话** ✗
#    于是列表里冒出一个你根本没在看的视频页标题 ✗
#
#    所以：**要么是音乐软件，要么不显示** ✓
#    代价是"在 B 站 / YouTube 听歌"也不显示了 —— 这是明确选的取舍 ✓
#    想加就往下加一行（匹配的是 AUMID，用小写**子串**比，所以写个 exe 名就行）。
$MUSIC_APPS = @(
  'cloudmusic',  # 网易云音乐
  'netease',     # 网易云的其它写法（兜底）
  'qqmusic',     # QQ 音乐
  'kugou',       # 酷狗
  'kwmusic',     # 酷我
  'kuwo',
  'spotify',
  'foobar2000',
  'aimp',
  'musicbee',
  'wmplayer',    # Windows Media Player
  'zunemusic',   # Windows 11 的「媒体播放器」
  'groove',      # 旧版 Groove 音乐
  'itunes',
  'lx-music',    # 洛雪音乐
  'potplayer',
  'vlc'
)

function Test-IsMusicApp($aumid) {
  $s = ([string]$aumid).ToLowerInvariant()
  if (-not $s) { return $false }
  foreach ($n in $MUSIC_APPS) {
    if ($s.Contains($n)) { return $true }
  }
  return $false
}

while ($true) {
  $json = '{"active":false}'
  try {
    $cur = $mgr.GetCurrentSession()
    if ($null -ne $cur) {
      # ⚠️ 两道门，**缺一不可**：
      #
      #    ① 必须是**音乐软件**（Test-IsMusicApp）✓
      #       —— 不然音乐软件一关，Windows 会把浏览器的残留会话顶上来 ✗
      #          列表里就冒出一个你根本没在看的视频页标题 ✗
      #
      #    ② 会话不能是 **Closed** ✓
      #       暂停、停止、刚打开都照报 ✓ —— 也就是"只要音乐程序还在" ✓
      #       （会话 Closed = 播放器被关了 ✓，那时 GetCurrentSession() 也会返回 null ✓）
      $status = $cur.GetPlaybackInfo().PlaybackStatus.ToString()
      if ((Test-IsMusicApp $cur.SourceAppUserModelId) -and $status -ne 'Closed') {
        $props = Await ($cur.TryGetMediaPropertiesAsync()) $propsType
        $title = [string]$props.Title
        if ($title) {
          # 字段叫 active 而不是 playing：暂停时它也是 true，
          # 叫 playing 会误导下一个读这段代码的人。
          $json = @{
            active = $true
            app    = [string]$cur.SourceAppUserModelId
            title  = $title
            artist = [string]$props.Artist
            # 顺带把真实状态带出去，日志里好查（客户端目前不用它）
            state  = $status
          } | ConvertTo-Json -Compress
        }
      }
    }
  }
  catch {
    # 切歌、播放器退出这类瞬间会抛 —— 忽略，下一轮再看
    $json = '{"active":false}'
  }

  if ($json -ne $last) {
    $last = $json
    Write-Output $json
    [Console]::Out.Flush()
  }

  Start-Sleep -Seconds 3
}
