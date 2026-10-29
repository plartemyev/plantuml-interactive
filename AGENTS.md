## Tooling notes

- **Docker service** (`Dockerfile` + `docker-compose.yml`, added 2026-10-29):
  single self-sufficient image — archlinux base + darkhttpd (docroot `/app`)
  + the full routing toolchain (`nodejs`, `kicad`/pcbnew, `jdk25-openjdk`,
  `fontconfig` for headless java). Repo files carry `0600` modes (author
  umask) and `COPY` preserves them, so the image runs `chmod -R a+rX /app` —
  without it darkhttpd (as `nobody`) 403s on unreadable files. darkhttpd's
  built-in MIME table serves ES modules fine (`text/javascript`), and
  `samples/` must be copied alongside `diagrams/` because two catalog
  `.puml` entries are symlinks into it. Routing runs in the same image via
  the profile-gated `router` compose service (same image, host-uid
  `${UID:-1000}`, rw `./diagrams` mount, scratch `/app/.tmp/board`
  pre-created 777); the serving service mounts `./diagrams` read-only, so
  re-routed boards are served without a rebuild. `tools/` must NOT be in
  `.dockerignore` (a `tools` exclusion with a `!tools/vendor/freerouting.jar`
  negation re-includes ONLY the jar — route-board.mjs silently vanishes from
  the image until the router run fails with MODULE_NOT_FOUND). One-tree
  consequence: darkhttpd also exposes `/tools/`, `/samples/` and the jar over
  HTTP — acceptable for a LAN viz tool.
