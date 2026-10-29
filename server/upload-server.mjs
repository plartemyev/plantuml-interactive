#!/usr/bin/env node
// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Static file server + the env-flag-gated diagram upload feature.
//
//   node server/upload-server.mjs                 # static only (== python -m http.server)
//   PUML_UPLOAD=1 node server/upload-server.mjs   # static + uploads + routing
//
// With PUML_UPLOAD enabled, users can upload up to 100 .puml files at a time.
// Uploads live in memory just long enough for preprocessing; the routing
// scratch (spec/ses/dsn/log) lands in a per-job directory under the upload
// scratch dir and is removed as soon as the client has fetched the routed
// artifact — with sweeper/startup/teardown passes guaranteeing cleanup even
// for abandoned jobs. Progress (real preprocess/route/postprocess stages) is
// streamed over a WebSocket at /api/progress; diagrams are stored user-side
// in OPFS by the browser (js/uploads.js) — the server keeps nothing.
//
// API (all 404 when the flag is off):
//   GET  /api/features                     -> { uploads: true, maxFiles }
//   POST /api/diagrams?name=<file>.puml    body: raw .puml -> { id, name }
//   GET  /api/jobs                         -> queued/running/finished jobs
//   GET  /api/diagrams/<id>/routes         -> routes.json once done
//   POST /api/diagrams/<id>/ack            -> fetch done; server deletes now
//   WS   /api/progress                     -> hello snapshot + job events

import { createServer } from 'node:http';
import { createReadStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isUpgradeRequest, upgrade as wsUpgrade } from './lib/ws.mjs';
import { prepareDiagram, routeBoard } from '../tools/lib/route.mjs';
import { sanitizeUploadName } from '../js/upload-name.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// feature gate + scratch location
export const uploadEnabled = (env = process.env) =>
  /^(1|true|yes|on)$/i.test(env.PUML_UPLOAD ?? '');
const defaultUploadDir = (env = process.env) =>
  env.PUML_UPLOAD_DIR ?? join(ROOT, '.tmp', 'uploads');

// limits: diagrams per batch (the task's "up to 100 at a time"), per-file
// bytes, job backlog, and the retention windows that guarantee cleanup.
const MAX_FILES = 100;
const MAX_FILE_BYTES = 2 << 20; // 2 MiB is far beyond any hand-written diagram
const MAX_ACTIVE_JOBS = 100;    // queued + running (upload burst guard)
const DONE_TTL_MS = 10 * 60_000;    // finished jobs linger only this long
const JOB_MAX_AGE_MS = 2 * 3_600_000; // hard cap for any job, whatever it does
const SWEEP_INTERVAL_MS = 60_000;
const PASS_TIMEOUT_MS = 660_000; // freerouting itself caps at 600s per pass

// Real progress values, derived from actual pipeline transitions only:
// queued 0 -> preprocess .02 -> route pass 1 .05 / pass 2 .45 ->
// postprocess .9 -> done 1.
const PROGRESS = { queued: 0, preprocess: 0.02, route: 0.05, route2: 0.45, postprocess: 0.9, done: 1 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.puml': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jar': 'application/java-archive',
};

// Strip machine-specific paths from an error before it reaches a client.
function safeMessage(err, scratchDir) {
  let msg = String(err?.message ?? err);
  for (const dir of [scratchDir, ROOT]) {
    while (msg.includes(dir)) msg = msg.replace(dir, '<scratch>');
  }
  return msg.slice(0, 300);
}

const lastLine = (s) => {
  const lines = s.trimEnd().split('\n');
  return lines[lines.length - 1] ?? '';
};

// ---------------------------------------------------------------------------
// Job queue: strictly sequential (each routing pass spawns KiCad + a 2 GiB
// JVM), events broadcast to every connected progress client.

