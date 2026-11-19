// WebGPU ports of the OpenCV / SciPy calls labs 7 and 8 make, one pixel per invocation.
// Images: `src` is the BGR bytes cv2.imread gives, packed four to a u32; every result image
// is one u32 per pixel in canvas order (r | g << 8 | b << 16 | a << 24), so it goes straight
// into an ImageData. Grey images repeat the value in r, g and b.

struct Params {
  w: u32, h: u32, y0: u32, y1: u32,    // image size; lab 7's mask rows [y0, y1) and columns [x0, x1)
  x0: u32, x1: u32, n: u32, _p0: u32,  // n = w * h
  fp0: f32, fp1: f32, fp2: f32, fp3: f32, fp4: f32, _p1: f32, _p2: f32, _p3: f32,  // lab 7's LUT points
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;   // packed BGR bytes, or a u32-per-pixel image
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read_write> acc: array<atomic<u32>>;  // histograms, min/max, sums
@group(0) @binding(4) var<storage, read_write> fdst: array<f32>;        // Roberts magnitude, k-means centres
@group(0) @binding(5) var<storage, read> aux: array<u32>;               // a second input (mask/threshold/labels)

const WG = 256u;
override MASKED: bool = false;   // lab 7: count only the pixels inside the mask
override FROM_BGR: bool = false; // read `src` as packed BGR bytes instead of one u32 per pixel
override CHANNELS: u32 = 3u;

fn pixel_index(gid: vec3<u32>, nwg: vec3<u32>) -> u32 { return gid.x + gid.y * nwg.x * WG; }
fn byte_at(k: u32) -> u32 { return (src[k >> 2u] >> ((k & 3u) * 8u)) & 255u; }
fn bgr(i: u32) -> vec3<u32> { let k = i * 3u; return vec3<u32>(byte_at(k), byte_at(k + 1u), byte_at(k + 2u)); }
fn rgba(r: u32, g: u32, b: u32) -> u32 { return r | (g << 8u) | (b << 16u) | 0xff000000u; }
fn unpack(c: u32) -> vec3<u32> { return vec3<u32>(c & 255u, (c >> 8u) & 255u, (c >> 16u) & 255u); }  // r, g, b
fn in_mask(i: u32) -> bool {
  let y = i / P.w; let x = i % P.w;
  return y >= P.y0 && y < P.y1 && x >= P.x0 && x < P.x1;
}

// ---------------------------------------------------------------- lab 7 --
// cv2.bitwise_and(img, img, mask=mask): the pixel where the mask is set, black elsewhere
@compute @workgroup_size(WG)
fn mask_and(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let i = pixel_index(gid, nwg);
  if (i >= P.n) { return; }
  let c = bgr(i);
  dst[i] = select(rgba(0u, 0u, 0u), rgba(c.z, c.y, c.x), in_mask(i));
}

// stretch_contrast: np.interp(x, [0, 64, 128, 192, 255], fp).astype('uint8'), then cv2.LUT
fn interp(x: f32) -> u32 {
  var v: f32;
  // np.interp picks the segment with xp[j] <= x < xp[j + 1] and computes slope * (x - xp[j]) + fp[j]
  if (x < 64.0) { v = ((P.fp1 - P.fp0) / 64.0) * (x - 0.0) + P.fp0; }
  else if (x < 128.0) { v = ((P.fp2 - P.fp1) / 64.0) * (x - 64.0) + P.fp1; }
  else if (x < 192.0) { v = ((P.fp3 - P.fp2) / 64.0) * (x - 128.0) + P.fp2; }
  else { v = ((P.fp4 - P.fp3) / 63.0) * (x - 192.0) + P.fp3; }
  if (x == 255.0) { v = P.fp4; }
  return u32(i32(trunc(v))) & 255u;  // astype('uint8') truncates
}
@compute @workgroup_size(WG)
fn lut(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let i = pixel_index(gid, nwg);
  if (i >= P.n) { return; }
  let c = bgr(i);
  dst[i] = rgba(interp(f32(c.z)), interp(f32(c.y)), interp(f32(c.x)));
}

// min and max over every channel of a u32-per-pixel image (cv2.normalize's minMaxLoc):
// acc[0] = min, acc[1] = max, reduced in workgroup memory first
var<workgroup> wmin: atomic<u32>;
var<workgroup> wmax: atomic<u32>;
@compute @workgroup_size(WG)
fn min_max(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&wmin, 0xffffffffu); atomicStore(&wmax, 0u); }
  workgroupBarrier();
  let i = pixel_index(gid, nwg);
  if (i < P.n) {
    let c = unpack(src[i]);
    atomicMin(&wmin, min(c.x, min(c.y, c.z)));
    atomicMax(&wmax, max(c.x, max(c.y, c.z)));
  }
  workgroupBarrier();
  if (li == 0u) { atomicMin(&acc[0], atomicLoad(&wmin)); atomicMax(&acc[1], atomicLoad(&wmax)); }
}

