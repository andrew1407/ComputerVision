// Computer Vision Labs showcase: lab panels, canvas players, WebGL and SVG charts.
// Every lab runs its own Python through PyScript (bridge.py, showcase.py):
//  - labs 1-5 and the control task run main.py against a tkinter recorder
//    (shims/tkinter.py); the page replays the log on a canvas,
//  - lab 6 runs against an OpenGL recorder (shims/OpenGL) and is drawn with WebGL,
//  - labs 7 and 8 call the lab's OpenCV functions on the repo's images or yours.

const REPO = 'https://github.com/Andrew1407/ComputerVision';
const SRC = `${REPO}/blob/main`;
const TREE = `${REPO}/tree/main`;
const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v, d = 4) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(2);
  return String(+v.toFixed(d));
};
const msFmt = (v) => `${fmt(v, v < 10 ? 2 : 0)} ms`;
const range = (n, f = (i) => i) => Array.from({ length: n }, (_, i) => f(i));
const pause = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const stat = (value, label, cls = '') => `<div class="stat ${cls}"><b>${value}</b><span>${label}</span></div>`;
const int = (v) => Math.round(v).toLocaleString('en-US');

// ---------------------------------------------------------------- runtimes --
let pyReady = false;
const pyWaiters = [];
window.addEventListener('py-ready', () => {
  pyReady = true;
  document.querySelectorAll('.py-status').forEach((el) => el.remove());
  pyWaiters.splice(0).forEach((f) => f());
});
const whenPy = () => (pyReady ? Promise.resolve() : new Promise((r) => pyWaiters.push(r)));

function pyCall(name, params = {}) {
  const res = JSON.parse(window.pyRun(name, JSON.stringify(params)));
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
async function runPy(name, params) {
  await whenPy();
  await pause();
  return pyCall(name, params);
}

// OpenCV and SciPy are big, so they're only fetched when lab 7 or 8 is opened
const loaded = new Set();
async function ensurePackages(pkgs, out) {
  await whenPy();
  const missing = pkgs.filter((p) => !loaded.has(p));
  if (!missing.length) return;
  const size = { 'opencv-python': 11, scipy: 14 };
  const mb = missing.reduce((s, p) => s + (size[p] || 1), 0);
  const box = document.createElement('div');
  box.className = 'loading';
  box.setAttribute('role', 'status');
  box.innerHTML = `<span class="spinner" aria-hidden="true"></span><div><b>Loading ${missing.map((p) => (p === 'opencv-python' ? 'OpenCV' : 'SciPy')).join(' and ')} for WebAssembly…</b><small>About ${mb} MB on the first visit, cached after that.</small></div><div class="bar" aria-hidden="true"><i></i></div>`;
  out.before(box);
  try { await window.pyEnsure(JSON.stringify(missing)); missing.forEach((p) => loaded.add(p)); }
  finally { box.remove(); }
}

// repo files the image labs read with cv2.imread, fetched once and written at the same path in Pyodide
const fetched = new Set();
const toB64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
async function ensureFile(lab, rel) {
  const key = `${lab}/${rel}`;
  if (fetched.has(key)) return;
  const resp = await fetch(`../${lab}/${rel}`);
  if (!resp.ok) throw new Error(`Couldn't fetch ${key} (${resp.status})`);
  pyCall('put_file', { lab, rel, data_b64: await toB64(await resp.blob()) });
  fetched.add(key);
}

// ------------------------------------------------------------------ charts --
const charts = new Map();
let chartSeq = 0;

function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const m = raw / p;
  return (m >= 5 ? 10 : m >= 2 ? 5 : m >= 1 ? 2 : 1) * p;
}
function ticks(min, max, count) {
  if (min === max) { min -= 1; max += 1; }
  const step = niceStep(max - min, count);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toPrecision(12));
  return { lo, hi, ticks: out };
}

/** spec: { title, x, y, series: [{ name, xs, ys, color, width, dash }], marks: [{ x, label, color }], height } */
function chart(spec) {
  const id = `c${++chartSeq}`;
  charts.set(id, spec);
  const keys = spec.series.length > 1 || spec.marks?.length
    ? `<span class="keys">${spec.series.map((s) => `<span><i style="background:var(${s.color})"></i>${esc(s.name)}</span>`).join('')}${(spec.marks || []).map((m) => `<span><i style="background:var(${m.color});width:3px;height:10px;vertical-align:-1px"></i>${esc(m.label)}</span>`).join('')}</span>` : '';
  return `<figure class="chart" data-chart="${id}" data-copyable data-title="${esc(spec.title)}"><figcaption><span>${esc(spec.title)}</span>${keys}${actions('png', 'csv')}</figcaption><div class="plot"></div></figure>`;
}

function drawCharts(root = document) {
  root.querySelectorAll('figure.chart').forEach((fig) => {
    const spec = charts.get(fig.dataset.chart);
    const plot = $('.plot', fig);
    if (!spec || !plot.offsetParent) return;
    drawChart(plot, spec);
  });
}
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => drawCharts(), 120); });

function drawChart(plot, spec) {
  const W = Math.max(260, plot.clientWidth), H = spec.height || 210;
  const M = { l: 58, r: 14, t: 8, b: 38 };
  const all = spec.series.flatMap((s) => s.xs.map((x, i) => [x, s.ys[i]])).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (!all.length) { plot.innerHTML = '<p class="hint">No data.</p>'; return; }
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const [x, y] of all) { if (x < xmin) xmin = x; if (x > xmax) xmax = x; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
  if (spec.yZero) ymin = Math.min(0, ymin);
  const xr = ticks(xmin, xmax, Math.max(3, Math.floor((W - M.l) / 90)));
  const yr = ticks(ymin, ymax, 5);
  const x0 = xmin, x1 = xmax;
  const X = (v) => M.l + ((v - x0) / (x1 - x0 || 1)) * (W - M.l - M.r);
  const Y = (v) => H - M.b - ((v - yr.lo) / (yr.hi - yr.lo || 1)) * (H - M.t - M.b);
  const xt = xr.ticks.filter((v) => v >= x0 - 1e-9 && v <= x1 + 1e-9);
  const grid = yr.ticks.map((v) => `<line x1="${M.l}" x2="${W - M.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)"/><text x="${M.l - 8}" y="${Y(v)}" text-anchor="end" dominant-baseline="middle">${fmt(v, 6)}</text>`).join('')
    + xt.map((v) => `<line x1="${X(v)}" x2="${X(v)}" y1="${H - M.b}" y2="${H - M.b + 4}" stroke="var(--muted)"/><text x="${X(v)}" y="${H - M.b + 16}" text-anchor="middle">${fmt(v, 6)}</text>`).join('');
  const axes = `<line x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}" stroke="var(--line)"/>`
    + `<text x="${(M.l + W - M.r) / 2}" y="${H - 4}" text-anchor="middle">${esc(spec.x)}</text>`
    + `<text transform="translate(12 ${(M.t + H - M.b) / 2}) rotate(-90)" text-anchor="middle">${esc(spec.y)}</text>`;
  const marks = (spec.marks || []).map((m) => `<line x1="${X(m.x)}" x2="${X(m.x)}" y1="${M.t}" y2="${H - M.b}" stroke="var(${m.color})" stroke-width="2" stroke-dasharray="5 3"/><text x="${X(m.x) + 5}" y="${M.t + 10}" style="fill:var(${m.color})">${esc(m.short || m.label)}</text>`).join('');
  const lines = spec.series.map((s) => {
    const pts = s.xs.map((x, i) => `${X(x).toFixed(1)},${Y(s.ys[i]).toFixed(1)}`).join(' ');
    const dots = spec.dots || s.xs.length <= 30 ? s.xs.map((x, i) => `<circle cx="${X(x)}" cy="${Y(s.ys[i])}" r="2.6" fill="var(${s.color})"/>`).join('') : '';
    return `<polyline points="${pts}" fill="none" stroke="var(${s.color})" stroke-width="${s.width || 1.8}" stroke-linejoin="round" ${s.dash ? 'stroke-dasharray="5 4"' : ''} ${s.opacity ? `stroke-opacity="${s.opacity}"` : ''}/>${dots}`;
  }).join('');
  plot.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(spec.title)}">${grid}${axes}${lines}${marks}<line class="cross" y1="${M.t}" y2="${H - M.b}" stroke="var(--muted)" stroke-dasharray="3 3" visibility="hidden"/><g class="marks"></g></svg><div class="tip" hidden></div>`;

  const svg = $('svg', plot), tip = $('.tip', plot), cross = $('.cross', svg), hover = $('.marks', svg);
  const nearest = (xs, v) => {
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] < v) lo = m; else hi = m; }
    return Math.abs(xs[lo] - v) <= Math.abs(xs[hi] - v) ? lo : hi;
  };
  const move = (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    if (px < M.l - 6 || px > W - M.r + 6) return hide();
    const v = x0 + ((px - M.l) / (W - M.l - M.r)) * (x1 - x0);
    const hits = spec.series.map((s) => { const i = nearest(s.xs, v); return { s, x: s.xs[i], y: s.ys[i] }; });
    const hx = X(hits[0].x);
    cross.setAttribute('x1', hx); cross.setAttribute('x2', hx); cross.setAttribute('visibility', 'visible');
    hover.innerHTML = hits.map((h) => `<circle cx="${X(h.x)}" cy="${Y(h.y)}" r="4" fill="var(--panel)" stroke="var(${h.s.color})" stroke-width="2"/>`).join('');
    tip.innerHTML = `<div class="tx">${esc(spec.x)} = ${fmt(hits[0].x, 6)}</div>` + hits.map((h) => `<div><i style="background:var(${h.s.color})"></i>${esc(h.s.name || spec.y)}: ${fmt(h.y, 6)}</div>`).join('');
    tip.hidden = false;
    const left = (hx / W) * rect.width;
    const tw = tip.offsetWidth;
    tip.style.left = `${left + 12 + tw > rect.width ? Math.max(0, left - tw - 12) : left + 12}px`;
    tip.style.top = `${M.t}px`;
  };
  const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); hover.innerHTML = ''; };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', hide);
}

