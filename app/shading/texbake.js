/* SPDX-License-Identifier: Apache-2.0 */
/**
 * shading/texbake.js — texture baking (0.7 MT.5, session `materials`): ambient occlusion, curvature, normals from a high-detail
 * surface onto a low one, and lighting, written into pictures along a surface's UVs. DOM-free. The page lays the surface out over
 * the picture (`rasterize`), the ray work runs as compute/pool.js jobs in bands of rows (texbake-job.js; in-process without a
 * pool), then the gaps between UV islands are filled from their edges (`dilate`) so filtering never reads the empty background.
 *
 *   surface = {pos: Float64Array 9 per triangle (world), nrm: 9 per triangle (corner normals, world), uv: 6 per triangle}
 *   bakeTextures({low: surface, maps, size, occluders, high, opts}, {pool, signal, onProgress}) → {map: image}
 *     maps       some of MAPS; size 64–2048 (a power of two is usual); occluders: Float64Array 9 per triangle (world) — what
 *                darkens AO and casts shadows ('ao', 'light'); high: {pos, nrm} ('normal'); opts: {rays, dist, seed, width, cage,
 *                sun, sunPower, sky, padding}
 *     image      {w, h, data: RGBA8 rows bottom-up} (shading/images.js's convention): ao and curvature grey (data, not colour),
 *                normal an OpenGL tangent-space normal map, light sRGB colour (a light map)
 *   rasterize(low, size) → {P, Nn, T, B, mask, count}   texel centres covered by a UV triangle (the first one wins)
 *   meshBuffers(tris9) → {tris (RENDER-SPEC § 6.2 records), bmin, bmax, a, b, order}   a BVH over triangles for the jobs
 *   edgeBuffers(surface, width) → {edges, grid, gridIdx, gridMeta}   the surface's bends (signed: + convex) in a grid of cells ≥ width
 *   dilate(values, ch, mask, size, px)   texels outside the islands take their nearest covered neighbour's value, px rounds
 *   toImage(values, ch, size, map) → image
 *   MAPS  ['ao', 'curvature', 'normal', 'light']
 */
import { triBoxes, buildTree } from '../compute/bvh-core.js';
import { bakeBand } from './texbake-job.js';

export const MAPS = Object.freeze(['ao', 'curvature', 'normal', 'light']);
const BAND = 32;   // rows per job

