// WebGL2 fallback for the image labs: fragment-shader passes for the per-pixel work and
// point scatters (one point per pixel, additive or MAX blending into float targets) for the
// histograms, min/max and k-means sums. Without EXT_float_blend those reductions run on the CPU
// from read-back GPU images instead. Read-back is async: a pixel-pack buffer plus a fence.

export const webgl = { gl: null, info: '', reason: '', blend: false };

export function initWebGL2() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) { webgl.reason = 'WebGL2 is not available'; return false; }
    if (!gl.getExtension('EXT_color_buffer_float')) { webgl.reason = 'WebGL2 has no EXT_color_buffer_float'; return false; }
    webgl.blend = !!gl.getExtension('EXT_float_blend') && !/[?&]gpu=webgl-noblend\b/.test(location.search);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    webgl.info = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    webgl.gl = gl;
    return true;
  } catch (e) {
    webgl.reason = `WebGL2 failed to start (${e.message || e})`;
    return false;
  }
}

// -------------------------------------------------------------------- shaders --
const HEAD = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp usampler2D;\n';
const FULL_VS = `${HEAD}void main() { vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0); gl_Position = vec4(p, 0.0, 1.0); }`;
const COMMON = `
uniform usampler2D src;   // the BGR image cv2.imread gives, as RGB8UI: .r = B, .g = G, .b = R
uniform sampler2D img;    // an RGBA8 result image (canvas order) or an RGBA32F one
uniform sampler2D aux;    // a small float texture: a range or a histogram
uniform ivec4 mask;       // lab 7: rows [x, y), columns [z, w)
uniform float fp[5];      // lab 7: LUT points
uniform vec3 c0, c1;      // k-means centres (r, g, b)
uniform int W, H;
ivec2 at() { return ivec2(gl_FragCoord.xy); }
uvec3 rgb_at(ivec2 p) { uvec4 c = texelFetch(src, p, 0); return uvec3(c.b, c.g, c.r); }
uvec3 u8(vec4 v) { return uvec3(round(v.rgb * 255.0)); }
vec4 out8(uvec3 c) { return vec4(vec3(c), 255.0) / 255.0; }
bool in_mask(ivec2 p) { return p.y >= mask.x && p.y < mask.y && p.x >= mask.z && p.x < mask.w; }
`;
const FS = {
  // cv2.bitwise_and(img, img, mask=mask)
  mask_and: `out vec4 o; void main() { ivec2 p = at(); o = in_mask(p) ? out8(rgb_at(p)) : vec4(0, 0, 0, 1); }`,
  // stretch_contrast: np.interp(x, [0, 64, 128, 192, 255], fp).astype('uint8') through cv2.LUT
  lut: `out vec4 o;
    uint interp(float x) {
      float v;
      if (x < 64.0) v = ((fp[1] - fp[0]) / 64.0) * x + fp[0];
      else if (x < 128.0) v = ((fp[2] - fp[1]) / 64.0) * (x - 64.0) + fp[1];
      else if (x < 192.0) v = ((fp[3] - fp[2]) / 64.0) * (x - 128.0) + fp[2];
      else v = ((fp[4] - fp[3]) / 63.0) * (x - 192.0) + fp[3];
      if (x == 255.0) v = fp[4];
      return uint(int(trunc(v))) & 255u;
    }
    void main() { vec3 c = vec3(rgb_at(at())); o = out8(uvec3(interp(c.r), interp(c.g), interp(c.b))); }`,
  // cv2.normalize(..., 0, 255, NORM_MINMAX) with the range in aux (x = max, y = -min)
  normalize: `out vec4 o; void main() {
      vec4 r = texelFetch(aux, ivec2(0), 0); float lo = -r.y, hi = r.x;
      float scale = hi > lo ? 255.0 / (hi - lo) : 0.0;
      vec3 c = vec3(u8(texelFetch(img, at(), 0)));
      o = out8(uvec3(clamp(roundEven(c * scale - lo * scale), 0.0, 255.0))); }`,
  // cv2.cvtColor(BGR2GRAY), OpenCV's 15-bit fixed-point weights
  gray: `out vec4 o; void main() { uvec3 c = rgb_at(at()); uint v = (c.b * 3735u + c.g * 19235u + c.r * 9798u + 16384u) >> 15; o = out8(uvec3(v)); }`,
  // THRESH_OTSU (getThreshVal_Otsu_8u) over the grey histogram in aux, written to a 1x1 target
  otsu: `out vec4 o; void main() {
      float n = 0.0, mu = 0.0;
      for (int i = 0; i < 256; i++) { float h = texelFetch(aux, ivec2(i, 0), 0).r; n += h; mu += float(i) * h; }
      float scale = 1.0 / n; mu *= scale;
      float q1 = 0.0, mu1 = 0.0, max_sigma = 0.0, max_val = 0.0, eps = 1.1920929e-7;
      for (int i = 0; i < 256; i++) {
        float p_i = texelFetch(aux, ivec2(i, 0), 0).r * scale;
        mu1 *= q1; q1 += p_i; float q2 = 1.0 - q1;
        if (min(q1, q2) < eps || max(q1, q2) > 1.0 - eps) continue;
        mu1 = (mu1 + float(i) * p_i) / q1; float mu2 = (mu - q1 * mu1) / q2;
        float sigma = q1 * q2 * (mu1 - mu2) * (mu1 - mu2);
        if (sigma > max_sigma) { max_sigma = sigma; max_val = float(i); }
      }
      o = vec4(max_val, 0, 0, 1); }`,
  // THRESH_BINARY_INV with the threshold in aux
  binary_inv: `out vec4 o; void main() { uint t = uint(texelFetch(aux, ivec2(0), 0).r); o = out8(uvec3(u8(texelFetch(img, at(), 0)).r > t ? 0u : 255u)); }`,
  // k-means assignment: label 0 or 1 in .r
  km_assign: `out vec4 o; void main() { vec3 c = vec3(rgb_at(at())); vec3 d0 = c - c0, d1 = c - c1; o = vec4(dot(d1, d1) < dot(d0, d0) ? 1.0 / 255.0 : 0.0, 0, 0, 1); }`,
  // center[label], centres cast to uint8
  km_paint: `out vec4 o; void main() { uint k = u8(texelFetch(img, at(), 0)).r; o = out8(uvec3(k == 1u ? c1 : c0)); }`,
  // robert: ndimage.convolve with the two 2x2 kernels ('reflect' repeats the last row and column)
  robert: `out vec4 o;
    float g(int x, int y) { return float(u8(texelFetch(img, ivec2(min(x, W - 1), min(y, H - 1)), 0)).r) / 255.0; }
    void main() { ivec2 p = at(); float v = g(p.x + 1, p.y + 1) - g(p.x, p.y), h = g(p.x, p.y + 1) - g(p.x + 1, p.y); o = vec4(sqrt(h * h + v * v) * 255.0, 0, 0, 1); }`,
  // the page's min..max scaling of the float image: uint8(clip((m - lo) / (hi - lo) * 255, 0, 255))
  f_display: `out vec4 o; void main() {
      vec4 r = texelFetch(aux, ivec2(0), 0); float lo = -r.y, hi = r.x, span = hi - lo != 0.0 ? hi - lo : 1.0;
      float m = texelFetch(img, at(), 0).r; o = out8(uvec3(uint(clamp((m - lo) / span * 255.0, 0.0, 255.0)))); }`,
};
// point scatters: one point per pixel (gl_VertexID), the instance picks a channel or a target pixel
const SCATTER = {
  // histogram rows = channels (B, G, R order as cv2.calcHist), target 256 x rows
  hist: `uniform int rows, from_bgr, masked; out vec4 v;
    void main() {
      ivec2 p = ivec2(gl_VertexID % W, gl_VertexID / W);
      uvec3 bgr = from_bgr == 1 ? texelFetch(src, p, 0).rgb : u8(texelFetch(img, p, 0)).bgr;
      uint bin = rows == 1 ? bgr.b : bgr[gl_InstanceID];
      gl_PointSize = 1.0;
      gl_Position = masked == 1 && !in_mask(p) ? vec4(2, 2, 0, 1) : vec4((float(bin) + 0.5) / 128.0 - 1.0, (float(gl_InstanceID) + 0.5) / float(rows) * 2.0 - 1.0, 0, 1);
      v = vec4(1, 0, 0, 0);
    }`,
  // max and -min of every channel into 1x1 (MAX blending); float images use .r only
  minmax: `uniform int is_float; out vec4 v;
    void main() {
      ivec2 p = ivec2(gl_VertexID % W, gl_VertexID / W);
      vec4 t = texelFetch(img, p, 0);
      vec3 c = is_float == 1 ? t.rrr : vec3(u8(t));
      gl_PointSize = 1.0; gl_Position = vec4(0, 0, 0, 1);
      v = vec4(max(c.r, max(c.g, c.b)), -min(c.r, min(c.g, c.b)), 0, 0);
    }`,
  // k-means: per-channel max (instance 0) and -min (instance 1) of the colours into 2x1, the starting centres
  km_bounds: `out vec4 v;
    void main() {
      vec3 c = vec3(rgb_at(ivec2(gl_VertexID % W, gl_VertexID / W)));
      gl_PointSize = 1.0; gl_Position = vec4(gl_InstanceID == 0 ? -0.5 : 0.5, 0, 0, 1);
      v = vec4(gl_InstanceID == 0 ? c : -c, 0);
    }`,
  // k-means sums: colour / 255 and a count into pixel 0 or 1 of a 2x1 target (additive)
  km_sums: `out vec4 v;
    void main() {
      ivec2 p = ivec2(gl_VertexID % W, gl_VertexID / W);
      uint k = u8(texelFetch(img, p, 0)).r;
      gl_PointSize = 1.0; gl_Position = vec4(k == 1u ? 0.5 : -0.5, 0, 0, 1);
      v = vec4(vec3(rgb_at(p)) / 255.0, 1);
    }`,
};
const SCATTER_FS = `${HEAD}in vec4 v; out vec4 o; void main() { o = v; }`;

