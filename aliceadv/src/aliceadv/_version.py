# =========================================================
# aliceADV 版本号唯一来源
#
# 本文件是引擎版本的**唯一**书写位置。其它任何地方都不应再出现版本号字面量：
#   - 包版本（pip / PyPI）  ：pyproject.toml 通过 [tool.setuptools.dynamic]
#                             读取下面的 __version__
#   - 引擎展示版本（产物）  ：aliceadv/__init__.py 由 __version__ 派生 ENGINE_VERSION，
#                             构建时注入 window.__ENGINE__（见 builder.py）
#   - 命令行 --version      ：读 __version__ 与 ENGINE_VERSION（见 cli.py）
#
# 改版本就是改下面那一行——全仓库只有这一处写版本号，其余全是读取，所以不需要
# 任何工具参与。改完重新构建需要带上新版本的工程即可。
#
# 不变量由测试守住（可直接运行，也可被 pytest 收集）：
#   python3 aliceadv/tests/test_version.py
# 它会在「别处又写死版本号 / pyproject.toml 不再走 dynamic / __init__.py 不再派生
# ENGINE_VERSION / builder.py 不再注入 window.__ENGINE__」时报错。
#
# 约束：本文件必须保持「零依赖 + 单条赋值」。setuptools 构建时会直接
# 静态解析（AST）下面这行来取版本，不会 import 本模块；一旦加入 import
# 或函数调用，静态解析失效，会退化成真正导入包，构建环境未必满足。
# =========================================================

__version__ = "0.3.1"