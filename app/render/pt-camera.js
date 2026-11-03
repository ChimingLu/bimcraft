/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-camera.js — the path tracer's physical camera (0.7 RN.4; RENDER-SPEC § 1, § 4, § 6.1 words 86–127, § 7). No DOM; imports
 * only pt-spec.js. pt-wgsl.js's generate stage is the same camera, line for line.
 *
 *   cameraStops(settings) → stops added to the display exposure (the slider, plus f-stop / shutter / ISO in camera mode:
 *                           log2(t · S · 256 / N²), 0 at "sunny 16" — f/16, 1/100 s, ISO 100 — the light the scene's daylight
 *                           scale is set for)
 *   ev100(settings) → the camera's EV at ISO 100 (log2(N² / t) − log2(S / 100)), for the dialog
 *   whiteBalance(kelvin) → AP1 gains [r, g, b]: a white lit by that colour temperature shows as white (1 at 6500 K)
 *   cctToXy(kelvin) → CIE 1931 xy: Planckian locus below 4000 K (Kim et al. 2002 cubic fit), the CIE daylight locus above
 *   levelCamera(world, proj, up) → {world, proj}   two-point perspective: the camera turned level, the projection shifted so the
 *                           old view centre stays where it was in the frame (vertical lines stay vertical: tilt-shift)
 *   cameraWords(settings, {world, proj}, {focus}) → {[header word]: value}   projection kind, lens, focus, stereo
 *   writeMotion(hf, hu, camera1, far)   the camera at the shutter's close (world + inverse projection) for camera motion blur
 *   cameraRay(hf, hu, px, py, w, h, jx, jy, l1, l2, tm, o, d)   one camera ray (pixel sample, lens sample, time) → o, d
 *   lensPoint(u, v, blades, rot) → [x, y] in the unit disc (round: concentric map; blades ≥ 3: a regular polygon, uniform)
 *
 * Projection kinds (word 86): 0 the app's camera (perspective or parallel, § 1) with an optional thin lens; 1 a 360° panorama
 * (equirectangular, the view's direction in the middle, 2:1); 2 a 360° stereo panorama (omni-directional stereo: left eye on
 * top, right below, each 2:1, eyes 64 mm apart); 3 a cube map (3 × 2 faces: right, left, up / down, front, back, each 90°).
 * Depth of field: a thin lens of diameter f / N (f from the view's angle on a 24 mm-high sensor), focused at `focus` metres
 * (0 = what is in the middle of the view); the aperture is round or has 5–9 blades.
 */
import { HW } from './pt-spec.js';

export const PROJ = Object.freeze({ normal: 0, equirect: 1, stereo: 2, cube: 3 });   // the choices: looks.js PROJECTIONS
export const STEREO_IPD = 0.064;
const SENSOR_H = 0.024;

export function ev100(s) {
  const N = s.fstop || 8, t = s.shutter || 1 / 125, S = s.iso || 100;
  return Math.log2((N * N) / t) - Math.log2(S / 100);
}
export function cameraStops(s) {
  const base = (s && s.exposure) || 0;
  if (!s || s.exposureMode !== 'camera') return base;
  const N = s.fstop || 8, t = s.shutter || 1 / 125, S = s.iso || 100;
  return base + Math.log2((t * S * 256) / (N * N));
}

export function cctToXy(T) {
  T = Math.min(25000, Math.max(1667, T));
  let x, y;
  if (T < 4000) {
    x = -0.2661239e9 / T ** 3 - 0.2343589e6 / T ** 2 + 0.8776956e3 / T + 0.17991;
    y = T < 2222 ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
      : -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867;
  } else {
    x = T <= 7000 ? -4.607e9 / T ** 3 + 2.9678e6 / T ** 2 + 0.09911e3 / T + 0.244063 : -2.0064e9 / T ** 3 + 1.9018e6 / T ** 2 + 0.24748e3 / T + 0.23704;
    y = -3 * x * x + 2.87 * x - 0.275;
  }
  return [x, y];
}
// XYZ → AP1 (ACES 2065-1 → AP1 via the published AP1 primaries: the inverse of AP1's RGB → XYZ matrix, D60 white)
const XYZ_TO_AP1 = [[1.6410234, -0.3248033, -0.2364247], [-0.6636629, 1.6153316, 0.0167563], [0.0117219, -0.0082844, 0.9883949]];
const ap1OfXy = ([x, y]) => { const X = x / y, Z = (1 - x - y) / y; return XYZ_TO_AP1.map((r) => r[0] * X + r[1] + r[2] * Z); };
const lumAp1 = (c) => 0.2722 * c[0] + 0.6741 * c[1] + 0.0537 * c[2];
export function whiteBalance(K) {
  if (!K || Math.abs(K - 6500) < 1) return [1, 1, 1];
  const ref = ap1OfXy(cctToXy(6500)), w = ap1OfXy(cctToXy(K));
  // gains take that white to the 6500 K white, scaled so its luminance stays: they change colour, not exposure
  const k = lumAp1(w) / lumAp1(ref);
  return ref.map((v, i) => (v / w[i]) * k);
}

const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Two-point perspective (perspective views only; a parallel view or one looking straight up/down is returned as it was). */
export function levelCamera(world, proj, up) {
  if (proj[11] !== -1) return { world, proj };
  const u = norm(up), fwd = norm([-world[8], -world[9], -world[10]]), s = dot(fwd, u);
  if (Math.abs(s) > 0.97) return { world, proj };
  const f = norm([fwd[0] - s * u[0], fwd[1] - s * u[1], fwd[2] - s * u[2]]), r = norm(cross(f, u));
  const W = [r[0], r[1], r[2], 0, u[0], u[1], u[2], 0, -f[0], -f[1], -f[2], 0, world[12], world[13], world[14], 1];
  // the old centre direction sits at height tan α above the level horizon; shift the frame up by P5 · tan α (NDC)
  const sy = proj[5] * (s / Math.sqrt(1 - s * s));
  const P = proj.slice();
  for (let col = 0; col < 4; col++) P[col * 4 + 1] += sy * -P[col * 4 + 3];
  return { world: W, proj: P };
}

export function lensPoint(u, v, blades, rot) {
  if (!(blades >= 3)) {
    // Shirley–Chiu concentric map
    const a = 2 * u - 1, b = 2 * v - 1;
    if (a === 0 && b === 0) return [0, 0];
    let r, ph;
    if (Math.abs(a) > Math.abs(b)) { r = a; ph = (Math.PI / 4) * (b / a); } else { r = b; ph = Math.PI / 2 - (Math.PI / 4) * (a / b); }
    return [r * Math.cos(ph), r * Math.sin(ph)];
  }
  // a regular polygon of `blades` sides: pick a triangle (centre, corner k, corner k + 1), then a uniform point in it
  const n = blades, k = Math.min(n - 1, Math.floor(u * n)), uu = u * n - k;
  const a0 = rot + (2 * Math.PI * k) / n, a1 = a0 + (2 * Math.PI) / n;
  const su = Math.sqrt(uu), b1 = su * (1 - v), b2 = su * v;
  return [b1 * Math.cos(a0) + b2 * Math.cos(a1), b1 * Math.sin(a0) + b2 * Math.sin(a1)];
}

/** The camera's header words (§ 6.1 86–95). `focus` = the auto-focus distance when settings.focus is 0. */
export function cameraWords(s, camera, { focus = 1 } = {}) {
  const f32 = (x) => { const b = new Float32Array([x]); return new Uint32Array(b.buffer)[0]; };
  const kind = PROJ[s && s.projection] || 0;
  let radius = 0;
  if (kind === 0 && s && s.dof && camera.proj[11] === -1) {
    const fl = SENSOR_H / 2 * camera.proj[5];   // focal length (m) = (h/2) / tan(fov/2)
    radius = fl / (s.fstop || 8) / 2;
  }
  const fd = s && s.focus > 0 ? s.focus : focus;
  return {
    [HW.PROJ]: kind, [HW.LENS_R]: f32(radius), [HW.FOCUS]: f32(Math.max(0.01, fd)), [HW.BLADES]: (s && s.blades) | 0,
    [HW.BLADE_ROT]: f32((((s && s.bladeRot) || 0) * Math.PI) / 180), [HW.STEREO_IPD]: f32(STEREO_IPD),
  };
}

/** The camera at the shutter's close: world (16) + inverse projection (16) in words 96–127; word 91 = 1. */
export function writeMotion(hf, hu, camera1, invProj) {
  hu[HW.MOTION] = 1;
  hf.set(camera1.world, HW.CAM1_W);
  hf.set(invProj, HW.CAM1_PI);
}

// ---- the camera ray (pt-ref.js; pt-wgsl.js gen is the same) ----
const un = [0, 0, 0, 0], ca = [0, 0, 0], cb = [0, 0, 0], o2 = [0, 0, 0], d2 = [0, 0, 0];
function unproject(Pi, x, y, z, out) {
  for (let r = 0; r < 4; r++) un[r] = Pi[r] * x + Pi[4 + r] * y + Pi[8 + r] * z + Pi[12 + r];
  out[0] = un[0] / un[3]; out[1] = un[1] / un[3]; out[2] = un[2] / un[3];
}
function pinhole(W, Pi, x, y, o, d) {
  unproject(Pi, x, y, -1, ca); unproject(Pi, x, y, 1, cb);
  const dx = cb[0] - ca[0], dy = cb[1] - ca[1], dz = cb[2] - ca[2];
  for (let r = 0; r < 3; r++) {
    o[r] = W[r] * ca[0] + W[4 + r] * ca[1] + W[8 + r] * ca[2] + W[12 + r];
    d[r] = W[r] * dx + W[4 + r] * dy + W[8 + r] * dz;
  }
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  d[0] /= l; d[1] /= l; d[2] /= l;
}
/** A direction of a panorama / cube pixel in the camera's own frame (x right, y up, −z forward) → world through W's columns. */
function panoDir(kind, W, u, v, d, eye) {
  let cx, cy, cz;
  if (kind === 3) {
    // cube 3 × 2: (0,0) right (+x), (1,0) left (−x), (2,0) up (+y) / (0,1) down (−y), (1,1) front (−z), (2,1) back (+z)
    const fx = Math.min(2, Math.floor(u * 3)), fy = v < 0.5 ? 0 : 1, a = (u * 3 - fx) * 2 - 1, b = 1 - ((v * 2) % 1) * 2;
    const f = fx + 3 * fy;
    if (f === 0) { cx = 1; cy = b; cz = a; }
    else if (f === 1) { cx = -1; cy = b; cz = -a; }
    else if (f === 2) { cx = a; cy = 1; cz = -b; }
    else if (f === 3) { cx = a; cy = -1; cz = b; }
    else if (f === 4) { cx = a; cy = b; cz = -1; }
    else { cx = -a; cy = b; cz = 1; }
  } else {
    const vv = kind === 2 ? (v * 2) % 1 : v;
    const lon = 2 * Math.PI * (u - 0.5), lat = Math.PI * (0.5 - vv);
    cx = Math.cos(lat) * Math.sin(lon); cy = Math.sin(lat); cz = -Math.cos(lat) * Math.cos(lon);
    if (eye) {
      // omni-directional stereo: each column's eye sits on a circle, at right angles to that column's heading
      const s = (v < 0.5 ? -1 : 1) * eye / 2;
      eye = [s * Math.cos(lon), 0, s * Math.sin(lon)];
    }
  }
  const l = Math.hypot(cx, cy, cz);
  cx /= l; cy /= l; cz /= l;
  for (let r = 0; r < 3; r++) d[r] = W[r] * cx + W[4 + r] * cy + W[8 + r] * cz;
  const dl = Math.hypot(d[0], d[1], d[2]) || 1;
  d[0] /= dl; d[1] /= dl; d[2] /= dl;
  return eye;
}
export function cameraRay(hf, hu, px, py, w, h, jx, jy, l1, l2, tm, o, d) {
  const kind = hu[HW.PROJ];
  const W = hf.subarray(16, 32), Pi = hf.subarray(32, 48);
  if (kind) {
    const u = (px + jx) / w, v = (py + jy) / h;
    const eye = panoDir(kind, W, u, v, d, kind === 2 ? hf[HW.STEREO_IPD] : 0);
    for (let r = 0; r < 3; r++) o[r] = W[12 + r] + (eye ? W[r] * eye[0] + W[4 + r] * eye[1] + W[8 + r] * eye[2] : 0);
    return;
  }
  const x = (2 * (px + jx)) / w - 1, y = 1 - (2 * (py + jy)) / h;
  pinhole(W, Pi, x, y, o, d);
  if (hu[HW.MOTION] === 1 && tm > 0) {
    pinhole(hf.subarray(HW.CAM1_W, HW.CAM1_W + 16), hf.subarray(HW.CAM1_PI, HW.CAM1_PI + 16), x, y, o2, d2);
    for (let r = 0; r < 3; r++) { o[r] += (o2[r] - o[r]) * tm; d[r] += (d2[r] - d[r]) * tm; }
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    d[0] /= l; d[1] /= l; d[2] /= l;
  }
  const R = hf[HW.LENS_R];
  if (R > 0) {
    // thin lens: the point this ray reaches on the focus plane stays sharp; the ray leaves from a point on the aperture
    // the focus plane lies `focus` metres in front of the eye (W's position), square to the view
    const fwd = [-W[8], -W[9], -W[10]], fl = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
    const c = (d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2]) / fl;
    if (!(c > 1e-6)) return;
    const ahead = ((o[0] - W[12]) * fwd[0] + (o[1] - W[13]) * fwd[1] + (o[2] - W[14]) * fwd[2]) / fl;
    const t = (hf[HW.FOCUS] - ahead) / c, pf = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    const [a, b] = lensPoint(l1, l2, hu[HW.BLADES], hf[HW.BLADE_ROT]);
    const rx = Math.hypot(W[0], W[1], W[2]) || 1, ry = Math.hypot(W[4], W[5], W[6]) || 1;
    for (let r = 0; r < 3; r++) o[r] += (W[r] / rx) * a * R + (W[4 + r] / ry) * b * R;
    for (let r = 0; r < 3; r++) d[r] = pf[r] - o[r];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    d[0] /= l; d[1] /= l; d[2] /= l;
  }
}
