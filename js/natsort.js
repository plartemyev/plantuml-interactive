// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Natural sort: digit runs compare numerically ("a2" < "a10"), everything
// else compares with locale collation. Digit runs are compared as BigInt so
// arbitrarily long runs stay correct.

export function naturalCompare(a, b) {
  const ta = String(a).split(/(\d+)/);
  const tb = String(b).split(/(\d+)/);
  const n = Math.min(ta.length, tb.length);
  for (let k = 0; k < n; k++) {
    if (k % 2 === 1) {
      const x = BigInt(ta[k] === '' ? '0' : ta[k]);
      const y = BigInt(tb[k] === '' ? '0' : tb[k]);
      if (x !== y) return x < y ? -1 : 1;
      if (ta[k].length !== tb[k].length) return ta[k].length < tb[k].length ? -1 : 1;
    } else if (ta[k] !== tb[k]) {
      return ta[k] < tb[k] ? -1 : 1;
    }
  }
  if (ta.length !== tb.length) return ta.length < tb.length ? -1 : 1;
  return 0;
}

export function naturalSort(items) {
  return [...items].sort(naturalCompare);
}
