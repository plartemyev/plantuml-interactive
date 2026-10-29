#!/usr/bin/env node
// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// PCB-traces the relations of every diagram: parser + layout (the same pure
// modules the browser runs), board geometry (tools/lib/boardgeo.mjs), then
// KiCad + Freerouting (tools/kicad_route.py) produce copper tracks. Routing
// runs in two passes: first F.Cu-only, and only when that leaves a net
// unrouted again on both layers (F.Cu + B.Cu). Output:
// diagrams/<name>.routes.json, consumed by js/render.js.
//
//   node tools/route-board.mjs [--force] [diagram.puml ...]
//
// Diagrams whose routes.json is newer than their .puml and the toolchain are
// skipped unless --force. Freerouting runs with its GUI disabled (it would
// otherwise pop a window per run on a desktop); see kicad_route.py for the
// toolchain requirements (java >= 25, freerouting.jar).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDiagram, routeBoard } from './lib/route.mjs';
import { naturalSort } from '../js/natsort.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const diagramsDir = join(root, 'diagrams');
const tmpDir = join(root, '.tmp', 'board');

const args = process.argv.slice(2);
const force = args.includes('--force');
const targets = args.filter((a) => !a.startsWith('--')).map((a) => basename(a));

const TOOLCHAIN = [
  join(root, 'tools', 'route-board.mjs'),
  join(root, 'tools', 'lib', 'boardgeo.mjs'),
  join(root, 'tools', 'kicad_route.py'),
  // layout/parser drive pin positions, so their changes also stale the routes
  join(root, 'js', 'parser.js'),
  join(root, 'js', 'layout.js'),
];

function mtime(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

function pickTargets() {
  const all = naturalSort(
    existsSync(diagramsDir)
      ? readdirSync(diagramsDir).filter((f) => f.toLowerCase().endsWith('.puml'))
      : [],
  );
  return targets.length > 0 ? targets : all;
}

async function main() {
  mkdirSync(tmpDir, { recursive: true });
  const names = pickTargets();
  if (names.length === 0) {
    console.log('no diagrams found in diagrams/');
    return;
  }
  let routed = 0;
  let failed = 0;
  for (const name of names) {
    const base = name.replace(/\.puml$/i, '');
    const pumlPath = join(diagramsDir, name);
    const routesPath = join(diagramsDir, `${base}.routes.json`);
    if (!existsSync(pumlPath)) {
      console.error(`skip ${name}: not found`);
      continue;
    }
    const stale = TOOLCHAIN.some((t) => mtime(t) > mtime(routesPath));
    if (!force && existsSync(routesPath) && mtime(routesPath) >= mtime(pumlPath) && !stale) {
      console.log(`up-to-date ${name}`);
      continue;
    }
    try {
      const { scene, spec } = prepareDiagram(readFileSync(pumlPath, 'utf8'));
      const res = await routeBoard({
        scene, spec, tmpDir, base, routesPath,
        runRouter: (specPath, sesPath, singleLayer) => spawnRouter(specPath, sesPath, singleLayer),
        onStage: (stage, detail, info) => {
          if (detail === 'pass 2 (F.Cu+B.Cu)') {
            console.log(`${base}: F.Cu-only left ${info.unrouted} net(s) unrouted, retrying on 2 layers`);
          }
        },
      });
      console.log(`routed ${base}: ${res.routed}/${res.nets} nets`);
      routed++;
    } catch (err) {
      failed++;
      console.error(`FAIL ${name}: ${err.message}`);
    }
  }
  console.log(`routed ${routed} diagram(s), ${failed} failure(s)`);
  if (failed > 0) process.exitCode = 1;
}

function spawnRouter(specPath, sesPath, singleLayer) {
  const args = [join(root, 'tools', 'kicad_route.py'), specPath, sesPath];
  if (singleLayer) args.push('--single-layer');
  const py = spawnSync('python3', args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  });
  if (py.error) throw py.error;
  if (py.status !== 0) throw new Error(`kicad_route.py exited ${py.status}`);
}

main();
