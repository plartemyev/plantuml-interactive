// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Tests for the minimal WebSocket server side (server/lib/ws.mjs): handshake
// key, frame codec, parser edge cases (fragmentation, interleaved control
// frames, masking, close handshake) and a live round-trip against Node's own
// WebSocket client. Pure node — `node --test`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';

import { acceptKey, encodeFrame, WsParser, isUpgradeRequest, upgrade } from '../server/lib/ws.mjs';

// -- codec ------------------------------------------------------------------

test('acceptKey matches the RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('encodeFrame: FIN set, small payloads use the short length form', () => {
  const frame = encodeFrame(0x1, Buffer.from('hi'));
  assert.deepEqual([...frame], [0x81, 2, 0x68, 0x69]);
});

test('encodeFrame: medium and large payloads use extended lengths', () => {
  const mid = encodeFrame(0x1, Buffer.alloc(300));
  assert.equal(mid[1], 126);
  assert.equal(mid.readUInt16BE(2), 300);

  const big = encodeFrame(0x1, Buffer.alloc(70_000));
  assert.equal(big[1], 127);
  assert.equal(big.readBigUInt64BE(2), 70_000n);
});

// -- parser -----------------------------------------------------------------

// Client frames MUST be masked (RFC 6455 §5.3).
function clientFrame(opcode, payload, { fin = true, mask = Buffer.from([10, 20, 30, 40]) } = {}) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]);
  } else if (len < 1 << 16) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

function feed(parser, ...frames) {
  for (const f of frames) parser.feed(f);
}

test('parser: masked text frame arrives as a message', () => {
  const parser = new WsParser();
  const got = [];
  parser.on('message', (m) => got.push(m));
  feed(parser, clientFrame(0x1, Buffer.from('{"type":"job"}')));
  assert.deepEqual(got, ['{"type":"job"}']);
});

test('parser: split feed and fragmented messages reassemble', () => {
  const parser = new WsParser();
  const got = [];
  parser.on('message', (m) => got.push(m));
  const whole = clientFrame(0x1, Buffer.from('abcdef'));
  parser.feed(whole.subarray(0, 3)); // mid-header
  parser.feed(whole.subarray(3, 7)); // mid-mask
  parser.feed(whole.subarray(7)); // mid-payload
  feed(
    parser,
    clientFrame(0x1, Buffer.from('he'), { fin: false }),
    clientFrame(0x0, Buffer.from('llo')),
  );
  assert.deepEqual(got, ['abcdef', 'hello']);
});

test('parser: control frames interleave with fragments, pings answered by caller', () => {
  const parser = new WsParser();
  const got = [];
  const pings = [];
  parser.on('message', (m) => got.push(m));
  parser.on('ping', (p) => pings.push(p.toString()));
  feed(
    parser,
    clientFrame(0x1, Buffer.from('ab'), { fin: false }),
    clientFrame(0x9, Buffer.from('ping!')),
    clientFrame(0x0, Buffer.from('cd')),
  );
  assert.deepEqual(got, ['abcd']);
  assert.deepEqual(pings, ['ping!']);
});

test('parser: close frames surface with code and reason', () => {
  const parser = new WsParser();
  const closed = [];
  parser.on('close', (code, reason) => closed.push([code, reason]));
  const body = Buffer.alloc(2 + Buffer.byteLength('bye'));
  body.writeUInt16BE(1001, 0);
  body.write('bye', 2);
  feed(parser, clientFrame(0x8, body));
  assert.equal(parser.closed, true);
  assert.deepEqual(closed, [[1001, 'bye']]);
});

test('parser: unmasked client frames and stray continuations are protocol errors', () => {
  for (const bad of [
    (() => { const f = encodeFrame(0x1, Buffer.from('x')); f[1] |= 0x80 ^ 0x80; return f; })(), // unmasked
    clientFrame(0x0, Buffer.from('orphan')), // continuation without start
  ]) {
    const parser = new WsParser();
    const errs = [];
    parser.on('error', (e) => errs.push(e));
    parser.feed(bad);
    assert.equal(errs.length, 1);
    assert.equal(parser.closed, true);
  }
});

test('parser: oversized frames are rejected', () => {
  const parser = new WsParser();
  const errs = [];
  parser.on('error', (e) => errs.push(e));
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(1n << 40n, 2);
  parser.feed(Buffer.concat([header, Buffer.alloc(4)]));
  assert.match(String(errs[0]), /too large/);
});

// -- live round-trip --------------------------------------------------------

test('upgrade: handshake + two-way text against the Node WebSocket client', async () => {
  const server = createServer(() => {});
  const received = [];
  const connections = new Set();
  server.on('upgrade', (req, socket, head) => {
    assert.equal(isUpgradeRequest(req), true);
    const conn = upgrade(req, socket);
    if (head?.length) conn.feed(head);
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
    conn.on('message', (text) => received.push(text));
    conn.sendText(JSON.stringify({ hello: true }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${server.address().port}/`;
  try {
    const ws = new WebSocket(url);
    const opened = new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    await opened;
    const fromServer = await new Promise((r) => { ws.onmessage = (e) => r(e.data); });
    assert.deepEqual(JSON.parse(fromServer), { hello: true });
    ws.send('ping-from-client');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(received, ['ping-from-client']);
    const closedState = new Promise((r) => { ws.onclose = r; });
    ws.close();
    await closedState;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(connections.size, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('upgrade: bogus requests are rejected before any handshake', async () => {
  const server = createServer(() => {});
  let upgraded = false;
  server.on('upgrade', (req, socket) => {
    if (!isUpgradeRequest(req)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    upgraded = true;
    upgrade(req, socket);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    // raw socket: an upgrade request missing key + version
    const status = await new Promise((resolve, reject) => {
      const sock = connect(server.address().port, '127.0.0.1', () => {
        sock.write('GET /api/progress HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      });
      sock.on('data', (c) => {
        resolve(String(c).split('\r\n')[0]);
        sock.destroy();
      });
      sock.on('error', reject);
    });
    assert.match(status, /400/);
    assert.equal(upgraded, false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
