// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Deterministic "package-on-package" layout.
//
// World space: x/y = board plane, z = up. Children sit ON TOP of their parent
// package (stacked along z, like PoP chips); siblings are packed into a grid
// on the parent's top face. Output is a flat box list in painter order plus
// per-edge pin data (face + fraction) so the renderer can route wires.
//
// Pure module: no DOM, no canvas — unit-testable under Node.

import { wrapText } from './textutil.js';

export const M = {
  charW: 6.4,        // estimated average glyph width at font 13 (world units)
  lineH: 15,
  padX: 16, padTop: 11, padBottom: 13,
  minLeafW: 120, minLeafD: 56, hardMaxW: 430,
  maxLabelCols: 30, maxLines: 8,
  leafH: 14, boxH: 20, stackGap: 2,
  gridGap: 30, margin: 18, silkscreenD: 24,
  boardMargin: 48,
  targetAspect: 1.3,
  pinMin: 0.12, pinMax: 0.88,
};

// Body heights per element kind (leaf boxes).
const LEAF_H = {
  cloud: 10, database: 18, queue: 16, actor: 8, storage: 18,
};

const CONTAINER_KINDS = new Set(['frame', 'package', 'folder', 'node', 'cloud', 'rectangle', 'component', 'boundary', 'stack']);

export function isContainer(kind) {
  return CONTAINER_KINDS.has(kind);
}

function labelLines(el) {
  const raw = el.label == null ? el.id : el.label;
  return wrapText(raw, M.maxLabelCols, M.maxLines);
}

function boxHeight(kind, container) {
  if (container) return M.boxH;
  return LEAF_H[kind] ?? M.leafH;
}

// Grid packing: tries every column count, keeps the most balanced layout.
// Declaration order is preserved row-major; rows are centered horizontally.
export function packGrid(items) {
  const n = items.length;
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    let W = 0;
    const rowD = [];
    for (let r = 0; r < rows; r++) {
      const c0 = r * cols;
      const c1 = Math.min(n, (r + 1) * cols);
      let rw = 0;
      let rd = 0;
      for (let i = c0; i < c1; i++) {
        rw += items[i].w;
        rd = Math.max(rd, items[i].d);
      }
      rw += (c1 - c0 - 1) * M.gridGap;
      W = Math.max(W, rw);
      rowD.push(rd);
    }
    const D = rowD.reduce((a, b) => a + b, 0) + (rows - 1) * M.gridGap;
    const score = Math.abs(W / Math.max(D, 1) - M.targetAspect);
    if (!best || score < best.score) best = { cols, rows, W, D, rowD, score };
  }
  const pos = new Array(n);
  let y = 0;
  for (let r = 0; r < best.rows; r++) {
    const c0 = r * best.cols;
    const c1 = Math.min(n, (r + 1) * best.cols);
    let rw = 0;
    let rd = 0;
    for (let i = c0; i < c1; i++) {
      rw += items[i].w;
      rd = Math.max(rd, items[i].d);
    }
    rw += (c1 - c0 - 1) * M.gridGap;
    let x = (best.W - rw) / 2;
    for (let i = c0; i < c1; i++) {
      // center items vertically within the row band
      pos[i] = { x, y: y + (rd - items[i].d) / 2 };
      x += items[i].w + M.gridGap;
    }
    y += rd + M.gridGap;
  }
  return { W: best.W, D: best.D, pos };
}

function sizeBox(el, childrenBoxes) {
  const container = isContainer(el.kind) && childrenBoxes.length > 0;
  if (!container) {
    const lines = labelLines(el);
    let textW = 0;
    for (const l of lines) textW = Math.max(textW, l.length * M.charW);
    const w = Math.min(Math.max(textW + 2 * M.padX, M.minLeafW), M.hardMaxW);
    const d = Math.max(M.minLeafD, lines.length * M.lineH + M.padTop + M.padBottom);
    return { w, d, lines, container: false, grid: null };
  }
  const grid = packGrid(childrenBoxes);
  const w = grid.W + 2 * M.margin;
  const d = grid.D + 2 * M.margin + M.silkscreenD;
  return { w, d, lines: labelLines(el), container: true, grid };
}

