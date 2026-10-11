// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Unit tests for the PCB routing geometry (tools/lib/boardgeo.mjs): board
// spec construction (pads, TSV corridors, keepouts) and Specctra .ses
// parsing/chaining. Pure modules — no DOM, runs under `node --test`.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBoardSpec, subtractRects, sesToWorld, chainSegments,
  PAD_R, CLEARANCE, CORRIDOR_W,
} from '../tools/lib/boardgeo.mjs';

// -- fixtures ---------------------------------------------------------------

function fakeScene() {
  // two top-level packages; pkg2 holds one stacked child (z on top of pkg2)
  const boxes = [
    { id: 'pkg1', kind: 'node', parentId: null, x: 100, y: 100, w: 200, d: 100, z0: 0, z1: 20 },
    { id: 'pkg2', kind: 'node', parentId: null, x: 500, y: 150, w: 180, d: 120, z0: 0, z1: 20 },
    { id: 'die', kind: 'component', parentId: 'pkg2', x: 540, y: 190, w: 100, d: 60, z0: 22, z1: 36 },
  ];
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const edges = [
    // pkg1 -> pkg2: both top-level
    { fromId: 'pkg1', toId: 'pkg2', fromPin: { face: 0, t: 0.5 }, toPin: { face: 2, t: 0.5 } },
    // pkg2 -> die (stacked child): TSV
    { fromId: 'pkg2', toId: 'die', fromPin: { face: 1, t: 0.5 }, toPin: { face: 2, t: 0.5 } },
    // hidden + self must be skipped
    { fromId: 'pkg1', toId: 'pkg2', fromPin: { face: 0, t: 0.2 }, toPin: { face: 2, t: 0.2 }, hidden: true },
    { fromId: 'pkg1', toId: 'pkg1', fromPin: { face: 0, t: 0.4 }, toPin: { face: 0, t: 0.6 }, self: true },
  ];
  return {
    boxes, byId, edges,
    bounds: { w: 800, d: 400 },
  };
}

// -- subtractRects ----------------------------------------------------------

test('subtractRects: corridor crossing fully along x splits into two pieces', () => {
  const pieces = subtractRects(
    { x0: 0, y0: 0, x1: 100, y1: 50 },
    [{ x0: 40, y0: -10, x1: 60, y1: 60 }],
  );
  assert.equal(pieces.length, 2);
  const area = pieces.reduce((a, p) => a + (p.x1 - p.x0) * (p.y1 - p.y0), 0);
  assert.equal(area, 100 * 50 - 20 * 50);
});

test('subtractRects: multiple cuts are exact and non-overlapping', () => {
  const pieces = subtractRects(
    { x0: 0, y0: 0, x1: 100, y1: 100 },
    [
      { x0: 45, y0: -5, x1: 55, y1: 105 },
      { x0: -5, y0: 20, x1: 105, y1: 30 },
    ],
  );
  const area = pieces.reduce((a, p) => a + (p.x1 - p.x0) * (p.y1 - p.y0), 0);
  // 10000 - vertical strip (10*100) - horizontal strip (90*10 of the rest)
  assert.equal(area, 10000 - 1000 - 900);
});

test('subtractRects: non-crossing cut is trimmed conservatively', () => {
  // corridor not reaching the edges still removes its intersection
  const pieces = subtractRects(
    { x0: 0, y0: 0, x1: 100, y1: 100 },
    [{ x0: 40, y0: 40, x1: 60, y1: 60 }],
  );
  const area = pieces.reduce((a, p) => a + (p.x1 - p.x0) * (p.y1 - p.y0), 0);
  assert.equal(area, 10000 - 20 * 20);
});

// -- buildBoardSpec ---------------------------------------------------------

test('buildBoardSpec: every visible non-self relation becomes a two-pad net', () => {
  const spec = buildBoardSpec(fakeScene());
  assert.equal(spec.nets.length, 2);
  for (const net of spec.nets) {
    assert.equal(net.pads.length, 2);
  }
  assert.deepEqual(spec.nets.map((n) => n.index), [0, 1]);
});

test('buildBoardSpec: top-level pads sit outside their package outline', () => {
  const spec = buildBoardSpec(fakeScene());
  const net = spec.nets[0]; // pkg1 -> pkg2
  const pkg1 = { x0: 100, y0: 100, x1: 300, y1: 200 };
  const pad = net.pads[0];
  const dist = pad.x - pkg1.x1; // face 0 => +x side
  assert.ok(dist >= PAD_R + CLEARANCE - 1e-9, `pad ${dist} units outside outline`);
});

