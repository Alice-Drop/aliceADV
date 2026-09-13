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

Requires Python >= 3.9.

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
you). The **engine version** is stamped by the packaged engine itself at build time
(`aliceadv/__init__.py` → `ENGINE_NAME` / `ENGINE_VERSION`) and injected into the
built `index.html` as `window.__ENGINE__`. Both are shown on the title page and the
About page after a build — so you no longer maintain the engine version by hand.

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

## License

Released under the [MIT License](./LICENSE).
