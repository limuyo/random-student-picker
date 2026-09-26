# -*- coding: utf-8 -*-
"""把英雄头像合集大图切分为独立 PNG，并生成 js/avatars.js 清单。

用法:
    python tools/slice_avatars.py            # 自动在仓库根目录查找最大的 PNG
    python tools/slice_avatars.py 源图.png   # 指定源图

换老师替换头像时：把新的合集图放进根目录（或替换 assets/avatars/ 下的
hero_*.png 并手动维护 js/avatars.js）即可，网页无需改动。
"""
import glob
import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def find_source():
    if len(sys.argv) > 1:
        return sys.argv[1]
    cands = [
        p for p in glob.glob(os.path.join(ROOT, "*.png"))
        if "contact" not in os.path.basename(p).lower()
    ]
    if not cands:
        raise SystemExit("根目录未找到 PNG 源图。用法: python tools/slice_avatars.py 源图.png")
    return max(cands, key=os.path.getsize)


def bands(profile, thresh, min_gap):
    """把一维投影切分成若干连续区间，区间之间至少隔 min_gap 个空白。"""
    on = profile > thresh
    out, start, gap = [], None, 0
    for i, v in enumerate(on):
        if v:
            if start is None:
                start = i
            gap = 0
        elif start is not None:
            gap += 1
            if gap >= min_gap:
                out.append((start, i - gap))
                start, gap = None, 0
    if start is not None:
        out.append((start, len(on) - 1))
    return out


def main():
    src = find_source()
    img = Image.open(src).convert("RGBA")
    arr = np.array(img)
    alpha = arr[..., 3]
    if (alpha < 250).any():
        mask = alpha > 24
        print("检测到透明通道，按 alpha 分割")
    else:
        mask = arr[..., :3].astype(np.int16).max(axis=2) > 28
        print("无透明通道，按亮度分割")

    boxes = []
    for r0, r1 in bands(mask.sum(axis=1), 2, 4):
        cols = mask[r0:r1 + 1].sum(axis=0)
        for c0, c1 in bands(cols, 1, 4):
            if c1 - c0 + 1 >= 24 and r1 - r0 + 1 >= 24:
                boxes.append((c0, r0, c1 + 1, r1 + 1))

    # 相邻头像距离太近时会粘成一个宽块，按列投影做二次切分
    widths = sorted(b[2] - b[0] for b in boxes)
    med_w = widths[len(widths) // 2]
    split = []
    for x0, y0, x1, y1 in boxes:
        if x1 - x0 <= med_w * 1.35:
            split.append((x0, y0, x1, y1))
            continue
        piece_mask = mask[y0:y1, x0:x1]
        pieces = []
        for c0, c1 in bands(piece_mask.sum(axis=0), 8, 1):
            if c1 - c0 + 1 < 24:
                continue
            row_b = bands(piece_mask[:, c0:c1 + 1].sum(axis=1), 1, 1)
            if not row_b:
                continue
            r0, r1 = row_b[0]
            pieces.append((x0 + c0, y0 + r0, x0 + c1 + 1, y0 + r1 + 1))
        split.extend(pieces or [(x0, y0, x1, y1)])
    boxes = split
    boxes.sort(key=lambda b: (b[1], b[0]))

    out_dir = os.path.join(ROOT, "assets", "avatars")
    os.makedirs(out_dir, exist_ok=True)
    for old in glob.glob(os.path.join(out_dir, "hero_*.png")):
        os.remove(old)

    names = []
    for i, (x0, y0, x1, y1) in enumerate(boxes, 1):
        fn = "hero_%03d.png" % i
        img.crop((x0, y0, x1, y1)).save(os.path.join(out_dir, fn))
        names.append("assets/avatars/" + fn)

    js = os.path.join(ROOT, "js", "avatars.js")
    os.makedirs(os.path.dirname(js), exist_ok=True)
    with open(js, "w", encoding="utf-8") as f:
        f.write("// 本文件由 tools/slice_avatars.py 自动生成：英雄头像清单（相对 index.html）。\n")
        f.write("// 替换头像后重新运行脚本，或手动增删此数组即可。\n")
        f.write("window.AVATARS = " + json.dumps(names, ensure_ascii=False) + ";\n")

    # 生成联络表便于人工检查切分质量
    cols_n = 10
    rows_n = (len(names) + cols_n - 1) // cols_n
    sheet = Image.new("RGB", (cols_n * 96, rows_n * 96), (40, 46, 62))
    for i, name in enumerate(names):
        tile = Image.open(os.path.join(ROOT, name)).convert("RGBA")
        tile.thumbnail((88, 88))
        sheet.paste(tile, ((i % cols_n) * 96 + 4, (i // cols_n) * 96 + 4), tile)
    sheet.save(os.path.join(ROOT, "tools", "_contact_sheet.png"))

    widths = sorted(b[2] - b[0] for b in boxes)
    heights = sorted(b[3] - b[1] for b in boxes)
    print("源图: %s (%dx%d)" % (os.path.basename(src), img.width, img.height))
    print("共切出 %d 个头像 -> assets/avatars/，清单已写入 js/avatars.js" % len(names))
    print("尺寸中位数 %dx%d，最小 %dx%d，最大 %dx%d" % (
        widths[len(widths) // 2], heights[len(heights) // 2],
        widths[0], heights[0], widths[-1], heights[-1]))


if __name__ == "__main__":
    main()