// cv2.normalize(img, None, 0, 255, NORM_MINMAX): (x - min) * 255 / (max - min), rounded half to even
@compute @workgroup_size(WG)
fn normalize(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let i = pixel_index(gid, nwg);
  if (i >= P.n) { return; }
  let lo = f32(aux[0]); let hi = f32(aux[1]);
  let scale = select(0.0, 255.0 / (hi - lo), hi > lo);
  let c = vec3<f32>(unpack(src[i]));
  let v = clamp(round(c * scale - lo * scale), vec3<f32>(0.0), vec3<f32>(255.0));
  dst[i] = rgba(u32(v.x), u32(v.y), u32(v.z));
}

// cv2.calcHist([img], [c], mask, [256], [0, 256]) for every channel c at once:
// acc[c * 256 + v], with CHANNELS = 1 for a grey image. Workgroup histograms first, then one atomicAdd per bin.
var<workgroup> wh: array<atomic<u32>, 768>;
@compute @workgroup_size(WG)
fn histogram(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  for (var k = li; k < 768u; k += WG) { atomicStore(&wh[k], 0u); }
  workgroupBarrier();
  let i = pixel_index(gid, nwg);
  if (i < P.n && (!MASKED || in_mask(i))) {
    var c: vec3<u32>;
    if (FROM_BGR) { let b = bgr(i); c = vec3<u32>(b.x, b.y, b.z); }  // channel 0 is B, as in OpenCV
    else { let r = unpack(src[i]); c = vec3<u32>(r.z, r.y, r.x); }   // back to B, G, R order
    if (CHANNELS == 1u) { atomicAdd(&wh[c.z], 1u); }                  // grey: r = g = b
    else { atomicAdd(&wh[c.x], 1u); atomicAdd(&wh[256u + c.y], 1u); atomicAdd(&wh[512u + c.z], 1u); }
  }
  workgroupBarrier();
  for (var k = li; k < 256u * CHANNELS; k += WG) {
    let v = atomicLoad(&wh[k]);
    if (v != 0u) { atomicAdd(&acc[k], v); }
  }
}

// ---------------------------------------------------------------- lab 8 --
// cv2.cvtColor(img, COLOR_BGR2GRAY): OpenCV's fixed-point weights 0.299 R + 0.587 G + 0.114 B, 15-bit
@compute @workgroup_size(WG)
fn gray(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let i = pixel_index(gid, nwg);
  if (i >= P.n) { return; }
  let c = bgr(i);
  let v = (c.x * 3735u + c.y * 19235u + c.z * 9798u + 16384u) >> 15u;
  dst[i] = rgba(v, v, v);
}

