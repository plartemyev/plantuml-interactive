// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { naturalCompare, naturalSort } from '../js/natsort.js';

test('digit runs compare numerically', () => {
  assert.equal(naturalCompare('a2', 'a10'), -1);
  assert.equal(naturalCompare('a10', 'a2'), 1);
  assert.equal(naturalCompare('a2', 'a2'), 0);
});

test('naturalSort orders file names the way humans expect', () => {
  assert.deepEqual(
    naturalSort(['d10.puml', 'd2.puml', 'd1.puml', '3-tier.puml']),
    ['3-tier.puml', 'd1.puml', 'd2.puml', 'd10.puml'],
  );
});

test('leading zeros break ties deterministically', () => {
  assert.equal(naturalCompare('x01', 'x1'), 1); // longer run sorts later
  assert.deepEqual(naturalSort(['x7', 'x07', 'x007']), ['x7', 'x07', 'x007']);
});

test('long digit runs do not overflow', () => {
  const big = 'a' + '9'.repeat(40);
  assert.equal(naturalCompare(big, 'a2'), 1);
});

test('does not mutate input', () => {
  const input = ['b', 'a'];
  naturalSort(input);
  assert.deepEqual(input, ['b', 'a']);
});
