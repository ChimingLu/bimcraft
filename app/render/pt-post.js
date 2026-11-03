/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-post.js — the path tracer's post and colour (0.7 RN.8; RENDER-SPEC § 2, § 7). No DOM; imports pt-spec.js and lib/exr's
 * .cube reader (`../exr/cube.js`, the app's copy). Everything runs on the linear picture the kernels leave (AP1 means), so every
 * control can change after the render, as often as wanted, with no new render.
 *
 *   POST_DEFAULTS, VIEWS ('aces' | 'agx' | 'filmic' | 'standard'), cleanPost(o) → settings.post (untrusted)
 *   isPlainPost(post) → true when nothing but the view transform runs (bloom, glare, vignette, LUT, contrast, highlights all off)
 *   post(lin, w, h, post, {exposure, wb, lut, float}) → Uint8ClampedArray RGBA   lin = Float32Array w·h·3 (AP1 linear means);
 *                         float: true → Float32Array w·h·3 of the display values in [0, 1] instead (16-bit PNG, RN.9)
 *   viewTransform(kind, rgb709) → display-linear [0, 1]³ (before the sRGB encoding)
 *   bloomPass(img, w, h, amount, size), glarePass(img, w, h, amount, streaks) → Float32Array   the image-wide passes (linear Rec.709)
 *
 * Order (per pixel, after the image-wide passes): AP1 × white balance → linear Rec.709 × 2^exposure → bloom (energy-preserving:
 * the picture blended with a wide blur of itself) and glare (streaks from what is brighter than display white) → vignette →
 * highlight compression (a soft knee above 1) → contrast (a power about 18 % grey) → view transform → sRGB → the LUT (on the
 * sRGB-encoded 0–1 values, the domain .cube files are made for) → 8 bits. With the defaults (ACES, nothing else) this is exactly
 * pt-spec.js displayPixel, so every older picture stays the same.
 *
 * View transforms: 'aces' = the ACES filmic fit three.js uses (pt-spec.js acesFilmic, the default since RN.1); 'agx' = AgX (Troy
 * Sobotka) with Benjamin Wrensch's polynomial fit of its sigmoid, as three.js's AgXToneMapping (MIT) writes it — Rec.2020 inset
 * and outset matrices, log2 encoding over [−12.47393, 4.026069] stops, a 2.2 power back; 'filmic' = John Hable's curve (the
 * "Uncharted 2" operator from his GDC 2010 talk: A 0.15, B 0.50, C 0.10, D 0.20, E 0.02, F 0.30, white 11.2, bias 2); 'standard'
 * = linear clipped at 1 (what a camera's plain sRGB would show).
 */
import { AP1_TO_REC709, mul3, linearToSrgb, acesFilmic } from './pt-spec.js';
import { applyCube } from '../exr/cube.js';

export const VIEWS = ['aces', 'agx', 'filmic', 'standard'];
export const STREAKS = [4, 6, 8];
export const POST_DEFAULTS = Object.freeze({ view: 'aces', contrast: 0, highlights: 0, bloom: 0, bloomSize: 0.02, glare: 0, streaks: 6, vignette: 0, lutName: '', lutStrength: 1 });

const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
export function cleanPost(o) {
  o = o && typeof o === 'object' ? o : {};
  return {
    view: VIEWS.includes(o.view) ? o.view : 'aces',
    contrast: Math.round(num(o.contrast, -0.5, 0.5, 0) * 100) / 100,
    highlights: Math.round(num(o.highlights, 0, 1, 0) * 100) / 100,
    bloom: Math.round(num(o.bloom, 0, 1, 0) * 100) / 100,
    bloomSize: Math.round(num(o.bloomSize, 0.005, 0.1, 0.02) * 1000) / 1000,
    glare: Math.round(num(o.glare, 0, 1, 0) * 100) / 100,
    streaks: STREAKS.includes(o.streaks) ? o.streaks : 6,
    vignette: Math.round(num(o.vignette, 0, 1, 0) * 100) / 100,
    lutName: typeof o.lutName === 'string' ? o.lutName.replace(/[\u0000-\u001f]/g, '').slice(0, 120) : '',
    lutStrength: Math.round(num(o.lutStrength, 0, 1, 1) * 100) / 100,
  };
}
export const isPlainPost = (p) => !p || (!p.contrast && !p.highlights && !p.bloom && !p.glare && !p.vignette && !p.lutName);

// ---- view transforms ----
const R709_TO_2020 = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0113], [0.0164, 0.088, 0.8956]];
const R2020_TO_709 = [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]];
const AGX_INSET = [[0.856627153315983, 0.0951212405381588, 0.0482516061458583], [0.137318972929847, 0.761241990602591, 0.101439036467562], [0.11189821299995, 0.0767994186031903, 0.811302368396859]];
const AGX_OUTSET = [[1.1271005818144368, -0.11060664309660323, -0.016493938717834573], [-0.1413297634984383, 1.157823702216272, -0.016493938717834257], [-0.14132976349843826, -0.11060664309660294, 1.2519364065950405]];
const AGX_MIN = -12.47393, AGX_MAX = 4.026069;
const agxCurve = (x) => { const x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; };
const hable = (x) => ((x * (0.15 * x + 0.1 * 0.5) + 0.2 * 0.02) / (x * (0.15 * x + 0.5) + 0.2 * 0.3)) - 0.02 / 0.3;
const HABLE_W = hable(11.2);
export function viewTransform(kind, c) {
  if (kind === 'agx') {
    let v = mul3(AGX_INSET, mul3(R709_TO_2020, c));
    v = v.map((x) => Math.min(1, Math.max(0, (Math.log2(Math.max(x, 1e-10)) - AGX_MIN) / (AGX_MAX - AGX_MIN)))).map(agxCurve);
    v = mul3(AGX_OUTSET, v).map((x) => Math.pow(Math.max(0, x), 2.2));
    return mul3(R2020_TO_709, v).map((x) => Math.min(1, Math.max(0, x)));
  }
  if (kind === 'filmic') return c.map((x) => Math.min(1, Math.max(0, hable(2 * Math.max(0, x)) / HABLE_W)));
  if (kind === 'standard') return c.map((x) => Math.min(1, Math.max(0, x)));
  return acesFilmic(c, 0);
}

