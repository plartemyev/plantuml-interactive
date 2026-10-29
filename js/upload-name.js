// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Uploaded-diagram file name rules, shared verbatim by the browser
// (js/uploads.js previews/deduplicates a picked batch) and the upload server
// (authoritative check). Pure module — unit-tested under node.

// Sanitize one uploaded file name to a plain "<stem>.puml" (extension
// normalized to lowercase): strips any path parts, keeps [A-Za-z0-9._ -],
// requires a non-empty stem with a bounded length and a .puml extension.
// Returns the clean name or null.
export function sanitizeUploadName(raw) {
  let s = String(raw).split(/[\\/]/).pop().normalize('NFC');
  s = s.replace(/[^A-Za-z0-9._ -]+/g, '_');
  if (!/\.puml$/i.test(s)) return null;
  const stem = s.slice(0, -'.puml'.length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/.test(stem)) return null;
  return `${stem}.puml`;
}

// Resolve a picked batch into upload names: invalid files map to name:null,
// same-name files get -2, -3, ... suffixes so a single "upload 100 files"
// action never collides with itself. Returns [{raw, name}] in input order.
export function dedupeBatch(rawNames) {
  const seen = new Set();
  const out = [];
  for (const raw of rawNames) {
    const name = sanitizeUploadName(raw);
    if (name === null) {
      out.push({ raw, name: null });
      continue;
    }
    let final = name;
    if (seen.has(name)) {
      const stem = name.slice(0, -'.puml'.length);
      let n = 2;
      while (n < 1000 && seen.has(`${stem}-${n}.puml`)) n++;
      final = n < 1000 ? `${stem}-${n}.puml` : null;
    }
    if (final === null) {
      out.push({ raw, name: null });
      continue;
    }
    seen.add(final);
    out.push({ raw, name: final });
  }
  return out;
}
