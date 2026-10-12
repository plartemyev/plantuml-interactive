// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Pure geometry for through-silicon via (TSV) drops between a stacked
// package and its landing pad. No DOM, no canvas — unit-tested under Node.
//
// A stacked connection is drawn as per-package pieces of one column: a Cu
// signal core (radius coreR) inside a dielectric liner sleeve (outer
// radius coreR + linerT), standing on an annular landing pad on the board.
// Each housing package on the way down owns its body's segment plus the
// stack gap above it; the topmost piece ends at the die's bottom face.
// While the stack is at rest the pieces tile into one continuous column;
// on explosion every piece moves with its own package, and the renderer
// bridges the temporary gaps with dotted leaders (the topmost one runs
// from the die's pin, which owns no piece).

export const TSV_DEFAULTS = {
  coreR: 1.7,  // Cu signal core radius (world units)
  linerT: 0.9, // dielectric liner thickness around the core
  padR: 3.0,   // landing annulus outer radius
  zBase: 0.3,  // board surface — the plane the routed copper lives on
  nub: 1.5,    // Cu core protrusion above each piece's liner mouth
};

// Clamp lab/user input into a valid parameter set: never throws, no NaN.
export function normalizeTsvParams(p) {
  const q = { ...TSV_DEFAULTS, ...(p ?? {}) };
  const num = (v, fb) => (Number.isFinite(v) ? v : fb);
  return {
    coreR: Math.max(0.2, num(q.coreR, TSV_DEFAULTS.coreR)),
    linerT: Math.max(0, num(q.linerT, TSV_DEFAULTS.linerT)),
    padR: Math.max(0.2, num(q.padR, TSV_DEFAULTS.padR)),
    zBase: Math.max(0, num(q.zBase, TSV_DEFAULTS.zBase)),
    nub: Math.max(0, num(q.nub, TSV_DEFAULTS.nub)),
  };
}

// Radii/pad/nub spec derived from the (clamped) parameters.
export function tsvSpec(params) {
  const p = normalizeTsvParams(params);
  return {
    coreR: p.coreR,
    linerR: p.coreR + p.linerT,
    padR: p.padR,
    zBase: p.zBase,
    nub: p.nub,
  };
}

// Rest-space pieces of one column, bottom-up (board first).
//
// die       — the stacked endpoint box (its rest z0 is the column top);
// ancestors — its parent, grandparent, ..., root (nearest first); each
//             entry needs {id, z0}.
//
// Every piece covers its package's body plus the gap above it, up to the
// bottom face of the next package in the chain; the root piece reaches
// down to the board surface so the column meets its landing pad.
export function tsvPieces(die, ancestors, zBase = TSV_DEFAULTS.zBase) {
  const pieces = [];
  for (let i = ancestors.length - 1; i >= 0; i--) { // root -> parent
    const p = ancestors[i];
    const above = i === 0 ? die.z0 : ancestors[i - 1].z0; // next package up
    pieces.push({
      id: p.id,
      z0: i === ancestors.length - 1 ? Math.max(p.z0, zBase) : p.z0,
      z1: above,
    });
  }
  return pieces;
}
