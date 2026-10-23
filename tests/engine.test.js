// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const T = require('../public/engine.js');

test('1000-ticket generation test (02_TICKET_GENERATION.md section 4)', () => {
  let tickets = [], books = 0;
  while (tickets.length < 1000) { const b = T.generateBook(); books++; assertBook(b); tickets = tickets.concat(b); }
  assert.ok(tickets.length >= 1000);
  tickets.slice(0, 1000).forEach(assertTicket);
  // scaling helper: N players -> N unique-position tickets
  [1, 5, 6, 7, 30, 90].forEach(n => assert.strictEqual(T.generateTickets(n).length, n));
});

function assertTicket(t) {
  assert.strictEqual(t.length, 3);
  let total = 0;
  t.forEach(row => { assert.strictEqual(row.length, 9); const f = row.filter(x => x); assert.strictEqual(f.length, 5, 'row has 5'); total += f.length; });
  assert.strictEqual(total, 15);
  for (let c = 0; c < 9; c++) {
    const col = [t[0][c], t[1][c], t[2][c]].filter(x => x);
    assert.ok(col.length >= 1 && col.length <= 3, 'col count 1-3');
    for (let i = 1; i < col.length; i++) assert.ok(col[i] > col[i - 1], 'ascending');
    col.forEach(n => assert.ok(n >= T.COLUMN_RANGES[c][0] && n <= T.COLUMN_RANGES[c][1], 'in range'));
  }
}
function assertBook(b) {
  assert.strictEqual(b.length, 6);
  const seen = new Set();
  b.forEach(t => { assertTicket(t); T.ticketNumbers(t).forEach(n => { assert.ok(!seen.has(n), 'dup in book ' + n); seen.add(n); }); });
  assert.strictEqual(seen.size, 90);   // book covers 1..90 exactly once
}

test('verified matrix sums', () => {
  assert.deepStrictEqual(T.MATRIX.map(r => r.reduce((a, b) => a + b)), [15, 15, 15, 15, 15, 15]);
  const cols = [0,1,2,3,4,5,6,7,8].map(c => T.MATRIX.reduce((a, r) => a + r[c], 0));
  assert.deepStrictEqual(cols, [9, 10, 10, 10, 10, 10, 10, 10, 11]);
});

test('prize win conditions', () => {
  const t = [[1, 0, 20, 0, 40, 0, 60, 0, 80], [0, 11, 0, 31, 0, 51, 0, 71, 0], [5, 0, 25, 0, 45, 0, 65, 0, 85]];
  // rows have 5 each (row1 has 4 here: fine for rule tests except full-house counts)
  const S = a => new Set(a);
  assert.ok(T.checkPrize(t, S([1, 20, 40, 60, 80]), 'topLine'));
  assert.ok(!T.checkPrize(t, S([1, 20, 40, 60]), 'topLine'));
  assert.ok(T.checkPrize(t, S([5, 25, 45, 65, 85]), 'bottomLine'));
  assert.ok(T.checkPrize(t, S([1, 80, 5, 85]), 'fourCorners'));
  assert.ok(!T.checkPrize(t, S([1, 80, 5]), 'fourCorners'));
  assert.ok(T.checkPrize(t, S([1, 11, 20, 31, 40]), 'earlyFive'));
  assert.ok(!T.checkPrize(t, S([1, 11, 20, 31]), 'earlyFive'));
  assert.ok(T.checkPrize(t, S(T.ticketNumbers(t)), 'fullHouse'));
});

// ---- state machine ----
function rig(over) {
  const sent = [], kicked = [];
  const timers = []; let clock = 1000000;
  const transport = {
    to: (c, m) => sent.push({ c, m }), toMany: (cs, m) => cs.forEach(c => sent.push({ c, m })),
    all: m => sent.push({ c: '*', m }), kick: c => kicked.push(c)
  };
  const settings = Object.assign(JSON.parse(JSON.stringify(T.DEFAULT_SETTINGS)), over || {});
  const g = new T.GameHost({
    transport, settings, pin: '4321', now: () => clock,
    setTimeout: (f, ms) => { const t = { f, at: clock + ms }; timers.push(t); return t; },
    clearTimeout: h => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); }
  });
  const advance = ms => { clock += ms; timers.filter(t => t.at <= clock).sort((a, b) => a.at - b.at).forEach(t => { const i = timers.indexOf(t); if (i >= 0) { timers.splice(i, 1); t.f(); } }); };
  const join = (conn, name) => { g.handleMessage(conn, { type: 'JOIN_ROOM', payload: { playerName: name, deviceId: 'd' + conn, pin: '4321' } }); return g.playerByConn(conn); };
  const msgsTo = (c, type) => sent.filter(x => x.c === c && (!type || x.m.type === type)).map(x => x.m);
  const callAll = () => { while (g.remainingNumbers.length) { g.callNext(); advance(1000); } };
  return { g, sent, kicked, advance, join, msgsTo, callAll, timers };
}
const claim = (r, p, prize, tok) => r.g.handleMessage(p.connId, { type: 'CLAIM_PRIZE', payload: { playerId: p.playerId, prizeType: prize }, sessionToken: tok === undefined ? p.sessionToken : tok });

