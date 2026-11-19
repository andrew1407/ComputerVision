// GPU compute mode for labs 7 and 8: picks a backend (WebGPU, else WebGL2), runs the shader
// ports of the labs' OpenCV / SciPy calls on the same pixels OpenCV saw, and checks them
// against OpenCV's own arrays. CPU mode never touches this module's GPU code.
import { webgpu, initWebGPU, prepareWebGPU, lab7WebGPU, lab8WebGPU } from './webgpu.js';
import { webgl, initWebGL2, prepareWebGL2, lab7WebGL2, lab8WebGL2 } from './webgl2.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ms = (v) => (v == null ? '—' : `${v < 10 ? (+v.toFixed(2)) : Math.round(v)} ms`);
const yieldFrame = () => new Promise((r) => setTimeout(r, 0));
const NAMES = { webgpu: 'WebGPU', webgl2: 'WebGL2' };
export const HONEST = 'GPU mode is a port of the lab\'s computation to shaders (f32 on the GPU), not the lab\'s own code. OpenCV still runs first, as the reference.';

// ------------------------------------------------------------------ backend --
// ?gpu=webgl forces the WebGL2 fallback, ?gpu=none turns the GPU off (for testing both paths).
// WebGPU needs navigator.gpu and a non-null adapter; WebGL2 needs float render targets, probed in a
// worker (gpu/glprobe.js) because the first WebGL context can take a while. The page's own WebGL2
// context is only created when a GPU run starts.
const want = new URLSearchParams(location.search).get('gpu') || '';
const probeWebGL2 = () => new Promise((resolve) => {
  try {
    const w = new Worker(new URL('./glprobe.js', import.meta.url));
    const end = (reason) => { w.terminate(); resolve(reason); };
    w.onmessage = (e) => end(e.data);
    w.onerror = (e) => { e.preventDefault?.(); end('the WebGL2 check failed'); };
    setTimeout(() => end('the WebGL2 check timed out'), 10000);
  } catch (e) { resolve(`the WebGL2 check failed (${e.message || e})`); }
});
export const backend = (async () => {
  const reasons = [];
  if (want === 'none' || want === 'cpu') return { name: null, reason: 'the GPU is turned off by ?gpu=none' };
  if (!want.startsWith('webgl')) {
    if (await initWebGPU()) return { name: 'webgpu', info: webgpu.info };
    reasons.push(webgpu.reason);
  }
  const reason = await probeWebGL2();
  if (!reason) return { name: 'webgl2', info: 'WebGL2 with float render targets' };
  reasons.push(reason);
  return { name: null, reason: reasons.join('; and ') };
})();

// ------------------------------------------------------------- the control --
// GPU first, then CPU. With a WebGPU adapter the GPU is the default; with only WebGL2 the
// default stays CPU. A choice made on the page is kept per lab for the session, and an explicit
// ?gpu=webgpu / ?gpu=webgl… picks the GPU regardless.
const ICON_GPU = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="4" width="13" height="7.5" rx="1.2"/><circle cx="10.5" cy="7.75" r="2"/><path d="M4 6.5h2.5M4 9h2.5M3 11.5V14M6 11.5V14"/></svg>';
const ICON_CPU = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.2"/><rect x="6.5" y="6.5" width="3" height="3" fill="currentColor" stroke="none"/><path d="M6 1.5V4M10 1.5V4M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5"/></svg>';
const mode = new Map(), ready = new Map();
backend.then((b) => { if (!b.name) console.info(`GPU mode is not offered: ${b.reason}`); });
const KEY = (lab) => `cv-compute-${lab}`;
const store = {
  get: (lab) => { try { return sessionStorage.getItem(KEY(lab)); } catch { return null; } },
  set: (lab, v) => { try { sessionStorage.setItem(KEY(lab), v); } catch {} },
};
/** Resolves to true when the lab should run on the GPU; waits for the backend check on the first run. */
export const gpuOn = async (lab) => { await ready.get(lab); return mode.get(lab) === 'gpu'; };