// ------------------------------------------------------------------ copying --
const ACTION_LABEL = { png: 'Copy image', img: 'Copy image', csv: 'Copy CSV', table: 'Copy table', results: 'Copy results', text: 'Copy text' };
const ACTION_TIP = {
  png: 'Copy as a PNG image (downloads it if the clipboard is unavailable)', img: 'Copy the canvas as a PNG image (downloads it if the clipboard is unavailable)',
  csv: 'Copy the plotted data as CSV', table: 'Copy the table as tab-separated text, pastes into spreadsheets',
  results: 'Copy the inputs and results as text', text: 'Copy the printed output',
};
const actions = (...kinds) => `<span class="copy-actions">${kinds.map((k) => `<button type="button" class="mini" data-act="${k}" title="${ACTION_TIP[k]}">${ACTION_LABEL[k]}</button>`).join('')}</span>`;

// Render an on-screen SVG to PNG: computed colours and fonts are inlined so the image
// matches the current theme, with the caption drawn above it.
function svgPng(svg, title, legend = [], scale = 2) {
  const box = svg.viewBox.baseVal;
  const w = (box && box.width) || +svg.getAttribute('width') || svg.clientWidth;
  const h = (box && box.height) || +svg.getAttribute('height') || svg.clientHeight;
  const clone = svg.cloneNode(true);
  const src = [svg, ...svg.querySelectorAll('*')], dst = [clone, ...clone.querySelectorAll('*')];
  src.forEach((el, i) => {
    const cs = getComputedStyle(el), c = dst[i];
    for (const a of ['fill', 'stroke', 'stroke-opacity', 'fill-opacity', 'stroke-width', 'opacity', 'visibility']) c.setAttribute(a, cs.getPropertyValue(a));
    if (el.tagName === 'text') for (const a of ['font-family', 'font-size', 'font-weight']) c.setAttribute(a, cs.getPropertyValue(a));
    c.removeAttribute('style'); c.removeAttribute('class');
  });
  clone.querySelectorAll('title, .marks').forEach((t) => t.remove());
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', w); clone.setAttribute('height', h);
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const css = getComputedStyle(document.documentElement);
  const head = title ? 30 : 0, pad = 14;
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = (w + pad * 2) * scale; c.height = (h + head + pad * 2) * scale;
      const ctx = c.getContext('2d');
      ctx.scale(scale, scale);
      ctx.fillStyle = css.getPropertyValue('--panel').trim();
      ctx.fillRect(0, 0, w + pad * 2, h + head + pad * 2);
      const family = getComputedStyle(document.body).fontFamily;
      if (title) {
        ctx.fillStyle = css.getPropertyValue('--ink').trim();
        ctx.font = `600 14px ${family}`;
        ctx.fillText(title, pad, pad + 14);
        ctx.font = `12px ${family}`;
        let x = w + pad;
        for (const { name, color } of [...legend].reverse()) {
          x -= ctx.measureText(name).width;
          ctx.fillStyle = css.getPropertyValue('--muted').trim();
          ctx.fillText(name, x, pad + 13);
          x -= 19;
          ctx.fillStyle = css.getPropertyValue(color).trim();
          ctx.fillRect(x, pad + 7, 14, 3);
          x -= 14;
        }
      }
      ctx.drawImage(img, pad, pad + head, w, h);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG render failed')); };
    img.src = url;
  });
}

// a canvas copies as exactly what it shows (canvas.toBlob); WebGL canvases keep their buffer for this
const canvasPng = (canvas) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
function chartCsv(spec) {
  const s0 = spec.series[0];
  const shared = spec.series.every((s) => s.xs.length === s0.xs.length && s.xs.every((x, i) => x === s0.xs[i]));
  if (shared) return [[spec.x, ...spec.series.map((s) => s.name || spec.y)], ...s0.xs.map((x, i) => [x, ...spec.series.map((s) => s.ys[i])])].map((r) => r.map(csvCell).join(',')).join('\n');
  return [['series', spec.x, spec.y], ...spec.series.flatMap((s) => s.xs.map((x, i) => [s.name, x, s.ys[i]]))].map((r) => r.map(csvCell).join(',')).join('\n');
}
const tableTsv = (table) => [...table.rows].map((r) => [...r.cells].map((c) => c.innerText.trim().replace(/\s+/g, ' ')).join('\t')).join('\n');

function resultsText(sec) {
  const lab = LABS.find((l) => `panel-${l.id}` === sec.id);
  const p = params(lab);
  const lines = [`${labName(lab)}: ${lab.name}`];
  const shown = lab.fields.filter((f) => f.type !== 'file' && (!f.when || p[f.when[0]] === f.when[1]));
  if (shown.length) lines.push(`Parameters: ${shown.map((f) => `${f.label} = ${p[f.key]}`).join(', ')}`);
  const out = $('.out', sec);
  out.querySelectorAll('.stats').forEach((st) => {
    const group = st.closest('[data-group]')?.dataset.group;
    if (group) lines.push(`${group}:`);
    st.querySelectorAll('.stat').forEach((x) => lines.push(`${group ? '  ' : ''}${$('span', x).innerText.trim()}: ${$('b', x).innerText.trim()}`));
  });
  out.querySelectorAll('pre.out-text').forEach((pre) => lines.push('Printed output:', pre.innerText.trimEnd()));
  return lines.join('\n');
}