const programs = new Map();
function program(gl, name) {
  if (programs.has(name)) return programs.get(name);
  const sh = (type, code) => {
    const s = gl.createShader(type); gl.shaderSource(s, code); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${name}: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const scatter = name in SCATTER;
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, scatter ? HEAD + COMMON.replace('ivec2 at() { return ivec2(gl_FragCoord.xy); }', '') + SCATTER[name] : FULL_VS));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, scatter ? SCATTER_FS : HEAD + COMMON + FS[name]));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name}: ${gl.getProgramInfoLog(p)}`);
  const loc = new Map();
  const entry = { p, loc: (n) => (loc.has(n) ? loc.get(n) : (loc.set(n, gl.getUniformLocation(p, n)), loc.get(n))) };
  programs.set(name, entry);
  return entry;
}
const PROGS = { lab7: ['mask_and', 'lut', 'normalize', 'hist', 'minmax'], lab8: ['gray', 'otsu', 'binary_inv', 'km_assign', 'km_paint', 'robert', 'f_display', 'hist', 'minmax', 'km_bounds', 'km_sums'] };
/** Compile and link every program a lab uses; returns the time it took (0 when cached). */
export function prepareWebGL2(lab) {
  const t0 = performance.now();
  const fresh = PROGS[lab].some((n) => !programs.has(n));
  PROGS[lab].forEach((n) => program(webgl.gl, n));
  return fresh ? performance.now() - t0 : 0;
}

// ------------------------------------------------------------ textures, passes --
const wait = () => new Promise((r) => setTimeout(r, 1));
class Run {
  constructor(w, h) {
    const gl = (this.gl = webgl.gl);
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (w > max || h > max) throw new Error(`The image is larger than this GPU's ${max} px texture limit.`);
    this.w = w; this.h = h; this.n = w * h;
    this.texs = []; this.fbs = []; this.times = {};
    this.vao = gl.createVertexArray();
  }
  tex(w, h, internal, format, type, data = null) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.texs.push(t);
    let fb = null;
    if (internal !== gl.RGB8UI) {
      fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      this.fbs.push(fb);
    }
    return { t, fb, w, h, float: type === gl.FLOAT };
  }
  u8(w = this.w, h = this.h) { const gl = this.gl; return this.tex(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE); }
  f32(w, h, data = null) { const gl = this.gl; return this.tex(w, h, gl.RGBA32F, gl.RGBA, gl.FLOAT, data); }
  srcTex(bgr) { const gl = this.gl; return this.tex(this.w, this.h, gl.RGB8UI, gl.RGB_INTEGER, gl.UNSIGNED_BYTE, bgr); }
  /** Bind a program, its textures (src, img, aux) and uniforms, and the target. */
  use(name, target, { src, img, aux, ...uniforms } = {}) {
    const gl = this.gl, pr = program(gl, name);
    gl.useProgram(pr.p);
    gl.bindVertexArray(this.vao);
    [['src', src], ['img', img], ['aux', aux]].forEach(([n, t], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t ? t.t : null);
      gl.uniform1i(pr.loc(n), unit);
    });
    gl.uniform1i(pr.loc('W'), this.w); gl.uniform1i(pr.loc('H'), this.h);
    for (const [k, v] of Object.entries(uniforms)) {
      const l = pr.loc(k);
      if (k === 'mask') gl.uniform4i(l, ...v);
      else if (k === 'fp') gl.uniform1fv(l, v);
      else if (Array.isArray(v)) gl.uniform3f(l, ...v);
      else gl.uniform1i(l, v);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, target.w, target.h);
  }
  pass(name, target, opts) { const gl = this.gl; this.use(name, target, opts); gl.disable(gl.BLEND); gl.drawArrays(gl.TRIANGLES, 0, 3); return target; }
  scatter(name, target, instances, equation, clear, opts) {
    const gl = this.gl;
    this.use(name, target, opts);
    gl.clearColor(...clear); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendEquation(equation); gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArraysInstanced(gl.POINTS, 0, this.n, instances);
    gl.disable(gl.BLEND);
    return target;
  }
  /** Async read-back: readPixels into a pixel-pack buffer, then wait for a fence without blocking. */
  async read(t) {
    const gl = this.gl, size = t.w * t.h * 4;
    const out = t.float ? new Float32Array(size) : new Uint8Array(size);
    const pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, out.byteLength, gl.STREAM_READ);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.fb);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, t.float ? gl.FLOAT : gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    await this.fence();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteBuffer(pbo);
    return out;
  }
  async fence() {
    const gl = this.gl, sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) await wait();
    gl.deleteSync(sync);
  }
  async step(name, fn) {
    const t0 = performance.now();
    const r = await fn();
    await this.fence();
    this.times[name] = (this.times[name] || 0) + performance.now() - t0;
    return r;
  }

  // reductions: scatter with blending, or (no EXT_float_blend) count on the CPU from a read-back image
  async hist(source, rows, { fromBgr = null, mask = null } = {}) {
    if (webgl.blend) {
      const t = this.f32(256, rows);
      return this.scatter('hist', t, rows, this.gl.FUNC_ADD, [0, 0, 0, 0], { src: fromBgr, img: source, rows, from_bgr: fromBgr ? 1 : 0, masked: mask ? 1 : 0, mask: mask || [0, 0, 0, 0] });
    }
    const counts = new Float32Array(256 * rows * 4);
    const px = fromBgr ? null : await this.read(source);
    for (let i = 0; i < this.n; i++) {
      const y = (i / this.w) | 0, x = i - y * this.w;
      if (mask && !(y >= mask[0] && y < mask[1] && x >= mask[2] && x < mask[3])) continue;
      for (let c = 0; c < rows; c++) {
        const v = fromBgr ? fromBgr.bytes[i * 3 + c] : px[i * 4 + (rows === 1 ? 0 : 2 - c)];
        counts[(c * 256 + v) * 4]++;
      }
    }
    return this.f32(256, rows, counts);
  }
  async minmax(source, isFloat) {
    if (webgl.blend) return this.scatter('minmax', this.f32(1, 1), 1, this.gl.MAX, [-3e38, -3e38, 0, 0], { img: source, is_float: isFloat ? 1 : 0 });
    const px = await this.read(source);
    let hi = -Infinity, lo = Infinity;
    for (let i = 0; i < px.length; i += 4) for (let c = 0; c < (isFloat ? 1 : 3); c++) { const v = px[i + c]; if (v > hi) hi = v; if (v < lo) lo = v; }
    return this.f32(1, 1, new Float32Array([hi, -lo, 0, 0]));
  }
  free() {
    const gl = this.gl;
    this.texs.forEach((t) => gl.deleteTexture(t));
    this.fbs.forEach((f) => gl.deleteFramebuffer(f));
    gl.deleteVertexArray(this.vao);
  }
}

