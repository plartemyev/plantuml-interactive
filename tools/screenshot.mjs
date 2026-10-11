#!/usr/bin/env node
// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Headless screenshot driver over the DevTools protocol (no dependencies;
// uses Node's built-in WebSocket). Lets a screenshot run page JS first, so
// interactive states (hover, explode, ghosting) can be captured.
//
// usage: node tools/screenshot.mjs <url> <out.png> [eval-expression] [settle-ms]

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [, , url, out, evalExpr = '', settleMs = '1200'] = process.argv;

const chromium = spawn('chromium', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--window-size=1600,1000', '--hide-scrollbars',
  '--remote-debugging-port=0', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const port = await new Promise((resolve, reject) => {
  let buf = '';
  chromium.stderr.on('data', (d) => {
    buf += d;
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
    if (m) resolve(m[1]);
  });
  chromium.on('exit', () => reject(new Error('chromium exited early')));
  setTimeout(() => reject(new Error('no devtools port; stderr: ' + buf)), 10000);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// create a tab and connect to it
const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
const tab = await res.json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
};

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await send('Page.enable');
await send('Page.navigate', { url });
await sleep(Number(settleMs) + 800); // load + animations settle

if (evalExpr) {
  const r = await send('Runtime.evaluate', {
    expression: evalExpr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    console.error('eval failed:', JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails, null, 2));
  } else {
    console.log('eval:', JSON.stringify(r.result.value));
  }
  await sleep(Number(settleMs)); // let explode/ghost animations play out
}

if (process.env.MOUSE) {
  const [mx, my] = process.env.MOUSE.split(',').map(Number);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx, y: my });
  await sleep(400);
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('wrote', out);
ws.close();
chromium.kill();
process.exit(0);
