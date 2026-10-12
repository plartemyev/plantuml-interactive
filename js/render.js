// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Canvas 2D isometric renderer with "integrated circuit package" styling.
//
// - 2:1 dimetric projection, cel-shaded boxes (flat top/left/right shades)
// - nesting rendered as package-on-package stacking with corner TSV vias
// - click: pin a package — animated exploded view (children spread + lift,
//   leaves pop up), its nets glow on the copper, occluding packages ghost
//   to 30% so every trace stays visible; notes of the package and of its
//   net neighbors appear. Nothing is shown until a click selects a package.
// - hover: tooltip only
// - wheel: zoom
// - level-of-detail: labels/notes/edge labels appear by zoom tier
// - frame pacing: ~30 fps cap, and no redraws at all while idle
//
// Pure Canvas 2D + ES modules, no third-party code.

import { M, PIN_NORMALS, pinWorld } from './layout.js';
import { findOccluders } from './occlude.js';
import { TSV_DEFAULTS, tsvPieces, tsvSpec } from './tsv.js';

// Kind → base color (top face derives from this; sides darken).
export const PALETTE = {
  node: { base: '#3e8f68', label: 'node' },
  cloud: { base: '#5b8fc9', label: 'cloud' },
  database: { base: '#c9934f', label: 'database' },
  queue: { base: '#a06fc9', label: 'queue' },
  frame: { base: '#66707f', label: 'frame' },
  package: { base: '#66707f', label: 'package' },
  folder: { base: '#66707f', label: 'folder' },
  card: { base: '#8a919c', label: 'card' },
  actor: { base: '#c95f5f', label: 'actor' },
  component: { base: '#4f9a9a', label: 'component' },
  rectangle: { base: '#7a8494', label: 'rectangle' },
  storage: { base: '#b7797f', label: 'storage' },
  stack: { base: '#7a6fc9', label: 'stack' },
  file: { base: '#7f9a6f', label: 'file' },
  default: { base: '#7a8494', label: 'element' },
};

const BG = '#0b0f14';
const BOARD = '#0f141b';
const OUTLINE = '#05070b';
const TEXT_ON_FACE = 'rgba(7, 12, 16, 0.92)';
const SILKSCREEN = 'rgba(214, 226, 235, 0.85)';
const EDGE_DIM = '126, 143, 166';
const ACCENT = '#53e3c2';
// PCB copper: a dark solder-mask outline under a copper core. B.Cu is the
// board underside — same hue, dimmer, so layer changes read as such.
const COPPER = 'rgba(206, 141, 79, 0.62)';
const COPPER_B = 'rgba(206, 141, 79, 0.30)';
const COPPER_DIM = 'rgba(206, 141, 79, 0.26)';
const COPPER_DIM_B = 'rgba(206, 141, 79, 0.15)';
const COPPER_MASK = 'rgba(6, 8, 10, 0.9)';
const VIA_HOLE = '#0a0e13';
// TSV bodies: cel-shaded Cu signal core in copper tones inside a dielectric
// liner sleeve in the accent teal family; hi (traced/lifted) glows accent.
const TSV_CORE_L = '#d69a52';
const TSV_CORE_TOP = '#eeb36b'; // fully lit top face of the Cu core
const TSV_CORE_D = '#96602f';
const TSV_LINER_L = '#2f9d87';
const TSV_LINER_D = '#1e6a5b';
const TSV_LINER_L_HI = '#53e3c2';
const TSV_LINER_D_HI = '#2a9a85';
const SQRT2 = Math.sqrt(2); // world circle radius -> projected ellipse semi-x
const ZERO_OFF = { dx: 0, dy: 0, lift: 0 }; // the board (pads never move)

const STUB = 14;        // wire stub length leaving a package pin
const SPREAD = 42;      // in-plane explode distance for children
const LIFT_CHILD = 30;  // vertical explode lift for children
const LIFT_SELF = 12;   // selected container pops slightly itself
const LIFT_LEAF = 38;   // selected leaf pops off the board
const OCCLUDE_ALPHA = 0.3;              // ghost level for trace occluders
const FRAME_MIN_MS = 1000 / 30;         // power-saving render cap: ~30 fps

const KY = 0.5; // 2:1 dimetric: sy = (x + y) * KY - z

function isoX(x, y) { return x - y; }
function isoY(x, y, z) { return (x + y) * KY - z; }

// ---- color helpers -------------------------------------------------------

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function shade(hex, dl) {
  const [r, g, b] = hexToRgb(hex);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c + dl * 255)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

function paletteFor(kind) {
  return PALETTE[kind] ?? PALETTE.default;
}

// ---- renderer ------------------------------------------------------------

