/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-denoise.js — the path tracer's denoiser (0.7 RN.5; docs/spikes/RN.5-denoiser.md): Intel Open Image Denoise's published
 * network weights (Apache-2.0, unmodified in assets/vendor/oidn-weights/) run by our own code. This file is the CPU path and
 * everything the GPU path (pt-denoise-gpu.js) shares: reading the weights, the input and output steps, the tiles. No DOM.
 *
 *   WEIGHTS_SPEC = 'oidn-weights' (the import-map key; the file is fetched from import.meta.resolve of it)
 *   readTza(bytes) → net {tensors: {name: {dims, data: Float32Array}}, small: bool}   untrusted: every size checked
 *   prepare(rgb, alb, nrm, w, h) → {input: Float32Array 9·w·h (channel-major), scale}   the network's input: colour × the
 *     auto-exposure scale through the PU curve normalised to 65 504, albedo clamped to [0, 1], normals mapped to [0, 1]
 *   finish(out3, w, h, scale) → Float32Array w·h·3   the inverse curve ÷ the scale (linear, the colour's own units)
 *   unet(net, x) → y   the U-Net on one tensor {c, h, w, d} whose h and w are multiples of 16
 *   tilesFor(w, h, core = 256, overlap = 96) → [{x0, y0, x1, y1 (the tile read), cx0, cy0, cx1, cy1 (the part kept)}]
 *   denoiseCpu(net, rgb, alb, nrm, w, h, {signal, onProgress}) → Float32Array w·h·3 (linear)   one thread (tests, tiny pictures)
 *   denoisePool(pool, weightBytes, rgb, alb, nrm, w, h, {signal, onProgress}) → the same on every core (pt-denoise-job.js)
 *   loadNet() / loadWeights() → the network / the weights' bytes, fetched once per page
 *
 * The network (core/unet_filter.cpp's small/base U-Net): enc_conv0 → (conv, 2 × 2 max pool) × 4 → enc_conv5a, 5b → (2 ×
 * nearest upsampling, concatenation with the encoder's pooled output of that size, two convolutions) × 4 → dec_conv0; every
 * convolution 3 × 3 with zero padding, bias and ReLU. The tiles overlap by the network's reach (96 pixels) and each keeps only
 * its middle, so a tiled picture equals an untiled one to rounding. Auto-exposure (key 0.18 over 16 × 16 bins) is the whole
 * picture's, not a tile's.
 */
import { halfToFloat } from '../exr/util.js';

export const WEIGHTS_SPEC = 'oidn-weights';
const PU = { a: 1.41283765e+03, b: 1.64593172e+00, c: 4.31384981e-01, d: -2.94139609e-03, e: 1.92653254e-01, f: 6.26026094e-03, g: 9.98620152e-01, y0: 1.57945760e-06, y1: 3.22087631e-02, x0: 2.23151711e-03, x1: 3.70974749e-01 };
export const puForward = (y) => (y <= PU.y0 ? PU.a * y : y <= PU.y1 ? PU.b * Math.pow(y, PU.c) + PU.d : PU.e * Math.log(y + PU.f) + PU.g);
export const puInverse = (x) => (x <= PU.x0 ? x / PU.a : x <= PU.x1 ? Math.pow((x - PU.d) / PU.b, 1 / PU.c) : Math.exp((x - PU.g) / PU.e) - PU.f);
export const PU_NORM = 1 / puForward(65504);
export const LAYERS = ['enc_conv0', 'enc_conv1', 'enc_conv2', 'enc_conv3', 'enc_conv4', 'enc_conv5a', 'enc_conv5b', 'dec_conv4a', 'dec_conv4b',
  'dec_conv3a', 'dec_conv3b', 'dec_conv2a', 'dec_conv2b', 'dec_conv1a', 'dec_conv1b', 'dec_conv0'];

export function readTza(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const bad = (why) => { throw Object.assign(new Error('weights: ' + why), { code: 'bad_weights' }); };   // i18n-ignore: caught by the caller
  if (b.length < 16 || v.getUint16(0, true) !== 0x41d7) bad('not a TZA file');   // i18n-ignore: weights-file check, caught by the caller (code bad_weights)
  if (b[2] !== 2) bad('version ' + b[2]);
  let o = Number(v.getBigUint64(4, true));
  if (!(o + 4 <= b.length)) bad('table');
  const n = v.getUint32(o, true); o += 4;
  if (n > 256) bad('too many tensors');   // i18n-ignore: weights-file check, caught by the caller (code bad_weights)
  const tensors = {};
  for (let i = 0; i < n; i++) {
    if (o + 3 > b.length) bad('table cut short');   // i18n-ignore: weights-file check, caught by the caller (code bad_weights)
    const nl = v.getUint16(o, true); o += 2;
    if (o + nl + 1 > b.length || nl > 128) bad('name');
    const name = new TextDecoder().decode(b.subarray(o, o + nl)); o += nl;
    const nd = b[o]; o += 1;
    if (nd < 1 || nd > 4 || o + nd * 5 + 9 > b.length) bad('dims');
    const dims = []; for (let j = 0; j < nd; j++) { const d = v.getUint32(o, true); o += 4; if (d < 1 || d > 4096) bad('dim'); dims.push(d); }
    o += nd;
    const dt = String.fromCharCode(b[o]); o += 1;
    const off = Number(v.getBigUint64(o, true)); o += 8;
    const count = dims.reduce((a, x) => a * x, 1), size = dt === 'h' ? 2 : dt === 'f' ? 4 : bad('type');
    if (count > 1 << 22 || off + count * size > b.length) bad('data');
    const data = new Float32Array(count);
    for (let k = 0; k < count; k++) data[k] = dt === 'h' ? halfToFloat(v.getUint16(off + k * 2, true)) : v.getFloat32(off + k * 4, true);
    tensors[name] = { dims, data };
  }
  for (const L of LAYERS) if (!tensors[L + '.weight'] || !tensors[L + '.bias'] || tensors[L + '.weight'].dims.length !== 4) bad('missing ' + L);
  if (tensors['enc_conv0.weight'].dims[1] !== 9 || tensors['dec_conv0.weight'].dims[0] !== 3) bad('not a colour + albedo + normal network');   // i18n-ignore: weights-file check, caught by the caller (code bad_weights)
  return { tensors, small: tensors['enc_conv0.weight'].dims[0] === 32 && tensors['dec_conv4a.weight'].dims[0] === 64 };
}

/** Key 0.18 ÷ the log-average luminance of the picture in 16 × 16-pixel bins (Rec.709 weights, as the network was trained). */
export function autoexposure(rgb, w, h) {
  const nbH = Math.ceil(h / 16), nbW = Math.ceil(w / 16);
  let s = 0, n = 0;
  for (let i = 0; i < nbH; i++) for (let j = 0; j < nbW; j++) {
    const h0 = Math.floor((i * h) / nbH), h1 = Math.floor(((i + 1) * h) / nbH), w0 = Math.floor((j * w) / nbW), w1 = Math.floor(((j + 1) * w) / nbW);
    let L = 0;
    for (let y = h0; y < h1; y++) for (let x = w0; x < w1; x++) { const o = (y * w + x) * 3; L += 0.212671 * Math.max(0, rgb[o] || 0) + 0.71516 * Math.max(0, rgb[o + 1] || 0) + 0.072169 * Math.max(0, rgb[o + 2] || 0); }
    L /= Math.max(1, (h1 - h0) * (w1 - w0));
    if (L > 1e-8) { s += Math.log2(L); n++; }
  }
  return n ? 0.18 / Math.pow(2, s / n) : 1;
}

export function prepare(rgb, alb, nrm, w, h, scale = autoexposure(rgb, w, h)) {
  const N = w * h, input = new Float32Array(9 * N);
  const fin = (x) => (Number.isFinite(x) ? x : 0);
  for (let p = 0; p < N; p++) for (let k = 0; k < 3; k++) {
    input[k * N + p] = puForward(Math.min(65504, Math.max(0, fin(rgb[p * 3 + k]) * scale))) * PU_NORM;
    input[(3 + k) * N + p] = Math.min(1, Math.max(0, fin(alb[p * 3 + k])));
    input[(6 + k) * N + p] = Math.min(1, Math.max(-1, fin(nrm[p * 3 + k]))) * 0.5 + 0.5;
  }
  return { input, scale };
}
export function finish(out3, w, h, scale) {
  const N = w * h, res = new Float32Array(N * 3), inv = scale > 0 ? 1 / scale : 0;
  for (let p = 0; p < N; p++) for (let k = 0; k < 3; k++) { const x = out3[k * N + p]; res[p * 3 + k] = puInverse(Number.isFinite(x) ? Math.max(0, x) / PU_NORM : 0) * inv; }
  return res;
}

// ---- the network on the CPU ----
const tensor = (c, h, w) => ({ c, h, w, d: new Float32Array(c * h * w) });
function conv(x, W, B) {
  const [O, I] = W.dims, H = x.h, Wd = x.w, y = tensor(O, H, Wd), wd = W.data, bd = B.data, xd = x.d, yd = y.d, plane = H * Wd;
  for (let o = 0; o < O; o++) {
    const yo = o * plane;
    yd.fill(bd[o], yo, yo + plane);
    for (let i = 0; i < I; i++) {
      const xi = i * plane, wo = (o * I + i) * 9;
      for (let ky = 0; ky < 3; ky++) for (let kx = 0; kx < 3; kx++) {
        const k = wd[wo + ky * 3 + kx];
        if (k === 0) continue;
        const dy = ky - 1, dx = kx - 1, y0 = Math.max(0, -dy), y1 = Math.min(H, H - dy), x0 = Math.max(0, -dx), x1 = Math.min(Wd, Wd - dx);
        for (let yy = y0; yy < y1; yy++) {
          const row = yo + yy * Wd, src = xi + (yy + dy) * Wd + dx;
          for (let xx = x0; xx < x1; xx++) yd[row + xx] += k * xd[src + xx];
        }
      }
    }
    for (let p = yo; p < yo + plane; p++) if (yd[p] < 0) yd[p] = 0;
  }
  return y;
}
function pool(x) {
  const y = tensor(x.c, x.h >> 1, x.w >> 1);
  for (let c = 0; c < x.c; c++) for (let yy = 0; yy < y.h; yy++) for (let xx = 0; xx < y.w; xx++) {
    const s = c * x.h * x.w + yy * 2 * x.w + xx * 2;
    y.d[c * y.h * y.w + yy * y.w + xx] = Math.max(x.d[s], x.d[s + 1], x.d[s + x.w], x.d[s + x.w + 1]);
  }
  return y;
}
function upConcat(x, skip) {
  const y = tensor(x.c + skip.c, skip.h, skip.w);
  for (let c = 0; c < x.c; c++) for (let yy = 0; yy < skip.h; yy++) for (let xx = 0; xx < skip.w; xx++) y.d[c * skip.h * skip.w + yy * skip.w + xx] = x.d[c * x.h * x.w + (yy >> 1) * x.w + (xx >> 1)];
  y.d.set(skip.d, x.c * skip.h * skip.w);
  return y;
}
export function unet(net, inp) {
  const T = net.tensors, C = (name, x) => conv(x, T[name + '.weight'], T[name + '.bias']);
  let x = C('enc_conv0', inp);
  const p1 = x = pool(C('enc_conv1', x));
  const p2 = x = pool(C('enc_conv2', x));
  const p3 = x = pool(C('enc_conv3', x));
  const p4 = pool(C('enc_conv4', x));
  x = C('enc_conv5b', C('enc_conv5a', p4));
  x = C('dec_conv4b', C('dec_conv4a', upConcat(x, p3)));
  x = C('dec_conv3b', C('dec_conv3a', upConcat(x, p2)));
  x = C('dec_conv2b', C('dec_conv2a', upConcat(x, p1)));
  x = C('dec_conv1b', C('dec_conv1a', upConcat(x, inp)));
  return C('dec_conv0', x);
}

/** Tiles of at most `core` kept pixels, read with `overlap` around (clamped to the picture), each read size a multiple of 16. */
export function tilesFor(w, h, core = 256, overlap = 96) {
  const out = [];
  for (let cy0 = 0; cy0 < h; cy0 += core) for (let cx0 = 0; cx0 < w; cx0 += core) {
    const cx1 = Math.min(w, cx0 + core), cy1 = Math.min(h, cy0 + core);
    const x0 = Math.max(0, cx0 - overlap), y0 = Math.max(0, cy0 - overlap), x1 = Math.min(w, cx1 + overlap), y1 = Math.min(h, cy1 + overlap);
    out.push({ x0, y0, x1, y1, cx0, cy0, cx1, cy1 });
  }
  return out;
}
/** One tile's input (zero-padded to multiples of 16) from the whole picture's prepared input. */
export function tileInput(input, w, h, t) {
  const tw = t.x1 - t.x0, th = t.y1 - t.y0, W16 = Math.ceil(tw / 16) * 16, H16 = Math.ceil(th / 16) * 16, x = tensor(9, H16, W16), N = w * h;
  for (let c = 0; c < 9; c++) for (let yy = 0; yy < th; yy++) x.d.set(input.subarray(c * N + (t.y0 + yy) * w + t.x0, c * N + (t.y0 + yy) * w + t.x1), c * H16 * W16 + yy * W16);
  return x;
}
/** Put a tile's kept part of the 3-channel output into the whole picture's (channel-major) output. */
export function placeTile(out3, w, h, t, y, W16, H16) {
  const N = w * h;
  for (let c = 0; c < 3; c++) for (let yy = t.cy0; yy < t.cy1; yy++) for (let xx = t.cx0; xx < t.cx1; xx++) out3[c * N + yy * w + xx] = y[c * H16 * W16 + (yy - t.y0) * W16 + (xx - t.x0)];
}

export async function denoiseCpu(net, rgb, alb, nrm, w, h, { signal = null, onProgress = null, core = 256, overlap = 96 } = {}) {
  const { input, scale } = prepare(rgb, alb, nrm, w, h), out3 = new Float32Array(3 * w * h), tiles = tilesFor(w, h, core, overlap);
  for (let i = 0; i < tiles.length; i++) {
    if (signal?.aborted) throw Object.assign(new Error('stopped'), { code: 'cancelled' });   // i18n-ignore: caught by the caller
    const x = tileInput(input, w, h, tiles[i]), y = unet(net, x);
    placeTile(out3, w, h, tiles[i], y.d, x.w, x.h);
    onProgress?.((i + 1) / tiles.length);
    await null;
  }
  return finish(out3, w, h, scale);
}

/**
 * The same on every core (compute's page pool; the CPU path when the page has no WebGPU): the tiles go out together, the pool
 * runs them on cores − 1 workers. `bytes` = the weights file (shared once with every worker).
 */
export async function denoisePool(pool, bytes, rgb, alb, nrm, w, h, { signal = null, onProgress = null, core = 256, overlap = 96 } = {}) {
  const { input, scale } = prepare(rgb, alb, nrm, w, h), out3 = new Float32Array(3 * w * h), tiles = tilesFor(w, h, core, overlap);
  pool.share('pt.oidn', bytes);
  const job = new URL('./pt-denoise-job.js', import.meta.url).href;
  let done = 0;
  await Promise.all(tiles.map(async (t) => {
    const x = tileInput(input, w, h, t);
    const r = await pool.run(job, 'tile', { input: x.d, h: x.h, w: x.w }, { transfer: [x.d.buffer], signal, priority: 5 });
    placeTile(out3, w, h, t, r.out, x.w, x.h);
    onProgress?.(++done / tiles.length);
  }));
  return finish(out3, w, h, scale);
}

/** The weights file's URL: the app's import map entry (pinned per release), else the vendor folder next to the apps. */
export function weightsUrl() {
  try { return import.meta.resolve(WEIGHTS_SPEC); } catch { return new URL('../../../../vendor/oidn-weights/current/rt_hdr_alb_nrm_small.tza', import.meta.url).href; }
}
let bytesP = null, netP = null;
/** The weights' bytes, fetched once per page. */
export function loadWeights(fetchFn = globalThis.fetch) {
  bytesP ||= fetchFn(weightsUrl()).then((r) => { if (!r.ok) throw Object.assign(new Error('weights ' + r.status), { code: 'no_weights' }); return r.arrayBuffer(); }).then((b) => new Uint8Array(b)).catch((e) => { bytesP = null; throw e; });   // i18n-ignore: caught by the caller
  return bytesP;
}
/** The network, read once per page. */
export function loadNet(fetchFn = globalThis.fetch) {
  netP ||= loadWeights(fetchFn).then(readTza).catch((e) => { netP = null; throw e; });
  return netP;
}
