// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlantUml } from '../js/parser.js';

test('parses nested containers with labels, aliases and \\n escapes', () => {
  const src = `@startuml demo
node "VPC 10.0.0.0/16\\nunit: network" as vpc {
  frame "public subnets" as pub {
    node "NAT gateway (1)" as nat
  }
}
cloud "Internet" as net
`;
  const m = parsePlantUml(src);
  assert.equal(m.name, 'demo');
  assert.deepEqual(m.rootOrder, ['vpc', 'net']);
  const vpc = m.elements.get('vpc');
  assert.equal(vpc.label, 'VPC 10.0.0.0/16\nunit: network');
  assert.deepEqual(vpc.children, ['pub']);
  assert.deepEqual(m.elements.get('pub').children, ['nat']);
  assert.equal(m.elements.get('nat').parent, 'pub');
});

test('label without alias becomes referenceable by label text', () => {
  const src = `@startuml
node "RDS app-db" as rds
rds --> "RDS app-db"
`;
  const m = parsePlantUml(src);
  const r = m.relations[0];
  assert.equal(r.fromId, 'rds');
  assert.equal(r.toId, 'rds');
});test('bare alias form and block opened on the next line', () => {
  const src = `@startuml
node ecs
{
  node web
}
`;
  const m = parsePlantUml(src);
  assert.deepEqual(m.rootOrder, ['ecs']);
  assert.deepEqual(m.elements.get('ecs').children, ['web']);
});

test('relation arrow variants', () => {
  const src = `@startuml
a --> b : solid
c ..> d : dotted
e -- f
g .. h
i -[hidden]-> j
k -up-> l : hint
m ..> m
`;
  const m = parsePlantUml(src);
  const r = Object.fromEntries(m.relations.map((x) => [x.from + x.to, x]));
  assert.equal(r.ab.dotted, false);
  assert.equal(r.cd.dotted, true);
  assert.equal(r.ef.arrow, false);
  assert.equal(r.gh.dotted, true);
  assert.equal(r.ij.hidden, true);
  assert.equal(r.kl.dir, 'up');
  assert.equal(r.mm.self, true);
});

test('unknown aliases are auto-created as actors with a warning', () => {
  const src = `@startuml
known --> mystery : 443
`;
  const m = parsePlantUml(src);
  assert.equal(m.elements.get('mystery').kind, 'actor');
  assert.ok(m.warnings.some((w) => w.message.includes('mystery')));
});

test('multi-line block note and inline note', () => {
  const src = `@startuml
node a
note right of a
  line one
  line two
end note
node b
note left of b: inline text
`;
  const m = parsePlantUml(src);
  assert.equal(m.notes.length, 2);
  assert.equal(m.notes[0].target, 'a');
  assert.equal(m.notes[0].text, 'line one\nline two');
  assert.equal(m.notes[1].side, 'left');
  assert.equal(m.notes[1].text, 'inline text');
});

test('floating note as N attaches via relation', () => {
  const src = `@startuml
a --> b
note as N1
  floating
end note
N1 ..> b
`;
  const m = parsePlantUml(src);
  assert.equal(m.notes[0].target, 'b');
  assert.equal(m.notes[0].text, 'floating');
});

test('comments, skinparams and pragmas are ignored without warnings', () => {
  const src = `@startuml
' full line comment
/' block
   comment '/
skinparam backgroundColor white
!pragma layout smetana
hide empty members
node a
`;
  const m = parsePlantUml(src);
  assert.deepEqual(m.rootOrder, ['a']);
  assert.equal(m.warnings.length, 0);
});

test('ports attach to their container and relations resolve through them', () => {
  const src = `@startuml
node "board" as b {
  portin p1
  port p2
}
p2 --> c : via port
`;
  const m = parsePlantUml(src);
  const b = m.elements.get('b');
  assert.deepEqual(b.ports, ['p1', 'p2']);
  const r = m.relations[0];
  assert.equal(r.fromPort, 'p2');
  assert.equal(r.fromId, 'b');
});

test('together blocks are transparent', () => {
  const src = `@startuml
node box {
  together {
    card x
    card y
  }
}
`;
  const m = parsePlantUml(src);
  assert.deepEqual(m.elements.get('box').children, ['x', 'y']);
});

test('quoted labels may span physical lines', () => {
  const src = `@startuml
node "first line
second line" as multi
`;
  const m = parsePlantUml(src);
  assert.equal(m.elements.get('multi').label, 'first line second line');
});

test('malformed input produces warnings, never throws', () => {
  const m = parsePlantUml('@startuml\nwhat even is this\n%%% ===\n@enduml');
  assert.ok(m.warnings.length >= 2);
  assert.deepEqual(m.rootOrder, []);
});

test('title forms', () => {
  const m1 = parsePlantUml('@startuml\ntitle: My Title\n');
  assert.equal(m1.title, 'My Title');
  const m2 = parsePlantUml('@startuml\ntitle\nlong title\nend title\n');
  assert.equal(m2.title, 'long title');
});