export class UploadService {
  constructor({ uploadDir, runRouter, now = Date.now } = {}) {
    this.uploadDir = uploadDir;
    this.runRouter = runRouter;
    this.now = now;
    this.jobs = new Map(); // id -> job (kept until ack/TTL, incl. errors)
    this.queue = [];
    this.draining = false;
    this.clients = new Set();
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  jobDir(job) { return join(this.uploadDir, job.id); }

  snapshot(job) {
    return {
      id: job.id, name: job.name, state: job.state,
      progress: job.progress, detail: job.detail,
      error: job.error ?? undefined,
    };
  }

  list() {
    return [...this.jobs.values()].map((j) => this.snapshot(j));
  }

  addClient(conn) {
    conn.sendText(JSON.stringify({ type: 'hello', jobs: this.list() }));
    this.clients.add(conn);
    conn.on('close', () => this.clients.delete(conn));
  }

  broadcast(event) {
    const text = JSON.stringify(event);
    for (const conn of this.clients) {
      try { conn.sendText(text); } catch { this.clients.delete(conn); }
    }
  }

  update(job, patch) {
    if (!this.jobs.has(job.id)) return; // swept mid-run: nothing to tell
    Object.assign(job, patch);
    this.broadcast({ type: 'job', ...this.snapshot(job) });
  }

  // Validate + enqueue one uploaded diagram. Returns { job } or { error, message }.
  submit(rawName, text) {
    const name = sanitizeUploadName(rawName);
    if (!name) return { error: 400, message: 'bad file name (want "<stem>.puml")' };
    if (!/@startuml/i.test(text)) return { error: 400, message: 'not a PlantUML file (no @startuml)' };
    const active = [...this.jobs.values()]
      .filter((j) => ['queued', 'preprocess', 'route', 'postprocess'].includes(j.state));
    if (active.length >= MAX_ACTIVE_JOBS) return { error: 429, message: 'too many queued diagrams' };
    if (active.some((j) => j.name === name)) return { error: 409, message: `"${name}" is already queued or routing` };
    const job = {
      id: randomUUID(),
      name,
      text, // dropped right after preprocessing
      state: 'queued',
      progress: PROGRESS.queued,
      detail: '',
      error: null,
      createdAt: this.now(),
      doneAt: 0,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.broadcast({ type: 'job', ...this.snapshot(job) });
    this.drain();
    return { job };
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!this.jobs.has(job.id)) continue; // swept while queued
        await this.runJob(job);
      }
    } finally {
      this.draining = false;
    }
  }

  async runJob(job) {
    const dir = this.jobDir(job);
    try {
      mkdirSync(dir, { recursive: true });
      this.update(job, { state: 'preprocess', progress: PROGRESS.preprocess, detail: 'parsing + layout' });
      const { scene, spec } = prepareDiagram(job.text);
      job.text = null; // the source lives client-side (OPFS) from here on
      this.update(job, { state: 'route', progress: PROGRESS.route, detail: 'pass 1 (F.Cu)' });
      const res = await routeBoard({
        scene,
        spec,
        tmpDir: dir,
        base: job.name.slice(0, -'.puml'.length),
        routesPath: join(dir, 'routes.json'),
        runRouter: (specPath, sesPath, singleLayer) =>
          this.runRouter(specPath, sesPath, singleLayer),
        onStage: (stage, detail) => {
          if (detail === 'pass 2 (F.Cu+B.Cu)') {
            this.update(job, { detail, progress: PROGRESS.route2 });
          }
        },
      });
      this.update(job, { state: 'postprocess', progress: PROGRESS.postprocess, detail: 'writing routes' });
      for (const entry of readdirSync(dir)) { // keep only the artifact
        if (entry !== 'routes.json') rmSync(join(dir, entry), { recursive: true, force: true });
      }
      this.update(job, {
        state: 'done',
        progress: PROGRESS.done,
        detail: `${res.routed}/${res.nets} nets`,
        doneAt: this.now(),
      });
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      this.update(job, {
        state: 'error',
        detail: 'failed',
        error: safeMessage(err, this.uploadDir),
        doneAt: this.now(),
      });
    } finally {
      job.text = null;
    }
  }

  // The cleanup guarantee, in four passes: acked/dead dirs go immediately;
  // finished-but-unclaimed dirs after DONE_TTL; anything (whatever state)
  // after JOB_MAX_AGE. Called on an interval, at startup and at teardown.
  sweep() {
    const t = this.now();
    for (const job of [...this.jobs.values()]) {
      const dir = this.jobDir(job);
      if (t - job.createdAt > JOB_MAX_AGE_MS) {
        rmSync(dir, { recursive: true, force: true });
        this.jobs.delete(job.id);
        this.broadcast({ type: 'job', id: job.id, name: job.name, state: 'error', error: 'expired' });
      } else if ((job.state === 'done' || job.state === 'error') && t - job.doneAt > DONE_TTL_MS) {
        rmSync(dir, { recursive: true, force: true }); // no-op for error dirs
        this.jobs.delete(job.id);
      }
    }
  }

  sweepAll() { // startup/teardown: the scratch dir belongs to this process
    // clear contents, not the dir itself: it may be a tmpfs mount point
    let entries = [];
    try {
      entries = readdirSync(this.uploadDir);
    } catch { /* missing dir is as good as an empty one */ }
    for (const entry of entries) {
      rmSync(join(this.uploadDir, entry), { recursive: true, force: true });
    }
    mkdirSync(this.uploadDir, { recursive: true });
    this.jobs.clear();
    this.queue.length = 0;
  }

  routesFile(id) {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'done') return null;
    return join(this.uploadDir, id, 'routes.json');
  }

  ack(id) {
    const job = this.jobs.get(id);
    if (!job) return 404;
    if (job.state !== 'done') return 409;
    rmSync(this.jobDir(job), { recursive: true, force: true });
    this.jobs.delete(job.id);
    return 200;
  }
}