test('join validation: wrong pin, duplicate names, capacity, after start', () => {
  const r = rig({ maxPlayers: 2 });
  r.g.handleMessage('x', { type: 'JOIN_ROOM', payload: { playerName: 'A', deviceId: 'd', pin: '0000' } });
  assert.strictEqual(r.msgsTo('x', 'JOIN_REJECTED')[0].payload.reason, 'Wrong PIN');
  const a = r.join('c1', 'Ravi'), b = r.join('c2', 'Ravi');
  assert.strictEqual(a.name, 'Ravi'); assert.strictEqual(b.name, 'Ravi (2)');
  r.join('c3', 'Late');
  assert.strictEqual(r.msgsTo('c3', 'JOIN_REJECTED')[0].payload.reason, 'Room full');
  r.g.startGame();
  r.g.handleMessage('c4', { type: 'JOIN_ROOM', payload: { playerName: 'Z', deviceId: 'd', pin: '4321' } });
  assert.strictEqual(r.msgsTo('c4', 'JOIN_REJECTED')[0].payload.reason, 'Game already in progress');
});

test('a client with no prior knowledge of the room\'s approval mode (e.g. manually-typed address/PIN) can always use JOIN_REQUEST safely', () => {
  // Regression test: play.html used to guess the room's joinApprovalMode from a URL query param
  // that's only present when the player arrived via the host's QR link. A player who typed the
  // host address and PIN in by hand has no such hint, defaults to assuming 'auto', and — if the
  // room actually required approval — would send JOIN_ROOM and get silently stuck forever (the
  // server just replies with room settings and grants no entry, with no further client action).
  // The fix was for the client to always send JOIN_REQUEST instead. This proves that message type
  // is safe and correct in both an auto-approval room and a host-approved room, with no client-side
  // mode-guessing required at all.
  const auto = rig({ joinApprovalMode: 'auto' });
  auto.g.handleMessage('c1', { type: 'JOIN_REQUEST', payload: { playerName: 'Auto', deviceId: 'd', pin: '4321' } });
  assert.strictEqual(auto.g.players.length, 1, 'JOIN_REQUEST under auto mode admits immediately, just like JOIN_ROOM would');
  assert.ok(auto.msgsTo('c1', 'JOIN_APPROVED').length === 1);

  const approved = rig({ joinApprovalMode: 'host_approves' });
  approved.g.handleMessage('c1', { type: 'JOIN_REQUEST', payload: { playerName: 'Careful', deviceId: 'd', pin: '4321' } });
  assert.strictEqual(approved.g.players.length, 0, 'not admitted yet');
  assert.strictEqual(approved.g.pending.length, 1, 'correctly queued for approval instead of being stuck with no path forward');
  approved.g.approve(approved.g.pending[0].pendingId);
  assert.strictEqual(approved.g.players.length, 1);
  assert.ok(approved.msgsTo('c1', 'JOIN_APPROVED').length === 1);
});

