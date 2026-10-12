// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parsePlantUml } from '../js/parser.js';
import { buildScene, packGrid, isContainer, pinWorld, PIN_NORMALS } from '../js/layout.js';
import { occluderHex, segmentPolyDistance } from '../js/occlude.js';

const model = (src) => parsePlantUml(src);

function rectOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.d && b.y < a.y + a.d;
}

test('packGrid picks a balanced grid and preserves declaration order', () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ w: 100, d: 60, id: i }));
  const g = packGrid(items);
  assert.equal(g.pos.length, 7);
  // 7 items at aspect ~1.3 → 3 columns / 3 rows is the expected optimum
  assert.equal(g.pos.length, 7);
  for (const p of g.pos) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
});

test('siblings never overlap and sit inside the parent footprint', () => {
  const m = model(`@startuml
node "vpc" as vpc {
  frame "a" as a {
    node a1
    node a2
    node a3
  }
  frame "b" as b {
    node b1
    node b2
  }
  node solo
}
`);
  const s = buildScene(m);
  const vpc = s.boxes.find((b) => b.id === 'vpc');
  const kids = s.boxes.filter((b) => b.parentId === 'vpc');
  for (let i = 0; i < kids.length; i++) {
    for (let j = i + 1; j < kids.length; j++) {
      assert.ok(!rectOverlap(kids[i], kids[j]), `overlap between ${kids[i].id} and ${kids[j].id}`);
    }
    assert.ok(kids[i].x >= vpc.x && kids[i].x + kids[i].w <= vpc.x + vpc.w, 'x containment');
    assert.ok(kids[i].y >= vpc.y && kids[i].y + kids[i].d <= vpc.y + vpc.d, 'y containment');
  }
});

test('children stack on top of parents (PoP z-order)', () => {
  const m = model(`@startuml
node outer {
  node inner {
    node core
  }
}
`);
  const s = buildScene(m);
  const outer = s.boxes.find((b) => b.id === 'outer');
  const inner = s.boxes.find((b) => b.id === 'inner');
  const core = s.boxes.find((b) => b.id === 'core');
  assert.ok(inner.z0 >= outer.z1);
  assert.ok(core.z0 >= inner.z1);
});

test('painter order places parents before children', () => {
  const m = model('@startuml\nnode a {\n  node b {\n    node c\n  }\n}\n');
  const s = buildScene(m);
  const idx = new Map(s.boxes.map((b, i) => [b.id, i]));
  for (const b of s.boxes) {
    if (b.parentId) assert.ok(idx.get(b.parentId) < idx.get(b.id));
  }
});

test('layout is deterministic', () => {
  const src = fs.readFileSync('samples/deployment.puml', 'utf8');
  const a = JSON.stringify(buildScene(model(src)));
  const b = JSON.stringify(buildScene(model(src)));
  assert.equal(a, b);
});

test('pins stay within face bounds and faces are valid', () => {
  const src = fs.readFileSync('samples/deployment.puml', 'utf8');
  const s = buildScene(model(src));
  for (const e of s.edges) {
    if (e.self) continue;
    for (const p of [e.fromPin, e.toPin]) {
      assert.ok(p.face >= 0 && p.face <= 3, 'face range');
      assert.ok(p.t > 0 && p.t < 1, 't range');
    }
  }
});

test('relations resolve through ports with deterministic slots', () => {
  const m = model(`@startuml
node "board" as b {
  port p1
  port p2
}
p2 --> other
`);
  const s = buildScene(m);
  const e = s.edges[0];
  assert.equal(e.fromId, 'b');
  assert.ok(e.fromPin.t > 0.5, 'second port sits further along the face');
});

test('sample diagram produces finite geometry for every box', () => {
  const src = fs.readFileSync('samples/deployment.puml', 'utf8');
  const s = buildScene(model(src));
  assert.equal(s.stats.elements, 47); // parser yields 47 elements, none are ports
  for (const b of s.boxes) {
    for (const v of [b.x, b.y, b.w, b.d, b.z0, b.z1]) {
      assert.ok(Number.isFinite(v), `${b.id} has finite ${v}`);
    }
    assert.ok(b.w > 0 && b.d > 0);
  }
  assert.ok(s.bounds.w > 0 && s.bounds.d > 0);
});

