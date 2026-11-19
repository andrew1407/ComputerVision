// WebGPU backend for the image labs: device setup, cached pipelines for gpu/cv.wgsl, buffers,
// dispatches and async read-back (the same plumbing as the ParallelCuda showcase's gpu.js).

const WG = 256;
export const webgpu = { device: null, info: '', reason: '' };

export async function initWebGPU() {
  if (!navigator.gpu) { webgpu.reason = 'this browser has no WebGPU (navigator.gpu is missing)'; return false; }
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) { webgpu.reason = 'no WebGPU adapter is available'; return false; }
    const a = adapter.limits;
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: a.maxStorageBufferBindingSize,
        maxBufferSize: a.maxBufferSize,
        maxStorageBuffersPerShaderStage: Math.min(8, a.maxStorageBuffersPerShaderStage),
      },
    });
    device.lost.then((e) => { webgpu.device = null; webgpu.reason = `the GPU device was lost (${e.message || e.reason})`; });
    webgpu.device = device;
    const info = adapter.info || {};
    webgpu.info = [info.vendor, info.architecture, info.description].filter(Boolean).join(' · ') || 'unknown adapter';
    return true;
  } catch (e) {
    webgpu.reason = `WebGPU failed to start (${e.message || e})`;
    return false;
  }
}