// THRESH_OTSU: OpenCV's getThreshVal_Otsu_8u over the 256-bin grey histogram in `aux`, in f32.
// One invocation; it writes the threshold to dst[0].
@compute @workgroup_size(1)
fn otsu() {
  let scale = 1.0 / f32(P.n);
  var mu = 0.0;
  for (var i = 0u; i < 256u; i++) { mu += f32(i) * f32(aux[i]); }
  mu *= scale;
  var q1 = 0.0; var mu1 = 0.0; var max_sigma = 0.0; var max_val = 0u;
  let eps = 1.1920929e-7;
  for (var i = 0u; i < 256u; i++) {
    let p_i = f32(aux[i]) * scale;
    mu1 *= q1;
    q1 += p_i;
    let q2 = 1.0 - q1;
    if (min(q1, q2) < eps || max(q1, q2) > 1.0 - eps) { continue; }
    mu1 = (mu1 + f32(i) * p_i) / q1;
    let mu2 = (mu - q1 * mu1) / q2;
    let sigma = q1 * q2 * (mu1 - mu2) * (mu1 - mu2);
    if (sigma > max_sigma) { max_sigma = sigma; max_val = i; }
  }
  dst[0] = max_val;
}

// THRESH_BINARY_INV with the Otsu threshold in aux[0]: 0 above it, 255 at or below
@compute @workgroup_size(WG)
fn binary_inv(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let i = pixel_index(gid, nwg);
  if (i >= P.n) { return; }
  let v = select(255u, 0u, (src[i] & 255u) > aux[0]);
  dst[i] = rgba(v, v, v);
}

// k-means, k = 2, on the RGB colours (Lloyd's algorithm). State in `acc`:
// [0..2] channel minima, [3..5] maxima (the starting centres), [8..15] per-cluster sums (r, g, b, count),
// [16] done flag. Centres live in fdst[0..5] as (r, g, b) x 2.
var<workgroup> wsum: array<atomic<u32>, 8>;
var<workgroup> wb: array<atomic<u32>, 6>;
var<workgroup> wdone: u32;
@compute @workgroup_size(WG)
fn km_bounds(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li < 3u) { atomicStore(&wb[li], 255u); } else if (li < 6u) { atomicStore(&wb[li], 0u); }
  workgroupBarrier();
  let i = pixel_index(gid, nwg);
  if (i < P.n) {
    let c = bgr(i);
    atomicMin(&wb[0], c.z); atomicMin(&wb[1], c.y); atomicMin(&wb[2], c.x);
    atomicMax(&wb[3], c.z); atomicMax(&wb[4], c.y); atomicMax(&wb[5], c.x);
  }
  workgroupBarrier();
  if (li < 3u) { atomicMin(&acc[li], atomicLoad(&wb[li])); } else if (li < 6u) { atomicMax(&acc[li], atomicLoad(&wb[li])); }
}

@compute @workgroup_size(1)
fn km_init() {
  _ = P.n;  // every kernel binds the uniform at 0
  for (var c = 0u; c < 3u; c++) { fdst[c] = f32(atomicLoad(&acc[c])); fdst[3u + c] = f32(atomicLoad(&acc[3u + c])); }
}

