// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Tests for the upload server (server/upload-server.mjs): feature gating,
// upload -> WebSocket progress -> routed artifact -> ack cleanup, limits,
// and the cleanup guarantees (TTL sweep, hard age cap, error dirs). The
// KiCad+Freerouting toolchain is replaced by a fake runRouter that writes a
// minimal valid .ses for the given board spec, so the real
// prepare/route/postprocess pipeline (parser, layout, boardgeo, chaining)
// runs end to end. Pure node — `node --test`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUploadServer } from '../server/upload-server.mjs';

// -- fixtures ---------------------------------------------------------------

const DIAGRAM = `@startuml uploaded
node "web" as web
database "db" as db
web --> db
@enduml
`;

// Writes a minimal Specctra .ses joining every net's two pads (world ->
// um: x1000, y mirrored). failPass1 leaves the first net out of the first
// pass so the pipeline must retry on two layers. slow delays each pass.
function fakeRouter({ failPass1 = false, slowMs = 0 } = {}) {
  let call = 0;
  return async (specPath, sesPath) => {
    call += 1;
    if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
    const spec = JSON.parse(await readFile(specPath, 'utf8'));
    const skip = failPass1 && call === 1 ? spec.nets[0]?.name : null;
    const nets = spec.nets
      .filter((n) => n.name !== skip)
      .map((n) => {
        const [a, b] = n.pads;
        const pts = `${a.x * 1000} ${-a.y * 1000} ${b.x * 1000} ${-b.y * 1000}`;
        return `(net ${n.name} (wire (path F.Cu 2000 ${pts})))`;
      });
    await writeFile(sesPath,
      `(session s (base_design s) (routes (resolution um 10) (network_out ${nets.join(' ')})))`);
  };
}

const readFile = async (p) => {
  const { readFileSync } = await import('node:fs');
  return readFileSync(p, 'utf8');
};

async function withServer(opts, fn) {
  const uploadDir = await mkdtemp(join(tmpdir(), 'puml-uploads-'));
  const { server, service } = createUploadServer({ enabled: true, uploadDir, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, service, uploadDir });
  } finally {
    await new Promise((r) => server.close(r));
    await rm(uploadDir, { recursive: true, force: true });
  }
}

async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

// WS test client: connects, records every event, resolves after the hello
// snapshot (so callers can act without racing the handshake).
async function connectWs(base) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/progress`);
  const events = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no hello snapshot')), 5000);
    ws.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      events.push(ev);
      if (ev.type === 'hello') {
        clearTimeout(timer);
        resolve();
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('ws error'));
    };
  });
  return { ws, events };
}

async function waitForEvent(events, want, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const found = events.find(want);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for event; got ${events.length}: ${JSON.stringify(events)}`);
}

// -- feature gating ---------------------------------------------------------

