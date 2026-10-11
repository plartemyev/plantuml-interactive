// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Occlusion of board-level geometry (copper traces) by packages, in world
// plan coordinates. Pure module: no DOM, no canvas — unit-tested under Node.
//
// The 2:1 dimetric projection (isoX = x - y, isoY = (x + y) / 2 - z, painter
// order ascending z0 then x + y) looks along the +(1, 1, 1) diagonal. A board
// point p = (px, py, 0) is covered by a box silhouette exactly when the
// diagonal ray (px + z, py + z, z) pierces the box volume for some z, so a
// box's shadow on the board is its plan rectangle swept diagonally by
// (-z, -z) for z in [z0, z1] — a convex hexagon.

// Sweep hexagon of box b, in plan world coordinates.
export function occluderHex(b) {
  const s0 = b.z0;
  const s1 = b.z1;
  return [
    { x: b.x + b.w - s1, y: b.y - s1 },
    { x: b.x + b.w - s0, y: b.y - s0 },
    { x: b.x + b.w - s0, y: b.y + b.d - s0 },
    { x: b.x - s0, y: b.y + b.d - s0 },
    { x: b.x - s1, y: b.y + b.d - s1 },
    { x: b.x - s1, y: b.y - s1 },
  ];
}

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

function sign(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment(ax, ay, bx, by, px, py) {
  return Math.min(ax, bx) <= px && px <= Math.max(ax, bx)
    && Math.min(ay, by) <= py && py <= Math.max(ay, by);
}

function segSeg(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = sign(cx, cy, dx, dy, ax, ay);
  const d2 = sign(cx, cy, dx, dy, bx, by);
  const d3 = sign(ax, ay, bx, by, cx, cy);
  const d4 = sign(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
  if (d2 === 0 && onSegment(cx, cy, dx, dy, bx, by)) return true;
  if (d3 === 0 && onSegment(ax, ay, bx, by, cx, cy)) return true;
  if (d4 === 0 && onSegment(ax, ay, bx, by, dx, dy)) return true;
  return false;
}

// True when board-plane segment (a -> b) is covered by the sweep hexagon.
export function segmentOccluded(ax, ay, bx, by, hex) {
  if (pointInPoly(ax, ay, hex) || pointInPoly(bx, by, hex)) return true;
  for (let i = 0, j = hex.length - 1; i < hex.length; j = i++) {
    if (segSeg(ax, ay, bx, by, hex[j].x, hex[j].y, hex[i].x, hex[i].y)) return true;
  }
  return false;
}

// Ids of boxes whose board shadow covers any segment of any path.
// `paths` are arrays of [x, y] board points; excludeId (the selected box
// itself) is never reported.
export function findOccluders(boxes, paths, excludeId) {
  const out = new Set();
  for (const b of boxes) {
    if (b.id === excludeId) continue;
    const hex = occluderHex(b);
    let hit = false;
    for (const path of paths) {
      for (let i = 1; i < path.length && !hit; i++) {
        hit = segmentOccluded(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1], hex);
      }
      if (hit) break;
    }
    if (hit) out.add(b.id);
  }
  return out;
}
