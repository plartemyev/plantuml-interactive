// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Bootstrap: loads the diagram catalog, feeds the parser/layout/renderer
// pipeline, and wires the HUD (title block, legend, diagram list, warnings).

import { parsePlantUml } from './parser.js';
import { buildScene } from './layout.js';
import { createRenderer, PALETTE } from './render.js';
import { naturalSort } from './natsort.js';
import { TSV_DEFAULTS } from './tsv.js';
import { initUploads, stageText } from './uploads.js';

const canvas = document.getElementById('scene');
const els = {
  titlebar: document.getElementById('titlebar'),
  title: document.getElementById('diagram-title'),
  stats: document.getElementById('diagram-stats'),
  legend: document.getElementById('legend'),
  list: document.getElementById('diagram-list'),
  items: document.getElementById('diagram-items'),
  uploadRow: document.getElementById('upload-row'),
  uploadBtn: document.getElementById('upload-btn'),
  uploadInput: document.getElementById('upload-input'),
  uploadNote: document.getElementById('upload-note'),
  tsvlab: document.getElementById('tsvlab'),
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
  routes: new Set(),
  current: null,
};

// The upload feature (server env-flag gated; null when unavailable).
const uploads = { ctl: null };

// Catalog + user-uploaded (OPFS) names, uploaded shadowing catalog dupes.
function allDiagramNames() {
  return naturalSort([...new Set([...state.diagrams, ...(uploads.ctl?.names() ?? [])])]);
}

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
  initUploadFeature(); // async; independent of the catalog fetch below
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
    refreshList();
    maybeLoadFirst();
    return;
  }
  let catalog;
  try {
    catalog = JSON.parse(raw);
  } catch {
    showError('diagrams/index.json is not valid JSON.');
    refreshList();
    maybeLoadFirst();
    return;
  }
  state.diagrams = naturalSort(catalog.diagrams ?? []);
  state.routes = new Set(catalog.routes ?? []);
  if (state.diagrams.length === 0) {
    showError('No diagrams listed in <code>diagrams/index.json</code>.');
  }
  refreshList();
  maybeLoadFirst();
}

function maybeLoadFirst() {
  if (!state.current && allDiagramNames().length > 0) {
    loadDiagram(allDiagramNames()[0]);
  }
}

function refreshList() {
  const names = allDiagramNames();
  if (names.length === 0) return;
  buildList(names);
  // the list doubles as the upload panel, so it shows even for a single
  // diagram once the upload feature is active
  els.list.hidden = names.length < 2 && els.uploadRow.hidden;
  if (names.length > 0 && !state.current) els.banner.hidden = true;
}

function buildList(names) {
  els.items.textContent = '';
  for (const name of names) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = name.replace(/\.puml$/i, '');
    btn.title = uploads.ctl?.isLocal(name)
      ? `${name} — stored locally (OPFS)`
      : name;
    btn.dataset.file = name;
    btn.classList.toggle('local', !!uploads.ctl?.isLocal(name));
    btn.addEventListener('click', () => loadDiagram(name));
    li.appendChild(btn);
    els.items.appendChild(li);
  }
  renderUploadStatuses();
}

async function loadDiagram(name) {
  state.current = name;
  for (const btn of els.items.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.file === name);
  }
  const local = uploads.ctl?.isLocal(name);
  let text;
  try {
    text = local
      ? await uploads.ctl.readSource(name)
      : await fetchText(`diagrams/${encodeURIComponent(name)}`);
  } catch (err) {
    showError(`Could not load <code>${name}</code>: ${err.message}`);
    return;
  }
  const model = parsePlantUml(text);
  const scene = buildScene(model);
  const routesName = name.replace(/\.puml$/i, '.routes.json');
  if (local && uploads.ctl.hasRoutes(name)) {
    try {
      scene.routes = JSON.parse(await uploads.ctl.readRoutes(name));
    } catch {
      scene.routes = null; // fall back to airborne wires
    }
  } else if (!local && state.routes.has(routesName)) {
    try {
      scene.routes = JSON.parse(await fetchText(`diagrams/${encodeURIComponent(routesName)}`));
    } catch {
      scene.routes = null; // fall back to airborne wires
    }
  } else {
    scene.routes = null;
  }
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
  updateTsvLab(scene);
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

// ---- uploads (server env-flag gated; the whole section is optional) -------

