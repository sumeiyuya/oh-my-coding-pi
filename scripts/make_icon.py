"""生成 oh-my-coding-pi 应用图标（多尺寸 ico + 256 png）。

设计：深蓝到青绿的圆角方块底，白色三根柱（数据/分析）+ 一条折线（趋势），
右下角一个小圆点（甲烷气泡 / 数据点）。纯几何，无字体依赖。
"""

import os
from PIL import Image, ImageDraw

SIZE = 1024
BG_TOP = (31, 62, 122)      # #1F3E7A
BG_BOTTOM = (16, 130, 120)  # #108278
FG = (255, 255, 255)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def build(size=SIZE):
    # 纵向渐变底
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        grad.putpixel((0, y), lerp(BG_TOP, BG_BOTTOM, y / (size - 1)))
    img = grad.resize((size, size)).convert("RGBA")

    # 圆角裁切（Windows 图标通常留一点边距）
    pad = round(size * 0.06)
    inner = size - pad * 2
    mask = rounded_mask(inner, radius=round(inner * 0.22))
    bg = Image.new("RGBA", (inner, inner), (0, 0, 0, 0))
    bg.paste(img.crop((0, 0, inner, inner)), (0, 0), mask)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(bg, (pad, pad), bg)

    d = ImageDraw.Draw(canvas)
    # 三根柱
    base_y = size * 0.74
    bar_w = size * 0.105
    gap = size * 0.055
    heights = [0.20, 0.32, 0.44]
    total_w = bar_w * 3 + gap * 2
    x0 = (size - total_w) / 2
    for i, h in enumerate(heights):
        x = x0 + i * (bar_w + gap)
        top = base_y - size * h
        d.rounded_rectangle([x, top, x + bar_w, base_y], radius=bar_w * 0.22, fill=FG)

    # 折线（从左下到右上，穿过柱顶）
    pts = [
        (x0 - size * 0.01, base_y - size * 0.16),
        (x0 + bar_w * 0.5, base_y - size * 0.24),
        (x0 + bar_w + gap + bar_w * 0.5, base_y - size * 0.36),
        (x0 + 2 * (bar_w + gap) + bar_w * 0.5, base_y - size * 0.50),
    ]
    d.line(pts, fill=FG, width=round(size * 0.028), joint="curve")
    for p in pts:
        r = size * 0.022
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=FG)

    # 底部基线
    d.rounded_rectangle(
        [x0 - size * 0.02, base_y + size * 0.015, x0 + total_w + size * 0.02, base_y + size * 0.035],
        radius=size * 0.012,
        fill=FG,
    )
    return canvas


def main():
    out_dir = os.path.join("apps", "desktop", "build")
    os.makedirs(out_dir, exist_ok=True)
    master = build(SIZE)
    png_path = os.path.join(out_dir, "icon.png")
    master.resize((256, 256), Image.LANCZOS).save(png_path)
    ico_path = os.path.join(out_dir, "icon.ico")
    sizes = [16, 24, 32, 48, 64, 128, 256]
    master.save(ico_path, format="ICO", sizes=[(s, s) for s in sizes])
    print("written", png_path)
    print("written", ico_path, os.path.getsize(ico_path), "bytes")


if __name__ == "__main__":
    main()
