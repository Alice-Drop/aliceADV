# AliceADV

aliceADV is a web-based ADV (visual novel) game engine that follows the design
language of Ren'Py. Scenes, dialogue, characters, and branching are described in
JSON, and the engine compiles them into a static web game that runs in any browser
with no server or runtime dependency — you can open `index.html` directly over
`file://` or host it as a static site.

The engine ships as a Python package providing a `create` / `build` command-line
tool, plus the engine template (HTML/CSS/JS) that is assembled into each project
at build time.

> 中文说明见仓库根目录 `README_zh-CN.md`。

## Installation

Requires Python >= 3.6 (see `requires-python` in `pyproject.toml`).

```bash
pip install aliceadv          # from PyPI
# or, from a local checkout of this package directory:
pip install ./aliceadv
```

Verify:

```bash
aliceadv --version
# aliceADV 0.1.0 (engine v0.1)
```

## Quick start

```bash
# 1. Create a project (copies the engine template into a new directory)
aliceadv create my_game --name "My Game"

# 2. Edit theme.json (styling) and story/*.json (script)

# 3. Build → <project>/dist/web/
aliceadv build my_game

# 4. Play: open my_game/dist/web/index.html, or serve it
python3 -m http.server -d my_game/dist/web 8000
```

## Game version & engine version

The game version comes from your project's `info.json` (`version` field, authored by
you). The **engine version** is stamped by the packaged engine itself at build time and
injected into the built `index.html` as `window.__ENGINE__`. Both are shown on the title
page and the About page after a build — so you no longer maintain the engine version by
hand.

Both numbers are zero-maintenance because they come from one place. The package version
is written exactly once, in `src/aliceadv/_version.py`; `__init__.py` derives
`ENGINE_NAME` / `ENGINE_VERSION` from it, and `pyproject.toml` reads the same value via
`[tool.setuptools.dynamic]`:

| Where | How it gets the version |
|---|---|
| `pyproject.toml` (`[project]`) | `dynamic = ["version"]` → `[tool.setuptools.dynamic] version = { attr = "aliceadv._version.__version__" }` |
| `aliceadv/__init__.py` | `from ._version import __version__`；`ENGINE_VERSION = "v" + __version__` |
| Build output `index.html` | `window.__ENGINE__ = {"name": "aliceADV", "version": "vX.Y.Z"}` |
| `aliceadv --version` | `aliceADV X.Y.Z (engine vX.Y.Z)` |

To cut a new version, edit that one line — nothing else in the repository carries a
version number.

`test_version.py` guards the invariant so it cannot decay: it fails if a version literal
reappears elsewhere, if `pyproject.toml` stops using `dynamic`, or if `__init__.py` stops
deriving `ENGINE_VERSION`.

```bash
python tests/test_version.py
```

## Command-line reference

| Command | Purpose |
|---|---|
| `aliceadv create <dir> [--name NAME] [--force]` | Create a project by copying the engine template. |
| `aliceadv build <dir>` | Build a project into `<dir>/dist/web/`. |
| `aliceadv rpy2adv <script.rpy> <images_dir> <out_dir>` | Convert a Ren'Py script into `story/` JSON. |
| `aliceadv gui2theme <gui.rpy> <theme.json> [--apply]` | Convert Ren'Py `gui.rpy` layout into `theme.json`. |

The build command refuses to run against the engine template directory itself (it
contains the `.aliceadv_engine` marker). The engine runtime (`index.html`, `style/`)
is **not** stored in your project — it is assembled from the engine template on every
build, so upgrading the engine takes effect by simply rebuilding.

## Documentation

Documentation is **not** bundled with this package, and `aliceadv create` does not copy
any docs into projects. It lives in the engine repository under `docs/` and is published
as a documentation site:

<https://alice-drop.github.io/aliceADV/>

It covers the instruction manual, the script JSON specification, the `theme.json` and
`info.json` configuration manuals, the engine overview, and how `aliceadv build` works.

## License

Released under the [MIT License](./LICENSE).
