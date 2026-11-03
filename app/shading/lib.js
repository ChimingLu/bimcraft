/* SPDX-License-Identifier: Apache-2.0 */
/**
 * shading/lib.js — the maths node materials are made of (0.7 MT.1 / MT.2, session `materials`), twice: as JS functions (the
 * reference bake, shading/bake.js) and as the same functions in WGSL (`WGSL_LIB`, the GPU bake, shading/compile-wgsl.js). The
 * two are written line for line; the hashes are 32-bit integer arithmetic, so lattice values are the same bits on both sides.
 * No DOM. Every pattern here **tiles**: noise lattices wrap at their period, so a graph's tile repeats without a seam.
 *
 *   hash01(x, y, seed) → [0, 1)            pcg of three integers (RENDER-SPEC's pcg), 24 bits
 *   vnoise(x, y, px, py, seed) → [0, 1]    value noise, smoothstep-faded, wrapping every px × py cells
 *   fbm(x, y, px, py, octaves, gain, seed) fractal sum of vnoise (lacunarity 2), normalised to [0, 1]
 *   srgbDecode / srgbEncode (per channel), hexLinear('#rrggbb') → [r, g, b] linear Rec.709, luminance(c)
 *   rgbToHsv / hsvToRgb (in place on [r, g, b]), smooth(t) (the fade)
 *   voronoi(x, y, px, py, randomness, seed, manhattan, out) → out = [F1, F2, cell x, cell y] (MT.2): the nearest and second
 *                                         feature points of a wrapping grid of cells, one jittered point per cell, 3 × 3 search
 *   waveProfile(p, kind) → 0…1             0 sine, 1 saw, 2 triangle (MT.2)
 */
import { pcg } from '../render/pt-spec.js';

export const hash01 = (x, y, seed) => (pcg(((x >>> 0) ^ pcg(((y >>> 0) ^ pcg(seed >>> 0)) >>> 0)) >>> 0) >>> 8) / 16777216;
const wrap = (a, n) => ((a % n) + n) % n;
export const smooth = (t) => t * t * (3 - 2 * t);

export function vnoise(x, y, px, py, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = smooth(x - x0), fy = smooth(y - y0);
  const xa = wrap(x0, px), xb = wrap(x0 + 1, px), ya = wrap(y0, py), yb = wrap(y0 + 1, py);
  const a = hash01(xa, ya, seed), b = hash01(xb, ya, seed), c = hash01(xa, yb, seed), d = hash01(xb, yb, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export function fbm(x, y, px, py, octaves, gain, seed) {
  let s = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    s += amp * vnoise(x * f, y * f, px * f, py * f, (seed + o * 101) >>> 0);
    norm += amp; amp *= gain; f *= 2;
  }
  return norm > 0 ? s / norm : 0;
}

export function voronoi(x, y, px, py, rand, seed, manhattan, out) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 1e9, f2 = 1e9, cx = 0, cy = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const gx = ix + i, gy = iy + j, wx = wrap(gx, px), wy = wrap(gy, py);
    const dx = gx + 0.5 + (hash01(wx, wy, seed) - 0.5) * rand - x, dy = gy + 0.5 + (hash01(wx, wy, (seed + 1) >>> 0) - 0.5) * rand - y;
    const d = manhattan ? Math.abs(dx) + Math.abs(dy) : Math.sqrt(dx * dx + dy * dy);
    if (d < f1) { f2 = f1; f1 = d; cx = wx; cy = wy; } else if (d < f2) f2 = d;
  }
  out[0] = f1; out[1] = f2; out[2] = cx; out[3] = cy;
  return out;
}
export function waveProfile(p, kind) {
  const f = p - Math.floor(p);
  return kind === 1 ? f : kind === 2 ? 1 - Math.abs(2 * f - 1) : 0.5 + 0.5 * Math.sin(2 * Math.PI * p);
}