test('disabled feature: /api/* 404s, static serving still works', async () => {
  const uploadDir = await mkdtemp(join(tmpdir(), 'puml-uploads-'));
  const { server } = createUploadServer({ enabled: false, uploadDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/features`)).status, 404);
    assert.equal((await fetch(`${base}/api/jobs`)).status, 404);
    assert.equal(
      (await fetch(`${base}/api/diagrams?name=x.puml`, { method: 'POST', body: 'x' })).status,
      404,
    );
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const js = await fetch(`${base}/js/main.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /text\/javascript/);
    assert.equal((await fetch(`${base}/.git/config`)).status, 404);
    assert.equal((await fetch(`${base}/no-such-file.puml`)).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(uploadDir, { recursive: true, force: true });
  }
});

test('enabled feature: probe reports uploads + maxFiles', async () => {
  await withServer({ runRouter: fakeRouter() }, async ({ base }) => {
    const res = await fetch(`${base}/api/features`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { uploads: true, maxFiles: 100 });
  });
});

// -- the happy path: upload -> progress -> artifact -> ack ------------------

test('upload flows through real stages to a routed artifact and cleans up', async () => {
  await withServer({ runRouter: fakeRouter() }, async ({ base, service, uploadDir }) => {
    const { ws, events } = await connectWs(base);
    try {
      const res = await fetch(`${base}/api/diagrams?name=uploaded.puml`, {
        method: 'POST',
        body: DIAGRAM,
      });
      assert.equal(res.status, 200);
      const { id, name } = await res.json();
      assert.equal(name, 'uploaded.puml');

      await waitForEvent(events, (ev) => ev.type === 'job' && ev.id === id && ev.state === 'done');
      const mine = events.filter((e) => e.id === id);
      // every real stage, in pipeline order, with monotonic progress
      assert.deepEqual(mine.map((e) => e.state),
        ['queued', 'preprocess', 'route', 'postprocess', 'done']);
      for (let i = 1; i < mine.length; i++) {
        assert.ok(mine[i].progress >= mine[i - 1].progress, 'progress must not go backwards');
      }
      const done = mine[mine.length - 1];
      assert.equal(done.progress, 1);
      assert.equal(done.detail, '1/1 nets');
    } finally {
      ws.close();
    }

    // artifact: fetchable, valid, and the ONLY thing left in the scratch dir
    const id = service.list()[0]?.id;
    const routesRes = await fetch(`${base}/api/diagrams/${id}/routes`);
    assert.equal(routesRes.status, 200);
    const routes = await routesRes.json();
    assert.equal(routes.version, 1);
    assert.equal(Object.keys(routes.nets).length, 1);
    assert.deepEqual(await readdir(join(uploadDir, id)), ['routes.json']);

    // ack: instant cleanup, then the artifact is gone
    assert.equal((await fetch(`${base}/api/diagrams/${id}/ack`, { method: 'POST' })).status, 200);
    assert.equal(existsSync(join(uploadDir, id)), false);
    assert.equal(service.jobs.size, 0);
    assert.equal((await fetch(`${base}/api/diagrams/${id}/routes`)).status, 409);
  });
});

test('unroutable pass 1 triggers the real second pass on both layers', async () => {
  await withServer({ runRouter: fakeRouter({ failPass1: true }) }, async ({ base, uploadDir }) => {
    const { ws, events } = await connectWs(base);
    let id;
    try {
      const res = await fetch(`${base}/api/diagrams?name=two-pass.puml`, {
        method: 'POST',
        body: DIAGRAM,
      });
      id = (await res.json()).id;
      await waitForEvent(events, (ev) => ev.type === 'job' && ev.id === id && ev.state === 'done');
      const route2 = events.find((e) => e.id === id && e.detail === 'pass 2 (F.Cu+B.Cu)');
      assert.ok(route2, 'pass-2 stage must be reported');
      assert.equal(route2.progress, 0.45);
    } finally {
      ws.close();
    }
    // the artifact is still complete: the retry routed the skipped net
    const routes = await (await fetch(`${base}/api/diagrams/${id}/routes`)).json();
    assert.equal(Object.keys(routes.nets).length, 1);
    assert.equal(existsSync(join(uploadDir, id, 'routes.json')), true);
  });
});

// -- validation -------------------------------------------------------------

test('upload validation: bad names, non-plantuml bodies, oversize payloads', async () => {
  await withServer({ runRouter: fakeRouter() }, async ({ base }) => {
    const post = (name, body) =>
      fetch(`${base}/api/diagrams?name=${encodeURIComponent(name)}`, { method: 'POST', body });

    assert.equal((await post('', DIAGRAM)).status, 400);
    // traversal attempts are defused by basename stripping, not rejected
    const evil = await post('../evil.puml', DIAGRAM);
    assert.equal(evil.status, 200);
    assert.equal((await evil.json()).name, 'evil.puml');
    assert.equal((await post('no extension', DIAGRAM)).status, 400);
    assert.equal((await post('ok.puml', 'just some text, honestly')).status, 400);

    const big = Buffer.alloc((2 << 20) + 2, 0x78);
    const res = await post('big.puml', big);
    assert.equal(res.status, 413);
  });
});

test('duplicate active names are rejected while the first job is running', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowRouter = async (...args) => {
    await gate;
    return fakeRouter()(...args);
  };
  await withServer({ runRouter: slowRouter }, async ({ base, service }) => {
    const first = service.submit('dup.puml', DIAGRAM);
    assert.ok(first.job, 'first submit succeeds');
    assert.equal((await service.submit('dup.puml', DIAGRAM)).error, 409);
    release();
    assert.ok(await waitFor(() => service.jobs.get(first.job.id)?.state === 'done'));
    // after completion the name is free again
    assert.ok(service.submit('dup.puml', DIAGRAM).job);
  });
});

test('the active-job cap rejects further uploads with 429', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowRouter = async (...args) => {
    await gate;
    return fakeRouter()(...args);
  };
  await withServer({ runRouter: slowRouter }, async ({ service }) => {
    for (let i = 0; i < 100; i++) {
      assert.ok(service.submit(`job-${i}.puml`, DIAGRAM).job, `job ${i} accepted`);
    }
    assert.equal(service.submit('job-100.puml', DIAGRAM).error, 429);
    release();
    // done jobs linger until ack/TTL by design; wait until nothing is active
    assert.ok(await waitFor(() => service.list().every((j) => j.state === 'done')));
  });
});

