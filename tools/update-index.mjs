#!/usr/bin/env node
// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Regenerates diagrams/index.json from the *.puml files in diagrams/.
// Run after adding or removing diagrams:  node tools/update-index.mjs
// Diagrams that have a routed board (see tools/route-board.mjs) are listed
// in "routes" so the page can load their copper tracks without a 404 probe.

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { naturalSort } from '../js/natsort.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'diagrams');

const diagrams = naturalSort(
  readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.puml')),
);

const routes = diagrams
  .map((d) => `${d.replace(/\.puml$/i, '')}.routes.json`)
  .filter((f) => existsSync(join(dir, f)));

const out = JSON.stringify({ diagrams, routes }, null, 2) + '\n';
writeFileSync(join(dir, 'index.json'), out);
console.log(
  `wrote diagrams/index.json with ${diagrams.length} diagram(s), `
  + `${routes.length} routed`,
);
