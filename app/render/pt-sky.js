/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-sky.js — the physical sky and environment maps for the path tracer (0.7 RN.3; RENDER-SPEC § 5.3). No DOM, no imports but
 * pt-spec.js. Every environment that is not today's analytic gradient — the physical sky, an HDRI picture — becomes one
 * equirectangular map (linear AP1) with tables for importance sampling, which every kernel reads the same way.
 *
 *   preetham(sunDir, up, turbidity) → {radiance(dir) → [r, g, b] linear Rec.709 (kcd/m² luminance scale), zenithY, sunTau}
 *   sunTransmittance(cosSun, turbidity) → [τ650, τ550, τ450]   direct sunlight through the atmosphere (Rayleigh + aerosol)
 *   bakeEnvMap(fn(dir) → AP1 rgb, w, h, up, rotation) → {w, h, rgb: Float32Array (w·h·4, AP1, alpha 1)}
 *   envFromImage({width, height, data RGBA}, w?, up, rotation) → the same, resampled (an HDRI: lib/exr readHdrImage)
 *   envTables(map) → {marginal: Float32Array (h+1), conditional: Float32Array (h·(w+1)), total}   CDFs ∝ luminance · sin θ
 *   envDir(i, j, fx, fy, w, h, up, rotation) / envPixel(dir, w, h, up, rotation) → the map's direction ↔ pixel mapping
 *   sampleEnv(map, T, u, v, up, rotation, out) → pdf (solid angle) and out = direction;  envPdf(map, T, dir, up, rotation)
 *   lookupEnv(map, dir, up, rotation, out) → AP1 rgb of the pixel the direction falls in (the same pixel the CDFs describe)
 *
 * Map convention: θ from `up` (0 = zenith), φ around it from basis(up).e1 toward e2, plus `rotation` (radians); pixel (i, j) =
 * φ ∈ [2πi/w, 2π(i+1)/w), θ ∈ [πj/h, π(j+1)/h) — row 0 is the zenith, as an HDRI picture's top row.
 *
 * Sources: A. J. Preetham, P. Shirley, B. Smits, "A Practical Analytic Model for Daylight", SIGGRAPH 1999 — Perez distribution
 * (§ 3), Appendix A.2 (the distribution coefficients as linear functions of turbidity; zenith luminance and chromaticity, the
 * printed four-decimal matrices), Appendix A.1 (relative optical mass after Kasten, Rayleigh and Ångström aerosol transmittance,
 * β = 0.04608 T − 0.04586, α = 1.3); CIE xyY → XYZ; the sRGB (IEC 61966-2-1) XYZ → linear RGB matrix. Formulas only.
 */
import { REC709_TO_AP1, mul3 } from './pt-spec.js';

const PERZ = {
  Y: [[0.1787, -1.4630], [-0.3554, 0.4275], [-0.0227, 5.3251], [0.1206, -2.5771], [-0.0670, 0.3703]],
  x: [[-0.0193, -0.2592], [-0.0665, 0.0008], [-0.0004, 0.2125], [-0.0641, -0.8989], [-0.0033, 0.0452]],
  y: [[-0.0167, -0.2608], [-0.0950, 0.0092], [-0.0079, 0.2102], [-0.0441, -1.6537], [-0.0109, 0.0529]],
};
const XZ = [[0.0017, -0.0037, 0.0021, 0.0000], [-0.0290, 0.0638, -0.0320, 0.0039], [0.1169, -0.2120, 0.0605, 0.2589]];
const YZ = [[0.0028, -0.0061, 0.0032, 0.0000], [-0.0421, 0.0897, -0.0415, 0.0052], [0.1535, -0.2676, 0.0667, 0.2669]];
const XYZ_TO_REC709 = [[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]];

