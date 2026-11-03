/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-probes.js — the real-time view's indirect light: a grid of irradiance probes baked by the path tracer (0.7 RT.2, session
 * `realtime`). DOM-free (Node tests and pool workers). Canonical in modelcraft/dev/rt/ (tools/rt/sync.mjs).
 *
 * Each probe is a tiny 360° panorama path traced from its point by the JS reference tracer (render/pt-ref.js, RENDER-SPEC:
 * projection 1, the same estimator as a still) and projected onto spherical harmonics, bands 0 and 1 (four coefficients per
 * colour, world axes, three.js's order and constants: Y00, Y1−1 ∝ y, Y10 ∝ z, Y11 ∝ x). A camera ray of the tracer sees the sky
 * and every surface lit by the sun, lamps and their bounces, but never the sun's disc (RENDER-SPEC § 3: the sun counts from
 * bounce 1), so a probe holds exactly the light the real-time sun does not draw. The view then adds, per pixel, the probe
 * irradiance minus the sky's own (the sky is already in the view's image light): indoors that difference is negative and takes
 * the sky back out; near a sunlit wall it adds the bounce.
 *
 *   probeGrid(bounds, up, groundAt, res) → {min, max, res, n, positions: Float64Array(n·3)}   the box around the model (a margin
 *     of 5 %, the floor 2 cm above the ground), probes at the corners of res − 1 cells, x fastest, then y, then z (world axes)
 *   probeCamera(p) → {world, proj}   a camera at p for the panorama (orientation fixed; the tracer's own mapping gives each
 *     pixel's direction, so the projection never has to agree with anything here)
 *   panoramaDirs(header, w, h) → Float32Array(w·h·3)  each pixel's ray direction (pixel centres, through pt-camera.js cameraRay)
 *   projectL1(accum, dirs, w, h, out?, at?) → out      Σ L·Y·dΩ over the panorama (accum = AP1 sums + counts, pt-ref's layout),
 *     into linear Rec.709: 12 floats [c0 rgb, c1 rgb, c2 rgb, c3 rgb]; dΩ = (2π/w)(π/h) sin θ from the pixel's direction
 *   skyL1(sky, up, k) → 12 floats   the gradient sky's own coefficients (render/looks.js SKIES colours × k), the same quadrature
 *   irradianceL1(c, n) → [r, g, b]  E(n) = 0.886227·c0 + 1.023328·(c1 y + c2 z + c3 x) (three.js's getShIrradianceAt, bands 0–1)
 *   sampleGrid(grid, p) → 12 coefficients   a baked grid ({min, max, res, sh}) at a point, trilinear (the headset's bounce light)
 *   rotateL1(c, R) → 12 coefficients    band 1 turned by a 3 × 3 (column-major, any uniform scale taken out): it turns as a vector
 *   packTextures(sh, res) → [Float32Array × 3]   three RGBA 3D textures (nx × ny × nz): (c0.rgb, c1.r), (c1.gb, c2.rg), (c2.b, c3.rgb)
 */
import { AP1_TO_REC709, srgbToLinear } from '../render/pt-spec.js';
import { cameraRay } from '../render/pt-camera.js';

const Y0 = 0.282095, Y1 = 0.488603;

export function probeGrid(bounds, up, groundAt, res) {
  const lo = bounds ? bounds.min.slice() : [-5, -5, -5], hi = bounds ? bounds.max.slice() : [5, 5, 5];
  for (let k = 0; k < 3; k++) { const m = Math.max(0.05, (hi[k] - lo[k]) * 0.05); lo[k] -= m; hi[k] += m; }
  // not under the ground: the axis that is up starts 2 cm above it
  const ax = [0, 1, 2].reduce((a, k) => (Math.abs(up[k]) > Math.abs(up[a]) ? k : a), 0);
  if (up[ax] > 0) lo[ax] = Math.max(lo[ax], (groundAt || 0) + 0.02); else hi[ax] = Math.min(hi[ax], -(groundAt || 0) - 0.02);
  for (let k = 0; k < 3; k++) if (!(hi[k] > lo[k] + 0.01)) hi[k] = lo[k] + 0.01;
  const r = res.map((x) => Math.max(2, x | 0));
  const n = r[0] * r[1] * r[2], positions = new Float64Array(n * 3);
  let i = 0;
  for (let z = 0; z < r[2]; z++) for (let y = 0; y < r[1]; y++) for (let x = 0; x < r[0]; x++) {
    positions[i++] = lo[0] + ((hi[0] - lo[0]) * x) / (r[0] - 1);
    positions[i++] = lo[1] + ((hi[1] - lo[1]) * y) / (r[1] - 1);
    positions[i++] = lo[2] + ((hi[2] - lo[2]) * z) / (r[2] - 1);
  }
  return { min: lo, max: hi, res: r, n, positions };
}

export function probeCamera(p) {
  // world = a translation (camera axes = world axes); a plain perspective projection (ignored by panoramas, kept valid)
  const world = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0], p[1], p[2], 1];
  const f = 1, n = 0.01, fr = 1000;
  const proj = [f, 0, 0, 0, 0, f, 0, 0, 0, 0, (fr + n) / (n - fr), -1, 0, 0, (2 * fr * n) / (n - fr), 0];
  return { world, proj };
}

export function panoramaDirs(header, w, h) {
  const hu = new Uint32Array(header.buffer || header, header.byteOffset || 0, 128), hf = new Float32Array(hu.buffer, hu.byteOffset, 128);
  const out = new Float32Array(w * h * 3), o = [0, 0, 0], d = [0, 0, 0];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    cameraRay(hf, hu, x, y, w, h, 0.5, 0.5, 0.5, 0.5, 0, o, d);
    out.set(d, (y * w + x) * 3);
  }
  return out;
}

export function projectL1(accum, dirs, w, h, out = new Float32Array(12), at = 0) {
  const cell = ((2 * Math.PI) / w) * (Math.PI / h);
  const c = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < w * h; i++) {
    const n = accum[i * 4 + 3];
    if (!(n > 0)) continue;
    const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
    // dΩ from the pixel's latitude: every panorama row is a band of equal height in θ (RENDER-SPEC § 1)
    const row = Math.floor(i / w), sinT = Math.sin((Math.PI * (row + 0.5)) / h);
    const wgt = (cell * sinT) / n;
    const a = [accum[i * 4], accum[i * 4 + 1], accum[i * 4 + 2]];
    for (let k = 0; k < 3; k++) {
      const L = (AP1_TO_REC709[k][0] * a[0] + AP1_TO_REC709[k][1] * a[1] + AP1_TO_REC709[k][2] * a[2]) * wgt;
      c[k] += L * Y0; c[3 + k] += L * Y1 * dy; c[6 + k] += L * Y1 * dz; c[9 + k] += L * Y1 * dx;
    }
  }
  for (let k = 0; k < 12; k++) out[at + k] = c[k];
  return out;
}

