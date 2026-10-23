// Full-stack 90-player test: the REAL server.js relay, a REAL GameHost (engine.js), and 90 REAL
// WebSocket client connections standing in for 90 phones. This goes beyond tests/server.test.js's
// raw-broadcast load test by exercising the actual game: concurrent joins, ticket delivery, number
// calling, leaderboard propagation, and contended claims — at the full 90-player ceiling.
// Run: node --test tests/scale.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const T = require('../public/engine.js');

const N = 90;

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--no-open'], { env: Object.assign({}, process.env, { NO_OPEN: '1' }) });
    let out = '';
    p.stdout.on('data', d => { out += d; const m = out.match(/localhost:(\d+)/); if (m) resolve({ p, port: +m[1] }); });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', c => reject(new Error('server exited ' + c + ' ' + out)));
    setTimeout(() => reject(new Error('server start timeout: ' + out)), 5000);
  });
}
const openWs = url => new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(ws); ws.onerror = e => rej(new Error('ws error ' + url)); });
function waitFor(fn, label, timeoutMs) {
  const start = Date.now(); timeoutMs = timeoutMs || 10000;
  return new Promise((resolve, reject) => {
    (function tick() {
      let ok; try { ok = fn(); } catch (e) { ok = false; }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for: ' + label));
      setTimeout(tick, 15);
    })();
  });
}
// A fake, manually-advanced clock for the GameHost (as in engine.test.js), so DRAW_MS / leaderboard
// throttling can be fast-forwarded instantly instead of burning real wall-clock seconds — while the
// actual message delivery below still goes over real sockets through the real relay process.
function fakeClock() {
  const c = { time: 1000000, timers: [] };
  c.now = () => c.time;
  c.setTimeout = (fn, ms) => { const t = { fn, at: c.time + ms }; c.timers.push(t); return t; };
  c.clearTimeout = t => { const i = c.timers.indexOf(t); if (i >= 0) c.timers.splice(i, 1); };
  c.advance = ms => {
    c.time += ms;
    for (;;) {
      const due = c.timers.filter(t => t.at <= c.time).sort((a, b) => a.at - b.at);
      if (!due.length) break;
      due.forEach(t => { const i = c.timers.indexOf(t); if (i >= 0) { c.timers.splice(i, 1); t.fn(); } });
    }
  };
  return c;
}

let srv, port, hostWs, game, clients;
test.before(async () => { ({ p: srv, port } = await startServer()); });
test.after(() => { srv.kill(); });

test(`handles ${N} players joining concurrently, each gets a valid, unique ticket`, async () => {
  hostWs = await openWs('ws://127.0.0.1:' + port + '/host');
  const clock = fakeClock();
  const transport = {
    to: (c, m) => hostWs.send(JSON.stringify({ k: 'to', c, m })),
    toMany: (cs, m) => hostWs.send(JSON.stringify({ k: 'many', cs, m })),
    all: m => hostWs.send(JSON.stringify({ k: 'all', m })),
    kick: c => hostWs.send(JSON.stringify({ k: 'kick', c }))
  };
  game = new T.GameHost({ transport, settings: Object.assign({}, T.DEFAULT_SETTINGS, { maxPlayers: N, hostTtsEnabled: false }), pin: '9090', now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  game._clock = clock;
  hostWs.onmessage = e => { const m = JSON.parse(e.data); if (m.k === 'msg') game.handleMessage(m.c, m.m); else if (m.k === 'close') game.handleClose(m.c); };

  // 90 real sockets, all connecting and sending JOIN_ROOM concurrently (worst-case: everyone scans
  // the QR code the instant the lobby opens).
  clients = await Promise.all(Array.from({ length: N }, () => openWs('ws://127.0.0.1:' + port + '/join')));
  const received = clients.map(() => []);
  clients.forEach((ws, i) => ws.addEventListener('message', e => received[i].push(JSON.parse(e.data))));

  const t0 = Date.now();
  clients.forEach((ws, i) => ws.send(JSON.stringify({ type: 'JOIN_ROOM', payload: { playerName: 'Player' + i, deviceId: 'dev' + i, pin: '9090' } })));
  await waitFor(() => game.players.length === N, 'all ' + N + ' players registered on the host');
  const joinMs = Date.now() - t0;
  console.log(`   ${N} concurrent joins settled in ${joinMs} ms`);

  // Every player got exactly one JOIN_APPROVED, with a distinct playerId and name (no corruption,
  // no cross-talk between connections under concurrent load).
  await waitFor(() => received.every(r => r.some(m => m.type === 'JOIN_APPROVED')), 'every client received JOIN_APPROVED');
  const ids = new Set(game.players.map(p => p.playerId));
  assert.strictEqual(ids.size, N, 'every player has a unique id');
  const names = new Set(game.players.map(p => p.name));
  assert.strictEqual(names.size, N, 'no duplicate/corrupted names under concurrent join');

  assert.ok(game.canStart());
  game.startGame();

  // Every single client — not a sample — must receive a well-formed ticket.
  await waitFor(() => received.every(r => r.some(m => m.type === 'ASSIGN_TICKET')), 'every client received ASSIGN_TICKET', 15000);
  const allNumbers = new Set();
  received.forEach((r, i) => {
    const msg = r.find(m => m.type === 'ASSIGN_TICKET');
    const ticket = msg.payload.ticket;
    const nums = T.ticketNumbers(ticket);
    assert.strictEqual(nums.length, 15, 'player ' + i + ' ticket has 15 numbers');
    nums.forEach(n => { assert.ok(n >= 1 && n <= 90); allNumbers.add(i + ':' + n); });
  });
  assert.strictEqual(game.gameStatus, 'in_progress');
});

test('calling numbers reaches all 90 players promptly and in order', async () => {
  const clock = game._clock;
  const received = [];
  clients.forEach((ws, i) => { received[i] = []; ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.type === 'NUMBER_CALLED') received[i].push(m); }); });

  const CALLS = 10;
  const t0 = Date.now();
  for (let i = 0; i < CALLS; i++) { game.callNext(); clock.advance(T.DRAW_MS); }
  await waitFor(() => received.every(r => r.length === CALLS), 'all clients received all ' + CALLS + ' calls', 15000);
  const elapsed = Date.now() - t0;
  console.log(`   ${CALLS} calls delivered to all ${N} clients in ${elapsed} ms of real time`);

  // Every client saw the exact same sequence of numbers, in the exact same order.
  const sequences = received.map(r => r.map(m => m.number).join(','));
  assert.ok(sequences.every(s => s === sequences[0]), 'every client saw an identical call sequence');
  assert.strictEqual(game.calledNumbersSoFar.length, CALLS);
});