// ------------------------------------------------------------------ pipelines --
let modulePromise = null;
const pipelines = new Map();
function shaderModule() {
  if (!modulePromise) modulePromise = (async () => {
    const res = await fetch(new URL('./cv.wgsl', import.meta.url));
    if (!res.ok) throw new Error(`gpu/cv.wgsl: HTTP ${res.status}`);
    const module = webgpu.device.createShaderModule({ label: 'cv.wgsl', code: await res.text() });
    const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error');
    if (errors.length) throw new Error(`cv.wgsl: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
    return module;
  })();
  return modulePromise;
}
async function pipeline(entryPoint, constants = {}) {
  const key = `${entryPoint}|${JSON.stringify(constants)}`;
  if (!pipelines.has(key)) {
    const p = (async () => {
      const module = await shaderModule();
      webgpu.device.pushErrorScope('validation');
      const pipe = await webgpu.device.createComputePipelineAsync({ label: key, layout: 'auto', compute: { module, entryPoint, constants } });
      const err = await webgpu.device.popErrorScope();
      if (err) throw new Error(err.message);
      return pipe;
    })();
    pipelines.set(key, p);
    p.catch(() => pipelines.delete(key));
  }
  return pipelines.get(key);
}

const KERNELS = {
  lab7: [['mask_and'], ['lut'], ['min_max'], ['normalize'], ['histogram', { FROM_BGR: true }], ['histogram', { MASKED: true }], ['histogram']],
  lab8: [['gray'], ['histogram', { CHANNELS: 1 }], ['otsu'], ['binary_inv'], ['km_bounds'], ['km_init'], ['km_assign'], ['km_update'], ['km_paint'], ['robert'], ['f_min_max'], ['f_display']],
};
/** Compile every pipeline a lab uses; returns the time it took (0 when they're cached). */
export async function prepareWebGPU(lab) {
  const t0 = performance.now();
  const fresh = KERNELS[lab].some(([e, c = {}]) => !pipelines.has(`${e}|${JSON.stringify(c)}`));
  await Promise.all(KERNELS[lab].map(([e, c]) => pipeline(e, c)));
  return fresh ? performance.now() - t0 : 0;
}

// -------------------------------------------------------------------- buffers --
const U = () => GPUBufferUsage;
function storage(dataOrBytes) {
  const bytes = typeof dataOrBytes === 'number' ? dataOrBytes : dataOrBytes.byteLength;
  const buf = webgpu.device.createBuffer({ size: Math.max(16, Math.ceil(bytes / 4) * 4), usage: U().STORAGE | U().COPY_SRC | U().COPY_DST });
  if (typeof dataOrBytes !== 'number') {
    const padded = dataOrBytes.byteLength % 4 ? (() => { const a = new Uint8Array(Math.ceil(dataOrBytes.byteLength / 4) * 4); a.set(new Uint8Array(dataOrBytes.buffer, dataOrBytes.byteOffset, dataOrBytes.byteLength)); return a; })() : dataOrBytes;
    webgpu.device.queue.writeBuffer(buf, 0, padded);
  }
  return buf;
}
function uniform(p) {
  const data = new ArrayBuffer(64), u = new Uint32Array(data), f = new Float32Array(data);
  u.set([p.w, p.h, p.y0 || 0, p.y1 || 0, p.x0 || 0, p.x1 || 0, p.w * p.h, 0]);
  f.set((p.fp || [0, 0, 0, 0, 0]).slice(0, 5), 8);
  const buf = webgpu.device.createBuffer({ size: 64, usage: U().UNIFORM | U().COPY_DST });
  webgpu.device.queue.writeBuffer(buf, 0, data);
  return buf;
}
async function download(src, size, Type) {
  const rb = webgpu.device.createBuffer({ size: Math.ceil(size / 4) * 4, usage: U().MAP_READ | U().COPY_DST });
  const enc = webgpu.device.createCommandEncoder();
  enc.copyBufferToBuffer(src, 0, rb, 0, Math.ceil(size / 4) * 4);
  webgpu.device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  const out = new Type(rb.getMappedRange().slice(0, size));
  rb.unmap(); rb.destroy();
  return out;
}

/** One lab run: dispatch helpers bound to the image size, per-step timing and clean-up. */
class Run {
  constructor(params) {
    this.p = params;
    this.n = params.w * params.h;
    const groups = Math.ceil(this.n / WG);
    this.grid = [Math.min(groups, 65535), Math.ceil(groups / 65535)];
    this.u = uniform(params);
    this.bufs = [this.u];
    this.times = {};
  }
  buf(dataOrBytes) { const b = storage(dataOrBytes); this.bufs.push(b); return b; }
  /** Encode a dispatch: bindings {1: src, 2: dst, ...} beside the uniform at 0. */
  async enc(enc, entry, binds, constants = {}, single = false) {
    const pipe = await pipeline(entry, constants);
    const group = webgpu.device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [[0, this.u], ...Object.entries(binds)].map(([b, buffer]) => ({ binding: +b, resource: { buffer } })),
    });
    const pass = enc.beginComputePass();
    pass.setPipeline(pipe); pass.setBindGroup(0, group);
    if (single) pass.dispatchWorkgroups(1); else pass.dispatchWorkgroups(...this.grid);
    pass.end();
  }
  /** Run a step (a list of dispatches) and time it to completion on the queue. */
  async step(name, dispatches) {
    const t0 = performance.now();
    const enc = webgpu.device.createCommandEncoder();
    for (const d of dispatches) await this.enc(enc, ...d);
    webgpu.device.queue.submit([enc.finish()]);
    await webgpu.device.queue.onSubmittedWorkDone();
    this.times[name] = (this.times[name] || 0) + performance.now() - t0;
  }
  read(buf, bytes, Type = Uint32Array) { return download(buf, bytes, Type); }
  free() { this.bufs.forEach((b) => b.destroy()); }
}

/** Lab 7: bitwise_and with the mask, the LUT stretch, NORM_MINMAX and the four calcHist calls. */
export async function lab7WebGPU(bgr, w, h, { mask, fp }) {
  const t0 = performance.now();
  const r = new Run({ w, h, y0: mask[0], y1: mask[1], x0: mask[2], x1: mask[3], fp });
  try {
    const n = r.n, img = n * 4;
    const src = r.buf(bgr);
    const masked = r.buf(img), stretched = r.buf(img), norm = r.buf(img);
    const mm = r.buf(new Uint32Array([0xffffffff, 0, 0, 0]));
    const hists = [0, 1, 2, 3].map(() => r.buf(768 * 4));
    await r.step('mask', [['mask_and', { 1: src, 2: masked }]]);
    await r.step('lut', [['lut', { 1: src, 2: stretched }]]);
    await r.step('norm', [['min_max', { 1: masked, 3: mm }], ['normalize', { 1: masked, 5: mm, 2: norm }]]);
    await r.step('hist', [
      ['histogram', { 1: src, 3: hists[0] }, { FROM_BGR: true }],
      ['histogram', { 1: masked, 3: hists[1] }, { MASKED: true }],
      ['histogram', { 1: stretched, 3: hists[2] }],
      ['histogram', { 1: norm, 3: hists[3] }, { MASKED: true }],
    ]);
    const [m, s, no, range, ...hs] = await Promise.all([r.read(masked, img), r.read(stretched, img), r.read(norm, img), r.read(mm, 8), ...hists.map((b) => r.read(b, 768 * 4))]);
    return {
      images: { masked: m, stretched: s, norm: no }, normRange: [range[0], range[1]],
      hists: hs.map((a) => [0, 1, 2].map((c) => Array.from(a.subarray(c * 256, c * 256 + 256)))),
      times: r.times, total: performance.now() - t0,
    };
  } finally { r.free(); }
}

/** Lab 8: grey + Otsu, k-means (k = 2) and Roberts cross for one image. */
export async function lab8WebGPU(bgr, w, h) {
  const t0 = performance.now();
  const r = new Run({ w, h });
  try {
    const n = r.n, img = n * 4;
    const src = r.buf(bgr);
    const gray = r.buf(img), hist = r.buf(256 * 4), thr = r.buf(16), otsu = r.buf(img);
    await r.step('otsu', [['gray', { 1: src, 2: gray }], ['histogram', { 1: gray, 3: hist }, { CHANNELS: 1 }], ['otsu', { 5: hist, 2: thr }, {}, true], ['binary_inv', { 1: gray, 5: thr, 2: otsu }]]);

    const ks = r.buf(new Uint32Array(32).fill(255, 0, 3));  // minima start at 255, maxima, sums and the done flag at 0
    const centres = r.buf(8 * 4), labels = r.buf(img), km = r.buf(img);
    const iters = [];
    for (let i = 0; i < 9; i++) iters.push(['km_assign', { 1: src, 2: labels, 3: ks, 4: centres }], ['km_update', { 3: ks, 4: centres }, {}, true]);
    await r.step('kmeans', [['km_bounds', { 1: src, 3: ks }], ['km_init', { 3: ks, 4: centres }, {}, true], ...iters, ['km_paint', { 5: labels, 4: centres, 2: km }]]);

    const mag = r.buf(img), range = r.buf(new Uint32Array([0xffffffff, 0, 0, 0])), disp = r.buf(img), dhist = r.buf(256 * 4);
    await r.step('robert', [['robert', { 1: gray, 4: mag }]]);
    await r.step('display', [['f_min_max', { 4: mag, 3: range }], ['f_display', { 4: mag, 5: range, 2: disp }], ['histogram', { 1: disp, 3: dhist }, { CHANNELS: 1 }]]);

    const [g, gh, t, o, kmImg, c, state, m, rg, d, dh] = await Promise.all([
      r.read(gray, img), r.read(hist, 1024), r.read(thr, 4), r.read(otsu, img), r.read(km, img), r.read(centres, 24, Float32Array), r.read(ks, 17 * 4),
      r.read(mag, img, Float32Array), r.read(range, 8, Float32Array), r.read(disp, img), r.read(dhist, 1024)]);
    return {
      images: { gray: g, otsu: o, kmeans: kmImg, robert_disp: d }, robert: m, robertRange: [rg[0], rg[1]],
      grayHist: Array.from(gh), otsu: t[0], centres: [Array.from(c.slice(0, 3)), Array.from(c.slice(3, 6))], converged: state[16] === 1,
      dispHist: Array.from(dh), times: r.times, total: performance.now() - t0,
    };
  } finally { r.free(); }
}