async function copyAction(btn) {
  const kind = btn.dataset.act, box = btn.closest('[data-copyable]');
  const done = (text) => { btn.textContent = text; setTimeout(() => (btn.textContent = ACTION_LABEL[kind]), 1400); };
  const name = (box?.dataset.title || 'image').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  try {
    if (kind === 'png' || kind === 'img') {
      let make;
      if (kind === 'img') {
        const canvas = box.querySelector('canvas');
        box._beforeCopy?.();
        make = () => canvasPng(canvas);
      } else {
        const svg = box.querySelector('.plot svg, svg');
        const spec = charts.get(box.dataset.chart);
        const legend = spec && spec.series.length > 1 ? spec.series.map((x) => ({ name: x.name, color: x.color })) : [];
        make = () => svgPng(svg, box.dataset.title, legend);
      }
      try {
        // pass the promise straight to ClipboardItem so Safari keeps the user gesture
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': make() })]);
        return done('Copied');
      } catch {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(await make());
        a.download = `${name}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        return done('Downloaded');
      }
    }
    const text = kind === 'csv' ? chartCsv(charts.get(box.dataset.chart))
      : kind === 'table' ? tableTsv(box.querySelector('table'))
      : kind === 'text' ? box.querySelector('pre').innerText
      : resultsText(btn.closest('section.panel'));
    await navigator.clipboard.writeText(text);
    done('Copied');
  } catch (e) { console.error(e); done('Failed'); }
}
document.addEventListener('click', (e) => { const b = e.target.closest('button[data-act]'); if (b) copyAction(b); });

// --------------------------------------------------------- tkinter player --
// Replays the canvas log recorded by shims/tkinter.py while the lab's own
// graphics.py drew into it. Op layout is documented in showcase._pack_window.
const TK_COLORS = { green: '#00ff00', gray: '#bebebe', grey: '#bebebe', maroon: '#b03060', purple: '#a020f0' }; // X11 names that differ from CSS
const tkColor = (c) => (c ? TK_COLORS[c.toLowerCase()] || c : '');
const PLAY = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>';
const PAUSE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor"/></svg>';
const REPLAY = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 8a5 5 0 1 0 1.5-3.6M3 2.5v3h3"/></svg>';

class TkWindow {
  constructor(session, spec, index) {
    Object.assign(this, { session, spec, index });
    const ops = spec.ops;
    this.colors = spec.colors.map(tkColor);
    const clickAt = ops.findIndex((o) => o[1] === 5);
    const drawEnd = clickAt < 0 ? ops.length : clickAt;
    const timed = ops.slice(0, drawEnd).some((o) => o[0] > 0);
    // windows without time.sleep are drawn as fast as Tk can; replay them in drawing order instead
    this.reveal = !timed;
    const adds = ops.slice(0, drawEnd).filter((o) => o[1] === 0).length;
    const D = this.reveal ? Math.min(6, Math.max(1.5, adds / 12000)) : 0;
    this.times = ops.map((o, i) => (this.reveal ? (i < drawEnd ? (i / Math.max(1, drawEnd)) * D : D + (o[0] - (ops[drawEnd]?.[0] || 0))) : o[0]));
    this.clickIndex = clickAt;
    this.end = this.times.length ? this.times[this.times.length - 1] : 0;
    this.drawEnd = clickAt < 0 ? this.end : this.times[clickAt];
    this.bbox = this.computeBox();
    this.t = 0; this.applied = 0; this.state = index === 0 ? 'playing' : 'pending';
    this.build();
    this.reset();
  }

  computeBox() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of this.spec.ops) {
      if (o[1] !== 0) continue;
      const w = o[6] || 1, c = o.slice(7);
      if (o[3] === 5) c.push(c[0] + 2, c[1] + 2);
      for (let i = 0; i + 1 < c.length; i += 2) {
        x0 = Math.min(x0, c[i] - w); x1 = Math.max(x1, c[i] + w);
        y0 = Math.min(y0, c[i + 1] - w); y1 = Math.max(y1, c[i + 1] + w);
      }
    }
    if (!Number.isFinite(x0)) return null;
    const { width: W, height: H } = this.spec;
    const m = Math.max(12, 0.08 * Math.max(x1 - x0, y1 - y0));
    x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(W, x1 + m); y1 = Math.min(H, y1 + m);
    if (x1 - x0 < 8 || y1 - y0 < 8) return null;
    return [x0, y0, x1 - x0, y1 - y0];
  }

  build() {
    const s = this.spec;
    const el = document.createElement('figure');
    el.className = 'win';
    el.style.margin = '0';
    el.dataset.copyable = '';
    el.dataset.title = s.title;
    el.innerHTML = `<div class="win-bar"><span class="win-dots" aria-hidden="true"><i></i><i></i><i></i></span><b title="GraphWin title">${esc(s.title)}</b><span class="muted">${s.width}×${s.height}</span>${actions('img')}</div>
      <div class="stage"><canvas role="img" aria-label="${esc(s.title)} drawing"></canvas><div class="badge" hidden></div></div>
      <div class="player"><button type="button" class="icon-btn play" title="Play or pause"></button><button type="button" class="icon-btn" data-replay title="Replay this window">${REPLAY}</button><input type="range" min="0" max="1000" value="0" aria-label="Playback position"><span class="time"></span></div>`;
    this.el = el;
    this.canvas = $('canvas', el); this.ctx = this.canvas.getContext('2d');
    this.badge = $('.badge', el); this.slider = $('input[type="range"]', el); this.timeEl = $('.time', el); this.playBtn = $('.play', el);
    this.playBtn.onclick = () => {
      if (this.state === 'playing') this.setState('paused');
      else { if (this.t >= this.end) this.seek(0); this.setState('playing'); }
    };
    $('[data-replay]', el).onclick = () => { this.seek(0); this.setState('playing'); };
    this.slider.oninput = () => { this.seek((this.slider.value / 1000) * this.end); if (this.state !== 'paused') this.setState('paused'); };
    this.canvas.onclick = () => this.click();
    el._beforeCopy = () => this.redraw();
  }

  // a click on the canvas is the click graphics.GraphWin.getMouse() waits for
  click() {
    if (this.state === 'click') { this.passClick(); return; }
    if (this.state === 'closed' || this.t >= this.end) { this.seek(0); this.setState('playing'); return; }
    this.setState(this.state === 'playing' ? 'paused' : 'playing');
  }

  passClick() {
    this.t = this.times[this.clickIndex] + 1e-6;
    this.setState('playing');
  }

  setState(st) {
    this.state = st;
    this.playBtn.innerHTML = st === 'playing' ? PAUSE : PLAY;
    const b = this.badge;
    b.classList.toggle('wait', st === 'click');
    b.hidden = !['pending', 'click', 'closed'].includes(st);
    if (st === 'pending') b.textContent = 'Opens when the previous window is closed';
    if (st === 'click') b.textContent = 'getMouse(): click the window to go on';
    if (st === 'closed') b.textContent = 'Window closed · click to replay';
    if (st === 'playing') this.session.kick();
  }

  reset() {
    const view = this.session.fit && this.bbox ? this.bbox : [0, 0, this.spec.width, this.spec.height];
    const [vx, vy, vw, vh] = view;
    const dpr = window.devicePixelRatio || 1;
    const s = Math.max(dpr, Math.min(8, 1000 / Math.max(vw, vh)));
    this.canvas.width = Math.round(vw * s); this.canvas.height = Math.round(vh * s);
    this.view = { vx, vy, s };
    this.shapes = new Map(); this.bg = '#d9d9d9'; this.applied = 0;
    this.redraw();
  }

  seek(t) {
    if (t < this.t || t === 0) { this.shapes = new Map(); this.bg = '#d9d9d9'; this.applied = 0; this.dirty = true; }
    this.t = Math.max(0, Math.min(this.end, t));
    this.advance();
  }

  // apply every op up to this.t; draw incrementally unless something was removed or changed
  advance() {
    const ops = this.spec.ops;
    let dirty = this.dirty;
    const fresh = [];
    while (this.applied < ops.length && this.times[this.applied] <= this.t) {
      const o = ops[this.applied++];
      switch (o[1]) {
        case 0: { const sh = { k: o[3], fill: this.colors[o[4]], outline: this.colors[o[5]], w: o[6], c: o.slice(7), id: o[2] }; this.shapes.set(o[2], sh); fresh.push(sh); break; }
        case 1: this.shapes.delete(o[2]); dirty = true; break;
        case 2: this.bg = this.colors[o[2]] || '#d9d9d9'; dirty = true; break;
        case 3: { const sh = this.shapes.get(o[2]); if (sh) { const cfg = o[3]; if ('fill' in cfg) sh[sh.k === 2 ? 'outline' : 'fill'] = tkColor(cfg.fill); if ('outline' in cfg && sh.k !== 2) sh.outline = tkColor(cfg.outline); if ('width' in cfg) sh.w = +cfg.width; } dirty = true; break; }
        case 4: { const sh = this.shapes.get(o[2]); if (sh) sh.c = sh.c.map((v, i) => v + (i % 2 ? o[4] : o[3])); dirty = true; break; }
        default: break;
      }
    }
    if (dirty) this.redraw();
    else if (fresh.length) { this.prep(); fresh.forEach((sh) => this.drawShape(sh)); }
    this.dirty = false;
    this.updateUi();
  }

  prep() { const { vx, vy, s } = this.view; this.ctx.setTransform(s, 0, 0, s, -vx * s, -vy * s); }

  redraw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.prep();
    for (const sh of this.shapes.values()) this.drawShape(sh);
  }

  drawShape(sh) {
    const ctx = this.ctx, c = sh.c;
    switch (sh.k) {
      case 5: // graphics.Point: create_rectangle(x, y, x+1, y+1) with a 1px outline, i.e. a 2×2 pixel dot
        if (sh.outline) { ctx.fillStyle = sh.outline; ctx.fillRect(c[0], c[1], 2, 2); }
        break;
      case 0:
        if (sh.fill) { ctx.fillStyle = sh.fill; ctx.fillRect(c[0], c[1], c[2] - c[0], c[3] - c[1]); }
        if (sh.outline && sh.w > 0) { ctx.strokeStyle = sh.outline; ctx.lineWidth = sh.w; ctx.strokeRect(c[0] + 0.5, c[1] + 0.5, c[2] - c[0], c[3] - c[1]); }
        break;
      case 1:
        ctx.beginPath();
        ctx.ellipse((c[0] + c[2]) / 2, (c[1] + c[3]) / 2, Math.abs(c[2] - c[0]) / 2, Math.abs(c[3] - c[1]) / 2, 0, 0, Math.PI * 2);
        if (sh.fill) { ctx.fillStyle = sh.fill; ctx.fill(); }
        if (sh.outline && sh.w > 0) { ctx.strokeStyle = sh.outline; ctx.lineWidth = sh.w; ctx.stroke(); }
        break;
      case 2: case 3:
        ctx.beginPath();
        ctx.moveTo(c[0], c[1]);
        for (let i = 2; i + 1 < c.length; i += 2) ctx.lineTo(c[i], c[i + 1]);
        if (sh.k === 3) ctx.closePath();
        if (sh.k === 3 && sh.fill) { ctx.fillStyle = sh.fill; ctx.fill(); }
        if (sh.outline && sh.w > 0) { ctx.strokeStyle = sh.outline; ctx.lineWidth = sh.w; ctx.lineJoin = 'round'; ctx.lineCap = sh.k === 2 ? 'butt' : 'round'; ctx.stroke(); }
        break;
      case 4: {
        const t = this.spec.texts[sh.id] || { text: '', font: ['helvetica', 12, 'normal'] };
        ctx.fillStyle = sh.fill || 'black';
        ctx.font = `${t.font[2] === 'normal' ? '' : t.font[2]} ${t.font[1]}px ${t.font[0]}, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(t.text, c[0], c[1]);
        break;
      }
      default: break;
    }
  }

  updateUi() {
    this.slider.value = this.end ? Math.round((this.t / this.end) * 1000) : 1000;
    const adds = this.spec.ops.slice(0, this.applied).filter((o) => o[1] === 0).length;
    this.timeEl.textContent = this.reveal
      ? `${int(adds)} / ${int(this.totalAdds ??= this.spec.ops.filter((o) => o[1] === 0).length)} shapes`
      : `t = ${this.t.toFixed(2)} / ${this.drawEnd.toFixed(2)} s`;
  }

  // one animation step of dt real seconds
  step(dt) {
    if (this.state !== 'playing') return false;
    let t = this.t + dt * this.session.speed;
    if (this.clickIndex >= 0 && this.t < this.times[this.clickIndex] && t >= this.times[this.clickIndex]) {
      t = this.times[this.clickIndex];
      this.t = t; this.advance();
      if (this.session.autoClick) { this.setState('click'); this.autoTimer = setTimeout(() => this.state === 'click' && this.passClick(), 700); }
      else this.setState('click');
      return true;
    }
    this.t = Math.min(this.end, t);
    this.advance();
    if (this.t >= this.end) {
      this.setState(this.clickIndex >= 0 ? 'closed' : 'paused');
      this.session.closed(this.index);
    }
    return true;
  }
}

