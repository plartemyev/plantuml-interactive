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
// skipped unless --force. Freerouting runs headlessly; see kicad_route.py for
// the toolchain requirements (java >= 25, freerouting.jar).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlantUml } from '../js/parser.js';
import { buildScene } from '../js/layout.js';
import { buildBoardSpec, sesToWorld, chainSegments } from './lib/boardgeo.mjs';
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
      const scene = buildScene(parsePlantUml(readFileSync(pumlPath, 'utf8')));
      await routeDiagram(base, scene, routesPath);
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

// Chains every net's routed segments pad-to-pad; returns the per-net map for
// routes.json plus the count of nets whose chain reached the far pad.
function chainNets(scene, spec, world) {
  const nets = {};
  let okCount = 0;
  for (const net of spec.nets) {
    const g = world.nets[net.name] ?? { segments: [], vias: [] };
    const edge = scene.edges[net.index];
    const ends = net.pads.map((p, k) => ({
      box: k === 0 ? edge.fromId : edge.toId,
      land: [p.x, p.y],
      stacked: !!scene.byId.get(k === 0 ? edge.fromId : edge.toId).parentId,
    }));
    const pads = net.pads;
    const chained = chainSegments(
      g.segments,
      pads[0] ? [pads[0].x, pads[0].y] : [NaN, NaN],
      pads[1] ? [pads[1].x, pads[1].y] : null,
    );
    const unrouted = chained === null;
    const path = unrouted ? [] : chained;
    const segs = unrouted ? [] : chained.segs;
    if (!unrouted) okCount++;
    nets[String(net.index)] = {
      path,
      segs,
      vias: g.vias,
      ends,
      unrouted,
    };
  }
  return { nets, okCount };
}

async function routeDiagram(base, scene, routesPath) {
  const spec = buildBoardSpec(scene);
  const specPath = join(tmpDir, `${base}.spec.json`);
  const sesPath = join(tmpDir, `${base}.ses`);
  writeFileSync(specPath, JSON.stringify(spec));

  // Pass 1: F.Cu only. Pass 2 (both layers) only when pass 1 leaves a net
  // unrouted.
  spawnRouter(specPath, sesPath, true);
  let world = sesToWorld(readFileSync(sesPath, 'utf8'));
  let res = chainNets(scene, spec, world);
  if (res.okCount < spec.nets.length) {
    console.log(`${base}: F.Cu-only left ${spec.nets.length - res.okCount} net(s) unrouted, retrying on 2 layers`);
    spawnRouter(specPath, sesPath, false);
    world = sesToWorld(readFileSync(sesPath, 'utf8'));
    res = chainNets(scene, spec, world);
  }

  const out = {
    version: 1,
    traceW: spec.traceW,
    padR: spec.padD / 2,
    viaR: spec.viaD / 2,
    nets: res.nets,
  };
  writeFileSync(routesPath, JSON.stringify(out) + '\n');
  console.log(`routed ${base}: ${res.okCount}/${spec.nets.length} nets`);
}

main();
