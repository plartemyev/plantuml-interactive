// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Client side of the upload feature (env-flag gated by the server; the page
// probes GET api/features to discover it):
//
//   - uploaded .puml sources AND their routed artifacts live user-side in
//     OPFS (`<origin>/uploads/<name>.puml` + `<name>.routes.json`), so they
//     survive reloads and never depend on server storage;
//   - the server keeps uploads only for the duration of routing (guaranteed
//     cleanup server-side); progress arrives as real stage events over the
//     /api/progress WebSocket;
//   - uploading/processing never blocks browsing — every callback here is
//     fire-and-forget for the caller.
//
// DOM-free except for initUploads' callbacks: rendering stays in main.js.

import { dedupeBatch } from './upload-name.js';

const routesName = (name) => name.replace(/\.puml$/i, '.routes.json');

export function opfsSupported() {
  try {
    return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
  } catch {
    return false;
  }
}

async function openUploadsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('uploads', { create: true });
}

async function writeText(dir, name, text) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function readText(dir, name) {
  const file = await (await dir.getFileHandle(name)).getFile();
  return file.text();
}

async function hasFile(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

// Scan OPFS: everything the user stored so far, with routed-artifact flags.
async function listStored(dir) {
  const stored = new Map();
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file' || !/\.puml$/i.test(name)) continue;
    stored.set(name, { hasRoutes: await hasFile(dir, routesName(name)) });
  }
  return stored;
}

// States surfaced to the UI (server pipeline states + client-local ones):
//   uploading -> queued -> preprocess -> route -> postprocess -> done -> routed
//                                                        \-> error
const ACTIVE_STATES = new Set(['uploading', 'queued', 'preprocess', 'route', 'postprocess']);

export function stageText(st) {
  switch (st.state) {
    case 'uploading': return 'uploading…';
    case 'queued': return 'queued';
    case 'preprocess': return 'preprocessing…';
    case 'route': return `routing · ${st.detail || 'autorouter'}`;
    case 'postprocess': return 'finishing…';
    case 'routed': return 'routed · stored locally';
    case 'error': return `failed — ${st.error ?? 'unknown error'}`;
    default: return st.detail || st.state;
  }
}

