// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occluderHex, segmentOccluded, findOccluders } from '../js/occlude.js';

// A box at plan [100..140] x [100..140], standing z 0..30.
const BOX = { id: 'b', x: 100, y: 100, w: 40, d: 40, z0: 0, z1: 30 };
const HEX = occluderHex(BOX);

test('sweep hexagon covers the floor behind the box, not beside it', () => {
  // 25 units diagonally behind the box: covered (px + z in rect for z=25)
  assert.equal(pointInside(115, 115), true);
  // the box footprint itself: covered
  assert.equal(pointInside(120, 120), true);
  // far in front (larger x+y): uncovered
  assert.equal(pointInside(200, 200), false);
  // laterally beside the sweep: uncovered
  assert.equal(pointInside(160, 100), false);
  // behind but off the diagonal band: uncovered
  assert.equal(pointInside(60, 120), false);
});

function pointInside(px, py) {
  return segmentOccluded(px, py, px + 0.001, py + 0.001, HEX);
}

test('segment occlusion: crossing, endpoint-inside, collinear overlap, miss', () => {
  const behind = (p) => segmentOccluded(p[0], p[1], p[2], p[3], HEX);
  // segment passing fully behind the box
  assert.equal(behind([80, 130, 80, 30]), true);
  // segment ending inside the hexagon
  assert.equal(behind([90, 90, 115, 115]), true);
  // collinear overlap with a hexagon edge (y = 100 run from 70 to 110)
  assert.equal(behind([75, 100, 90, 100]), true);
  // segment entirely in the open, in front of the box
  assert.equal(behind([180, 180, 260, 120]), false);
  // segment behind but not reaching the diagonal band
  assert.equal(behind([0, 0, 40, 40]), false);
});

test('findOccluders reports every covering box, skips the excluded one', () => {
  const boxes = [
    BOX,
    { id: 'stacked', x: 120, y: 120, w: 20, d: 20, z0: 32, z1: 46 }, // above BOX
    { id: 'far', x: 400, y: 400, w: 30, d: 30, z0: 0, z1: 20 },
  ];
  const paths = [[[90, 130], [90, 30]]]; // runs behind BOX and 'stacked'
  const occ = findOccluders(boxes, paths, null);
  assert.deepEqual([...occ].sort(), ['b', 'stacked']);
  const occEx = findOccluders(boxes, paths, 'b');
  assert.deepEqual([...occEx], ['stacked']);
  assert.equal(findOccluders(boxes, [[[500, 500], [600, 500]]], null).size, 0);
});
