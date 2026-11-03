/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-caustic.js — caustics by light tracing (0.7 RN.7; RENDER-SPEC § 3.3, § 6.9): the data the light tracers read (the camera's
 * projection and view, the pixel's size, the lights that emit and their pick table) and the connection of a light-path vertex
 * to the camera. No DOM, no imports. The JS reference (pt-ref.js `lightTrace`) and the WGSL `caustic` stage use the same maths.
 *
 *   causticBlock({ L, R, camera, w, h }) → Float32Array | null      the block that goes at the end of the volume block (§ 6.9)
 *       L = pt-pack.js buildLights' result (ldat, off, count, sun, nBounded), camera = {world, proj}; null: no light to emit
 *       or a camera the connection does not handle (orthographic is handled; panoramas and lenses are the pack's to refuse)
 *   readCaustic(ldat, C, w, h) → cb      cb.connect(p, out) → bool: where the point p seen from the camera lands: out = {px, py,
 *       dist (to the camera, or to its plane when orthographic), dir (unit, from p toward the camera), w (the importance
 *       weight 1 / (dist² cos³θ A_pixel), or 1 / A_pixel orthographic; the surface's own cosine is the caller's)}
 *   CAUS { DIM0, STRIDE, FIXED, MAX_PATHS, MIN_PATHS }
 *
 * Derivation (Veach 1997 § 8.3 / pbrt-v4 § 16 for the pinhole's importance W_e = 1 / (A cos⁴θ)): the picture's pixel is the mean
 * radiance over its area on the image plane at distance 1, I_j = (1 / A_j) ∫ L(ω) dω / cos³θ; a light path that arrives at x
 * carrying α (Le cos θ_L / (p_pick p_pos p_dir), then f cos / pdf at each bounce) adds α · f(x) · cos θ' / (d² cos³θ A_j) / N
 * to its pixel, θ' the angle at x to the camera, θ the angle at the camera to its axis, N the paths per picture sample.
 */
import { LIGHT, LIGHT_FLOATS } from './pt-spec.js';

export const CAUS = Object.freeze({ DIM0: 0x200000, STRIDE: 64, FIXED: 1048576, MAX_PATHS: 262144, MIN_PATHS: 4096, FLAG: 4 });
const H = 36;   // the floats before the emitters: P (16), world → view rows (12), the eye (3), pixel area, kind, count, paths, spare

const lum = (a) => 0.2722 * a[0] + 0.6741 * a[1] + 0.0537 * a[2];

export function causticBlock({ L, R, camera, w, h, hasSun = true }) {
  const D = L.ldat, rec = (i, k) => D[L.off.rec + i * LIGHT_FLOATS + k];
  const idx = [], flux = [];
  for (let i = 0; i < L.count; i++) {
    const k = rec(i, 0);
    let phi = 0;
    if (k === LIGHT.SUN) phi = hasSun ? lum([rec(i, 12), rec(i, 13), rec(i, 14)]) * Math.PI * (1.05 * R) * (1.05 * R) : 0;
    else if (k === LIGHT.POINT || k === LIGHT.SPOT) phi = lum([rec(i, 12), rec(i, 13), rec(i, 14)]) * Math.PI * rec(i, 7) * rec(i, 7) * (k === LIGHT.SPOT ? 2 * Math.PI * (1 - rec(i, 11)) : 4 * Math.PI) * 0.7;
    else if (k === LIGHT.AREA) phi = lum([rec(i, 12), rec(i, 13), rec(i, 14)]) * Math.PI * rec(i, 7) * rec(i, 11);
    else if (k === LIGHT.DISC) phi = lum([rec(i, 12), rec(i, 13), rec(i, 14)]) * Math.PI * Math.PI * rec(i, 7) * rec(i, 7);
    else if (k === LIGHT.TRI || k === LIGHT.TRI2) phi = lum([rec(i, 12), rec(i, 13), rec(i, 14)]) * Math.PI * rec(i, 7) * (k === LIGHT.TRI2 ? 2 : 1);
    if (phi > 0 && Number.isFinite(phi)) { idx.push(i); flux.push(phi); }
  }
  if (!idx.length) return null;
  const P = camera.proj, W = camera.world;
  const axis = (c) => { const x = W[4 * c], y = W[4 * c + 1], z = W[4 * c + 2]; return [x, y, z, x * x + y * y + z * z || 1]; };
  const ax = [axis(0), axis(1), axis(2)], persp = P[11] === -1;
  if (!(P[0] > 0) || !(P[5] > 0)) return null;
  const n = idx.length, out = new Float32Array(H + 2 * n + 1), u = new Uint32Array(out.buffer);
  out.set(P, 0);
  for (let r = 0; r < 3; r++) {   // view = R^T (p − eye), R's columns the camera's axes (scale-safe)
    const a = ax[r];
    out[16 + 4 * r] = a[0] / a[3]; out[17 + 4 * r] = a[1] / a[3]; out[18 + 4 * r] = a[2] / a[3];
    out[19 + 4 * r] = -(a[0] * W[12] + a[1] * W[13] + a[2] * W[14]) / a[3];
  }
  out[28] = W[12]; out[29] = W[13]; out[30] = W[14];
  out[31] = (persp ? 4 / (P[0] * P[5]) : (2 / P[0]) * (2 / P[5])) / (w * h);
  out[32] = persp ? 1 : 0;
  out[33] = n;
  out[34] = Math.max(CAUS.MIN_PATHS, Math.min(CAUS.MAX_PATHS, Math.round((w * h) / 2)));
  idx.forEach((i, k) => { u[H + k] = i; });
  const tot = flux.reduce((a, b) => a + b, 0);
  let cum = 0;
  out[H + n] = 0;
  flux.forEach((f, k) => { cum += f / tot; out[H + n + 1 + k] = k === n - 1 ? 1 : cum; });
  return out;
}

/** Reads the block at C in `ldat`; w, h = the picture's size (header words 60, 61). */
export function readCaustic(ldat, C, w, h) {
  const u = new Uint32Array(ldat.buffer, ldat.byteOffset, ldat.length), f = ldat;
  const P = f.subarray(C, C + 16), V = f.subarray(C + 16, C + 28), eye = [f[C + 28], f[C + 29], f[C + 30]];
  const Aj = f[C + 31], persp = f[C + 32] === 1, n = f[C + 33], paths = f[C + 34];
  const z = [V[8], V[9], V[10]], zl = Math.hypot(z[0], z[1], z[2]) || 1;   // the camera's +z axis in the world, the way to an orthographic camera
  const toCamOrtho = [z[0] / zl, z[1] / zl, z[2] / zl];
  const view = [0, 0, 0];
  return {
    n, paths, persp, eye, Aj,
    emitter: (k) => u[C + H + k],
    cdf: (k) => f[C + H + n + k],
    /** Which emitter u picks, with its probability. */
    pick(uPick, out) {
      let lo = 0, hi = n - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (f[C + H + n + m + 1] > uPick) hi = m; else lo = m + 1; }
      out.i = u[C + H + lo]; out.prob = f[C + H + n + lo + 1] - f[C + H + n + lo];
      return out;
    },
    connect(p, out) {
      for (let r = 0; r < 3; r++) view[r] = V[4 * r] * p[0] + V[4 * r + 1] * p[1] + V[4 * r + 2] * p[2] + V[4 * r + 3];
      const cx = P[0] * view[0] + P[4] * view[1] + P[8] * view[2] + P[12], cy = P[1] * view[0] + P[5] * view[1] + P[9] * view[2] + P[13];
      const cw = P[3] * view[0] + P[7] * view[1] + P[11] * view[2] + P[15];
      if (!(cw > 0)) return false;
      const nx = cx / cw, ny = cy / cw;
      if (!(Math.abs(nx) < 1 && Math.abs(ny) < 1)) return false;
      out.px = Math.min(w - 1, Math.floor(((nx + 1) / 2) * w)); out.py = Math.min(h - 1, Math.floor(((1 - ny) / 2) * h));
      if (persp) {
        const depth = -view[2];
        if (!(depth > 0)) return false;
        const d = Math.hypot(view[0], view[1], view[2]), cosC = depth / d;
        out.dist = d;
        for (let r = 0; r < 3; r++) out.dir[r] = (eye[r] - p[r]) / d;
        out.w = 1 / (d * d * cosC * cosC * cosC * Aj);
      } else {
        out.dist = -view[2];
        if (!(out.dist > 0)) return false;
        for (let r = 0; r < 3; r++) out.dir[r] = toCamOrtho[r];
        out.w = 1 / Aj;
      }
      return true;
    },
  };
}
