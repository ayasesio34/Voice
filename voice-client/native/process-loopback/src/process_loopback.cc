// ============================================================================
//  Windows 进程级音频回环捕获 —— Node 原生插件
//
//  能力：录「整个系统的声音」，但**按进程树包含或排除**。
//
//  Voice 客户端用它来做「只分享系统音频、不含频道对话声」：
//      系统混音（游戏 + 音乐 + 通话声）
//        −  本软件的进程树（通话声就是从这儿放出来的）
//        ─────────────────────────────────
//        =  游戏 + 音乐
//
//  通话声是**物理上没进过采集链路**，不是事后过滤 —— 零音质损失。
//
//  ── 为什么用 N-API 而不是老的 NAN ──────────────────────────────
//  N-API 的 ABI **跨 Node 和 Electron 版本都稳定**：
//  编译一次就能同时给 Node 20/22/24 和 Electron 33/34+ 用，
//  升级 Electron 不需要重新编译。这消掉了原生模块最大的那条维护成本。
//
//  ── 线程模型 ──────────────────────────────────────────────────
//  采集是阻塞循环，绝不能占用 JS 主线程：
//      start()  →  起一个 std::thread 跑采集
//                  线程里用 ThreadSafeFunction 把 PCM 推回 JS
//      stop()   →  置停止标志 → join → 释放 TSFN
//
//  推数据用 NonBlockingCall：JS 忙的时候**宁可丢这一块**，
//  也不能让采集线程堵住 —— 音频流堵住之后只会越积越多，最后全烂掉。
//
//  ── 已验证 ────────────────────────────────────────────────────
//  「排除 Electron 主进程能不能连带排掉它的 AudioService 子进程」——
//  能。见 ../spike/README.md 里的双向实测数据（1500Hz 掉了 134dB）。
// ============================================================================

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <napi.h>

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
// ⚠️ 进程级回环的类型在**这个**头文件里，不在 audioclient.h：
//    PROCESS_LOOPBACK_MODE / AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS /
//    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK。需要 Windows SDK 10.0.20348+。
#include <audioclientactivationparams.h>
#include <wrl/implements.h>

#include <atomic>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

// 采集格式。固定 16 位 PCM / 48kHz / 立体声：
//   · 48000 和 Opus 一致，后面不用重采样
//   · 16 位够用，而且 IPC 传输量只有 float32 的一半
constexpr uint32_t kSampleRate = 48000;
constexpr uint16_t kChannels = 2;

/** HRESULT -> 可读的错误串 */
std::string HrText(const char* what, HRESULT hr) {
  char buf[256];
  _snprintf_s(buf, sizeof(buf), _TRUNCATE, "%s 失败 (HRESULT 0x%08lX)", what,
              static_cast<unsigned long>(hr));
  return buf;
}

/** 进程 id -> 可执行文件名（拿不到返回空串） */
std::string ProcessName(DWORD pid) {
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return "";

  wchar_t path[MAX_PATH] = {};
  DWORD len = MAX_PATH;
  std::string out;
  if (QueryFullProcessImageNameW(h, 0, path, &len)) {
    const wchar_t* base = wcsrchr(path, L'\\');
    base = base ? base + 1 : path;
    char narrow[MAX_PATH] = {};
    WideCharToMultiByte(CP_UTF8, 0, base, -1, narrow, sizeof(narrow), nullptr, nullptr);
    out = narrow;
  }
  CloseHandle(h);
  return out;
}

// ---------------------------------------------------------------------------
// ActivateAudioInterfaceAsync 的完成回调
// ---------------------------------------------------------------------------
class ActivationHandler
    : public Microsoft::WRL::RuntimeClass<
          Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
          IActivateAudioInterfaceCompletionHandler, Microsoft::WRL::FtmBase> {
 public:
  HANDLE done = CreateEventW(nullptr, FALSE, FALSE, nullptr);

  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation*) override {
    SetEvent(done);
    return S_OK;
  }
};

