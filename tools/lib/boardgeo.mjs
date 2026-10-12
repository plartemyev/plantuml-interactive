// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Pure geometry + formats for the PCB routing pipeline (no DOM, no IO).
//
// The board metaphor: the diagram is a two-layer PCB. Every element package
// sits on (or is PoP-stacked above) the board. Relations become nets; every
// net endpoint becomes a landing pad on the top copper (F.Cu — the visible
// "base" layer):
//
//   - top-level package: pad just outside the package outline (a SMD pad next
//     to the body); the renderer draws a short lead from the face pin to it.
//   - stacked package (a die on top of another die): pad directly below the
//     face pin, at board level. The signal reaches it through a vertical
//     through-chip via (TSV).
//
// There are no routing keepouts: the autorouter is free to run copper where
// it likes, including under packages — the renderer's occluder ghosting and
// trace highlights keep hidden traces readable.
//
// The autorouter may hop between F.Cu and B.Cu (board vias): the underside is
// rendered dimmer by the renderer, and layer changes read as classic PCB
// vias.

import { PIN_NORMALS, pinWorld } from '../../js/layout.js';
import { TSV_DEFAULTS } from '../../js/tsv.js';

// Board scale: 1 world unit = 0.1 mm (KiCad side uses scaleNm per unit).
export const UNIT_MM = 0.1;
export const SCALE_NM = 100000; // nm per world unit (0.1 mm)

export const TRACE_W = 2;    // copper track width
export const CLEARANCE = 2;  // copper clearance
export const PAD_R = 3;      // landing pad radius (0.6 mm pad)
export const VIA_R = 3;      // via pad radius (0.6 mm / 0.3 mm drill)

// No-track zones covering what each TSV column hides of the board. The
// projection is orthographic along (1,1,1), so a board point is hidden
// behind a column exactly when it sits inside the column's screen band
// (|d(x-y)| <= linerR*sqrt(2)) up-screen of the pad, within the column
// height: a trace crossing that shadow reads as diving behind the column
// and plugging into its top. Each shadow becomes rule areas on both copper
// layers (tracks only; vias stay legal — the final hop to the SMD pad is
// always F.Cu), starting past the pad clearance so short 45° connection
// stubs stay legal. Where another landing pad sits inside the shadow, the
// strip resumes behind it, leaving only a half-band-wide window on that
// pad's own side: enough to connect it, while the covered half plus the
// pad's own clearance seal the shadow against hidden crossings.
const DIAG_S0 = PAD_R + CLEARANCE; // zone starts past the pad clearance
const DIAG_HALF = 3;               // zone half-width across the axis
const DIAG_MARGIN = 3;             // half-track + clearance past the shadow
const DIAG_WIN = 5;                // connection window around an in-band pad

function diagonalBlock(pad, s0, s1) {
  const corner = (s, u) => [
    pad.x + (-Math.SQRT1_2) * s + Math.SQRT1_2 * u,
    pad.y + (-Math.SQRT1_2) * s - Math.SQRT1_2 * u,
  ];
  return [
    corner(s0, DIAG_HALF), corner(s0, -DIAG_HALF),
    corner(s1, -DIAG_HALF), corner(s1, DIAG_HALF),
  ];
}

// s = up-screen distance along -(1,1)/sqrt(2), u = offset across it.
function buildNoTrackZones(allPads, stackedPads) {
  const zones = [];
  for (const sp of stackedPads) {
    const sMax = Math.max(DIAG_S0 + 8, Math.SQRT2 * (sp.z0 - TSV_DEFAULTS.zBase) + DIAG_MARGIN);
    const blockers = [];
    for (const q of allPads) {
      if (q === sp.pad) continue;
      const s = -((q.x - sp.pad.x) + (q.y - sp.pad.y)) / Math.SQRT2;
      const u = ((q.x - q.y) - (sp.pad.x - sp.pad.y)) / Math.SQRT2;
      if (s > DIAG_S0 - 1 && s < sMax && Math.abs(u) < DIAG_HALF + PAD_R + CLEARANCE) {
        blockers.push(s);
      }
    }
    blockers.sort((a, b) => a - b);
    let cur = DIAG_S0;
    for (const sb of blockers) {
      // full-width window: an in-shadow pad's own connection necessarily
      // traverses the shadow right at its plug-in point — that residual is
      // inherent and short — while anything crossing the window away from
      // the pads is pushed beside the barrel (|u| >= ~4, visible)
      if (sb - DIAG_WIN - cur >= 1) zones.push(diagonalBlock(sp.pad, cur, sb - DIAG_WIN));
      cur = Math.max(cur, sb + DIAG_WIN);
    }
    if (sMax - cur >= 1) zones.push(diagonalBlock(sp.pad, cur, sMax));
  }
  return zones;
}

// ---- scene -> board spec --------------------------------------------------

export function buildBoardSpec(scene) {
  const byId = scene.byId;

  const footprints = new Map(); // boxId -> {id, pads: []}
  const nets = new Map();       // "N<edgeIndex>" -> {index, name, pads: []}
  const allPads = [];           // every landing pad, for shadow truncation
  const stackedPads = [];       // {pad, z0}: TSV columns cast route shadows

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
      const land = stacked
        ? { x: pw.x, y: pw.y } // pad directly below the pin, on the base layer
        : { x: pw.x + n[0] * (PAD_R + CLEARANCE), y: pw.y + n[1] * (PAD_R + CLEARANCE) };
      allPads.push(land);
      if (stacked) stackedPads.push({ pad: land, z0: b.z0 });
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

  return {
    scaleNm: SCALE_NM,
    traceW: TRACE_W,
    clearance: CLEARANCE,
    padD: 2 * PAD_R,
    viaD: 2 * VIA_R,
    viaDrill: VIA_R,
    board: { w: scene.bounds.w, d: scene.bounds.d },
    noTrackZones: buildNoTrackZones(allPads, stackedPads),
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