- **Local serving is required**: browsers block `fetch()` and ES module scripts
  on `file://` pages. Serve with `python3 -m http.server 8000` (npm run serve).
  `index.html` carries an inline watchdog that explains this if the module
  never boots (file:// case).
- **`diagrams/index.json` is generated**: static servers cannot list
  directories; after adding/removing `diagrams/*.puml` run
  `node tools/update-index.mjs`. Symlinks into `diagrams/` work (python's
  http.server follows them; `diagrams/deployment.puml` -> `../samples/deployment.puml`).
- **Headless Chromium screenshots**: canvas content captured with
  `--virtual-time-budget` can be stale/unrelated to the final rAF state; plain
  `--screenshot` also cannot run page JS first. Use
  `node tools/screenshot.mjs <url> <out.png> ['js-expr'] [settle-ms]`
  (CDP driver over Node's built-in WebSocket; `MOUSE=x,y` env dispatches a real
  pointermove for tooltip testing). Chromium needs `--no-sandbox` here.
  The eval expression runs with `awaitPromise: true` — an async IIFE can
  chain diagram switch (click the `#diagram-items` button) + `__view.select()`.
  Give the switch a real settle delay (~1.5s) before selecting: the eval can
  race `loadDiagram`'s fetch, and `__view.select(id)` then lands on the
  previous scene (silent — `__selected` sets, `__focus` stays empty).
  Frame a target with `window.__view.focus(id)`; wheel-zoom to hardcoded
  screen coordinates is NOT reproducible across runs (the fit() scale after a
  diagram switch depends on the scene), synthetic `WheelEvent`s on the canvas
  only work right after a camera op you control. `?tsvlab=1` reveals the
  hidden TSV parameter panel; `window.__view.tsv({...})` drives the same
  parameters from scripts.
- **CSS gotcha**: author `display:` values (e.g. `#legend { display:flex }`)
  override the UA `[hidden] { display:none }`; `css/style.css` carries a global
  `[hidden] { display:none !important }` guard — keep it when adding panels.
- **Canvas silent failures**: NaN coordinates in canvas paths/fillRect do not
  throw — they draw nothing. If something "disappears", suspect NaN before
  suspecting paint order (this bit during development: `scene.byId` exposed
  BFS nodes instead of placed boxes).
- **Tests**: `node --test test/` (parser, layout, natural sort are pure modules
  with no DOM dependency — keep it that way so they stay Node-runnable).
- **Headless perf numbers are not wall-clock truth**: headless Chromium
  (`--disable-gpu`) throttles rAF unpredictably (20–55 fps observed), so fps
  figures from `tools/screenshot.mjs` are meaningless. Measure with the
  `window.__view.drawMs` / `__view.draws` debug hooks instead: `drawMs` is a
  smoothed per-draw cost (comparable across runs at identical view/zoom), and
  `draws` over a fixed interval verifies the idle skip / fps cap.
- **Headless viewport ≠ `--window-size`**: with `--window-size=1600,1000` the
  actual viewport (and `canvas.clientHeight`) is ~913px — headless=new reserves
  ~87px of virtual window chrome. Hand-computed screen coordinates from the
  window size are vertically off by half of that; use `innerHeight` or
  `window.__view.state()`/pixel probes on the canvas instead of assuming the
  full window height.
- **PCB routing pipeline** (`npm run route`): relations are autorouted as
  copper on a 2-layer board via KiCad + Freerouting. The board carries no
  package keepouts — copper may run under packages (the selection-time
  occluder ghosting keeps it readable) — except no-track zones on both
  copper layers covering each TSV column's projection shadow on the board:
  the screen band |d(x-y)| <= linerR*sqrt(2) up-screen of the pad, within
  the column height. A trace crossing that shadow is painted over by the
  column and reads as plugging into its top instead of its base pad
  (tools/lib/boardgeo.mjs `buildNoTrackZones`; polygon rule areas
  export/import fine with the plain jar). Where other landing pads sit
  inside a shadow, the strip resumes behind them, leaving a connection
  window on the pad's own side — their plug-in point stays briefly shadowed,
  which is inherent and short. Routing is two-pass
  (tools/route-board.mjs): pass 1 runs `kicad_route.py --single-layer`,
  which blocks B.Cu board-wide so only F.Cu is used; only when that leaves
  nets unrouted does pass 2 re-run on both layers and replace the result.
  Peculiarities discovered
  empirically (KiCad 10.0.7, Freerouting 2.5.0):
  - Freerouting 2.5.0 jar requires **Java ≥ 25** (class file 69): use
    `/usr/lib/jvm/java-27-openjdk/bin/java`; the system default is Java 17.
    The `freerouting-cli-*` native-image binaries crash on DSNs containing
    keepouts (`UnsupportedFeatureError: ObstacleArea serialization`) — use
    the plain jar, not the CLI distribution. Unattended batch:
    `java -jar freerouting.jar -de x.dsn -do x.ses --gui.enabled=false
    --router.autorouter.max_passes=40 -mt 1` (exits by itself; `-mt 1`
    keeps results deterministic). Without `--gui.enabled=false` v2.5.0
    OPENS ITS SWING UI whenever a display exists (shows the "Autorouter
    is about to start" countdown dialog, auto-starts, saves, exits —
    unattended but visibly windows on the desktop, hit 2026-10-29); with
    no DISPLAY it falls back to text mode on its own (warns "Couldn't
    get screen resolution"). The long-option spelling of `-mp` is
    `--router.autorouter.max_passes=` (plain `-mp` logs a deprecation
    warning); `--gui.enabled=false` logs "GUI is disabled and you don't
    have a console available" — expected. There is no `-h`-listed
    batch/`-headless` flag in v2.5.0.
  - A board with **no via padstack at all** crashes Freerouting 2.5
    (`NullPointerException ... viaRule is null`). Even when vias can never be
    placed (e.g. the F.Cu-only pass blocks B.Cu board-wide, vias included),
    the via padstack definition must stay in the DSN — blocking a layer
    entirely with a rule area is fine as long as the padstack exists.
  - pcbnew SWIG (system `python3`, module `pcbnew`): **every proxy added to
    the board must be kept alive** in a Python list (PCB_SHAPE, ZONE, the
    SHAPE_POLY_SET passed to `SetOutline`, NETINFO_ITEM, FOOTPRINT, PAD) —
    garbage-collecting them segfaults `SaveBoard`/`ExportSpecctraDSN`
    (symptom: sporadic SIGSEGV in ~100% of runs when the zone constructor is
    a function whose locals die).
  - `pcbnew.LSET(int)` / `LSET([...])` ctors are broken in this build (TypeError
    or SIGSEGV); use `pcbnew.PAD.SMDMask()` for SMD pads.
  - `pcbnew.NewBoard(path)` requires the filename argument.
  - `ExportSpecctraDSN` / `ImportSpecctraSES` are **module-level** functions,
    not BOARD methods. `ImportSpecctraSES` returns False silently — parse the
    `.ses` directly instead (`tools/lib/boardgeo.mjs sesToWorld`).
  - DSN/SES mirror the y axis (Specctra y-up vs KiCad y-down) and each file
    carries its own `(resolution <unit> <div>)` header; convert with
    `world = value/div/100` (µm→0.1 mm world units), y negated.
  - pcbnew prints harmless wx asserts ("PROPERTY_ENUM ... No enum choices
    defined") on stderr of every invocation — filter, don't fix.
  - Freerouting occasionally emits disconnected debris stubs in the SES;
    `chainSegments` drops them and validates the chain reaches the far pad.
  - Layout pin spread vs ports: ports claim their declared slot first, plain
    pins spread over the remaining slots (js/layout.js). Without this, a port
    pin and a spread pin can share a spot — harmless for the old airborne
    wires but a short (unroutable net) for PCB pads.
  - De-shadow pin pass (js/layout.js `deShadowPins`): a stacked die's landing
    pad sits directly below its pin, so on back faces (2: -x, 3: -y) the pad
    is inside the body's own isometric shadow unless the pin sits near the
    face's front corner (`t > 1 - z0/w` resp. `/d`; front faces 0/1 are never
    self-shadowed — the sweep preserves x-y). Spread pins are nudged to the
    nearest slot where the pad and the straight pad-to-peer run keep
    SHADOW_MARGIN (8 world units) of plan clearance from both bodies' sweep
    hexagons (js/occlude.js `segmentPolyDistance` — plain non-occlusion is
    not enough: a pad 1-2 units outside the hexagon hugs the silhouette edge
    and its trace reads as part of the edge line) AND stay >= 8.5 world units
    from every other net's pad — without the clearance guard corner-escaping
    pins converge on neighbours' pads and Freerouting plateaus with
    unresolved violations (observed on deployment.puml: identical score,
    5 unrouted + 2 violations, exploding memory, passes 13+). Ports never
    move; top-level package leads stay put (only stacked endpoints are
    nudged). Residual shadowed pins (crowded faces, port slots) remain
    covered by the selection-time occluder ghosting.
  - Edge label chips (js/render.js `drawEdgeLabel`) sit offset perpendicular
    to the route's local direction, on whichever side is free of package
    hulls — a chip centered on the copper hides short runs entirely (the
    poll net disappeared under its own label).
  - Route freshness: `route-board.mjs` TOOLCHAIN now also includes
    js/parser.js and js/layout.js — pin positions live in the layout, so a
    layout change stales every .routes.json (re-run `npm run route`).
