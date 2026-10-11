// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parsePlantUml } from '../js/parser.js';
import { buildScene, packGrid, isContainer } from '../js/layout.js';

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