test('host_approves flow and JOIN_ROOM cannot bypass it', () => {
  const r = rig({ joinApprovalMode: 'host_approves' });
  r.join('c1', 'Sita');
  assert.strictEqual(r.g.players.length, 0);
  assert.strictEqual(r.msgsTo('c1', 'ROOM_SETTINGS')[0].payload.joinApprovalMode, 'host_approves');
  r.g.handleMessage('c1', { type: 'JOIN_REQUEST', payload: { playerName: 'Sita', deviceId: 'd', pin: '4321' } });
  assert.strictEqual(r.g.pending.length, 1);
  r.g.approve(r.g.pending[0].pendingId);
  assert.strictEqual(r.g.players.length, 1);
  assert.ok(r.msgsTo('c1', 'JOIN_APPROVED').length === 1);
  r.g.handleMessage('c2', { type: 'JOIN_REQUEST', payload: { playerName: 'Bo', deviceId: 'd', pin: '4321' } });
  r.g.reject(r.g.pending[0].pendingId);
  assert.strictEqual(r.msgsTo('c2', 'JOIN_REJECTED')[0].payload.reason, 'Host declined');
});

test('start: tickets dealt, calling, points +1, NUMBER_CALLED at 1000ms', () => {
  const r = rig({ hostTtsEnabled: false });
  const a = r.join('c1', 'A'), b = r.join('c2', 'B');
  assert.ok(r.g.startGame());
  assert.strictEqual(r.msgsTo('c1', 'ASSIGN_TICKET').length, 1);
  assert.strictEqual(r.g.gameStatus, 'in_progress');
  r.g.callNext();
  assert.strictEqual(r.msgsTo('c1', 'NUMBER_CALLED').length, 0, 'nothing before the 1000ms mark');
  r.advance(999); assert.strictEqual(r.msgsTo('c1', 'NUMBER_CALLED').length, 0);
  r.advance(1);
  const nc = r.msgsTo('c1', 'NUMBER_CALLED')[0].payload;
  assert.strictEqual(nc.callIndex, 1); assert.deepStrictEqual(nc.calledNumbersSoFar, [nc.number]);
  const owns = p => T.ticketNumbers(p.ticket).includes(nc.number) ? 1 : 0;
  assert.strictEqual(a.points, owns(a)); assert.strictEqual(b.points, owns(b));
});

test('claims: automatic validation, speed bonus, already-claimed, pause, no client marks used', () => {
  const r = rig({ hostTtsEnabled: false });
  const a = r.join('c1', 'A'), b = r.join('c2', 'B');
  r.g.startGame();
  // premature claim rejected
  claim(r, a, 'fullHouse');
  assert.strictEqual(r.msgsTo('c1', 'CLAIM_RESULT').pop().payload.rejectionReason, 'Ticket does not satisfy this prize yet');
  // force calls until A has a top line
  const need = T.rowNumbers(a.ticket, 0);
  r.g.remainingNumbers = r.g.remainingNumbers.filter(n => !need.includes(n)).concat(need.slice().reverse());
  need.forEach(() => { r.g.callNext(); r.advance(1000); });
  const before = a.points;
  claim(r, a, 'topLine');
  const res = r.msgsTo('c1', 'CLAIM_RESULT').pop().payload;
  assert.strictEqual(res.accepted, true); assert.strictEqual(res.pointsAwarded, 15 + 5);
  assert.strictEqual(a.points, before + 20); assert.deepStrictEqual(a.prizesWon, ['topLine']);
  assert.ok(r.msgsTo('c2', 'CLAIM_RESULT').some(m => m.payload.accepted), 'accepted claim is broadcast to all');
  // B cannot take the same prize even with a legit ticket state
  claim(r, b, 'topLine');
  assert.strictEqual(r.msgsTo('c2', 'CLAIM_RESULT').pop().payload.rejectionReason, 'Already claimed by another player');
  // pause blocks claims
  r.g.pause();
  claim(r, a, 'earlyFive');
  assert.strictEqual(r.msgsTo('c1', 'CLAIM_RESULT').pop().payload.rejectionReason, 'Game is paused');
  assert.ok(r.msgsTo('c1', 'GAME_PAUSE').length === 1);
  r.g.resume(); assert.strictEqual(r.g.gameStatus, 'in_progress');
});

test('sessionToken enforced: bad/missing token dropped silently', () => {
  const r = rig({ hostTtsEnabled: false });
  const a = r.join('c1', 'A'); r.g.startGame();
  const n = r.sent.length;
  claim(r, a, 'earlyFive', 'wrong'); claim(r, a, 'earlyFive', null);
  r.g.handleMessage('c1', { type: 'ANNOUNCE', payload: { playerId: a.playerId, row: 'top' } });
  assert.strictEqual(r.sent.length, n, 'nothing sent in response');
  assert.strictEqual(r.g.claims.length, 0);
});

