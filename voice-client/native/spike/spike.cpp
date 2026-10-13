// ============================================================================
//  阶段 1 验证程序 —— Windows 进程级回环捕获（排除模式）
//
//  目的：证明「录整个系统，但**排除掉本软件的进程树**」这条路走得通。
//        走通了，投屏的系统声音里就再也不会有通话声 —— 而且是**物理上没录进去**，
//        不是事后过滤，零音质损失。
//
//  为什么这段代码要单独存在、不直接写成 Node 插件：
//        最不确定的一点是 **Chromium 的音频是由独立的 Audio Service 进程播放的**，
//        而排除模式按的是「进程树」。主进程是不是这棵树的根、能不能一次排掉
//        音频服务 —— 这个没验证之前，写整个插件是赌博。
//        所以先花半天用一个 300 行的控制台程序确认。通了再包成插件。
//
//  用法：
//      spike.exe --list                     列出正在出声的进程（看谁在播音频）
//      spike.exe --exclude <pid> --sec 10   录 10 秒，排除该进程树
//      spike.exe --exclude <pid> --sec 10 --out test.wav
//
//  编译（VS 开发者命令提示符里）：
//      cl /std:c++17 /EHsc /O2 spike.cpp ole32.lib oleaut32.lib uuid.lib /Fe:spike.exe
// ============================================================================

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>

// ⚠️ 进程级回环的类型**不在** audioclient.h 里，而在这个单独的头文件：
//      PROCESS_LOOPBACK_MODE / AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS /
//      AUDIOCLIENT_ACTIVATION_PARAMS / VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
//    少了它，编译器会报"这些标识符未定义"，很容易误以为要自己补一份。
//    需要 Windows SDK 10.0.20348 以上。
#include <audioclientactivationparams.h>

#include <comdef.h>

// RuntimeClass / FtmBase 在 implements.h 里 —— client.h 只有 ComPtr。
// 只 include client.h 的话会报一个很难懂的「RuntimeClass 不是 Microsoft::WRL 的成员」。
#include <wrl/implements.h>

#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

// 进程级回环的类型、以及虚拟设备 id（VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK），
// 全部由 <audioclientactivationparams.h> 提供 —— 见文件顶部的说明。
// 一开始我以为它在 audioclient.h 里、还自己补了一份 typedef，
// 结果是重复定义。SDK 已经给了，直接用就好。

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

static void fail(const char* what, HRESULT hr) {
  char buf[512];
  _snprintf_s(buf, sizeof(buf), _TRUNCATE, "[失败] %s  (HRESULT 0x%08lX)", what,
              static_cast<unsigned long>(hr));
  std::fprintf(stderr, "%s\n", buf);
}

/** 进程 id -> 可执行文件名。拿不到就返回 "?" */
static std::string procName(DWORD pid) {
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return "?";

  wchar_t path[MAX_PATH] = {};
  DWORD len = MAX_PATH;
  std::string out = "?";
  if (QueryFullProcessImageNameW(h, 0, path, &len)) {
    const wchar_t* base = wcsrchr(path, L'\\');
    base = base ? base + 1 : path;
    // 只取窄字符部分，够看了（中文路径会退化，不影响判断）
    char narrow[MAX_PATH] = {};
    WideCharToMultiByte(CP_ACP, 0, base, -1, narrow, sizeof(narrow), nullptr, nullptr);
    out = narrow;
  }
  CloseHandle(h);
  return out;
}

// ---------------------------------------------------------------------------
// --list：枚举默认输出设备上的所有音频会话
//
// 这一步是**诊断的关键**：能直接看出通话声音到底是从哪个进程出去的。
// 如果 Electron 的音频挂在 Audio Service 进程上（而不是主进程），
// 那排除策略就要相应调整。
// ---------------------------------------------------------------------------