// ---------------------------------------------------------------------------
// 打开一个进程级回环捕获客户端
//
// ⚠️ 进程级回环**不能调 GetMixFormat** —— 它会直接返回 E_NOTIMPL (0x80004001)。
//    必须自己指定格式。这是当初在 spike 里卡住的地方。
// ---------------------------------------------------------------------------
struct CaptureContext {
  ComPtr<IAudioClient> client;
  ComPtr<IAudioCaptureClient> capture;
  HANDLE audioEvent = nullptr;
  WAVEFORMATEX format = {};
  bool ok = false;
  std::string error;

  ~CaptureContext() {
    if (audioEvent) CloseHandle(audioEvent);
  }
};

bool OpenCapture(DWORD targetPid, bool exclude, CaptureContext& out) {
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

  auto handler = Microsoft::WRL::Make<ActivationHandler>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;

  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                                           __uuidof(IAudioClient), &prop, handler.Get(), &op);
  if (FAILED(hr)) {
    out.error = HrText("ActivateAudioInterfaceAsync（Windows 需要 Build 20348+）", hr);
    return false;
  }

  if (WaitForSingleObject(handler->done, 5000) != WAIT_OBJECT_0) {
    out.error = "等待音频接口激活超时";
    return false;
  }

  HRESULT activateResult = E_FAIL;
  ComPtr<IUnknown> unknown;
  hr = op->GetActivateResult(&activateResult, &unknown);
  if (FAILED(hr)) { out.error = HrText("GetActivateResult", hr); return false; }
  if (FAILED(activateResult)) {
    out.error = HrText("激活音频接口", activateResult);
    return false;
  }

  hr = unknown.As(&out.client);
  if (FAILED(hr)) { out.error = HrText("取 IAudioClient", hr); return false; }

  WAVEFORMATEX& fmt = out.format;
  fmt.wFormatTag = WAVE_FORMAT_PCM;
  fmt.nChannels = kChannels;
  fmt.nSamplesPerSec = kSampleRate;
  fmt.wBitsPerSample = 16;
  fmt.nBlockAlign = static_cast<WORD>(fmt.nChannels * fmt.wBitsPerSample / 8);
  fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
  fmt.cbSize = 0;

  // 参数照搬微软 ApplicationLoopback 示例。进程级回环对 Initialize 比较挑，
  // 这组是实测能过的（spike 里试过 4 组，只有这组成功）。
  hr = out.client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                              AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                              2000000, 2000000, &fmt, nullptr);
  if (FAILED(hr)) { out.error = HrText("IAudioClient::Initialize", hr); return false; }

  out.audioEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = out.client->SetEventHandle(out.audioEvent);
  if (FAILED(hr)) { out.error = HrText("SetEventHandle", hr); return false; }

  hr = out.client->GetService(IID_PPV_ARGS(&out.capture));
  if (FAILED(hr)) { out.error = HrText("GetService(IAudioCaptureClient)", hr); return false; }

  out.ok = true;
  return true;
}

// ---------------------------------------------------------------------------
// 枚举默认输出设备上的音频会话（诊断用）
//
// 能直接看出"某个程序的声音到底挂在哪个 PID 上" ——
// 排查"该排除谁"的时候全靠它。实测发现 Chromium 的音频挂在
// audio.mojom.AudioService 这个**独立的 utility 子进程**上，
// 而不是渲染进程。
// ---------------------------------------------------------------------------
Napi::Value ListSessions(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array result = Napi::Array::New(env);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);

  ComPtr<IMMDeviceEnumerator> enumerator;
  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                        IID_PPV_ARGS(&enumerator));
  if (FAILED(hr)) return result;

  ComPtr<IMMDevice> device;
  if (FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device))) return result;

  ComPtr<IAudioSessionManager2> mgr;
  if (FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, &mgr)))
    return result;

  ComPtr<IAudioSessionEnumerator> sessions;
  if (FAILED(mgr->GetSessionEnumerator(&sessions))) return result;

  int count = 0;
  sessions->GetCount(&count);

  uint32_t n = 0;
  for (int i = 0; i < count; ++i) {
    ComPtr<IAudioSessionControl> ctl;
    if (FAILED(sessions->GetSession(i, &ctl))) continue;

    ComPtr<IAudioSessionControl2> ctl2;
    if (FAILED(ctl->QueryInterface(IID_PPV_ARGS(&ctl2)))) continue;

    DWORD pid = 0;
    ctl2->GetProcessId(&pid);

    AudioSessionState state = AudioSessionStateInactive;
    ctl->GetState(&state);

    Napi::Object item = Napi::Object::New(env);
    item.Set("pid", Napi::Number::New(env, static_cast<double>(pid)));
    item.Set("name", Napi::String::New(env, ProcessName(pid)));
    item.Set("active", Napi::Boolean::New(env, state == AudioSessionStateActive));
    result.Set(n++, item);
  }

  return result;
}

