// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Tests for js/uploads.js pure helpers (stage labels for the loading bars).
// Importing the module must work in plain node (no top-level DOM access).

import test from 'node:test';
import assert from 'node:assert/strict';

import { stageText, opfsSupported } from '../js/uploads.js';

test('stageText renders every pipeline state', () => {
  assert.equal(stageText({ state: 'uploading' }), 'uploading…');
  assert.equal(stageText({ state: 'queued' }), 'queued');
  assert.equal(stageText({ state: 'preprocess' }), 'preprocessing…');
  assert.equal(stageText({ state: 'route', detail: 'pass 1 (F.Cu)' }), 'routing · pass 1 (F.Cu)');
  assert.equal(stageText({ state: 'route', detail: '' }), 'routing · autorouter');
  assert.equal(stageText({ state: 'postprocess' }), 'finishing…');
  assert.equal(stageText({ state: 'routed' }), 'routed · stored locally');
  assert.equal(stageText({ state: 'error', error: 'kicad_route.py exited 1' }),
    'failed — kicad_route.py exited 1');
  assert.equal(stageText({ state: 'error' }), 'failed — unknown error');
});

test('opfsSupported is false where navigator.storage is absent (node)', () => {
  assert.equal(opfsSupported(), false);
});