static int listSessions() {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) { fail("CoInitializeEx", hr); return 1; }

  ComPtr<IMMDeviceEnumerator> enumerator;
  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                        IID_PPV_ARGS(&enumerator));
  if (FAILED(hr)) { fail("MMDeviceEnumerator", hr); return 1; }

  ComPtr<IMMDevice> device;
  hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  if (FAILED(hr)) { fail("GetDefaultAudioEndpoint", hr); return 1; }

  ComPtr<IAudioSessionManager2> mgr;
  hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, &mgr);
  if (FAILED(hr)) { fail("IAudioSessionManager2", hr); return 1; }

  ComPtr<IAudioSessionEnumerator> sessions;
  hr = mgr->GetSessionEnumerator(&sessions);
  if (FAILED(hr)) { fail("GetSessionEnumerator", hr); return 1; }

  int count = 0;
  sessions->GetCount(&count);

  std::printf("%-8s %-28s %-10s %s\n", "PID", "进程", "状态", "会话标识");
  std::printf("%s\n", std::string(78, '-').c_str());

  for (int i = 0; i < count; ++i) {
    ComPtr<IAudioSessionControl> ctl;
    if (FAILED(sessions->GetSession(i, &ctl))) continue;

    ComPtr<IAudioSessionControl2> ctl2;
    if (FAILED(ctl->QueryInterface(IID_PPV_ARGS(&ctl2)))) continue;

    DWORD pid = 0;
    ctl2->GetProcessId(&pid);

    AudioSessionState state = AudioSessionStateInactive;
    ctl->GetState(&state);
    const char* stateText = state == AudioSessionStateActive    ? "出声中"
                            : state == AudioSessionStateInactive ? "空闲"
                                                                 : "已过期";

    LPWSTR id = nullptr;
    ctl2->GetSessionIdentifier(&id);
    char narrowId[160] = {};
    if (id) {
      WideCharToMultiByte(CP_ACP, 0, id, -1, narrowId, sizeof(narrowId), nullptr, nullptr);
      CoTaskMemFree(id);
    }

    std::printf("%-8lu %-28s %-10s %s\n", static_cast<unsigned long>(pid),
                procName(pid).c_str(), stateText, narrowId);
  }

  std::printf("\n共 %d 个会话。\n", count);
  std::printf("提示：把这个列表和你实际在播的音频对照一下 ——\n");
  std::printf("      就能知道通话声是从哪个 PID 出去的。\n");

  CoUninitialize();
  return 0;
}

// ---------------------------------------------------------------------------
// 捕获
// ---------------------------------------------------------------------------

/** ActivateAudioInterfaceAsync 的回调。等它触发就说明接口拿到了 */
class ActivationHandler
    : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
                                          IActivateAudioInterfaceCompletionHandler,
                                          Microsoft::WRL::FtmBase> {
 public:
  HANDLE done = CreateEventW(nullptr, FALSE, FALSE, nullptr);

  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation*) override {
    SetEvent(done);
    return S_OK;
  }
};

/** 写一个 16 位 PCM 的 WAV（float 采样会被转成 int16）*/
static bool writeWav(const std::string& path, const std::vector<int16_t>& pcm,
                     uint32_t sampleRate, uint16_t channels) {
  FILE* f = nullptr;
  if (fopen_s(&f, path.c_str(), "wb") != 0 || !f) return false;

  const uint32_t dataBytes = static_cast<uint32_t>(pcm.size() * sizeof(int16_t));
  const uint16_t bits = 16;
  const uint16_t blockAlign = static_cast<uint16_t>(channels * bits / 8);
  const uint32_t byteRate = sampleRate * blockAlign;

  auto u32 = [&](uint32_t v) { fwrite(&v, 4, 1, f); };
  auto u16 = [&](uint16_t v) { fwrite(&v, 2, 1, f); };

  fwrite("RIFF", 1, 4, f);
  u32(36 + dataBytes);
  fwrite("WAVE", 1, 4, f);
  fwrite("fmt ", 1, 4, f);
  u32(16);
  u16(1);  // PCM
  u16(channels);
  u32(sampleRate);
  u32(byteRate);
  u16(blockAlign);
  u16(bits);
  fwrite("data", 1, 4, f);
  u32(dataBytes);
  fwrite(pcm.data(), 1, dataBytes, f);

  fclose(f);
  return true;
}

