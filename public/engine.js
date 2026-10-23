/* Tambola engine — pure logic, no DOM. Runs in the browser (host page) and in Node (tests).
 * Implements 01_GAME_RULES, 02_TICKET_GENERATION, 03_STATE_MACHINE and the message shapes of
 * data/message_schemas.json. Message field names are final and unchanged from the spec. */
(function (root) {
  'use strict';

  // ---------- constants (data/prizes_and_scoring.json) ----------
  var COLUMN_RANGES = [[1, 9], [10, 19], [20, 29], [30, 39], [40, 49], [50, 59], [60, 69], [70, 79], [80, 90]];
  var MATRIX = [
    [1, 1, 1, 2, 2, 2, 2, 2, 2],
    [1, 2, 2, 1, 1, 2, 2, 2, 2],
    [1, 2, 2, 2, 2, 1, 1, 2, 2],
    [2, 1, 2, 1, 2, 2, 2, 1, 2],
    [2, 2, 1, 2, 2, 1, 2, 1, 2],
    [2, 2, 2, 2, 1, 2, 1, 2, 1]
  ];
  var PRIZES = {
    earlyFive: { label: 'Early Five', basePoints: 10 },
    topLine: { label: 'Top Line', basePoints: 15 },
    middleLine: { label: 'Middle Line', basePoints: 15 },
    bottomLine: { label: 'Bottom Line', basePoints: 15 },
    fourCorners: { label: 'Four Corners', basePoints: 15 },
    fullHouse: { label: 'Full House', basePoints: 50 }
  };
  var PRIZE_ORDER = ['earlyFive', 'topLine', 'middleLine', 'bottomLine', 'fourCorners', 'fullHouse'];
  var POINTS = { perOwnNumberCalled: 1, speedBonus: 5 };
  var LEADERBOARD_THROTTLE_MS = 1000;
  var DRAW_MS = 1000;
  var DEFAULT_SETTINGS = {
    maxPlayers: 30,
    connectionMethod: 'router',
    connectionMethodTouched: false,
    prizeMoney: { first: 0, second: 0, third: 0, currency: '\u20B9' },
    prizesEnabled: { earlyFive: true, topLine: true, middleLine: true, bottomLine: true, fourCorners: true, fullHouse: true },
    autoCallEnabled: false,
    autoCallIntervalSeconds: 8,
    hostTtsEnabled: true,
    joinApprovalMode: 'auto',
    rankingBasis: 'highest_points'
  };

  // ---------- randomness ----------
  function randInt(n) {
    var c = root.crypto || (typeof require === 'function' ? require('crypto').webcrypto : null);
    if (c && c.getRandomValues) {
      // rejection sampling to avoid modulo bias
      var lim = Math.floor(4294967296 / n) * n, x;
      var buf = new Uint32Array(1);
      do { c.getRandomValues(buf); x = buf[0]; } while (x >= lim);
      return x % n;
    }
    return Math.floor(Math.random() * n);
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = randInt(i + 1), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  // uuid v4 without crypto.randomUUID (which needs a secure context; the LAN page is plain http)
  function uuid() {
    var b = new Uint8Array(16), c = root.crypto || (typeof require === 'function' ? require('crypto').webcrypto : null);
    if (c && c.getRandomValues) c.getRandomValues(b); else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  // ---------- ticket generation (02_TICKET_GENERATION.md) ----------
  function generateBook() {
    var buckets = COLUMN_RANGES.map(function (r) {
      var a = []; for (var n = r[0]; n <= r[1]; n++) a.push(n);
      return shuffle(a);
    });
    var tickets = [];
    for (var t = 0; t < 6; t++) {
      var grid = [[0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0]];
      var fill = [0, 0, 0];
      for (var c = 0; c < 9; c++) {
        var need = MATRIX[t][c];
        var nums = buckets[c].splice(0, need).sort(function (a, b) { return a - b; });
        // rows with the lowest fill first, ties -> lowest index
        var order = [0, 1, 2].sort(function (a, b) { return fill[a] - fill[b] || a - b; });
        var rows = order.slice(0, need).sort(function (a, b) { return a - b; });
        for (var k = 0; k < rows.length; k++) { grid[rows[k]][c] = nums[k]; fill[rows[k]]++; }
      }
      tickets.push(grid);
    }
    return tickets;
  }
  function generateTickets(n) {
    var books = Math.ceil(n / 6), all = [];
    for (var b = 0; b < books; b++) all = all.concat(generateBook());
    shuffle(all);
    return all.slice(0, n);
  }

  // ---------- prize rules (01_GAME_RULES.md §2) ----------
  function rowNumbers(ticket, r) { return ticket[r].filter(function (x) { return x !== 0; }); }
  function ticketNumbers(ticket) { return rowNumbers(ticket, 0).concat(rowNumbers(ticket, 1), rowNumbers(ticket, 2)); }
  function cornerNumbers(ticket) {
    var top = rowNumbers(ticket, 0), bot = rowNumbers(ticket, 2);
    return [top[0], top[top.length - 1], bot[0], bot[bot.length - 1]];
  }
  function checkPrize(ticket, calledSet, prizeType) {
    var has = function (n) { return calledSet.has(n); };
    switch (prizeType) {
      case 'earlyFive': return ticketNumbers(ticket).filter(has).length >= 5;
      case 'topLine': return rowNumbers(ticket, 0).every(has);
      case 'middleLine': return rowNumbers(ticket, 1).every(has);
      case 'bottomLine': return rowNumbers(ticket, 2).every(has);
      case 'fourCorners': return cornerNumbers(ticket).every(has);
      case 'fullHouse': return ticketNumbers(ticket).every(has);
    }
    return false;
  }

  // ---------- number words (host-only TTS) ----------
  var EN_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  var EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  function englishWords(n) { return n < 20 ? EN_ONES[n] : EN_TENS[Math.floor(n / 10)] + (n % 10 ? '-' + EN_ONES[n % 10] : ''); }
  function englishDigits(n) { return String(n).split('').map(function (d) { return EN_ONES[+d]; }).join(' '); }
  var TE_ONES = ['', 'ఒకటి', 'రెండు', 'మూడు', 'నాలుగు', 'ఐదు', 'ఆరు', 'ఏడు', 'ఎనిమిది', 'తొమ్మిది', 'పది', 'పదకొండు', 'పన్నెండు', 'పదమూడు', 'పద్నాలుగు', 'పదిహేను', 'పదహారు', 'పదిహేడు', 'పద్దెనిమిది', 'పంతొమ్మిది'];
  var TE_TENS = ['', '', 'ఇరవై', 'ముప్పై', 'నలభై', 'యాభై', 'అరవై', 'డెబ్బై', 'ఎనభై', 'తొంభై'];
  function teluguWords(n) { return n < 20 ? TE_ONES[n] : TE_TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + TE_ONES[n % 10] : ''); }

  // ---------- money allocation (06_UI_HOST §8.6, settings rankingBasis) ----------
  function sortRankings(players) {
    return players.slice().sort(function (a, b) { return (b.points - a.points) || (a.joinIndex - b.joinIndex); });
  }
  function allocateMoney(players, settings, fullHouseWinnerId) {
    var sorted = sortRankings(players), out = {}, order;
    var amounts = [settings.prizeMoney.first, settings.prizeMoney.second, settings.prizeMoney.third];
    if (settings.rankingBasis === 'full_house_winner' && fullHouseWinnerId && sorted.some(function (p) { return p.playerId === fullHouseWinnerId; })) {
      order = sorted.filter(function (p) { return p.playerId === fullHouseWinnerId; })
        .concat(sorted.filter(function (p) { return p.playerId !== fullHouseWinnerId; }));
    } else order = sorted;
    players.forEach(function (p) { out[p.playerId] = 0; });
    order.slice(0, 3).forEach(function (p, i) { out[p.playerId] = Number(amounts[i]) || 0; });
    return out;
  }

  // ---------- GameHost: the server-side brain (03_STATE_MACHINE.md) ----------
  // transport: { to(connId,msg), toMany(connIds,msg), all(msg), kick(connId) }
  function GameHost(opts) {
    this.transport = opts.transport;
    this.settings = JSON.parse(JSON.stringify(opts.settings));
    this.pin = opts.pin;
    this.now = opts.now || function () { return Date.now(); };
    this.setTimeout = opts.setTimeout || function (f, ms) { return setTimeout(f, ms); };
    this.clearTimeout = opts.clearTimeout || function (h) { clearTimeout(h); };
    this.handlers = {};
    this.gameStatus = 'lobby';
    this.players = [];      // joined players
    this.pending = [];      // JOIN_REQUEST awaiting host decision
    this.nextJoinIndex = 1;
    this._resetRound();
    this.lbTimer = null; this.lbLast = 0; this.lbDirty = false;
    this.drawing = false; this.ttsPending = false; this.autoRemainingMs = 0;
  }
  GameHost.prototype._resetRound = function () {
    this.calledNumbersSoFar = [];
    this.remainingNumbers = [];
    this.claims = [];
    this.accepted = {};        // prizeType -> playerId
    this.announced = {};       // playerId|row -> true
    this.claimSeq = 0;
    this.currentNumber = null;
  };
  GameHost.prototype.on = function (ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); };
  GameHost.prototype.emit = function (ev, data) { (this.handlers[ev] || []).forEach(function (f) { try { f(data); } catch (e) { if (typeof console !== 'undefined') console.error(e); } }); };
  GameHost.prototype.changed = function () { this.emit('change'); };
  GameHost.prototype.playerById = function (id) { return this.players.filter(function (p) { return p.playerId === id; })[0]; };
  GameHost.prototype.playerByConn = function (c) { return this.players.filter(function (p) { return p.connId === c; })[0]; };
  GameHost.prototype.joinedConnIds = function () {
    return this.players.filter(function (p) { return p.connId && p.connectionStatus !== 'quit'; }).map(function (p) { return p.connId; });
  };
  GameHost.prototype.broadcast = function (type, payload) {
    var ids = this.joinedConnIds(); if (ids.length) this.transport.toMany(ids, this._env(type, payload));
  };
  GameHost.prototype._env = function (type, payload) { return { type: type, payload: payload || {}, timestamp: this.now() }; };
  GameHost.prototype.sendTo = function (connId, type, payload) { if (connId) this.transport.to(connId, this._env(type, payload)); };
  GameHost.prototype.roomSettingsPayload = function () {
    var s = this.settings;
    return {
      maxPlayers: s.maxPlayers, connectionMethod: s.connectionMethod, joinApprovalMode: s.joinApprovalMode,
      prizeMoney: s.prizeMoney, prizesEnabled: s.prizesEnabled, autoCallEnabled: s.autoCallEnabled,
      autoCallIntervalSeconds: s.autoCallIntervalSeconds, hostTtsEnabled: s.hostTtsEnabled, rankingBasis: s.rankingBasis
    };
  };
  GameHost.prototype.updateSettings = function (s) {
    this.settings = JSON.parse(JSON.stringify(s));
    this.broadcast('ROOM_SETTINGS', this.roomSettingsPayload());
    this.changed();
  };

  // ----- inbound -----
  GameHost.prototype.handleMessage = function (connId, msg) {
    if (!msg || typeof msg.type !== 'string') return;
    var p = msg.payload || {};
    switch (msg.type) {
      case 'JOIN_ROOM': case 'JOIN_REQUEST': return this._join(connId, msg.type, p);
      case 'STATE_SYNC_REQUEST': return this._sync(connId, p, msg.sessionToken);
    }
    // every other player message needs a valid sessionToken for its claimed playerId (03 §2 step 4)
    var pl = this.playerById(p.playerId);
    if (!pl || !msg.sessionToken || msg.sessionToken !== pl.sessionToken) return;   // silently dropped
    if (pl.connId !== connId) return;
    switch (msg.type) {
      case 'CLAIM_PRIZE': return this._claim(pl, p.prizeType);
      case 'ANNOUNCE': return this._announce(pl, p.row);
      case 'QUIT_GAME': return this._quit(pl);
    }
  };
  GameHost.prototype.handleOpen = function () {};
  GameHost.prototype.handleClose = function (connId) {
    var pi = this.pending.findIndex(function (x) { return x.connId === connId; });
    if (pi >= 0) { this.pending.splice(pi, 1); this.changed(); }
    var pl = this.playerByConn(connId);
    if (pl && pl.connectionStatus !== 'quit') {
      pl.connectionStatus = 'disconnected'; pl.connId = null;
      this.markLeaderboard(); this.changed();
    } else if (pl) pl.connId = null;
  };
  // host learns which sockets currently exist (after a host page reload)
  GameHost.prototype.reconcileConnections = function (connIds) {
    var set = {}; connIds.forEach(function (c) { set[c] = true; });
    this.players.forEach(function (p) {
      if (p.connectionStatus === 'quit') return;
      if (p.connId && set[p.connId]) p.connectionStatus = 'connected';
      else { p.connId = null; p.connectionStatus = 'disconnected'; }
    });
    this.markLeaderboard(); this.changed();
  };

  GameHost.prototype._join = function (connId, type, p) {
    var name = typeof p.playerName === 'string' ? p.playerName.trim() : '';
    var reject = function (self, reason) { self.sendTo(connId, 'JOIN_REJECTED', { reason: reason }); };
    if (!name || name.length > 20) return reject(this, 'Name must be 1-20 characters');
    if (String(p.pin) !== String(this.pin)) return reject(this, 'Wrong PIN');
    if (this.gameStatus !== 'lobby') return reject(this, 'Game already in progress');
    if (this.players.length >= this.settings.maxPlayers) return reject(this, 'Room full');
    // one pending entry / player record per socket
    if (this.playerByConn(connId)) return;
    if (this.settings.joinApprovalMode === 'host_approves') {
      if (type === 'JOIN_ROOM') { this.sendTo(connId, 'ROOM_SETTINGS', this.roomSettingsPayload()); return; }
      if (this.pending.some(function (x) { return x.connId === connId; })) return;
      this.pending.push({ pendingId: uuid(), connId: connId, name: name, deviceId: p.deviceId || null });
      this.changed(); return;
    }
    this._admit(connId, name, p.deviceId);
  };
  GameHost.prototype._uniqueName = function (name) {
    var taken = {}; this.players.forEach(function (p) { taken[p.name] = true; });
    if (!taken[name]) return name;
    for (var i = 2; ; i++) { var c = name + ' (' + i + ')'; if (!taken[c]) return c; }
  };
  GameHost.prototype._admit = function (connId, name, deviceId) {
    var pl = {
      playerId: uuid(), sessionToken: uuid(), name: this._uniqueName(name), connId: connId, deviceId: deviceId || null,
      connectionStatus: 'connected', points: 0, prizesWon: [], numbersMarked: 0, ticket: null, joinIndex: this.nextJoinIndex++
    };
    this.players.push(pl);
    this.sendTo(connId, 'JOIN_APPROVED', { playerId: pl.playerId, sessionToken: pl.sessionToken });
    this.sendTo(connId, 'ROOM_SETTINGS', this.roomSettingsPayload());
    this.markLeaderboard(); this.changed();
    return pl;
  };
  GameHost.prototype.approve = function (pendingId) {
    var i = this.pending.findIndex(function (x) { return x.pendingId === pendingId; });
    if (i < 0) return;
    var pd = this.pending.splice(i, 1)[0];
    if (this.gameStatus !== 'lobby') this.sendTo(pd.connId, 'JOIN_REJECTED', { reason: 'Game already in progress' });
    else if (this.players.length >= this.settings.maxPlayers) this.sendTo(pd.connId, 'JOIN_REJECTED', { reason: 'Room full' });
    else this._admit(pd.connId, pd.name, pd.deviceId);
    this.changed();
  };
  GameHost.prototype.reject = function (pendingId) {
    var i = this.pending.findIndex(function (x) { return x.pendingId === pendingId; });
    if (i < 0) return;
    var pd = this.pending.splice(i, 1)[0];
    this.sendTo(pd.connId, 'JOIN_REJECTED', { reason: 'Host declined' });
    this.changed();
  };

  GameHost.prototype._sync = function (connId, p, token) {
    var pl = this.playerById(p.playerId);
    if (!pl || !token || token !== pl.sessionToken || token !== p.sessionToken) return;
    if (pl.connectionStatus === 'quit') return;   // a quit is final for this identity; rejoining is a fresh join
    pl.connId = connId;
    if (pl.connectionStatus !== 'quit') pl.connectionStatus = 'connected';
    this._sendSync(pl);
    this.markLeaderboard(); this.changed();
  };
  GameHost.prototype._sendSync = function (pl) {
    var zero = [[0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0]];
    this.sendTo(pl.connId, 'STATE_SYNC_RESPONSE', {
      ticket: pl.ticket || zero, calledNumbersSoFar: this.calledNumbersSoFar.slice(),
      claimedPrizes: Object.keys(this.accepted), gameStatus: this.gameStatus
    });
    this.sendTo(pl.connId, 'ROOM_SETTINGS', this.roomSettingsPayload());
    this.sendTo(pl.connId, 'LEADERBOARD_UPDATE', { rankings: this.rankings() });
  };

  // ----- start / call / end (03 §3, §4) -----
  GameHost.prototype.canStart = function () { return this.gameStatus === 'lobby' && this.players.length >= 1; };
  GameHost.prototype.startGame = function () {
    if (!this.canStart()) return false;
    var self = this;
    this.pending.splice(0).forEach(function (pd) { self.sendTo(pd.connId, 'JOIN_REJECTED', { reason: 'Game already in progress' }); });
    this.broadcast('ROOM_SETTINGS', this.roomSettingsPayload());
    this._resetRound();
    var tickets = generateTickets(this.players.length);
    this.players.forEach(function (pl, i) {
      pl.ticket = tickets[i]; pl.points = 0; pl.prizesWon = []; pl.numbersMarked = 0;
    });
    this.players.forEach(function (pl) { if (pl.connId && pl.connectionStatus !== 'quit') self.sendTo(pl.connId, 'ASSIGN_TICKET', { playerId: pl.playerId, ticket: pl.ticket }); });
    this.gameStatus = 'in_progress';
    this.remainingNumbers = shuffle(Array.from({ length: 90 }, function (_, i) { return i + 1; }));
    this.autoRemainingMs = this.settings.autoCallIntervalSeconds * 1000;
    this.drawing = false; this.ttsPending = false;
    this.markLeaderboard(true); this.changed();
    return true;
  };
  GameHost.prototype.canCall = function () { return this.gameStatus === 'in_progress' && !this.drawing && this.remainingNumbers.length > 0; };
  GameHost.prototype.callNext = function () {
    if (!this.canCall()) return false;
    var self = this, n = this.remainingNumbers.pop();
    this.drawing = true; this.drawingNumber = n; this.ttsPending = false;
    this.emit('drawStart', { number: n, ms: DRAW_MS });
    this.changed();
    this.drawTimer = this.setTimeout(function () { self._commitCall(n); }, DRAW_MS);
    return true;
  };
  GameHost.prototype._commitCall = function (n) {
    this.drawing = false; this.drawTimer = null;
    this.calledNumbersSoFar.push(n); this.currentNumber = n;
    var callIndex = this.calledNumbersSoFar.length;
    this.broadcast('NUMBER_CALLED', { number: n, calledNumbersSoFar: this.calledNumbersSoFar.slice(), callIndex: callIndex });
    this.players.forEach(function (pl) {
      if (pl.connectionStatus === 'quit' || !pl.ticket) return;
      if (ticketNumbers(pl.ticket).indexOf(n) >= 0) pl.points += POINTS.perOwnNumberCalled;
    });
    this.markLeaderboard();
    this.ttsPending = !!this.settings.hostTtsEnabled;   // the UI calls ttsDone() when speech finishes
    if (!this.ttsPending) this.autoRemainingMs = this.settings.autoCallIntervalSeconds * 1000;
    this.emit('called', { number: n, callIndex: callIndex });
    this.changed();
  };
  GameHost.prototype.ttsDone = function () {
    if (!this.ttsPending) return;
    this.ttsPending = false;
    this.autoRemainingMs = this.settings.autoCallIntervalSeconds * 1000;   // countdown starts only after speech ends
    this.changed();
  };
  // called ~10x/second by the UI (Worker-driven so background tabs are not throttled)
  GameHost.prototype.tick = function (dtMs) {
    if (this.gameStatus !== 'in_progress' || !this.settings.autoCallEnabled) return;
    if (this.drawing || this.ttsPending || !this.remainingNumbers.length) return;
    this.autoRemainingMs -= dtMs;
    if (this.autoRemainingMs <= 0) { this.autoRemainingMs = 0; this.callNext(); }
  };
  GameHost.prototype.heartbeat = function () { this.transport.all(this._env('HEARTBEAT', {})); };

  // ----- pause / resume (03 §9) -----
  GameHost.prototype.pause = function () {
    if (this.gameStatus !== 'in_progress' || this.drawing) return false;
    this.gameStatus = 'paused'; this.broadcast('GAME_PAUSE', {}); this.changed(); return true;
  };
  GameHost.prototype.resume = function () {
    if (this.gameStatus !== 'paused') return false;
    this.gameStatus = 'in_progress'; this.broadcast('GAME_RESUME', {}); this.changed(); return true;   // autoRemainingMs is kept, not reset
  };

  // ----- claims (03 §5) -----
  GameHost.prototype._claim = function (pl, prizeType) {
    var self = this;
    var respond = function (accepted, pts, reason, record) {
      var payload = { playerId: pl.playerId, playerName: pl.name, prizeType: prizeType, accepted: accepted, pointsAwarded: pts, rejectionReason: reason };
      if (accepted) self.broadcast('CLAIM_RESULT', payload); else self.sendTo(pl.connId, 'CLAIM_RESULT', payload);
      if (record !== false) {
        var c = { id: ++self.claimSeq, playerId: pl.playerId, playerName: pl.name, prizeType: prizeType, accepted: accepted, pointsAwarded: pts, rejectionReason: reason, at: self.now(), overridden: false };
        self.claims.push(c); self.emit('claim', c);
      }
      self.changed();
    };
    if (!PRIZES[prizeType]) return;
    if (this.gameStatus === 'paused') return respond(false, 0, 'Game is paused', false);
    if (this.gameStatus !== 'in_progress') return respond(false, 0, 'Game is not in progress', false);
    if (!this.settings.prizesEnabled[prizeType]) return respond(false, 0, 'Prize is not enabled', false);
    if (this.accepted[prizeType] && this.accepted[prizeType] !== pl.playerId) return respond(false, 0, 'Already claimed by another player');
    if (this.accepted[prizeType] === pl.playerId) return;   // already yours; ignore repeat taps
    if (!checkPrize(pl.ticket, new Set(this.calledNumbersSoFar), prizeType)) return respond(false, 0, 'Ticket does not satisfy this prize yet');
    var pts = this._award(pl, prizeType);
    respond(true, pts, null);
    this.markLeaderboard(true);
  };
  GameHost.prototype._award = function (pl, prizeType) {
    var first = !this.accepted[prizeType];
    var pts = PRIZES[prizeType].basePoints + (first ? POINTS.speedBonus : 0);
    pl.points += pts; pl.prizesWon.push(prizeType); this.accepted[prizeType] = pl.playerId;
    return pts;
  };
  // admin-only correction (03 §5 step 8)
  GameHost.prototype.overrideClaim = function (claimId) {
    var c = this.claims.filter(function (x) { return x.id === claimId; })[0];
    if (!c) return false;
    var pl = this.playerById(c.playerId); if (!pl) return false;
    if (c.accepted) {
      pl.points -= c.pointsAwarded; if (pl.points < 0) pl.points = 0;
      pl.prizesWon = pl.prizesWon.filter(function (x) { return x !== c.prizeType; });
      if (this.accepted[c.prizeType] === pl.playerId) delete this.accepted[c.prizeType];
      c.accepted = false; c.awardedBefore = c.pointsAwarded; c.pointsAwarded = 0; c.rejectionReason = 'Overridden by host';
    } else {
      if (this.accepted[c.prizeType]) return false;   // someone holds it; override that claim first
      c.pointsAwarded = this._award(pl, c.prizeType); c.accepted = true; c.rejectionReason = null;
    }
    c.overridden = true;
    this.broadcast('CLAIM_OVERRIDE', { playerId: pl.playerId, prizeType: c.prizeType, newAcceptedState: c.accepted, correctedByHost: true });
    this.markLeaderboard(true); this.changed();
    return true;
  };
  GameHost.prototype.canOverride = function (c) { return c.accepted || !this.accepted[c.prizeType]; };

  // ----- announcements (03 §6) — never touches points/prizes/claims -----
  GameHost.prototype._announce = function (pl, row) {
    if (['top', 'middle', 'bottom'].indexOf(row) < 0) return;
    if (this.gameStatus !== 'in_progress' && this.gameStatus !== 'paused') return;
    var key = pl.playerId + '|' + row;
    if (this.announced[key]) return;            // silent backstop
    this.announced[key] = true;
    var payload = { playerId: pl.playerId, playerName: pl.name, row: row };
    var ids = this.players.filter(function (x) { return x.connId && x.connectionStatus !== 'quit' && x.playerId !== pl.playerId; }).map(function (x) { return x.connId; });
    if (ids.length) this.transport.toMany(ids, this._env('ANNOUNCE', payload));
    this.emit('announce', payload);
  };

  // ----- quit / kick (10 §1) -----
  GameHost.prototype._quit = function (pl) {
    if (this.gameStatus === 'lobby') {          // leaving the lobby just removes the player; there is no standing to preserve
      this.players = this.players.filter(function (x) { return x !== pl; });
    } else { pl.connectionStatus = 'quit'; pl.connId = null; }
    this.markLeaderboard(); this.changed();
  };
  GameHost.prototype.kickPlayer = function (playerId) {
    var i = this.players.findIndex(function (p) { return p.playerId === playerId; });
    if (i < 0) return false;
    var pl = this.players.splice(i, 1)[0];
    if (pl.connId) { this.sendTo(pl.connId, 'KICK_PLAYER', { reason: 'Removed by the host' }); this.transport.kick(pl.connId); }
    this.markLeaderboard(true); this.changed();
    return true;
  };

  // ----- leaderboard (03 §8: at most one broadcast per 1000 ms) -----
  GameHost.prototype.rankings = function () {
    return sortRankings(this.players).map(function (p) {
      return { playerId: p.playerId, playerName: p.name, points: p.points, prizesWon: p.prizesWon.slice(), numbersMarked: p.numbersMarked, connectionStatus: p.connectionStatus };
    });
  };
  GameHost.prototype.markLeaderboard = function (/*urgent*/) {
    var self = this;
    this.lbDirty = true;
    if (this.lbTimer) return;
    var wait = Math.max(0, LEADERBOARD_THROTTLE_MS - (this.now() - this.lbLast));
    this.lbTimer = this.setTimeout(function () {
      self.lbTimer = null;
      if (!self.lbDirty) return;
      self.lbDirty = false; self.lbLast = self.now();
      self.broadcast('LEADERBOARD_UPDATE', { rankings: self.rankings() });
    }, wait);
  };

  // ----- game over / new game (03 §1, 06 §8.6) -----
  GameHost.prototype.endGame = function () {
    if (this.gameStatus !== 'in_progress' && this.gameStatus !== 'paused') return false;
    if (this.drawTimer) { this.clearTimeout(this.drawTimer); this.drawTimer = null; if (this.drawing) { this.remainingNumbers.push(this.drawingNumber); this.drawing = false; } }
    this.gameStatus = 'ended';
    var money = allocateMoney(this.players, this.settings, this.accepted.fullHouse);
    this.finalRankings = sortRankings(this.players).map(function (p) {
      return { playerId: p.playerId, playerName: p.name, points: p.points, moneyPrize: money[p.playerId] || 0 };
    });
    this.broadcast('GAME_OVER', { finalRankings: this.finalRankings });
    this.markLeaderboard(true); this.changed();
    return true;
  };
  GameHost.prototype.newGame = function () {
    if (this.gameStatus !== 'ended') return false;
    var self = this;
    this.players = this.players.filter(function (p) { return p.connectionStatus !== 'quit'; });
    this.pending.splice(0).forEach(function (pd) { self.sendTo(pd.connId, 'JOIN_REJECTED', { reason: 'Host declined' }); });
    this._resetRound();
    this.finalRankings = null;
    this.players.forEach(function (p) { p.ticket = null; p.points = 0; p.prizesWon = []; p.numbersMarked = 0; });
    this.gameStatus = 'lobby'; this.drawing = false; this.ttsPending = false;
    this.players.forEach(function (p) { if (p.connId) self._sendSync(p); });
    this.markLeaderboard(true); this.changed();
    return true;
  };

  // ----- persistence (host page reload keeps the room alive) -----
  GameHost.prototype.serialize = function () {
    return JSON.stringify({
      v: 1, pin: this.pin, settings: this.settings, gameStatus: this.gameStatus, players: this.players, nextJoinIndex: this.nextJoinIndex,
      calledNumbersSoFar: this.calledNumbersSoFar, remainingNumbers: this.remainingNumbers, claims: this.claims, accepted: this.accepted,
      announced: this.announced, claimSeq: this.claimSeq, currentNumber: this.currentNumber, finalRankings: this.finalRankings || null,
      autoRemainingMs: this.autoRemainingMs
    });
  };
  GameHost.prototype.restore = function (json) {
    var d = typeof json === 'string' ? JSON.parse(json) : json;
    this.pin = d.pin; this.settings = d.settings; this.players = d.players; this.nextJoinIndex = d.nextJoinIndex;
    this.calledNumbersSoFar = d.calledNumbersSoFar; this.remainingNumbers = d.remainingNumbers; this.claims = d.claims;
    this.accepted = d.accepted; this.announced = d.announced; this.claimSeq = d.claimSeq; this.currentNumber = d.currentNumber;
    this.finalRankings = d.finalRankings; this.autoRemainingMs = d.autoRemainingMs || 0;
    this.gameStatus = d.gameStatus === 'in_progress' ? 'paused' : d.gameStatus;   // never resume live calling by surprise
    this.drawing = false; this.ttsPending = false;
    this.players.forEach(function (p) { if (p.connectionStatus !== 'quit') p.connectionStatus = 'disconnected'; });
  };

  var api = {
    COLUMN_RANGES: COLUMN_RANGES, MATRIX: MATRIX, PRIZES: PRIZES, PRIZE_ORDER: PRIZE_ORDER, POINTS: POINTS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS, DRAW_MS: DRAW_MS, LEADERBOARD_THROTTLE_MS: LEADERBOARD_THROTTLE_MS,
    generateBook: generateBook, generateTickets: generateTickets, checkPrize: checkPrize, ticketNumbers: ticketNumbers,
    rowNumbers: rowNumbers, cornerNumbers: cornerNumbers, shuffle: shuffle, uuid: uuid, randInt: randInt,
    englishWords: englishWords, englishDigits: englishDigits, teluguWords: teluguWords,
    sortRankings: sortRankings, allocateMoney: allocateMoney, GameHost: GameHost
  };
  root.Tambola = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