export function rasterize(low, N) {
  const nt = Math.floor(low.pos.length / 9), cnt = N * N;
  const P = new Float32Array(cnt * 3), Nn = new Float32Array(cnt * 3), T = new Float32Array(cnt * 3), B = new Float32Array(cnt * 3), mask = new Uint8Array(cnt);
  let count = 0;
  for (let t = 0; t < nt; t++) {
    const q = t * 6, u0 = low.uv[q] * N, v0 = low.uv[q + 1] * N, u1 = low.uv[q + 2] * N, v1 = low.uv[q + 3] * N, u2 = low.uv[q + 4] * N, v2 = low.uv[q + 5] * N;
    const den = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (Math.abs(den) < 1e-12) continue;
    // the triangle's tangent and bitangent from its UVs
    const p = t * 9, e1 = [low.pos[p + 3] - low.pos[p], low.pos[p + 4] - low.pos[p + 1], low.pos[p + 5] - low.pos[p + 2]], e2 = [low.pos[p + 6] - low.pos[p], low.pos[p + 7] - low.pos[p + 1], low.pos[p + 8] - low.pos[p + 2]];
    const du1 = (u1 - u0) / N, dv1 = (v1 - v0) / N, du2 = (u2 - u0) / N, dv2 = (v2 - v0) / N, r = 1 / (du1 * dv2 - du2 * dv1 || 1e-30);
    const tt = [0, 1, 2].map((k) => (e1[k] * dv2 - e2[k] * dv1) * r), bt = [0, 1, 2].map((k) => (e2[k] * du1 - e1[k] * du2) * r);
    const x0 = Math.max(0, Math.floor(Math.min(u0, u1, u2) - 0.5)), x1 = Math.min(N - 1, Math.ceil(Math.max(u0, u1, u2) - 0.5));
    const y0 = Math.max(0, Math.floor(Math.min(v0, v1, v2) - 0.5)), y1 = Math.min(N - 1, Math.ceil(Math.max(v0, v1, v2) - 0.5));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * N + x;
      if (mask[i]) continue;
      const cx = x + 0.5, cy = y + 0.5;
      const a = ((v1 - v2) * (cx - u2) + (u2 - u1) * (cy - v2)) / den, b = ((v2 - v0) * (cx - u2) + (u0 - u2) * (cy - v2)) / den, c = 1 - a - b;
      if (a < -1e-6 || b < -1e-6 || c < -1e-6) continue;
      mask[i] = 1; count++;
      let nx = 0, ny = 0, nz = 0;
      for (let k = 0; k < 3; k++) {
        P[i * 3 + k] = low.pos[p + k] * a + low.pos[p + 3 + k] * b + low.pos[p + 6 + k] * c;
        const v = low.nrm[p + k] * a + low.nrm[p + 3 + k] * b + low.nrm[p + 6 + k] * c;
        if (k === 0) nx = v; else if (k === 1) ny = v; else nz = v;
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      Nn[i * 3] = nx; Nn[i * 3 + 1] = ny; Nn[i * 3 + 2] = nz;
      // tangent made square to the normal; bitangent = n × t, turned to agree with the UVs' own
      const d = tt[0] * nx + tt[1] * ny + tt[2] * nz;
      let tx = tt[0] - nx * d, ty = tt[1] - ny * d, tz = tt[2] - nz * d;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      let bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
      if (bx * bt[0] + by * bt[1] + bz * bt[2] < 0) { bx = -bx; by = -by; bz = -bz; }
      T[i * 3] = tx; T[i * 3 + 1] = ty; T[i * 3 + 2] = tz; B[i * 3] = bx; B[i * 3 + 1] = by; B[i * 3 + 2] = bz;
    }
  }
  return { P, Nn, T, B, mask, count };
}

export function meshBuffers(tris9) {
  const n = Math.floor(tris9.length / 9), tris = new Float32Array(n * 12);
  for (let i = 0; i < n; i++) {
    const s = i * 9, o = i * 12;
    for (let k = 0; k < 3; k++) { tris[o + k] = tris9[s + k]; tris[o + 4 + k] = tris9[s + 3 + k] - tris9[s + k]; tris[o + 8 + k] = tris9[s + 6 + k] - tris9[s + k]; }
  }
  const tree = buildTree(triBoxes(tris, n));
  return { tris, bmin: tree.bmin, bmax: tree.bmax, a: tree.a, b: tree.b, order: tree.order };
}

