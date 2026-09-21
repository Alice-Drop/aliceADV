# AliceADV

| English | [简体中文](./README_zh-CN.md) |

AliceADV is a web-based ADV (visual novel) game engine. It follows the design language of Ren'Py: scenes, dialogue, characters, and branching are described in JSON, and the engine produces a static web game that runs in any browser.

The engine ships as a Python package with a `create` / `build` command-line tool. The build output is plain HTML/CSS/JS with no server or runtime dependency — you can open `index.html` directly over `file://` or host it as a static site.

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Project structure](#project-structure)
- [Command-line reference](#command-line-reference)
- [Script overview](#script-overview)
- [Ren'Py migration](#renpy-migration)
- [Architecture notes](#architecture-notes)
- [Versioning](#versioning)
- [Documents](#documents)

## Installation

Requirements: Python >= 3.6.

Install from source:

```bash
pip install ./aliceadv
```

For development, install in editable mode:

```bash
pip install -e ./aliceadv
```

Verify:

```bash
aliceadv --version
```

The command prints the package version and the engine display version — both come from a
single source (`aliceadv/src/aliceadv/_version.py`), so they always agree, e.g.
`aliceADV 1.2.3 (engine v1.2.3)`.

## Quick start

1. Create a project. This copies the engine template into a new directory:

   ```bash
   aliceadv create my_game --name "My Game"
   ```

2. Edit the project. Modify `theme.json` for styling and `story/*.json` for the script. See [Documents](#documents) for the full instruction set.

3. Build the project. This assembles the engine runtime and your content into `my_game/dist/web/`:

   ```bash
   aliceadv build my_game
   ```

4. Play. Open `my_game/dist/web/index.html` in a browser, or serve it:

   ```bash
   python3 -m http.server -d my_game/dist/web 8000
   ```

## Project structure

After `aliceadv create`, a user project looks like this:

```text
my_game/
├── theme.json        # styling + interface text (colors, fonts, sizes, layout)
├── info.json         # game name, version
├── story/            # script: chX.json, characters.json, chapters.json
├── gui/              # interface images (textbox, buttons, panels, overlays)
├── images/           # content images: bg/, char/<id>/
└── audio/            # music and sound effects
```

A project contains content only. Documentation is not copied into projects; see [Documents](#documents).

The `index.html` shell and the engine runtime `style/` are **not** stored in the project. They are assembled from the engine template at build time. This keeps the project limited to content, so upgrading the engine takes effect by rebuilding.

The engine template itself lives in `aliceadv/template/` (part of the package). Do not point `aliceadv build` at it — the build command refuses to build a directory that contains the `.aliceadv_engine` marker.

## Command-line reference

| Command | Purpose |
|---|---|
| `aliceadv create <dir> [--name NAME] [--force]` | Create a new project by copying the engine template. |
| `aliceadv build <dir>` | Build a project into `<dir>/dist/web/`. |
| `aliceadv rpy2adv <script.rpy> <images_dir> <out_dir>` | Convert a Ren'Py script into `story/` JSON. |
| `aliceadv gui2theme <gui.rpy> <theme.json> [--apply]` | Convert Ren'Py `gui.rpy` layout into `theme.json`. |

### aliceadv create

Copies the template content (`gui/`, `images/`, `audio/`, `story/`, `theme.json`, `info.json`, `about.txt`) into the target directory.

| Argument | Type | Required | Description | Default |
|---|---|---|---|---|
| `dir` | string | no* | Target project directory. | interactive prompt |
| `--name` | string | no | Game name written into `info.json`. | template default |
| `--force` | flag | no | Skip the non-empty-directory confirmation. | off |

\* If `dir` is omitted, the CLI prompts for it.

The engine marker `.aliceadv_engine` and the engine runtime (`index.html`, `style/`) are not copied into the project.

### aliceadv build

Reads `theme.json` and `story/*.json` from the project, translates `theme.json` relative values (0–1) into percentage CSS variables, inlines theme and script into `index.html`, and writes the result to `<dir>/dist/web/`.

| Argument | Type | Required | Description | Default |
|---|---|---|---|---|
| `dir` | string | no* | Project directory to build. | interactive prompt |

\* If `dir` is omitted, the CLI prompts for it.

Behavior and limits:

- Refuses to build a directory containing `.aliceadv_engine` (the engine template itself).
- Requires `theme.json` at the project root.
- `info.json` values are merged into `theme.info` when present.
- `story/*.json` are collected and inlined as `window.__SCRIPTS__` so `file://` play works.
- The build is clean: `dist/web/` is removed and recreated each run.

### aliceadv rpy2adv

Converts a Ren'Py `.rpy` script into aliceADV `story/` JSON. Mapping: `label` → segment, `jump` → `goto`, `menu` → `decide`, `$ x=...` → `set`, `default x=...` → `vars`, and `if/elif/else` blocks → per-instruction `if` conditions.

### aliceadv gui2theme

Converts Ren'Py `gui.rpy` geometry and font-size parameters into `theme.json` `layout`/`sizes` fields. Without `--apply` it prints the computed values; with `--apply` it writes them back (fields not derived from geometry are preserved).

## Script overview

A script is a set of **segments** (剧情段). Each segment is an ordered list of instructions — JSON objects with a `cmd` field. A minimal valid script:

```json
{
  "start": "opening",
  "segments": {
    "opening": [
      { "cmd": "bg", "src": "images/bg/classroom.png" },
      { "cmd": "show", "char": "elin", "sprite": "normal", "at": "center" },
      { "cmd": "say", "char": "elin", "text": "晚上好。" }
    ]
  }
}
```

Common instructions:

| Instruction | Purpose |
|---|---|
| `bg` / `scene` | Set the background image. |
| `show` / `hide` | Add or remove a character sprite or image. |
| `sprite` | Swap the sprite of an already-shown character. |
| `say` / `narrate` | Display dialogue or narration. |
| `music` / `sound` / `voice` / `stop` | Control audio. |
| `set` / `if` / `decide` | Variables, conditional jumps, and player choices (branching). |
| `goto` | Jump to another segment. |
| `wait` / `end` | Pause, or end the game. |

Branching uses variables and conditions. A segment can `goto` another segment, forming a story graph; two branches may converge on a shared segment. Small differences in a shared segment are expressed either as an inline `{if ...}` inside `say` text, or as an `if` field on a single instruction (the instruction is skipped when its condition is false).

For the complete instruction reference (field tables, defaults, examples, and limits), see `docs/指令.md`. The precise specification of the script JSON is `docs/剧本格式说明.md`. Both are published at <https://alice-drop.github.io/aliceADV/>.

> Note: the instruction manual is currently written in Chinese. An English version is planned.

## Ren'Py migration

Two helpers exist:

- `aliceadv rpy2adv` converts scripts.
- `aliceadv gui2theme` converts layout.

They cover the common Ren'Py mapping (`label` / `jump` / `menu` / `$` / `default` / `if`). Not every Ren'Py feature is translated; review the generated JSON and adjust manually where needed.

## Architecture notes

The package separates the **engine template** (pure data: `index.html`, `style/`, `gui/`, `story/`, `images/`, `audio/`, `theme.json`, `info.json`, `about.txt`) from the **compiler implementation** (`creator.py`, `builder.py`, `cli.py`, `cssutil.py`). The template contains no Python code, and carries no documentation.

This separation is deliberate: if the compiler is later rewritten in another language, the same `template/` directory and CLI semantics can be reused without touching template content. The template location can be overridden with the `ALICEADV_TEMPLATE` environment variable, which points at any template directory.

The fixed design canvas is 1920×1080. `theme.json` values are authored in design pixels or as relative values (0–1) that the build translates into CSS.

## Versioning

The engine version is written in exactly one place:

```
aliceadv/src/aliceadv/_version.py      __version__ = "x.y.z"
```

Everything else derives from it. `pyproject.toml` declares `dynamic = ["version"]` and reads that same attribute, so the package version (`pip show aliceadv`, PyPI) can never drift from the source. `aliceadv/__init__.py` derives `ENGINE_VERSION = "v" + __version__`, which `builder.py` injects into the built `index.html` as `window.__ENGINE__`, and which `aliceadv --version` prints as `aliceADV x.y.z (engine vx.y.z)`.

To cut a new version, edit that one line and nothing else, then rebuild the projects that
should pick it up. `pyproject.toml`, `__init__.py`, the injected `window.__ENGINE__` and
`aliceadv --version` all follow from it.

`aliceadv/tests/test_version.py` guards the invariant so it cannot decay: it fails if a
version literal reappears elsewhere in the repository, if `pyproject.toml` stops using
`dynamic`, or if `__init__.py` stops deriving `ENGINE_VERSION`. Run it directly or through
pytest:

```bash
python aliceadv/tests/test_version.py
```

Keep `_version.py` free of imports and function calls: setuptools parses that line statically instead of importing the package at build time. Full details in [`docs/编译原理.md` §5](docs/编译原理.md).

Game version (what the player sees for your own game) is separate and lives in the project's `info.json`; engine version is never configured per project.

## Documents

All engine documentation lives in this repository under `docs/` and is published as a documentation site at <https://alice-drop.github.io/aliceADV/>.

- `docs/index.md` — index and five-minute quick start.
- `docs/指令.md` — instruction manual (Chinese): every instruction with purpose, fields, examples, and limits.
- `docs/剧本格式说明.md` — precise specification of the script JSON: field types, defaults, and boundaries.
- `docs/样式控制.md` / `docs/信息配置.md` — configuration manuals for `theme.json` / `info.json`.
- `docs/编译原理.md` — how `aliceadv build` assembles a project.
- `docs/定义.md` — engine overview: two-layer structure, directory and asset conventions.
- `docs/先进脚本设计.md` — design note for an unimplemented alternative script format.
- `docs/renpy文档.md` — Ren'Py GUI documentation kept as migration reference material.

Documentation is **not** shipped inside the `aliceadv` package, and `aliceadv create` does not copy it into projects. `example_project/` is a sample project showing a real script, `theme.json`, and branching.

### Publishing the docs site

The site is published by GitHub Pages straight from this repository. Repository setting:

- **Settings → Pages → Build and deployment → Source: Deploy from a branch**
- **Branch: `main`**, **folder: `/docs`**

Jekyll renders the Markdown in `docs/` on push; no build step or CI workflow is required.

## License

Released under the [MIT License](./aliceadv/LICENSE).