// The real toolchain runner: kicad_route.py (which in turn runs the
// Freerouting JVM). New process group so a timeout kills python AND java.
export function pythonRouter(timeoutMs = PASS_TIMEOUT_MS) {
  return (specPath, sesPath, singleLayer) => new Promise((resolve, reject) => {
    const args = [join(ROOT, 'tools', 'kicad_route.py'), specPath, sesPath];
    if (singleLayer) args.push('--single-layer');
    const child = spawn('python3', args, {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`routing pass timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`router killed (${signal})`));
      else if (code !== 0) reject(new Error(`kicad_route.py exited ${code}: ${lastLine(stderr)}`));
      else resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP surface

function json(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function fail(res, code, message) {
  json(res, code, { error: message });
}

function fileResponse(res, filePath, { method, cache = 'no-cache' } = {}) {
  let st;
  try { st = statSync(filePath); } catch { return false; }
  res.writeHead(200, {
    'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': st.size,
    'cache-control': cache,
  });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(filePath).pipe(res);
  return true;
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return; // discard the rest; caller answers 413
      size += c.length;
      if (size > cap) {
        tooBig = true;
        reject(Object.assign(new Error(`payload exceeds ${cap} bytes`), { code: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!tooBig) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

export function createUploadServer({
  root = ROOT,
  uploadDir = defaultUploadDir(),
  enabled = uploadEnabled(),
  runRouter = pythonRouter(),
  now = Date.now,
} = {}) {
  const service = new UploadService({ uploadDir, runRouter, now });

  // Static docroot serving with traversal + dotfile protection (mirrors the
  // darkhttpd docroot so the upload server can fully replace it in Docker).
  function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return fail(res, 400, 'bad path'); }
    if (rel.includes('\0')) return fail(res, 400, 'bad path');
    if (rel === '/' || rel === '') rel = '/index.html';
    const norm = normalize(rel);
    const segs = norm.split(sep).filter(Boolean);
    if (segs.some((s) => s === '..' || s.startsWith('.'))) return fail(res, 404, 'not found');
    const full = join(root, ...segs);
    if (!fileResponse(res, full, { method: req.method })) {
      return fail(res, 404, 'not found');
    }
    return true;
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) fail(res, 500, 'internal error');
      else res.destroy();
    });
  });

  async function handle(req, res) {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');

    if (pathname === '/api/features') {
      if (!enabled) return fail(res, 404, 'not found');
      return json(res, 200, { uploads: true, maxFiles: MAX_FILES });
    }
    if (!enabled && pathname.startsWith('/api/')) return fail(res, 404, 'not found');

    if (enabled && req.method === 'POST' && pathname === '/api/diagrams') {
      let body;
      try {
        body = await readBody(req, MAX_FILE_BYTES);
      } catch (err) {
        return fail(res, err.code ?? 400, err.message);
      }
      const result = service.submit(searchParams.get('name') ?? '', body.toString('utf8'));
      if (result.error) return fail(res, result.error, result.message);
      return json(res, 200, {
        id: result.job.id, name: result.job.name, state: result.job.state,
      });
    }
    if (enabled && req.method === 'GET' && pathname === '/api/jobs') {
      return json(res, 200, { jobs: service.list(), maxFiles: MAX_FILES });
    }
    const routeMatch = pathname.match(/^\/api\/diagrams\/([0-9a-f-]{36})\/(routes|ack)$/);
    if (enabled && routeMatch) {
      const [, id, action] = routeMatch;
      if (action === 'routes' && req.method === 'GET') {
        const file = service.routesFile(id);
        if (!file) return fail(res, 409, 'routes not ready (or already cleaned up)');
        if (!fileResponse(res, file, { method: req.method, cache: 'no-store' })) {
          return fail(res, 409, 'routes already cleaned up');
        }
        return true;
      }
      if (action === 'ack' && req.method === 'POST') {
        const code = service.ack(id);
        return code === 200 ? json(res, 200, { ok: true }) : fail(res, code, 'cannot ack');
      }
    }
    if (pathname.startsWith('/api/')) return fail(res, 404, 'not found');

    return serveStatic(req, res, pathname);
  }

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (!enabled || pathname !== '/api/progress' || !isUpgradeRequest(req)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const conn = wsUpgrade(req, socket);
    if (head?.length > 0) conn.feed(head);
    service.addClient(conn);
  });

  return { server, service };
}

// ---------------------------------------------------------------------------
// CLI entry point

function main() {
  const uploadDir = defaultUploadDir();
  const enabled = uploadEnabled();
  const port = Number(process.env.PORT ?? 8000);
  const host = process.env.HOST ?? '0.0.0.0';

  const { server, service } = createUploadServer({ uploadDir, enabled });
  service.sweepAll(); // orphaned scratch from a previous life is garbage

  const teardown = (signal) => {
    service.sweepAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
    console.log(`${signal}: swept uploads, closing`);
  };
  process.on('SIGINT', () => teardown('SIGINT'));
  process.on('SIGTERM', () => teardown('SIGTERM'));

  server.listen(port, host, () => {
    console.log(`serving ${ROOT} on http://${host}:${port}`);
    if (enabled) {
      console.log(`upload feature enabled (PUML_UPLOAD, scratch: ${uploadDir}, max ${MAX_FILES} files/batch)`);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
