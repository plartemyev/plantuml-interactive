# plantuml-interactive

Interactive, isometric **"integrated circuit package"** rendering of PlantUML
**deployment diagrams** — a static web page, pure JavaScript, no third-party
frontend libraries.

## Why

PlantUML is excellent as *text*: diff-friendly in version control, LLM-friendly,
easy to author. Its *rendered* deployment diagrams are another story: a pure
layout engine scatters elements (people fight it with dozens of `-[hidden]->`
links), containment hierarchy is drawn as thin monochrome rectangles, and dense
infra diagrams turn into edge spaghetti. Try it:

```sh
plantuml -tpng samples/deployment.puml && xdg-viewer samples/deployment.png
```

This project keeps the text format and replaces the rendered artifact: elements
become **IC packages** on a board, nested elements become **package-on-package
(PoP) stacks**, and relations are **autorouted as copper traces on a 2-layer
board** — the same way a real PCB connects its components. Everything is drawn
in 2:1 isometric projection with cel shading.

## PCB routing pipeline

Relations are not drawn as wires in the air: they become **nets on a 2-layer
board**, routed by [Freerouting](https://freerouting.org) (GPL, the standard
open-source autorouter) through a KiCad round-trip. Each diagram layout is
exported as a board (packages = keepout rule areas on both copper layers, pin
slots = SMD pads, stacked blocks = TSV landing pads with escape corridors),
autorouted headlessly, and the resulting tracks/vias are stored as
`diagrams/<name>.routes.json` which the renderer paints as base-layer copper
(dimmed for the underside layer, vias as donuts).

```sh
npm run route      # (re)route all diagrams; --force to ignore freshness
```

Toolchain requirements (build-time only, the page itself stays dependency-free):

- `python3` with the `pcbnew` module (the `kicad` package);
- Java ≥ 25 and the Freerouting jar at `tools/vendor/freerouting.jar`
  (or `$FREEROUTING_JAR`), e.g.:
  `curl -L -o tools/vendor/freerouting.jar https://github.com/freerouting/freerouting/releases/download/v2.5.0/freerouting-2.5.0.jar`

Diagrams without a routes file (or individual unrouted nets) fall back to the
legacy airborne wires, so adding a `.puml` never blocks rendering.

## Quick start

Browsers forbid `fetch()` of local files on `file://` pages, so serve the
directory over HTTP:

```sh
python3 -m http.server 8000
# open http://localhost:8000/
```

Then:

