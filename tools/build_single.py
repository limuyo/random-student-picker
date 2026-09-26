# -*- coding: utf-8 -*-
"""把点名器打包成「单文件版」：一个 HTML 内联全部 CSS / JS / 头像（base64）。

产出: dist/RandomStudentPicker.html —— 下载后双击即可使用，无需任何其他文件。

用法: python tools/build_single.py
"""
import base64
import glob
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
OUT = os.path.join(DIST, "RandomStudentPicker.html")

CSS_ORDER = ["style.css", "roller-strip.css", "roller-slots.css", "mood.css"]
JS_ORDER = [
    "roster.js", "audio.js", "wall.js",
    "roller-strip.js", "roller-slots.js", "mood.js",
    "history.js", "app.js",
]


def read(path):
    with open(os.path.join(ROOT, path), "r", encoding="utf-8") as f:
        return f.read()


def main():
    html = read("index.html")

    # ---- CSS 内联 ----
    css = "\n".join(read("css/" + name) for name in CSS_ORDER)
    style_block = "<style>\n" + css + "\n</style>"
    for name in CSS_ORDER:
        link = '<link rel="stylesheet" href="css/%s">' % name
        assert link in html, "缺少样式链接: " + link
        html = html.replace(link, "")  # 先移除
    html = html.replace("</head>", style_block + "\n</head>")

    # ---- 头像清单：114 张 PNG → base64 data URI ----
    avatars = []
    for png in sorted(glob.glob(os.path.join(ROOT, "assets", "avatars", "hero_*.png"))):
        with open(png, "rb") as f:
            avatars.append("data:image/png;base64," + base64.b64encode(f.read()).decode("ascii"))
    avatars_js = ("// 头像已内联为 data URI（由 tools/build_single.py 生成）\n"
                  "window.AVATARS = " + json.dumps(avatars, ensure_ascii=False) + ";")
    old = '<script src="js/avatars.js"></script>'
    assert old in html
    html = html.replace(old, "<script>\n" + avatars_js + "\n</script>")

    # ---- JS 内联（保持执行顺序）----
    for name in JS_ORDER:
        src = '<script src="js/%s"></script>' % name
        assert src in html, "缺少脚本链接: " + src
        html = html.replace(src, "<script>\n" + read("js/" + name) + "\n</script>")

    # ---- 标题 ----
    html = html.replace("<title>点名器 · 班级随机点名</title>",
                        "<title>Random Student Picker (Honor of Kings)</title>")

    os.makedirs(DIST, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)

    size = os.path.getsize(OUT)
    print("已生成 %s（%.1f MB，%d 个头像已内联）" % (
        os.path.relpath(OUT, ROOT), size / 1024 / 1024, len(avatars)))


if __name__ == "__main__":
    main()