export function buildScene(model) {
  const boxes = [];
  const byId = new Map();

  // BFS from roots (parents before children), skipping ports (they only
  // influence pin placement).
  const order = [];
  const queue = [];
  for (const id of model.rootOrder) {
    const el = model.elements.get(id);
    if (el && el.kind !== 'port') queue.push(id);
  }
  while (queue.length > 0) {
    const id = queue.shift();
    const el = model.elements.get(id);
    if (!el || byId.has(id)) continue;
    const depth = el.parent ? byId.get(el.parent).depth + 1 : 0;
    const node = { el, depth, children: [] };
    byId.set(id, node);
    order.push(id);
    for (const c of el.children) {
      const ce = model.elements.get(c);
      if (ce && ce.kind !== 'port') {
        queue.push(c);
        node.children.push(c);
      }
    }
  }

  // Sizes, deepest first.
  const sizes = new Map();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const node = byId.get(id);
    const childBoxes = node.children.map((c) => sizes.get(c)).filter(Boolean);
    const el = node.el;
    const container = isContainer(el.kind) && childBoxes.length > 0;
    const s = sizeBox(el, childBoxes);
    s.h = boxHeight(el.kind, s.container);
    sizes.set(id, s);
  }

  // Placement, parents first.
  const rootItems = model.rootOrder
    .filter((id) => byId.has(id))
    .map((id) => ({ id, ...sizes.get(id) }));
  const rootGrid = packGrid(rootItems);
  const positions = new Map();

  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    const node = byId.get(id);
    const s = sizes.get(id);
    const el = node.el;
    let x; let y; let z0;
    if (el.parent && positions.has(el.parent)) {
      const p = positions.get(el.parent);
      const slot = positions.get(el.parent).childSlots.get(id);
      x = p.x + M.margin + slot.x;
      y = p.y + M.margin + slot.y;
      z0 = p.z1 + M.stackGap;
    } else {
      const slot = rootGrid.pos[rootItems.findIndex((r) => r.id === id)];
      x = M.boardMargin + slot.x;
      y = M.boardMargin + slot.y;
      z0 = 0;
    }
    const box = {
      id, kind: el.kind, depth: node.depth,
      x, y, w: s.w, d: s.d, z0, z1: z0 + s.h,
      lines: s.lines, container: s.container,
      stereotype: el.stereotype,
      parentId: el.parent && positions.has(el.parent) ? el.parent : null,
      childSlots: s.container ? new Map() : null,
      titleLine: s.lines[0] ?? id,
    };
    if (s.container) {
      const childIds = node.children;
      childIds.forEach((cid, k) => box.childSlots.set(cid, s.grid.pos[k]));
    }
    positions.set(id, box);
    boxes.push(box);
  }

  // Pins: group relations per (element, face), spread fractions along the face.
  const centers = new Map();
  for (const b of boxes) centers.set(b.id, { cx: b.x + b.w / 2, cy: b.y + b.d / 2 });
  const pending = [];
  for (let i = 0; i < model.relations.length; i++) {
    const r = model.relations[i];
    const a = positions.get(r.fromId);
    const b = positions.get(r.toId);
    if (!a || !b) continue; // unresolved at parse time; parser warned
    pending.push({ r, a, b, i });
  }
  const groups = new Map();
  for (const p of pending) {
    if (p.r.self) continue;
    assignFace(p, centers);
    for (const end of ['a', 'b']) {
      const e = p[end];
      const key = e.box.id + ':' + e.face;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
  }
  for (const list of groups.values()) {
    list.sort((u, v) => u.cross - v.cross);
    for (let k = 0; k < list.length; k++) {
      list[k].t = M.pinMin + (M.pinMax - M.pinMin) * ((k + 1) / (list.length + 1));
    }
  }
  // Ports override the fraction with a slot derived from declaration order.
  for (const p of pending) {
    for (const end of ['a', 'b']) {
      const portId = end === 'a' ? p.r.fromPort : p.r.toPort;
      if (!portId) continue;
      const port = model.elements.get(portId);
      const host = positions.get(p[end].box.id);
      if (port && host && host.kind !== 'port' && port.portIndex >= 0) {
        const n = Math.max(host.ports ? host.ports.length : 1, port.portIndex + 1);
        p[end].t = M.pinMin + (M.pinMax - M.pinMin) * ((port.portIndex + 1) / (n + 1));
      }
    }
  }

  const edges = pending.map((p) => ({
    fromId: p.r.fromId, toId: p.r.toId,
    fromPin: { face: p.a.face, t: p.a.t },
    toPin: { face: p.b.face, t: p.b.t },
    label: p.r.label ?? null,
    dotted: p.r.dotted, hidden: p.r.hidden, arrow: p.r.arrow,
    bidir: p.r.bidir, color: p.r.color, self: !!p.r.self,
    line: p.r.line,
  }));

  const notes = model.notes.map((n) => ({
    targetId: n.target && positions.has(n.target) ? n.target : null,
    side: n.side ?? 'right',
    lines: wrapText(n.text ?? '', 34, 12),
  }));

  // Painter order: stacking level first, then depth along the view diagonal.
  boxes.sort((u, v) =>
    (u.z0 - v.z0)
    || ((u.x + u.w + u.y + u.d) - (v.x + v.w + v.y + v.d))
    || (u.depth - v.depth)
    || (u.id < v.id ? -1 : 1));

  let maxX = 0; let maxY = 0;
  for (const b of boxes) {
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.d);
  }
  return {
    boxes,
    byId: positions, // id -> placed box (with geometry)
    edges, notes,
    bounds: { w: maxX + M.boardMargin, d: maxY + M.boardMargin },
    stats: {
      elements: boxes.length,
      relations: edges.length,
      visibleRelations: edges.filter((e) => !e.hidden).length,
      notes: notes.length,
    },
  };
}

// Chooses which side face each endpoint's pin sits on (0:+x, 1:+y, 2:-x, 3:-y)
// and records the cross-axis coordinate used to spread pins later.
function assignFace(p, centers) {
  const ca = centers.get(p.a.id);
  const cb = centers.get(p.b.id);
  const dx = cb.cx - ca.cx;
  const dy = cb.cy - ca.cy;
  const fa = faceFor(dx, dy);
  const fb = faceFor(-dx, -dy);
  p.a = { box: p.a, face: fa, t: null, cross: crossCoord(fa, cb) };
  p.b = { box: p.b, face: fb, t: null, cross: crossCoord(fb, ca) };
}

function faceFor(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 0 : 2;
  return dy >= 0 ? 1 : 3;
}

function crossCoord(face, c) {
  return face === 0 || face === 2 ? c.cy : c.cx;
}