export const srgbDecode = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const srgbEncode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
export function hexLinear(hex) {
  const h = /^#[0-9a-f]{6}$/i.test(hex || '') ? hex : '#cccccc';
  return [1, 3, 5].map((i) => srgbDecode(parseInt(h.slice(i, i + 2), 16) / 255));
}
export function linearHex(c) {
  const b = (x) => Math.max(0, Math.min(255, Math.floor(srgbEncode(Math.max(0, Math.min(1, x))) * 255 + 0.5))).toString(16).padStart(2, '0');
  return '#' + b(c[0]) + b(c[1]) + b(c[2]);
}
export const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** [r, g, b] (0…1) → [h, s, v] in place (h in turns, 0…1). */
export function rgbToHsv(c) {
  const r = c[0], g = c[1], b = c[2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  c[0] = h; c[1] = mx > 0 ? d / mx : 0; c[2] = mx;
  return c;
}
/** [h, s, v] → [r, g, b] in place. */
export function hsvToRgb(c) {
  const h = (c[0] - Math.floor(c[0])) * 6, s = c[1], v = c[2], i = Math.floor(h), f = h - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  switch (i % 6) {
    case 0: c[0] = v; c[1] = t; c[2] = p; break;
    case 1: c[0] = q; c[1] = v; c[2] = p; break;
    case 2: c[0] = p; c[1] = v; c[2] = t; break;
    case 3: c[0] = p; c[1] = q; c[2] = v; break;
    case 4: c[0] = t; c[1] = p; c[2] = v; break;
    default: c[0] = v; c[1] = p; c[2] = q;
  }
  return c;
}

// The same functions in WGSL (pcg as RENDER-SPEC § 4 and pt-wgsl.js write it).
export const WGSL_LIB = `
fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn hash01(x: i32, y: i32, seed: u32) -> f32 { return f32(pcg(bitcast<u32>(x) ^ pcg(bitcast<u32>(y) ^ pcg(seed))) >> 8u) * (1.0 / 16777216.0); }
fn wrapI(a: i32, n: i32) -> i32 { return ((a % n) + n) % n; }
fn smooth1(t: f32) -> f32 { return t * t * (3.0 - 2.0 * t); }
fn vnoise(x: f32, y: f32, px: i32, py: i32, seed: u32) -> f32 {
  let x0 = floor(x); let y0 = floor(y);
  let fx = smooth1(x - x0); let fy = smooth1(y - y0);
  let ix = i32(x0); let iy = i32(y0);
  let xa = wrapI(ix, px); let xb = wrapI(ix + 1, px); let ya = wrapI(iy, py); let yb = wrapI(iy + 1, py);
  let a = hash01(xa, ya, seed); let b = hash01(xb, ya, seed); let c = hash01(xa, yb, seed); let d = hash01(xb, yb, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
fn fbm(x: f32, y: f32, px: i32, py: i32, octaves: i32, gain: f32, seed: u32) -> f32 {
  var s = 0.0; var amp = 1.0; var norm = 0.0; var f = 1.0; var fi = 1;
  for (var o = 0; o < octaves; o++) {
    s += amp * vnoise(x * f, y * f, px * fi, py * fi, seed + u32(o) * 101u);
    norm += amp; amp *= gain; f *= 2.0; fi *= 2;
  }
  return select(0.0, s / norm, norm > 0.0);
}
fn voronoi(x: f32, y: f32, px: i32, py: i32, rand: f32, seed: u32, manhattan: bool) -> vec4f {
  let ix = i32(floor(x)); let iy = i32(floor(y));
  var f1 = 1e9; var f2 = 1e9; var cx = 0; var cy = 0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let gx = ix + i; let gy = iy + j; let wx = wrapI(gx, px); let wy = wrapI(gy, py);
      let dx = f32(gx) + 0.5 + (hash01(wx, wy, seed) - 0.5) * rand - x;
      let dy = f32(gy) + 0.5 + (hash01(wx, wy, seed + 1u) - 0.5) * rand - y;
      let d = select(sqrt(dx * dx + dy * dy), abs(dx) + abs(dy), manhattan);
      if (d < f1) { f2 = f1; f1 = d; cx = wx; cy = wy; } else if (d < f2) { f2 = d; }
    }
  }
  return vec4f(f1, f2, f32(cx), f32(cy));
}
fn waveProfile(p: f32, kind: i32) -> f32 {
  let f = p - floor(p);
  if (kind == 1) { return f; }
  if (kind == 2) { return 1.0 - abs(2.0 * f - 1.0); }
  return 0.5 + 0.5 * sin(6.283185307179586 * p);
}
fn srgbDecode(c: f32) -> f32 { return select(pow((c + 0.055) / 1.055, 2.4), c / 12.92, c <= 0.04045); }
fn srgbEncode(c: f32) -> f32 { return select(1.055 * pow(c, 1.0 / 2.4) - 0.055, 12.92 * c, c <= 0.0031308); }
fn srgbDecode3(c: vec3f) -> vec3f { return vec3f(srgbDecode(c.x), srgbDecode(c.y), srgbDecode(c.z)); }
fn luminance(c: vec3f) -> f32 { return 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z; }
fn rgbToHsv(c: vec3f) -> vec3f {
  let mx = max(c.x, max(c.y, c.z)); let mn = min(c.x, min(c.y, c.z)); let d = mx - mn;
  var h = 0.0;
  if (d > 0.0) {
    if (mx == c.x) { h = (c.y - c.z) / d + select(0.0, 6.0, c.y < c.z); }
    else if (mx == c.y) { h = (c.z - c.x) / d + 2.0; }
    else { h = (c.x - c.y) / d + 4.0; }
    h = h / 6.0;
  }
  return vec3f(h, select(0.0, d / mx, mx > 0.0), mx);
}
fn hsvToRgb(c: vec3f) -> vec3f {
  let h = (c.x - floor(c.x)) * 6.0; let s = c.y; let v = c.z;
  let fi = floor(h); let f = h - fi; let i = i32(fi) % 6;
  let p = v * (1.0 - s); let q = v * (1.0 - s * f); let t = v * (1.0 - s * (1.0 - f));
  if (i == 0) { return vec3f(v, t, p); }
  if (i == 1) { return vec3f(q, v, p); }
  if (i == 2) { return vec3f(p, v, t); }
  if (i == 3) { return vec3f(p, q, v); }
  if (i == 4) { return vec3f(t, p, v); }
  return vec3f(v, p, q);
}
`;