// ---- image-wide passes on linear Rec.709 (Float32Array w·h·3) ----
/** Three box blurs per axis ≈ a Gaussian of standard deviation σ (pixels); edges clamp. */
function blur(src, w, h, sigma) {
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  const pass = (from, to, horiz) => {
    const n = horiz ? w : h, m = horiz ? h : w, inv = 1 / (2 * r + 1);
    for (let j = 0; j < m; j++) for (let c = 0; c < 3; c++) {
      const at = (i) => (horiz ? (j * w + Math.min(n - 1, Math.max(0, i))) : (Math.min(n - 1, Math.max(0, i)) * w + j)) * 3 + c;
      let s = 0;
      for (let i = -r; i <= r; i++) s += from[at(i)];
      for (let i = 0; i < n; i++) { to[at(i)] = s * inv; s += from[at(i + r + 1)] - from[at(i - r)]; }
    }
  };
  for (let k = 0; k < 3; k++) { pass(a, b, true); [a, b] = [b, a]; }
  for (let k = 0; k < 3; k++) { pass(a, b, false); [a, b] = [b, a]; }
  return a;
}
export function bloomPass(img, w, h, amount, size) {
  const d = Math.hypot(w, h) * size, out = new Float32Array(img.length);
  const blurs = [[d, 0.5], [d * 2, 0.3], [d * 4, 0.2]].map(([s, wt]) => [blur(img, w, h, s), wt]);
  for (let i = 0; i < img.length; i++) { let b = 0; for (const [bl, wt] of blurs) b += bl[i] * wt; out[i] = img[i] * (1 - amount) + b * amount; }
  return out;
}
export function glarePass(img, w, h, amount, streaks) {
  // streaks from what is brighter than display white, smeared along `streaks` directions with an exponential fall-off
  const src = new Float32Array(img.length);
  for (let i = 0; i < img.length; i++) src[i] = Math.max(0, img[i] - 1);
  const add = new Float32Array(img.length), L = Math.max(8, Math.round(Math.hypot(w, h) * 0.08));
  for (let k = 0; k < streaks; k++) {
    const a = (Math.PI * k) / streaks + Math.PI / 4, dx = Math.cos(a), dy = Math.sin(a);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      if (!(src[o] > 0 || src[o + 1] > 0 || src[o + 2] > 0)) continue;
      for (const sgn of [1, -1]) for (let t = 1; t < L; t++) {
        const xi = Math.round(x + sgn * dx * t), yi = Math.round(y + sgn * dy * t);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) break;
        const f = Math.exp((-4 * t) / L) / L, q = (yi * w + xi) * 3;
        add[q] += src[o] * f; add[q + 1] += src[o + 1] * f; add[q + 2] += src[o + 2] * f;
      }
    }
  }
  const out = Float32Array.from(img);
  for (let i = 0; i < img.length; i++) out[i] += (add[i] * amount * 4) / streaks;
  return out;
}