test('buildBoardSpec: stacked pad is directly below the die pin and escapes', () => {
  const spec = buildBoardSpec(fakeScene());
  const net = spec.nets[1]; // pkg2 -> die
  const die = { x: 540, y: 190, w: 100, d: 60 };
  const pad = net.pads[1];
  // pin face 2 (-x) at t=0.5: pin at (540, 190 + 30) => pad right below it
  assert.equal(pad.x, die.x);
  assert.equal(pad.y, die.y + die.d * 0.5);
  // the corridor must cut the whole pkg2 outline open along -x from the pad:
  // no keepout piece may cover the pad or the escape path outside the outline
  const pkg2 = { x0: 500, y0: 150, x1: 680, y1: 270 };
  const probe = [
    [pad.x, pad.y],
    [pad.x - CORRIDOR_W, pad.y],
    [pkg2.x0 - PAD_R, pad.y],
  ];
  for (const [x, y] of probe) {
    for (const [kx0, ky0, kx1, ky1] of spec.keepouts) {
      const inside = x > kx0 && x < kx1 && y > ky0 && y < ky1;
      assert.ok(!inside, `escape point ${x},${y} must be clear of keepouts`);
    }
  }
});

test('buildBoardSpec: keepouts cover the top-level outlines elsewhere', () => {
  const spec = buildBoardSpec(fakeScene());
  // pkg1 has no stacked children: it must appear fully as keepout(s)
  const pkg1Area = 200 * 100;
  let pkg1Covered = 0;
  for (const [x0, y0, x1, y1] of spec.keepouts) {
    if (x0 >= 100 && x1 <= 300 && y0 >= 100 && y1 <= 200) {
      pkg1Covered += (x1 - x0) * (y1 - y0);
    }
  }
  assert.equal(pkg1Covered, pkg1Area);
});

// -- Specctra session -------------------------------------------------------

test('sesToWorld: parses freerouting session with resolution and y mirror', () => {
  const ses = `(session probe
    (base_design probe)
    (routes
      (resolution um 10)
      (network_out
        (net N0
          (wire
            (path F.Cu 2000
              670000 -200000
              660000 -200000
            )
          )
          (wire
            (path F.Cu 2000
              130000 -200000
              140000 -200000
            )
            (path B.Cu 2000
              140000 -200000
              150000 -190000
            )
          )
          (via "Via[0-1]_600:300_um" 400000 -100000)
        )
      )
    )
  )`;
  const { nets } = sesToWorld(ses);
  const n0 = nets.N0;
  // world units: 0.1 mm each; y mirrored. 670000/10/100 = 670; layer 0 = F.Cu
  assert.deepEqual(n0.segments, [
    [670, 200, 660, 200, 0],
    [130, 200, 140, 200, 0],
    [140, 200, 150, 190, 1],
  ]);
  assert.deepEqual(n0.vias, [[400, 100]]);
});

test('chainSegments: orders a routed path from the start pad', () => {
  const path = chainSegments(
    [
      [5, 0, 8, 0],
      [0, 0, 2, 0],
      [2, 0, 5, 0],
    ],
    [0, 0],
    [8, 0],
  );
  assert.deepEqual([...path], [[0, 0], [2, 0], [5, 0], [8, 0]]);
  assert.deepEqual(path.segs.map((s) => [s[0], s[1], s[2], s[3]]), [
    [0, 0, 2, 0],
    [2, 0, 5, 0],
    [5, 0, 8, 0],
  ]);
});

test('chainSegments: drops debris but still reaches the far pad', () => {
  const path = chainSegments(
    [
      [0, 0, 4, 0],
      [4, 0, 8, 0],
      [4, 0, 4, 5], // stub hanging off the T-junction at (4,0)
    ],
    [0, 0],
    [8, 0],
  );
  assert.deepEqual([...path], [[0, 0], [4, 0], [8, 0]]);
});

test('chainSegments: returns null for broken chains', () => {
  assert.equal(chainSegments([[0, 0, 1, 0], [5, 5, 6, 5]], [0, 0], [6, 5]), null);
});
