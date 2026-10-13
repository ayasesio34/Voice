# 进程级音频回环捕获 —— Node 原生插件

> **阶段 2 完成 ✅** —— 插件已编译、已双向实测、已验证能在 Electron 里免重编加载。

把 Windows 的**进程级回环捕获**包成 Node 插件。Voice 客户端用它实现
「**只分享系统音频、不含频道对话声**」：

```
系统混音（游戏 + 音乐 + 通话声）
  −  本软件的进程树（通话声就是从这儿放出来的）
  ─────────────────────────────────
  =  游戏 + 音乐
```

通话声是**物理上没进过采集链路**，不是事后过滤 —— **零音质损失**。

---

## 为什么用 N-API，不用老的 NAN

**N-API 的 ABI 跨 Node 和 Electron 版本都稳定。** 这一条直接消掉了原生模块
最大的那条维护成本。实测过：

```
编译时   Node 24.16.0        modules ABI 137   napi 10
运行时   Electron 33.4.11    modules ABI 130   napi 9   （Node 20.18.3）
         → require 成功、实例化成功、stop() 成功
```

**Node 主版本不同、原生 ABI 号也不同，同一个 `.node` 照常工作。**
以后升级 Electron **不需要重新编译**。

---

## API

```js
const loopback = require('./native/process-loopback')

loopback.available        // 插件能不能用
loopback.reason           // 不可用的原因（给设置界面显示）

// 创建一个捕获器
const cap = loopback.create()   // 不可用时返回 null

cap.start({ pid: 1234, mode: 'exclude' }, (buf) => {
  // buf 是 Node Buffer：交错立体声、16 位有符号、48kHz
  // 也就是可以直接喂给 AudioWorklet 的那种
  //
  // 出问题时回调收到的是 Error 对象，要判断一下
  if (buf instanceof Error) return console.error(buf.message)
})

cap.running    // boolean
cap.stop()

// 列出默认输出设备上正在出声的进程（排查"该排除谁"时用）
loopback.listSessions()   // [{ pid, name, active }]
```

`mode`：
- `'exclude'` —— 录**除了**这棵进程树之外的全部系统声音（本项目的用法）
- `'include'` —— **只**录这棵进程树

**插件不可用时必须优雅降级。** `available` 为 false 时上层要退回整系统捕获，
而不是起不来。不可用的情形：非 Windows、没编译、Windows 版本太老（< 20348）。

---

## 编译

```powershell
cd native/process-loopback
npm install
npm run build
node test.js
```

**环境要求**

| | |
|---|---|
| Windows | **Build 20348+**（Win11 或较新 Win10） |
| VS Build Tools | VCTools + Windows SDK 10.0.20348+ |
| Python | 3.8+（node-gyp 用） |
| node-gyp | **v11+** —— v9 不支持 Python 3.12（见下） |

---

## 实测结果

用两个互不成谐波的纯音做双向对照（440Hz 普通进程 / 1500Hz Electron）：

```
方向 A  --include（只录 Electron）
  峰值 11426 / 32767 · RMS 8047
  1500Hz  +143.3 dB  [有]
   440Hz   +16.6 dB  [无]        ← 环境噪声底
  [OK]

方向 B  --exclude（系统声音 − Electron）
  峰值 11472 / 32767 · RMS 8047
   440Hz  +133.0 dB  [有]
  1500Hz   +17.8 dB  [无]        ← Electron 的声音没了
  [OK]
```

**同一测量、只改一个开关：1500Hz 掉了 126 dB。**

### ⚠️ 别拿"收到多少数据"当成功判据

第一次跑测试时收到 198 块、190080 采样、完整度 99%，看着完全正常 ——
**但峰值只有 11/32767，也就是静音。**

链路通 ≠ 采到了东西。`test.js` 因此加了 `peak < 50` 的显式警告，
真正的判断必须靠 `--wav` 存下来做频谱分析。

---

## 踩过的坑

| 坑 | 表现 | 原因 / 解法 |
|---|---|---|
| **`distutils` 没了** | `ModuleNotFoundError: No module named 'distutils'` | Python 3.12 删掉了 `distutils`，node-gyp 9.x 还在用 → **装 node-gyp@^11** |
| **子目录不继承 `.npmrc`** | npm 走 registry.npmjs.org 直接卡死 | npm **只**看当前目录/用户级/全局级，**不向上找** → 子项目自带一份 `.npmrc` |
| **Node 头文件下不动** | `gyp ERR! FetchError ... node-v24-headers.tar.gz` | nodejs.org 连不上 → `--dist-url=https://npmmirror.com/mirrors/node` |
| **`.cc` 没加 BOM** | 一堆莫名其妙的语法错误 | MSVC 按系统 GBK 读 UTF-8 源码（和 spike 是同一个坑） |

---

## 线程模型

采集是阻塞循环，**绝不能占用 JS 主线程**：

```
start()  →  起一个 std::thread 跑采集
            线程里用 ThreadSafeFunction 把 PCM 推回 JS
stop()   →  置停止标志 → SetEvent 叫醒 → join → 释放 TSFN
```

几个关键点：

- **COM 要按线程初始化** —— 工作线程里自己 `CoInitializeEx` 一遍
- **用 `NonBlockingCall`** —— JS 忙的时候宁可丢这一块，也不能堵住采集线程。
  音频流堵住只会越积越多，最后全烂掉。
- **TSFN 必须在 join 之后才 Release** —— 提前释放时线程里可能正有一次调用在飞，会崩
- **`WaitForMultipleObjects` 等两个事件** —— 音频事件和停止事件，谁先来都行，
  这样 `stop()` 能立刻响应，不用等 500ms 超时
