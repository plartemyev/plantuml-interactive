// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TSV_DEFAULTS, normalizeTsvParams, tsvPieces, tsvSpec } from '../js/tsv.js';

test('normalize clamps bad lab input without throwing', () => {
  const p = normalizeTsvParams({ coreR: -5, linerT: NaN, padR: -1, nub: -3 });
  assert.ok(p.coreR >= 0.2);
  assert.equal(p.linerT, TSV_DEFAULTS.linerT); // non-finite -> default
  assert.equal(p.padR, 0.2); // finite -> clamped to the floor
  assert.equal(p.nub, 0);
  // partial input keeps defaults for the rest
  assert.equal(normalizeTsvParams({ coreR: 2.5 }).linerT, TSV_DEFAULTS.linerT);
  assert.deepEqual(normalizeTsvParams(null), normalizeTsvParams({}));
});

test('spec: radii ordered, nub above zero, deterministic', () => {
  const s = tsvSpec({ coreR: 2.2, linerT: 1.8 });
  assert.ok(s.coreR < s.linerR);
  assert.equal(s.padR, TSV_DEFAULTS.padR);
  assert.equal(s.nub, TSV_DEFAULTS.nub);
  assert.deepEqual(s, tsvSpec({ coreR: 2.2, linerT: 1.8 }));
});

// Three-tier chain, rest geometry: root [0..20], housing [22..42],
// die bottom at 44 (like edge VPC > DMZ subnet > CDN origin shield).
const DIE = { id: 'die', z0: 44 };
const CHAIN = [{ id: 'dmz', z0: 22 }, { id: 'edge', z0: 0 }];

test('pieces tile the column: board -> root -> housing -> die bottom', () => {
  const pieces = tsvPieces(DIE, CHAIN);
  assert.equal(pieces.length, 2); // one per housing package, die owns none
  // bottom-up: root first, reaching down to the board surface
  assert.deepEqual(pieces[0], { id: 'edge', z0: TSV_DEFAULTS.zBase, z1: 22 });
  assert.deepEqual(pieces[1], { id: 'dmz', z0: 22, z1: 44 });
  // continuity: every piece starts where the one below ends
  for (let i = 1; i < pieces.length; i++) {
    assert.equal(pieces[i].z0, pieces[i - 1].z1);
  }
  // and the topmost piece ends exactly at the die's bottom face
  assert.equal(pieces[pieces.length - 1].z1, DIE.z0);
});

test('root piece is clamped to the board, body pieces keep their z0', () => {
  const pieces = tsvPieces(DIE, CHAIN, 0.3);
  assert.equal(pieces[0].z0, 0.3); // root: max(z0, board surface)
  assert.equal(pieces[1].z0, 22);
});

test('a die sitting directly on the root yields a single piece', () => {
  const pieces = tsvPieces({ id: 'die', z0: 22 }, [{ id: 'root', z0: 0 }]);
  assert.equal(pieces.length, 1);
  assert.deepEqual(pieces[0], { id: 'root', z0: TSV_DEFAULTS.zBase, z1: 22 });
});

test('pieces are deterministic and finite', () => {
  const a = tsvPieces(DIE, CHAIN);
  const b = tsvPieces(DIE, CHAIN);
  assert.deepEqual(a, b);
  for (const piece of a) {
    for (const v of [piece.z0, piece.z1]) assert.ok(Number.isFinite(v));
    assert.ok(piece.z1 > piece.z0); // non-degenerate segment
  }
});