static int capture(DWORD targetPid, bool exclude, int seconds, const std::string& outPath) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) { fail("CoInitializeEx", hr); return 1; }

  // ---- 1. 组装进程级回环的激活参数 --------------------------------
  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = targetPid;
  params.ProcessLoopbackParams.ProcessLoopbackMode =
      exclude ? PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
              : PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT prop = {};
  prop.vt = VT_BLOB;
  prop.blob.cbSize = sizeof(params);
  prop.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  std::printf("%s进程树 PID = %lu (%s)\n", exclude ? "排除" : "只录",
              static_cast<unsigned long>(targetPid), procName(targetPid).c_str());

  // ---- 2. 拿到 IAudioClient --------------------------------------
  ComPtr<ActivationHandler> handler = Microsoft::WRL::Make<ActivationHandler>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;
  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                                   __uuidof(IAudioClient), &prop, handler.Get(), &op);
  if (FAILED(hr)) {
    fail("ActivateAudioInterfaceAsync（多半是 Windows 版本不够，需要 Build 20348+）", hr);
    CoUninitialize();
    return 1;
  }

  // 回调是异步的，这里等它（最多 5 秒）
  if (WaitForSingleObject(handler->done, 5000) != WAIT_OBJECT_0) {
    std::fprintf(stderr, "[失败] 等待激活超时\n");
    CoUninitialize();
    return 1;
  }

  HRESULT activateResult = E_FAIL;
  ComPtr<IUnknown> unknown;
  hr = op->GetActivateResult(&activateResult, &unknown);
  if (FAILED(hr) || FAILED(activateResult)) {
    fail("GetActivateResult", FAILED(hr) ? hr : activateResult);
    CoUninitialize();
    return 1;
  }

  ComPtr<IAudioClient> client;
  hr = unknown.As(&client);
  if (FAILED(hr)) { fail("取 IAudioClient", hr); CoUninitialize(); return 1; }

  // ---- 3. 初始化 -------------------------------------------------
  //
  // ⚠️ 进程级回环**不能调 GetMixFormat** —— 它会直接返回 E_NOTIMPL (0x80004001)。
  //    官方的 ApplicationLoopback 示例也是自己指定格式，不走 GetMixFormat。
  //
  //    格式固定用 16 位 PCM / 48kHz / 立体声：
  //    · 采样率跟 Opus 一致，省一次重采样
  //    · 16 位对"验证有没有人声"完全够用
  //
  //    参数也照搬官方示例（缓冲 200ms）。下面准备了几组备选，
  //    因为不同 Windows 版本对 Initialize 的挑剔程度不一样 ——
  //    与其猜，不如逐组试一遍并把 HRESULT 打出来。
  WAVEFORMATEX fmt = {};
  fmt.wFormatTag = WAVE_FORMAT_PCM;
  fmt.nChannels = 2;
  fmt.nSamplesPerSec = 48000;
  fmt.wBitsPerSample = 16;
  fmt.nBlockAlign = static_cast<WORD>(fmt.nChannels * fmt.wBitsPerSample / 8);
  fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
  fmt.cbSize = 0;

  std::printf("捕获格式（自定）：%u Hz, %u 声道, %u bit PCM\n", fmt.nSamplesPerSec,
              fmt.nChannels, fmt.wBitsPerSample);

  struct Attempt {
    const char* name;
    DWORD flags;
    REFERENCE_TIME buffer;
    REFERENCE_TIME periodicity;
  };
  const Attempt attempts[] = {
      {"官方示例参数（LOOPBACK|EVENTCALLBACK, buf=200ms, period=200ms）",
       AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 2000000, 2000000},
      {"同上但 period=0", AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
       2000000, 0},
      {"仅 LOOPBACK（不用事件回调，轮询取数据）", AUDCLNT_STREAMFLAGS_LOOPBACK, 2000000, 0},
      {"LOOPBACK, buf=0, period=0", AUDCLNT_STREAMFLAGS_LOOPBACK, 0, 0},
  };

  bool initialized = false;
  bool useEvent = false;
  for (const auto& a : attempts) {
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, a.flags, a.buffer, a.periodicity, &fmt,
                            nullptr);
    std::printf("  [%s] Initialize -> 0x%08lX %s\n", a.name,
                static_cast<unsigned long>(hr), SUCCEEDED(hr) ? "OK" : "");
    if (SUCCEEDED(hr)) {
      initialized = true;
      useEvent = (a.flags & AUDCLNT_STREAMFLAGS_EVENTCALLBACK) != 0;
      break;
    }
  }
  if (!initialized) {
    std::fprintf(stderr, "[失败] 所有 Initialize 组合都不行\n");
    CoUninitialize();
    return 1;
  }

  HANDLE audioEvent = nullptr;
  if (useEvent) {
    audioEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    hr = client->SetEventHandle(audioEvent);
    if (FAILED(hr)) { fail("SetEventHandle", hr); CoUninitialize(); return 1; }
  } else {
    std::printf("（轮询模式，每 10ms 取一次）\n");
  }

  ComPtr<IAudioCaptureClient> capture;
  hr = client->GetService(IID_PPV_ARGS(&capture));
  if (FAILED(hr)) { fail("GetService(IAudioCaptureClient)", hr); CoUninitialize(); return 1; }

  hr = client->Start();
  if (FAILED(hr)) { fail("IAudioClient::Start", hr); CoUninitialize(); return 1; }

  // ---- 4. 收数据 --------------------------------------------------
  const uint16_t outChannels = fmt.nChannels;
  const uint32_t outRate = fmt.nSamplesPerSec;
  std::vector<int16_t> pcm;
  pcm.reserve(static_cast<size_t>(outRate) * outChannels * seconds);

  std::printf("开始录制 %d 秒…\n", seconds);
  const ULONGLONG deadline = GetTickCount64() + static_cast<ULONGLONG>(seconds) * 1000;
  uint64_t frames = 0;
  int emptyPolls = 0;

  while (GetTickCount64() < deadline) {
    if (useEvent) {
      if (WaitForSingleObject(audioEvent, 200) != WAIT_OBJECT_0) continue;
    } else {
      Sleep(10);  // 轮询模式
    }

    // 一次事件可能攒了多块数据，所以要循环取到没得取为止
    for (;;) {
      BYTE* data = nullptr;
      UINT32 available = 0;
      DWORD bufFlags = 0;
      hr = capture->GetBuffer(&data, &available, &bufFlags, nullptr, nullptr);

      if (hr == AUDCLNT_S_BUFFER_EMPTY) {
        ++emptyPolls;
        break;
      }
      if (FAILED(hr)) {
        std::fprintf(stderr, "[警告] GetBuffer 失败 0x%08lX，停止读取\n",
                     static_cast<unsigned long>(hr));
        goto done;
      }
      if (available == 0) {
        capture->ReleaseBuffer(0);
        break;
      }

      if (bufFlags & AUDCLNT_BUFFERFLAGS_SILENT) {
        pcm.insert(pcm.end(), static_cast<size_t>(available) * outChannels, 0);
      } else {
        // 格式是我们自己指定的 16 位 PCM，直接拷
        const int16_t* src = reinterpret_cast<const int16_t*>(data);
        pcm.insert(pcm.end(), src, src + static_cast<size_t>(available) * outChannels);
      }

      frames += available;
      capture->ReleaseBuffer(available);
    }
  }