test('ANNOUNCE: once per (player,row), decoupled from scoring', () => {
  const r = rig({ hostTtsEnabled: false });
  const a = r.join('c1', 'A'); r.join('c2', 'B'); r.g.startGame();
  const snap = JSON.stringify([a.points, a.prizesWon, r.g.claims]);
  const ann = row => r.g.handleMessage('c1', { type: 'ANNOUNCE', payload: { playerId: a.playerId, playerName: 'A', row }, sessionToken: a.sessionToken });
  ann('top'); ann('top'); ann('middle');
  assert.strictEqual(r.msgsTo('c2', 'ANNOUNCE').length, 2);
  assert.strictEqual(r.msgsTo('c1', 'ANNOUNCE').length, 0, 'sender does not get an echo');
  assert.strictEqual(JSON.stringify([a.points, a.prizesWon, r.g.claims]), snap);
});

test('quit vs disconnect vs kick produce three distinct outcomes', () => {
  const r = rig({ hostTtsEnabled: false });
  const a = r.join('c1', 'A'), b = r.join('c2', 'B'), c = r.join('c3', 'C'); r.g.startGame();
  r.g.handleMessage('c1', { type: 'QUIT_GAME', payload: { playerId: a.playerId }, sessionToken: a.sessionToken });
  r.g.handleClose('c1');
  assert.strictEqual(a.connectionStatus, 'quit');
  r.g.handleClose('c2'); assert.strictEqual(b.connectionStatus, 'disconnected');
  r.g.kickPlayer(c.playerId);
  assert.ok(!r.g.playerById(c.playerId)); assert.deepStrictEqual(r.kicked, ['c3']);
  assert.strictEqual(r.msgsTo('c3', 'KICK_PLAYER').length, 1);
  // reconnect of b resumes via STATE_SYNC_REQUEST; quit player cannot
  r.g.handleMessage('c9', { type: 'STATE_SYNC_REQUEST', payload: { playerId: b.playerId, sessionToken: b.sessionToken }, sessionToken: b.sessionToken });
  assert.strictEqual(b.connectionStatus, 'connected');
  assert.strictEqual(r.msgsTo('c9', 'STATE_SYNC_RESPONSE')[0].payload.gameStatus, 'in_progress');
  r.g.handleMessage('c8', { type: 'STATE_SYNC_REQUEST', payload: { playerId: a.playerId, sessionToken: a.sessionToken }, sessionToken: a.sessionToken });
  assert.strictEqual(r.msgsTo('c8', 'STATE_SYNC_RESPONSE').length, 0);
  // a kicked token can no longer act
  r.g.handleMessage('c3', { type: 'STATE_SYNC_REQUEST', payload: { playerId: c.playerId, sessionToken: c.sessionToken }, sessionToken: c.sessionToken });
  assert.strictEqual(r.msgsTo('c3', 'STATE_SYNC_RESPONSE').length, 0);
});

test('leaderboard throttled to <=1 broadcast per 1000ms under load', () => {
  const r = rig({ hostTtsEnabled: false });
  for (let i = 0; i < 40; i++) r.join('c' + i, 'P' + i);
  r.g.startGame();
  r.advance(1500);
  const count = () => r.sent.filter(x => x.c === 'c0' && x.m.type === 'LEADERBOARD_UPDATE').length;
  const base = count();
  for (let i = 0; i < 60; i++) { r.g.markLeaderboard(); r.advance(10); }   // 600ms of spam
  assert.ok(count() - base <= 1, 'at most one in a 600ms burst, got ' + (count() - base));
  r.advance(1200);
  assert.ok(count() - base <= 2);
});

test('auto-call: countdown starts after TTS, freezes on pause, resumes without reset', () => {
  const r = rig({ autoCallEnabled: true, autoCallIntervalSeconds: 8, hostTtsEnabled: true });
  r.join('c1', 'A'); r.g.startGame();
  r.g.tick(3000); assert.strictEqual(r.g.autoRemainingMs, 5000);
  r.g.pause(); r.g.tick(4000); assert.strictEqual(r.g.autoRemainingMs, 5000, 'paused: no countdown');
  r.g.resume(); r.g.tick(1000); assert.strictEqual(r.g.autoRemainingMs, 4000, 'resumed from where it left off');
  r.g.tick(4000); assert.ok(r.g.drawing, 'timer fired -> drawing');
  r.advance(1000);
  assert.ok(r.g.ttsPending);
  r.g.tick(5000); assert.strictEqual(r.g.calledNumbersSoFar.length, 1, 'no countdown while speaking');
  r.g.ttsDone(); assert.strictEqual(r.g.autoRemainingMs, 8000);
});

