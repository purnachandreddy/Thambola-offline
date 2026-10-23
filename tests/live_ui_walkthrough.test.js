// LIVE UI walkthrough: no real graphical browser is available in this environment, but this runs
// the actual server.js and the actual index.html/play.html in a real executing JS DOM (jsdom) —
// real clicks, real WebSocket traffic over the real relay, real DOM output checked at every step.
// This is the closest thing to "open it in a browser and click through it" available here.
//
// IMPORTANT: both pages' root <section>s have their "on" class in the static HTML source itself
// (so the very first screen shows up even before any script runs) — so "is the screen's CSS class
// present" is NOT a valid signal that the boot script has finished executing. Readiness is instead
// gated on window.__host / window.__player, debug objects assigned as the LAST statement of each
// page's boot script specifically so this can be detected reliably.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

let srv, base;
test.before(async () => {
  process.env.NO_OPEN = '1';
  delete require.cache[require.resolve('../server.js')];
  srv = require('../server.js');
  await new Promise((resolve, reject) => { srv.server.once('listening', resolve); srv.server.once('error', reject); srv.listen(0); });
  base = 'http://127.0.0.1:' + srv.server.address().port;
});
test.after(() => { srv.server.close(); });

function waitFor(fn, label, timeoutMs) {
  const start = Date.now(); timeoutMs = timeoutMs || 10000;
  return new Promise((resolve, reject) => {
    (function tick() {
      let ok; try { ok = fn(); } catch (e) { ok = false; }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for: ' + label));
      setTimeout(tick, 20);
    })();
  });
}
function loadPage(pathname, opts) {
  opts = opts || {};
  const errors = [];
  return JSDOM.fromURL(base + pathname, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(window) {
      if (opts.stubWebSocket) window.WebSocket = class { constructor() { this.readyState = 0; setTimeout(() => { if (this.onopen) this.onopen(); }, 5); } send() {} close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); } };
      window.speechSynthesis = { getVoices: () => [], speak: () => {}, cancel: () => {} };
      window.SpeechSynthesisUtterance = function () {};
      window.navigator.vibrate = () => {};
      window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.HTMLMediaElement.prototype.play = () => Promise.resolve();
      window.HTMLMediaElement.prototype.pause = () => {};
      window.fetch = (url, opts) => fetch(new URL(url, window.location.href).href, opts);
      window.onerror = (msg, src, line, col, err) => errors.push((err && err.stack) || String(msg));
      window.addEventListener('error', e => errors.push((e.error && e.error.stack) || e.message));
      window.addEventListener('unhandledrejection', e => errors.push('unhandledrejection: ' + (e.reason && e.reason.stack || e.reason)));
    }
  }).then(dom => ({ dom, errors }));
}
async function loadHostReady(pathname) {
  const r = await loadPage(pathname || '/');
  await waitFor(() => r.dom.window.__host, 'index.html boot script finished (window.__host present)');
  await waitFor(() => !r.dom.window.document.getElementById('btnCreate').disabled, 'Create button enabled (net.ok resolved)');
  return r;
}
async function loadPlayerReady(pathname, opts) {
  const r = await loadPage(pathname, opts);
  await waitFor(() => r.dom.window.__player, 'play.html boot script finished (window.__player present)');
  return r;
}
function on(className, el) { return el.classList.contains(className); }

test('LIVE WALKTHROUGH: host — landing screen renders correctly on load', async () => {
  const { dom, errors } = await loadHostReady('/');
  const d = dom.window.document;
  assert.ok(on('on', d.getElementById('s-landing')), 'landing screen is the active screen');
  assert.strictEqual(d.querySelector('.brand').textContent, 'Tambola');
  assert.ok(d.getElementById('sampleTicket').querySelector('.ticket-grid'), 'sample ticket actually rendered on the landing page');
  assert.strictEqual(d.getElementById('sampleTicket').querySelectorAll('.tcell:not(.blank)').length, 15, 'sample ticket has exactly 15 numbered cells');
  assert.ok(d.getElementById('btnResume').classList.contains('hidden'), 'no saved game -> Resume button hidden');
  assert.deepStrictEqual(errors, []);
  dom.window.close();
});