/** Add the GPU / CPU switch before the lab form's Run button; onChange re-runs the lab.
 *  It shows CPU, dimmed and inert, until the backend check resolves, and is removed when there's no GPU. */
export function mountControl(form, lab, onChange) {
  mode.set(lab, 'cpu');
  const box = document.createElement('div');
  box.className = 'field compute';
  box.innerHTML = `<span>Compute</span><div class="compute-switch cs-pending" role="radiogroup" aria-label="Compute" style="--n:2;--i:1">
      <label data-gpu-opt><input type="radio" name="${lab}-compute" value="gpu" disabled>${ICON_GPU}GPU<span class="cs-chip" hidden></span></label>
      <label title="Run the lab's OpenCV / SciPy code only, as the lab does"><input type="radio" name="${lab}-compute" value="cpu" checked disabled>${ICON_CPU}CPU</label></div>`;
  form.querySelector('.run').before(box);
  const sw = box.querySelector('.compute-switch');
  const inputs = [...sw.querySelectorAll('input')];
  const show = (v) => { inputs.forEach((i) => { i.checked = i.value === v; }); sw.style.setProperty('--i', v === 'gpu' ? 0 : 1); };
  let initial = 'cpu';
  ready.set(lab, backend.then((b) => {
    if (!b.name) { box.remove(); return; }
    const gpuLabel = sw.querySelector('[data-gpu-opt]'), chip = sw.querySelector('.cs-chip');
    gpuLabel.title = `Also run the ${NAMES[b.name]} port of these calls and compare it with OpenCV (${b.info})`;
    chip.textContent = NAMES[b.name]; chip.hidden = false;
    const forced = want && want !== 'none' && want !== 'cpu';
    initial = b.name === 'webgpu' || forced ? 'gpu' : 'cpu';
    const v = forced ? 'gpu' : (store.get(lab) === 'gpu' || store.get(lab) === 'cpu' ? store.get(lab) : initial);
    inputs.forEach((i) => { i.defaultChecked = i.value === initial; i.disabled = false; });
    mode.set(lab, v); show(v);
    sw.classList.remove('cs-pending');
  }));
  sw.addEventListener('change', (e) => { const v = e.target.value; mode.set(lab, v); store.set(lab, v); show(v); onChange(); });
  // Defaults puts the device's default back (the form resets the radios after this event)
  form.addEventListener('reset', () => setTimeout(() => { if (!box.isConnected) return; mode.set(lab, initial); store.set(lab, initial); show(initial); }));
}

