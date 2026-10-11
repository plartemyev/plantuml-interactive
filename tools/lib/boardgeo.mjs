// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Pure geometry + formats for the PCB routing pipeline (no DOM, no IO).
//
// The board metaphor: the diagram is a two-layer PCB. Every element package
// sits on (or is PoP-stacked above) the board; its keepout covers the package
// outline on BOTH copper layers, so copper always routes around packages and
// never hides beneath them. Relations become nets; every net endpoint becomes
// a landing pad on the top copper (F.Cu — the visible "base" layer):
//
//   - top-level package: pad just outside the package outline (a SMD pad next
//     to the body); the renderer draws a short lead from the face pin to it.
//   - stacked package (a die on top of another die): pad directly below the
//     face pin, at board level. The signal reaches it through a vertical
//     through-chip via (TSV), so the package's keepout is cut an escape
//     corridor along the pin's face normal, out of the top-level ancestor's
//     outline.
//
// The autorouter may hop between F.Cu and B.Cu (board vias): the underside is
// rendered dimmer by the renderer, and layer changes read as classic PCB
// vias.

import { PIN_NORMALS, pinWorld } from '../../js/layout.js';

// Board scale: 1 world unit = 0.1 mm (KiCad side uses scaleNm per unit).
export const UNIT_MM = 0.1;
export const SCALE_NM = 100000; // nm per world unit (0.1 mm)

export const TRACE_W = 2;    // copper track width
export const CLEARANCE = 2;  // copper clearance
export const PAD_R = 3;      // landing pad radius (0.6 mm pad)
export const VIA_R = 3;      // via pad radius (0.6 mm / 0.3 mm drill)
export const CORRIDOR_W = 2 * (PAD_R + CLEARANCE) + 2; // TSV escape corridor

const EDGE_EXIT = PAD_R + CLEARANCE + 2; // how far past the outline corridors run

// ---- rectangle algebra ----------------------------------------------------

// Subtracts axis-aligned cuts from an axis-aligned rect. Returns a set of
// non-overlapping rect pieces covering (rect - cuts). Cuts are corridors that
// fully cross the rect, so a guillotine decomposition is exact.
export function subtractRects(rect, cuts) {
  let pieces = [rect];
  for (const cut of cuts) {
    const next = [];
    for (const p of pieces) next.push(...subtractOne(p, cut));
    pieces = next;
  }
  return pieces.filter((p) => p.x1 - p.x0 > 0.5 && p.y1 - p.y0 > 0.5);
}

function subtractOne(p, cut) {
  const ix0 = Math.max(p.x0, cut.x0);
  const ix1 = Math.min(p.x1, cut.x1);
  const iy0 = Math.max(p.y0, cut.y0);
  const iy1 = Math.min(p.y1, cut.y1);
  if (ix0 >= ix1 || iy0 >= iy1) return [p];
  const out = [];
  if (cut.x0 > p.x0) out.push({ x0: p.x0, y0: p.y0, x1: cut.x0, y1: p.y1 });
  if (cut.x1 < p.x1) out.push({ x0: cut.x1, y0: p.y0, x1: p.x1, y1: p.y1 });
  const mx0 = Math.max(ix0, p.x0);
  const mx1 = Math.min(ix1, p.x1);
  if (cut.y0 > p.y0) out.push({ x0: mx0, y0: p.y0, x1: mx1, y1: cut.y0 });
  if (cut.y1 < p.y1) out.push({ x0: mx0, y0: cut.y1, x1: mx1, y1: p.y1 });
  return out;
}

