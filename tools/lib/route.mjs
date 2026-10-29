// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// The PCB routing pipeline as a callable unit, shared by the CLI driver
// (tools/route-board.mjs) and the upload server (server/upload-server.mjs):
// parse + layout -> board spec -> KiCad + Freerouting -> routes object.
//
// The toolchain invocation is injected (runRouter(specPath, sesPath,
// singleLayer)) so callers control spawning (sync CLI / async server with
// timeouts). onStage(stage, detail) reports the real two-pass progress:
//   ('route', 'pass 1 (F.Cu)')      first autorouter pass
//   ('route', 'pass 2 (F.Cu+B.Cu)') only when pass 1 leaves nets unrouted

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlantUml } from '../../js/parser.js';
import { buildScene } from '../../js/layout.js';
import { buildBoardSpec, sesToWorld, chainSegments } from './boardgeo.mjs';

// Parse + lay out a .puml text and derive the board spec from the scene.
// Split from routeBoard so servers can report a real "preprocessing" stage
// (and drop the source text) before the slow autorouter starts.
export function prepareDiagram(pumlText) {
  const scene = buildScene(parsePlantUml(pumlText));
  return { scene, spec: buildBoardSpec(scene) };
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

// Route one prepared diagram and write the routes.json consumed by
// js/render.js. scratch files (spec/ses/dsn/log) land in tmpDir; the final
// artifact in routesPath. Returns { routes, routed, nets }.
export async function routeBoard({ scene, spec, tmpDir, base, routesPath, runRouter, onStage }) {
  const specPath = join(tmpDir, `${base}.spec.json`);
  const sesPath = join(tmpDir, `${base}.ses`);
  writeFileSync(specPath, JSON.stringify(spec));

  // Pass 1: F.Cu only. Pass 2 (both layers) only when pass 1 leaves a net
  // unrouted.
  onStage?.('route', 'pass 1 (F.Cu)');
  await runRouter(specPath, sesPath, true);
  let world = sesToWorld(readFileSync(sesPath, 'utf8'));
  let res = chainNets(scene, spec, world);
  if (res.okCount < spec.nets.length) {
    onStage?.('route', 'pass 2 (F.Cu+B.Cu)', { unrouted: spec.nets.length - res.okCount });
    await runRouter(specPath, sesPath, false);
    world = sesToWorld(readFileSync(sesPath, 'utf8'));
    res = chainNets(scene, spec, world);
  }

  const routes = {
    version: 1,
    traceW: spec.traceW,
    padR: spec.padD / 2,
    viaR: spec.viaD / 2,
    nets: res.nets,
  };
  writeFileSync(routesPath, JSON.stringify(routes) + '\n');
  return { routes, routed: res.okCount, nets: spec.nets.length };
}
