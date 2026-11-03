/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-lights.js — the lights as the JS reference samples them (0.7 RN.3; RENDER-SPEC § 5.2, § 5.3, § 6.5, § 6.8). Reads the
 * `ldat` buffer and the header words pt-pack.js writes; pt-wgsl.js has the same functions line for line. No DOM; scratch
 * objects are made once per tracer (KICKOFF rule 18).
 *
 *   const LT = makeLights(pk, {P, emitted})        P = material params by index (pt-bsdf.js params), emitted = pt-bsdf emitted
 *   LT.pick(u) → writes PK = {i, prob, u}           the sky, the sun or a light of the tree (by importance at PK.p), with the
 *                                                   probability of that pick and the rest of u for the sky's own choice
 *   LT.sample(i, p, u, v, uRest, LS) → bool         LS = {wi, dist, L (radiance; sun: E/Ω), pdf (solid angle, the pick not in)}
 *   LT.pdf(i, p, wi, dist) → solid-angle pdf        LT.pickProb(i, p) → the pick probability of light i at p
 *   LT.env(dir, out)                                the sky's radiance in a direction (gradient, physical sky or picture)
 *   LT.lampHit(ro, rd, tmax, LH) → bool             the nearest lamp shape a ray meets (not triangles: they are geometry)
 *   LT.emit(i, u1, u2, u3, u4, E) → bool            RN.7 (caustics): a particle leaving light i — E = {pos, dir, n, alpha}, alpha = Le cos θ / (p_pos p_dir)
 *   LT.envIndex, LT.sunIndex, LT.count
 *
 * Kinds (§ 6.5): SUN (a cone of 0.75°), POINT / SPOT (a sphere sampled by the cone it subtends; SPOT × a smooth cone; with an
 * IES profile × its multiplier instead), AREA (a one-sided rectangle, by area), DISC (a one-sided disc, by area), TRI / TRI2 (an
 * emissive triangle, one- / two-sided, by area; its radiance is the material's emission at that angle), ENV (the sky: uniform
 * sphere for the gradient, the map's CDFs for a physical sky or a picture, and — when the scene has portals — half the samples
 * through a portal rectangle, the pdf being the mix of both).
 */
import { LIGHT_FLOATS, LIGHT, HW, IES_THETA, IES_PHI, PORTAL_FLOATS, LIGHT_SCALE } from './pt-spec.js';
import { importance } from './pt-lighttree.js';
import { gridLookup } from './pt-ies.js';

const INF = 1e30;

function basisInto(u, t, b) {
  let ax = 0, ay = 0, az = 1;
  if (!(Math.abs(u[2]) < 0.9)) { ax = 1; az = 0; }
  let x = u[1] * az - u[2] * ay, y = u[2] * ax - u[0] * az, z = u[0] * ay - u[1] * ax;
  const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
  t[0] = x; t[1] = y; t[2] = z;
  b[0] = u[1] * z - u[2] * y; b[1] = u[2] * x - u[0] * z; b[2] = u[0] * y - u[1] * x;
}