// Wire the feature up. Resolves to a controller (or null when the server
// doesn't expose uploads / OPFS is unavailable). Hooks:
//   maxFiles       batch cap from /api/features
//   onStored()     stored map changed (new/updated sources or artifacts)
//   onStatus()     some entry in `statuses` changed (re-render bars)
//   onRoutesReady(name)  routed artifact just landed in OPFS
//   onNote(text)   small non-fatal notices (skipped files, caps hit)
export async function initUploads({
  maxFiles = 100,
  onStored = () => {},
  onStatus = () => {},
  onRoutesReady = () => {},
  onNote = () => {},
} = {}) {
  let features;
  try {
    const res = await fetch('api/features');
    if (!res.ok) return null;
    features = await res.json();
  } catch {
    return null;
  }
  if (!features?.uploads || !opfsSupported()) return null;

  const dir = await openUploadsDir();
  const stored = await listStored(dir);        // name -> { hasRoutes }
  const statuses = new Map();                  // name -> { state, progress, detail, error }
  const jobNames = new Map();                  // server job id -> local name
  let wsTimer = null;
  let closed = false;

  const emitStatus = (name) => onStatus(name);
  const note = (text) => text && onNote(text);

  // ---- websocket progress channel (reconnects until the page dies) --------

  function handleEvent(ev) {
    if (ev.type === 'hello') {
      for (const job of ev.jobs ?? []) adopt(job);
      return;
    }
    if (ev.type === 'job') adopt(ev);
  }

  function connect() {
    if (closed) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/progress`;
    const ws = new WebSocket(url);
    ws.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      handleEvent(ev);
    };
    ws.onclose = () => {
      if (!closed) wsTimer = setTimeout(connect, 3000);
    };
    ws.onerror = () => ws.close();
  }

  // ---- server job events -> local statuses --------------------------------

  function adopt(job) {
    let name = jobNames.get(job.id);
    if (!name) {
      // e.g. hello snapshot after a reload: re-attach by diagram name
      if (job.name && (stored.has(job.name) || statuses.has(job.name))) {
        jobNames.set(job.id, job.name);
        name = job.name;
      } else {
        return; // a job from another browser profile — nothing to show
      }
    }
    statuses.set(name, {
      state: job.state,
      progress: job.progress ?? 0,
      detail: job.detail ?? '',
      error: job.error ?? null,
    });
    emitStatus(name);
    if (job.state === 'done') claimRoutes(job.id, name);
    if (job.state === 'error') jobNames.delete(job.id);
  }

  // Fetch the routed artifact into OPFS, then let the server delete it.
  async function claimRoutes(id, name) {
    try {
      const res = await fetch(`api/diagrams/${id}/routes`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await writeText(dir, routesName(name), await res.text());
      stored.set(name, { hasRoutes: true });
      onStored();
      fetch(`api/diagrams/${id}/ack`, { method: 'POST' }).catch(() => {});
    } catch (err) {
      if (!(await hasFile(dir, routesName(name)))) {
        statuses.set(name, { state: 'error', progress: 0, detail: '', error: `artifact lost (${err.message})` });
        emitStatus(name);
        return;
      }
      // artifact already in OPFS (e.g. another tab claimed it) — done either way
    }
    jobNames.delete(id);
    statuses.set(name, { state: 'routed', progress: 1, detail: 'stored locally' });
    emitStatus(name);
    onRoutesReady(name);
  }

  // ---- uploading -----------------------------------------------------------

  async function uploadOne(file, name) {
    statuses.set(name, { state: 'uploading', progress: 0, detail: '', error: null });
    emitStatus(name);
    try {
      const text = await file.text();
      await writeText(dir, name, text); // user-side copy FIRST: survives everything
      stored.set(name, { hasRoutes: await hasFile(dir, routesName(name)) });
      onStored();
      const res = await fetch(`api/diagrams?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        body: text,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      jobNames.set(body.id, name);
      // the server's first broadcast may already have fired before we got
      // the id back; if no event arrives, seed the bar from the response
      setTimeout(() => {
        if (!statuses.get(name) || statuses.get(name).state === 'uploading') {
          statuses.set(name, { state: body.state ?? 'queued', progress: 0, detail: '', error: null });
          emitStatus(name);
        }
      }, 1500);
    } catch (err) {
      // source is already safe in OPFS: the diagram stays usable (airborne
      // wires fallback), only routing is missing
      statuses.set(name, { state: 'error', progress: 0, detail: '', error: err.message });
      emitStatus(name);
    }
  }

  async function uploadFiles(fileList) {
    const files = [...fileList];
    if (files.length === 0) return;
    const capped = files.slice(0, maxFiles);
    if (capped.length < files.length) {
      note(`${files.length - capped.length} file(s) ignored: at most ${maxFiles} per batch`);
    }
    const plan = dedupeBatch(capped.map((f) => f.name));
    const jobs = [];
    const skipped = [];
    plan.forEach((entry, i) => {
      if (!entry.name) skipped.push(files[i].name);
      else jobs.push({ file: capped[i], name: entry.name });
    });
    if (skipped.length > 0) {
      note(`skipped ${skipped.length} file(s) with unusable names (want <stem>.puml)`);
    }
    // small fixed pool: OPFS writes + POSTs stay orderly, routing is server-
    // queued sequentially anyway
    const POOL = 4;
    let idx = 0;
    const workers = Array.from({ length: Math.min(POOL, jobs.length) }, async () => {
      while (idx < jobs.length) {
        const job = jobs[idx];
        idx += 1;
        await uploadOne(job.file, job.name);
      }
    });
    await Promise.all(workers);
  }

  connect();

  return {
    statuses,
    uploadFiles,
    names: () => [...stored.keys()],
    isLocal: (name) => stored.has(name),
    hasRoutes: (name) => stored.get(name)?.hasRoutes ?? false,
    readSource: (name) => readText(dir, name),
    readRoutes: (name) => readText(dir, routesName(name)),
    isActive: (name) => ACTIVE_STATES.has(statuses.get(name)?.state),
    dispose: () => {
      closed = true;
      clearTimeout(wsTimer);
    },
  };
}
