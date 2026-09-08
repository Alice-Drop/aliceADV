#!/usr/bin/env python3
# =========================================================
# aliceADV cssutil — CSS 资源路径的「编译期」重写（共用模块）
#
# 背景（重要陷阱）：
#   CSS 里的 url() 是相对 **CSS 文件自身所在目录** 解析的，而不是相对 index.html。
#   但引擎模板里统一按「工程根目录」语义书写资源路径（gui/textbox.png 等），
#   与 theme.json / story 里的约定保持一致，便于阅读与替换。
#
# 二者不一致会导致：style/pages/stage.css 里写 url("gui/textbox.png")
#   实际去请求 style/pages/gui/textbox.png → 404，默认对话框/选项按钮/弹窗底图全部不显示。
#
# 解决：模板只写工程根相对路径 url("gui/...")，由编译器在「复制/构建」阶段
#   按每个 CSS 文件相对根目录的深度自动补 ../ 前缀：
#       style/base.css       (深度 1) → url("../gui/...")
#       style/pages/*.css    (深度 2) → url("../../gui/...")
#
# 该重写是 **幂等** 的：先把已存在的 (../)+ 前缀压平，再按深度重写，
# 因此 create 复制工程、build 构建产物等多处调用同一个函数也不会累积前缀。
#
# 用法：
#   from aliceadv.cssutil import rewrite_css_asset_paths
#   changed = rewrite_css_asset_paths("/path/to/project")
# =========================================================
import os
import re

# 资源根目录名（工程根下的 gui/ / images/ / audio/ / fonts/ 等）
ASSET_DIRS = ("gui", "images", "audio", "fonts")

# 匹配 url(".../../gui/ 形式（含可选引号），用于压平已有前缀
_PREFixed_RE = re.compile(r'url\(\s*(["\']?)(?:\.\./)+(%s)/' % "|".join(ASSET_DIRS))
# 匹配 url("gui/ 形式（工程根相对，模板规范写法）
_CANONICAL_RE = re.compile(r'url\(\s*(["\']?)(%s)/' % "|".join(ASSET_DIRS))


def _depth_prefix(web_dir, css_dir):
    """按 CSS 文件所在目录相对根目录的深度，返回 ../ 前缀。"""
    rel = os.path.relpath(css_dir, web_dir)
    if rel in (".", ""):
        return ""
    return "../" * len(rel.split(os.sep))


def rewrite_css_asset_paths(web_dir, subdir="style"):
    """把 <web_dir>/<subdir>/**/*.css 里的资源 url() 重写为按深度正确的相对路径。

    返回被修改的文件列表（相对 web_dir 的路径），供调用方打印摘要。
    """
    style_dir = os.path.join(web_dir, subdir)
    if not os.path.isdir(style_dir):
        return []
    changed = []
    for root, _dirs, files in os.walk(style_dir):
        for name in files:
            if not name.endswith(".css"):
                continue
            path = os.path.join(root, name)
            prefix = _depth_prefix(web_dir, root)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    src = f.read()
            except (OSError, UnicodeDecodeError):
                continue
            # 1) 幂等：压平任何已有的 (../)+ 前缀
            out = _PREFixed_RE.sub(lambda m: "url(" + m.group(1) + m.group(2) + "/", src)
            # 2) 按本文件深度重写为规范前缀
            if prefix:
                out = _CANONICAL_RE.sub(
                    lambda m: "url(" + m.group(1) + prefix + m.group(2) + "/", out
                )
            if out != src:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(out)
                changed.append(os.path.relpath(path, web_dir))
    return changed