fn nearest(c: vec3<f32>) -> u32 {
  let d0 = c - vec3<f32>(fdst[0], fdst[1], fdst[2]);
  let d1 = c - vec3<f32>(fdst[3], fdst[4], fdst[5]);
  return select(0u, 1u, dot(d1, d1) < dot(d0, d0));
}
// assignment step: label every pixel with its nearest centre and add it to that cluster's sums
@compute @workgroup_size(WG)
fn km_assign(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { wdone = atomicLoad(&acc[16]); }
  if (workgroupUniformLoad(&wdone) != 0u) { return; }  // converged in an earlier iteration
  if (li < 8u) { atomicStore(&wsum[li], 0u); }
  workgroupBarrier();
  let i = pixel_index(gid, nwg);
  if (i < P.n) {
    let b = bgr(i);
    let c = vec3<u32>(b.z, b.y, b.x);
    let k = nearest(vec3<f32>(c));
    dst[i] = k;
    atomicAdd(&wsum[k * 4u], c.x); atomicAdd(&wsum[k * 4u + 1u], c.y); atomicAdd(&wsum[k * 4u + 2u], c.z); atomicAdd(&wsum[k * 4u + 3u], 1u);
  }
  workgroupBarrier();
  if (li < 8u) { atomicAdd(&acc[8u + li], atomicLoad(&wsum[li])); }
}
// update step: centres = cluster means; stop once no centre moves by more than criteria eps = 1
@compute @workgroup_size(1)
fn km_update() {
  _ = P.n;
  if (atomicLoad(&acc[16]) != 0u) { return; }
  var shift = 0.0;
  for (var k = 0u; k < 2u; k++) {
    let n = atomicLoad(&acc[8u + k * 4u + 3u]);
    if (n == 0u) { continue; }
    var d = 0.0;
    for (var c = 0u; c < 3u; c++) {
      let m = f32(atomicLoad(&acc[8u + k * 4u + c])) / f32(n);
      d += (m - fdst[k * 3u + c]) * (m - fdst[k * 3u + c]);
      fdst[k * 3u + c] = m;
    }
    shift = max(shift, d);
  }
  for (var j = 8u; j < 16u; j++) { atomicStore(&acc[j], 0u); }
  if (shift <= 1.0) { atomicStore(&acc[16], 1u); }
}
// center[label] with the centres cast to uint8 (np.uint8 truncates)
@compute @workgroup_size(WG)
fn km_paint(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let i = pixel_index(gid, nwg);
  if (i >= P.n) { return; }
  let k = aux[i] * 3u;
  dst[i] = rgba(u32(fdst[k]), u32(fdst[k + 1u]), u32(fdst[k + 2u]));
}

// robert: ndimage.convolve with [[1, 0], [0, -1]] and [[0, 1], [-1, 0]] (mode 'reflect', which for a
// 2x2 kernel repeats the last row and column), then sqrt(h^2 + v^2) * 255 on the grey image / 255
fn g01(x: u32, y: u32) -> f32 { return f32(src[min(y, P.h - 1u) * P.w + min(x, P.w - 1u)] & 255u) / 255.0; }
@compute @workgroup_size(WG)
fn robert(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let i = pixel_index(gid, nwg);
  if (i >= P.n) { return; }
  let y = i / P.w; let x = i % P.w;
  let vertical = g01(x + 1u, y + 1u) - g01(x, y);
  let horizontal = g01(x, y + 1u) - g01(x + 1u, y);
  fdst[i] = sqrt(horizontal * horizontal + vertical * vertical) * 255.0;
}

// min and max of the magnitudes: non-negative floats order like their bit patterns
@compute @workgroup_size(WG)
fn f_min_max(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&wmin, 0xffffffffu); atomicStore(&wmax, 0u); }
  workgroupBarrier();
  let i = pixel_index(gid, nwg);
  if (i < P.n) { let b = bitcast<u32>(fdst[i]); atomicMin(&wmin, b); atomicMax(&wmax, b); }
  workgroupBarrier();
  if (li == 0u) { atomicMin(&acc[0], atomicLoad(&wmin)); atomicMax(&acc[1], atomicLoad(&wmax)); }
}

// plt.imshow(float, 'gray') scaling, as the page does it: uint8(clip((m - lo) / (hi - lo) * 255, 0, 255))
@compute @workgroup_size(WG)
fn f_display(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let i = pixel_index(gid, nwg);
  if (i >= P.n) { return; }
  let lo = bitcast<f32>(aux[0]); let hi = bitcast<f32>(aux[1]);
  let span = select(1.0, hi - lo, hi - lo != 0.0);
  let v = u32(clamp((fdst[i] - lo) / span * 255.0, 0.0, 255.0));
  dst[i] = rgba(v, v, v);
}
