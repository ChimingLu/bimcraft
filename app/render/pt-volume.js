/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-volume.js — participating media for the path tracer (0.7 RN.7; RENDER-SPEC § 3.1, § 6.9): a fog layer, up to four grid
 * volumes (clouds, smoke), the Henyey–Greenstein phase function, the `.ccvol` grid file and two procedural grids. No DOM, no
 * imports. The JS reference (pt-ref.js) calls makeMedia(); the WGSL kernel (pt-wgsl.js) runs the same algorithm draw for draw.
 *
 *   packVolumes({ up, fog, grids, caustic }) → Float32Array | null      the volume block that goes at the end of `ldat` (§ 6.9)
 *     fog   = { sigma (1/m), top (the plane's height along up, world units), albedo [r, g, b] AP1, g } | null
 *     grids = [{ data: Float32Array ρ ≥ 0 (nx·ny·nz, x fastest), nx, ny, nz, m (placeBox), scale (1/m at ρ = 1), albedo, g }]
 *   makeMedia(ldat, V) → media | null          V = the block's offset in `ldat` (header word 82; 0 = none)
 *     media.event(ro, rd, tmax, rnd, out) → bool    delta-tracked free flight; out = {t, albedo[3], g}
 *     media.transmit(ro, rd, len, rnd) → T          the shadow ray's transmittance (fog exact, grids by ratio tracking)
 *     media.sigmaAt(p, out?) → σ_t                  for tests
 *   hgPhase(cos, g), hgSampleCos(u, g), fogSigma(visibilityM), placeBox({centre, size, nx, ny, nz, up, yaw})
 *   writeCcvol(data, nx, ny, nz, {float}) → Uint8Array · readCcvol(bytes) → {nx, ny, nz, data} (untrusted; codes not_ccvol,
 *   too_new, too_big, damaged) · cloudGrid(n, seed) · plumeGrid(n, seed)
 *
 * Sources: Henyey & Greenstein 1941 (the phase function), Woodcock et al. 1965 (delta tracking), Novák et al. 2014 (ratio
 * tracking), pbrt-v4 chapter 14 (the estimators; no code copied), Koschmieder's visibility law (σ = 3.912 / V for 2 % contrast).
 */

export const VOL = Object.freeze({
  MAX_GRIDS: 4, HEAD: 16, REC: 32, MAX_VOXELS: 16 * 1024 * 1024, DIM0: 1000, SHADOW_DIM0: 0x100000, STRIDE: 4096, MAX_DRAWS: 2048,
  FOG_FLAG: 1, MEDIA_FLAG: 2, CAUSTIC_FLAG: 4,
});
const INF = 1e30;
const FOG_K = 3.912;
const clampi = (i, n) => (i < 0 ? 0 : i >= n ? n - 1 : i);

/** The extinction (1/m) of a fog that lets a black target be seen at the visibility V (m). */
export const fogSigma = (visibilityM) => FOG_K / Math.max(1e-3, visibilityM);
export const visibilityOf = (sigma) => FOG_K / Math.max(1e-9, sigma);

/** Henyey–Greenstein: cos θ = dot(travel direction, the new direction). Integrates to 1 over the sphere. */
export function hgPhase(c, g) {
  const d = 1 + g * g - 2 * g * c;
  return (1 - g * g) / (4 * Math.PI * Math.pow(Math.max(d, 1e-9), 1.5));
}
/** cos θ for a uniform u in [0, 1) (pdf = hgPhase). */
export function hgSampleCos(u, g) {
  if (Math.abs(g) < 1e-3) return 1 - 2 * u;
  const q = (1 - g * g) / (1 - g + 2 * g * u);
  return Math.max(-1, Math.min(1, (1 + g * g - q * q) / (2 * g)));
}

/** The frame about `up` the volume's box is turned in: e1, e2 square to up (the same convention as the kernels' basis()). */
function frameAbout(up) {
  const ax = Math.abs(up[2]) < 0.9 ? 0 : 1, az = Math.abs(up[2]) < 0.9 ? 1 : 0;
  let x = up[1] * az, y = up[2] * ax - up[0] * az, z = -up[1] * ax;
  const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
  const e1 = [x, y, z], e2 = [up[1] * z - up[2] * y, up[2] * x - up[0] * z, up[0] * y - up[1] * x];
  return { e1, e2 };
}

/**
 * The box of a grid in the world: its centre, the length of its longest side, a turn about `up` (degrees); the sides follow the
 * voxel counts (x, y across, z along up). Returns { rows: the world → object map as 3 rows (a, b, c, d), size: [sx, sy, sz] }.
 */
export function placeBox({ centre, size, nx, ny, nz, up, yaw = 0 }) {
  const m = Math.max(nx, ny, nz), s = [size * nx / m, size * ny / m, size * nz / m];
  const f = frameAbout(up), a = (yaw * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const ex = [0, 1, 2].map((k) => ca * f.e1[k] + sa * f.e2[k]), ey = [0, 1, 2].map((k) => -sa * f.e1[k] + ca * f.e2[k]);
  const axes = [ex, ey, up];
  const rows = axes.map((e, i) => [e[0] / s[i], e[1] / s[i], e[2] / s[i], 0.5 - (e[0] * centre[0] + e[1] * centre[1] + e[2] * centre[2]) / s[i]]);
  return { rows, size: s };
}

/**
 * The volume block (floats; ints as raw bits): § 6.9. Word 1 flags: 1 fog on, 2 the scene has media, 4 caustics (word 11 = the
 * offset, in the block, of the caustic data `caustic` = pt-caustic.js causticBlock, which follows the grids' densities).
 * Null when there is nothing to say.
 */
export function packVolumes({ up, fog = null, grids = [], caustic = null }) {
  grids = (grids || []).filter((g) => g && g.data && g.nx > 0 && g.ny > 0 && g.nz > 0).slice(0, VOL.MAX_GRIDS);
  const hasFog = !!(fog && fog.sigma > 0);
  if (!hasFog && !grids.length && !caustic) return null;
  let voxels = 0;
  for (const g of grids) voxels += g.nx * g.ny * g.nz;
  if (voxels > VOL.MAX_VOXELS) throw Object.assign(new Error('volume too large'), { code: 'volume_too_big' });   // i18n-ignore: caught by the caller
  const head = VOL.HEAD + VOL.REC * grids.length, cOff = head + voxels;
  const out = new Float32Array(cOff + (caustic ? caustic.length : 0)), u = new Uint32Array(out.buffer);
  u[0] = grids.length; u[1] = (hasFog ? VOL.FOG_FLAG : 0) | (hasFog || grids.length ? VOL.MEDIA_FLAG : 0) | (caustic ? VOL.CAUSTIC_FLAG : 0);
  if (hasFog) { out[2] = fog.sigma; out[3] = fog.top; out.set(fog.albedo || [1, 1, 1], 4); out[7] = Math.max(-0.95, Math.min(0.95, fog.g || 0)); }
  out.set([up[0], up[1], up[2]], 8);
  if (caustic) { u[11] = cOff; out.set(caustic, cOff); }
  let off = head;
  grids.forEach((g, i) => {
    const r = VOL.HEAD + VOL.REC * i;
    out.set(g.rows[0], r); out.set(g.rows[1], r + 4); out.set(g.rows[2], r + 8);
    out[r + 12] = g.nx; out[r + 13] = g.ny; out[r + 14] = g.nz; u[r + 15] = off;
    out.set(g.albedo || [1, 1, 1], r + 16); out[r + 19] = Math.max(-0.95, Math.min(0.95, g.g || 0));
    let mx = 0;
    const n = g.nx * g.ny * g.nz;
    for (let k = 0; k < n; k++) { const v = Math.max(0, g.data[k]); out[off + k] = v; if (v > mx) mx = v; }
    out[r + 20] = g.scale; out[r + 21] = mx;
    off += n;
  });
  return out;
}

/** The media of a packed scene: reads the block at V in `ldat` (a Float32Array). */
export function makeMedia(ldat, V) {
  if (!V) return null;
  const u = new Uint32Array(ldat.buffer, ldat.byteOffset, ldat.length), f = ldat;
  if (!(u[V + 1] & VOL.MEDIA_FLAG)) return null;
  const nG = u[V], fogOn = (u[V + 1] & VOL.FOG_FLAG) !== 0;
  const sigF = fogOn ? f[V + 2] : 0, top = f[V + 3], fogAlb = [f[V + 4], f[V + 5], f[V + 6]], fogG = f[V + 7];
  const up = [f[V + 8], f[V + 9], f[V + 10]];
  const G = [];
  for (let i = 0; i < nG; i++) {
    const r = V + VOL.HEAD + VOL.REC * i;
    G.push({ row: f.subarray(r, r + 12), nx: f[r + 12], ny: f[r + 13], nz: f[r + 14], off: V + u[r + 15], albedo: [f[r + 16], f[r + 17], f[r + 18]], g: f[r + 19], scale: f[r + 20], maxMajor: f[r + 20] * f[r + 21] });
  }
  // scratch, made once
  const ga = new Float64Array(VOL.MAX_GRIDS), gb = new Float64Array(VOL.MAX_GRIDS), pts = new Float64Array(2 * (VOL.MAX_GRIDS + 1) + 2);
  const op = [0, 0, 0], xw = [0, 0, 0], sg = new Float64Array(VOL.MAX_GRIDS);
  let fa = 0, fb = 0, nPts = 0;

  /** The trilinear density of a grid at the object-space point (x, y, z) in [0, 1]³ (cell-centred, clamped at the faces). */
  function rho(g, x, y, z) {
    const fx = x * g.nx - 0.5, fy = y * g.ny - 0.5, fz = z * g.nz - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz), tx = fx - x0, ty = fy - y0, tz = fz - z0;
    const nx = g.nx, ny = g.ny, nz = g.nz, o = g.off;
    const X0 = clampi(x0, nx), X1 = clampi(x0 + 1, nx), Y0 = clampi(y0, ny), Y1 = clampi(y0 + 1, ny), Z0 = clampi(z0, nz), Z1 = clampi(z0 + 1, nz);
    const a = o + Z0 * ny * nx, b = o + Z1 * ny * nx, r0 = Y0 * nx, r1 = Y1 * nx;
    const c00 = f[a + r0 + X0] * (1 - tx) + f[a + r0 + X1] * tx, c10 = f[a + r1 + X0] * (1 - tx) + f[a + r1 + X1] * tx;
    const c01 = f[b + r0 + X0] * (1 - tx) + f[b + r0 + X1] * tx, c11 = f[b + r1 + X0] * (1 - tx) + f[b + r1 + X1] * tx;
    return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
  }
  const toObj = (g, p, out) => { const r = g.row; for (let k = 0; k < 3; k++) out[k] = r[4 * k] * p[0] + r[4 * k + 1] * p[1] + r[4 * k + 2] * p[2] + r[4 * k + 3]; return out; };
  const sigGrid = (g, p) => { toObj(g, p, op); return g.scale * rho(g, op[0], op[1], op[2]); };

  /** The intervals the ray [0, tmax] is inside the fog layer and each box; the sorted breakpoints. */
  function gather(ro, rd, tmax) {
    nPts = 0;
    pts[nPts++] = 0; pts[nPts++] = tmax;
    fa = 1; fb = 0;
    if (sigF > 0) {
      const h0 = up[0] * ro[0] + up[1] * ro[1] + up[2] * ro[2], dz = up[0] * rd[0] + up[1] * rd[1] + up[2] * rd[2];
      let a = 1, b = 0;
      if (dz > 0) { if (h0 <= top) { a = 0; b = (top - h0) / dz; } }
      else if (dz < 0) { a = h0 <= top ? 0 : (top - h0) / dz; b = INF; }
      else if (h0 <= top) { a = 0; b = INF; }
      a = Math.max(a, 0); b = Math.min(b, tmax);
      if (a < b) { fa = a; fb = b; pts[nPts++] = a; pts[nPts++] = b; }
    }
    for (let i = 0; i < G.length; i++) {
      const g = G[i], r = g.row;
      let a = 0, b = tmax, ok = true;
      for (let k = 0; k < 3 && ok; k++) {
        const o = r[4 * k] * ro[0] + r[4 * k + 1] * ro[1] + r[4 * k + 2] * ro[2] + r[4 * k + 3], d = r[4 * k] * rd[0] + r[4 * k + 1] * rd[1] + r[4 * k + 2] * rd[2];
        if (Math.abs(d) < 1e-30) { if (o < 0 || o > 1) ok = false; continue; }
        let t1 = (0 - o) / d, t2 = (1 - o) / d;
        if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
        a = Math.max(a, t1); b = Math.min(b, t2);
        if (!(a < b)) ok = false;
      }
      if (ok && a < b) { ga[i] = a; gb[i] = b; pts[nPts++] = a; pts[nPts++] = b; } else { ga[i] = 1; gb[i] = 0; }
    }
    // insertion sort (≤ 10 points)
    for (let i = 1; i < nPts; i++) { const v = pts[i]; let j = i - 1; while (j >= 0 && pts[j] > v) { pts[j + 1] = pts[j]; j--; } pts[j + 1] = v; }
  }
  const fogIn = (p, q) => sigF > 0 && fa <= p && fb >= q && fa < fb;
  const gridIn = (i, p, q) => ga[i] <= p && gb[i] >= q && ga[i] < gb[i];

  /** Delta tracking: the first real collision on [0, tmax), or none. */
  function event(ro, rd, tmax, rnd, out) {
    gather(ro, rd, tmax);
    let draws = 0;
    for (let s = 0; s + 1 < nPts; s++) {
      const p = pts[s], q = pts[s + 1];
      if (!(q > p)) continue;
      const fogC = fogIn(p, q);
      let major = fogC ? sigF : 0;
      for (let i = 0; i < G.length; i++) if (gridIn(i, p, q)) major += G[i].maxMajor;
      if (!(major > 0)) continue;
      let t = p;
      for (;;) {
        if (draws >= VOL.MAX_DRAWS) return false;
        t += -Math.log(1 - rnd()) / major; draws++;
        if (t >= q) break;
        for (let k = 0; k < 3; k++) xw[k] = ro[k] + rd[k] * t;
        let st = fogC ? sigF : 0;
        for (let i = 0; i < G.length; i++) { sg[i] = gridIn(i, p, q) ? sigGrid(G[i], xw) : 0; st += sg[i]; }
        if (draws >= VOL.MAX_DRAWS) return false;
        const u2 = rnd(); draws++;
        if (!(u2 * major < st)) continue;
        // a real collision: whose? components in the order fog, box 0 … 3; a third draw only when more than one is non-zero
        let n = fogC ? 1 : 0, pick = -1;   // -1 = the fog
        for (let i = 0; i < G.length; i++) if (sg[i] > 0) { n++; if (!fogC || n > 1) pick = i; }
        if (n > 1) {
          if (draws >= VOL.MAX_DRAWS) return false;
          const uc = rnd() * st; draws++;
          let cum = 0, last = -1;
          pick = -2;
          if (fogC) { cum = sigF; if (uc < cum) pick = -1; }
          for (let i = 0; i < G.length && pick === -2; i++) if (sg[i] > 0) { last = i; cum += sg[i]; if (uc < cum) pick = i; }
          if (pick === -2) pick = last;
        }
        out.t = t;
        const a = pick < 0 ? fogAlb : G[pick].albedo;
        out.albedo[0] = a[0]; out.albedo[1] = a[1]; out.albedo[2] = a[2];
        out.g = pick < 0 ? fogG : G[pick].g;
        return true;
      }
    }
    return false;
  }

  /** The transmittance along [0, len]: the fog's exactly, the grids' by ratio tracking. */
  function transmit(ro, rd, len, rnd) {
    gather(ro, rd, len);
    let T = 1;
    if (sigF > 0 && fa < fb) T = Math.exp(-sigF * (fb - fa));
    if (!G.length) return T;
    let draws = 0;
    for (let s = 0; s + 1 < nPts; s++) {
      const p = pts[s], q = pts[s + 1];
      if (!(q > p)) continue;
      let major = 0;
      for (let i = 0; i < G.length; i++) if (gridIn(i, p, q)) major += G[i].maxMajor;
      if (!(major > 0)) continue;
      let t = p;
      for (;;) {
        if (draws >= VOL.MAX_DRAWS) return T;
        t += -Math.log(1 - rnd()) / major; draws++;
        if (t >= q) break;
        for (let k = 0; k < 3; k++) xw[k] = ro[k] + rd[k] * t;
        let st = 0;
        for (let i = 0; i < G.length; i++) if (gridIn(i, p, q)) st += sigGrid(G[i], xw);
        T *= Math.max(0, 1 - st / major);
      }
    }
    return T;
  }

  /** σ_t at a world point (tests): the fog layer plus every grid. */
  function sigmaAt(p) {
    let s = sigF > 0 && up[0] * p[0] + up[1] * p[1] + up[2] * p[2] <= top ? sigF : 0;
    for (const g of G) { toObj(g, p, op); if (op[0] >= 0 && op[0] <= 1 && op[1] >= 0 && op[1] <= 1 && op[2] >= 0 && op[2] <= 1) s += g.scale * rho(g, op[0], op[1], op[2]); }
    return s;
  }
  return { event, transmit, sigmaAt, grids: G.length, fog: sigF > 0, fogTop: top, up };
}

// ---- the .ccvol file: "CCVL", version 1, dtype (0 = bytes × ρmax / 255, 1 = f32), nx, ny, nz, ρmax, 0, then the samples ----
const CC_MAGIC = 0x4c564343;
export function writeCcvol(data, nx, ny, nz, { float = false } = {}) {
  const n = nx * ny * nz;
  if (data.length < n) throw Object.assign(new Error('short data'), { code: 'damaged' });   // i18n-ignore: a programming error
  let mx = 0;
  for (let i = 0; i < n; i++) if (data[i] > mx) mx = data[i];
  const out = new Uint8Array(32 + (float ? n * 4 : n)), v = new DataView(out.buffer);
  v.setUint32(0, CC_MAGIC, true); v.setUint32(4, 1, true); v.setUint32(8, float ? 1 : 0, true);
  v.setUint32(12, nx, true); v.setUint32(16, ny, true); v.setUint32(20, nz, true); v.setFloat32(24, mx || 1, true);
  if (float) for (let i = 0; i < n; i++) v.setFloat32(32 + i * 4, Math.max(0, data[i]), true);
  else for (let i = 0; i < n; i++) out[32 + i] = Math.max(0, Math.min(255, Math.round((Math.max(0, data[i]) / (mx || 1)) * 255)));
  return out;
}
export function readCcvol(bytes) {
  const bad = (code) => Object.assign(new Error('not a volume file: ' + code), { code });   // i18n-ignore: caught by the caller
  if (!bytes || bytes.length < 32) throw bad('not_ccvol');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, true) !== CC_MAGIC) throw bad('not_ccvol');
  if (v.getUint32(4, true) > 1) throw bad('too_new');
  const dtype = v.getUint32(8, true), nx = v.getUint32(12, true), ny = v.getUint32(16, true), nz = v.getUint32(20, true), mx = v.getFloat32(24, true);
  if (dtype > 1 || !(nx > 0 && ny > 0 && nz > 0) || !(mx > 0 && Number.isFinite(mx))) throw bad('damaged');
  const n = nx * ny * nz;
  if (!Number.isSafeInteger(n) || n > VOL.MAX_VOXELS) throw bad('too_big');
  if (bytes.length !== 32 + (dtype ? n * 4 : n)) throw bad('damaged');
  const data = new Float32Array(n);
  if (dtype) for (let i = 0; i < n; i++) { const x = v.getFloat32(32 + i * 4, true); data[i] = Number.isFinite(x) ? Math.max(0, x) : 0; }
  else for (let i = 0; i < n; i++) data[i] = (bytes[32 + i] / 255) * mx;
  return { nx, ny, nz, data };
}