- **drag** — pan · **wheel** — zoom · **dblclick** — fit to view
- **click a package** — pin the selection: animated exploded view (children
  spread and lift; each package carries its own piece of the through-chip
  via, and dotted leaders bridge the temporary disconnects), its nets
  glow on the copper with their labels, and occluding packages fade to 30%
  so every connection stays visible end to end — board copper *and* the
  through-chip columns, which pierce the housings (the selected container
  itself becomes translucent when its subtree's columns run through it).
  Notes of the package and of its net neighbors appear. **Click empty
  space** to deselect and revert everything.
- **hover a package** — tooltip only (the scene never changes under the cursor)
- face labels appear progressively with zoom level (LOD); net labels and
  notes are hidden entirely until a package is selected
- rendering is capped at ~30 fps and skips redraws entirely while idle

## Adding diagrams

1. Put or link `.puml` files into `diagrams/` (deployment-style syntax;
   symlinks are fine — the bundled `diagrams/deployment.puml` links to
   `samples/deployment.puml`).
2. Regenerate the catalog and route the board:

   ```sh
   node tools/update-index.mjs
   npm run route          # needs the toolchain above; optional
   ```

If more than one diagram is listed, a selector appears in the top-right
corner; the first naturally-sorted diagram (`3-tier-web` before
`deployment-10` before `deployment-2`) loads on start.

## Supported .puml subset

- Element declarations: `node`, `cloud`, `database`, `queue`, `frame`,
  `package`, `folder`, `card`, `component`, `rectangle`, `storage`, `stack`,
  `actor`, `agent`, `boundary`, `control`, `entity`, `interface`, `file`,
  `label`, `person`, `hexagon`, `artifact`, `usecase` — with `"quoted labels"`
  (including `\n` escapes and strings spanning physical lines), `as alias`,
  `<<stereotypes>>`, and nested `{ ... }` blocks.
- `port` / `portin` / `portout` inside elements: rendered as pin slots on the
  parent package; relations through ports attach to the parent at the port's
  slot.
- Relations: `-->`, `..>`, `--`, `..`, `<-->`, direction hints (`-up->`),
  bracket annotations (`-[hidden]->`, `-[#color]->`, `bold`, `dotted`,
  `dashed`), `: labels` (multi-line via `\n`).
- `note left|right|top|bottom of X` (block and inline), `note as N`.
- `title`, `@startuml name`.
- `together { }` blocks (transparent grouping).
- Tolerated and ignored: `skinparam`, `!pragma`, `!theme`, `!include`,
  `hide/show`, `scale`, `set`, `legend`, direction directives.
- Undeclared aliases referenced in relations are auto-created (as PlantUML
  does — it renders them as actors) and produce a visible parser warning.

Anything unrecognized is skipped with a warning (badge in the bottom-right
corner) — the parser never throws on bad input.

## Architecture

```
index.html            page shell + boot watchdog (file:// guidance)
css/style.css         HUD panels (title block, legend, list, warnings, tooltip)
js/parser.js          tolerant .puml -> model (elements, relations, notes)
js/textutil.js        label wrapping (shared by layout + tests)
js/layout.js          deterministic containment-tree layout:
                      grid packing per container, PoP z-stacking,
                      edge pin assignment (face + slot, port slots claimed
                      first), painter order
js/render.js          Canvas 2D renderer: 2:1 dimetric projection, cel-shaded
                      packages, base-layer copper tracks + vias (routes.json),
                      pin leads, LOD tiers, selection explode + net tracing,
                      occluder ghosting, ~30 fps cap + idle skip, hit testing
js/occlude.js         pure board-level occlusion math (package board shadows
                      vs copper paths and TSV drops, world space; tested)
js/tsv.js             pure TSV geometry: per-package column pieces, radii
                      and core-nub spec (tested)
js/main.js            catalog loading, HUD wiring, debug hooks
diagrams/             your .puml files + generated index.json + *.routes.json
samples/              reference diagrams (stock PlantUML comparison)
tools/update-index.mjs  rebuilds diagrams/index.json
tools/route-board.mjs   PCB routing driver (layout -> board spec -> KiCad ->
                        Freerouting -> diagrams/<name>.routes.json)
tools/lib/boardgeo.mjs  pure board geometry + Specctra .ses parsing (tested)
tools/kicad_route.py    builds the KiCad board, exports DSN, runs Freerouting
tools/vendor/           freerouting.jar (not committed)
test/                 Node built-in test-runner suites (parser, layout, sort,
                      occlusion, tsv geometry, pcb routing geometry)
```

Parser and layout are pure modules (no DOM), unit-tested with `node --test`:

```sh
npm test          # or: node --test test/
```

### Layout model

- World space: `x/y` = board plane, `z` = up. Children sit **on top** of their
  parent (`z0 = parent.z1 + gap`), like stacked IC packages.
- Siblings are packed into a grid; the packer tries every column count and
  keeps the most square-ish result. Declaration order is preserved.
- Containers reserve a front **silkscreen strip** on their top face for the
  title, like PCB silkscreen.
- Wires leave a package through side-face **pins** (spread along the face to
  avoid overlap); pins attached through ports keep the port's declared slot
  and the remaining pins spread over the free slots. Routed nets become
  copper on the 2-layer board (see the routing pipeline above); stacked
  blocks connect through a **through-chip via (TSV)** down to their landing
  pad on the base layer — drawn as per-package cel-shaded pieces (Cu signal
  core inside a dielectric liner, `js/tsv.js` holds the geometry): every
  housing owns its body's segment plus the gap up to the next package, and
  at rest the pieces tile into one column from the pad to the die's bottom.
  On explosion each piece moves with its own package, and dotted leaders
  bridge the temporary gaps between disconnected ends — the topmost leader
  runs from the die's pin.
- Painter order is `(z0, x+y diagonal)`; elements of one diagram always lay
  out identically (deterministic, snapshot-tested).

### Current limitations

- Occlusion is painter-sorted, not a z-buffer: rare cross-subtree overlaps can
  draw in a wrong order (mitigated by the click-explode).
- Occluder ghosting for traced nets is computed once at selection time, from
  resting positions — a package that stops (or starts) covering a trace only
  because of the explode animation itself is not re-evaluated until the next
  selection.
- Copper routed on the underside (B.Cu) is drawn translucent; it is not
  z-occluded by the board, only styled dimmer.
- Edge labels show their first line at route midpoint, only for the traced
  nets of the selected package.
- No minimap, no search, no editing — read-only visualization by design.

## Development

```sh
npm run serve      # python3 -m http.server 8000
npm test           # unit tests
npm run index      # regenerate diagrams/index.json
npm run route      # re-route the boards (KiCad + Freerouting toolchain)
node tools/screenshot.mjs http://localhost:8000/ out.png \
     'window.__view.select("ecs")'   # scripted interactive screenshots
```

Debug hooks on `window.__view` (used by headless screenshots; harmless
otherwise): `hover(id)`, `select(id)`, `fit()`, `zoom(f)`, `focus(id)`
(center + zoom on one package — deterministic framing for shots),
`tsv(params)` / read-only `tsvParams` (TSV parameter overrides; the hidden
"TSV lab" slider panel — kept for future experiments — reappears with
`?tsvlab=1` on diagrams that stack packages), read-only `scale`,
`drawMs` (smoothed draw cost), `draws` (frames actually painted — with the
idle skip this stays flat while the page sits still) and `state()` (snapshot
of per-package ghost/explode targets and the current focus set).

See `AGENTS.md` for tooling notes (headless Chromium quirks, PlantUML CLI
peculiarities).

## License

plantuml-interactive is licensed under the **GNU Lesser General Public
License v3.0** — the same license family as PlantUML itself.

- `LICENSE` — the full GNU LGPL-3.0 text
- `COPYING` — the full GNU GPL-3.0 text, which the LGPL incorporates by
  reference and which must accompany it

SPDX identifier: `LGPL-3.0-or-later`. Every source file carries a matching
SPDX header.

Copyright © 2026 Pavel Artemyev &lt;a@pavel.bz&gt;

This program is free software: you can redistribute it and/or modify it
under the terms of the GNU Lesser General Public License as published by
the Free Software Foundation, either version 3 of the License, or (at your
option) any later version. This program is distributed in the hope that it
will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty
of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Lesser
General Public License for more details.