function normRect(x0, y0, x1, y1) {
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

function rectContains(r, x, y) {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

// ---- scene -> board spec --------------------------------------------------

export function buildBoardSpec(scene) {
  const byId = scene.byId;
  const rootOf = (id) => {
    let b = byId.get(id);
    while (b.parentId && byId.has(b.parentId)) b = byId.get(b.parentId);
    return b;
  };

  // TSV escape corridors, grouped by the top-level package they pierce.
  const corridors = new Map(); // rootId -> cut[]
  const addCorridor = (rootId, cut) => {
    if (!corridors.has(rootId)) corridors.set(rootId, []);
    corridors.get(rootId).push(cut);
  };

  const footprints = new Map(); // boxId -> {id, pads: []}
  const nets = new Map();       // "N<edgeIndex>" -> {index, name, pads: []}

  scene.edges.forEach((e, index) => {
    if (e.hidden || e.self) return;
    const name = `N${index}`;
    const net = { index, name, pads: [] };
    nets.set(name, net);

    for (const [endKey, pinKey] of [['from', 'fromPin'], ['to', 'toPin']]) {
      const b = byId.get(e[`${endKey}Id`]);
      const pin = e[pinKey];
      const o = { x: b.x, y: b.y, z0: b.z0, z1: b.z1 };
      const pw = pinWorld(b, o, pin);
      const n = PIN_NORMALS[pin.face];
      const stacked = !!b.parentId;
      let land;
      if (stacked) {
        // pad directly below the pin, on the base layer; the corridor runs
        // from just behind the pad, along the face normal, out of the
        // top-level ancestor's outline
        land = { x: pw.x, y: pw.y };
        const root = rootOf(b.id);
        const exitX = n[0] > 0 ? root.x + root.w + EDGE_EXIT
          : n[0] < 0 ? root.x - EDGE_EXIT : land.x;
        const exitY = n[1] > 0 ? root.y + root.d + EDGE_EXIT
          : n[1] < 0 ? root.y - EDGE_EXIT : land.y;
        const half = CORRIDOR_W / 2;
        addCorridor(root.id, normRect(
          land.x - n[0] * (PAD_R + CLEARANCE) - (n[1] !== 0 ? half : 0),
          land.y - n[1] * (PAD_R + CLEARANCE) - (n[0] !== 0 ? half : 0),
          exitX + (n[1] !== 0 ? half : 0),
          exitY + (n[0] !== 0 ? half : 0),
        ));
      } else {
        land = { x: pw.x + n[0] * (PAD_R + CLEARANCE), y: pw.y + n[1] * (PAD_R + CLEARANCE) };
      }
      const fpId = b.id;
      if (!footprints.has(fpId)) footprints.set(fpId, { id: fpId, x: b.x + b.w / 2, y: b.y + b.d / 2, pads: [] });
      const fp = footprints.get(fpId);
      net.pads.push({
        fpId,
        padName: String(fp.pads.length + 1),
        x: land.x,
        y: land.y,
      });
      fp.pads.push({ net: name, padName: String(fp.pads.length + 1), x: land.x, y: land.y });
    }
  });

  const keepouts = [];
  for (const b of scene.boxes) {
    if (b.parentId) continue;
    const cuts = corridors.get(b.id) ?? [];
    for (const piece of subtractRects(
      { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.d }, cuts,
    )) {
      keepouts.push([piece.x0, piece.y0, piece.x1, piece.y1]);
    }
  }

  return {
    scaleNm: SCALE_NM,
    traceW: TRACE_W,
    clearance: CLEARANCE,
    padD: 2 * PAD_R,
    viaD: 2 * VIA_R,
    viaDrill: VIA_R,
    board: { w: scene.bounds.w, d: scene.bounds.d },
    keepouts,
    footprints: [...footprints.values()],
    nets: [...nets.values()].map((n) => ({ name: n.name, index: n.index, pads: n.pads })),
  };
}

// ---- Specctra session (.ses) ----------------------------------------------

// Minimal s-expression parser: tokens are parenthesized lists and strings.
// Iterative (explicit stack) — no recursion, single pass with fixed bound.
export function parseSexpr(text) {
  const top = [];
  const stack = [top];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') {
      i++;
      const list = [];
      stack[stack.length - 1].push(list);
      stack.push(list);
      continue;
    }
    if (c === ')') {
      i++;
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (c === '"') {
      const j = text.indexOf('"', i + 1);
      const s = text.slice(i + 1, j === -1 ? n : j);
      i = j === -1 ? n : j + 1;
      stack[stack.length - 1].push(s);
      continue;
    }
    let j = i;
    while (j < n && !/[\s()]/.test(text[j])) j++;
    stack[stack.length - 1].push(text.slice(i, j));
    i = j;
  }
  return top;
}

function findChild(list, name) {
  for (const x of list) {
    if (Array.isArray(x) && x[0] === name) return x;
  }
  return null;
}

const UM_PER_INT = { um: (v) => v, mm: (v) => v * 1000, cm: (v) => v * 10000, mil: (v) => v * 0.0254, inch: (v) => v * 25.4 };

// Extracts routed geometry from a freerouting .ses file. Returns
// { nets: { name: { segments: [[x1,y1,x2,y2,layer],...], vias: [[x,y],...] } } }
// in world units (y axis flipped back from the DSN mirror). layer: 0 = F.Cu
// (base top copper), 1 = B.Cu (board underside).
export function sesToWorld(text) {
  const top = parseSexpr(text);
  const session = top.find((x) => Array.isArray(x));
  const routes = (session && findChild(session, 'routes'))
    ?? findChild(top, 'routes');
  if (!routes) return { nets: {} };
  let resDiv = 10;
  let resUnit = 'um';
  const netsOut = {};
  for (const item of routes) {
    if (!Array.isArray(item)) continue;
    if (item[0] === 'resolution') {
      resUnit = item[1];
      resDiv = Number(item[2]);
      continue;
    }
    if (item[0] !== 'network_out') continue;
    for (const net of item) {
      if (!Array.isArray(net) || net[0] !== 'net') continue;
      const name = net[1];
      const segments = [];
      const vias = [];
      collectNetGeometry(net, segments, vias);
      const toW = toWorld(resUnit, resDiv);
      netsOut[name] = {
        segments: segments.map(toW),
        vias: vias.map(toW),
      };
    }
  }
  return { nets: netsOut };
}

function layerIndex(name) {
  if (name === 'B.Cu') return 1;
  return 0; // F.Cu and anything unexpected land on the base top layer
}

function collectNetGeometry(net, segments, vias) {
  for (const wire of net) {
    if (!Array.isArray(wire)) continue;
    if (wire[0] === 'wire') {
      // (wire (path LAYER W x1 y1 x2 y2 ...) (path ...) (via ...))
      let last = null;
      for (const seg of wire) {
        if (!Array.isArray(seg)) continue;
        if (seg[0] === 'path') {
          const layer = layerIndex(seg[1]);
          const nums = seg.slice(3).map(Number); // path LAYER WIDTH x y x y ...
          for (let k = 0; k + 1 < nums.length; k += 2) {
            const p = [nums[k], nums[k + 1]];
            if (last && (last[0] !== p[0] || last[1] !== p[1])) {
              segments.push([last[0], last[1], p[0], p[1], layer]);
            }
            last = p;
          }
        } else if (seg[0] === 'arc') {
          // approximate arcs by their endpoints, chained like paths
          const layer = layerIndex(seg[1]);
          const nums = seg.slice(2).flat(Infinity)
            .filter((x) => typeof x === 'string' && /^-?[\d.]+$/.test(x)).map(Number);
          for (let k = 0; k + 1 < nums.length; k += 2) {
            const p = [nums[k], nums[k + 1]];
            if (last && (last[0] !== p[0] || last[1] !== p[1])) {
              segments.push([last[0], last[1], p[0], p[1], layer]);
            }
            last = p;
          }
        } else if (seg[0] === 'via') {
          const nums = seg.slice(1).map(Number).filter((v) => Number.isFinite(v));
          if (nums.length >= 2) vias.push([nums[0], nums[1]]);
        }
      }
    } else if (wire[0] === 'via') {
      const nums = wire.slice(1).map(Number).filter((v) => Number.isFinite(v));
      if (nums.length >= 2) vias.push([nums[0], nums[1]]);
    }
  }
}

function toWorld(unit, div) {
  const f = UM_PER_INT[unit] ?? UM_PER_INT.um;
  // world unit = 0.1 mm; y mirrored (KiCad y-down vs Specctra y-up);
  // trailing non-geometry fields (layer index) pass through untouched
  const tx = (v) => f(v / div) / 100;
  return (row) => row.map((v, i) => {
    if (i > 3) return v;
    return i % 2 === 0 ? tx(v) : -tx(v);
  });
}

// ---- chaining --------------------------------------------------------------

// Chains routed segments into one polyline from `startPt` towards `endPt`.
// Debris segments (the optimizer occasionally leaves disconnected stubs) are
// dropped; returns null only when the far pad is not reached (route broken).
// The ordered segment rows (with layer tags) are returned via the `segs`
// property on the returned point array.
export function chainSegments(segments, startPt, endPt) {
  const EPS = 0.01;
  const key = (p) => Math.round(p[0] * 100) + ':' + Math.round(p[1] * 100);
  const near = (a, b) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
  // degree of every point: dead-end detection steers the walk away from
  // optimizer debris stubs hanging off T-junctions
  const degree = new Map();
  for (const s of segments) {
    for (const p of [[s[0], s[1]], [s[2], s[3]]]) {
      degree.set(key(p), (degree.get(key(p)) ?? 0) + 1);
    }
  }
  const unused = segments.map((s) => s.slice());
  let cursor = startPt;
  const path = [[cursor[0], cursor[1]]];
  const segs = [];
  for (;;) {
    let found = -1;
    let flip = false;
    let fallback = -1;
    let fallbackFlip = false;
    for (let i = 0; i < unused.length; i++) {
      const s = unused[i];
      let isFlip = false;
      let other = null;
      if (near([s[0], s[1]], cursor)) { isFlip = false; other = [s[2], s[3]]; }
      else if (near([s[2], s[3]], cursor)) { isFlip = true; other = [s[0], s[1]]; }
      else continue;
      const reachesEnd = endPt && near(other, endPt);
      const deadEnd = (degree.get(key(other)) ?? 0) <= 1;
      if (reachesEnd || !deadEnd) {
        found = i; flip = isFlip; break;
      }
      if (fallback === -1) { fallback = i; fallbackFlip = isFlip; }
    }
    if (found === -1 && fallback !== -1) { found = fallback; flip = fallbackFlip; }
    if (found === -1) break; // debris or dead end: stop the walk here
    const s = unused.splice(found, 1)[0];
    segs.push(s);
    cursor = flip ? [s[0], s[1]] : [s[2], s[3]];
    path.push([cursor[0], cursor[1]]);
  }
  if (endPt && !near(cursor, endPt)) return null;
  path.segs = segs;
  return path;
}
