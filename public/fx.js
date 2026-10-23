/* Sounds are synthesised with Web Audio so the app needs no audio files and works fully offline.
   Haptics use navigator.vibrate (Android browsers; iPhones do not expose vibration to web pages). */
(function (root) {
  'use strict';
  var ctx = null, master = null, ambient = null;

  function ensure() {
    try {
      if (!ctx) {
        var AC = root.AudioContext || root.webkitAudioContext; if (!AC) return null;
        ctx = new AC(); master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') { var rp = ctx.resume(); if (rp && rp.catch) rp.catch(function () {}); }
    } catch (e) { return null; }
    return ctx;
  }
  function tone(o) {
    var c = ensure(); if (!c) return;
    var t0 = c.currentTime + (o.at || 0), osc = c.createOscillator(), g = c.createGain();
    osc.type = o.type || 'sine'; osc.frequency.setValueAtTime(o.f, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + o.d);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(o.v || 0.2, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.d);
    osc.connect(g); g.connect(master); osc.start(t0); osc.stop(t0 + o.d + 0.05);
  }
  function noise(o) {
    var c = ensure(); if (!c) return;
    var len = Math.max(1, Math.floor(c.sampleRate * o.d)), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = c.createBufferSource(); src.buffer = buf;
    var f = c.createBiquadFilter(); f.type = o.ftype || 'bandpass'; f.frequency.value = o.f || 1800; f.Q.value = o.q || 1;
    var g = c.createGain(); g.gain.value = o.v || 0.2; var t0 = c.currentTime + (o.at || 0);
    src.connect(f); f.connect(g); g.connect(master); src.start(t0);
  }

  var Sfx = {
    unlock: ensure,
    clack: function () { noise({ d: 0.05, f: 2600, q: 0.7, v: 0.5 }); tone({ f: 190, to: 90, d: 0.12, type: 'triangle', v: 0.35 }); },
    mark: function () { noise({ d: 0.13, f: 2200, q: 1.2, v: 0.28 }); tone({ f: 620, to: 420, d: 0.09, type: 'triangle', v: 0.08 }); },
    unmark: function () { noise({ d: 0.09, f: 1500, q: 1, v: 0.08 }); },
    wrong: function () { tone({ f: 150, to: 95, d: 0.11, type: 'square', v: 0.07 }); },
    popup: function () { tone({ f: 880, d: 0.16, type: 'sine', v: 0.07 }); },                       // quieter, shorter than the claim sounds
    chime: function () { tone({ f: 880, d: 0.7, v: 0.2 }); tone({ f: 1320, d: 0.9, v: 0.14, at: 0.12 }); },   // ~1 s
    fanfare: function () {                                                                             // ~2 s
      [523, 659, 784, 1047].forEach(function (f, i) { tone({ f: f, d: 0.28, type: 'triangle', v: 0.22, at: i * 0.16 }); });
      tone({ f: 784, d: 0.5, type: 'triangle', v: 0.2, at: 0.75 }); tone({ f: 1047, d: 1.0, type: 'triangle', v: 0.24, at: 1.0 });
      tone({ f: 523, d: 1.0, type: 'sine', v: 0.14, at: 1.0 });
    },
    ambientOn: function () {                                                                           // hall-hum loop, capped at 15% volume
      var c = ensure(); if (!c || ambient) return;
      var len = c.sampleRate * 4, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0), last = 0;
      for (var i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
      var src = c.createBufferSource(); src.buffer = buf; src.loop = true;
      var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520;
      var g = c.createGain(); g.gain.value = 0.15;
      src.connect(lp); lp.connect(g); g.connect(master); src.start();
      ambient = { src: src, g: g };
    },
    ambientOff: function () { if (ambient) { try { ambient.src.stop(); } catch (e) {} ambient = null; } }
  };

  var Haptic = {
    _v: function (p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} },
    light: function () { this._v(12); },
    medium: function () { this._v(35); },
    double: function () { this._v([35, 70, 35]); },      // incorrect tap
    heavy: function () { this._v(220); },                // own prize won
    single: function () { this._v(80); }                 // disconnect
  };

  // Full House burst — uses only the Accent and Connected-status green (08 §6)
  function confetti() {
    if (root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var cv = document.createElement('canvas'); cv.className = 'confetti'; document.body.appendChild(cv);
    var W = cv.width = innerWidth, H = cv.height = innerHeight, g = cv.getContext('2d'); if (!g) { cv.remove(); return; }
    var cols = ['#E0A458', '#2ECC71'], ps = [];
    for (var i = 0; i < 160; i++) ps.push({ x: W / 2, y: H * 0.35, vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 15 - 4, s: 5 + Math.random() * 7, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: cols[i % 2] });
    var t0 = performance.now();
    (function frame(t) {
      var e = t - t0; g.clearRect(0, 0, W, H);
      ps.forEach(function (p) { p.vy += 0.38; p.x += p.vx; p.y += p.vy; p.r += p.vr; g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.fillStyle = p.c; g.globalAlpha = Math.max(0, 1 - e / 2800); g.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); g.restore(); });
      if (e < 2800) requestAnimationFrame(frame); else cv.remove();
    })(t0);
  }

  // tiny modal helper
  function modal(html, buttons) {
    return new Promise(function (resolve) {
      var w = document.createElement('div'); w.className = 'modal-wrap'; w.setAttribute('role', 'dialog'); w.setAttribute('aria-modal', 'true');
      var m = document.createElement('div'); m.className = 'modal'; m.innerHTML = html;
      var row = document.createElement('div'); row.className = 'row';
      (buttons || [{ label: 'OK', value: true }]).forEach(function (b) {
        var el = document.createElement('button'); el.className = 'btn ' + (b.cls || ''); el.textContent = b.label;
        el.onclick = function () { w.remove(); resolve(b.value); }; row.appendChild(el);
      });
      m.appendChild(row); w.appendChild(m); document.body.appendChild(w);
      var first = row.querySelector('button:last-child'); if (first) first.focus();
    });
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // Toast queue: at most `max` visible, each auto-dismisses after `ms` (09 §3: 2500 ms, max 2 stacked)
  function ToastQueue(region, max, ms) {
    this.region = region; this.max = max; this.ms = ms; this.q = []; this.visible = 0;
  }
  ToastQueue.prototype.push = function (text, cls) { this.q.push({ text: text, cls: cls || '' }); this._pump(); };
  ToastQueue.prototype._pump = function () {
    var self = this;
    while (this.visible < this.max && this.q.length) {
      var it = this.q.shift(), el = document.createElement('div');
      el.className = 'toast toast-in ' + it.cls; el.textContent = it.text; this.region.appendChild(el); this.visible++;
      (function (el) { setTimeout(function () { el.remove(); self.visible--; self._pump(); }, self.ms); })(el);
    }
  };

  root.Sfx = Sfx; root.Haptic = Haptic; root.Fx = { confetti: confetti, modal: modal, esc: esc, ToastQueue: ToastQueue };
})(window);