const histRows = (a, rows) => range(rows).map((c) => range(256, (v) => Math.round(a[(c * 256 + v) * 4])));
const range = (n, f = (i) => i) => Array.from({ length: n }, (_, i) => f(i));
const asU32 = (u8) => new Uint32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);

/** Lab 7 on WebGL2: same steps and outputs as lab7WebGPU. */
export async function lab7WebGL2(bgr, w, h, { mask, fp }) {
  const t0 = performance.now();
  const r = new Run(w, h);
  try {
    const src = r.srcTex(bgr); src.bytes = bgr;
    const masked = await r.step('mask', () => r.pass('mask_and', r.u8(), { src, mask }));
    const stretched = await r.step('lut', () => r.pass('lut', r.u8(), { src, fp }));
    let range7;
    const norm = await r.step('norm', async () => { range7 = await r.minmax(masked, false); return r.pass('normalize', r.u8(), { img: masked, aux: range7 }); });
    const hists = await r.step('hist', async () => [
      await r.hist(null, 3, { fromBgr: src }), await r.hist(masked, 3, { mask }), await r.hist(stretched, 3), await r.hist(norm, 3, { mask })]);
    const [m, s, no, rg, ...hs] = await Promise.all([r.read(masked), r.read(stretched), r.read(norm), r.read(range7), ...hists.map((t) => r.read(t))]);
    return {
      images: { masked: asU32(m), stretched: asU32(s), norm: asU32(no) }, normRange: [-rg[1], rg[0]],
      hists: hs.map((a) => histRows(a, 3)), times: r.times, total: performance.now() - t0,
    };
  } finally { r.free(); }
}

