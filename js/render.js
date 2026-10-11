// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Canvas 2D isometric renderer with "integrated circuit package" styling.
//
// - 2:1 dimetric projection, cel-shaded boxes (flat top/left/right shades)
// - nesting rendered as package-on-package stacking with corner TSV vias
// - hover: animated exploded view (children spread + lift, leaves pop up)
// - wheel over element: changes its opacity (ghosting); otherwise zooms
// - level-of-detail: labels/notes/edge labels appear by zoom tier
//
// Pure Canvas 2D + ES modules, no third-party code.

import { M } from './layout.js';

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

const STUB = 14;        // wire stub length leaving a package pin
const SPREAD = 42;      // in-plane explode distance for children
const LIFT_CHILD = 30;  // vertical explode lift for children
const LIFT_SELF = 12;   // hovered container pops slightly itself
const LIFT_LEAF = 38;   // hovered leaf pops off the board

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
  let focusEdges = new Set(); // edges of hovered/selected element, per frame
  let raf = 0;
  let lastT = 0;
  let dashOffset = 0;

  // ---- dynamic state -----------------------------------------------------

  function stateOf(id) {
    let s = anim.get(id);
    if (!s) {
      s = { dx: 0, dy: 0, lift: 0, ghost: 1, tdx: 0, tdy: 0, tlift: 0, tghost: 1 };
      anim.set(id, s);
    }
    return s;
  }

  // Recompute every explode target from scratch for the current hover.
  function retarget() {
    for (const s of anim.values()) {
      s.tdx = 0; s.tdy = 0; s.tlift = 0;
    }
    const id = hoverId ?? selectedId;
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
    focusEdges = edgeFocusSet();
    for (const b of scene.boxes) {
      const o = boxOrigin(b, eff.get(b.id));
      if (boxOutsideView(b, o, view)) continue;
      drawBox(b, o, eff, eff.get(b.id));
    }
    drawEdges(eff);
    drawNotes(eff);
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

  function drawBox(b, o, effMap, eff) {
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
    drawVias(b, o, effMap, eff);
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

  // TSV / through-chip vias: corner columns connecting a child package down
  // into its parent; dashed leaders appear while the stack is exploded.
  function drawVias(b, o, effMap, eff) {
    const parent = b.parentId ? scene.byId.get(b.parentId) : null;
    if (!parent) return;
    const pEff = effMap.get(b.parentId);
    const lifted = eff.lift - pEff.lift > 2 || pEff.lift > 2;
    const corners = [
      [o.x + 6, o.y + 6], [o.x + b.w - 6, o.y + 6],
      [o.x + 6, o.y + b.d - 6], [o.x + b.w - 6, o.y + b.d - 6],
    ];
    const pz1 = parent.z1 + pEff.lift;
    ctx.save();
    ctx.strokeStyle = lifted ? 'rgba(83, 227, 194, 0.85)' : 'rgba(10, 14, 18, 0.9)';
    ctx.lineWidth = (lifted ? 1.6 : 2.6) / cam.scale;
    if (lifted) ctx.setLineDash([5 / cam.scale, 4 / cam.scale]);
    ctx.beginPath();
    for (const [cx, cy] of corners) {
      const top = project(cx, cy, o.z0);
      const bot = project(cx, cy, pz1);
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bot.x, bot.y);
    }
    ctx.stroke();
    ctx.restore();
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

  // Tiny kind glyph in the top-right corner of the top face.
  function drawKindGlyph(b) {
    const k = b.kind;
    ctx.strokeStyle = 'rgba(7, 12, 16, 0.55)';
    ctx.fillStyle = 'rgba(7, 12, 16, 0.55)';
    ctx.lineWidth = 1.4;
    const gx = b.w - 18;
    const gy = 14;
    ctx.beginPath();
    if (k === 'database' || k === 'storage') {
      ctx.ellipse(gx, gy, 7, 3.4, 0, 0, Math.PI * 2);
      ctx.moveTo(gx - 7, gy); ctx.lineTo(gx - 7, gy + 6);
      ctx.moveTo(gx + 7, gy); ctx.lineTo(gx + 7, gy + 6);
      ctx.stroke();
    } else if (k === 'cloud') {
      ctx.arc(gx - 4, gy + 1, 3.4, 0, Math.PI * 2);
      ctx.arc(gx + 2, gy - 1, 4, 0, Math.PI * 2);
      ctx.arc(gx + 6, gy + 2, 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (k === 'queue') {
      for (let i = 0; i < 3; i++) {
        ctx.moveTo(gx - 7, gy - 4 + i * 4);
        ctx.lineTo(gx + 7, gy - 4 + i * 4);
      }
      ctx.stroke();
    } else if (k === 'actor') {
      ctx.arc(gx, gy - 3, 3, 0, Math.PI * 2);
      ctx.moveTo(gx - 4, gy + 6);
      ctx.quadraticCurveTo(gx, gy - 1, gx + 4, gy + 6);
      ctx.stroke();
    } else {
      // chip: square with pin marks
      ctx.rect(gx - 5, gy - 5, 10, 10);
      ctx.moveTo(gx - 8, gy - 2); ctx.lineTo(gx - 5, gy - 2);
      ctx.moveTo(gx + 5, gy - 2); ctx.lineTo(gx + 8, gy - 2);
      ctx.moveTo(gx - 8, gy + 3); ctx.lineTo(gx - 5, gy + 3);
      ctx.moveTo(gx + 5, gy + 3); ctx.lineTo(gx + 8, gy + 3);
      ctx.stroke();
    }
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

  // ---- edges -------------------------------------------------------------

  function pinWorld(b, o, pin) {
    const t = pin.t;
    const z = o.z0 + (o.z1 - o.z0) / 2;
    if (pin.face === 0) return { x: o.x + b.w, y: o.y + b.d * t, z, face: pin.face };
    if (pin.face === 1) return { x: o.x + b.w * t, y: o.y + b.d, z, face: pin.face };
    if (pin.face === 2) return { x: o.x, y: o.y + b.d * t, z, face: pin.face };
    return { x: o.x + b.w * t, y: o.y, z, face: pin.face };
  }

  const NORMALS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

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
    const id = hoverId ?? selectedId;
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
    dashOffset -= 0.55;
    if (lod.edgeLabels !== 'none') {
      for (const e of scene.edges) {
        if (e.hidden || !e.label) continue;
        if (!focusEdges.has(e) && lod.edgeLabels !== 'all') continue;
        drawEdgeLabel(e, eff);
      }
    }
    for (const e of scene.edges) {
      if (e.hidden || focusEdges.has(e)) continue;
      strokeRoute(e, eff, `rgba(${EDGE_DIM}, 0.50)`, 1.5 / cam.scale, false);
    }
    for (const e of focusEdges) {
      if (e.hidden) continue;
      ctx.setLineDash([9 / cam.scale, 6 / cam.scale]);
      ctx.lineDashOffset = dashOffset / cam.scale;
      strokeRoute(e, eff, e.color ?? ACCENT, 2.2 / cam.scale, true);
      ctx.setLineDash([]);
    }
  }

  function strokeRoute(e, eff, color, width, glow) {
    const pts = routePoints(e, scene.byId, eff);
    const ga = ghostAlpha(e);
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
    const pts = routePoints(e, scene.byId, eff);
    const m = pts[Math.floor(pts.length / 2) - 1] ?? pts[0];
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
    const lod = lodTier();
    if (lod.notes === 'none') return;
    for (const n of scene.notes) {
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
    if (s < 0.3) return { silkDepth: 0, leafLines: 0, edgeLabels: 'none', notes: 'none', icons: false, stereo: false };
    if (s < 0.6) return { silkDepth: 1, leafLines: 0, edgeLabels: 'none', notes: 'none', icons: false, stereo: false };
    if (s < 1.2) return { silkDepth: 99, leafLines: 1, edgeLabels: 'focus', notes: 'collapsed', icons: true, stereo: false };
    return { silkDepth: 99, leafLines: 99, edgeLabels: 'all', notes: 'full', icons: true, stereo: true };
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
  }

  function zoomAt(px, py, factor) {
    const before = screenToIso(px, py);
    cam.scale = Math.max(0.05, Math.min(8, cam.scale * factor));
    const after = screenToIso(px, py);
    cam.sx += before.x - after.x;
    cam.sy += before.y - after.y;
  }

  // ---- frame loop --------------------------------------------------------

  function frame(t) {
    const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
    lastT = t;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (cw !== W || ch !== H) {
      resize();
      fit();
    }
    stepAnim(dt);
    draw();
    raf = requestAnimationFrame(frame);
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
  }

  // ---- events ------------------------------------------------------------

  function updateHover(px, py) {
    const id = hitTest(px, py);
    if (id !== hoverId) {
      hoverId = id;
      retarget();
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
    const s = stateOf(hoverId);
    return {
      id: hoverId,
      kind: b.kind,
      lines: b.lines,
      stereotype: b.stereotype,
      ghost: s.ghost,
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
      selectedId = dragging.hitId; // click empty space clears selection
      retarget();
      if (hooks.onHover) hooks.onHover(hoverPayload(pointer.x, pointer.y));
    }
    dragging = null;
  });

  canvas.addEventListener('pointerleave', () => {
    if (hoverId) {
      hoverId = null;
      retarget();
      if (hooks.onHover) hooks.onHover(null);
    }
  });

  canvas.addEventListener('dblclick', () => fit());

  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = canvas.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const py = ev.clientY - r.top;
    const hit = hitTest(px, py);
    if (hit && !ev.ctrlKey) {
      const s = stateOf(hit);
      const step = ev.deltaY < 0 ? 0.1 : -0.1;
      s.tghost = Math.max(0.12, Math.min(1, s.tghost + step));
    } else {
      zoomAt(px, py, Math.exp(-ev.deltaY * 0.0014));
    }
    if (hooks.onHover) hooks.onHover(hoverPayload(px, py));
  }, { passive: false });

  window.addEventListener('resize', () => {
    resize();
  });

  // ---- public API --------------------------------------------------------

  resize();

  return {
    load(newScene) {
      scene = newScene;
      anim.clear();
      hoverId = null;
      selectedId = null;
      resize();
      fit();
      if (!raf) raf = requestAnimationFrame(frame);
    },
    fit,
    zoom(f) { zoomAt(W / 2, H / 2, f); },
    get scale() { return cam.scale; },
    debugHover(id) {
      hoverId = id;
      retarget();
    },
    debugGhost(id, v) {
      stateOf(id).tghost = Math.max(0.12, Math.min(1, v));
    },
    debugSelect(id) {
      selectedId = id;
      retarget();
    },
  };
}
