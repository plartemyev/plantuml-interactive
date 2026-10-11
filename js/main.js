// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Bootstrap: loads the diagram catalog, feeds the parser/layout/renderer
// pipeline, and wires the HUD (title block, legend, diagram list, warnings).

import { parsePlantUml } from './parser.js';
import { buildScene } from './layout.js';
import { createRenderer, PALETTE } from './render.js';
import { naturalSort } from './natsort.js';

const canvas = document.getElementById('scene');
const els = {
  titlebar: document.getElementById('titlebar'),
  title: document.getElementById('diagram-title'),
  stats: document.getElementById('diagram-stats'),
  legend: document.getElementById('legend'),
  list: document.getElementById('diagram-list'),
  items: document.getElementById('diagram-items'),
  warnings: document.getElementById('warnings'),
  warnToggle: document.getElementById('warnings-toggle'),
  warnItems: document.getElementById('warning-items'),
  tooltip: document.getElementById('tooltip'),
  hint: document.getElementById('hint'),
  banner: document.getElementById('banner'),
  bannerText: document.getElementById('banner-text'),
};

const renderer = createRenderer(canvas, { onHover: showTooltip });

window.__booted = true; // inline watchdog in index.html checks this (file:// case)

const state = {
  diagrams: [],
  current: null,
};

function showError(html) {
  els.bannerText.innerHTML = html;
  els.banner.hidden = false;
}

function bannerForFileProtocol() {
  showError(
    'This page was opened via <code>file://</code>, which browsers forbid for ' +
    'loading local diagram files (CORS). Serve the directory instead, e.g.:<br>' +
    '<code>python3 -m http.server 8000</code> &nbsp;then open ' +
    '<code>http://localhost:8000/</code>',
  );
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function loadCatalog() {
  let raw;
  try {
    raw = await fetchText('diagrams/index.json');
  } catch (err) {
    if (location.protocol === 'file:') {
      bannerForFileProtocol();
    } else {
      showError(
        `Could not load <code>diagrams/index.json</code> (${err.message}). ` +
        'Add diagrams to <code>diagrams/</code> and regenerate the catalog with ' +
        '<code>node tools/update-index.mjs</code>.',
      );
    }
    return;
  }
  let catalog;
  try {
    catalog = JSON.parse(raw);
  } catch {
    showError('diagrams/index.json is not valid JSON.');
    return;
  }
  state.diagrams = naturalSort(catalog.diagrams ?? []);
  if (state.diagrams.length === 0) {
    showError('No diagrams listed in <code>diagrams/index.json</code>.');
    return;
  }
  if (state.diagrams.length > 1) {
    buildList();
    els.list.hidden = false;
  }
  await loadDiagram(state.diagrams[0]);
}

function buildList() {
  els.items.textContent = '';
  for (const name of state.diagrams) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = name.replace(/\.puml$/i, '');
    btn.title = name;
    btn.dataset.file = name;
    btn.addEventListener('click', () => loadDiagram(name));
    li.appendChild(btn);
    els.items.appendChild(li);
  }
}

async function loadDiagram(name) {
  state.current = name;
  for (const btn of els.items.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.file === name);
  }
  let text;
  try {
    text = await fetchText(`diagrams/${encodeURIComponent(name)}`);
  } catch (err) {
    showError(`Could not load <code>${name}</code>: ${err.message}`);
    return;
  }
  const model = parsePlantUml(text);
  const scene = buildScene(model);
  renderer.load(scene);
  updateHud(name, model, scene);
}

function updateHud(name, model, scene) {
  const display = model.title || model.name || name.replace(/\.puml$/i, '');
  els.title.textContent = display;
  document.title = `${display} · plantuml-interactive`;
  els.stats.textContent =
    `${scene.stats.elements} elements · ${scene.stats.visibleRelations} relations`
    + (scene.stats.notes ? ` · ${scene.stats.notes} notes` : '');
  els.titlebar.hidden = false;
  buildLegend(scene);
  buildWarnings(model.warnings);
}

function buildLegend(scene) {
  const kinds = new Set(scene.boxes.map((b) => b.kind));
  els.legend.textContent = '';
  for (const kind of [...kinds].sort()) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = (PALETTE[kind] ?? PALETTE.default).base;
    chip.appendChild(swatch);
    chip.appendChild(document.createTextNode(PALETTE[kind]?.label ?? kind));
    els.legend.appendChild(chip);
  }
  els.legend.hidden = false;
}

function buildWarnings(warnings) {
  els.warnItems.textContent = '';
  if (warnings.length === 0) {
    els.warnings.hidden = true;
    return;
  }
  for (const w of warnings.slice(0, 50)) {
    const li = document.createElement('li');
    const loc = document.createElement('b');
    loc.textContent = `L${w.line} `;
    li.appendChild(loc);
    li.appendChild(document.createTextNode(w.message));
    els.warnItems.appendChild(li);
  }
  els.warnToggle.textContent = `⚠ ${warnings.length} parser warning${warnings.length === 1 ? '' : 's'}`;
  els.warnItems.hidden = true; // collapsed until clicked
  els.warnings.hidden = false;
}

els.warnToggle.addEventListener('click', () => {
  els.warnItems.hidden = !els.warnItems.hidden;
});

const tooltipState = { id: null };

function showTooltip(payload) {
  if (!payload) {
    els.tooltip.hidden = true;
    tooltipState.id = null;
    return;
  }
  const t = els.tooltip;
  if (tooltipState.id !== payload.id || t.hidden) {
    t.textContent = '';
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = payload.kind;
    t.appendChild(kind);
    t.appendChild(document.createTextNode(payload.lines.join('\n')));
    if (payload.stereotype) {
      t.appendChild(document.createTextNode(`\n<< ${payload.stereotype} >>`));
    }
    if (payload.ghost < 0.995) {
      const g = document.createElement('div');
      g.className = 'ghost';
      g.textContent = `opacity ${Math.round(payload.ghost * 100)}% — wheel to adjust`;
      t.appendChild(g);
    }
    tooltipState.id = payload.id;
  }
  const x = Math.min(payload.x + 16, window.innerWidth - 280);
  const y = Math.min(payload.y + 18, window.innerHeight - 140);
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
  t.hidden = false;
}

loadCatalog();

// Debug/test hooks (used by headless screenshots; harmless in normal use).
window.__view = {
  hover: (id) => renderer.debugHover(id),
  ghost: (id, v) => renderer.debugGhost(id, v),
  select: (id) => renderer.debugSelect(id),
  fit: () => renderer.fit(),
  zoom: (f) => renderer.zoom(f),
  get scale() { return renderer.scale; },
};