export function makeLights(pk, { P, emitted }) {
  const hb = ArrayBuffer.isView(pk.header) ? pk.header : new Uint8Array(pk.header);
  const hu = new Uint32Array(hb.buffer, hb.byteOffset, 128), hf = new Float32Array(hb.buffer, hb.byteOffset, 128);
  const D = pk.ldat, DU = new Uint32Array(D.buffer, D.byteOffset, D.length);
  const count = hu[5], nb = hu[HW.NBOUNDED], REC = hu[HW.LREC_OFF], META = hu[HW.LMETA_OFF], TREE = hu[HW.TREE_OFF], NTREE = hu[HW.TREE_N];
  const IES = hu[HW.IES_OFF], NPORT = hu[HW.PORTAL_N], PORT = hu[HW.PORTAL_OFF];
  const envIndex = hu[11] === 0xffffffff ? -1 : hu[11], sunIndex = hu[59] === 0xffffffff ? -1 : hu[59];
  const pEnv = hf[HW.P_ENV], pSun = hf[HW.P_SUN], pTree = hf[HW.P_TREE];
  const up = [hf[8], hf[9], hf[10]];
  const zen = [hf[48], hf[49], hf[50]], envI = hf[51], hor = [hf[52], hf[53], hf[54]], gnd = [hf[56], hf[57], hf[58]];
  const kind = hu[HW.ENV_KIND], MW = hu[HW.MAP_W], MH = hu[HW.MAP_H], MAP = hu[HW.MAP_OFF], MARG = hu[HW.MARG_OFF], COND = hu[HW.COND_OFF];
  const rot = hf[HW.ENV_ROT], envScale = hf[HW.ENV_SCALE];
  const treeNodes = new Float32Array(D.buffer, D.byteOffset + TREE * 4, NTREE * 16);
  const rec = (i, k) => D[REC + i * LIGHT_FLOATS + k];
  // the map's frame (θ from up, φ from e1 toward e2, turned by `rot`)
  const me1 = [0, 0, 0], me2 = [0, 0, 0];
  basisInto(up, me1, me2);
  if (rot) { const c = Math.cos(rot), s = Math.sin(rot); for (let k = 0; k < 3; k++) { const a = me1[k] * c + me2[k] * s, b = -me1[k] * s + me2[k] * c; me1[k] = a; me2[k] = b; } }
  // frames of the bounded lights, made once
  const F1 = new Float64Array(count * 3), F2 = new Float64Array(count * 3), tq = [0, 0, 0], tb = [0, 0, 0], ax = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const k = rec(i, 0);
    if (k === LIGHT.SUN) { ax[0] = rec(i, 4); ax[1] = rec(i, 5); ax[2] = rec(i, 6); }
    else { ax[0] = rec(i, 8); ax[1] = rec(i, 9); ax[2] = rec(i, 10); }
    if (!(Math.hypot(ax[0], ax[1], ax[2]) > 0)) ax[2] = 1;
    basisInto(ax, tq, tb);
    F1.set(tq, i * 3); F2.set(tb, i * 3);
  }

  // ---- the sky ----
  function envPixel(d) {
    const ct = Math.min(1, Math.max(-1, d[0] * up[0] + d[1] * up[1] + d[2] * up[2]));
    let phi = Math.atan2(d[0] * me2[0] + d[1] * me2[1] + d[2] * me2[2], d[0] * me1[0] + d[1] * me1[1] + d[2] * me1[2]);
    if (phi < 0) phi += 2 * Math.PI;
    return [(phi / (2 * Math.PI)) * MW, (Math.acos(ct) / Math.PI) * MH];
  }
  function env(d, out) {
    if (kind === 1) {
      const [x, y] = envPixel(d), i = Math.min(MW - 1, Math.max(0, Math.floor(x))), j = Math.min(MH - 1, Math.max(0, Math.floor(y))), o = MAP + (j * MW + i) * 4;
      out[0] = D[o] * envScale; out[1] = D[o + 1] * envScale; out[2] = D[o + 2] * envScale;
      return out;
    }
    const z = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
    if (z >= 0) { const f = Math.pow(z, 0.6); for (let k = 0; k < 3; k++) out[k] = (hor[k] + (zen[k] - hor[k]) * f) * envI; }
    else { const f = Math.pow(-z, 0.4); for (let k = 0; k < 3; k++) out[k] = (hor[k] + (gnd[k] - hor[k]) * f) * envI; }
    return out;
  }
  const findCdf = (off, n, u) => { let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (D[off + m + 1] > u) hi = m; else lo = m + 1; } return lo; };
  function envGlobalPdf(d) {
    if (kind !== 1) return 1 / (4 * Math.PI);
    const [x, y] = envPixel(d), i = Math.min(MW - 1, Math.max(0, Math.floor(x))), j = Math.min(MH - 1, Math.max(0, Math.floor(y)));
    const pj = D[MARG + j + 1] - D[MARG + j], o = COND + j * (MW + 1), pi = D[o + i + 1] - D[o + i], st = Math.sin((Math.PI * y) / MH);
    return st > 0 ? (pj * pi * MW * MH) / (2 * Math.PI * Math.PI * st) : 0;
  }
  function envGlobalSample(u, v, out) {
    if (kind !== 1) {
      const z = 1 - 2 * u, r = Math.sqrt(Math.max(0, 1 - z * z)), ph = 2 * Math.PI * v;
      out[0] = r * Math.cos(ph); out[1] = r * Math.sin(ph); out[2] = z;
      return;
    }
    const j = findCdf(MARG, MH, u), pj = D[MARG + j + 1] - D[MARG + j], fy = pj > 0 ? (u - D[MARG + j]) / pj : 0.5;
    const o = COND + j * (MW + 1), i = findCdf(o, MW, v), pi = D[o + i + 1] - D[o + i], fx = pi > 0 ? (v - D[o + i]) / pi : 0.5;
    const phi = (2 * Math.PI * (i + fx)) / MW, th = (Math.PI * (j + fy)) / MH, st = Math.sin(th), ct = Math.cos(th), cp = Math.cos(phi), sp = Math.sin(phi);
    for (let k = 0; k < 3; k++) out[k] = me1[k] * cp * st + me2[k] * sp * st + up[k] * ct;
  }
  // portals: a ray from p along d through portal k → the solid-angle pdf of sampling that point by area
  const pq = [0, 0, 0];
  function portalPdf(p, d) {
    let sum = 0;
    for (let k = 0; k < NPORT; k++) {
      const o = PORT + k * PORTAL_FLOATS;
      const ax0 = D[o + 4], ay0 = D[o + 5], az0 = D[o + 6], bx = D[o + 8], by = D[o + 9], bz = D[o + 10];
      let nx = ay0 * bz - az0 * by, ny = az0 * bx - ax0 * bz, nz = ax0 * by - ay0 * bx;
      const A = Math.hypot(nx, ny, nz); if (!(A > 0)) continue;
      nx /= A; ny /= A; nz /= A;
      const dn = d[0] * nx + d[1] * ny + d[2] * nz;
      if (Math.abs(dn) < 1e-9) continue;
      const t = ((D[o] - p[0]) * nx + (D[o + 1] - p[1]) * ny + (D[o + 2] - p[2]) * nz) / dn;
      if (!(t > 0)) continue;
      pq[0] = p[0] + d[0] * t - D[o]; pq[1] = p[1] + d[1] * t - D[o + 1]; pq[2] = p[2] + d[2] * t - D[o + 2];
      const s = (pq[0] * ax0 + pq[1] * ay0 + pq[2] * az0) / (ax0 * ax0 + ay0 * ay0 + az0 * az0), q = (pq[0] * bx + pq[1] * by + pq[2] * bz) / (bx * bx + by * by + bz * bz);
      if (s < 0 || s > 1 || q < 0 || q > 1) continue;
      sum += (t * t) / (A * Math.abs(dn));
    }
    return sum / NPORT;
  }
  const envPdf = (p, d) => (NPORT ? 0.5 * envGlobalPdf(d) + 0.5 * portalPdf(p, d) : envGlobalPdf(d));
  function envSample(p, u, v, uRest, LS) {
    if (NPORT && uRest < 0.5) {
      const k = Math.min(NPORT - 1, Math.floor((uRest / 0.5) * NPORT)), o = PORT + k * PORTAL_FLOATS;
      const x = D[o] + D[o + 4] * u + D[o + 8] * v - p[0], y = D[o + 1] + D[o + 5] * u + D[o + 9] * v - p[1], z = D[o + 2] + D[o + 6] * u + D[o + 10] * v - p[2];
      const l = Math.hypot(x, y, z); if (!(l > 0)) return false;
      LS.wi[0] = x / l; LS.wi[1] = y / l; LS.wi[2] = z / l;
    } else envGlobalSample(u, v, LS.wi);
    env(LS.wi, LS.L); LS.dist = INF; LS.pdf = envPdf(p, LS.wi);
    return LS.pdf > 0;
  }

  // ---- picking ----
  const PK = { i: -1, prob: 0, u: 0, p: [0, 0, 0] };
  const U32 = new Uint32Array(treeNodes.buffer, treeNodes.byteOffset, treeNodes.length);
  /** Pick at point p with u: the sky, the sun or a light of the tree. */
  function pick(p, u) {
    PK.i = -1; PK.prob = 0;
    if (u < pEnv && envIndex >= 0) { PK.i = envIndex; PK.prob = pEnv; PK.u = u / pEnv; return PK; }
    if (u < pEnv + pSun && sunIndex >= 0) { PK.i = sunIndex; PK.prob = pSun; PK.u = (u - pEnv) / pSun; return PK; }
    if (!(pTree > 0) || !NTREE) return PK;
    let uu = Math.min(0.99999994, (u - pEnv - pSun) / pTree), ni = 0, prob = pTree;
    if (!(importance(treeNodes, 0, p, null) > 0)) return PK;
    for (;;) {
      const o = ni * 16;
      if (U32[o + 13] & 1) { PK.i = U32[o + 12]; PK.prob = prob; PK.u = uu; return PK; }
      const c = U32[o + 12], il = importance(treeNodes, c, p, null), ir = importance(treeNodes, c + 1, p, null);
      if (!(il + ir > 0)) return PK;
      const pl = il / (il + ir);
      if (uu < pl) { uu /= pl; ni = c; prob *= pl; } else { uu = (uu - pl) / (1 - pl); ni = c + 1; prob *= 1 - pl; }
      uu = Math.min(uu, 0.99999994);
    }
  }
  function pickProb(i, p) {
    if (i === envIndex) return pEnv;
    if (i === sunIndex) return pSun;
    if (i < 0 || i >= nb || !NTREE) return 0;
    if (!(importance(treeNodes, 0, p, null) > 0)) return 0;
    const bits = DU[META + i * 4], depth = DU[META + i * 4 + 1];
    let ni = 0, prob = pTree;
    for (let k = 0; k < depth; k++) {
      const c = U32[ni * 16 + 12], il = importance(treeNodes, c, p, null), ir = importance(treeNodes, c + 1, p, null);
      if (!(il + ir > 0)) return 0;
      const right = (bits >>> k) & 1;
      prob *= right ? ir / (il + ir) : il / (il + ir);
      ni = c + right;
    }
    return prob;
  }

  // ---- one light ----
  const oneMinusCos = (s2, c) => s2 / (1 + c);
  const spotFall = (i, dx, dy, dz) => {
    const c = rec(i, 8) * dx + rec(i, 9) * dy + rec(i, 10) * dz, c0 = rec(i, 11), c1 = Math.cos(Math.acos(c0) * (1 - rec(i, 15)));
    if (c <= c0) return 0;
    if (c >= c1) return 1;
    const x = (c - c0) / (c1 - c0);
    return x * x * (3 - 2 * x);
  };
  /** The IES multiplier of light i toward (dx, dy, dz) (from the lamp to the point), 1 without a profile. */
  const iesGrid = (g) => new Float32Array(D.buffer, D.byteOffset + (IES + g * IES_THETA * IES_PHI) * 4, IES_THETA * IES_PHI);
  const IESG = [];
  function iesMul(i, dx, dy, dz) {
    const g = DU[META + i * 4 + 2];
    if (g === 0xffffffff) return 1;
    const a1 = F1.subarray(i * 3, i * 3 + 3), a2 = F2.subarray(i * 3, i * 3 + 3);
    const cosT = rec(i, 8) * dx + rec(i, 9) * dy + rec(i, 10) * dz;
    const phi = Math.atan2(a2[0] * dx + a2[1] * dy + a2[2] * dz, a1[0] * dx + a1[1] * dy + a1[2] * dz);
    return gridLookup(IESG[g] ||= iesGrid(g), IES_THETA, IES_PHI, cosT, phi);
  }
  const em = [0, 0, 0];
  function sample(i, p, u, v, uRest, LS) {
    const k = rec(i, 0);
    if (k === LIGHT.ENV) return envSample(p, u, v, uRest, LS);
    if (k === LIGHT.SUN) {
      const omc = 1 - rec(i, 7), ct = 1 - u * omc, st = Math.sqrt(Math.max(0, 1 - ct * ct)), ph = 2 * Math.PI * v, cp = Math.cos(ph), sp = Math.sin(ph), o = i * 3;
      for (let c = 0; c < 3; c++) LS.wi[c] = rec(i, 4 + c) * ct + (F1[o + c] * cp + F2[o + c] * sp) * st;
      const omega = 2 * Math.PI * omc;
      for (let c = 0; c < 3; c++) LS.L[c] = rec(i, 12 + c) / omega;
      LS.dist = INF; LS.pdf = 1 / omega;
      return true;
    }
    if (k === LIGHT.AREA || k === LIGHT.DISC || k === LIGHT.TRI || k === LIGHT.TRI2) {
      let qx, qy, qz, nx, ny, nz, A;
      if (k === LIGHT.TRI || k === LIGHT.TRI2) {
        const su = Math.sqrt(u), b1 = 1 - su, b2 = v * su;
        const e1x = rec(i, 8), e1y = rec(i, 9), e1z = rec(i, 10), e2x = rec(i, 1), e2y = rec(i, 2), e2z = rec(i, 3);
        qx = rec(i, 4) + e1x * b1 + e2x * b2; qy = rec(i, 5) + e1y * b1 + e2y * b2; qz = rec(i, 6) + e1z * b1 + e2z * b2;
        nx = e1y * e2z - e1z * e2y; ny = e1z * e2x - e1x * e2z; nz = e1x * e2y - e1y * e2x;
        const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l; A = rec(i, 7);
      } else {
        const o = i * 3;
        nx = rec(i, 8); ny = rec(i, 9); nz = rec(i, 10);
        let a, b;
        if (k === LIGHT.AREA) { a = (u - 0.5) * rec(i, 7); b = (v - 0.5) * rec(i, 11); A = rec(i, 7) * rec(i, 11); }
        else { const r = rec(i, 7) * Math.sqrt(u), ph = 2 * Math.PI * v; a = r * Math.cos(ph); b = r * Math.sin(ph); A = Math.PI * rec(i, 7) * rec(i, 7); }
        qx = rec(i, 4) + F1[o] * a + F2[o] * b; qy = rec(i, 5) + F1[o + 1] * a + F2[o + 1] * b; qz = rec(i, 6) + F1[o + 2] * a + F2[o + 2] * b;
      }
      let dx = qx - p[0], dy = qy - p[1], dz = qz - p[2];
      const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2);
      if (!(d > 0)) return false;
      dx /= d; dy /= d; dz /= d;
      let cl = -(dx * nx + dy * ny + dz * nz);
      if (k === LIGHT.TRI2) cl = Math.abs(cl);
      if (cl <= 0) return false;
      LS.wi[0] = dx; LS.wi[1] = dy; LS.wi[2] = dz; LS.dist = d; LS.pdf = d2 / (A * cl);
      if (k === LIGHT.TRI || k === LIGHT.TRI2) { emitted(P[rec(i, 11)], cl, LIGHT_SCALE, em); LS.L[0] = em[0]; LS.L[1] = em[1]; LS.L[2] = em[2]; }
      else { LS.L[0] = rec(i, 12); LS.L[1] = rec(i, 13); LS.L[2] = rec(i, 14); }
      return true;
    }
    // point / spot: the cone the sphere subtends
    const r = rec(i, 7);
    let tx = rec(i, 4) - p[0], ty = rec(i, 5) - p[1], tz = rec(i, 6) - p[2];
    const d2 = tx * tx + ty * ty + tz * tz, d = Math.sqrt(d2);
    if (d <= r) return false;
    tx /= d; ty /= d; tz /= d;
    const s2 = (r * r) / d2, cm = Math.sqrt(Math.max(0, 1 - s2)), omc = oneMinusCos(s2, cm);
    const ct = 1 - u * omc, st = Math.sqrt(Math.max(0, 1 - ct * ct)), ph = 2 * Math.PI * v, cp = Math.cos(ph), sp = Math.sin(ph);
    tq[0] = tx; tq[1] = ty; tq[2] = tz;
    basisInto(tq, ax, tb);
    for (let c = 0; c < 3; c++) LS.wi[c] = tq[c] * ct + (ax[c] * cp + tb[c] * sp) * st;
    const b = d * ct, disc = r * r - (d2 - b * b);
    LS.dist = b - Math.sqrt(Math.max(0, disc));
    const f = (k === LIGHT.SPOT ? spotFall(i, -tx, -ty, -tz) : 1) * iesMul(i, -tx, -ty, -tz);
    if (f <= 0) return false;
    for (let c = 0; c < 3; c++) LS.L[c] = rec(i, 12 + c) * f;
    LS.pdf = 1 / (2 * Math.PI * omc);
    return true;
  }
  function pdf(i, p, wi, dist) {
    const k = rec(i, 0);
    if (k === LIGHT.ENV) return envPdf(p, wi);
    if (k === LIGHT.SUN) return 1 / (2 * Math.PI * (1 - rec(i, 7)));
    if (k === LIGHT.AREA || k === LIGHT.DISC) {
      const cl = -(wi[0] * rec(i, 8) + wi[1] * rec(i, 9) + wi[2] * rec(i, 10)), A = k === LIGHT.AREA ? rec(i, 7) * rec(i, 11) : Math.PI * rec(i, 7) * rec(i, 7);
      return cl > 0 ? (dist * dist) / (A * cl) : 0;
    }
    if (k === LIGHT.TRI || k === LIGHT.TRI2) {
      const e1x = rec(i, 8), e1y = rec(i, 9), e1z = rec(i, 10), e2x = rec(i, 1), e2y = rec(i, 2), e2z = rec(i, 3);
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      let cl = -(wi[0] * nx + wi[1] * ny + wi[2] * nz);
      if (k === LIGHT.TRI2) cl = Math.abs(cl);
      return cl > 0 ? (dist * dist) / (rec(i, 7) * cl) : 0;
    }
    const r = rec(i, 7), dx = rec(i, 4) - p[0], dy = rec(i, 5) - p[1], dz = rec(i, 6) - p[2], d2 = dx * dx + dy * dy + dz * dz;
    if (d2 <= r * r) return 0;
    const s2 = (r * r) / d2;
    return 1 / (2 * Math.PI * oneMinusCos(s2, Math.sqrt(Math.max(0, 1 - s2))));
  }

  // ---- lamp shapes along a ray: the tree as a ray BVH (sphere, rectangle and disc lamps; triangles are geometry) ----
  const stack = new Int32Array(64);
  function lampHit(ro, rd, tmax, LH) {
    LH.i = -1; LH.t = tmax;
    if (!NTREE) return false;
    const ix = 1 / (rd[0] || 1e-30), iy = 1 / (rd[1] || 1e-30), iz = 1 / (rd[2] || 1e-30);
    let sp = 0;
    stack[sp++] = 0;
    while (sp) {
      const ni = stack[--sp], o = ni * 16;
      // slab test on the node's bounds
      let t0 = (treeNodes[o] - ro[0]) * ix, t1 = (treeNodes[o + 4] - ro[0]) * ix;
      let lo = Math.min(t0, t1), hi = Math.max(t0, t1);
      t0 = (treeNodes[o + 1] - ro[1]) * iy; t1 = (treeNodes[o + 5] - ro[1]) * iy; lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      t0 = (treeNodes[o + 2] - ro[2]) * iz; t1 = (treeNodes[o + 6] - ro[2]) * iz; lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      if (!(hi >= Math.max(lo, 0) && lo < LH.t)) continue;
      if (!(U32[o + 13] & 1)) { if (sp < 63) { stack[sp++] = U32[o + 12]; stack[sp++] = U32[o + 12] + 1; } continue; }
      const i = U32[o + 12], k = rec(i, 0);
      if (k === LIGHT.POINT || k === LIGHT.SPOT) {
        const r = rec(i, 7), ox = ro[0] - rec(i, 4), oy = ro[1] - rec(i, 5), oz = ro[2] - rec(i, 6);
        const b = ox * rd[0] + oy * rd[1] + oz * rd[2], c = ox * ox + oy * oy + oz * oz - r * r, disc = b * b - c;
        if (disc < 0 || c <= 0) continue;
        const t = -b - Math.sqrt(disc);
        if (t > 0 && t < LH.t) {
          const f = (k === LIGHT.SPOT ? spotFall(i, -rd[0], -rd[1], -rd[2]) : 1) * iesMul(i, -rd[0], -rd[1], -rd[2]);
          LH.i = i; LH.t = t; for (let c2 = 0; c2 < 3; c2++) LH.L[c2] = rec(i, 12 + c2) * f;
        }
      } else if (k === LIGHT.AREA || k === LIGHT.DISC) {
        const nx = rec(i, 8), ny = rec(i, 9), nz = rec(i, 10), nd = rd[0] * nx + rd[1] * ny + rd[2] * nz;
        if (nd >= 0) continue;   // one-sided: seen from the front only
        const t = ((rec(i, 4) - ro[0]) * nx + (rec(i, 5) - ro[1]) * ny + (rec(i, 6) - ro[2]) * nz) / nd;
        if (!(t > 0 && t < LH.t)) continue;
        const qx = ro[0] + rd[0] * t - rec(i, 4), qy = ro[1] + rd[1] * t - rec(i, 5), qz = ro[2] + rd[2] * t - rec(i, 6), oo = i * 3;
        const a = qx * F1[oo] + qy * F1[oo + 1] + qz * F1[oo + 2], b = qx * F2[oo] + qy * F2[oo + 1] + qz * F2[oo + 2];
        if (k === LIGHT.AREA ? Math.abs(a) > rec(i, 7) / 2 || Math.abs(b) > rec(i, 11) / 2 : a * a + b * b > rec(i, 7) * rec(i, 7)) continue;
        LH.i = i; LH.t = t; LH.L[0] = rec(i, 12); LH.L[1] = rec(i, 13); LH.L[2] = rec(i, 14);
      }
    }
    return LH.i >= 0;
  }
  /** The direction factor of a sphere lamp toward (dx, dy, dz) from it (spot cone × IES profile; 1 for others). */
  const factor = (i, dx, dy, dz) => { const k = rec(i, 0); return k === LIGHT.POINT || k === LIGHT.SPOT ? (k === LIGHT.SPOT ? spotFall(i, dx, dy, dz) : 1) * iesMul(i, dx, dy, dz) : 1; };

  // ---- emission (RN.7, caustics by light tracing; RENDER-SPEC § 3.3): a particle leaving light i ----
  // E = {pos, dir (the way the light flows), n (the emitter's normal, or null), alpha (rgb) = Le cos θ / (p_pos · p_dir)} for the
  // radiometry `sample` uses: the sun's irradiance E over a disc of the scene's size square to its axis, a sphere lamp's
  // intensity L π r² f(ω) over the sphere (or the spot's cone), a rectangle / disc by area with cosine-weighted directions,
  // an emissive triangle by area (two-sided: a side first). The pick probability of the light is the caller's.
  const ER = { R: hf[15], C: [hf[12], hf[13], hf[14]] }, wi0 = [0, 0, 0];
  function emit(i, u1, u2, u3, u4, E) {
    const k = rec(i, 0), o = i * 3;
    if (k === LIGHT.SUN) {
      const omc = 1 - rec(i, 7), ct = 1 - u3 * omc, st = Math.sqrt(Math.max(0, 1 - ct * ct)), ph = 2 * Math.PI * u4, cp = Math.cos(ph), sp = Math.sin(ph);
      const Rd = 1.05 * ER.R, r = Rd * Math.sqrt(u1), a = 2 * Math.PI * u2, ca = Math.cos(a), sa = Math.sin(a);
      for (let c = 0; c < 3; c++) {
        const w = rec(i, 4 + c) * ct + (F1[o + c] * cp + F2[o + c] * sp) * st;   // toward the sun
        E.dir[c] = -w;
        E.pos[c] = ER.C[c] + rec(i, 4 + c) * Rd + (F1[o + c] * ca + F2[o + c] * sa) * r;
        E.alpha[c] = rec(i, 12 + c) * Math.PI * Rd * Rd * ct;
      }
      E.n = null;
      return true;
    }
    if (k === LIGHT.POINT || k === LIGHT.SPOT) {
      const spot = k === LIGHT.SPOT, omc = spot ? 1 - rec(i, 11) : 2, omega = spot ? 2 * Math.PI * omc : 4 * Math.PI;
      const ct = spot ? 1 - u3 * omc : 1 - 2 * u3, st = Math.sqrt(Math.max(0, 1 - ct * ct)), ph = 2 * Math.PI * u4, cp = Math.cos(ph), sp = Math.sin(ph);
      for (let c = 0; c < 3; c++) { E.dir[c] = rec(i, 8 + c) * ct + (F1[o + c] * cp + F2[o + c] * sp) * st; E.pos[c] = rec(i, 4 + c); }
      const f = factor(i, E.dir[0], E.dir[1], E.dir[2]);
      if (!(f > 0)) return false;
      const r = rec(i, 7), w = Math.PI * r * r * f * omega;
      for (let c = 0; c < 3; c++) E.alpha[c] = rec(i, 12 + c) * w;
      E.n = null;
      return true;
    }
    // surfaces: a point, then a cosine-weighted direction about the emitting side
    let A, nx, ny, nz, side = 1, uu = u3;
    if (k === LIGHT.TRI || k === LIGHT.TRI2) {
      const su = Math.sqrt(u1), b1 = 1 - su, b2 = u2 * su;
      const e1x = rec(i, 8), e1y = rec(i, 9), e1z = rec(i, 10), e2x = rec(i, 1), e2y = rec(i, 2), e2z = rec(i, 3);
      E.pos[0] = rec(i, 4) + e1x * b1 + e2x * b2; E.pos[1] = rec(i, 5) + e1y * b1 + e2y * b2; E.pos[2] = rec(i, 6) + e1z * b1 + e2z * b2;
      nx = e1y * e2z - e1z * e2y; ny = e1z * e2x - e1x * e2z; nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l; A = rec(i, 7);
      if (k === LIGHT.TRI2) { if (u3 < 0.5) uu = u3 * 2; else { uu = (u3 - 0.5) * 2; side = -1; } }
    } else if (k === LIGHT.AREA || k === LIGHT.DISC) {
      nx = rec(i, 8); ny = rec(i, 9); nz = rec(i, 10);
      let a, b;
      if (k === LIGHT.AREA) { a = (u1 - 0.5) * rec(i, 7); b = (u2 - 0.5) * rec(i, 11); A = rec(i, 7) * rec(i, 11); }
      else { const r = rec(i, 7) * Math.sqrt(u1), ph = 2 * Math.PI * u2; a = r * Math.cos(ph); b = r * Math.sin(ph); A = Math.PI * rec(i, 7) * rec(i, 7); }
      for (let c = 0; c < 3; c++) E.pos[c] = rec(i, 4 + c) + F1[o + c] * a + F2[o + c] * b;
    } else return false;
    nx *= side; ny *= side; nz *= side;
    tq[0] = nx; tq[1] = ny; tq[2] = nz;
    basisInto(tq, ax, tb);
    const r = Math.sqrt(uu), ph = 2 * Math.PI * u4, z = Math.sqrt(Math.max(0, 1 - uu));
    for (let c = 0; c < 3; c++) E.dir[c] = ax[c] * r * Math.cos(ph) + tb[c] * r * Math.sin(ph) + tq[c] * z;
    const nb2 = E.nbuf || (E.nbuf = [0, 0, 0]);
    nb2[0] = nx; nb2[1] = ny; nb2[2] = nz; E.n = nb2;
    if (k === LIGHT.TRI || k === LIGHT.TRI2) { emitted(P[rec(i, 11)], Math.max(1e-4, z), LIGHT_SCALE, em); for (let c = 0; c < 3; c++) E.alpha[c] = em[c] * Math.PI * A * (k === LIGHT.TRI2 ? 2 : 1); }
    else for (let c = 0; c < 3; c++) E.alpha[c] = rec(i, 12 + c) * Math.PI * A;
    return true;
  }
  /** RN.6: a light's group (light mixing): the meta block's word 3. */
  const groupOf = (i) => (i >= 0 && i < count ? DU[META + i * 4 + 3] : 0);
  return { count, envIndex, sunIndex, nBounded: nb, factor, rec, groupOf, emit, pick: (p, u) => { PK.p = p; return pick(p, u); }, pickProb, sample, pdf, env, lampHit, envPdf, portals: NPORT };
}
