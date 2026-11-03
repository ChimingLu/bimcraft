/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: developer errors */
/**
 * shading/texbake-job.js — pool job for texture baking (0.7 MT.5, session `materials`): one band of texel rows of a bake. Runs in a
 * compute/pool.js worker (or in-process with a stand-in ctx, as the Node tests and the no-worker fallback do). DOM-free.
 *
 *   bakeBand({ map, n, P, Nn, T, B, mask, opts }, ctx) → Float32Array (n texels × 1, or × 3 for 'normal' and 'light')
 *     map    'ao' | 'curvature' | 'normal' | 'light'
 *     P, Nn  texel positions and normals (world), 3 per texel; T, B tangent and bitangent (world; 'normal' only); mask 1 = texel used
 *     opts   ao/light: {rays, dist, seed}; light: {sun: [x, y, z] | null, sunPower, sky}; curvature: {width}; normal: {cage}
 *   shared (pool.share, or ctx.shared in-process):
 *     'tb.occ.tris', 'tb.occ.bmin', 'tb.occ.bmax', 'tb.occ.a', 'tb.occ.b', 'tb.occ.order'   what shades (RENDER-SPEC § 6.2 records + a binary BVH)
 *     'tb.hi.*' the same for the high-detail surface, plus 'tb.hi.nrm' (9 per triangle: its corners' normals)
 *     'tb.edges'  7 per edge (a xyz, b xyz, signed bend in radians: + convex), 'tb.grid' + 'tb.gridIdx' + 'tb.gridMeta' (a hash of them)
 * Samples come from a hash of (texel, ray, seed): the same bake gives the same bytes however it is split.
 */
import { closestHit, anyHit } from '../compute/bvh-core.js';

const treeCache = new WeakMap();
function treeOf(ctx, pre) {
  const tris = ctx.shared[pre + '.tris'];
  if (!tris) throw new Error('texbake: nothing shared as ' + pre);
  let t = treeCache.get(tris);
  if (!t) {
    t = { bmin: ctx.shared[pre + '.bmin'], bmax: ctx.shared[pre + '.bmax'], a: ctx.shared[pre + '.a'], b: ctx.shared[pre + '.b'], order: ctx.shared[pre + '.order'], n: Math.floor(tris.length / 12) };
    treeCache.set(tris, t);
  }
  return { tree: t, tris };
}

function hash(a, b, c) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be59b, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// scratch shared by every texel (hot loops allocate nothing)
const O = [0, 0, 0], D = [0, 0, 0], HIT = { t: 0, prim: -1, u: 0, v: 0 }, F = [0, 0, 0, 0, 0, 0];

/** A frame (t, b) square to unit n, into F. */
function frame(nx, ny, nz) {
  const s = nz >= 0 ? 1 : -1, a = -1 / (s + nz), b = nx * ny * a;
  F[0] = 1 + s * nx * nx * a; F[1] = s * b; F[2] = -s * nx;
  F[3] = b; F[4] = s + ny * ny * a; F[5] = -ny;
}

/** The unoccluded fraction over `rays` cosine-weighted directions above (p, n), up to `dist`; texel k. */
function openness(occ, px, py, pz, nx, ny, nz, rays, dist, k, seed, eps) {
  frame(nx, ny, nz);
  O[0] = px + nx * eps; O[1] = py + ny * eps; O[2] = pz + nz * eps;
  let open = 0;
  for (let r = 0; r < rays; r++) {
    const u1 = hash(k, r, seed), u2 = hash(k, r, seed + 7919);
    const rr = Math.sqrt(u1), ph = 2 * Math.PI * u2, x = rr * Math.cos(ph), y = rr * Math.sin(ph), z = Math.sqrt(Math.max(0, 1 - u1));
    D[0] = F[0] * x + F[3] * y + nx * z; D[1] = F[1] * x + F[4] * y + ny * z; D[2] = F[2] * x + F[5] * y + nz * z;
    if (!anyHit(occ.tree, occ.tris, O, D, dist)) open++;
  }
  return open / rays;
}