// ------------------------------------------------------------ comparisons --
/** GPU RGBA (u32 per pixel) against an OpenCV array with `ch` channels in `order` (indices into r, g, b). */
function compareU8(gpu, cpu, ch, order) {
  const g = new Uint8Array(gpu.buffer, gpu.byteOffset, gpu.byteLength);
  let max = 0, sum = 0, px = 0;
  const n = cpu.length / ch;
  for (let i = 0; i < n; i++) {
    let bad = false;
    for (let c = 0; c < ch; c++) {
      const d = Math.abs(g[i * 4 + order[c]] - cpu[i * ch + c]);
      if (d) { bad = true; sum += d; if (d > max) max = d; }
    }
    if (bad) px++;
  }
  return { kind: 'u8', max, mean: sum / (n * ch), px, n };
}
function compareF(gpu, cpu) {
  let max = 0, sum = 0, top = 0;
  for (let i = 0; i < cpu.length; i++) { const d = Math.abs(gpu[i] - cpu[i]); sum += d; if (d > max) max = d; if (Math.abs(cpu[i]) > top) top = Math.abs(cpu[i]); }
  return { kind: 'f', max, mean: sum / cpu.length, rel: top ? max / top : 0 };
}
function compareHist(gpu, cpu) {
  let bins = 0, max = 0;
  gpu.flat().forEach((v, i) => { const d = Math.abs(v - cpu.flat()[i]); if (d) { bins++; max = Math.max(max, d); } });
  return { kind: 'hist', bins, max };
}
const BGR = [2, 1, 0], RGB = [0, 1, 2], GREY = [0];
function checkHtml(c) {
  if (!c) return '—';
  const ok = (t) => `<span class="gpu-ok">${t}</span>`, warn = (t) => `<span class="gpu-warn">${t}</span>`;
  if (c.kind === 'u8') return c.max === 0 ? ok('exact match') : (c.max <= 1 ? ok : warn)(`max |Δ| ${c.max}, mean ${c.mean.toExponential(1)}, ${c.px.toLocaleString('en-US')} px (${(100 * c.px / c.n).toFixed(c.px / c.n < 0.001 ? 3 : 2)}%) differ`);
  if (c.kind === 'f') return (c.rel < 1e-4 ? ok : warn)(`max |Δ| ${c.max.toExponential(2)}, rel ${c.rel.toExponential(1)}, mean ${c.mean.toExponential(1)}`);
  if (c.kind === 'hist') return c.bins === 0 ? ok('all bins equal') : warn(`${c.bins} bins differ, by up to ${c.max}`);
  if (c.kind === 'eq') return c.ok ? ok(c.text) : warn(c.text);
  return String(c);
}

const asType = (bytes, dtype) => (dtype === 'float64' ? new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8) : bytes);
async function fetchRaw(take, spec) {
  const out = {};
  for (const [k, v] of Object.entries(spec)) out[k] = { ...v, data: asType(await take(v.key), v.dtype) };
  return out;
}

async function prepare(lab) {
  const b = await backend;
  if (!b.name) throw new Error(`The GPU isn't available: ${b.reason}`);
  if (b.name === 'webgl2' && !webgl.gl) {
    if (!initWebGL2()) throw new Error(`The GPU isn't available: ${webgl.reason}`);
    b.info = webgl.info + (webgl.blend ? '' : ' (no EXT_float_blend: reductions on the CPU)');
  }
  return { b, compile: b.name === 'webgpu' ? await prepareWebGPU(lab) : prepareWebGL2(lab) };
}

/** Lab 7: run the port on the image OpenCV loaded and check every result. Adds d.gpu. */
export async function runLab7(d, take) {
  const { b, compile } = await prepare('lab7');
  const raw = await fetchRaw(take, d.raw);
  const [h, w] = raw.img.shape;
  const res = await (b.name === 'webgpu' ? lab7WebGPU : lab7WebGL2)(raw.img.data, w, h, { mask: d.mask, fp: d.fp_values });
  await yieldFrame();
  const checks = {};
  checks.mask = compareU8(res.images.masked, raw.masked.data, 3, BGR); await yieldFrame();
  checks.lut = compareU8(res.images.stretched, raw.stretched.data, 3, BGR); await yieldFrame();
  checks.norm = compareU8(res.images.norm, raw.norm.data, 3, BGR); await yieldFrame();
  checks.hist = compareHist(res.hists, d.panels.map((p) => p.hist));
  d.gpu = { backend: b, compile, res, checks, images: [null, res.images.masked, res.images.stretched, res.images.norm] };
  return d;
}