export function edgeBuffers(low, width) {
  // weld corners by position, then pair the triangles on each edge
  const nt = Math.floor(low.pos.length / 9), key = (i) => Math.round(low.pos[i] * 1e5) + ',' + Math.round(low.pos[i + 1] * 1e5) + ',' + Math.round(low.pos[i + 2] * 1e5);
  const ids = new Map(), vid = new Int32Array(nt * 3);
  for (let c = 0; c < nt * 3; c++) { const k = key(c * 3); let v = ids.get(k); if (v === undefined) { v = ids.size; ids.set(k, v); } vid[c] = v; }
  const fn = new Float64Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const p = t * 9, e1 = [low.pos[p + 3] - low.pos[p], low.pos[p + 4] - low.pos[p + 1], low.pos[p + 5] - low.pos[p + 2]], e2 = [low.pos[p + 6] - low.pos[p], low.pos[p + 7] - low.pos[p + 1], low.pos[p + 8] - low.pos[p + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], l = Math.hypot(...n) || 1;
    fn[t * 3] = n[0] / l; fn[t * 3 + 1] = n[1] / l; fn[t * 3 + 2] = n[2] / l;
  }
  const byEdge = new Map(), out = [];
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const a = vid[t * 3 + k], b = vid[t * 3 + (k + 1) % 3], ek = a < b ? a + '|' + b : b + '|' + a;
    const other = byEdge.get(ek);
    if (other === undefined) { byEdge.set(ek, [t, k]); continue; }
    const [t2] = other, d = fn[t * 3] * fn[t2 * 3] + fn[t * 3 + 1] * fn[t2 * 3 + 1] + fn[t * 3 + 2] * fn[t2 * 3 + 2], ang = Math.acos(Math.max(-1, Math.min(1, d)));
    if (ang < 1e-3) continue;
    // convex when the other triangle's far corner lies below this one's plane
    const opp = t2 * 9 + [0, 1, 2].find((j) => vid[t2 * 3 + j] !== a && vid[t2 * 3 + j] !== b) * 3, p = t * 9 + k * 3;
    const s = (low.pos[opp] - low.pos[p]) * fn[t * 3] + (low.pos[opp + 1] - low.pos[p + 1]) * fn[t * 3 + 1] + (low.pos[opp + 2] - low.pos[p + 2]) * fn[t * 3 + 2];
    const q = t * 9 + ((k + 1) % 3) * 3;
    out.push(low.pos[p], low.pos[p + 1], low.pos[p + 2], low.pos[q], low.pos[q + 1], low.pos[q + 2], s < 0 ? ang : -ang);
  }
  const edges = new Float32Array(out), ne = edges.length / 7;
  // a grid of cells at least `width` wide (a texel looks at its own cell and the 26 round it), at most ~2 million cells
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let e = 0; e < ne; e++) for (let k = 0; k < 6; k++) { const v = edges[e * 7 + k]; lo[k % 3] = Math.min(lo[k % 3], v); hi[k % 3] = Math.max(hi[k % 3], v); }
  if (!ne) return { edges, grid: new Uint32Array(0), gridIdx: new Uint32Array(2), gridMeta: new Float64Array([0, 0, 0, 1, 1, 1, width]) };
  for (let k = 0; k < 3; k++) { lo[k] -= width; hi[k] += width; }
  let cell = width;
  const vol = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
  if (vol / cell ** 3 > 2e6) cell = Math.cbrt(vol / 2e6);
  const dim = [0, 1, 2].map((k) => Math.max(1, Math.ceil((hi[k] - lo[k]) / cell)));
  const cellsOf = (e, fn2) => {
    const c0 = [0, 1, 2].map((k) => Math.floor((Math.min(edges[e * 7 + k], edges[e * 7 + 3 + k]) - lo[k]) / cell));
    const c1 = [0, 1, 2].map((k) => Math.floor((Math.max(edges[e * 7 + k], edges[e * 7 + 3 + k]) - lo[k]) / cell));
    for (let z = c0[2]; z <= c1[2]; z++) for (let y = c0[1]; y <= c1[1]; y++) for (let x = c0[0]; x <= c1[0]; x++) fn2((z * dim[1] + y) * dim[0] + x);
  };
  const nc = dim[0] * dim[1] * dim[2], gridIdx = new Uint32Array(nc + 1);
  for (let e = 0; e < ne; e++) cellsOf(e, (c) => { gridIdx[c + 1]++; });
  for (let c = 0; c < nc; c++) gridIdx[c + 1] += gridIdx[c];
  const grid = new Uint32Array(gridIdx[nc]), fill = gridIdx.slice(0, nc);
  for (let e = 0; e < ne; e++) cellsOf(e, (c) => { grid[fill[c]++] = e; });
  return { edges, grid, gridIdx, gridMeta: new Float64Array([lo[0], lo[1], lo[2], dim[0], dim[1], dim[2], cell]) };
}