export function createRenderer(canvas, hooks = {}) {
  const ctx = canvas.getContext('2d');
  let scene = null;
  let dpr = 1;
  let W = 0;
  let H = 0;
  const cam = { sx: 0, sy: 0, scale: 1 };
  const anim = new Map(); // box id -> {dx,dy,lift,ghost, tdx,tdy,tlift,tghost}
  let hoverId = null;
  let selectedId = null;
  let hulls = []; // rebuilt per frame: {id, poly, minx, miny, maxx, maxy}
  let pointer = { x: 0, y: 0 };
  let dragging = null; // {startX, startY, camSX, camSY, moved}
  let focusEdges = new Set(); // edges of the selected element, per selection
  let focusNets = new Set();  // selected element + direct net neighbors
  let needsDraw = true;       // redraw only when something changed
  let routeView = new Map();  // edge index -> {raw, pts, runs, viaPts, midPt}
  let glyphFit = 1; // uniform kind-glyph scale, computed once per scene load
  let raf = 0;
  let lastT = 0;
  let lastFrameT = -1e9;
  let dashOffset = 0;
  let drawMs = 0; // smoothed draw() cost, for the debug hook
  let draws = 0;  // frames actually painted, for the debug hook
  let tsvParams = { ...TSV_DEFAULTS }; // TSV lab (playground) parameters

  // ---- dynamic state -----------------------------------------------------

  function stateOf(id) {
    let s = anim.get(id);
    if (!s) {
      s = { dx: 0, dy: 0, lift: 0, ghost: 1, tdx: 0, tdy: 0, tlift: 0, tghost: 1 };
      anim.set(id, s);
    }
    return s;
  }

  // Recompute every explode target from scratch for the current selection.
  function retarget() {
    for (const s of anim.values()) {
      s.tdx = 0; s.tdy = 0; s.tlift = 0;
    }
    const id = selectedId;
    if (!id || !scene) return;
    const box = scene.byId.get(id);
    if (!box) return;
    const self = stateOf(id);
    if (box.container) {
      self.tlift = LIFT_SELF;
      for (const b of scene.boxes) {
        if (b.parentId !== id) continue;
        const s = stateOf(b.id);
        const cx = box.x + box.w / 2;
        const cy = box.y + box.d / 2;
        let ux = b.x + b.w / 2 - cx;
        let uy = b.y + b.d / 2 - cy;
        const len = Math.hypot(ux, uy) || 1;
        ux /= len; uy /= len;
        s.tdx = ux * SPREAD;
        s.tdy = uy * SPREAD;
        s.tlift = LIFT_CHILD;
      }
    } else {
      self.tlift = LIFT_LEAF;
    }
  }

  function stepAnim(dt) {
    const k = Math.min(1, dt * 9);
    for (const s of anim.values()) {
      s.dx += (s.tdx - s.dx) * k;
      s.dy += (s.tdy - s.dy) * k;
      s.lift += (s.tlift - s.lift) * k;
      s.ghost += (s.tghost - s.ghost) * k;
    }
  }

  // True while any explode/ghost state is still easing toward its target.
  function animating() {
    for (const s of anim.values()) {
      if (Math.abs(s.dx - s.tdx) > 0.05 || Math.abs(s.dy - s.tdy) > 0.05
        || Math.abs(s.lift - s.tlift) > 0.05 || Math.abs(s.ghost - s.tghost) > 0.002) {
        return true;
      }
    }
    return false;
  }

  // Selection: explode the package, trace its nets, reveal the notes of the
  // package and of its net neighbors, and ghost every package that covers
  // any traced copper (so the traces stay visible). Reverts on deselect.
  function applySelection(id) {
    selectedId = id;
    retarget();
    focusEdges = edgeFocusSet();
    focusNets = new Set();
    for (const s of anim.values()) s.tghost = 1;
    if (id && scene) {
      focusNets.add(id);
      const paths = [];
      for (const e of focusEdges) {
        focusNets.add(e.fromId);
        focusNets.add(e.toId);
        const rv = e.routeIdx != null ? routeView.get(e.routeIdx) : null;
        if (!rv) continue;
        paths.push(rv.raw.path);
        // TSV columns are per-package pieces; assembled, they span the pad
        // up to the die's REST bottom face (z0). A column point at height
        // z' projects to the board point pad - (z', z'), so the column is
        // hidden exactly where that diagonal crosses a package's board
        // shadow — test it with the same occlusion machinery.
        for (const end of rv.raw.ends) {
          if (!end.stacked) continue;
          const b = scene.byId.get(end.box);
          if (!b) continue;
          const zTop = b.z0;
          paths.push([
            [end.land[0], end.land[1]],
            [end.land[0] - zTop, end.land[1] - zTop],
          ]);
        }
      }
      for (const oid of findOccluders(scene.boxes, paths, id)) {
        stateOf(oid).tghost = OCCLUDE_ALPHA;
      }
      // The selected subtree's columns must read through their housings
      // even when the selected element itself has no traced nets: ghost
      // every package covering those columns — the selected container
      // itself included (translucent-housing exploded view) — but not the
      // lifting descendants, which fly away from their own columns.
      const stack = subtreeBoxes(id);
      const colPaths = [];
      for (const e of scene.edges) {
        const rv = e.routeIdx != null ? routeView.get(e.routeIdx) : null;
        if (!rv) continue;
        for (const end of rv.raw.ends) {
          if (!end.stacked || end.box === id || !stack.has(end.box)) continue;
          const b = scene.byId.get(end.box);
          if (!b) continue;
          const zTop = b.z0;
          colPaths.push([
            [end.land[0], end.land[1]],
            [end.land[0] - zTop, end.land[1] - zTop],
          ]);
        }
      }
      for (const oid of findOccluders(scene.boxes, colPaths, null)) {
        if (oid !== id && stack.has(oid)) continue;
        stateOf(oid).tghost = OCCLUDE_ALPHA;
      }
    }
    needsDraw = true;
  }

  // Parent offsets propagate to descendants (painter order guarantees
  // parents are visited first).
  function effectiveOffsets() {
    const eff = new Map();
    for (const b of scene.boxes) {
      const s = stateOf(b.id);
      const p = b.parentId ? eff.get(b.parentId) : null;
      eff.set(b.id, {
        dx: (p ? p.dx : 0) + s.dx,
        dy: (p ? p.dy : 0) + s.dy,
        lift: (p ? p.lift : 0) + s.lift,
        ghost: s.ghost,
      });
    }
    return eff;
  }

  // Root id -> {root} ∪ descendants. scene.boxes is painter-ordered
  // (parents before children), so one pass closes the set.
  function subtreeBoxes(rootId) {
    const set = new Set([rootId]);
    for (const b of scene.boxes) {
      if (b.parentId && set.has(b.parentId)) set.add(b.id);
    }
    return set;
  }

  // ---- projection --------------------------------------------------------

  const project = (x, y, z) => ({ x: isoX(x, y), y: isoY(x, y, z) });

  function toScreen(p) {
    return {
      x: (p.x - cam.sx) * cam.scale + W / 2,
      y: (p.y - cam.sy) * cam.scale + H / 2,
    };
  }

  function screenToIso(px, py) {
    return {
      x: (px - W / 2) / cam.scale + cam.sx,
      y: (py - H / 2) / cam.scale + cam.sy,
    };
  }

  function boxOrigin(b, eff) {
    return { x: b.x + eff.dx, y: b.y + eff.dy, z0: b.z0 + eff.lift, z1: b.z1 + eff.lift };
  }

  // ---- drawing -----------------------------------------------------------

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    hulls = [];
    if (!scene) return;
    // camera: world(iso) units -> screen, for everything scene-related
    ctx.setTransform(
      dpr * cam.scale, 0, 0, dpr * cam.scale,
      dpr * (W / 2 - cam.sx * cam.scale),
      dpr * (H / 2 - cam.sy * cam.scale),
    );
    const eff = effectiveOffsets();
    drawBoard();
    const view = viewBounds();
    dashOffset -= 0.55;
    drawRoutes(eff, view);
    for (const b of scene.boxes) {
      const o = boxOrigin(b, eff.get(b.id));
      if (boxOutsideView(b, o, view)) continue;
      drawBox(b, o, eff.get(b.id));
    }
    drawEdges(eff);
    drawNotes(eff);
  }

  // Indexes the routed board (if the diagram has one): edge -> copper path.
  // Edges without a route (self loops, unroutable, or no routes.json) keep
  // the airborne fallback wire. Projections of the static copper are cached
  // per scene load — they depend on world coordinates only, not the camera.
  function buildRouteView() {
    routeView = new Map();
    for (const e of scene.edges) {
      e.routed = false;
      delete e.routeIdx;
    }
    const routes = scene.routes;
    if (!routes || !routes.nets) return;
    for (const [idxStr, r] of Object.entries(routes.nets)) {
      const idx = Number(idxStr);
      const e = scene.edges[idx];
      if (!e || r.unrouted || !Array.isArray(r.path) || r.path.length < 2) continue;
      e.routed = true;
      e.routeIdx = idx;
      const pts = r.path.map(([x, y]) => project(x, y, 0.3));
      let minx = Infinity; let maxx = -Infinity; let miny = Infinity; let maxy = -Infinity;
      for (const p of pts) {
        minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x);
        miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y);
      }
      const mid = r.path[Math.floor(r.path.length / 2)];
      routeView.set(idx, {
        raw: r,
        pts,
        bounds: { minx, maxx, miny, maxy },
        runs: layerRuns(r),
        viaPts: (r.vias ?? []).map(([x, y]) => project(x, y, 0.3)),
        midPt: { x: mid[0], y: mid[1], z: 6 },
      });
    }
  }

  function viewBounds() {
    const a = screenToIso(0, 0);
    const b = screenToIso(W, H);
    return { minx: Math.min(a.x, b.x) - 80, maxx: Math.max(a.x, b.x) + 80, miny: Math.min(a.y, b.y) - 80, maxy: Math.max(a.y, b.y) + 80 };
  }

  function boxOutsideView(b, o, view) {
    const minIx = o.x - (o.y + b.d);
    const maxIx = (o.x + b.w) - o.y;
    const minIy = (o.x + o.y) * KY - o.z1;
    const maxIy = (o.x + b.w + o.y + b.d) * KY - o.z0;
    return maxIx < view.minx || minIx > view.maxx || maxIy < view.miny || minIy > view.maxy;
  }

  function drawBoard() {
    const bd = scene.bounds;
    const c = [
      project(0, 0, -2), project(bd.w, 0, -2), project(bd.w, bd.d, -2), project(0, bd.d, -2),
    ];
    ctx.beginPath();
    ctx.moveTo(c[0].x, c[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
    ctx.closePath();
    ctx.fillStyle = BOARD;
    ctx.fill();
    ctx.strokeStyle = 'rgba(90, 110, 130, 0.35)';
    ctx.lineWidth = 1.4 / cam.scale;
    ctx.stroke();
    // faint mounting-hole grid, like a PCB silkscreen
    ctx.strokeStyle = 'rgba(90, 110, 130, 0.10)';
    ctx.lineWidth = 1 / cam.scale;
    ctx.beginPath();
    for (let gx = 240; gx < bd.w; gx += 240) {
      const a = project(gx, 0, -2);
      const b = project(gx, bd.d, -2);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    for (let gy = 240; gy < bd.d; gy += 240) {
      const a = project(0, gy, -2);
      const b = project(bd.w, gy, -2);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }

  function drawBox(b, o, eff) {
    const pal = paletteFor(b.kind);
    const A = project(o.x, o.y, o.z1);
    const B = project(o.x + b.w, o.y, o.z1);
    const C = project(o.x + b.w, o.y + b.d, o.z1);
    const D = project(o.x, o.y + b.d, o.z1);
    const A0 = project(o.x, o.y, o.z0);
    const B0 = project(o.x + b.w, o.y, o.z0);
    const C0 = project(o.x + b.w, o.y + b.d, o.z0);
    const D0 = project(o.x, o.y + b.d, o.z0);
    const ghost = eff.ghost < 0.999 ? eff.ghost : 1;
    ctx.globalAlpha = ghost;

    // right face (y + d plane), left face (x + w plane), top face
    fillPoly([D0, C0, C, D], shade(pal.base, 0.02));
    fillPoly([B0, C0, C, B], shade(pal.base, -0.16));
    fillPoly([A, B, C, D], shade(pal.base, 0.16));
    // crisp cel outline: top rim, front bottom edges, visible verticals
    strokePoly([A, B, C, D], OUTLINE, 1.2 / cam.scale);
    strokePoly([B0, C0, D0], OUTLINE, 1.2 / cam.scale);
    strokePoly([C, C0], OUTLINE, 1.2 / cam.scale);
    drawFaceDetails(b, o, A, B, D);
    recordHull(b, [A, B, C, D, C0, D0, A0, B0]);
    ctx.globalAlpha = 1;
  }

  function fillPoly(pts, color) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  function strokePoly(pts, color, width) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  // Silkscreen title (containers) and printed label (top faces).
  function drawFaceDetails(b, o, A, B, D) {
    const lod = lodTier();
    ctx.save();
    // map face-space (world x,y) onto the projected top face
    const ux = { x: (B.x - A.x) / b.w, y: (B.y - A.y) / b.w };
    const vy = { x: (D.x - A.x) / b.d, y: (D.y - A.y) / b.d };
    ctx.transform(ux.x, ux.y, vy.x, vy.y, A.x, A.y);
    if (b.container) drawSilkscreen(b, lod);
    else drawLeafLabel(b, lod);
    if (lod.icons) drawKindGlyph(b);
    ctx.restore();
  }

  function drawSilkscreen(b, lod) {
    if (b.depth > lod.silkDepth) return;
    const y0 = b.d - M.margin - M.silkscreenD + M.silkscreenD / 2;
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = SILKSCREEN;
    const maxPx = b.w - 2 * M.margin;
    ctx.fillText(fitText(ctx, b.titleLine, maxPx), M.margin, y0);
  }

  function drawLeafLabel(b, lod) {
    if (lod.leafLines === 0) return;
    const lines = lod.leafLines === 1 ? b.lines.slice(0, 1) : b.lines;
    if (lines.length === 0) return;
    ctx.font = '600 13px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = TEXT_ON_FACE;
    const y0 = b.d / 2 - ((lines.length - 1) * M.lineH) / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], b.w / 2, y0 + i * M.lineH);
    }
    if (b.stereotype && lod.stereo) {
      ctx.font = 'italic 10px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(7, 12, 16, 0.65)';
      ctx.fillText(`<< ${b.stereotype} >>`, b.w / 2, 10);
    }
  }

  // All kind glyphs share one size per scene: the largest that fits into 90%
  // of the shortest side of the scene's smallest box, so every element can
  // carry the same stamp. Computed once per load, independent of the camera.
  function computeGlyphFit() {
    const base = 20; // glyph bounding box in world units at scale 1
    let minSide = Infinity;
    for (const b of scene.boxes) minSide = Math.min(minSide, b.w, b.d);
    if (minSide === Infinity) return 1;
    return (minSide * 0.9) / base;
  }

  // Kind glyph in the top-right corner of the top face, at the shared
  // per-scene scale (geometry is authored around its own center).
  function drawKindGlyph(b) {
    const k = b.kind;
    const gs = glyphFit;
    ctx.save();
    ctx.translate(b.w - 12 * gs, 12 * gs);
    ctx.scale(gs, gs);
    ctx.strokeStyle = 'rgba(7, 12, 16, 0.55)';
    ctx.fillStyle = 'rgba(7, 12, 16, 0.55)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    if (k === 'database' || k === 'storage') {
      ctx.ellipse(0, 0, 7, 3.4, 0, 0, Math.PI * 2);
      ctx.moveTo(-7, 0); ctx.lineTo(-7, 6);
      ctx.moveTo(7, 0); ctx.lineTo(7, 6);
      ctx.stroke();
    } else if (k === 'cloud') {
      ctx.arc(-4, 1, 3.4, 0, Math.PI * 2);
      ctx.arc(2, -1, 4, 0, Math.PI * 2);
      ctx.arc(6, 2, 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (k === 'queue') {
      for (let i = 0; i < 3; i++) {
        ctx.moveTo(-7, -4 + i * 4);
        ctx.lineTo(7, -4 + i * 4);
      }
      ctx.stroke();
    } else if (k === 'actor') {
      ctx.arc(0, -3, 3, 0, Math.PI * 2);
      ctx.moveTo(-4, 6);
      ctx.quadraticCurveTo(0, -1, 4, 6);
      ctx.stroke();
    } else {
      // chip: square with pin marks
      ctx.rect(-5, -5, 10, 10);
      ctx.moveTo(-8, -2); ctx.lineTo(-5, -2);
      ctx.moveTo(5, -2); ctx.lineTo(8, -2);
      ctx.moveTo(-8, 3); ctx.lineTo(-5, 3);
      ctx.moveTo(5, 3); ctx.lineTo(8, 3);
      ctx.stroke();
    }
    ctx.restore();
  }

  function fitText(c, text, maxPx) {
    if (c.measureText(text).width <= maxPx) return text;
    let t = text;
    while (t.length > 1 && c.measureText(t + '…').width > maxPx) t = t.slice(0, -1);
    return t + '…';
  }

  function recordHull(b, pts) {
    let minx = 1e9; let miny = 1e9; let maxx = -1e9; let maxy = -1e9;
    const poly = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const s = toScreen(pts[i]);
      poly[i] = s;
      minx = Math.min(minx, s.x); maxx = Math.max(maxx, s.x);
      miny = Math.min(miny, s.y); maxy = Math.max(maxy, s.y);
    }
    hulls.push({ id: b.id, poly, minx, miny, maxx, maxy });
  }

  // ---- base-layer copper -------------------------------------------------

  // Traces routed by Freerouting live on the board surface, so they are
  // painted right after the board and before the packages (which occlude
  // them, like real copper running under a component body). B.Cu hops are
  // drawn dimmer — the underside of the board.
  function drawRoutes(eff, view) {
    if (routeView.size === 0) return;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const focusActive = focusEdges.size > 0;
    const traceW = (scene.routes.traceW ?? 2) / cam.scale;
    for (const [idx, rv] of routeView) {
      const bd = rv.bounds;
      if (bd.maxx < view.minx || bd.minx > view.maxx || bd.maxy < view.miny || bd.miny > view.maxy) {
        continue; // net entirely outside the viewport
      }
      const e = scene.edges[idx];
      const isFocus = focusEdges.has(e);
      const pts = rv.pts;
      // traced nets stay at full alpha even when an endpoint is ghosted
      ctx.globalAlpha = isFocus ? 1 : ghostAlpha(e);
      // mask pass: one dark outline under the whole route
      strokePath(pts, COPPER_MASK, traceW + 2.4 / cam.scale);
      if (isFocus) {
        ctx.setLineDash([9 / cam.scale, 6 / cam.scale]);
        ctx.lineDashOffset = dashOffset / cam.scale;
        strokeGlow(pts, e.color ?? ACCENT, traceW * 1.2);
        ctx.setLineDash([]);
      } else {
        for (const run of rv.runs) {
          strokePath(run.pts, focusActive
            ? (run.layer === 0 ? COPPER_DIM : COPPER_DIM_B)
            : (run.layer === 0 ? COPPER : COPPER_B), traceW);
        }
      }
      drawRouteVias(rv);
      drawRoutePads(pts);
      drawRouteEnds(e, rv.raw, eff, isFocus);
      const lineColor = isFocus ? (e.color ?? ACCENT) : focusActive ? COPPER_DIM : COPPER;
      if (e.arrow || e.bidir) drawFlatArrow(pts[pts.length - 2], pts[pts.length - 1], lineColor);
      if (e.bidir) drawFlatArrow(pts[1], pts[0], lineColor);
      ctx.globalAlpha = 1;
    }
  }

  // Splits the chained segments into runs of consecutive same-layer segments
  // (projected). Segment rows are [x1, y1, x2, y2, layer]. Called once per
  // scene load; the result is camera-independent.
  function layerRuns(r) {
    const runs = [];
    let cur = null;
    for (const s of r.segs ?? []) {
      const layer = s[4] ?? 0;
      if (!cur || cur.layer !== layer) {
        cur = { layer, pts: [project(s[0], s[1], 0.3)] };
        runs.push(cur);
      }
      cur.pts.push(project(s[2], s[3], 0.3));
    }
    return runs;
  }

  function strokePath(pts, color, width) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  function strokeGlow(pts, color, width) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.shadowColor = color;
    ctx.shadowBlur = 7;
    strokePath(pts, color, width);
    ctx.restore();
  }

  function drawRouteVias(rv) {
    const rad = (scene.routes.viaR ?? 3) / cam.scale;
    for (const p of rv.viaPts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
      ctx.fillStyle = COPPER;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad * 0.45, 0, Math.PI * 2);
      ctx.fillStyle = VIA_HOLE;
      ctx.fill();
    }
  }

  function drawRoutePads(pts) {
    const rad = (scene.routes.padR ?? 3) / cam.scale;
    for (const p of [pts[0], pts[pts.length - 1]]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
      ctx.fillStyle = COPPER;
      ctx.fill();
      ctx.strokeStyle = COPPER_MASK;
      ctx.lineWidth = 0.8 / cam.scale;
      ctx.stroke();
    }
  }

  // Connection between a package and its landing pad: top-level packages
  // grow a short gull-wing lead, stacked dies drop a through-chip via (TSV)
  // straight down to the base layer (dashed leader while the stack is
  // exploded).
  function drawRouteEnds(e, r, eff, isFocus) {
    for (let k = 0; k < r.ends.length; k++) {
      const end = r.ends[k];
      const b = scene.byId.get(end.box);
      if (!b) continue;
      const pin = k === 0 ? e.fromPin : e.toPin;
      if (end.stacked) {
        // Per-package column pieces: each moves with its owner, dotted
        // leaders bridge the gaps that explosions open up.
        drawTsvDrop(b, pin, end.land, eff, isFocus);
      } else {
        const eEff = eff.get(end.box);
        const o = boxOrigin(b, eEff);
        const pw = pinWorld(b, o, pin);
        const top = project(pw.x, pw.y, pw.z);
        const bot = project(end.land[0], end.land[1], 0.3);
        ctx.strokeStyle = isFocus ? (e.color ?? ACCENT) : COPPER;
        ctx.lineWidth = 1.4 / cam.scale;
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(bot.x, bot.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(top.x, top.y, 1.3 / cam.scale, 0, Math.PI * 2);
        ctx.fillStyle = isFocus ? (e.color ?? ACCENT) : COPPER;
        ctx.fill();
      }
    }
  }

  // Per-package through-chip via (TSV). The connection from a stacked die
  // to its landing pad is one column at rest, drawn as pieces — one per
  // housing package down the chain — and each piece moves with its owner
  // (is explodable). Wherever neighbouring pieces separate, or the die's
  // pin separates from the top piece, a dotted leader bridges the gap.
  function drawTsvDrop(b, pin, land, eff, hi) {
    const spec = tsvSpec(tsvParams);
    const aL = spec.linerR * SQRT2;
    const aC = spec.coreR * SQRT2;
    const liner = hi ? [TSV_LINER_L_HI, TSV_LINER_D_HI] : [TSV_LINER_L, TSV_LINER_D];
    // landing annulus flat on the board + dark plated opening under the foot
    const pad = project(land[0], land[1], spec.zBase);
    ellipseFill(pad, spec.padR * SQRT2, COPPER, hi ? ACCENT : COPPER_MASK);
    ellipseFill(pad, (spec.linerR + 0.4) * SQRT2, VIA_HOLE, null);
    // ancestor chain, parent -> root (statically bounded walk)
    const chain = [];
    for (let cur = b, i = 0; cur.parentId && i < scene.boxes.length; i++) {
      cur = scene.byId.get(cur.parentId);
      if (!cur) break;
      chain.push(cur);
    }
    const pieces = tsvPieces(b, chain, spec.zBase);
    // pieces bottom-up: liner sleeve + core nub per piece; the nub of one
    // is absorbed by the piece above while the column stays assembled
    const info = [];
    for (const piece of pieces) {
      const o = eff.get(piece.id);
      const at = (z) => project(land[0] + o.dx, land[1] + o.dy, z + o.lift);
      const bot = at(piece.z0);
      const top = at(piece.z1);
      barrelBody(top, bot, aL, liner[0], liner[1]);
      ellipseRim(top, aL);                    // liner mouth
      const coreTop = at(piece.z1 + spec.nub);
      barrelBody(coreTop, bot, aC, TSV_CORE_L, TSV_CORE_D);
      ellipseFill(coreTop, aC, TSV_CORE_TOP, null); // fully lit top face
      ellipseRim(coreTop, aC);                // Cu core nub over the mouth
      info.push({ o, top, bot });
    }
    // dotted leaders across temporary disconnections, walking top-down:
    // die pin -> top piece, piece boundaries, root piece -> pad
    const dieO = eff.get(b.id);
    const pinW = pinWorld(b, boxOrigin(b, dieO), pin);
    let upper = { o: dieO, p: project(pinW.x, pinW.y, pinW.z) };
    for (let i = info.length - 1; i >= 0; i--) {
      const d = info[i];
      if (separated(upper.o, d.o)) drawDots(upper.p, d.top);
      upper = { o: d.o, p: d.bot };
    }
    if (separated(upper.o, ZERO_OFF)) drawDots(upper.p, pad);
  }

  // True when the two owners no longer share a position (epsilon absorbs
  // the tail of the ease animation, which never lands exactly).
  function separated(a, c) {
    return Math.abs(a.dx - c.dx) + Math.abs(a.dy - c.dy) + Math.abs(a.lift - c.lift) > 0.25;
  }

  // Dotted leader between two temporarily disconnected ends of a TSV
  // connection (accent tint — the explode/disconnect language).
  function drawDots(a, b) {
    ctx.save();
    ctx.strokeStyle = 'rgba(83, 227, 194, 0.85)';
    ctx.lineWidth = 1.3 / cam.scale;
    ctx.setLineDash([0.1 / cam.scale, 3.6 / cam.scale]); // round caps -> dots
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  // Flat horizontal disc: 2:1 ellipse (semi-x a) at projected point p.
  function ellipseFill(p, a, fill, stroke) {
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, a, a / 2, 0, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 0.8 / cam.scale;
      ctx.stroke();
    }
  }

  function ellipseRim(p, a) {
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, a, a / 2, 0, 0, Math.PI * 2);
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 0.9 / cam.scale;
    ctx.stroke();
  }

  // Cel-shaded cylinder silhouette between the projected top/bottom ellipse
  // centres (semi-x a): dark fill, light left half via clip, crisp outline.
  // Tolerates tilt (explode) — the terminator stays vertical, like the boxes.
  function barrelBody(top, bot, a, light, dark) {
    const b = a / 2;
    ctx.beginPath();
    ctx.ellipse(top.x, top.y, a, b, 0, Math.PI, 0); // upper half, left -> right
    ctx.lineTo(bot.x + a, bot.y);
    ctx.ellipse(bot.x, bot.y, a, b, 0, 0, Math.PI); // lower half, right -> left
    ctx.closePath();
    ctx.fillStyle = dark;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = light;
    ctx.fillRect((top.x + bot.x) / 2 - 1e4, top.y - 1e4, 1e4, 2e4);
    ctx.restore();
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 0.9 / cam.scale;
    ctx.stroke();
  }

  // Arrow head flat on the board plane (points are already projected).
  function drawFlatArrow(a, b, color) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const s = 8 / cam.scale;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - ux * s - uy * s * 0.5, b.y - uy * s + ux * s * 0.5);
    ctx.lineTo(b.x - ux * s + uy * s * 0.5, b.y - uy * s - ux * s * 0.5);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  // ---- edges -------------------------------------------------------------

  const NORMALS = PIN_NORMALS;

  function routePoints(e, byId, effMap) {
    const a = byId.get(e.fromId);
    const b = byId.get(e.toId);
    const ea = effMap.get(e.fromId);
    const eb = effMap.get(e.toId);
    const oa = boxOrigin(a, ea);
    const ob = boxOrigin(b, eb);
    if (e.self) return selfLoopPoints(a, oa);
    const pa = pinWorld(a, oa, e.fromPin);
    const pb = pinWorld(b, ob, e.toPin);
    const na = NORMALS[e.fromPin.face];
    const nb = NORMALS[e.toPin.face];
    const sa = { x: pa.x + na[0] * STUB, y: pa.y + na[1] * STUB, z: pa.z };
    const sb = { x: pb.x + nb[0] * STUB, y: pb.y + nb[1] * STUB, z: pb.z };
    const mid = { x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 };
    return [
      pa, sa,
      { x: mid.x, y: mid.y, z: sa.z },
      { x: mid.x, y: mid.y, z: sb.z },
      sb, pb,
    ];
  }

  function selfLoopPoints(b, o) {
    const cx = o.x + (b.w > 60 ? b.w - 34 : b.w / 2);
    const cy = o.y + b.d / 2;
    const z = o.z1 + 10;
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const th = (i / 24) * Math.PI * 2;
      pts.push({ x: cx + Math.cos(th) * 16, y: cy + Math.sin(th) * 16, z });
    }
    return pts;
  }

  function edgeFocusSet() {
    const id = selectedId;
    const set = new Set();
    if (!id) return set;
    for (const e of scene.edges) {
      if (e.fromId === id || e.toId === id) set.add(e);
    }
    return set;
  }

  function drawEdges(eff) {
    const lod = lodTier();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (lod.edgeLabels !== 'none') {
      for (const e of scene.edges) {
        // net labels are annotations too: only the selected package's
        // traced nets carry them, never the resting board
        if (e.hidden || !e.label || !focusEdges.has(e)) continue;
        drawEdgeLabel(e, eff);
      }
    }
    // routed edges are already on the base layer; only the airborne
    // fallback wires (self loops, unrouted, missing routes.json) remain
    for (const e of scene.edges) {
      if (e.hidden || e.routed || focusEdges.has(e)) continue;
      strokeRoute(e, eff, `rgba(${EDGE_DIM}, 0.50)`, 1.5 / cam.scale, false);
    }
    for (const e of focusEdges) {
      if (e.hidden || e.routed) continue;
      ctx.setLineDash([9 / cam.scale, 6 / cam.scale]);
      ctx.lineDashOffset = dashOffset / cam.scale;
      strokeRoute(e, eff, e.color ?? ACCENT, 2.2 / cam.scale, true, true);
      ctx.setLineDash([]);
    }
  }

  function strokeRoute(e, eff, color, width, glow, ignoreGhost) {
    const pts = routePoints(e, scene.byId, eff);
    const ga = ignoreGhost ? 1 : ghostAlpha(e);
    ctx.globalAlpha = ga;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = project(pts[i].x, pts[i].y, pts[i].z);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (glow) {
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 7;
      ctx.stroke();
      ctx.restore();
    }
    ctx.stroke();
    if (e.arrow || e.bidir) drawArrowHead(pts[pts.length - 2], pts[pts.length - 1], color);
    if (e.bidir) drawArrowHead(pts[1], pts[0], color);
    ctx.globalAlpha = 1;
  }

  function ghostAlpha(e) {
    const a = stateOf(e.fromId).ghost;
    const b = stateOf(e.toId).ghost;
    return Math.min(a, b) < 0.999 ? Math.min(a, b) : 1;
  }

  function drawArrowHead(from, to, color) {
    const a = project(from.x, from.y, from.z);
    const b = project(to.x, to.y, to.z);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const s = 8 / cam.scale;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - ux * s - uy * s * 0.5, b.y - uy * s + ux * s * 0.5);
    ctx.lineTo(b.x - ux * s + uy * s * 0.5, b.y - uy * s - ux * s * 0.5);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  function drawEdgeLabel(e, eff) {
    let m;
    const rv = e.routeIdx != null ? routeView.get(e.routeIdx) : null;
    if (rv) {
      m = rv.midPt;
    } else {
      const pts = routePoints(e, scene.byId, eff);
      m = pts[Math.floor(pts.length / 2) - 1] ?? pts[0];
    }
    const p = project(m.x, m.y, m.z);
    const first = (e.label ?? '').split('\n')[0];
    if (!first) return;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const w = ctx.measureText(first).width;
    const pad = 4 / cam.scale;
    const h = 16 / cam.scale;
    const isFocus = focusEdges.has(e);
    ctx.globalAlpha = isFocus ? 1 : 0.55;
    ctx.fillStyle = 'rgba(9, 13, 18, 0.85)';
    ctx.fillRect(p.x - w / 2 - pad, p.y - h / 2, w + 2 * pad, h);
    ctx.strokeStyle = isFocus ? (e.color ?? ACCENT) : `rgba(${EDGE_DIM},0.4)`;
    ctx.lineWidth = 1 / cam.scale;
    ctx.strokeRect(p.x - w / 2 - pad, p.y - h / 2, w + 2 * pad, h);
    ctx.fillStyle = isFocus ? '#d6e2eb' : 'rgba(200, 212, 224, 0.75)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(first, p.x, p.y);
    ctx.globalAlpha = 1;
  }

  // ---- notes -------------------------------------------------------------

  function drawNotes(eff) {
    if (!selectedId) return; // notes stay hidden until a package is clicked
    const lod = lodTier();
    if (lod.notes === 'none') return;
    for (const n of scene.notes) {
      // the selected package, its net neighbors, and floating notes
      if (n.targetId != null && n.targetId !== selectedId && !focusNets.has(n.targetId)) {
        continue;
      }
      let anchor;
      if (n.targetId) {
        const b = scene.byId.get(n.targetId);
        const e = eff.get(n.targetId);
        const ox = b.x + e.dx + b.w + 26;
        const oy = b.y + e.dy + b.d / 2;
        anchor = project(ox, oy, b.z1 + e.lift + 6);
      } else {
        anchor = project(60, scene.bounds.d - 60, 30);
      }
      drawNoteTag(n, anchor, lod);
    }
  }

  function drawNoteTag(n, anchor, lod) {
    const lines = lod.notes === 'full' ? n.lines : n.lines.slice(0, 1);
    if (lines.length === 0) return;
    const s = toScreen(anchor);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '11.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    let w = 0;
    for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
    const padX = 9;
    const lineH = 14;
    const wBox = w + padX * 2;
    const hBox = lines.length * lineH + 10;
    const x = s.x + 22;
    const y = s.y - hBox - 10;
    ctx.strokeStyle = 'rgba(255, 209, 102, 0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(x, y + hBox);
    ctx.stroke();
    ctx.fillStyle = 'rgba(23, 27, 34, 0.96)';
    ctx.fillRect(x, y, wBox, hBox);
    ctx.strokeRect(x, y, wBox, hBox);
    ctx.fillStyle = '#ffd166';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x + padX, y + 5 + i * lineH);
    }
    ctx.restore();
  }

  // ---- LOD ---------------------------------------------------------------

  function lodTier() {
    const s = cam.scale;
    // Low LOD: faces carry only the kind glyph (silk suppressed). From the
    // middle tier on, silkscreen takes over and glyphs are hidden. Edge
    // labels render only for the selected package's traced nets — the
    // resting board stays free of floating text.
    if (s < 0.3) return { silkDepth: -1, leafLines: 0, edgeLabels: 'none', notes: 'none', icons: true, stereo: false };
    if (s < 0.6) return { silkDepth: -1, leafLines: 0, edgeLabels: 'none', notes: 'none', icons: true, stereo: false };
    if (s < 1.2) return { silkDepth: 99, leafLines: 1, edgeLabels: 'focus', notes: 'collapsed', icons: false, stereo: false };
    return { silkDepth: 99, leafLines: 99, edgeLabels: 'focus', notes: 'full', icons: false, stereo: true };
  }

  // ---- hit testing -------------------------------------------------------

  function pointInPoly(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x; const yi = poly[i].y;
      const xj = poly[j].x; const yj = poly[j].y;
      if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  function hitTest(px, py) {
    for (let i = hulls.length - 1; i >= 0; i--) {
      const h = hulls[i];
      if (px < h.minx || px > h.maxx || py < h.miny || py > h.maxy) continue;
      if (pointInPoly(px, py, h.poly)) return h.id;
    }
    return null;
  }

  // ---- camera ------------------------------------------------------------

  function fit() {
    if (!scene || scene.boxes.length === 0) return;
    let minx = 1e9; let maxx = -1e9; let miny = 1e9; let maxy = -1e9;
    for (const b of scene.boxes) {
      const pts = [
        project(b.x, b.y + b.d, b.z1),   // iso x minimum
        project(b.x + b.w, b.y, b.z0),   // iso x maximum
        project(b.x, b.y, b.z1),         // iso y minimum
        project(b.x + b.w, b.y + b.d, b.z0), // iso y maximum
      ];
      for (const p of pts) {
        minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x);
        miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y);
      }
    }
    const pad = 30;
    const bw = maxx - minx + pad * 2;
    const bh = maxy - miny + pad * 2;
    cam.scale = Math.min(W / bw, H / bh, 4);
    cam.sx = (minx + maxx) / 2;
    cam.sy = (miny + maxy) / 2;
    if (cam.scale < 0.001) cam.scale = 0.001;
    needsDraw = true;
  }

  function zoomAt(px, py, factor) {
    const before = screenToIso(px, py);
    cam.scale = Math.max(0.05, Math.min(8, cam.scale * factor));
    const after = screenToIso(px, py);
    cam.sx += before.x - after.x;
    cam.sy += before.y - after.y;
    needsDraw = true;
  }

  // ---- frame loop --------------------------------------------------------

  // Capped at ~30 fps (a diagram is not a video game), and fully idle —
  // zero redraws — while nothing animates, moves or ticks.
  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (t - lastFrameT < FRAME_MIN_MS - 1.5) return;
    lastFrameT = t;
    const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
    lastT = t;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (cw !== W || ch !== H) {
      resize();
      fit();
    }
    if (!needsDraw && !animating() && focusEdges.size === 0) return;
    stepAnim(dt);
    const t0 = performance.now();
    draw();
    drawMs = drawMs * 0.9 + (performance.now() - t0) * 0.1;
    draws += 1;
    needsDraw = false;
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    needsDraw = true;
  }

  // ---- events ------------------------------------------------------------

  function updateHover(px, py) {
    const id = hitTest(px, py);
    if (id !== hoverId) {
      hoverId = id;
      if (hooks.onHover) {
        hooks.onHover(hoverPayload(px, py));
      }
    } else if (id && hooks.onHover) {
      hooks.onHover(hoverPayload(px, py));
    }
  }

  function hoverPayload(px, py) {
    if (!hoverId || !scene) return null;
    const b = scene.byId.get(hoverId);
    return {
      id: hoverId,
      kind: b.kind,
      lines: b.lines,
      stereotype: b.stereotype,
      x: px,
      y: py,
    };
  }

  canvas.addEventListener('pointermove', (ev) => {
    const r = canvas.getBoundingClientRect();
    pointer.x = ev.clientX - r.left;
    pointer.y = ev.clientY - r.top;
    if (dragging) {
      const dx = ev.clientX - dragging.startX;
      const dy = ev.clientY - dragging.startY;
      if (Math.hypot(dx, dy) > 4) dragging.moved = true;
      cam.sx = dragging.camSX - dx / cam.scale;
      cam.sy = dragging.camSY - dy / cam.scale;
      needsDraw = true;
      return;
    }
    updateHover(pointer.x, pointer.y);
  });

  canvas.addEventListener('pointerdown', (ev) => {
    const r = canvas.getBoundingClientRect();
    dragging = {
      startX: ev.clientX, startY: ev.clientY,
      camSX: cam.sx, camSY: cam.sy, moved: false,
      hitId: hitTest(ev.clientX - r.left, ev.clientY - r.top),
    };
    canvas.setPointerCapture(ev.pointerId);
  });

  canvas.addEventListener('pointerup', (ev) => {
    if (dragging && !dragging.moved) {
      applySelection(dragging.hitId); // click on empty space deselects
      if (hooks.onHover) hooks.onHover(hoverPayload(pointer.x, pointer.y));
    }
    dragging = null;
  });

  canvas.addEventListener('pointerleave', () => {
    if (hoverId) {
      hoverId = null;
      if (hooks.onHover) hooks.onHover(null);
    }
  });

  canvas.addEventListener('dblclick', () => fit());

  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = canvas.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const py = ev.clientY - r.top;
    zoomAt(px, py, Math.exp(-ev.deltaY * 0.0014));
    updateHover(px, py);
  }, { passive: false });

  window.addEventListener('resize', () => {
    resize();
  });

  // ---- public API --------------------------------------------------------

  resize();

  return {
    load(newScene) {
      scene = newScene;
      glyphFit = computeGlyphFit();
      anim.clear();
      hoverId = null;
      buildRouteView();
      applySelection(null);
      resize();
      fit();
      if (!raf) raf = requestAnimationFrame(frame);
    },
    fit,
    zoom(f) { zoomAt(W / 2, H / 2, f); },
    // Debug/scripted screenshots: center (and roughly zoom to) one package.
    focus(id) {
      const b = scene?.byId.get(id);
      if (!b) return;
      cam.scale = Math.max(0.4, Math.min(6, Math.min(W, H) / (Math.max(b.w, b.d) * 2.5)));
      const cx = b.x + b.w / 2;
      const cy = b.y + b.d / 2;
      cam.sx = isoX(cx, cy);
      cam.sy = isoY(cx, cy, 0); // pad level: die sits up-screen, barrels below
      needsDraw = true;
    },
    setTsvParams(p) { // partial update from the TSV lab panel / debug hook
      tsvParams = { ...tsvParams, ...p };
      needsDraw = true;
    },
    get tsvParams() { return { ...tsvParams }; },
    get scale() { return cam.scale; },
    get drawMs() { return drawMs; },
    get draws() { return draws; },
    debugHover(id) {
      hoverId = id;
    },
    debugSelect(id) {
      applySelection(id);
    },
    debugState() {
      const m = {};
      for (const [id, s] of anim) {
        if (s.tghost !== 1 || s.tlift !== 0 || s.tdx !== 0 || s.tdy !== 0) {
          m[id] = { ghost: +s.tghost.toFixed(2), lift: +s.tlift.toFixed(1), dxy: [+s.tdx.toFixed(1), +s.tdy.toFixed(1)] };
        }
      }
      m.__selected = selectedId;
      m.__focus = [...focusEdges].map((e) => `${e.fromId}->${e.toId}`);
      return m;
    },
  };
}
