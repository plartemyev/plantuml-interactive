// plantuml-interactive is free software: GNU LGPL v3 (or later) — see LICENSE.
// SPDX-License-Identifier: LGPL-3.0-or-later
// Copyright (C) 2026 Pavel Artemyev <a@pavel.bz>

// Minimal RFC 6455 WebSocket server side, no dependencies: enough for the
// upload server's progress channel (small server->client text frames, tiny
// client->server traffic). Covers the handshake, masked client frames,
// fragmentation, ping/pong and the close handshake.
//
// Not a general-purpose WS implementation: no extensions (no permessage
// deflate), no 64-bit payload splittings beyond what Number holds (frames
// are capped far below that anyway), binary frames arrive as strings.

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 1 << 20; // 1 MiB: progress JSON is tiny

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

// True when the HTTP request is a well-formed RFC 6455 upgrade for our use.
export function isUpgradeRequest(req) {
  return req.method === 'GET'
    && (req.headers.upgrade ?? '').toLowerCase() === 'websocket'
    && (req.headers.connection ?? '').toLowerCase().includes('upgrade')
    && (req.headers['sec-websocket-key'] ?? '').length >= 16
    && req.headers['sec-websocket-version'] === '13';
}

export function handshakeHeaders(key) {
  return 'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`;
}

// Encode one server->client frame (unmasked, as the RFC requires).
export function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 1 << 16) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

// Incremental frame parser for one socket. Feeds buffers, emits events:
// 'message' (full text message, fragments assembled), 'ping', 'pong',
// 'close' (code, reason), 'error' (protocol violations). Auto-replies to
// pings; callers send the close reply on 'close' request via sendFrame.
export class WsParser extends EventEmitter {
  constructor() {
    super();
    this.buf = Buffer.alloc(0);
    this.fragments = null; // { opcode, chunks: Buffer[] } while assembling
    this.closed = false;
  }

  feed(chunk) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      while (this.parseFrame()) { /* drain */ }
    } catch (err) {
      this.closed = true;
      this.emit('error', err);
    }
  }

  // Attempts one frame; returns false when more bytes are needed.
  parseFrame() {
    const buf = this.buf;
    if (buf.length < 2) return false;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return false;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return false;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error('frame too large');
      len = Number(big);
      off = 10;
    }
    if (len > MAX_MESSAGE_BYTES) throw new Error('frame too large');
    let mask = null;
    if (masked) {
      if (buf.length < off + 4) return false;
      mask = buf.subarray(off, off + 4);
      off += 4;
    } else {
      // clients MUST mask; a server receiving unmasked frames has a
      // protocol violation (RFC 6455 §5.1)
      throw new Error('unmasked client frame');
    }
    if (buf.length < off + len) return false;
    const payload = Buffer.from(buf.subarray(off, off + len)); // copy: unmask
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    this.buf = buf.subarray(off + len);

    if (opcode >= OP_CLOSE) return this.handleControl(opcode, fin, payload);
    return this.handleData(opcode, fin, payload);
  }

  handleControl(opcode, fin, payload) {
    if (!fin || payload.length > 125) throw new Error('bad control frame');
    if (opcode === OP_PING) {
      this.emit('ping', payload);
    } else if (opcode === OP_PONG) {
      this.emit('pong', payload);
    } else if (opcode === OP_CLOSE) {
      this.closed = true;
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      this.emit('close', code, payload.subarray(2).toString('utf8'));
    }
    return true;
  }

  handleData(opcode, fin, payload) {
    if (this.fragments) {
      if (opcode !== OP_CONT) throw new Error('interleaved data frame');
      this.fragments.chunks.push(payload);
    } else if (opcode === OP_CONT) {
      throw new Error('continuation without start');
    } else {
      this.fragments = { opcode, chunks: [payload] };
    }
    if (!fin) return true;
    const { opcode: op, chunks } = this.fragments;
    this.fragments = null;
    const whole = Buffer.concat(chunks);
    if (whole.length > MAX_MESSAGE_BYTES) throw new Error('message too large');
    if (op === OP_TEXT) this.emit('message', whole.toString('utf8'));
    return true;
  }
}

// Complete the upgrade on a raw socket. Returns a small send/close surface
// plus the parser; the caller wires parser events and socket lifecycle.
export function upgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  socket.write(handshakeHeaders(key));
  socket.setNoDelay(true);

  const parser = new WsParser();
  const api = new EventEmitter();
  let finished = false;
  // One close path for every reason (peer close frame, protocol error,
  // socket end/reset): reply with a close frame, then force-destroy shortly
  // after so a half-closed TCP peer cannot wedge the connection.
  const finish = (code, reason) => {
    if (finished) return;
    finished = true;
    parser.closed = true;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    if (socket.writable) socket.end(encodeFrame(OP_CLOSE, body));
    const t = setTimeout(() => socket.destroy(), 1000);
    t.unref?.();
  };

  api.sendText = (text) => {
    if (!finished) socket.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8')));
  };
  api.sendPong = (payload) => {
    if (!finished) socket.write(encodeFrame(OP_PONG, payload));
  };
  api.close = (code = 1000, reason = '') => finish(code, reason);
  api.feed = (chunk) => parser.feed(chunk); // bytes already buffered by the http server

  socket.on('data', (chunk) => {
    if (!parser.closed) parser.feed(chunk);
  });
  socket.on('end', () => {
    finish(1006, 'abnormal');
    api.emit('close', 1006, 'abnormal');
  });
  socket.on('close', () => {
    finish(1006, 'reset');
    api.emit('close', 1006, 'reset');
  });
  socket.on('error', () => {
    finish(1006, 'socket error');
    api.emit('close', 1006, 'socket error');
  });
  parser.on('message', (text) => api.emit('message', text));
  parser.on('ping', (payload) => api.sendPong(payload));
  parser.on('close', (code, reason) => {
    finish(code === 1005 ? 1000 : code, reason); // echo the close handshake
    api.emit('close', code, reason);
  });
  parser.on('error', (err) => {
    finish(1002, 'protocol error');
    api.emit('close', 1002, err.message);
  });
  return api;
}