/** Lab 8 on WebGL2: grey + Otsu, k-means (k = 2; the 6-number centre update runs on the CPU) and Roberts. */
export async function lab8WebGL2(bgr, w, h) {
  const t0 = performance.now();
  const r = new Run(w, h);
  try {
    const src = r.srcTex(bgr); src.bytes = bgr;
    let grayHist, thr;
    const { gray, otsu } = await r.step('otsu', async () => {
      const gray = r.pass('gray', r.u8(), { src });
      grayHist = await r.hist(gray, 1);
      thr = r.pass('otsu', r.f32(1, 1), { aux: grayHist });
      return { gray, otsu: r.pass('binary_inv', r.u8(), { img: gray, aux: thr }) };
    });

    let centres, converged = false;
    const km = await r.step('kmeans', async () => {
      let b;
      if (webgl.blend) b = await r.read(r.scatter('km_bounds', r.f32(2, 1), 2, r.gl.MAX, [-3e38, -3e38, -3e38, -3e38], { src }));
      else {
        b = new Float32Array([0, 0, 0, 0, -255, -255, -255, 0]);
        for (let i = 0; i < r.n; i++) for (let c = 0; c < 3; c++) { const v = bgr[i * 3 + 2 - c]; b[c] = Math.max(b[c], v); b[4 + c] = Math.max(b[4 + c], -v); }
      }
      centres = [[-b[4], -b[5], -b[6]], [b[0], b[1], b[2]]];  // per-channel minima and maxima
      const labels = r.u8(), sums = r.f32(2, 1);
      for (let it = 0; it < 9 && !converged; it++) {
        r.pass('km_assign', labels, { src, c0: centres[0], c1: centres[1] });
        let s;
        if (webgl.blend) s = await r.read(r.scatter('km_sums', sums, 1, r.gl.FUNC_ADD, [0, 0, 0, 0], { src, img: labels }));
        else {
          const lab = await r.read(labels); s = new Float64Array(8);
          for (let i = 0; i < r.n; i++) { const k = lab[i * 4] ? 4 : 0; s[k] += bgr[i * 3 + 2]; s[k + 1] += bgr[i * 3 + 1]; s[k + 2] += bgr[i * 3]; s[k + 3]++; }
          for (let k = 0; k < 8; k += 4) for (let c = 0; c < 3; c++) s[k + c] /= 255;
        }
        let shift = 0;
        centres = centres.map((old, k) => {
          const cnt = s[k * 4 + 3];
          if (!cnt) return old;
          const m = [0, 1, 2].map((c) => (s[k * 4 + c] * 255) / cnt);
          shift = Math.max(shift, m.reduce((d, v, c) => d + (v - old[c]) ** 2, 0));
          return m.map(Math.fround);
        });
        converged = shift <= 1;
      }
      return r.pass('km_paint', r.u8(), { img: labels, c0: centres[0], c1: centres[1] });
    });

    const mag = await r.step('robert', () => r.pass('robert', r.f32(w, h), { img: gray }));
    let range8, dhist;
    const disp = await r.step('display', async () => {
      range8 = await r.minmax(mag, true);
      const disp = r.pass('f_display', r.u8(), { img: mag, aux: range8 });
      dhist = await r.hist(disp, 1);
      return disp;
    });

    const [g, gh, t, o, k, m, rg, d, dh] = await Promise.all([r.read(gray), r.read(grayHist), r.read(thr), r.read(otsu), r.read(km), r.read(mag), r.read(range8), r.read(disp), r.read(dhist)]);
    const robert = new Float32Array(r.n);
    for (let i = 0; i < r.n; i++) robert[i] = m[i * 4];
    return {
      images: { gray: asU32(g), otsu: asU32(o), kmeans: asU32(k), robert_disp: asU32(d) }, robert, robertRange: [-rg[1], rg[0]],
      grayHist: histRows(gh, 1)[0], otsu: t[0], centres, converged, dispHist: histRows(dh, 1)[0], times: r.times, total: performance.now() - t0,
    };
  } finally { r.free(); }
}