// ---------------------------------------------------------------------------
// 捕获器
// ---------------------------------------------------------------------------
class ProcessLoopback : public Napi::ObjectWrap<ProcessLoopback> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "ProcessLoopback",
                                      {
                                          InstanceMethod("start", &ProcessLoopback::Start),
                                          InstanceMethod("stop", &ProcessLoopback::Stop),
                                          InstanceAccessor("running", &ProcessLoopback::GetRunning,
                                                           nullptr),
                                      });
    exports.Set("ProcessLoopback", func);
    exports.Set("listSessions", Napi::Function::New(env, ListSessions));
    return exports;
  }

  explicit ProcessLoopback(const Napi::CallbackInfo& info) : Napi::ObjectWrap<ProcessLoopback>(info) {}

  ~ProcessLoopback() override { StopInternal(); }

 private:
  std::thread thread_;
  std::atomic<bool> running_{false};
  HANDLE stopEvent_ = nullptr;
  Napi::ThreadSafeFunction tsfn_;
  bool tsfnValid_ = false;

  Napi::Value GetRunning(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), running_.load());
  }

  Napi::Value Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (running_.load()) {
      throw Napi::Error::New(env, "已经在采集了，先调用 stop()");
    }
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
      throw Napi::Error::New(env, "start(options, onData) —— options: { pid, mode }");
    }

    Napi::Object options = info[0].As<Napi::Object>();
    if (!options.Has("pid") || !options.Get("pid").IsNumber()) {
      throw Napi::Error::New(env, "options.pid 必须是数字（要包含/排除的进程 id）");
    }

    const DWORD pid = static_cast<DWORD>(options.Get("pid").As<Napi::Number>().Uint32Value());
    if (pid == 0) throw Napi::Error::New(env, "options.pid 不能是 0");

    // mode 默认 exclude —— 这是本项目的用法（系统声音减去自己）
    std::string mode = "exclude";
    if (options.Has("mode") && options.Get("mode").IsString()) {
      mode = options.Get("mode").As<Napi::String>().Utf8Value();
    }
    if (mode != "exclude" && mode != "include") {
      throw Napi::Error::New(env, "options.mode 只能是 'exclude' 或 'include'");
    }
    const bool exclude = (mode == "exclude");

    // TSFN 要在**起线程之前**建好，而且要记住它到底建成功没有 ——
    // 后面 push 数据时靠 tsfnValid_ 判断，不然会往一个空句柄上推
    tsfn_ = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(),
                                          "ProcessLoopbackData",
                                          0,    // 无限队列（用 NonBlockingCall，满了会丢）
                                          1);   // 初始线程数
    tsfnValid_ = true;

    stopEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    running_.store(true);

    thread_ = std::thread([this, pid, exclude]() { CaptureLoop(pid, exclude); });

    return env.Undefined();
  }

  Napi::Value Stop(const Napi::CallbackInfo& info) {
    StopInternal();
    return info.Env().Undefined();
  }

  void StopInternal() {
    if (!thread_.joinable()) {
      // 线程没起过，但 TSFN 可能还在
      ReleaseTsfn();
      return;
    }

    running_.store(false);
    if (stopEvent_) SetEvent(stopEvent_);  // 立刻叫醒采集循环
    thread_.join();

    if (stopEvent_) {
      CloseHandle(stopEvent_);
      stopEvent_ = nullptr;
    }
    ReleaseTsfn();
  }

  void ReleaseTsfn() {
    if (!tsfnValid_) return;
    // ⚠️ 必须在**线程 join 之后**才 Release：
    //    线程里可能正有一次 NonBlockingCall 在飞，提前释放会崩。
    tsfn_.Release();
    tsfnValid_ = false;
  }

  // 采集线程本体
  void CaptureLoop(DWORD pid, bool exclude) {
    // COM 是**按线程**初始化的，工作线程里必须自己来一遍
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    CaptureContext ctx;
    if (!OpenCapture(pid, exclude, ctx)) {
      // 把错误送回 JS 主线程，再退出
      PushError(ctx.error);
      running_.store(false);
      CoUninitialize();
      return;
    }

    if (FAILED(ctx.client->Start())) {
      PushError("IAudioClient::Start 失败");
      running_.store(false);
      CoUninitialize();
      return;
    }

    const HANDLE waits[2] = {ctx.audioEvent, stopEvent_};

    while (running_.load()) {
      // 等"有数据"或"要停" —— 两个事件谁先来都行
      DWORD w = WaitForMultipleObjects(2, waits, FALSE, 500);
      if (w == WAIT_OBJECT_0 + 1) break;  // 收到停止信号
      if (w != WAIT_OBJECT_0) continue;   // 超时，回到循环顶部检查 running_

      // 一次事件可能攒了多块，取到没得取为止
      for (;;) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        hr = ctx.capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);

        if (hr == AUDCLNT_S_BUFFER_EMPTY) break;
        if (FAILED(hr)) { running_.store(false); break; }
        if (frames == 0) { ctx.capture->ReleaseBuffer(0); break; }

        const size_t samples = static_cast<size_t>(frames) * kChannels;
        std::vector<int16_t> chunk(samples, 0);

        if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && data) {
          memcpy(chunk.data(), data, samples * sizeof(int16_t));
        }
        ctx.capture->ReleaseBuffer(frames);

        if (!PushChunk(std::move(chunk))) {
          running_.store(false);  // TSFN 关了（环境在退出），别再采了
          break;
        }
      }
    }

    ctx.client->Stop();
    CoUninitialize();
    running_.store(false);
  }

  /** 把一块 PCM 推回 JS。返回 false 表示该停了（TSFN 已关闭） */
  bool PushChunk(std::vector<int16_t> samples) {
    if (!tsfnValid_) return false;

    auto* payload = new std::vector<int16_t>(std::move(samples));

    napi_status status = tsfn_.NonBlockingCall(
        payload, [](Napi::Env env, Napi::Function jsCallback, std::vector<int16_t>* data) {
          if (data) {
            auto buf = Napi::Buffer<int16_t>::Copy(env, data->data(), data->size());
            jsCallback.Call({buf});
            delete data;
          }
        });

    if (status != napi_ok) {
      // 队列满（JS 太忙）或者 TSFN 正在关闭。
      // 两种情况都丢掉这块 —— 音频宁可丢一帧，也不能把采集线程堵死。
      delete payload;
      return status != napi_closing;
    }
    return true;
  }

  void PushError(const std::string& message) {
    if (!tsfnValid_) return;

    auto* payload = new std::string(message);
    napi_status status = tsfn_.NonBlockingCall(
        payload, [](Napi::Env env, Napi::Function jsCallback, std::string* msg) {
          if (msg) {
            jsCallback.Call({Napi::Error::New(env, *msg).Value()});
            delete msg;
          }
        });
    if (status != napi_ok) delete payload;
  }
};

}  // namespace

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  return ProcessLoopback::Init(env, exports);
}

NODE_API_MODULE(process_loopback, InitAll)
