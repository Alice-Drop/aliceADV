#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""版本一致性测试：守住「引擎版本只有一个来源」。

设计约定（见 docs/编译原理.md §5）：
  - 版本号唯一书写处是 src/aliceadv/_version.py 的 __version__；
  - pyproject.toml 用 dynamic = ["version"] 读同一个值，不再另写一份；
  - __init__.py 由它派生 ENGINE_VERSION = "v" + __version__；
  - builder.py 构建时把它注入产物的 window.__ENGINE__。

本测试防止下列退化：
  - 有人在 pyproject.toml 或 __init__.py 里重新写死版本号（双源又开始漂移）；
  - _version.py 里引入 import / 函数调用，破坏 setuptools 的静态解析；
  - 构建不再注入引擎版本，产物「关于」页与标题页失去引擎版本。

运行：
  python tests/test_version.py
  （也可被 pytest 收集，函数名以 test_ 开头）
"""

import ast
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)                        # .../aliceadv
REPO = os.path.dirname(PKG)                        # 引擎仓库根
SRC = os.path.join(PKG, "src")                     # .../aliceadv/src
sys.path.insert(0, SRC)

PACKAGE = os.path.join(SRC, "aliceadv")
VERSION_FILE = os.path.join(PACKAGE, "_version.py")
INIT_FILE = os.path.join(PACKAGE, "__init__.py")
BUILDER_PY = os.path.join(PACKAGE, "builder.py")
THEME_JS = os.path.join(PACKAGE, "template", "style", "theme.js")
PYPROJECT = os.path.join(PKG, "pyproject.toml")

VALID_RE = re.compile(r"^\d+\.\d+\.\d+(?:[.\-+]?[0-9A-Za-z.]+)?$")

_failures = []


def check(cond, msg):
    if cond:
        print("  ✓ " + msg)
    else:
        print("  ✗ " + msg)
        _failures.append(msg)
    return cond


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


# ---------------------------------------------------------
# 1. 唯一来源本身必须可被 setuptools 静态解析
# ---------------------------------------------------------
def test_version_file_is_static_single_assignment():
    print("_version.py 结构")
    tree = ast.parse(read(VERSION_FILE))

    body = [n for n in tree.body if not isinstance(n, ast.Expr)]
    assigns = [n for n in body if isinstance(n, ast.Assign)]
    check(len(assigns) == 1 and len(body) == 1,
          "_version.py 顶层只有一条赋值语句（其余为注释/文档字符串）")

    if assigns:
        node = assigns[0]
        check(len(node.targets) == 1
              and isinstance(node.targets[0], ast.Name)
              and node.targets[0].id == "__version__",
              "该赋值的目标是 __version__")
        check(isinstance(node.value, ast.Constant) and isinstance(node.value.value, str),
              "__version__ 的值是字符串字面量（非表达式）")
        if isinstance(node.value, ast.Constant):
            check(bool(VALID_RE.match(node.value.value)),
                  "版本号 %r 是合法的 x.y.z 形式" % node.value.value)

    risky = [n for n in ast.walk(tree)
             if isinstance(n, (ast.Import, ast.ImportFrom, ast.Call))]
    check(not risky,
          "_version.py 内无 import / 函数调用，保证 setuptools 静态解析成功")


# ---------------------------------------------------------
# 2. 派生关系
# ---------------------------------------------------------
def test_engine_version_derives_from_package_version():
    print("派生关系")
    import aliceadv
    from aliceadv._version import __version__ as raw

    check(aliceadv.__version__ == raw, "__init__.__version__ 与 _version.py 一致")
    check(aliceadv.ENGINE_NAME == "aliceADV", "ENGINE_NAME 为 aliceADV")
    check(aliceadv.ENGINE_VERSION == "v" + aliceadv.__version__,
          "ENGINE_VERSION == 'v' + __version__（由包版本派生，非另写一份）")
    check("from ._version import __version__" in read(INIT_FILE),
          "__init__.py 直接 import __version__（而非转而读安装元数据）")


# ---------------------------------------------------------
# 3. pyproject.toml 必须走 dynamic
# ---------------------------------------------------------
def test_pyproject_takes_version_dynamically():
    print("pyproject.toml")
    text = read(PYPROJECT)
    check('dynamic = ["version"]' in text, "[project] 声明 dynamic = [\"version\"]")
    check(not re.search(r"""(?m)^\s*version\s*=\s*["']""", text),
          "[project] 未写死 version = \"...\"")
    check("[tool.setuptools.dynamic]" in text, "存在 [tool.setuptools.dynamic]")
    check("aliceadv._version.__version__" in text,
          "动态版本指向 aliceadv._version.__version__")


# ---------------------------------------------------------
# 4. 构建必须注入引擎版本
# ---------------------------------------------------------
def test_build_injects_engine_version():
    print("构建注入")
    builder = read(BUILDER_PY)
    check("ENGINE_VERSION" in builder, "builder.py 引用 ENGINE_VERSION")
    check("window.__ENGINE__" in builder, "builder.py 注入 window.__ENGINE__")
    check("__ENGINE__" in read(THEME_JS), "theme.js 运行时读取 window.__ENGINE__")


# ---------------------------------------------------------
# 5. 仓库其它位置不得再出现写死的当前版本号
# ---------------------------------------------------------
SCAN_EXTS = {".py", ".toml", ".cfg", ".json", ".js", ".html", ".md", ".txt",
             ".in", ".yml", ".yaml", ".css"}
SKIP_DIRS = {".git", ".github", ".workbuddy", "__pycache__", "node_modules",
             "build", "dist", "废弃", "assets", "asserts", "fonts"}


def _version_lines():
    """返回 [(相对路径, 行号, 行内容)] —— 除唯一来源外写死了当前版本号的位置。

    整仓扫描（跳过构建产物与素材目录）。版本号只允许出现在 _version.py，
    其它任何位置出现都说明单一来源已经开始退化。
    """
    from aliceadv._version import __version__
    pattern = re.compile(r"(?<![\w.])v?" + re.escape(__version__) + r"(?![\w.])")
    hits = []
    for root, dirs, files in os.walk(REPO):
        dirs[:] = [d for d in dirs
                   if d not in SKIP_DIRS and not d.endswith(".egg-info")]
        for name in files:
            if os.path.splitext(name)[1].lower() not in SCAN_EXTS:
                continue
            path = os.path.join(root, name)
            if os.path.abspath(path) == os.path.abspath(VERSION_FILE):
                continue
            try:
                lines = read(path).splitlines()
            except (OSError, UnicodeDecodeError):
                continue
            for i, line in enumerate(lines, 1):
                if pattern.search(line):
                    hits.append((os.path.relpath(path, REPO), i, line.strip()))
    return hits


def test_no_hardcoded_version_elsewhere():
    print("单一来源")
    hits = _version_lines()
    for path, lineno, line in hits:
        print("      %s:%d  %s" % (path, lineno, line))
    check(not hits, "版本号只在 _version.py 中出现，其它位置均为派生")


def main():
    print("aliceADV 版本一致性测试")
    test_version_file_is_static_single_assignment()
    test_engine_version_derives_from_package_version()
    test_pyproject_takes_version_dynamically()
    test_build_injects_engine_version()
    test_no_hardcoded_version_elsewhere()
    print()
    if _failures:
        print("✗ 失败 %d 项" % len(_failures))
        return 1
    print("✓ 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