const perez = (c, theta, gamma) => (1 + c[0] * Math.exp(c[1] / Math.max(0.01, Math.cos(theta)))) * (1 + c[2] * Math.exp(c[3] * gamma) + c[4] * Math.cos(gamma) ** 2);
const vnorm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Relative optical mass (Kasten, as the paper's A.1 gives it), the sun at zenith angle θs (radians). */
export function opticalMass(thetaS) {
  const deg = (thetaS * 180) / Math.PI;
  return 1 / (Math.cos(thetaS) + 0.15 * Math.pow(Math.max(1e-3, 93.885 - deg), -1.253));
}
/** Direct sunlight's transmittance at 650, 550, 450 nm: Rayleigh e^(−0.008735 λ^−4.08 m) × Ångström e^(−β λ^−α m) (λ in µm). */
export function sunTransmittance(cosSun, turbidity) {
  const m = opticalMass(Math.acos(Math.min(1, Math.max(-1, cosSun)))), beta = 0.04608 * turbidity - 0.04586, alpha = 1.3;
  return [0.65, 0.55, 0.45].map((l) => Math.exp(-0.008735 * Math.pow(l, -4.08) * m) * Math.exp(-beta * Math.pow(l, -alpha) * m));
}

/** Preetham's sky for a sun direction (toward the sun) and turbidity (2 = very clear … 10 = hazy). */
export function preetham(sunDir, up, turbidity = 3) {
  const T = Math.min(10, Math.max(1.7, turbidity)), s = vnorm(sunDir), u = vnorm(up);
  const thetaS = Math.acos(Math.min(1, Math.max(0, dot(s, u))));   // the sky model wants the sun at or above the horizon
  const co = (tab) => tab.map(([a, b]) => a * T + b);
  const cY = co(PERZ.Y), cx = co(PERZ.x), cy = co(PERZ.y);
  const chi = (4 / 9 - T / 120) * (Math.PI - 2 * thetaS);
  const Yz = Math.max(0, (4.0453 * T - 4.9710) * Math.tan(chi) - 0.2155 * T + 2.4192);
  const ts = [thetaS ** 3, thetaS ** 2, thetaS, 1], tv = [T * T, T, 1];
  const mat = (M) => tv.reduce((acc, t, r) => acc + t * M[r].reduce((a, m, k) => a + m * ts[k], 0), 0);
  const xz = mat(XZ), yz = mat(YZ);
  const nY = perez(cY, 0, thetaS), nx = perez(cx, 0, thetaS), ny = perez(cy, 0, thetaS);
  return {
    zenithY: Yz, turbidity: T, thetaS,
    radiance(dir) {
      const d = vnorm(dir), cz = dot(d, u);
      const theta = Math.acos(Math.min(1, Math.max(0, cz)));   // below the horizon: the horizon's colour (the ground covers it)
      const gamma = Math.acos(Math.min(1, Math.max(-1, dot(d, s))));
      const Y = (Yz * perez(cY, theta, gamma)) / nY, x = (xz * perez(cx, theta, gamma)) / nx, y = (yz * perez(cy, theta, gamma)) / ny;
      const X = (x / Math.max(1e-6, y)) * Y, Z = ((1 - x - y) / Math.max(1e-6, y)) * Y;
      return mul3(XYZ_TO_REC709, [X, Y, Z]).map((v) => Math.max(0, v));
    },
  };
}

// ---- equirectangular maps ----
function frame(up, rotation) {
  const u = vnorm(up), ax = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let e1 = vnorm([u[1] * ax[2] - u[2] * ax[1], u[2] * ax[0] - u[0] * ax[2], u[0] * ax[1] - u[1] * ax[0]]);
  let e2 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]];
  if (rotation) {
    const c = Math.cos(rotation), s = Math.sin(rotation);
    const a = [0, 1, 2].map((k) => e1[k] * c + e2[k] * s), b = [0, 1, 2].map((k) => -e1[k] * s + e2[k] * c);
    e1 = a; e2 = b;
  }
  return { u, e1, e2 };
}
export function envDir(i, j, fx, fy, w, h, up, rotation = 0, out = [0, 0, 0]) {
  const F = frame(up, rotation), phi = (2 * Math.PI * (i + fx)) / w, theta = (Math.PI * (j + fy)) / h;
  const st = Math.sin(theta), ct = Math.cos(theta), cp = Math.cos(phi), sp = Math.sin(phi);
  for (let k = 0; k < 3; k++) out[k] = F.e1[k] * cp * st + F.e2[k] * sp * st + F.u[k] * ct;
  return out;
}
/** Direction → continuous pixel coordinates (x in [0, w), y in [0, h)). */
export function envPixel(dir, w, h, up, rotation = 0) {
  const F = frame(up, rotation), d = vnorm(dir);
  const ct = Math.min(1, Math.max(-1, dot(d, F.u))), theta = Math.acos(ct);
  let phi = Math.atan2(dot(d, F.e2), dot(d, F.e1));
  if (phi < 0) phi += 2 * Math.PI;
  return [(phi / (2 * Math.PI)) * w, (theta / Math.PI) * h];
}
export function bakeEnvMap(fn, w, h, up, rotation = 0) {
  const rgb = new Float32Array(w * h * 4), d = [0, 0, 0];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const c = fn(envDir(i, j, 0.5, 0.5, w, h, up, rotation, d)), o = (j * w + i) * 4;
    rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]; rgb[o + 3] = 1;
  }
  return { w, h, rgb };
}
/** An HDRI picture (linear Rec.709, as lib/exr reads it: top row = zenith) → a map in AP1, box-filtered down to ≤ maxW wide. */
export function envFromImage(img, maxW = 2048) {
  const k = Math.max(1, Math.ceil(img.width / maxW)), w = Math.max(1, Math.floor(img.width / k)), h = Math.max(1, Math.floor(img.height / k));
  const rgb = new Float32Array(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = j * k; y < Math.min(img.height, (j + 1) * k); y++) for (let x = i * k; x < Math.min(img.width, (i + 1) * k); x++) {
      const o = (y * img.width + x) * 4, R = img.data[o], G = img.data[o + 1], B = img.data[o + 2];
      if (Number.isFinite(R) && Number.isFinite(G) && Number.isFinite(B)) { r += Math.max(0, R); g += Math.max(0, G); b += Math.max(0, B); n++; }
    }
    const c = mul3(REC709_TO_AP1, n ? [r / n, g / n, b / n] : [0, 0, 0]), o = (j * w + i) * 4;
    rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]; rgb[o + 3] = 1;
  }
  return { w, h, rgb };
}