// -- cleanup guarantees -----------------------------------------------------

test('failed jobs remove their scratch dir and surface a sanitized error', async () => {
  await withServer({
    runRouter: async () => {
      throw new Error(`kicad blew up at ${join('some', 'secret', 'path')}`);
    },
  }, async ({ base, service, uploadDir }) => {
    const { ws, events } = await connectWs(base);
    try {
      const { id } = await service.submit('broken.puml', DIAGRAM).job;
      const err = await waitForEvent(events, (ev) => ev.type === 'job' && ev.id === id && ev.state === 'error');
      assert.match(err.error, /kicad blew up/);
    } finally {
      ws.close();
    }
    const id = service.list()[0]?.id;
    assert.equal(existsSync(join(uploadDir, id)), false);
    assert.equal((await fetch(`${base}/api/diagrams/${id}/routes`)).status, 409);
  });
});

test('finished-but-unclaimed dirs are swept after the done TTL', async () => {
  await withServer({ runRouter: fakeRouter() }, async ({ service, uploadDir }) => {
    const { job } = service.submit('ttl.puml', DIAGRAM);
    assert.ok(await waitFor(() => service.jobs.get(job.id)?.state === 'done'));
    assert.equal(existsSync(join(uploadDir, job.id, 'routes.json')), true);

    job.doneAt -= 10 * 60_000 + 1; // age past DONE_TTL_MS
    service.sweep();
    assert.equal(service.jobs.size, 0);
    assert.equal(existsSync(join(uploadDir, job.id)), false);
  });
});

test('the hard age cap removes anything, whatever its state', async () => {
  await withServer({ runRouter: fakeRouter() }, async ({ service, uploadDir }) => {
    const { job } = service.submit('ancient.puml', DIAGRAM);
    assert.ok(await waitFor(() => service.jobs.get(job.id)?.state === 'done'));
    job.createdAt -= 2 * 3_600_000 + 1; // age past JOB_MAX_AGE_MS
    service.sweep();
    assert.equal(service.jobs.has(job.id), false);
    assert.equal(existsSync(join(uploadDir, job.id)), false);
  });
});

test('queued jobs swept by age never run', async () => {
  let released = false;
  const gate = new Promise((r) => {
    setTimeout(r, 50);
    setTimeout(() => { released = true; }, 60);
  });
  await withServer({
    runRouter: async (...args) => { await gate; return fakeRouter()(...args); },
  }, async ({ service, uploadDir }) => {
    const { job } = service.submit('swept.puml', DIAGRAM);
    job.createdAt -= 2 * 3_600_000 + 1;
    service.sweep(); // removes the record + dir; drain skips it
    await waitFor(() => released);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(existsSync(join(uploadDir, job.id)), false);
  });
});

test('startup/teardown sweepAll wipes the whole scratch dir', async () => {
  await withServer({ runRouter: fakeRouter() }, async ({ service, uploadDir }) => {
    const orphan = join(uploadDir, 'deadbeef');
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, 'routes.json'), '{}');
    service.sweepAll();
    assert.deepEqual(await readdir(uploadDir), []);
    assert.equal(service.jobs.size, 0);
  });
});

// -- live status channel ----------------------------------------------------

test('progress clients get a hello snapshot of running jobs', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowRouter = async (...args) => {
    await gate;
    return fakeRouter()(...args);
  };
  await withServer({ runRouter: slowRouter }, async ({ base, service }) => {
    const { job } = service.submit('live.puml', DIAGRAM);
    assert.ok(await waitFor(() => ['route', 'postprocess'].includes(service.jobs.get(job.id)?.state)));
    const hello = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/api/progress`);
      const timer = setTimeout(() => reject(new Error('no hello')), 3000);
      ws.onmessage = (e) => {
        clearTimeout(timer);
        resolve(JSON.parse(e.data));
        ws.close();
      };
      ws.onerror = () => reject(new Error('ws error'));
    });
    assert.equal(hello.type, 'hello');
    assert.equal(hello.jobs.length, 1);
    assert.equal(hello.jobs[0].id, job.id);
    assert.equal(hello.jobs[0].name, 'live.puml');
    release();
  });
});

test('WS clients are dropped from the broadcast set on disconnect', async () => {
  await withServer({ runRouter: fakeRouter() }, async ({ base, service }) => {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/api/progress`);
      ws.onmessage = () => { // hello
        resolve();
        ws.close();
      };
      ws.onerror = () => reject(new Error('ws error'));
    });
    assert.ok(await waitFor(() => service.clients.size === 0));
  });
});