class TkSession {
  constructor(root, data, { autoClick = true } = {}) {
    this.root = root; this.speed = 1; this.fit = true; this.autoClick = autoClick; this.raf = 0;
    const box = $('.windows', root);
    box.classList.toggle('one', data.windows.length === 1);
    this.windows = data.windows.map((spec, i) => new TkWindow(this, spec, i));
    this.windows.forEach((w) => box.appendChild(w.el));
    const tb = $('.toolbar', root);
    $('select', tb).onchange = (e) => { this.speed = +e.target.value; };
    $('input[name="fit"]', tb).onchange = (e) => { this.fit = e.target.checked; this.windows.forEach((w) => { const t = w.t; w.reset(); w.seek(t); }); };
    $('input[name="auto"]', tb).onchange = (e) => { this.autoClick = e.target.checked; };
    $('[data-replay-all]', tb).onclick = () => this.replay();
    this.windows.forEach((w) => w.setState(w.state));
    this.kick();
  }

  replay() {
    this.windows.forEach((w, i) => { clearTimeout(w.autoTimer); w.seek(0); w.setState(i === 0 ? 'playing' : 'pending'); });
  }

  closed(i) {
    const next = this.windows[i + 1];
    if (next && next.state === 'pending') next.setState('playing');
  }

  kick() {
    if (this.raf) return;
    let last = performance.now();
    const loop = (now) => {
      const dt = Math.max(0, Math.min(0.1, (now - last) / 1000)); last = Math.max(last, now);
      if (!this.root.isConnected) { this.raf = 0; return; }
      let busy = false;
      for (const w of this.windows) busy = w.step(dt) || busy;
      this.raf = busy ? requestAnimationFrame(loop) : 0;
    };
    this.raf = requestAnimationFrame(loop);
  }
}

const tkToolbar = () => `<div class="toolbar"><label>Speed <select aria-label="Playback speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option><option value="10">10×</option></select></label>
  <label><input type="checkbox" name="fit" checked> Zoom to the drawing</label>
  <label title="graphics.GraphWin.getMouse() waits for a click before the lab closes a window"><input type="checkbox" name="auto" checked> Click for me at getMouse()</label>
  <button type="button" class="mini" data-replay-all>Replay all</button></div>`;

// tables built from the same log: polygons with their vertices, and colours with shape counts
function polygonRows(d) {
  const rows = [];
  d.windows.forEach((w) => w.ops.forEach((o) => {
    if (o[1] !== 0 || o[3] !== 3) return;
    const pts = [];
    for (let i = 7; i + 1 < o.length; i += 2) pts.push(`(${fmt(o[i], 2)}, ${fmt(o[i + 1], 2)})`);
    rows.push(`<tr><td>${esc(w.title)}</td><td class="num">${o[0].toFixed(2)}</td><td><span class="sw" style="background:${esc(tkColor(w.colors[o[5]]) || 'transparent')}"></span>${esc(w.colors[o[5]] || '—')}</td><td>${w.colors[o[4]] ? `<span class="sw" style="background:${esc(tkColor(w.colors[o[4]]))}"></span>${esc(w.colors[o[4]])}` : '—'}</td><td class="num">${o[6]}</td><td>${pts.join(' ')}</td></tr>`);
  }));
  return rows;
}
function colorRows(d) {
  const rows = [];
  d.windows.forEach((w) => {
    const count = new Map();
    w.ops.forEach((o) => { if (o[1] !== 0) return; const fill = w.colors[o[4]], c = (o[3] === 0 || o[3] === 1 || o[3] === 3) && fill ? fill : w.colors[o[5]] || fill; count.set(c, (count.get(c) || 0) + 1); });
    [...count].sort((a, b) => b[1] - a[1]).forEach(([c, n]) => rows.push(`<tr><td>${esc(w.title)}</td><td><span class="sw" style="background:${esc(tkColor(c))}"></span>${esc(c)}</td><td class="num">${int(n)}</td></tr>`));
  });
  return rows;
}

function graphicsView(d, lab) {
  const shapes = d.windows.reduce((s, w) => s + w.ops.filter((o) => o[1] === 0).length, 0);
  const dur = d.windows.reduce((s, w) => s + w.duration, 0);
  const polys = polygonRows(d), colors = colorRows(d);
  const LIMIT = 400;
  return `<div class="stats">${stat(d.windows.length, d.windows.length === 1 ? 'window' : 'windows')}${stat(int(shapes), 'shapes drawn')}${stat(`${fmt(dur, 2)} s`, 'time.sleep total')}${stat(msFmt(d.ms), 'main.py run time')}</div>
    <div class="tk-session">${tkToolbar()}<div class="windows"></div></div>
    ${d.stdout ? `<div data-copyable><div class="copy-head"><h2>Printed output</h2>${actions('text')}</div><pre class="out-text">${esc(d.stdout)}</pre></div>` : ''}
    ${polys.length ? `<div data-copyable style="margin-top:16px"><div class="copy-head"><h2>Polygons drawn <small>· ${polys.length}${polys.length > LIMIT ? `, first ${LIMIT} shown` : ''}</small></h2>${actions('table')}</div>
      <div class="table-wrap"><table><thead><tr><th>Window</th><th class="num">t, s</th><th>Outline</th><th>Fill</th><th class="num">Width</th><th>Vertices (screen x, y)</th></tr></thead><tbody>${polys.slice(0, LIMIT).join('')}</tbody></table></div></div>` : ''}
    ${lab.colorTable !== false ? `<div data-copyable style="margin-top:16px"><div class="copy-head"><h2>Colours <small>· shapes per colour</small></h2>${actions('table')}</div>
      <div class="table-wrap" style="max-height:260px"><table><thead><tr><th>Window</th><th>Colour</th><th class="num">Shapes</th></tr></thead><tbody>${colors.join('')}</tbody></table></div></div>` : ''}`;
}

// ---------------------------------------------------------- OpenGL viewer --
const VS = `attribute vec3 aPos; attribute vec3 aNrm; attribute vec4 aCol;
uniform mat4 uMV, uP; uniform mat3 uN; uniform vec4 uLight; uniform bool uLighting, uNormalize;
varying vec4 vCol;
void main() {
  vec4 eye = uMV * vec4(aPos, 1.0);
  gl_Position = uP * eye;
  if (!uLighting) { vCol = aCol; return; }
  vec3 n = uN * aNrm;
  if (uNormalize) n = normalize(n);
  vec3 L = uLight.w == 0.0 ? normalize(uLight.xyz) : normalize(uLight.xyz - eye.xyz);
  // OpenGL 1.x defaults: global ambient 0.2, GL_LIGHT0 diffuse 1, no specular (material specular is 0)
  vec3 c = 0.2 * aCol.rgb + max(dot(n, L), 0.0) * aCol.rgb;
  vCol = vec4(min(c, 1.0), aCol.a);
}`;
const FS = 'precision mediump float; varying vec4 vCol; void main() { gl_FragColor = vCol; }';

const m4 = {
  mul(a, b) { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; },
  tr(x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; },
  rx(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; },
  ry(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; },
  normal(m) { // inverse transpose of the upper 3×3
    const [a, b, c, , d, e, f, , g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C || 1;
    return [A, B, C, -(b * i - c * h), a * i - c * g, -(a * h - b * g), b * f - c * e, -(a * f - c * d), a * e - b * d].map((v) => v / det);
  },
};

class GLView {
  constructor(root, data) {
    this.root = root; this.data = data; this.playing = true; this.yaw = 0; this.pitch = 0; this.frames = 0; this.fpsT = performance.now(); this.fpsN = 0;
    const canvas = $('canvas', root);
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: true });
    if (!gl) throw new Error('WebGL is not available in this browser');
    this.gl = gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    gl.useProgram(prog);
    this.loc = Object.fromEntries(['aPos', 'aNrm', 'aCol'].map((n) => [n, gl.getAttribLocation(prog, n)]));
    this.uni = Object.fromEntries(['uMV', 'uP', 'uN', 'uLight', 'uLighting', 'uNormalize'].map((n) => [n, gl.getUniformLocation(prog, n)]));
    this.lists = {};
    for (const [id, g] of Object.entries(data.lists)) {
      const buf = (arr) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW); return b; };
      this.lists[id] = { pos: buf(g.pos), nrm: buf(g.nrm), col: buf(g.col), n: g.pos.length / 3 };
    }
    this.bindUi();
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.tick = this.tick.bind(this);
    this.raf = requestAnimationFrame(this.tick);
  }

  bindUi() {
    const r = this.root, c = this.canvas;
    const playBtn = $('[data-gl-play]', r);
    const sync = () => { playBtn.innerHTML = this.playing ? PAUSE : PLAY; };
    playBtn.onclick = () => { this.playing = !this.playing; sync(); if (this.playing) this.kick(); };
    $('[data-gl-step]', r).onclick = () => { this.playing = false; sync(); this.frame(); };
    $('[data-gl-reset]', r).onclick = () => { this.yaw = 0; this.pitch = 0; if (!this.playing) this.render(this.last); };
    sync();
    let drag = null;
    c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.yaw = drag.yaw + (e.clientX - drag.x) * 0.01;
      this.pitch = Math.max(-1.5, Math.min(1.5, drag.pitch + (e.clientY - drag.y) * 0.01));
      if (!this.playing && this.last) this.render(this.last);
    });
    const end = () => { drag = null; };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    this.root._beforeCopy = () => this.last && this.render(this.last);
  }

  // like GLUT calling the reshape callback when the window size changes
  resize() {
    const css = this.canvas.clientWidth || 600, dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(css * dpr), h = w;
    if (w === this.canvas.width && h === this.canvas.height && this.shaped) return;
    this.canvas.width = w; this.canvas.height = h; this.shaped = true;
    this.viewport = pyCall('gl_reshape', { w, h }).viewport;
    if (this.last) this.render(this.last);
  }

  kick() { if (!this.raf) this.raf = requestAnimationFrame(this.tick); }

  tick(now) {
    this.raf = 0;
    if (!this.root.isConnected) { this.ro.disconnect(); return; }
    if (!this.playing) return;
    if (this.canvas.offsetParent) {
      this.frame();
      this.fpsN++;
      if (now - this.fpsT > 500) { $('[data-gl-fps]', this.root).textContent = `${Math.round((this.fpsN * 1000) / (now - this.fpsT))} fps`; this.fpsT = now; this.fpsN = 0; }
    }
    this.raf = requestAnimationFrame(this.tick);
  }

  // one GLUT display callback: bearing.draw() runs in Python and hands back its draw calls
  frame() {
    const f = pyCall('gl_frame');
    this.last = f;
    this.render(f);
    $('[data-gl-frame]', this.root).textContent = `frame ${int(f.frame)}`;
  }

  render(f) {
    const gl = this.gl, u = this.uni, L = this.loc;
    const [vx, vy, vw, vh] = f.viewport[2] ? f.viewport : this.viewport;
    gl.viewport(vx, vy, vw, vh);
    gl.clearColor(...f.clear);
    const on = new Set(f.enabled);
    on.has('depth_test') ? gl.enable(gl.DEPTH_TEST) : gl.disable(gl.DEPTH_TEST);
    if (on.has('cull_face')) { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(gl.CCW); } else gl.disable(gl.CULL_FACE);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(u.uP, false, f.proj);
    gl.uniform4fv(u.uLight, f.light);
    gl.uniform1i(u.uLighting, on.has('lighting') && on.has('light0'));
    gl.uniform1i(u.uNormalize, on.has('normalize'));
    // viewer-only camera turn (drag), pivoting around the point the lab's reshape looks at
    const orbit = m4.mul(m4.tr(0, 0, -40), m4.mul(m4.rx(this.pitch), m4.mul(m4.ry(this.yaw), m4.tr(0, 0, 40))));
    for (const [id, mv] of f.draws) {
      const g = this.lists[id];
      if (!g) continue;
      const MV = m4.mul(orbit, mv);
      gl.uniformMatrix4fv(u.uMV, false, MV);
      gl.uniformMatrix3fv(u.uN, false, m4.normal(MV));
      for (const [buf, loc, n] of [[g.pos, L.aPos, 3], [g.nrm, L.aNrm, 3], [g.col, L.aCol, 4]]) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 0, 0);
      }
      gl.drawArrays(gl.TRIANGLES, 0, g.n);
    }
  }
}