export function dilate(values, ch, mask, N, px) {
  let m = mask.slice(), next = m.slice();
  for (let r = 0; r < px; r++) {
    let any = false;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      if (m[i]) continue;
      // the mean of the covered neighbours (4 then diagonals)
      let n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= N || yy >= N || !m[yy * N + xx]) continue;
        const j = yy * N + xx;
        if (!n) for (let k = 0; k < ch; k++) values[i * ch + k] = 0;
        for (let k = 0; k < ch; k++) values[i * ch + k] += values[j * ch + k];
        n++;
      }
      if (n) { for (let k = 0; k < ch; k++) values[i * ch + k] /= n; next[i] = 1; any = true; }
    }
    if (!any) break;
    m.set(next);
  }
  return values;
}

const srgb = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
export function toImage(values, ch, N, map) {
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    for (let k = 0; k < 3; k++) {
      let v = values[i * ch + (ch === 3 ? k : 0)];
      if (map === 'light') v = srgb(Math.min(1, Math.max(0, v)));
      data[i * 4 + k] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
    data[i * 4 + 3] = 255;
  }
  return { w: N, h: N, data };
}

const JOB = new URL('./texbake-job.js', import.meta.url).href;

export async function bakeTextures({ low, maps, size = 512, occluders = null, high = null, opts = {} }, { pool = null, signal = null, onProgress = null } = {}) {
  const N = Math.max(8, Math.min(2048, size | 0)), R = rasterize(low, N);
  const shared = {};
  if (maps.some((m) => m === 'ao' || m === 'light')) {
    const b = meshBuffers(occluders || low.pos);
    for (const [k, v] of Object.entries(b)) shared['tb.occ.' + k] = v;
  }
  if (maps.includes('normal')) {
    // i18n-ignore: a programmer error (code no_high)
    if (!high) throw Object.assign(new Error('texbake: a normal bake needs a high surface'), { code: 'no_high' });
    const b = meshBuffers(high.pos);
    for (const [k, v] of Object.entries(b)) shared['tb.hi.' + k] = v;
    shared['tb.hi.nrm'] = high.nrm instanceof Float32Array ? high.nrm : new Float32Array(high.nrm);
  }
  if (maps.includes('curvature')) {
    const e = edgeBuffers(low, opts.width > 0 ? opts.width : 0.01);
    shared['tb.edges'] = e.edges; shared['tb.grid'] = e.grid; shared['tb.gridIdx'] = e.gridIdx; shared['tb.gridMeta'] = e.gridMeta;
  }
  if (pool) for (const [k, v] of Object.entries(shared)) await pool.share(k, v);
  const ctx = { shared, cancelled: () => !!signal?.aborted };
  const out = {}, total = maps.length * Math.ceil(N / BAND);
  let done = 0;
  try {
    for (const map of maps) {
      const ch = map === 'normal' || map === 'light' ? 3 : 1, values = new Float32Array(N * N * ch), jobs = [];
      for (let y0 = 0; y0 < N; y0 += BAND) {
        const y1 = Math.min(N, y0 + BAND), a = y0 * N, b = y1 * N;
        const args = { map, n: b - a, P: R.P.slice(a * 3, b * 3), Nn: R.Nn.slice(a * 3, b * 3), mask: R.mask.slice(a, b), opts: { ...opts, first: a },
          ...(map === 'normal' ? { T: R.T.slice(a * 3, b * 3), B: R.B.slice(a * 3, b * 3) } : {}) };
        const run = pool ? pool.run(JOB, 'bakeBand', args, { signal, units: (b - a) * (opts.rays || 1) }) : Promise.resolve().then(() => bakeBand(args, ctx));
        jobs.push(run.then((v) => { values.set(v, a * ch); done++; onProgress?.(done / total); }));
      }
      await Promise.all(jobs);
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      dilate(values, ch, R.mask, N, opts.padding ?? 8);
      out[map] = toImage(values, ch, N, map);
    }
  } finally {
    if (pool) for (const k of Object.keys(shared)) pool.unshare(k);
  }
  out.coverage = R.count / (N * N);
  return out;
}
