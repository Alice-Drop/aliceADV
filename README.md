# AliceADV

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
- [Documents](#documents)

## Installation

Requirements: Python >= 3.9.

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

The command prints `aliceADV 0.1.0 (engine v0.1)`.

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
├── info.json         # game name, version, engine field
├── story/            # script: chX.json, characters.json, chapters.json
├── gui/              # interface images (textbox, buttons, panels, overlays)
├── images/           # content images: bg/, char/<id>/
├── audio/            # music and sound effects
└── documents/        # documentation copies
```

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

Copies the template content (`gui/`, `images/`, `audio/`, `story/`, `theme.json`, `info.json`, `about.txt`, `documents/`) into the target directory.

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

For the complete instruction reference (field tables, defaults, examples, and limits), see `documents/指令.md`. The precise specification `剧本格式说明.md` is in `aliceadv/template/documents/` and in your project's `documents/`.

> Note: the instruction manual is currently written in Chinese. An English version is planned.

## Ren'Py migration

Two helpers exist:

- `aliceadv rpy2adv` converts scripts.
- `aliceadv gui2theme` converts layout.

They cover the common Ren'Py mapping (`label` / `jump` / `menu` / `$` / `default` / `if`). Not every Ren'Py feature is translated; review the generated JSON and adjust manually where needed.

## Architecture notes

The package separates the **engine template** (pure data: `index.html`, `style/`, `gui/`, `story/`, `images/`, `audio/`, `documents/`) from the **compiler implementation** (`creator.py`, `builder.py`, `cli.py`, `cssutil.py`). The template contains no Python code.

This separation is deliberate: if the compiler is later rewritten in another language, the same `template/` directory and CLI semantics can be reused without touching template content. The template location can be overridden with the `ALICEADV_TEMPLATE` environment variable, which points at any template directory.

The fixed design canvas is 1920×1080. `theme.json` values are authored in design pixels or as relative values (0–1) that the build translates into CSS.

## Documents

- `documents/指令.md` — instruction manual (Chinese): every instruction with purpose, fields, examples, and limits.
- `aliceadv/template/documents/剧本格式说明.md` and your project's `documents/剧本格式说明.md` — precise specification: field types, defaults, and boundaries.
- `girls_orbit_project/` — a sample project ported from a Ren'Py demo, showing a real script, `theme.json`, and branching.

## License

No LICENSE file is present in the repository yet. Add one at the repository root to specify the terms.