function glView(d) {
  const calls = Object.entries(d.calls).sort((a, b) => b[1] - a[1]);
  const tris = Object.values(d.triangles).reduce((s, v) => s + v, 0);
  return `<div class="stats">${stat(int(tris), 'triangles in the display list')}${stat(int(d.calls.glVertex3f || 0), 'glVertex3f calls')}${stat(d.enabled.length, 'glEnable flags')}${stat(msFmt(d.ms), 'setup run time')}</div>
    <div class="windows one"><figure class="win gl-box" style="margin:0" data-copyable data-title="${esc(d.window.title)}">
      <div class="win-bar"><span class="win-dots" aria-hidden="true"><i></i><i></i><i></i></span><b title="glutCreateWindow title">${esc(d.window.title)}</b><span class="muted">${d.window.width}×${d.window.height}</span>${actions('img')}</div>
      <div class="stage gl-stage"><canvas role="img" aria-label="${esc(d.window.title)}: rotating bearing" style="max-width:${d.window.width}px"></canvas></div>
      <div class="player"><button type="button" class="icon-btn" data-gl-play title="Play or pause"></button><button type="button" class="mini" data-gl-step title="Run the display callback once">Step frame</button><button type="button" class="mini" data-gl-reset title="Undo the camera drag">Reset camera</button><span class="time" data-gl-frame>frame 0</span><span class="time" data-gl-fps></span></div>
    </figure></div>
    <p class="hint">Drag the bearing to turn the camera. That's a viewer extra, the lab itself takes no input: GLUT redraws it every frame, turning it 3° and moving it down 0.1 units.</p>
    <div class="two-col" style="margin-top:12px">
      <div data-copyable><div class="copy-head"><h2>OpenGL calls during setup</h2>${actions('table')}</div><div class="table-wrap" style="max-height:300px"><table><thead><tr><th>Call</th><th class="num">Count</th></tr></thead><tbody>${calls.map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td class="num">${int(v)}</td></tr>`).join('')}</tbody></table></div></div>
      <div data-copyable><div class="copy-head"><h2>Pipeline state</h2>${actions('table')}</div><div class="table-wrap"><table class="kv"><tbody>
        <tr><th>glEnable</th><td>${d.enabled.map((e) => `<code>GL_${e.toUpperCase()}</code>`).join(' ')}</td></tr>
        <tr><th>GL_LIGHT0 position (eye space)</th><td>${d.light.map((v) => fmt(v, 3)).join(', ')}</td></tr>
        <tr><th>glClearColor</th><td><span class="sw" style="background:rgb(${d.clear.slice(0, 3).map((v) => Math.round(v * 255)).join(',')})"></span>${d.clear.map((v) => fmt(v, 3)).join(', ')}</td></tr>
        ${Object.values(d.lists).flatMap((g) => [...new Set(range(g.col.length / 4, (i) => g.col.slice(i * 4, i * 4 + 4).join(',')))]).map((c) => `<tr><th>Material colour</th><td><span class="sw" style="background:rgb(${c.split(',').slice(0, 3).map((v) => Math.round(v * 255)).join(',')})"></span>${c.split(',').map((v) => fmt(+v, 3)).join(', ')}</td></tr>`).join('')}
      </tbody></table></div></div>
    </div>`;
}

// ------------------------------------------------------------ image views --
const b64Blob = (b64, type) => { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type }); };
async function paintImages(root) {
  for (const cv of root.querySelectorAll('canvas[data-img]')) {
    const bmp = await createImageBitmap(b64Blob(images.get(cv.dataset.img), cv.dataset.type || 'image/png'));
    cv.width = bmp.width; cv.height = bmp.height;
    cv.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
  }
}
const images = new Map();
let imgSeq = 0;
const imgFigure = (b64, title, sub = '', type = 'image/png') => {
  const id = `i${++imgSeq}`;
  images.set(id, b64);
  return `<figure class="img" data-copyable data-title="${esc(title)}"><figcaption><span>${esc(title)}</span>${sub ? `<span class="muted">${sub}</span>` : ''}${actions('img')}</figcaption><canvas data-img="${id}" data-type="${type}" role="img" aria-label="${esc(title)}"></canvas></figure>`;
};
const HIST_CH = [['B', '--c1'], ['G', '--c3'], ['R', '--c5']];
const xs256 = range(256);

function lab7View(d) {
  const rows = d.panels.map((p) => {
    const series = p.hist.map((h, c) => ({ name: c === 0 ? 'channel 0 (B), the one the lab plots' : `channel ${c} (${HIST_CH[c][0]})`, xs: xs256, ys: h, color: HIST_CH[c][1], width: c === 0 ? 2 : 1.2, opacity: c === 0 ? 1 : 0.6 }));
    return `<div class="imgs two" style="margin-bottom:16px">${imgFigure(p.image, p.title, p.masked ? 'with the mask' : '', 'image/jpeg')}
      <div style="min-width:0">${chart({ title: `Histogram: ${p.title}${p.masked ? ' (masked)' : ''}`, x: 'intensity', y: 'pixels', series, yZero: true })}</div></div>`;
  }).join('');
  return `<div class="stats">${stat(`${d.width}×${d.height}`, 'image size')}${stat(`[${d.mask[0]}:${d.mask[1]}, ${d.mask[2]}:${d.mask[3]}]`, 'mask rows, columns')}${stat(int(d.mask_px), 'pixels in the mask')}${stat(msFmt(d.ms), 'OpenCV time')}</div>
    ${rows}
    <div class="charts" style="max-width:560px">${chart({ title: 'stretch_contrast lookup table', x: 'input intensity', y: 'output', series: [{ name: 'cv2.LUT table', xs: xs256, ys: d.lut, color: '--c4' }, { name: 'identity', xs: xs256, ys: xs256, color: '--muted', dash: true, width: 1 }], height: 230 })}</div>`;
}

const SEG_TITLES = { original: 'original', otsu: 'otsu', kmeans: 'kmeans', robert: 'robert' };
function lab8View(d) {
  return d.images.map((im) => {
    const t = im.times;
    const scaled = im.width !== im.orig_width;
    const centers = im.centers.map((c) => `<span class="swatch" style="background:rgb(${c.rgb.join(',')})"></span>`).join('');
    const figs = im.panels.map((p) => imgFigure(p.image, SEG_TITLES[p.key], p.key === 'original' ? '' : msFmt(t[p.key]))).join('');
    return `<div class="src-group" data-group="${esc(im.source)}"><h2>${esc(im.source)} <small>· ${im.orig_width}×${im.orig_height}${scaled ? `, processed at ${im.width}×${im.height}` : ''}</small></h2>
      <div class="stats">${stat(fmt(im.otsu, 1), 'Otsu threshold')}${stat(`${fmt((100 * im.otsu_white) / (im.width * im.height), 1)}%`, 'white after THRESH_BINARY_INV')}${stat(`${centers}<span style="font-size:13px">${im.centers.map((c) => `#${c.rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`).join(' ')}</span>`, 'k-means centres (k = 2)')}${stat(msFmt(t.kmeans), 'k-means time')}${stat(`${fmt(im.robert_range[0], 1)} … ${fmt(im.robert_range[1], 1)}`, 'Roberts magnitude range')}</div>
      <div class="imgs quad" style="margin-bottom:16px">${figs}</div>
      <div class="charts two">
        ${chart({ title: `Grey levels of ${im.source}`, x: 'intensity', y: 'pixels', series: [{ name: 'grey', xs: xs256, ys: im.gray_hist, color: '--c1' }], marks: [{ x: im.otsu, label: `Otsu threshold ${fmt(im.otsu, 1)}`, short: `T = ${fmt(im.otsu, 1)}`, color: '--c2' }], yZero: true })}
        ${chart({ title: 'Roberts edge magnitude (as plotted)', x: 'scaled magnitude', y: 'pixels', series: [{ name: 'edges', xs: xs256, ys: im.panels[3].hist[0], color: '--c4' }], yZero: true })}
      </div></div>`;
  }).join('');
}

// --------------------------------------------------------------- lab config --
// py: { assign: 'NAME' } replaces `NAME = …` in the lab's main.py, py: { kw: 'name' } a `name=…` keyword
// argument; wrap() turns the typed text into the Python expression. Only edited fields are sent,
// so the default run is the lab's source exactly as it is.
const num = (key, label, value, min, max, py, extra = {}) => ({ key, label, value, min, max, py, ...extra });
const expr = (key, label, value, py, extra = {}) => ({ key, label, value: String(value), type: 'expr', py, ...extra });
const color = (key, label, value, py) => ({ key, label, value, type: 'color', py, wrap: (v) => `'${v}'` });
const vec = (key, label, value, py, tpl = (v) => `(${v})`) => ({ key, label, value, type: 'expr', py, wrap: tpl, vec: true });
const pyramid = (a, b, c, d) => [vec('a', 'Vertex a', a, { kw: 'a' }), vec('b', 'Vertex b', b, { kw: 'b' }), vec('c', 'Vertex c', c, { kw: 'c' }), vec('d', 'Vertex d', d, { kw: 'd' })];

const TK_NOTE = '<p class="note port"><b>Runs as is.</b> The page runs this lab\'s <code>main.py</code> and its own <code>graphics.py</code> unchanged. The browser has no Tk, so <a href="https://github.com/Andrew1407/ComputerVision/blob/main/web/shims/tkinter.py"><code>web/shims/tkinter.py</code></a> stands in for <code>tkinter</code> and records every canvas call, and <code>time.sleep</code> moves a virtual clock. The canvas below replays that log at the lab\'s timing.</p>';

function overrides(lab, p) {
  const out = { assign: {}, kw: {} };
  for (const f of lab.fields) {
    if (!f.py || String(p[f.key]) === String(f.value)) continue;
    const v = f.wrap ? f.wrap(String(p[f.key]).trim()) : String(p[f.key]).trim();
    if (f.py.assign) out.assign[f.py.assign] = v; else out.kw[f.py.kw] = v;
  }
  return out;
}

const gfx = (lab) => (p) => runPy('graphics', { lab, ...overrides(LABS.find((l) => l.dir === lab), p) });

const LABS = [
  {
    id: 'lab1', tab: '1', dir: '1-lab', name: 'Calculation strategies', lang: 'py', src: `${TREE}/1-lab`,
    intro: 'Moves and rotates a parallelogram 20 times with three interchangeable strategies: plain scalar formulas, a 2×2 rotation matrix applied step by step, and 3×3 homogeneous matrices composed into one transform. Each strategy opens its own window and the three come out the same.',
    fields: [
      num('times', 'MOVE_TIMES', 20, 1, 200, { assign: 'MOVE_TIMES' }),
      expr('offset', 'MOVE_OFFSET', '(-10, 10)', { assign: 'MOVE_OFFSET' }),
      expr('angle', 'MOVE_ANGLE', 'mt.pi / 50', { assign: 'MOVE_ANGLE' }),
      expr('inv', 'MOVE_ANGLE_INVERSE', '-mt.pi / 80', { assign: 'MOVE_ANGLE_INVERSE' }),
      num('delay', 'DRAW_DELAY_SEC', 0.25, 0, 5, { assign: 'DRAW_DELAY_SEC' }, { step: 'any' }),
      expr('xs', 'X1, X2', '720, 780', { assign: 'X1, X2' }),
      expr('ys', 'Y2, Y1', '80, 10', { assign: 'Y2, Y1' }),
      num('xo', 'X_OFFSET', 20, -400, 400, { assign: 'X_OFFSET' }),
    ],
    hint: 'Fields are the constants at the top of <code>1-lab/main.py</code>; they take Python expressions (<code>mt</code> is <code>math</code>). Click a window to step past its <code>getMouse()</code>, or let the page click for you.',
    run: gfx('1-lab'), render: graphicsView, mount: 'tk',
  },
  {
    id: 'lab2', tab: '2', dir: '2-lab', name: 'Spatial transforms', lang: 'py', src: `${TREE}/2-lab`,
    intro: 'Projects a triangular pyramid with an axonometric projection, then rotates it around an axis with a custom rotation matrix, drawing 50 frames. Faces fade from the background colour to pink and back, and the edges from yellow to blue.',
    fields: [
      num('steps', 'STEPS', 50, 2, 400, { assign: 'STEPS' }),
      num('delay', 'DRAW_DELAY_SEC', 0.2, 0, 5, { assign: 'DRAW_DELAY_SEC' }, { step: 'any' }),
      num('rot', 'ROTATION_ANGLE', 0.02, -1, 1, { assign: 'ROTATION_ANGLE' }, { step: 'any' }),
      expr('axis', 'ROTATION_COORDS', '1, 0, 0', { assign: 'ROTATION_COORDS' }),
      expr('proj', 'PROJECTION_ANGLES', 'mt.pi / 3, -mt.pi / 4', { assign: 'PROJECTION_ANGLES' }),
      expr('proj1', 'projection_angles (window 1)', '(1, -0.1)', { kw: 'projection_angles' }),
      ...pyramid('720, 300, 10', '680, 300, 80', '770, 350, 80', '700, 200, 50'),
      color('bg', 'BACKGROUND_COLOR', '#ffff00', { assign: 'BACKGROUND_COLOR' }),
      color('outline', 'OUTLINE_COLOR', '#0000ff', { assign: 'OUTLINE_COLOR' }),
      color('fill', 'FILL_FINISH_COLOR', '#ff99cc', { assign: 'FILL_FINISH_COLOR' }),
    ],
    notes: ['<p class="note bug"><b>Lab quirks, kept as they are.</b> <code>custom_rotation</code> divides the axis by √(n₁ + n₂ + n₃) rather than √(n₁² + n₂² + n₃²), so only axes like (1, 0, 0) stay unit length. It also rotates the already rotated pyramid by a growing angle each frame, so the spin speeds up. In <code>axonometric_projection</code> the second matrix has <code>sin</code> where a rotation needs <code>−sin</code>, which skews the projection a little.</p>'],
    run: gfx('2-lab'), render: graphicsView, mount: 'tk',
  },
  {
    id: 'lab3', tab: '3', dir: '3-lab', name: 'Raster algorithms', lang: 'py', src: `${TREE}/3-lab`,
    intro: 'Rasterises the projected pyramid pixel by pixel. Its faces are filled with scan lines found by vertical intersection, and its edges are drawn with Bresenham\'s line algorithm, with colour gradients along each line. The lab paints three passes, and the last one paints everything in the background colour, so the drawing is erased at the end. Drag the slider to see each pass.',
    fields: [
      expr('proj', 'PROJECTION_ANGLES', '1, -0.1', { assign: 'PROJECTION_ANGLES' }),
      ...pyramid('720, 300, 10', '680, 300, 80', '770, 350, 80', '700, 200, 50'),
      color('fill1', 'FIRST_FILL_COLOR', '#11ccee', { assign: 'FIRST_FILL_COLOR' }),
      color('fill2', 'SECOND_FILL_COLOR', '#eaccff', { assign: 'SECOND_FILL_COLOR' }),
      color('line1', 'FIRST_OUTLINE_COLOR', '#ff0000', { assign: 'FIRST_OUTLINE_COLOR' }),
      color('line2', 'SECOND_OUTLINE_COLOR', '#19507b', { assign: 'SECOND_OUTLINE_COLOR' }),
      color('bg', 'BACKGROUND_COLOR', '#ffff00', { assign: 'BACKGROUND_COLOR' }),
    ],
    hint: 'Tk draws each <code>Point</code> as soon as it is created and the lab never sleeps, so the page replays the points in drawing order over a few seconds.',
    run: gfx('3-lab'), render: graphicsView, mount: 'tk',
  },
  {
    id: 'lab4', tab: '4', dir: '4-lab', name: 'Vector graphics', lang: 'py', src: `${TREE}/4-lab`,
    intro: 'Sorts the pyramid\'s faces with the painter\'s algorithm (farthest from the viewpoint first), projects them orthogonally onto the xy plane, fills each face with raster scan lines and draws its edges as least-squares fitted lines.',
    fields: [
      vec('a', 'a', '420, 350, 10', { assign: 'a' }), vec('b', 'b', '380, 300, 80', { assign: 'b' }),
      vec('c', 'c', '470, 350, 80', { assign: 'c' }), vec('d', 'd', '400, 200, 50', { assign: 'd' }),
      color('fill', 'FILL_COLOR', '#11ccee', { assign: 'FILL_COLOR' }),
      color('outline', 'OUTLINE_COLOR', '#19507b', { assign: 'OUTLINE_COLOR' }),
      color('bg', 'BACKGROUND_COLOR', '#ffff00', { assign: 'BACKGROUND_COLOR' }),
    ],
    run: gfx('4-lab'), render: graphicsView, mount: 'tk',
  },
  {
    id: 'lab5', tab: '5', dir: '5-lab', name: 'Fractals', lang: 'py', src: `${TREE}/5-lab`,
    intro: 'Draws a field: three Sierpinski carpets (level 5, 243×243 cells) as the ground and a recursive fractal tree on each, branching ±20° with branches shrinking to 0.8 of their parent.',
    fields: [
      num('level', 'level (carpet)', 5, 0, 5, { assign: 'level' }),
      num('depth', 'depth (tree)', 10, 0, 13, { kw: 'depth' }),
      num('d', 'd (trunk length)', 20, 1, 200, { kw: 'd' }, { step: 'any' }),
      expr('g', 'g (trunk angle)', 'mt.radians(270)', { kw: 'g' }),
      num('w', 'WINDOW_WIDTH', 700, 100, 1600, { assign: 'WINDOW_WIDTH' }),
      num('h', 'WINDOW_HEIGHT', 500, 100, 1200, { assign: 'WINDOW_HEIGHT' }),
    ],
    notes: [
      '<p class="note port"><b>NumPy 2.</b> <code>sierpinski_carpet</code> uses <code>np.int0</code>, which NumPy 2 removed. Pyodide ships NumPy 2.4, so the page adds <code>np.int0 = np.intp</code> back before the lab runs. The source is unchanged.</p>',
      '<p class="note bug"><b>Lab bug, kept.</b> The bounds check <code>0 &gt; xi &gt; WINDOW_WIDTH</code> is never true, so carpet points past the window edge are still drawn (Tk clips them).</p>',
    ],
    hint: 'About 100,000 points: the carpet is replayed in drawing order. Level 6 would be 9 times more, so the level is capped at 5, the lab\'s value.',
    run: gfx('5-lab'), render: graphicsView, mount: 'tk',
  },
  {
    id: 'lab6', tab: '6', dir: '6-lab', name: 'OpenGL bearing', lang: 'gl', src: `${TREE}/6-lab`,
    intro: 'A ball bearing built from three hollow cylinders (two grey races and a lighter cage) compiled into an OpenGL display list. GLUT redraws it every frame: it spins 3° around the (1, 1, 0) axis and slides down a conveyor, wrapping back to the top. It\'s lit by one directional light with flat-shaded faces and smooth-shaded walls.',
    fields: [
      num('r1', 'radius_1', 1, 0, 20, { kw: 'radius_1' }, { step: 'any' }), num('r2', 'radius_2', 1.5, 0, 20, { kw: 'radius_2' }, { step: 'any' }),
      num('r3', 'radius_3', 3, 0, 20, { kw: 'radius_3' }, { step: 'any' }), num('r4', 'radius_4', 4, 0, 20, { kw: 'radius_4' }, { step: 'any' }),
      num('w1', 'width_1', 3, 0, 20, { kw: 'width_1' }, { step: 'any' }), num('w2', 'width_2', 2, 0, 20, { kw: 'width_2' }, { step: 'any' }),
      expr('rotation', 'rotation', 'ObjPosition(x=1, y=1, z=0)', { kw: 'rotation' }, { wide: true }),
      expr('position', 'position', 'ObjPosition(y=15)', { kw: 'position' }, { wide: true }),
      expr('light', 'light_position', 'ObjPosition(rotation=5, x=5, y=10, z=0)', { kw: 'light_position' }, { wide: true }),
      expr('sky', 'SKY_BLUE', '(102 / 255, 178 / 255, 1, 1)', { assign: 'SKY_BLUE' }, { wide: true }),
      expr('g1', 'GREY_1', '(80 / 255, 80 / 255, 80 / 255, 1)', { assign: 'GREY_1' }, { wide: true }),
      expr('g2', 'GREY_2', '(127 / 255, 127 / 255, 127 / 255, 1)', { assign: 'GREY_2' }, { wide: true }),
    ],
    notes: ['<p class="note port"><b>Drawn with WebGL because browsers have no desktop OpenGL.</b> <code>main.py</code>, <code>bearing.py</code> and <code>hollow_cylinder.py</code> run unchanged against <a href="https://github.com/Andrew1407/ComputerVision/tree/main/web/shims/OpenGL"><code>web/shims/OpenGL</code></a>, a stand-in for PyOpenGL that tracks the matrix stacks and turns the display list\'s quad strips into triangles. Each animation frame calls the lab\'s <code>glutDisplayFunc</code> callback in Python. WebGL then draws the frame with OpenGL 1.x\'s fixed-function lighting: 0.2 global ambient, diffuse <code>GL_LIGHT0</code>, back faces culled.</p>'],
    hint: 'The keyword fields replace the arguments of <code>mk_bearing()</code> in <code>6-lab/main.py</code>.',
    run: (p) => runPy('gl_start', overrides(LABS.find((l) => l.id === 'lab6'), p)), render: glView, mount: 'gl',
  },
  {
    id: 'lab7', tab: '7', dir: '7-lab', name: 'Histograms', lang: 'cv', src: `${SRC}/7-lab/main.py`,
    intro: 'Loads a photo with OpenCV, masks a rectangle with <code>cv2.bitwise_and</code>, stretches the contrast through a lookup table (<code>cv2.LUT</code>) and normalises the masked image with <code>NORM_MINMAX</code>. Each image is shown with its <code>cv2.calcHist</code> histogram, as the lab\'s 2×2 matplotlib figures do.',
    fields: [
      { key: 'source', label: 'Image', value: 'repo', options: [['repo', 'imgs/landscape.jpg (repo)'], ['upload', 'Your image']] },
      { key: 'file', label: 'Upload an image', type: 'file', when: ['source', 'upload'] },
      num('y0', 'mask rows from', 350, 0, 20000), num('y1', 'to', 550, 0, 20000),
      num('x0', 'mask columns from', 300, 0, 20000), num('x1', 'to', 700, 0, 20000),
      expr('fp', 'fp (LUT points at 0, 64, 128, 192, 255)', '[0, 64, 128, 240, 255]', null, { wide: true }),
    ],
    notes: ['<p class="note port"><b>Plotting redrawn on the page.</b> The lab\'s functions (<code>stretch_contrast</code> and the OpenCV calls) run in Pyodide\'s OpenCV. Its matplotlib figures are drawn here as images and SVG charts. The lab plots channel 0 of OpenCV\'s BGR images, which is blue; the other two channels are drawn lighter for comparison.</p>'],
    hint: 'The mask is <code>mask[350:550, 300:700] = 1</code> in <code>main.py</code>. For your own image, pick rows and columns inside it.',
    run: async (p, out) => {
      await ensurePackages(['opencv-python'], out);
      let image = null;
      if (p.source === 'upload') image = await uploadImage('7-lab', out);
      else await ensureFile('7-lab', 'imgs/landscape.jpg');
      return runPy('lab7', { image, y0: p.y0, y1: p.y1, x0: p.x0, x1: p.x1, fp: String(p.fp) });
    },
    render: lab7View, mount: 'img',
  },
  {
    id: 'lab8', tab: '8', dir: '8-lab', name: 'Segmentation', lang: 'cv', src: `${TREE}/8-lab`,
    intro: 'Segments each image three ways, as <code>apply_segms</code> does: Otsu thresholding (<code>THRESH_BINARY_INV + THRESH_OTSU</code>), k-means colour clustering with k = 2 (<code>cv2.kmeans</code>, k-means++ centres, 10 attempts), and Roberts cross edge detection by convolving with the 2×2 kernels (SciPy <code>ndimage.convolve</code>).',
    fields: [
      { key: 'source', label: 'Images', value: 'repo', options: [['repo', 'imgs/raw1.png and imgs/ref1.png (repo)'], ['raw1', 'imgs/raw1.png'], ['ref1', 'imgs/ref1.png'], ['upload', 'Your image']] },
      { key: 'file', label: 'Upload an image', type: 'file', when: ['source', 'upload'] },
      num('max_side', 'Process at most (px, 0 = full size)', 640, 0, 4000),
    ],
    notes: ['<p class="note port"><b>Plotting redrawn on the page.</b> <code>segmentation.py</code> and <code>original()</code> run unchanged in Pyodide\'s OpenCV and SciPy. The page draws the 2×2 <code>plt.imshow</code> grid and skips <code>write_img</code>, which saves the results next to the inputs. matplotlib stretches the float Roberts image from its minimum to its maximum, so the page does the same.</p>'],
    hint: 'The lab segments the images at full size (1076×938 and 1256×845). k-means takes several seconds per image at that size in the browser, so by default the page scales them to 640 px on the long side first. Set 0 for full size.',
    run: async (p, out) => {
      await ensurePackages(['opencv-python', 'scipy'], out);
      let list;
      if (p.source === 'upload') list = [await uploadImage('8-lab', out)];
      else {
        list = p.source === 'repo' ? ['imgs/raw1.png', 'imgs/ref1.png'] : [`imgs/${p.source}.png`];
        for (const rel of list) await ensureFile('8-lab', rel);
      }
      return runPy('lab8', { images: list, max_side: p.max_side });
    },
    render: lab8View, mount: 'img',
  },
  {
    id: 'control', tab: 'CT', dir: 'control-task', name: 'Back-face culling', lang: 'py', src: `${SRC}/control-task/main.py`,
    intro: 'The control task: a square pyramid whose faces get plane normals from the cross product of two vectors to the face centre. Each face is classed as visible or hidden by the sign of the dot product of its normal with the vector from the face centre to the viewpoint (0, 0, 0). Hidden faces and the edges two hidden faces share are printed, and only the visible faces are drawn.',
    fields: [
      vec('a', 'a', '200, 470, 10', { assign: 'a' }, (v) => `np.array([${v}])`), vec('b', 'b', '230, 450, 100', { assign: 'b' }, (v) => `np.array([${v}])`),
      vec('c', 'c', '450, 450, 100', { assign: 'c' }, (v) => `np.array([${v}])`), vec('d', 'd', '400, 470, 10', { assign: 'd' }, (v) => `np.array([${v}])`),
      vec('e', 'e (apex)', '300, 300, 60', { assign: 'e' }, (v) => `np.array([${v}])`),
      color('fill', 'fill_color', '#00ffff', { assign: 'fill_color' }),
      color('bg', 'bkg_color', '#ffff00', { assign: 'bkg_color' }),
    ],
    notes: ['<p class="note bug"><b>Lab bug, kept.</b> <code>mk_faces_containers</code> takes <code>np.arccos</code> (radians) and compares it with <code>90</code>, so a normal is never flipped to point outwards. With the default pyramid the result is still the one the lab expects.</p>'],
    hint: 'The colours default to the lab\'s <code>\'aqua\'</code> and <code>\'yellow\'</code>, the same colours as hex values.',
    run: gfx('control-task'), render: graphicsView, mount: 'tk', colorTable: false,
  },
  {
    id: 'lab9', tab: '9', dir: '9-lab', name: 'YOLO detection', lang: 'cv', src: `${SRC}/9-lab/main.py`, skip: true,
    intro: 'Detects and counts vehicles in a highway video with YOLOv3-320 through OpenCV\'s DNN module (<code>cv2.dnn.readNetFromDarknet</code>), with confidence and non-maximum-suppression thresholds.',
    notes: ['<p class="note"><b>Not included.</b> The lab needs the YOLOv3 weights (about 240 MB, not in the repo) and a video file, which is too much to load in a browser page. Run it locally with the model in <code>9-lab/model/</code>.</p>'],
    fields: [],
  },
];

const labName = (lab) => (lab.id === 'control' ? 'Control task' : `Lab ${lab.tab}`);
const LANG = { py: ['Py', 'Python · graphics.py'], gl: ['GL', 'Python · OpenGL'], cv: ['CV', 'Python · OpenCV'] };

async function uploadImage(lab, out) {
  const input = $(`#panel-lab${lab[0]} input[type="file"]`);
  const file = input?.files?.[0];
  if (!file) throw new Error('Choose an image file to upload first.');
  if (file.size > 25e6) throw new Error('That image is over 25 MB. Pick a smaller one.');
  return pyCall('save_upload', { lab, name: file.name, data_b64: await toB64(file) });
}

// --------------------------------------------------------------- framework --
const nav = $('#nav'), main = $('#labs');
const state = new Map();

function fieldHtml(lab, f) {
  const id = `${lab.id}-${f.key}`;
  const when = f.when ? ` data-when="${f.when[0]}=${f.when[1]}"` : '';
  if (f.options) return `<label class="field" for="${id}"${when}>${esc(f.label)}<select id="${id}" name="${f.key}" style="width:auto">${f.options.map(([v, t]) => `<option value="${v}"${v === f.value ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  if (f.type === 'file') return `<label class="field file" for="${id}"${when}>${esc(f.label)}<input id="${id}" name="${f.key}" type="file" accept="image/*"></label>`;
  if (f.type === 'color') return `<label class="field color" for="${id}">${esc(f.label)}<input id="${id}" name="${f.key}" type="color" value="${f.value}"></label>`;
  if (f.type === 'expr') return `<label class="field expr${f.wide ? ' wide' : ''}" for="${id}"${when}>${esc(f.label)}<input id="${id}" name="${f.key}" type="text" value="${esc(f.value)}" spellcheck="false" autocomplete="off"${f.vec ? ' style="width:150px"' : ''}></label>`;
  const attrs = ` min="${f.min}" max="${f.max}" step="${f.step || 1}" required`;
  return `<label class="field" for="${id}"${when}>${esc(f.label)}<input id="${id}" name="${f.key}" type="number" value="${esc(f.value)}"${attrs}></label>`;
}

function build() {
  for (const lab of LABS) {
    const [short, long] = LANG[lab.lang];
    const b = document.createElement('button');
    b.type = 'button'; b.role = 'tab'; b.dataset.lab = lab.id;
    b.setAttribute('aria-controls', `panel-${lab.id}`);
    b.innerHTML = `<span class="lang ${lab.lang}">${short}</span>${labName(lab)}<span class="long muted" style="font-weight:400">· ${esc(lab.name)}</span>`;
    if (lab.skip) b.classList.add('skip');
    b.onclick = () => select(lab.id, true);
    nav.appendChild(b);

    const sec = document.createElement('section');
    sec.className = `panel${lab.skip ? ' skip' : ''}`; sec.id = `panel-${lab.id}`; sec.role = 'tabpanel'; sec.hidden = true;
    const notes = [...(lab.mount === 'tk' ? [TK_NOTE] : []), ...(lab.notes || [])];
    sec.innerHTML = `<div class="lab-head"><span class="lang ${lab.lang}">${long}</span><h3>${labName(lab)}: ${esc(lab.name)}</h3><a href="${lab.src}" target="_blank" rel="noopener">View source</a></div>
      <p class="intro">${lab.intro}</p>
      ${notes.length ? `<div class="notes">${notes.join('')}</div>` : ''}
      ${lab.skip ? '' : `<form class="params" novalidate>${lab.fields.map((f) => fieldHtml(lab, f)).join('')}<button class="run" type="submit">Run</button><button class="mini" type="button" data-reset title="Put the lab's own values back">Defaults</button></form>`}
      ${lab.hint ? `<p class="hint">${lab.hint}</p>` : ''}
      <div class="out" style="margin-top:18px"></div>`;
    main.appendChild(sec);
    state.set(lab.id, { ran: false, running: false });
    if (lab.skip) continue;

    const form = $('form', sec);
    const sync = () => sec.querySelectorAll('[data-when]').forEach((el) => {
      const [k, v] = el.dataset.when.split('=');
      el.hidden = new FormData(form).get(k) !== v;
    });
    form.addEventListener('change', sync); sync();
    form.addEventListener('submit', (e) => { e.preventDefault(); run(lab); });
    $('[data-reset]', form).onclick = () => { form.reset(); sync(); };
    const file = $('input[type="file"]', form);
    if (file) file.addEventListener('change', () => { if (file.files[0]) run(lab); });

    if (!pyReady) sec.querySelector('.out').before(document.getElementById('py-loading').content.cloneNode(true));
  }
}

function params(lab) {
  const form = $(`#panel-${lab.id} form`);
  const fd = new FormData(form), p = {};
  for (const f of lab.fields) {
    if (f.type === 'file') continue;
    const v = fd.get(f.key);
    p[f.key] = f.type || f.options ? v : Number(v);
  }
  return p;
}

function invalid(lab, p) {
  for (const f of lab.fields) {
    if (f.type === 'expr' && !String(p[f.key]).trim()) return `${f.label} can't be empty.`;
    if (f.type || f.options) continue;
    const v = p[f.key];
    if (!Number.isFinite(v) || v < f.min || v > f.max || (f.step !== 'any' && !Number.isInteger(v))) return `${f.label} must be ${f.step === 'any' ? 'a number' : 'an integer'} from ${f.min} to ${f.max}.`;
  }
  if (lab.id === 'lab7' && (p.y1 <= p.y0 || p.x1 <= p.x0)) return 'The mask needs "to" values larger than the "from" values.';
  return null;
}

async function run(lab) {
  const st = state.get(lab.id);
  if (st.running) return;
  const sec = $(`#panel-${lab.id}`), btn = $('.run', sec), out = $('.out', sec);
  const p = params(lab);
  const bad = invalid(lab, p);
  if (bad) { out.innerHTML = `<div class="err">${esc(bad)}</div>`; return; }
  st.running = true; st.ran = true;
  btn.disabled = true; btn.textContent = !pyReady ? 'Waiting for Python…' : 'Running…';
  out.style.opacity = '.45';
  try {
    const data = await lab.run(p, out);
    btn.textContent = 'Running…';
    out.innerHTML = `<div class="out-actions">${actions('results')}</div>` + lab.render(data, lab);
    drawCharts(out);
    if (lab.mount === 'tk') new TkSession($('.tk-session', out), data);
    if (lab.mount === 'gl') new GLView($('.gl-box', out), data);
    if (lab.mount === 'img') await paintImages(out);
  } catch (e) {
    console.error(e);
    out.innerHTML = `<div class="err">${esc(e.message || e)}</div>`;
  } finally {
    st.running = false; btn.disabled = false; btn.textContent = 'Run'; out.style.opacity = '';
  }
}

function select(id, push) {
  const lab = LABS.find((l) => l.id === id) || LABS[0];
  nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', b.dataset.lab === lab.id));
  main.querySelectorAll('section.panel[role="tabpanel"]').forEach((s) => s.hidden = s.id !== `panel-${lab.id}`);
  if (push) try { history.replaceState(null, '', `#${lab.id}`); } catch {}
  document.title = `${labName(lab)} · Computer Vision Labs`;
  if (lab.skip) return;
  if (!state.get(lab.id).ran) run(lab);
  else drawCharts($(`#panel-${lab.id}`));
}

build();
const started = Date.now();
const tick = setInterval(() => {
  if (pyReady) return clearInterval(tick);
  const sec = Math.round((Date.now() - started) / 1000);
  document.querySelectorAll('.py-status').forEach((el) => {
    $('.elapsed', el).textContent = sec ? `${sec} s` : '';
    if (sec >= 45) { el.classList.add('slow'); $('.note-text', el).textContent = 'This is taking longer than usual. Check your connection, or reload the page.'; }
  });
}, 1000);
select(location.hash.slice(1), false);
window.addEventListener('hashchange', () => select(location.hash.slice(1), false));
