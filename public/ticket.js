/* Ticket renderer shared by the host landing page (read-only sample) and the player screen. */
(function (root) {
  'use strict';
  function tornPolygon() {
    var pts = [], n = 34, i, r = function (a, b) { return a + Math.random() * (b - a); };
    for (i = 0; i <= n; i++) pts.push((i / n * 100).toFixed(2) + '% ' + r(0, 2.4).toFixed(2) + '%');           // top edge
    for (i = 1; i <= 6; i++) pts.push(r(97.8, 100).toFixed(2) + '% ' + (i / 7 * 100).toFixed(2) + '%');        // right edge
    for (i = n; i >= 0; i--) pts.push((i / n * 100).toFixed(2) + '% ' + r(97.4, 100).toFixed(2) + '%');        // bottom edge
    for (i = 6; i >= 1; i--) pts.push(r(0, 2.2).toFixed(2) + '% ' + (i / 7 * 100).toFixed(2) + '%');           // left edge
    return 'polygon(' + pts.join(',') + ')';
  }
  var X_SVG = '<svg class="x" viewBox="0 0 40 40" aria-hidden="true"><path class="x1" pathLength="100" d="M7 8 C12 12 21 23 33.5 33"/><path class="x2" pathLength="100" d="M32.5 6.5 C26 14 16 25 7.5 34.5"/></svg>';

  // opts: { readonly, onTap(number, cellEl) }. Returns { cells: {number: el} }
  function render(container, grid, opts) {
    opts = opts || {};
    container.innerHTML = '';
    var box = document.createElement('div'); box.className = 'ticket-box';
    var paper = document.createElement('div'); paper.className = 'ticket-paper'; paper.style.clipPath = tornPolygon();
    var g = document.createElement('div'); g.className = 'ticket-grid' + (opts.readonly ? ' readonly' : '');
    var cells = {};
    for (var r = 0; r < 3; r++) for (var c = 0; c < 9; c++) {
      var n = grid[r][c], el = document.createElement(n && !opts.readonly ? 'button' : 'div');
      el.className = 'tcell' + (n ? '' : ' blank');
      if (n) {
        el.textContent = n; el.insertAdjacentHTML('beforeend', X_SVG); cells[n] = el;
        if (!opts.readonly) { el.type = 'button'; el.setAttribute('aria-pressed', 'false'); el.setAttribute('aria-label', 'Number ' + n); (function (n, el) { el.addEventListener('click', function () { if (opts.onTap) opts.onTap(n, el); }); })(n, el); }
      }
      g.appendChild(el);
    }
    paper.appendChild(g); box.appendChild(paper); container.appendChild(box);
    return { cells: cells };
  }
  root.Ticket = { render: render };
})(window);
