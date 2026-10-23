#!/usr/bin/env node
/* Tambola local relay — serves the pages and relays WebSocket messages. No internet, no npm packages.
 * All game logic runs in the HOST's browser page; this file only carries messages (see README.md).
 *
 *   /            host page ("Create a game")          /play    player page
 *   /host  (ws)  the one host socket (this computer only)
 *   /join  (ws)  player sockets
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PUBLIC = path.join(__dirname, 'public');
const FIRST_PORT = Number(process.env.PORT) || 8189;
const LAST_PORT = process.env.PORT ? FIRST_PORT : 8199;
const MAX_MSG = 256 * 1024;
const MAX_PLAYER_SOCKETS = 300;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

// ---------- minimal RFC 6455 WebSocket ----------
class WS {
  constructor(socket, onMessage, onClose) {
    this.socket = socket; this.onMessage = onMessage; this.onClose = onClose;
    this.buf = Buffer.alloc(0); this.frags = []; this.closed = false; this.lastPong = Date.now();
    socket.setNoDelay(true);
    socket.on('data', d => this._data(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }
  _closed() { if (this.closed) return; this.closed = true; try { this.socket.destroy(); } catch (e) {} this.onClose(); }
  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(MAX_MSG)) return this.close(1009); len = Number(big); off = 10; }
      if (len > MAX_MSG) return this.close(1009);
      if (!masked) return this.close(1002);            // clients must mask
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4), payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 0x8) { this.close(1000); return; }
      if (op === 0x9) { this._frame(0xA, payload); continue; }
      if (op === 0xA) { this.lastPong = Date.now(); continue; }
      if (op === 0x1 || op === 0x0) {
        if (op === 0x1) this.frags = [];
        this.frags.push(payload);
        if (fin) { const text = Buffer.concat(this.frags).toString('utf8'); this.frags = []; this.onMessage(text); }
      }
    }
  }
  _frame(op, payload) {
    if (this.closed) return;
    const n = payload.length; let h;
    if (n < 126) h = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
    try { this.socket.write(Buffer.concat([h, payload])); } catch (e) { this._closed(); }
  }
  sendText(s) { this._frame(0x1, Buffer.from(s, 'utf8')); }
  sendRaw(buf) { this._frame(0x1, buf); }
  ping() { this._frame(0x9, Buffer.alloc(0)); }
  close(code) {
    if (this.closed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code || 1000, 0);
    this._frame(0x8, p);
    setTimeout(() => this._closed(), 100);
  }
}

// ---------- network helpers ----------
function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) for (const n of nets[name] || []) {
    if (n.family === 'IPv4' && !n.internal) out.push({ ip: n.address, iface: name });
  }
  const rank = ip => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : /^169\.254\./.test(ip) ? 9 : 5);
  return out.sort((a, b) => rank(a.ip) - rank(b.ip));
}
function isLocalRequest(req) {
  if (process.env.ALLOW_REMOTE_HOST === '1') return true;
  const a = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1') return true;
  return lanAddresses().some(x => x.ip === a);       // the host page opened via this computer's own LAN IP
}

// ---------- state ----------
let host = null;                       // WS
const players = new Map();             // connId -> WS
let seq = 0;
let boundPort = FIRST_PORT;

function toHost(obj) { if (host) host.sendText(JSON.stringify(obj)); }
function statusToPlayers() { const s = JSON.stringify({ k: 'status', hostPresent: !!host }); players.forEach(ws => ws.sendText(s)); }

function onHostMessage(text) {
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m.k !== 'string') return;
  if (m.k === 'to' && m.m) { const ws = players.get(m.c); if (ws) ws.sendText(JSON.stringify(m.m)); }
  else if (m.k === 'many' && Array.isArray(m.cs) && m.m) {
    const buf = Buffer.from(JSON.stringify(m.m), 'utf8');       // serialise once, fan out
    for (const c of m.cs) { const ws = players.get(c); if (ws) ws.sendRaw(buf); }
  }
  else if (m.k === 'all' && m.m) { const buf = Buffer.from(JSON.stringify(m.m), 'utf8'); players.forEach(ws => ws.sendRaw(buf)); }
  else if (m.k === 'kick') { const ws = players.get(m.c); if (ws) setTimeout(() => ws.close(1000), 150); }
  else if (m.k === 'ping') toHost({ k: 'pong' });
}

function acceptWs(req, socket, onMessage, onClose) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return null; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  return new WS(socket, onMessage, onClose);
}

// ---------- http ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (p === '/info') {
    // CORS: a player's browser probing other IPs on the subnet (the "Nearby rooms" feature in
    // play.html) is a cross-origin request from the browser's perspective. Without this header the
    // request still reaches the server, but the browser silently refuses to let the page read the
    // response, making room discovery permanently fail. /info carries nothing sensitive (just LAN
    // IPs, a port number, and a boolean), so it's safe to expose to any origin on the LAN.
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ addresses: lanAddresses(), port: boundPort, hostPresent: !!host, localRequest: isLocalRequest(req) }));
  }
  if (p === '/') p = '/index.html';
  if (p === '/play') p = '/play.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname === '/host') {
    if (!isLocalRequest(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
    const old = host;
    const ws = acceptWs(req, socket, onHostMessage, () => { if (host === ws) { host = null; statusToPlayers(); } });
    if (!ws) return;
    host = ws;
    if (old) old.close(4000);                                   // a newer host page replaces the old one
    toHost({ k: 'hello', conns: Array.from(players.keys()) });
    statusToPlayers();
  } else if (pathname === '/join') {
    if (players.size >= MAX_PLAYER_SOCKETS) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return socket.destroy(); }
    const id = 'c' + (++seq);
    const ws = acceptWs(req, socket,
      text => {
        let m; try { m = JSON.parse(text); } catch (e) { return; }
        if (!m || typeof m !== 'object' || Array.isArray(m)) return;
        toHost({ k: 'msg', c: id, m });
      },
      () => { if (players.get(id) === ws) { players.delete(id); toHost({ k: 'close', c: id }); } });
    if (!ws) return;
    players.set(id, ws);
    ws.sendText(JSON.stringify({ k: 'status', hostPresent: !!host }));
    toHost({ k: 'open', c: id });
  } else { socket.destroy(); }
});

// drop dead sockets (phones that vanished without a close frame)
setInterval(() => {
  const now = Date.now();
  const all = Array.from(players.values()).concat(host ? [host] : []);
  all.forEach(ws => { if (now - ws.lastPong > 45000) ws._closed(); else ws.ping(); });
}, 15000).unref();

// ---------- start: port fallback 8189 -> 8199 ----------
function onListening() {
  boundPort = server.address().port;
  const port = boundPort, ips = lanAddresses();
  console.log('\n  Tambola is running (no internet needed).\n');
  console.log('  Host, open this on THIS computer:  http://localhost:' + port);
  ips.forEach(a => console.log('  Players join on the same Wi-Fi:    http://' + a.ip + ':' + port + '   (' + a.iface + ')'));
  if (!ips.length) console.log('  No Wi-Fi/LAN address found. Connect this computer to a network (or turn on its hotspot).');
  console.log('\n  Keep this window open while you play. Press Ctrl+C to stop.\n');
  if (!process.argv.includes('--no-open') && !process.env.NO_OPEN) openBrowser('http://localhost:' + port);
}
function onListenError(port) {
  return e => {
    if (e.code === 'EADDRINUSE' && port < LAST_PORT) return listen(port + 1);
    console.error(e.code === 'EADDRINUSE' ? `Ports ${FIRST_PORT}-${LAST_PORT} are all in use. Close other programs and try again.` : e.message);
    process.exit(1);
  };
}
let listeningHooked = false;
function listen(port) {
  if (!listeningHooked) { server.on('listening', onListening); listeningHooked = true; }
  server.removeAllListeners('error');
  server.once('error', onListenError(port));
  server.listen(port, '0.0.0.0');
}
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { execFile(cmd[0], cmd[1], () => {}); } catch (e) {}
}
if (require.main === module) listen(FIRST_PORT);
module.exports = { listen, server, get port() { return boundPort; } };