// Discover the feature (GET api/features), restore anything this browser
// already stored in OPFS, then keep list/statuses fresh as jobs progress.
async function initUploadFeature() {
  if (uploads.ctl || uploads.tried) return;
  uploads.tried = true;
  const ctl = await initUploads({
    onStored: () => {
      refreshList();
      maybeLoadFirst();
    },
    onStatus: () => renderUploadStatuses(),
    onRoutesReady: (name) => {
      // copper for a diagram the user is looking at lands mid-session
      if (state.current === name) loadDiagram(name);
    },
    onNote: showUploadNote,
  });
  if (!ctl) return; // flag off (404) or OPFS unavailable — stay a static page
  uploads.ctl = ctl;
  els.uploadRow.hidden = false;
  refreshList();
  maybeLoadFirst();
}

els.uploadBtn.addEventListener('click', () => els.uploadInput.click());
els.uploadInput.addEventListener('change', () => {
  if (els.uploadInput.files.length > 0) uploads.ctl?.uploadFiles(els.uploadInput.files);
  els.uploadInput.value = ''; // allow re-picking the same file
});

let noteTimer = null;
function showUploadNote(text) {
  els.uploadNote.textContent = text;
  els.uploadNote.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { els.uploadNote.hidden = true; }, 6000);
}

// Loading bar near the diagram name in the list: width + stage text come
// straight from the server's real pipeline events (js/uploads.js).
function renderUploadStatuses() {
  const ctl = uploads.ctl;
  if (!ctl) return;
  for (const [name, st] of ctl.statuses) {
    const btn = els.items.querySelector(`button[data-file="${CSS.escape(name)}"]`);
    if (!btn) continue;
    const li = btn.parentElement;
    const interesting = ['uploading', 'queued', 'preprocess', 'route', 'postprocess', 'error', 'routed']
      .includes(st.state);
    let bar = li.querySelector('.up-bar');
    if (!bar && interesting) {
      bar = document.createElement('div');
      bar.className = 'up-bar';
      bar.appendChild(document.createElement('div')).className = 'up-fill';
      const stage = document.createElement('div');
      stage.className = 'up-stage';
      li.append(bar, stage);
    }
    if (!bar) continue;
    const fill = bar.firstChild;
    const stage = bar.nextElementSibling;
    li.classList.toggle('up-error', st.state === 'error');
    fill.className = `up-fill${st.state === 'error' ? ' failed' : ''}${st.state === 'route' ? ' stripe' : ''}`;
    fill.style.width = `${Math.round(Math.max(st.progress, interesting && st.state !== 'routed' ? 0.04 : 1) * 100)}%`;
    stage.textContent = stageText(st);
    if (st.state === 'routed') {
      setTimeout(() => { // let the 100% state sink in, then clean the entry up
        bar.remove();
        stage.remove();
        li.classList.remove('up-error');
      }, 2500);
    }
  }
}

// ---- TSV lab --------------------------------------------------------------

// Sliders -> renderer TSV parameters. Slider ranges live in index.html;
// initial values (and the output text) come from the module defaults so the
// two cannot drift apart.
const TSV_CONTROLS = [
  ['tsv-core', 'coreR'],
  ['tsv-liner', 'linerT'],
];

for (const [inpId, key] of TSV_CONTROLS) {
  const inp = document.getElementById(inpId);
  const out = document.getElementById(`${inpId}-v`);
  const show = () => { out.textContent = Number(inp.value).toFixed(key === 'count' ? 0 : 1); };
  inp.value = TSV_DEFAULTS[key];
  show();
  inp.addEventListener('input', () => {
    show();
    renderer.setTsvParams({ [key]: Number(inp.value) });
  });
}

// The lab is an experiment tool, hidden from the production page: it only
// shows with ?tsvlab=1, and only on diagrams that actually stack packages;
// it parks itself right under the diagram list.
const TSV_LAB_SHOWN = /(?:^|[?&])tsvlab=1(?:&|$)/.test(location.search);

function updateTsvLab(scene) {
  const hasStacks = scene.boxes.some((b) => b.parentId);
  els.tsvlab.hidden = !TSV_LAB_SHOWN || !hasStacks;
  if (!els.tsvlab.hidden) {
    const top = els.list.hidden ? 14 : els.list.offsetTop + els.list.offsetHeight + 10;
    els.tsvlab.style.top = `${top}px`;
  }
}

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
  select: (id) => renderer.debugSelect(id),
  fit: () => renderer.fit(),
  zoom: (f) => renderer.zoom(f),
  tsv: (p) => renderer.setTsvParams(p),
  get tsvParams() { return renderer.tsvParams; },
  focus: (id) => renderer.focus(id),
  get scale() { return renderer.scale; },
  get drawMs() { return renderer.drawMs; },
  get draws() { return renderer.draws; },
  get hasRoutes() { return renderer.hasRoutes; },
  state: () => renderer.debugState(),
};
