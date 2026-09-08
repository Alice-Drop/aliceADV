# =========================================================
# aliceADV — 网页 ADV 游戏引擎（工程模板 + 创建/构建编译器）
#
# 包结构（模板与编译器实现分离）：
#   aliceadv/template/   引擎模板（纯数据：index.html / style / gui / story / ...）
#   aliceadv/creator.py  工程创建：模板 → 用户工程目录
#   aliceadv/builder.py  构建：工程目录 → <工程>/dist/web/
#   aliceadv/cli.py      `aliceadv` 命令行入口（create / build / rpy2adv / gui2theme）
#
# 模板目录单独存放、不含任何 Python 代码：将来若把编译器移植到其他语言，
# 只需复用 template/ 目录与同一套 CLI 语义，不必动模板内容。
# 模板位置可通过环境变量 ALICEADV_TEMPLATE 覆盖（指向任意的模板目录）。
# =========================================================
import os

__version__ = "0.1.0"
ENGINE_VERSION = "v0.1"

# 引擎（模板）目录标记：存在该文件的目录是引擎模板本身，禁止对其直接 build。
ENGINE_MARKER = ".aliceadv_engine"

# 引擎运行时文件：只存在于模板中，不复制进用户工程目录。
# 构建时由 builder 从模板装配到 dist/web/。
ENGINE_RUNTIME = ("index.html", "style")


def template_path():
    """返回引擎模板目录。

    优先读环境变量 ALICEADV_TEMPLATE（允许外部指定另一份模板，
    供其他语言实现的编译器或自定义模板复用）；缺省用包内 template/。
    """
    env = os.environ.get("ALICEADV_TEMPLATE")
    if env:
        return os.path.abspath(env)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "template")


from .creator import create_project
from .builder import build_project

__all__ = [
    "create_project",
    "build_project",
    "template_path",
    "__version__",
    "ENGINE_VERSION",
]