export function post(lin, w, h, p, { exposure = 0, wb = null, lut = null, float = false } = {}) {
  p = p || POST_DEFAULTS;
  const n = w * h, k = Math.pow(2, exposure);
  let img = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = [lin[i * 3] * (wb ? wb[0] : 1), lin[i * 3 + 1] * (wb ? wb[1] : 1), lin[i * 3 + 2] * (wb ? wb[2] : 1)];
    const c = mul3(AP1_TO_REC709, a);
    for (let j = 0; j < 3; j++) img[i * 3 + j] = Number.isFinite(c[j]) ? Math.max(0, c[j]) * k : 0;
  }
  if (p.bloom > 0) img = bloomPass(img, w, h, p.bloom, p.bloomSize);
  if (p.glare > 0) img = glarePass(img, w, h, p.glare, p.streaks);
  const out = float ? new Float32Array(n * 3) : new Uint8ClampedArray(n * 4), cx = (w - 1) / 2, cy = (h - 1) / 2, rmax = Math.hypot(cx, cy) || 1, px = [0, 0, 0], lo = [0, 0, 0];
  const knee = 1, hs = p.highlights * 2;
  for (let i = 0; i < n; i++) {
    px[0] = img[i * 3]; px[1] = img[i * 3 + 1]; px[2] = img[i * 3 + 2];
    if (p.vignette > 0) {
      const r = Math.hypot((i % w) - cx, Math.floor(i / w) - cy) / rmax, t = Math.min(1, Math.max(0, (r - 0.2) / 0.8)), f = 1 - p.vignette * t * t * (3 - 2 * t);
      px[0] *= f; px[1] *= f; px[2] *= f;
    }
    if (hs > 0) {
      const L = 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2];
      if (L > knee) { const L2 = knee + (L - knee) / (1 + (L - knee) * hs), s = L2 / L; px[0] *= s; px[1] *= s; px[2] *= s; }
    }
    if (p.contrast) for (let j = 0; j < 3; j++) px[j] = 0.18 * Math.pow(px[j] / 0.18, 1 + p.contrast);
    // ACES keeps its own 1/0.6 pre-scale (acesFilmic), so the default path is displayPixel's, number for number
    const t = p.view === 'aces' ? acesFilmic(px, 0) : viewTransform(p.view, px);
    let r = linearToSrgb(t[0]), g = linearToSrgb(t[1]), b = linearToSrgb(t[2]);
    if (lut && p.lutStrength > 0) {
      applyCube(lut, r, g, b, lo);
      const s = p.lutStrength;
      r += (lo[0] - r) * s; g += (lo[1] - g) * s; b += (lo[2] - b) * s;
    }
    if (float) { out[i * 3] = Math.min(1, Math.max(0, r)); out[i * 3 + 1] = Math.min(1, Math.max(0, g)); out[i * 3 + 2] = Math.min(1, Math.max(0, b)); continue; }
    out[i * 4] = Math.round(Math.min(1, Math.max(0, r)) * 255); out[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255); out[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255); out[i * 4 + 3] = 255;
  }
  return out;
}
