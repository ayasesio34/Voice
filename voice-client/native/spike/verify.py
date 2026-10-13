"""
阶段 1 的验证工具：生成测试音 + 分析录音。

为什么不用耳朵听：人耳判断"有没有人声"太主观，而且容易被我自己的预期带偏。
改用**两个频率不同的纯音**做对照，再用 FFT 看频谱里到底有哪几个峰 ——
结论是数字，不含糊。

    python verify.py make
        生成 tone-a-440.wav（用普通进程播，应该**保留**）
             tone-b-1500.wav（用 Electron 播，应该**被排除**）

    python verify.py analyze spike-out.wav
        分析录音里 440Hz 和 1500Hz 的能量

两个频率互不成谐波，所以不会互相干扰判断。
"""

import sys
import wave
from pathlib import Path

import numpy as np

# 强制 UTF-8 输出。
# 中文 Windows 的控制台默认是 GBK，打印 emoji 会直接抛 UnicodeEncodeError
# 把整个分析过程打断 —— 前面就因为这个白跑了一次。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = Path(__file__).resolve().parent

RATE = 48000
SECONDS = 5
FREQ_A = 440.0   # 普通进程播的
FREQ_B = 1500.0  # Electron 播的


def make_tone(freq: float, path: Path) -> None:
    t = np.arange(int(RATE * SECONDS), dtype=np.float64) / RATE
    # 加一点点淡入淡出，避免首尾爆音（爆音会在频谱上铺一层宽带噪声）
    wave_data = np.sin(2 * np.pi * freq * t) * 0.35
    fade = int(RATE * 0.02)
    wave_data[:fade] *= np.linspace(0, 1, fade)
    wave_data[-fade:] *= np.linspace(1, 0, fade)

    pcm = (wave_data * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())

    print(f"生成 {path.name}  {freq:.0f} Hz  {SECONDS}s")


def read_wav(path: Path):
    with wave.open(str(path), "rb") as w:
        channels = w.getnchannels()
        width = w.getsampwidth()
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())

    if width != 2:
        raise SystemExit(f"只支持 16 位 PCM，这个文件是 {width * 8} 位")

    data = np.frombuffer(frames, dtype=np.int16).astype(np.float64)
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return data, rate


def analyze(path: Path, mode: str = "") -> int:
    data, rate = read_wav(path)

    if data.size < rate:  # 不到 1 秒，没意义
        print(f"⚠️  录音只有 {data.size / rate:.2f} 秒，太短")
        return 1

    # 掐掉首尾各 0.5 秒 —— 起停瞬间可能有杂音
    pad = int(rate * 0.5)
    seg = data[pad:-pad] if data.size > pad * 3 else data

    # 加汉宁窗，减少频谱泄漏
    windowed = seg * np.hanning(seg.size)
    spectrum = np.abs(np.fft.rfft(windowed))
    freqs = np.fft.rfftfreq(seg.size, 1 / rate)

    # 用中位数当噪声底，比均值抗单频干扰
    floor = np.median(spectrum)
    peak = spectrum.max()

    def energy_at(f):
        """目标频率附近 ±5Hz 取最大值"""
        band = (freqs >= f - 5) & (freqs <= f + 5)
        return spectrum[band].max() if band.any() else 0.0

    def db(v):
        return 20 * np.log10(v / floor) if floor > 0 and v > 0 else -99.0

    e_a = energy_at(FREQ_A)
    e_b = energy_at(FREQ_B)

    dur = seg.size / rate
    rms = np.sqrt(np.mean(seg.astype(np.float64) ** 2))

    print(f"文件       {path.name}")
    print(f"采样率     {rate} Hz")
    print(f"分析长度   {dur:.1f} 秒")
    print(f"整体电平   RMS {rms:.0f} / 32767  ({20 * np.log10(max(rms, 1e-9) / 32767):.1f} dBFS)")
    print(f"频谱峰值   {peak:.0f}  @ {freqs[spectrum.argmax()]:.0f} Hz")
    print()

    # 判定阈值：比噪声底高 40dB 才算"听得见"。
    #
    # 一开始定的是 20dB，结果**环境噪声就压在 22dB 上**（Wallpaper Engine、
    # 聊天软件之类一直在出声），单向测试会误判成"听到了"。
    # 真正的测试音在 130~150dB，留 40dB 的余量既有区分度又不会误报。
    THRESHOLD_DB = 40.0
    heard_a = db(e_a) > THRESHOLD_DB
    heard_b = db(e_b) > THRESHOLD_DB

    print(f"{FREQ_A:>6.0f} Hz (普通进程)  {db(e_a):+7.1f} dB  {'[有] 听得见' if heard_a else '[无]'}")
    print(f"{FREQ_B:>6.0f} Hz (Electron)  {db(e_b):+7.1f} dB  {'[有] 听得见' if heard_b else '[无]'}")
    print()

    if not heard_a and not heard_b:
        print("[!] 两个都没录到 —— 可能根本没声音在播，或者录错了设备。")
        return 2

    # 有 mode 才能给确定结论 —— 同样一份频谱，--include 和 --exclude
    # 期望看到的正好相反，脚本自己猜不出来。
    if mode == "include":
        ok = heard_b and not heard_a
        print(f"{'[OK]' if ok else '[X]'} --include 期望：只有 Electron 的 1500Hz")
        print(f"       实际：440Hz {'有' if heard_a else '无'} / 1500Hz {'有' if heard_b else '无'}")
        return 0 if ok else 1

    if mode == "exclude":
        ok = heard_a and not heard_b
        print(f"{'[OK]' if ok else '[X]'} --exclude 期望：别的声音都在、Electron 的不在")
        print(f"       实际：440Hz {'有' if heard_a else '无'} / 1500Hz {'有' if heard_b else '无'}")
        return 0 if ok else 1

    print("[结果] 只有 440Hz（普通进程），Electron 的 1500Hz 不在")
    print("       跑的是 --exclude -> 排除生效；跑的是 --include -> 方向反了")
    print("       加上 --mode exclude / --mode include 可以拿到确定结论")
    return 2


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    cmd = sys.argv[1]
    if cmd == "make":
        make_tone(FREQ_A, HERE / "tone-a-440.wav")
        make_tone(FREQ_B, HERE / "tone-b-1500.wav")
        return 0
    if cmd == "analyze":
        args = sys.argv[2:]
        mode = ""
        if "--mode" in args:
            i = args.index("--mode")
            if i + 1 < len(args):
                mode = args[i + 1]
                del args[i : i + 2]
        if not args:
            print("用法: python verify.py analyze <录音.wav> [--mode include|exclude]")
            return 2
        return analyze(Path(args[0]), mode)

    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