// ---- procedural grids (deterministic; ρ in [0, 1], maximum 1) ----
const h3 = (x, y, z, seed) => {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647) + Math.imul(seed | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};
const smooth = (t) => t * t * (3 - 2 * t);
function vnoise(x, y, z, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z), tx = smooth(x - x0), ty = smooth(y - y0), tz = smooth(z - z0);
  let s = 0;
  for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) s += h3(x0 + i, y0 + j, z0 + k, seed) * (i ? tx : 1 - tx) * (j ? ty : 1 - ty) * (k ? tz : 1 - tz);
  return s;
}
const fbm = (x, y, z, seed) => { let a = 0.5, f = 1, s = 0; for (let o = 0; o < 4; o++) { s += a * vnoise(x * f, y * f, z * f, seed + o * 17); a *= 0.5; f *= 2; } return s; };
function normalise(d) { let mx = 0; for (let i = 0; i < d.length; i++) if (d[i] > mx) mx = d[i]; if (mx > 0) for (let i = 0; i < d.length; i++) d[i] /= mx; return d; }

/** A cumulus-like cloud filling the cube (n³): fractal noise cut off by an ellipsoid. */
export function cloudGrid(n = 48, seed = 1) {
  const d = new Float32Array(n * n * n);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n, y = (j + 0.5) / n, z = (k + 0.5) / n;
    const r = Math.hypot((x - 0.5) / 0.48, (y - 0.5) / 0.48, (z - 0.45) / 0.36);
    const base = Math.max(0, 1 - r * r), nz = fbm(x * 4, y * 4, z * 4, seed);
    d[(k * n + j) * n + i] = Math.max(0, (nz - 0.42) * 2.2) * Math.sqrt(base);
  }
  return normalise(d);
}
/** A column of smoke: dense at the foot, widening and thinning as it rises, torn by noise. */
export function plumeGrid(n = 48, seed = 1) {
  const d = new Float32Array(n * n * n);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n, y = (j + 0.5) / n, z = (k + 0.5) / n;
    const sway = 0.06 * Math.sin(z * 6.0 + seed), cx = 0.5 + sway, w = 0.07 + 0.2 * z;
    const r = Math.hypot(x - cx, y - 0.5) / w, core = Math.exp(-r * r * 2), nz = 0.35 + 1.3 * fbm(x * 5, y * 5, z * 5 - 1.5 * z, seed);
    d[(k * n + j) * n + i] = core * nz * (1 - 0.8 * z);
  }
  return normalise(d);
}