/** Lab 8: run the port on each (scaled) image OpenCV segmented. Adds im.gpu to every image. */
export async function runLab8(d, take) {
  const { b, compile } = await prepare('lab8');
  for (const im of d.images) {
    const raw = await fetchRaw(take, im.raw);
    const [h, w] = raw.img.shape;
    const res = await (b.name === 'webgpu' ? lab8WebGPU : lab8WebGL2)(raw.img.data, w, h);
    await yieldFrame();
    const checks = {};
    checks.gray = compareU8(res.images.gray, raw.gray.data, 1, GREY);
    checks.otsuT = { kind: 'eq', ok: res.otsu === im.otsu, text: res.otsu === im.otsu ? `same threshold, ${res.otsu}` : `threshold ${res.otsu}, OpenCV ${im.otsu}` };
    checks.grayHist = compareHist([res.grayHist], [im.gray_hist]); await yieldFrame();
    checks.otsu = compareU8(res.images.otsu, raw.otsu.data, 1, GREY); await yieldFrame();
    checks.kmeans = compareU8(res.images.kmeans, raw.kmeans.data, 3, RGB); await yieldFrame();
    checks.robert = compareF(res.robert, raw.robert.data); await yieldFrame();
    checks.disp = compareU8(res.images.robert_disp, raw.robert_disp.data, 1, GREY);
    checks.dispHist = compareHist([res.dispHist], [im.panels[3].hist[0]]);
    im.gpu = { backend: b, compile, res, checks, images: [null, res.images.otsu, res.images.kmeans, res.images.robert_disp] };
    await yieldFrame();
  }
  d.gpu = { backend: b, compile: d.images[0]?.gpu.compile };
  return d;
}

// ------------------------------------------------------------------ views --
let viewSeq = 0;
const toggle = (backendName, id = `gpu-view-${++viewSeq}`) => `<span class="seg gpu-view" role="radiogroup" aria-label="Images to show">
    <label title="Show the images OpenCV / SciPy made"><input type="radio" name="${id}" value="cpu" checked>OpenCV</label>
    <label title="Show the images the GPU port made"><input type="radio" name="${id}" value="gpu">GPU · ${NAMES[backendName]}</label></span>`;
const head = (g, cpuTotal, gpuTotal, extra = '') => `<div class="stats">
    <div class="stat"><b>GPU · ${NAMES[g.backend.name]}</b><span title="${esc(g.backend.info)}">backend that ran</span></div>
    <div class="stat"><b>${ms(cpuTotal)}</b><span>OpenCV / SciPy time</span></div>
    <div class="stat"><b>${ms(gpuTotal)}</b><span>GPU time, with upload and read-back</span></div>
    <div class="stat"><b>${g.compile ? ms(g.compile) : 'cached'}</b><span>shader compile</span></div>${extra}</div>`;