export function bakeBand({ map, n, P, Nn, T, B, mask, opts = {} }, ctx) {
  const ch = map === 'normal' || map === 'light' ? 3 : 1, out = new Float32Array(n * ch);
  const eps = opts.eps || 1e-4;
  if (map === 'ao' || map === 'light') {
    const occ = treeOf(ctx, 'tb.occ'), rays = Math.max(1, opts.rays | 0), dist = opts.dist > 0 ? opts.dist : 1e30, seed = opts.seed | 0, base = opts.first | 0;
    const sun = opts.sun, sp = opts.sunPower ?? 1, sky = opts.sky || [0.35, 0.4, 0.5];
    for (let i = 0; i < n; i++) {
      if ((i & 255) === 0 && ctx.cancelled && ctx.cancelled()) break;
      if (!mask[i]) { if (map === 'ao') out[i] = 1; continue; }
      const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2], nx = Nn[i * 3], ny = Nn[i * 3 + 1], nz = Nn[i * 3 + 2];
      const ao = openness(occ, px, py, pz, nx, ny, nz, rays, dist, base + i, seed, eps);
      if (map === 'ao') { out[i] = ao; continue; }
      let s = 0;
      if (sun) {
        const c = nx * sun[0] + ny * sun[1] + nz * sun[2];
        if (c > 0) {
          O[0] = px + nx * eps; O[1] = py + ny * eps; O[2] = pz + nz * eps; D[0] = sun[0]; D[1] = sun[1]; D[2] = sun[2];
          if (!anyHit(occ.tree, occ.tris, O, D, 1e30)) s = c * sp;
        }
      }
      for (let k = 0; k < 3; k++) out[i * 3 + k] = s + sky[k] * ao;
    }
  } else if (map === 'curvature') {
    const E = ctx.shared['tb.edges'], G = ctx.shared['tb.grid'], GI = ctx.shared['tb.gridIdx'], M = ctx.shared['tb.gridMeta'];
    if (!E) throw new Error('texbake: no edges shared');
    const w = opts.width > 0 ? opts.width : 0.01, cell = M[6], dim = [M[3] | 0, M[4] | 0, M[5] | 0];
    for (let i = 0; i < n; i++) {
      if (!mask[i]) { out[i] = 0.5; continue; }
      const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
      let sum = 0;
      const cx = Math.floor((px - M[0]) / cell), cy = Math.floor((py - M[1]) / cell), cz = Math.floor((pz - M[2]) / cell);
      for (let z = cz - 1; z <= cz + 1; z++) for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
        if (x < 0 || y < 0 || z < 0 || x >= dim[0] || y >= dim[1] || z >= dim[2]) continue;
        const c = (z * dim[1] + y) * dim[0] + x;
        for (let j = GI[c]; j < GI[c + 1]; j++) {
          const e = G[j] * 7, ax = E[e], ay = E[e + 1], az = E[e + 2], bx = E[e + 3] - ax, by = E[e + 4] - ay, bz = E[e + 5] - az;
          const l2 = bx * bx + by * by + bz * bz, t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * bx + (py - ay) * by + (pz - az) * bz) / l2)) : 0;
          const dx = px - ax - bx * t, dy = py - ay - by * t, dz = pz - az - bz * t, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d >= w) continue;
          const f = 1 - d / w;
          sum += E[e + 6] * f * f * (3 - 2 * f);
        }
      }
      out[i] = Math.min(1, Math.max(0, 0.5 + sum / Math.PI));
    }
  } else if (map === 'normal') {
    const hi = treeOf(ctx, 'tb.hi'), NR = ctx.shared['tb.hi.nrm'], cage = opts.cage > 0 ? opts.cage : 0.01;
    for (let i = 0; i < n; i++) {
      out[i * 3] = 0.5; out[i * 3 + 1] = 0.5; out[i * 3 + 2] = 1;
      if (!mask[i]) continue;
      if ((i & 255) === 0 && ctx.cancelled && ctx.cancelled()) break;
      const nx = Nn[i * 3], ny = Nn[i * 3 + 1], nz = Nn[i * 3 + 2];
      // from just outside the low surface, back in along its normal: the high surface's first point within the cage
      O[0] = P[i * 3] + nx * cage; O[1] = P[i * 3 + 1] + ny * cage; O[2] = P[i * 3 + 2] + nz * cage; D[0] = -nx; D[1] = -ny; D[2] = -nz;
      const h = closestHit(hi.tree, hi.tris, O, D, 2 * cage, HIT);
      if (!h) continue;
      const q = h.prim * 9, a = 1 - h.u - h.v;
      let hx = NR[q] * a + NR[q + 3] * h.u + NR[q + 6] * h.v, hy = NR[q + 1] * a + NR[q + 4] * h.u + NR[q + 7] * h.v, hz = NR[q + 2] * a + NR[q + 5] * h.u + NR[q + 8] * h.v;
      const l = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
      hx /= l; hy /= l; hz /= l;
      // into the low surface's tangent frame (OpenGL: +y along the bitangent, which runs up the picture)
      const tx = hx * T[i * 3] + hy * T[i * 3 + 1] + hz * T[i * 3 + 2], ty = hx * B[i * 3] + hy * B[i * 3 + 1] + hz * B[i * 3 + 2], tz = hx * nx + hy * ny + hz * nz;
      out[i * 3] = tx * 0.5 + 0.5; out[i * 3 + 1] = ty * 0.5 + 0.5; out[i * 3 + 2] = Math.max(0, tz) * 0.5 + 0.5;
    }
  } else throw new Error('texbake: unknown map ' + map);
  return out;
}
