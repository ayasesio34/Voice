// ============================================================================
//  阶段 1 测试用的最小 Electron 应用
//
//  存在的唯一意义：**用一个真实的 Electron 多进程结构播声音**，验证
//  「排除主进程 PID」能不能把它的 Audio Service 子进程也一起排掉。
//
//  这是整个插件方案里最不确定的一点 ——
//  Chromium 的音频不是渲染进程播的，而是一个独立的 utility 进程：
//
//      Electron 主进程
//         ├── 渲染进程
//         └── 🎵 Audio Service 进程   ← 声音其实是从这里出去的
//
//  如果排除主进程排不掉这个子进程，整个方案就得换思路。
// ============================================================================

const { app, BrowserWindow } = require('electron')
const path = require('path')

// 关掉自动播放限制 —— 我们要它一启动就出声，不需要用户先点一下
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 340,
    height: 140,
    title: 'Electron 测试音 1500Hz',
    autoHideMenuBar: true,
    webPreferences: {
      // 窗口万一被遮住或最小化，Chromium 会节流定时器。
      // 音频一般不受影响，但关掉更保险 —— 我们测的就是"声音有没有在放"
      backgroundThrottling: false,
    },
  })

  win.loadFile(path.join(__dirname, 'index.html'))
})