const row = (step, cpu, gpu, check) => `<tr><td>${step}</td><td class="num">${ms(cpu)}</td><td class="num">${ms(gpu)}</td><td>${checkHtml(check)}</td></tr>`;
const table = (title, rows) => `<div data-copyable><div class="copy-head"><h2>${title}</h2><span class="copy-actions"><button type="button" class="mini" data-act="table" title="Copy the table as tab-separated text, pastes into spreadsheets">Copy table</button></span></div>
  <div class="table-wrap"><table><thead><tr><th>Step</th><th class="num">OpenCV</th><th class="num">GPU</th><th>Check against OpenCV</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;

export function view7(d) {
  const g = d.gpu, t = g.res.times, c = d.times;
  const cpuTotal = c.mask + c.lut + c.norm + c.hist;
  return `<div class="gpu-box" data-gpu-box>
    <div class="gpu-top"><h2>GPU check</h2>${toggle(g.backend.name)}</div>
    <p class="note port gpu-note">${HONEST}</p>
    ${head(g, cpuTotal, g.res.total, `<div class="stat"><b>${g.res.normRange.join(' … ')}</b><span>NORM_MINMAX range found</span></div>`)}
    ${table('OpenCV vs GPU', [
      row('<code>cv2.bitwise_and</code> with the mask', c.mask, t.mask, g.checks.mask),
      row('<code>stretch_contrast</code>: <code>np.interp</code> + <code>cv2.LUT</code>', c.lut, t.lut, g.checks.lut),
      row('<code>cv2.normalize</code> <code>NORM_MINMAX</code> (min/max reduction + map)', c.norm, t.norm, g.checks.norm),
      row('4 × <code>cv2.calcHist</code>, 3 channels (atomics / point scatter)', c.hist, t.hist, g.checks.hist),
    ].join(''))}</div>`;
}

export function view8(im) {
  const g = im.gpu, t = g.res.times, c = im.times;
  const ch = g.checks;
  return `<div class="gpu-box" data-gpu-box>
    <div class="gpu-top"><h2>GPU check</h2>${toggle(g.backend.name)}</div>
    ${head(g, c.otsu + c.kmeans + c.robert, g.res.total, `<div class="stat"><b>${g.res.centres.map((k) => `#${k.map((v) => Math.trunc(v).toString(16).padStart(2, '0')).join('')}`).join(' ')}</b><span>GPU k-means centres${g.res.converged ? '' : ' (9 iterations, not converged)'}</span></div>`)}
    ${table('OpenCV / SciPy vs GPU', [
      row('<code>otsu</code>: grey, histogram, Otsu threshold, <code>THRESH_BINARY_INV</code>', c.otsu, t.otsu, ch.otsu),
      row('&nbsp;&nbsp;grey image (<code>COLOR_BGR2GRAY</code>)', null, null, ch.gray),
      row('&nbsp;&nbsp;grey histogram', null, null, ch.grayHist),
      row('&nbsp;&nbsp;Otsu threshold', null, null, ch.otsuT),
      row('<code>kmeans</code>, k = 2 (Lloyd, 1 attempt, see the note above)', c.kmeans, t.kmeans, ch.kmeans),
      row('<code>robert</code>: two 2×2 convolutions + magnitude (f32 vs float64)', c.robert, t.robert, ch.robert),
      row('min…max scaling for display + its histogram', null, t.display, ch.disp),
      row('&nbsp;&nbsp;display histogram', null, null, ch.dispHist),
    ].join(''))}</div>`;
}
export const KMEANS_NOTE = '<p class="hint" style="margin: 0 0 14px">GPU k-means can\'t replay <code>cv2.kmeans</code>\'s random k-means++ seeding and its 10 attempts, so the port runs one deterministic attempt of the same Lloyd iterations (eps 1, at most 10 iterations) from the per-channel minimum and maximum colours. Pixels that differ sit where the two runs settled on slightly different centres.</p>';

/** After the OpenCV images are painted: wire the OpenCV / GPU switch of each GPU box to the figures that follow it. */
export function mount(out) {
  out.querySelectorAll('[data-gpu-box]').forEach((box) => {
    const scope = box.closest('[data-group]') || out;
    const figs = [...scope.querySelectorAll('figure.img')];
    const g = box._gpu;
    if (!g) return;
    const cpuData = figs.map((f) => { const cv = f.querySelector('canvas'); return cv.width ? cv.getContext('2d').getImageData(0, 0, cv.width, cv.height) : null; });
    const show = (which) => figs.forEach((f, i) => {
      const cv = f.querySelector('canvas'), px = g.images[i];
      const sub = f.querySelector('figcaption .gpu-tag') || f.querySelector('figcaption > span').appendChild(Object.assign(document.createElement('span'), { className: 'gpu-tag' }));
      if (which === 'gpu' && px && cv.width * cv.height === px.length) {
        cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), cv.width, cv.height), 0, 0);
        sub.textContent = ` · GPU`;
      } else {
        if (cpuData[i]) cv.getContext('2d').putImageData(cpuData[i], 0, 0);
        sub.textContent = which === 'gpu' && i === 0 ? ' · input' : '';
      }
    });
    box.querySelector('.gpu-view').addEventListener('change', (e) => show(e.target.value));
  });
}
/** Give each rendered GPU box its data (the view functions return HTML strings). */
export function attach(out, list) {
  [...out.querySelectorAll('[data-gpu-box]')].forEach((box, i) => { box._gpu = list[i]; });
}