done:
  client->Stop();
  if (audioEvent) CloseHandle(audioEvent);

  // ---- 5. 落盘 ----------------------------------------------------
  double secondsCaptured = static_cast<double>(frames) / outRate;
  std::printf("取到 %llu 帧（%.2f 秒），空轮询 %d 次\n",
              static_cast<unsigned long long>(frames), secondsCaptured, emptyPolls);
  if (!writeWav(outPath, pcm, outRate, outChannels)) {
    std::fprintf(stderr, "[失败] 写不出 %s\n", outPath.c_str());
    CoUninitialize();
    return 1;
  }

  std::printf("\n写出 %s\n", outPath.c_str());
  std::printf("  时长 %.1f 秒 / %zu 字节 PCM\n", secondsCaptured, pcm.size() * 2);
  std::printf("\n【怎么判断】用播放器听这个 WAV：\n");
  std::printf("  · 只听到游戏/音乐，没有人声  -> [OK] 排除模式生效，方案可行\n");
  std::printf("  · 还能听到通话人声          -> [!!] 排除的 PID 不对，看 --list 的输出\n");
  std::printf("  · 录到的是全静音            -> 说明全被排掉了，PID 传错了\n");

  CoUninitialize();
  return 0;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

static void usage() {
  std::printf(
      "用法：\n"
      "  spike --list                            列出正在出声的进程\n"
      "  spike --exclude <pid> [--sec 10] [--out a.wav]  录「系统声音 - 该进程」\n"
      "  spike --include <pid> [--sec 10] [--out b.wav]  只录该进程的声音\n"
      "\n"
      "两个方向都要测，对照着看才准：\n"
      "  --include <Electron主进程>  应该只听到 Electron 的测试音\n"
      "  --exclude <Electron主进程>  应该听不到 Electron 的测试音、别的声音都在\n"
      "  只有单向结果的话，分不清「排除生效」和「本来就没什么可录的」。\n");
}

int main(int argc, char** argv) {
  DWORD targetPid = 0;
  bool exclude = true;
  int seconds = 10;
  std::string out = "spike-out.wav";

  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--list") return listSessions();
    if (a == "--exclude" && i + 1 < argc) {
      targetPid = std::strtoul(argv[++i], nullptr, 10);
      exclude = true;
    } else if (a == "--include" && i + 1 < argc) {
      targetPid = std::strtoul(argv[++i], nullptr, 10);
      exclude = false;
    } else if (a == "--sec" && i + 1 < argc) {
      seconds = std::atoi(argv[++i]);
    } else if (a == "--out" && i + 1 < argc) {
      out = argv[++i];
    }
  }

  if (targetPid == 0) {
    usage();
    return 2;
  }
  return capture(targetPid, exclude, seconds, out);
}