const hex = (s) => { const n = parseInt(String(s).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => srgbToLinear(x / 255)); };

export function skyL1(sky, up, k = 1) {
  const zen = hex(sky.zenith), hor = hex(sky.horizon), gnd = hex(sky.ground);
  const c = new Float32Array(12), N = 64, M = 128;
  for (let j = 0; j < N; j++) {
    const th = (Math.PI * (j + 0.5)) / N, st = Math.sin(th), ct = Math.cos(th);
    for (let i = 0; i < M; i++) {
      const ph = (2 * Math.PI * (i + 0.5)) / M;
      const d = [st * Math.cos(ph), st * Math.sin(ph), ct];   // a direction on the sphere (any frame: z = d·up below)
      // turn d into world: z → up (the gradient depends only on d·up; the band-1 terms need the world direction)
      const wv = toWorld(d, up);
      const z = wv[0] * up[0] + wv[1] * up[1] + wv[2] * up[2];
      const L = z >= 0 ? hor.map((h, q) => h + (zen[q] - h) * Math.pow(z, 0.6)) : hor.map((h, q) => h + (gnd[q] - h) * Math.pow(-z, 0.4));
      const wgt = ((2 * Math.PI) / M) * (Math.PI / N) * st * k;
      for (let q = 0; q < 3; q++) { const v = L[q] * wgt; c[q] += v * Y0; c[3 + q] += v * Y1 * wv[1]; c[6 + q] += v * Y1 * wv[2]; c[9 + q] += v * Y1 * wv[0]; }
    }
  }
  return c;
}
function toWorld(d, up) {
  let ax = Math.abs(up[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let e1 = [up[1] * ax[2] - up[2] * ax[1], up[2] * ax[0] - up[0] * ax[2], up[0] * ax[1] - up[1] * ax[0]];
  const l = Math.hypot(...e1); e1 = e1.map((x) => x / l);
  const e2 = [up[1] * e1[2] - up[2] * e1[1], up[2] * e1[0] - up[0] * e1[2], up[0] * e1[1] - up[1] * e1[0]];
  return [0, 1, 2].map((k) => e1[k] * d[0] + e2[k] * d[1] + up[k] * d[2]);
}

export function irradianceL1(c, n) {
  return [0, 1, 2].map((k) => 0.886227 * c[k] + 1.023328 * (c[3 + k] * n[1] + c[6 + k] * n[2] + c[9 + k] * n[0]));
}

export function packTextures(sh, res) {
  const n = res[0] * res[1] * res[2];
  const t = [new Float32Array(n * 4), new Float32Array(n * 4), new Float32Array(n * 4)];
  for (let i = 0; i < n; i++) {
    const c = sh.subarray(i * 12, i * 12 + 12), o = i * 4;
    t[0][o] = c[0]; t[0][o + 1] = c[1]; t[0][o + 2] = c[2]; t[0][o + 3] = c[3];
    t[1][o] = c[4]; t[1][o + 1] = c[5]; t[1][o + 2] = c[6]; t[1][o + 3] = c[7];
    t[2][o] = c[8]; t[2][o + 1] = c[9]; t[2][o + 2] = c[10]; t[2][o + 3] = c[11];
  }
  return t;
}

export function sampleGrid(g, p) {
  const out = new Array(12).fill(0), [nx, ny, nz] = g.res;
  // the cell below (never the last probe, so the far edge is that cell's t = 1 exactly)
  const f = [0, 1, 2].map((k) => Math.min(g.res[k] - 1, Math.max(0, ((p[k] - g.min[k]) / (g.max[k] - g.min[k])) * (g.res[k] - 1))));
  const i0 = f.map((v, k) => Math.min(Math.max(0, g.res[k] - 2), Math.floor(v))), t = f.map((v, k) => v - i0[k]);
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const w = (dx ? t[0] : 1 - t[0]) * (dy ? t[1] : 1 - t[1]) * (dz ? t[2] : 1 - t[2]);
    const i = Math.min(nx - 1, i0[0] + dx) + nx * (Math.min(ny - 1, i0[1] + dy) + ny * Math.min(nz - 1, i0[2] + dz));
    for (let k = 0; k < 12; k++) out[k] += g.sh[i * 12 + k] * w;
  }
  return out;
}

export function rotateL1(c, R) {
  const s = Math.hypot(R[0], R[1], R[2]) || 1, out = Array.from(c);
  for (let ch = 0; ch < 3; ch++) {
    const v = [c[9 + ch], c[3 + ch], c[6 + ch]];   // (x, y, z) of band 1
    const w = [0, 1, 2].map((r) => (R[r] * v[0] + R[3 + r] * v[1] + R[6 + r] * v[2]) / s);
    out[3 + ch] = w[1]; out[6 + ch] = w[2]; out[9 + ch] = w[0];
  }
  return out;
}
