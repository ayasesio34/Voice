"""
生成应用图标和托盘图标。

    python scripts/make-icons.py

产物（都在 resources/ 下）：
    icon.png      256x256  应用图标
    icon.ico      多尺寸   Windows 安装包 / 窗口图标
    tray.png      16x16    托盘（100% DPI）
    tray@2x.png   32x32    托盘（高 DPI）

图形是「圆角方块 + 三根音量条」—— 小尺寸下也认得出是语音软件。
图标是在 8 倍尺寸上画完再缩的（超采样），这样圆角和斜边才有抗锯齿。
"""

from pathlib import Path

from PIL import Image, ImageDraw

ACCENT = (88, 101, 242, 255)  # 和界面里的 --accent 同一个色
WHITE = (255, 255, 255, 255)

# 超采样倍数。8 倍足够平滑，再高就只是慢。
SUPERSAMPLE = 8

# 三根竖条的相对尺寸（占整幅的比例）
BAR_WIDTH = 0.14
BAR_GAP = 0.075
BAR_HEIGHTS = (0.36, 0.56, 0.36)  # 中间高、两边矮，像个音量条


def make_icon(size: int) -> Image.Image:
    """画一张 size x size 的图标"""
    big = size * SUPERSAMPLE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 圆角方块铺满整幅
    draw.rounded_rectangle(
        [0, 0, big - 1, big - 1],
        radius=int(big * 0.22),
        fill=ACCENT,
    )

    bar_w = big * BAR_WIDTH
    gap = big * BAR_GAP
    total = bar_w * len(BAR_HEIGHTS) + gap * (len(BAR_HEIGHTS) - 1)
    x = (big - total) / 2

    for ratio in BAR_HEIGHTS:
        h = big * ratio
        y = (big - h) / 2
        draw.rounded_rectangle([x, y, x + bar_w, y + h], radius=bar_w / 2, fill=WHITE)
        x += bar_w + gap

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "resources"
    out.mkdir(parents=True, exist_ok=True)

    app_icon = make_icon(256)
    app_icon.save(out / "icon.png")

    # 托盘：给两份，让 Electron 在高 DPI 下自己挑
    make_icon(16).save(out / "tray.png")
    make_icon(32).save(out / "tray@2x.png")

    # Windows 的多尺寸图标。Pillow 会把这些尺寸都塞进一个 .ico
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    app_icon.save(out / "icon.ico", sizes=ico_sizes)

    for f in sorted(out.iterdir()):
        print(f"{f.name:14} {f.stat().st_size:>7} bytes")


if __name__ == "__main__":
    main()
