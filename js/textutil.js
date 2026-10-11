// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Text helpers shared by layout (Node-safe) and rendering (browser).

// Wraps a label into lines: honors explicit newlines, then wraps long lines
// on word boundaries at `cols` characters. Result is capped at `maxLines`.
export function wrapText(text, cols, maxLines) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    for (const line of wrapLine(raw, cols)) {
      if (out.length >= maxLines) return out;
      out.push(line);
    }
  }
  return out;
}

function wrapLine(line, cols) {
  const words = line.split(' ').filter((w) => w !== '');
  if (words.length === 0) return [''];
  const out = [];
  let cur = words[0];
  for (let i = 1; i < words.length; i++) {
    if (cur.length + 1 + words[i].length <= cols) {
      cur += ' ' + words[i];
    } else {
      out.push(cur);
      cur = words[i];
    }
  }
  out.push(cur);
  return out;
}
