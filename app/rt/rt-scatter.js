/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-scatter.js — scatter plants, rocks and people over an area (0.7 RT.5, session `realtime`). DOM-free (Node tests, pool
 * workers). Canonical in modelcraft/dev/rt/ (tools/rt/sync.mjs). The same set and seed always give the same instances.
 *
 *   SCATTER_DEFAULTS, cleanScatter(o) → a scatter set (untrusted input from a file: every field checked)
 *     { id, name, items: [{slug, weight}] (entourage slugs), density (per m²), scale: [min, max], rotate (degrees of turn about
 *       up, 0–360), tilt (0 upright … 1 square to the surface), slope (largest slope in degrees), height: [min | null, max | null]
 *       (metres along up), clearance (metres kept from other objects; 0 = off), seed, mode 'fill' | 'paint',
 *       strokes: [[x, y, z, r]] (paint: brush dabs, world metres), target: app data naming the faces (the adapter resolves it) }
 *   scatter(set, {tris, up, bvh, budget, slugs}) → {count, matrices: Float32Array(count·16), item: Uint16Array(count), wanted}
 *     tris: the target's world triangles (Float64Array, 9 per triangle); fill = area-weighted points on them; paint = points in
 *     each dab's disc (square to up) dropped onto those triangles (or onto anything in bvh when there is no target);
 *     bvh: compute/bvh-scene.js scene of everything else (for clearance), or null; boxes: those objects' world boxes [{min, max}]
 *     (optional: only points near a box cast clearance rays, so open ground costs nothing); budget: the tier's instance count
 *     (compute/probe.js TIER_DEFAULTS[tier].instances): `wanted` says how many the density asked for, `count` ≤ budget;
 *     slugs: the order of items the `item` indices point into (set.items' slugs by default)
 *   Instances are made in a random order over the whole area, so a budget keeps an even thinning, never one corner.
 *   Matrices place an entourage item (millimetres, Z up, origin at its foot) in the world: × scale / 1000, turned about up.
 */
import { basis } from '../render/looks.js';
import { sceneHit } from '../compute/bvh-scene.js';

export const SCATTER_DEFAULTS = Object.freeze({
  name: '', items: [{ slug: 'grass-tuft', weight: 1 }], density: 4, scale: [0.8, 1.2], rotate: 360, tilt: 0, slope: 35,
  height: [null, null], clearance: 0.3, seed: 1, mode: 'fill', strokes: [], target: null,
});
export const MAX_STROKES = 4000, MAX_DENSITY = 400, MAX_INSTANCES = 2000000;

const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const SLUG = /^[a-z0-9-]{1,64}$/;

export function cleanScatter(o, n = 0) {
  o = o && typeof o === 'object' ? o : {};
  const D = SCATTER_DEFAULTS;
  const items = (Array.isArray(o.items) ? o.items : []).filter((x) => x && SLUG.test(x.slug)).slice(0, 32).map((x) => ({ slug: x.slug, weight: num(x.weight, 0, 100, 1) }));
  const sc = Array.isArray(o.scale) ? o.scale : D.scale;
  const s0 = num(sc[0], 0.05, 20, 0.8), s1 = num(sc[1], 0.05, 20, 1.2);
  const h = Array.isArray(o.height) ? o.height : [null, null];
  const hv = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1e6, Math.max(-1e6, v)) : null);
  return {
    id: typeof o.id === 'string' && /^[\w-]{1,40}$/.test(o.id) ? o.id : 's' + (n + 1),
    name: typeof o.name === 'string' ? o.name.replace(/[\u0000-\u001f]/g, '').slice(0, 80) : '',
    items: items.length ? items : D.items.map((x) => ({ ...x })),
    density: num(o.density, 0.001, MAX_DENSITY, D.density),
    scale: [Math.min(s0, s1), Math.max(s0, s1)],
    rotate: num(o.rotate, 0, 360, D.rotate), tilt: num(o.tilt, 0, 1, D.tilt), slope: num(o.slope, 0, 90, D.slope),
    height: [hv(h[0]), hv(h[1])], clearance: num(o.clearance, 0, 100, D.clearance), seed: Math.round(num(o.seed, 0, 2 ** 31, 1)),
    mode: o.mode === 'paint' ? 'paint' : 'fill',
    strokes: (Array.isArray(o.strokes) ? o.strokes : []).filter((s) => Array.isArray(s) && s.length === 4 && s.every(Number.isFinite) && s[3] > 0).slice(0, MAX_STROKES).map((s) => [s[0], s[1], s[2], Math.min(1000, s[3])]),
    target: o.target === undefined ? null : o.target,
  };
}