test('hidden relations are kept but flagged', () => {
  const m = model('@startuml\na -[hidden]-> b\n');
  const s = buildScene(m);
  assert.equal(s.edges.length, 1);
  assert.equal(s.edges[0].hidden, true);
  assert.equal(s.stats.visibleRelations, 0);
});

test('container detection matches deployment vocabulary', () => {
  for (const k of ['frame', 'package', 'node', 'cloud']) assert.ok(isContainer(k));
  assert.ok(!isContainer('database'));
});

test('stacked leaf pins escape body shadows so the connection stays readable', () => {
  const m = model(`@startuml
node vpc {
  frame subnet {
    database pg
    queue jobs
  }
}
jobs --> pg : poll
`);
  const s = buildScene(m);
  const e = s.edges.find((x) => x.fromId === 'jobs' && x.toId === 'pg');
  assert.ok(e, 'poll edge exists');
  const jobs = s.byId.get('jobs');
  const pg = s.byId.get('pg');
  assert.ok(jobs.parentId && pg.parentId, 'both stacked');
  const pad = (b, pin) => pinWorld(b, b, pin);
  const a = pad(jobs, e.fromPin);
  const b = pad(pg, e.toPin);
  // neither landing pad may hug its own body's sweep shadow and the straight
  // pad-to-pad run must keep real clearance from both bodies (occlude.js
  // distances: non-occluded alone still reads as glued to the edge)
  for (const [box, p] of [[jobs, a], [pg, b]]) {
    const hex = occluderHex(box);
    const d = segmentPolyDistance(p.x, p.y, p.x + 0.01, p.y + 0.01, hex);
    assert.ok(d >= 8, `${box.id} pad only ${d.toFixed(1)} from its own body shadow`);
  }
  const runJobs = segmentPolyDistance(a.x, a.y, b.x, b.y, occluderHex(jobs));
  const runPg = segmentPolyDistance(a.x, a.y, b.x, b.y, occluderHex(pg));
  assert.ok(runJobs >= 8, `poll run only ${runJobs.toFixed(1)} from jobs body`);
  assert.ok(runPg >= 8, `poll run only ${runPg.toFixed(1)} from pg body`);
});

test('de-shadow pass never moves port pins', () => {
  const m = model(`@startuml
node vpc {
  node peer
  node hub {
    portin pin1
  }
  peer --> pin1
}
`);
  const s = buildScene(m);
  const e = s.edges.find((x) => x.toId === 'hub');
  assert.ok(e, 'relation resolves to the hub');
  // single declared port keeps its spread-formula slot (0.12 + 0.76 * 1/2)
  assert.equal(e.toPin.t, 0.5);
});

test('landing pads of different nets keep clearance after de-shadow', () => {
  const src = fs.readFileSync('samples/deployment.puml', 'utf8');
  const s = buildScene(model(src));
  const pads = [];
  s.edges.forEach((e, i) => {
    if (e.self) return;
    for (const [id, pin] of [[e.fromId, e.fromPin], [e.toId, e.toPin]]) {
      const pos = s.byId.get(id);
      const pw = pinWorld(pos, pos, pin);
      const n = PIN_NORMALS[pin.face];
      pads.push({
        net: i,
        x: pos.parentId ? pw.x : pw.x + n[0] * 5,
        y: pos.parentId ? pw.y : pw.y + n[1] * 5,
      });
    }
  });
  for (let i = 0; i < pads.length; i++) {
    for (let j = i + 1; j < pads.length; j++) {
      if (pads[i].net === pads[j].net) continue; // same net pads may touch
      const d2 = (pads[i].x - pads[j].x) ** 2 + (pads[i].y - pads[j].y) ** 2;
      assert.ok(d2 >= 8.5 * 8.5,
        `pads ${i} and ${j} (nets ${pads[i].net}/${pads[j].net}) are ${Math.sqrt(d2).toFixed(2)} apart`);
    }
  }
});