test('override flips a claim and reverses points', () => {
  const r = rig({ hostTtsEnabled: false });
  const a = r.join('c1', 'A'); r.g.startGame();
  T.ticketNumbers(a.ticket).slice(0, 5).forEach(n => { r.g.remainingNumbers = r.g.remainingNumbers.filter(x => x !== n).concat(n); r.g.callNext(); r.advance(1000); });
  claim(r, a, 'earlyFive');
  const c = r.g.claims[0]; assert.ok(c.accepted);
  const pts = a.points;
  assert.ok(r.g.overrideClaim(c.id));
  assert.strictEqual(a.points, pts - c.awardedBefore); assert.deepStrictEqual(a.prizesWon, []);
  assert.ok(!r.g.accepted.earlyFive);
  const ov = r.msgsTo('c1', 'CLAIM_OVERRIDE').pop().payload;
  assert.deepStrictEqual(ov, { playerId: a.playerId, prizeType: 'earlyFive', newAcceptedState: false, correctedByHost: true });
  assert.ok(r.g.overrideClaim(c.id)); assert.ok(a.prizesWon.includes('earlyFive'));
});

test('game over money allocation for both ranking bases; new game resets without rejoin', () => {
  const r = rig({ hostTtsEnabled: false, prizeMoney: { first: 500, second: 300, third: 100, currency: 'X' } });
  const a = r.join('c1', 'A'), b = r.join('c2', 'B'), c = r.join('c3', 'C'), d = r.join('c4', 'D'); r.g.startGame();
  a.points = 10; b.points = 30; c.points = 20; d.points = 5;
  r.g.accepted.fullHouse = d.playerId;
  r.g.endGame();
  const fr = r.msgsTo('c1', 'GAME_OVER')[0].payload.finalRankings;
  assert.deepStrictEqual(fr.map(x => [x.playerName, x.moneyPrize]), [['B', 500], ['C', 300], ['A', 100], ['D', 0]]);
  r.g.settings.rankingBasis = 'full_house_winner';
  const m = T.allocateMoney(r.g.players, r.g.settings, d.playerId);
  assert.strictEqual(m[d.playerId], 500); assert.strictEqual(m[b.playerId], 300); assert.strictEqual(m[c.playerId], 100);
  // New game
  r.g.newGame();
  assert.strictEqual(r.g.gameStatus, 'lobby'); assert.strictEqual(r.g.players.length, 4);
  assert.ok(r.g.players.every(p => p.points === 0 && p.prizesWon.length === 0 && p.ticket === null));
  assert.deepStrictEqual(r.g.calledNumbersSoFar, []);
  assert.strictEqual(r.msgsTo('c1', 'STATE_SYNC_RESPONSE').pop().payload.gameStatus, 'lobby');
  assert.ok(r.g.startGame());
});

test('serialize/restore keeps the room; a live game comes back paused', () => {
  const r = rig({ hostTtsEnabled: false });
  const a = r.join('c1', 'A'); r.g.startGame(); r.g.callNext(); r.advance(1000);
  const snap = r.g.serialize();
  const r2 = rig(); r2.g.restore(snap);
  assert.strictEqual(r2.g.gameStatus, 'paused'); assert.strictEqual(r2.g.players[0].connectionStatus, 'disconnected');
  assert.deepStrictEqual(r2.g.calledNumbersSoFar, r.g.calledNumbersSoFar);
  r2.g.reconcileConnections(['c1']); assert.strictEqual(r2.g.players[0].connectionStatus, 'connected');
});

test('number words', () => {
  assert.strictEqual(T.englishDigits(45), 'four five'); assert.strictEqual(T.englishWords(45), 'forty-five');
  assert.strictEqual(T.englishDigits(7), 'seven'); assert.strictEqual(T.englishWords(90), 'ninety');
  assert.ok(T.teluguWords(45).length > 3); assert.strictEqual(T.teluguWords(20), 'ఇరవై');
  for (let n = 1; n <= 90; n++) { assert.ok(T.teluguWords(n)); assert.ok(T.englishWords(n)); }
});
