// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Tests for the shared upload name rules (js/upload-name.js). Pure node.

import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeUploadName, dedupeBatch } from '../js/upload-name.js';

test('sanitizeUploadName: accepts plain stems and normalizes the extension', () => {
  assert.equal(sanitizeUploadName('my diagram.puml'), 'my diagram.puml');
  assert.equal(sanitizeUploadName('Deployment.PUML'), 'Deployment.puml');
  assert.equal(sanitizeUploadName('v2_final.puml'), 'v2_final.puml');
});

test('sanitizeUploadName: strips path parts from both slash kinds', () => {
  assert.equal(sanitizeUploadName('/etc/passwd/evil.puml'), 'evil.puml');
  assert.equal(sanitizeUploadName('C:\\Users\\x\\net.puml'), 'net.puml');
  assert.equal(sanitizeUploadName('../../trap.puml'), 'trap.puml');
});

test('sanitizeUploadName: replaces hostile characters with underscores', () => {
  assert.equal(sanitizeUploadName('a<b> c.puml'), 'a_b_ c.puml');
  assert.equal(sanitizeUploadName('uml\x00.puml'), 'uml_.puml');
});

test('sanitizeUploadName: rejects non-puml, dot-stems, empties, overlong names', () => {
  assert.equal(sanitizeUploadName('diagram.svg'), null);
  assert.equal(sanitizeUploadName('.puml'), null);
  assert.equal(sanitizeUploadName('.hidden.puml'), null);
  assert.equal(sanitizeUploadName(''), null);
  assert.equal(sanitizeUploadName(`${'x'.repeat(81)}.puml`), null);
  assert.equal(sanitizeUploadName(`${'x'.repeat(80)}.puml`), `${'x'.repeat(80)}.puml`);
});

test('dedupeBatch: unique names pass through, duplicates get -2, -3 suffixes', () => {
  const out = dedupeBatch(['a.puml', 'a.puml', 'a.puml', 'b.puml']);
  assert.deepEqual(out.map((e) => e.name), ['a.puml', 'a-2.puml', 'a-3.puml', 'b.puml']);
});

test('dedupeBatch: suffixes dodge existing names and invalid files stay null', () => {
  const out = dedupeBatch(['a.puml', 'a-2.puml', 'a.puml', 'no.ext', 'ok.puml']);
  assert.deepEqual(out.map((e) => e.name), ['a.puml', 'a-2.puml', 'a-3.puml', null, 'ok.puml']);
});

test('dedupeBatch: preserves the raw file for error reporting', () => {
  const out = dedupeBatch(['w?eird.puml']);
  assert.equal(out[0].raw, 'w?eird.puml');
  assert.equal(out[0].name, 'w_eird.puml');
});
