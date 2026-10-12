// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Unit tests for the PCB routing geometry (tools/lib/boardgeo.mjs): board
// spec construction (pads) and Specctra .ses parsing/chaining. Pure modules —
// no DOM, runs under `node --test`.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBoardSpec, sesToWorld, chainSegments,
  PAD_R, CLEARANCE,
} from '../tools/lib/boardgeo.mjs';
import { TSV_DEFAULTS } from '../js/tsv.js';

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

test('buildBoardSpec: stacked pad is directly below the die pin', () => {
  const spec = buildBoardSpec(fakeScene());
  const net = spec.nets[1]; // pkg2 -> die
  const die = { x: 540, y: 190, w: 100, d: 60 };
  const pad = net.pads[1];
  // pin face 2 (-x) at t=0.5: pin at (540, 190 + 30) => pad right below it
  assert.equal(pad.x, die.x);
  assert.equal(pad.y, die.y + die.d * 0.5);
});

test('buildBoardSpec: stacked pads get a no-track zone covering the column shadow', () => {
  const spec = buildBoardSpec(fakeScene());
  // only the die endpoint is stacked -> exactly one zone, behind its pad
  assert.equal(spec.noTrackZones.length, 1);
  const pad = spec.nets[1].pads[1]; // (540, 220); the die sits at z0 = 22
  const ups = spec.noTrackZones[0].map(([x, y]) => (pad.x + pad.y) - (x + y));
  // nearest edge past the pad clearance, farthest past the column top: the
  // shadow of a column of height h spans 2*h of x+y up-screen of the pad
  assert.ok(Math.min(...ups) > 6, `zone touches the pad: ${Math.min(...ups)}`);
  assert.ok(Math.max(...ups) >= 2 * (22 - TSV_DEFAULTS.zBase),
    `zone shorter than the shadow: ${Math.max(...ups)}`);
  for (const [x, y] of spec.noTrackZones[0]) {
    // within a slim band around the column axis (isoX = x - y)
    assert.ok(Math.abs((x - y) - (pad.x - pad.y)) <= 4.3, `corner ${x},${y} off the axis band`);
    // never inside the pad clearance
    const dist = Math.hypot(x - pad.x, y - pad.y);
    assert.ok(dist >= PAD_R + CLEARANCE - 0.1, `corner ${x},${y} inside pad clearance`);
  }
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