const lumA = (r, g, b) => 0.2722 * r + 0.6741 * g + 0.0537 * b;
/** CDFs for importance sampling: a pixel's weight = luminance × sin θ (its solid angle); rows by the marginal, then a column. */
export function envTables(map) {
  const { w, h, rgb } = map, marginal = new Float32Array(h + 1), conditional = new Float32Array(h * (w + 1));
  let total = 0;
  for (let j = 0; j < h; j++) {
    const st = Math.sin((Math.PI * (j + 0.5)) / h);
    let row = 0;
    conditional[j * (w + 1)] = 0;
    for (let i = 0; i < w; i++) {
      const o = (j * w + i) * 4;
      row += Math.max(1e-12, lumA(rgb[o], rgb[o + 1], rgb[o + 2])) * st;
      conditional[j * (w + 1) + i + 1] = row;
    }
    for (let i = 1; i <= w; i++) conditional[j * (w + 1) + i] /= row;
    total += row;
    marginal[j + 1] = total;
  }
  for (let j = 1; j <= h; j++) marginal[j] /= total;
  return { marginal, conditional, total };
}
/** The first index i in [0, n) with cdf[i + 1] > u (cdf has n + 1 entries, 0 … 1). */
function findCdf(cdf, off, n, u) {
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[off + mid + 1] > u) hi = mid; else lo = mid + 1; }
  return lo;
}
export function sampleEnv(map, T, u, v, up, rotation, out) {
  const { w, h } = map;
  const j = findCdf(T.marginal, 0, h, u), pj = T.marginal[j + 1] - T.marginal[j];
  const fy = pj > 0 ? (u - T.marginal[j]) / pj : 0.5;
  const o = j * (w + 1), i = findCdf(T.conditional, o, w, v), pi = T.conditional[o + i + 1] - T.conditional[o + i];
  const fx = pi > 0 ? (v - T.conditional[o + i]) / pi : 0.5;
  envDir(i, j, fx, fy, w, h, up, rotation, out);
  const st = Math.sin((Math.PI * (j + fy)) / h);
  return st > 0 ? (pj * pi * w * h) / (2 * Math.PI * Math.PI * st) : 0;
}
export function envPdf(map, T, dir, up, rotation) {
  const { w, h } = map, [x, y] = envPixel(dir, w, h, up, rotation);
  const i = Math.min(w - 1, Math.max(0, Math.floor(x))), j = Math.min(h - 1, Math.max(0, Math.floor(y)));
  const pj = T.marginal[j + 1] - T.marginal[j], o = j * (w + 1), pi = T.conditional[o + i + 1] - T.conditional[o + i];
  const st = Math.sin((Math.PI * y) / h);
  return st > 0 ? (pj * pi * w * h) / (2 * Math.PI * Math.PI * st) : 0;
}
/** Nearest-pixel lookup: the same pixel the sampling tables describe (so the pdf and the radiance agree). */
export function lookupEnv(map, dir, up, rotation, out = [0, 0, 0]) {
  const { w, h, rgb } = map, [x, y] = envPixel(dir, w, h, up, rotation);
  const i = Math.min(w - 1, Math.max(0, Math.floor(x))), j = Math.min(h - 1, Math.max(0, Math.floor(y))), o = (j * w + i) * 4;
  out[0] = rgb[o]; out[1] = rgb[o + 1]; out[2] = rgb[o + 2];
  return out;
}