/** A small fast seeded generator (sfc32), floats in [0, 1). */
function rng(seed) {
  let a = 0x9e3779b9 ^ seed, b = 0x243f6a88, c = 0xb7e15162, d = seed >>> 0;
  const next = () => { a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0; let t = (a + b) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0; return (t >>> 0) / 4294967296; };
  for (let i = 0; i < 12; i++) next();
  return next;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function scatter(set, { tris = null, up = [0, 0, 1], bvh = null, boxes = null, budget = 20000, slugs = null } = {}) {
  const S = cleanScatter(set);
  const U = basis(up).up, { e1, e2 } = basis(U);
  const R = rng(S.seed);
  const order = slugs || S.items.map((x) => x.slug);
  const wsum = S.items.reduce((s, x) => s + x.weight, 0) || 1;
  const pick = () => { let u = R() * wsum; for (const x of S.items) { u -= x.weight; if (u <= 0) return Math.max(0, order.indexOf(x.slug)); } return Math.max(0, order.indexOf(S.items[S.items.length - 1].slug)); };
  const nT = tris ? Math.floor(tris.length / 9) : 0;
  // triangle areas and normals (fill: the area CDF; paint: a ray against the target)
  const cdf = new Float64Array(nT), nrm = new Float64Array(nT * 3);
  let area = 0;
  for (let i = 0; i < nT; i++) {
    const o = i * 9;
    const ax = tris[o + 3] - tris[o], ay = tris[o + 4] - tris[o + 1], az = tris[o + 5] - tris[o + 2];
    const bx = tris[o + 6] - tris[o], by = tris[o + 7] - tris[o + 1], bz = tris[o + 8] - tris[o + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx, l = Math.hypot(cx, cy, cz);
    area += l / 2; cdf[i] = area;
    let nx = cx / (l || 1), ny = cy / (l || 1), nz = cz / (l || 1);
    if (nx * U[0] + ny * U[1] + nz * U[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }   // faces scatter on their upper side
    nrm[i * 3] = nx; nrm[i * 3 + 1] = ny; nrm[i * 3 + 2] = nz;
  }
  let candidates = 0;
  if (S.mode === 'fill') candidates = Math.round(area * S.density);
  else for (const s of S.strokes) candidates += Math.max(1, Math.round(Math.PI * s[3] * s[3] * S.density));
  const wanted = Math.min(MAX_INSTANCES, candidates);
  const cap = Math.min(wanted, Math.max(0, budget | 0));
  const matrices = new Float32Array(cap * 16), item = new Uint16Array(cap);
  const cosMax = Math.cos((S.slope * Math.PI) / 180);
  const hit = { t: 0, slot: -1, mesh: -1, tri: -1, inst: -1, u: 0, v: 0 };
  const p = [0, 0, 0], n = [0, 0, 0];
  // a point on the target under (x, y, z) along −up (paint), into p and n; false when there is none
  const drop = (x, y, z) => {
    const from = [x + U[0] * 1000, y + U[1] * 1000, z + U[2] * 1000], dir = [-U[0], -U[1], -U[2]];
    if (nT) {
      let best = Infinity, bi = -1;
      for (let i = 0; i < nT; i++) {
        const t = rayTri(tris, i * 9, from, dir);
        if (t > 0 && t < best) { best = t; bi = i; }
      }
      if (bi < 0) return false;
      for (let k = 0; k < 3; k++) { p[k] = from[k] + dir[k] * best; n[k] = nrm[bi * 3 + k]; }
      return true;
    }
    if (!bvh || !sceneHit(bvh, from, dir, 5000, hit)) return false;
    for (let k = 0; k < 3; k++) p[k] = from[k] + dir[k] * hit.t;
    n[0] = U[0]; n[1] = U[1]; n[2] = U[2];
    return true;
  };
  // the boxes in the plane square to up, grown by the clearance, on a grid of cells: a point in no marked cell is clear
  let near = null, cellSize = 1;
  if (S.clearance > 0 && bvh && bvh.triCount && boxes && boxes.length) {
    near = new Set();
    cellSize = Math.max(0.5, S.clearance * 2);
    for (const b of boxes) {
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let k = 0; k < 8; k++) {
        const q = [k & 1 ? b.max[0] : b.min[0], k & 2 ? b.max[1] : b.min[1], k & 4 ? b.max[2] : b.min[2]];
        const u = dot(q, e1), v = dot(q, e2);
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      const g = S.clearance;
      if ((u1 - u0) * (v1 - v0) / (cellSize * cellSize) > 4e6) continue;   // a box the size of the site (the ground itself): rays decide
      for (let i = Math.floor((u0 - g) / cellSize); i <= Math.floor((u1 + g) / cellSize); i++) for (let j = Math.floor((v0 - g) / cellSize); j <= Math.floor((v1 + g) / cellSize); j++) near.add(i + ',' + j);
    }
  }
  const clear = () => {
    if (!(S.clearance > 0) || !bvh || !bvh.triCount) return true;
    if (near && !near.has(Math.floor(dot(p, e1) / cellSize) + ',' + Math.floor(dot(p, e2) / cellSize))) return true;
    // rays from a hand above the surface (a gentle slope of the surface itself does not count as an object in the way)
    const o = [p[0] + U[0] * 0.25, p[1] + U[1] * 0.25, p[2] + U[2] * 0.25];
    if (sceneHit(bvh, o, U, 50, hit)) return false;   // under a roof, a table, a bridge: not here
    for (let k = 0; k < 12; k++) {
      // twelve directions: a box's corner can't hide between two of them closer than the clearance × cos 15°
      const a = (k / 12) * 2 * Math.PI, d = [Math.cos(a) * e1[0] + Math.sin(a) * e2[0], Math.cos(a) * e1[1] + Math.sin(a) * e2[1], Math.cos(a) * e1[2] + Math.sin(a) * e2[2]];
      if (sceneHit(bvh, o, d, S.clearance, hit)) return false;
    }
    return true;
  };
  let count = 0, strokeAt = 0, strokeLeft = S.mode === 'paint' && S.strokes.length ? Math.max(1, Math.round(Math.PI * S.strokes[0][3] ** 2 * S.density)) : 0;
  for (let c = 0; c < wanted && count < cap; c++) {
    if (S.mode === 'fill') {
      if (!nT) break;
      const u = R() * area;
      let lo = 0, hi = nT - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid + 1; else hi = mid; }
      let a = R(), b = R();
      if (a + b > 1) { a = 1 - a; b = 1 - b; }
      const o = lo * 9;
      for (let k = 0; k < 3; k++) { p[k] = tris[o + k] + (tris[o + 3 + k] - tris[o + k]) * a + (tris[o + 6 + k] - tris[o + k]) * b; n[k] = nrm[lo * 3 + k]; }
    } else {
      while (strokeLeft <= 0 && strokeAt + 1 < S.strokes.length) { strokeAt++; strokeLeft = Math.max(1, Math.round(Math.PI * S.strokes[strokeAt][3] ** 2 * S.density)); }
      strokeLeft--;
      const s = S.strokes[strokeAt], rr = s[3] * Math.sqrt(R()), aa = R() * 2 * Math.PI;
      p[0] = s[0] + (Math.cos(aa) * e1[0] + Math.sin(aa) * e2[0]) * rr; p[1] = s[1] + (Math.cos(aa) * e1[1] + Math.sin(aa) * e2[1]) * rr; p[2] = s[2] + (Math.cos(aa) * e1[2] + Math.sin(aa) * e2[2]) * rr;
    }
    // every candidate takes the same draws, kept or not, so a mask or a budget never shifts the ones after it
    const turn = R() * (S.rotate * Math.PI / 180), s0 = S.scale[0] + (S.scale[1] - S.scale[0]) * R(), which = pick();
    if (S.mode === 'paint' && !drop(p[0], p[1], p[2])) continue;
    if (dot(n, U) < cosMax - 1e-9) continue;
    const hgt = dot(p, U);
    if ((S.height[0] !== null && hgt < S.height[0]) || (S.height[1] !== null && hgt > S.height[1])) continue;
    if (!clear()) continue;
    // the item's frame: z along up tilted toward the surface normal by `tilt`, x turned about it
    let z = [U[0] + (n[0] - U[0]) * S.tilt, U[1] + (n[1] - U[1]) * S.tilt, U[2] + (n[2] - U[2]) * S.tilt];
    const zl = Math.hypot(z[0], z[1], z[2]) || 1; z = z.map((v) => v / zl);
    const b0 = basis(z), c = Math.cos(turn), sn = Math.sin(turn);
    const x = [b0.e1[0] * c + b0.e2[0] * sn, b0.e1[1] * c + b0.e2[1] * sn, b0.e1[2] * c + b0.e2[2] * sn];
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    const k = s0 / 1000, o = count * 16;
    matrices[o] = x[0] * k; matrices[o + 1] = x[1] * k; matrices[o + 2] = x[2] * k;
    matrices[o + 4] = y[0] * k; matrices[o + 5] = y[1] * k; matrices[o + 6] = y[2] * k;
    matrices[o + 8] = z[0] * k; matrices[o + 9] = z[1] * k; matrices[o + 10] = z[2] * k;
    matrices[o + 12] = p[0]; matrices[o + 13] = p[1]; matrices[o + 14] = p[2]; matrices[o + 15] = 1;
    item[count] = which;
    count++;
  }
  return { count, matrices: count === cap ? matrices : matrices.slice(0, count * 16), item: count === cap ? item : item.slice(0, count), wanted, area };
}

/** Möller–Trumbore, two-sided: t > 0 or −1. */
function rayTri(T, o, from, d) {
  const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
  const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det, tx = from[0] - T[o], ty = from[1] - T[o + 1], tz = from[2] - T[o + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}
