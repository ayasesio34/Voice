# 阶段 1：进程级回环捕获 —— 可行性验证

> **结论：通过 ✅**（2026-10-08 实测）
>
> Windows 的 `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` **可以排除
> Electron 的整棵进程树**，包括那个独立播放音频的 AudioService 子进程。
>
> 也就是说：**投屏时分享"系统声音"，可以做到把通话声物理性地排除掉** ——
> 不是事后过滤，零音质损失。

---

## 为什么先做这个验证

最不确定的一点是：**Chromium 的音频不是渲染进程播的**，而是一个独立的 utility 进程。

```
Electron 主进程 (27220)
   ├── gpu-process
   ├── utility  NetworkService
   ├── renderer
   ├── utility  🎵 audio.mojom.AudioService   ← 声音其实是从这里出去的
   └── utility  VideoCaptureService
```

排除模式按的是「进程树」。**主进程是不是这棵树的根、能不能一次排掉音频服务** ——
这个没验证之前，直接写整个 Node 插件是赌博。所以先花半天用一个 350 行的
控制台程序确认。

**实测的进程树确认了**：所有子进程都是主进程的**直接**子进程，树是扁平的。

---

## 验证方法：双频对照 + FFT

不靠耳朵听（太主观），用两个互不成谐波的纯音做对照：

| 测试音 | 谁在播 | 应该 |
|---|---|---|
| **440 Hz** | 普通 PowerShell 进程 | **保留** |
| **1500 Hz** | Electron（最小测试 app） | **被排除** |

然后**两个方向都录一遍**，对照着看 —— 只有这样环境噪声才会被抵消：

```powershell
.\spike.exe --include <Electron主进程PID> --sec 6 --out test-include.wav
.\spike.exe --exclude <Electron主进程PID> --sec 6 --out test-exclude.wav
python verify.py analyze test-include.wav
python verify.py analyze test-exclude.wav
```

---

## 实测结果

```
════ 方向 A：--include 7672（只录 Electron）════
频谱峰值 @ 1500 Hz
   440 Hz (普通进程)    +22.4 dB      ← 环境噪声底
  1500 Hz (Electron)  +149.6 dB  [有]

════ 方向 B：--exclude 7672（系统声音 − Electron）════
频谱峰值 @ 440 Hz
   440 Hz (普通进程)   +135.6 dB  [有]
  1500 Hz (Electron)   +15.5 dB  [无]
```

**同一测量、只改一个开关：1500 Hz 从 +149.6 dB 掉到 +15.5 dB —— 掉了 134 dB。**

环境噪声（Wallpaper Engine、聊天软件一直在出声）在 +15~22 dB 一线，
所以**必须双向对照**，单向结果的 20dB 阈值会被噪声骗过去。
`verify.py` 的阈值因此定在 40 dB。

---

## 踩过的坑（都值得记着）

| 坑 | 表现 | 原因 |
|---|---|---|
| **`.cpp` 没加 BOM** | 一堆莫名其妙的语法错误，`printf` 被当成函数声明 | MSVC 按系统 GBK 读 UTF-8 源码，中文注释变乱码把语法搞崩 |
| **`.cmd` 里有中文** | `cmd.exe : . was unexpected at this time.` | cmd 用 OEM 代码页读 `.cmd`，同样的乱码问题 |
| **`if (...)` 块里的 `(x86)`** | `\Microsoft was unexpected at this time` | `Program Files (x86)` 的 `)` 提前闭合了 cmd 的 if 块 → 改用标签跳转 |
| **`RuntimeClass` 找不到** | `不是 Microsoft::WRL 的成员` | 它在 `<wrl/implements.h>`，不在 `client.h` |
| **类型定义找不到** | `PROCESS_LOOPBACK_MODE` 未定义 | 类型在 `<audioclientactivationparams.h>`，**不在** `audioclient.h` |
| **`GetMixFormat` 返回 E_NOTIMPL** | `0x80004001` | **进程级回环不支持它**，必须自己指定格式（16位PCM/48k/立体声） |
| **`ELECTRON_RUN_AS_NODE=1`** | Electron 退化成一个 Node 进程，`app` 是 undefined | DSH 环境里设了这个变量；跑 Electron 前必须清掉 |
| **`require('electron')` 被抢** | 返回 npm 包的路径字符串而不是 API | 测试 app 放在 `voice-client/` 里，被 `node_modules/electron` 遮蔽 → 挪到 `%TEMP%` |

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `spike.cpp` | 验证程序本体（`--list` / `--include` / `--exclude`） |
| `build.cmd` | 编译脚本（自动调 `vcvars64.bat`）。**必须保持纯 ASCII** |
| `verify.py` | 生成测试音 + FFT 频谱分析 |
| `tone-app/` | 最小 Electron 测试 app（Web Audio 合成 1500 Hz） |
| `test-include.wav` | 方向 A 的录音 —— 听得到 1500 Hz |
| `test-exclude.wav` | 方向 B 的录音 —— **听不到 1500 Hz** |

**两个 WAV 直接用播放器听就能感受到差别**，是这次验证最直观的证据。

---

## 环境要求

- **Windows 10 Build 20348+**（Win11 或较新的 Win10）—— 老系统上这个 API 不存在，需要降级回整系统捕获
- VS Build Tools（VCTools + Windows SDK 10.0.20348+）

---

## 下一步（阶段 2~5）

```
阶段 2  包成 Node 原生插件（node-addon-api）         半天
阶段 3  接进渲染进程（IPC → AudioWorklet → LiveKit）  半天
阶段 4  接 UI（共享时多一个「系统声音（不含通话）」）+ 版本降级  半天
阶段 5  打包（prebuild、asarUnpack）+ 朋友装完即可用  半天
```

**注意**：阶段 5 的"朋友装完即可用"是**可以做到**的 ——
原生模块编译只发生在**发布这台机器**上，编译好的 `.node` 会打进安装包。