test('LIVE WALKTHROUGH: host — Create Game -> explainer carousel -> Skip -> settings screen populated', async () => {
  const { dom, errors } = await loadHostReady('/');
  const d = dom.window.document, w = dom.window;

  d.getElementById('btnCreate').click();
  assert.ok(on('on', d.getElementById('s-explainer')), 'explainer shown on first run');
  assert.ok(d.getElementById('exTrack').children.length >= 3, 'explainer has multiple cards');
  assert.ok(d.getElementById('exDots').children.length === d.getElementById('exTrack').children.length, 'one dot per card');

  d.getElementById('exSkip').click();
  assert.ok(on('on', d.getElementById('s-settings')), 'landed on settings after skipping explainer');
  const body = d.getElementById('setBody').textContent;
  assert.ok(body.includes('Number of players'));
  assert.ok(body.includes('Connection method'));
  assert.ok(body.includes('Prize money'));
  assert.ok(body.includes('Early Five') && body.includes('Full House'), 'all 6 prize toggles rendered');
  assert.ok(body.includes('Auto-call'));
  assert.ok(body.includes('Join approval mode'));
  assert.strictEqual(d.querySelectorAll('#setBody input[type=number]').length, 4, 'maxPlayers + 3 prize-money fields');
  assert.strictEqual(d.querySelectorAll('#setBody input[type=checkbox]').length, 8, '6 prize toggles + autocall + hostTTS switches');

  const mp = d.querySelector('#setBody input[aria-label="Number of players"]');
  mp.value = '12'; mp.dispatchEvent(new w.Event('input')); mp.dispatchEvent(new w.Event('blur'));
  assert.strictEqual(w.__host.settings.maxPlayers, 12, 'live setting change applied to in-memory settings');
  assert.strictEqual(JSON.parse(w.localStorage.getItem('tambola.host.settings')).maxPlayers, 12, 'persisted to localStorage');

  assert.deepStrictEqual(errors, []);
  dom.window.close();
});

test('LIVE WALKTHROUGH: host — open lobby renders a real QR code and a 4-digit PIN', async () => {
  const { dom, errors } = await loadHostReady('/');
  const d = dom.window.document, w = dom.window;
  d.getElementById('btnCreate').click(); d.getElementById('exSkip').click();
  d.getElementById('btnOpenLobby').click();

  assert.ok(on('on', d.getElementById('s-lobby')), 'lobby screen active');
  await waitFor(() => d.getElementById('qr').querySelector('svg'), 'QR code SVG actually rendered');
  const pin = d.getElementById('pin').textContent;
  assert.match(pin, /^\d{4}$/, 'PIN is exactly 4 digits: got "' + pin + '"');
  assert.strictEqual(pin, w.__host.game.pin, 'displayed PIN matches the real game object\'s PIN');
  assert.ok(d.getElementById('btnStart').disabled, 'Start disabled with zero players');
  assert.ok(d.getElementById('pempty').textContent.includes('Nobody has joined'));

  assert.deepStrictEqual(errors, []);
  dom.window.close();
});

test('LIVE WALKTHROUGH: a real player — join screen, tab switching, manual entry, PIN auto-advance', async () => {
  const { dom, errors } = await loadPlayerReady('/play?pin=5555&mode=auto', { stubWebSocket: true });
  const d = dom.window.document, w = dom.window;

  assert.strictEqual(d.getElementById('manualHost').value, '127.0.0.1:' + base.split(':').pop(), 'host address preloaded from the QR-carried URL');
  const pinBoxes = d.querySelectorAll('.pd');
  assert.strictEqual(Array.prototype.map.call(pinBoxes, b => b.value).join(''), '5555', 'PIN digits preloaded from URL');

  assert.ok(!on('hidden', d.getElementById('paneScan')));
  d.getElementById('tabManual').click();
  assert.ok(on('hidden', d.getElementById('paneScan')), 'scan pane hidden after switching tabs');
  assert.ok(!on('hidden', d.getElementById('paneManual')), 'manual pane now visible');
  assert.strictEqual(d.getElementById('tabManual').getAttribute('aria-pressed'), 'true');
  assert.strictEqual(d.getElementById('tabScan').getAttribute('aria-pressed'), 'false');

  pinBoxes[0].value = ''; pinBoxes[0].dispatchEvent(new w.Event('input'));
  pinBoxes[0].value = '7'; pinBoxes[0].dispatchEvent(new w.Event('input'));
  assert.strictEqual(d.activeElement, pinBoxes[1], 'focus auto-advanced to the next PIN box after typing a digit');

  d.getElementById('nameInput').value = '';
  d.getElementById('btnJoin').click();
  assert.ok(d.getElementById('joinErr').textContent.length > 0, 'empty name produces a visible error');
  assert.ok(on('on', d.getElementById('s-join')), 'did not leave the join screen on invalid input');

  assert.deepStrictEqual(errors, []);
  dom.window.close();
});