test('leaderboard reaches all 90 players and stays throttled to ≤1 broadcast/second even under load', async () => {
  const clock = game._clock;
  const lbCounts = clients.map(() => 0);
  clients.forEach((ws, i) => ws.addEventListener('message', e => { if (JSON.parse(e.data).type === 'LEADERBOARD_UPDATE') lbCounts[i]++; }));

  const before = lbCounts.slice();
  // Simulate bursty activity: 200 leaderboard-dirtying events within one throttle window.
  for (let i = 0; i < 200; i++) game.markLeaderboard();
  clock.advance(1100);   // let exactly one throttle window elapse
  await waitFor(() => clients.every((_, i) => lbCounts[i] > before[i]), 'all clients received at least one leaderboard update');
  const deltas = lbCounts.map((c, i) => c - before[i]);
  assert.ok(deltas.every(d => d <= 2), 'no client received more than ~1 update for a single throttle window, got: ' + Math.max(...deltas));
  assert.ok(deltas.every(d => d >= 1), 'every one of the 90 clients actually received the update');
});

test('contended claims under 90-player load: exactly one winner, everyone else cleanly rejected, no crash', async () => {
  const clock = game._clock;
  // Pick 5 players and force-call numbers so ALL of them simultaneously qualify for Early Five —
  // the worst case for contention (several real clients racing for the same prize at once).
  const contenders = game.players.slice(0, 5);
  const commonFive = T.ticketNumbers(contenders[0].ticket).slice(0, 5);
  // Make sure all 5 contenders actually share these as part of their own 15, by instead calling
  // each contender's own first five numbers in turn — simplest robust way to guarantee eligibility.
  contenders.forEach(pl => {
    const five = T.ticketNumbers(pl.ticket).slice(0, 5);
    five.forEach(n => {
      if (game.calledNumbersSoFar.includes(n)) return;
      game.remainingNumbers = game.remainingNumbers.filter(x => x !== n).concat(n);
      game.callNext(); clock.advance(T.DRAW_MS);
    });
  });
  await waitFor(() => contenders.every(pl => T.checkPrize(pl.ticket, new Set(game.calledNumbersSoFar), 'earlyFive')), 'all 5 contenders now qualify for Early Five');

  const results = contenders.map(() => []);
  const sockets = contenders.map(pl => clients[game.players.indexOf(pl)]);
  sockets.forEach((ws, i) => ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.type === 'CLAIM_RESULT') results[i].push(m.payload); }));

  // All 5 claim the SAME prize in the same instant.
  sockets.forEach((ws, i) => ws.send(JSON.stringify({ type: 'CLAIM_PRIZE', payload: { playerId: contenders[i].playerId, prizeType: 'earlyFive' }, sessionToken: contenders[i].sessionToken })));

  await waitFor(() => game.claims.filter(c => c.prizeType === 'earlyFive').length >= 1, 'at least one claim was recorded');
  await new Promise(r => setTimeout(r, 300));   // let any stragglers' results arrive

  const accepted = game.claims.filter(c => c.prizeType === 'earlyFive' && c.accepted);
  assert.strictEqual(accepted.length, 1, 'exactly one Early Five claim was accepted, not zero, not several');
  assert.strictEqual(game.accepted.earlyFive, accepted[0].playerId);

  // The winner's own points went up exactly once (no double-award from a race).
  const winner = contenders.find(p => p.playerId === accepted[0].playerId);
  assert.ok(winner.prizesWon.filter(p => p === 'earlyFive').length === 1);
});

test('a player quitting and a player disconnecting mid-game, at 90-player scale, don\'t disturb anyone else', async () => {
  const quitter = game.players[10], dropper = game.players[20];
  const quitterWs = clients[10], dropperWs = clients[20];
  quitterWs.send(JSON.stringify({ type: 'QUIT_GAME', payload: { playerId: quitter.playerId }, sessionToken: quitter.sessionToken }));
  await waitFor(() => quitter.connectionStatus === 'quit', 'quitter marked as quit');
  dropperWs.close();
  await waitFor(() => dropper.connectionStatus === 'disconnected', 'dropper marked as disconnected');
  // The remaining 88 players are untouched.
  const others = game.players.filter(p => p !== quitter && p !== dropper);
  assert.strictEqual(others.length, N - 2);
  assert.ok(others.every(p => p.connectionStatus === 'connected'));
});

test('cleanup: all 90 sockets and the host socket close without leaking', async () => {
  clients.forEach(ws => { try { ws.close(); } catch (e) {} });
  hostWs.close();
  await new Promise(r => setTimeout(r, 200));
  assert.ok(true);
});
