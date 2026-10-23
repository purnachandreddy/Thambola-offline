// Relay + port-fallback + 90-client load test against the REAL server.js (10_RELIABILITY_EDGE_CASES.md section 7).
// Run: node --test tests/server.test.js
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');

function startServer(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--no-open'], { env: Object.assign({}, process.env, env) });
    let out = '';
    p.stdout.on('data', d => { out += d; const m = out.match(/localhost:(\d+)/); if (m) resolve({ p, port: +m[1] }); });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', c => reject(new Error('server exited ' + c + ' ' + out)));
    setTimeout(() => reject(new Error('timeout ' + out)), 5000);
  });
}
const open = url => new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(ws); ws.onerror = () => rej(new Error('ws error ' + url)); });
const nextMsg = ws => new Promise(res => { ws.addEventListener('message', e => res(JSON.parse(e.data)), { once: true }); });

test('port fallback: 8189 occupied -> uses 8190', async () => {
  const blocker = net.createServer().listen(8189, '0.0.0.0');
  await new Promise(r => blocker.once('listening', r));
  const { p, port } = await startServer({});
  try { assert.strictEqual(port, 8190); } finally { p.kill(); blocker.close(); }
});

test('serves host page, player page, /info; blocks path traversal', async () => {
  const { p, port } = await startServer({});
  try {
    for (const [u, code] of [['/', 200], ['/play', 200], ['/info', 200], ['/engine.js', 200], ['/nope', 404]]) {
      const r = await fetch('http://127.0.0.1:' + port + u); assert.strictEqual(r.status, code, u);
    }
    const r = await fetch('http://127.0.0.1:' + port + '/..%2fserver.js'); assert.notStrictEqual(r.status, 200);
  } finally { p.kill(); }
});

test('/info sends CORS headers so a player\'s browser can read it when probing OTHER IPs on the subnet (the "Nearby rooms" feature)', async () => {
  const { p, port } = await startServer({});
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/info');
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*', 'without this header, a cross-origin fetch() succeeds at the network level but the browser blocks JS from reading the response, so room discovery would silently always report nothing found');
    const body = await r.json();
    assert.ok(Array.isArray(body.addresses));
    assert.strictEqual(typeof body.hostPresent, 'boolean');
  } finally { p.kill(); }
});

test('relay: player->host framing, host->player, kick, close events, host replacement', async () => {
  const { p, port } = await startServer({});
  try {
    const host = await open('ws://127.0.0.1:' + port + '/host');
    const hello = await nextMsg(host); assert.strictEqual(hello.k, 'hello');
    const evP = nextMsg(host);
    const pl = await open('ws://127.0.0.1:' + port + '/join');
    const st = await nextMsg(pl); assert.deepStrictEqual(st, { k: 'status', hostPresent: true });
    const opened = await evP; assert.strictEqual(opened.k, 'open'); const cid = opened.c;
    const mP = nextMsg(host); pl.send(JSON.stringify({ type: 'JOIN_ROOM', payload: { x: 1 } }));
    const fm = await mP; assert.deepStrictEqual(fm, { k: 'msg', c: cid, m: { type: 'JOIN_ROOM', payload: { x: 1 } } });
    const rP = nextMsg(pl); host.send(JSON.stringify({ k: 'to', c: cid, m: { type: 'JOIN_APPROVED', payload: {} } }));
    assert.strictEqual((await rP).type, 'JOIN_APPROVED');
    // garbage from player is ignored, non-JSON dropped
    pl.send('not json'); pl.send('[1,2]');
    const cP = nextMsg(host); const closed = new Promise(r => { pl.onclose = r; });
    host.send(JSON.stringify({ k: 'kick', c: cid }));
    await closed; const ce = await cP; assert.deepStrictEqual(ce, { k: 'close', c: cid });
    // a second host replaces the first
    const first = new Promise(r => { host.onclose = r; });
    const host2 = await open('ws://127.0.0.1:' + port + '/host'); await first;
    host2.close();
  } finally { p.kill(); }
});

test('LOAD: 90 concurrent players all receive one broadcast within 200ms of each other', async () => {
  const { p, port } = await startServer({});
  try {
    const host = await open('ws://127.0.0.1:' + port + '/host');
    const conns = [];
    const N = 90, arrivals = [];
    const sockets = await Promise.all(Array.from({ length: N }, () => open('ws://127.0.0.1:' + port + '/join')));
    sockets.forEach((ws, i) => ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.type === 'NUMBER_CALLED') arrivals[i] = performance.now(); }));
    await new Promise(r => setTimeout(r, 400));
    // host learns about all ids from open events
    const ids = await new Promise(res => {
      const got = new Set(); host.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.k === 'open') got.add(m.c); if (got.size === N) res([...got]); });
      // events already delivered before listener? re-request via reconnect hello
      host.close(); const h2 = new WebSocket('ws://127.0.0.1:' + port + '/host');
      h2.onmessage = ev => { const m = JSON.parse(ev.data); if (m.k === 'hello') { host2 = h2; res(m.conns); } };
    });
    assert.strictEqual(ids.length, N);
    host2.send(JSON.stringify({ k: 'many', cs: ids, m: { type: 'NUMBER_CALLED', payload: { number: 42, calledNumbersSoFar: [42], callIndex: 1 }, timestamp: Date.now() } }));
    await new Promise(r => setTimeout(r, 800));
    const got = arrivals.filter(Boolean);
    assert.strictEqual(got.length, N, 'every client got the broadcast');
    const spread = Math.max(...got) - Math.min(...got);
    console.log('   broadcast spread across 90 clients: ' + spread.toFixed(1) + ' ms');
    assert.ok(spread < 200, 'spread ' + spread);
    sockets.forEach(s => s.close()); host2.close();
  } finally { p.kill(); }
});
let host2;