test('LIVE WALKTHROUGH: full real session — host creates room, a real player joins over a real socket, ticket renders, tapping marks it, a claim is accepted live', async () => {
  const { dom: hdom, errors: herrors } = await loadHostReady('/');
  const hd = hdom.window.document, hw = hdom.window;
  hd.getElementById('btnCreate').click(); hd.getElementById('exSkip').click(); hd.getElementById('btnOpenLobby').click();
  await waitFor(() => hd.getElementById('qr').querySelector('svg'), 'lobby up');
  const pin = hw.__host.game.pin;

  const { dom: pdom, errors: perrors } = await loadPlayerReady('/play?pin=' + pin + '&mode=auto', { stubWebSocket: false });
  const pd = pdom.window.document;
  pd.getElementById('nameInput').value = 'LiveTestPlayer';
  pd.getElementById('btnJoin').click();

  await waitFor(() => hw.__host.game.players.length === 1, 'host actually sees the player arrive');
  assert.strictEqual(hw.__host.game.players[0].name, 'LiveTestPlayer');
  await waitFor(() => on('on', pd.getElementById('s-wait')), 'player landed on the waiting lobby');
  assert.ok(pd.getElementById('waitYou').textContent.includes('LiveTestPlayer'));

  await waitFor(() => hd.getElementById('plist').textContent.includes('LiveTestPlayer'), 'host lobby list shows the real player name');
  assert.ok(!hd.getElementById('btnStart').disabled, 'Start now enabled with a real player present');

  hd.getElementById('btnStart').click();
  await waitFor(() => on('on', hd.getElementById('s-game')), 'host moved to the game screen');
  // Tickets are dealt on start, but — correctly — the player stays on the waiting screen until the
  // host actually calls the first number, not merely once a ticket exists.
  await waitFor(() => on('on', pd.getElementById('s-wait')), 'player still correctly shows the waiting screen immediately after start, before any number is called');
  const realTicket = hw.__host.game.players[0].ticket;
  assert.ok(realTicket, 'a real ticket was generated and assigned, even though the player UI hasn\'t shown it yet');

  const T = require('../public/engine.js');
  const numbers = T.ticketNumbers(realTicket);
  const ownedNumber = numbers[0];
  hw.__host.game.remainingNumbers = hw.__host.game.remainingNumbers.filter(n => n !== ownedNumber).concat(ownedNumber);
  hd.getElementById('btnCall').click();
  await new Promise(r => setTimeout(r, 1100));
  await waitFor(() => on('on', pd.getElementById('s-game')), 'player moves to the game screen on the first real call');
  await waitFor(() => pd.getElementById('curNum').textContent === String(ownedNumber), 'player screen shows the real called number');

  const cellEls = pd.querySelectorAll('#ticketHost .tcell:not(.blank)');
  assert.strictEqual(cellEls.length, 15, 'player ticket rendered with 15 real numbered cells');
  const renderedNumbers = Array.from(cellEls, c => +c.textContent).sort((a, b) => a - b);
  const expectedNumbers = Array.from(numbers).sort((a, b) => a - b);
  assert.deepStrictEqual(renderedNumbers, expectedNumbers, 'rendered ticket numbers exactly match the server-assigned ticket');
  assert.ok(hd.getElementById('board').querySelector('.c.called'), 'host board marks the number called');
  assert.ok(hd.getElementById('callInfo').textContent.includes('1 of 90'), 'host call counter updated');

  const ownedCell = Array.prototype.find.call(pd.querySelectorAll('#ticketHost .tcell'), c => c.textContent === String(ownedNumber));
  assert.ok(ownedCell, 'the owned number\'s cell exists in the DOM');
  assert.ok(!ownedCell.classList.contains('marked'), 'not marked before tapping');
  ownedCell.click();
  assert.ok(ownedCell.classList.contains('marked'), 'cell marked live after a real tap');
  assert.strictEqual(ownedCell.getAttribute('aria-pressed'), 'true');

  const uncalledCell = Array.prototype.find.call(pd.querySelectorAll('#ticketHost .tcell:not(.blank)'), c => +c.textContent !== ownedNumber);
  uncalledCell.click();
  assert.ok(!uncalledCell.classList.contains('marked'), 'tapping an uncalled number does not mark it');
  assert.ok(uncalledCell.classList.contains('shake'), 'visibly shakes to indicate rejection');

  const need = numbers.slice(1, 5);
  for (const n of need) {
    hw.__host.game.remainingNumbers = hw.__host.game.remainingNumbers.filter(x => x !== n).concat(n);
    hd.getElementById('btnCall').click();
    await new Promise(r => setTimeout(r, 1100));
  }
  await waitFor(() => pd.getElementById('curNum').textContent === String(need[need.length - 1]), 'final Early Five number reached the player live');
  const findClaimBtn = () => Array.prototype.find.call(pd.querySelectorAll('#claimBtns button'), b => b.textContent === 'Early Five');
  assert.ok(findClaimBtn() && !findClaimBtn().disabled, 'Early Five claim button is live and enabled');
  findClaimBtn().click();
  await waitFor(() => hw.__host.game.players[0].prizesWon.includes('earlyFive'), 'the REAL server-side state machine accepted the claim');
  await waitFor(() => findClaimBtn().disabled, 'claim button disables live once resolved, on the player\'s own screen (button is rebuilt fresh on each render, so re-query rather than reuse the earlier reference)');
  await waitFor(() => hd.getElementById('lb').textContent.includes('LiveTestPlayer') && hd.getElementById('lb').textContent.includes('Early Five'), 'host leaderboard shows the live prize win');

  assert.deepStrictEqual(herrors, []); assert.deepStrictEqual(perrors, []);
  hdom.window.close(); pdom.window.close();
}, { timeout: 30000 });
