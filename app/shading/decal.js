/* SPDX-License-Identifier: Apache-2.0 */
/**
 * shading/decal.js — decals (0.7 MT.6, session `materials`): a picture projected onto the surfaces under it, wearing a material of
 * its own. No DOM, no three.js. A decal belongs to one placement (`path`, the placement ids from the model's root, as the views walk
 * them) and lives in that definition's coordinates, so it moves with its group. Its geometry is made from the definition's own
 * triangles: those inside the decal's box that face the projector are clipped to the box and lifted a hair off the surface, with
 * UVs in metres across the decal (its material's tile is the decal's size, so the picture covers it once).
 *
 *   decal = {id: 'd' + 8 base-36, name, material: material id (doc.js ID_RE), path: [placement id], o: [x, y, z] centre,
 *            n: unit normal (out of the surface, toward the projector), u: unit across (⟂ n), size: [w, h] m, depth: m (each side of
 *            the surface), angle: degrees (faces turned further than this from n are left out)}
 *   makeDecal({p, n, size, rot, path, material, name, up}) → decal   upright on walls, along X on level faces, turned by rot degrees
 *   cleanDecal(untrusted) → decal | null    the only way a decal from a file gets in
 *   decalGeometry(decal, tris) → {pos: Float32Array, nor, uv, n (triangles)}   tris: flat [ax, ay, az, bx, …] in the decal's
 *                                    definition's coordinates; nothing allocated per triangle beyond the output
 *   decalGraph(name, imageKey, size) → graph   Picture → base colour, its alpha → opacity, rough 0.6, UV mapping, tile = size
 *   decalAt(decal, p) → [s, t] | null   a point's place on the decal (0–1 each way), null outside its box
 *   LIMIT  decals per file (256)    LIFT  how far the decal floats off its surface (0.5 mm)
 */
import { newGraph, outputNode } from './graph.js';
import { defaultValues, defaultParams } from './nodes.js';

export const LIMIT = 256;
export const LIFT = 0.0005;
export const DECAL_ID_RE = /^d[a-z0-9]{8}$/;
const MAT_RE = /^m[a-z0-9]{8}$/;   // doc.js ID_RE (not imported: doc.js imports this file)

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null; };
const num = (x, lo, hi, d) => { const v = Number(x); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const vec = (x) => (Array.isArray(x) && x.length === 3 && x.every((k) => Number.isFinite(k) && Math.abs(k) < 1e7) ? x.map(Number) : null);

export function newDecalId(taken = () => false) {
  for (;;) {
    let s = 'd';
    for (let i = 0; i < 8; i++) s += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)];
    if (!taken(s)) return s;
  }
}

/** The decal's across direction: level along a wall (as planarUV), along X on a level face; then turned by rot degrees about n. */
function across(n, rot, up = [0, 0, 1]) {
  let u = Math.abs(dot(n, up)) > 0.999 ? [1, 0, 0] : unit(cross(up, n));
  if (!u) u = [1, 0, 0];
  const v = cross(n, u), a = (rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return unit([u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s]);
}

export function makeDecal({ p, n, size = [1, 1], rot = 0, path = [], material = '', name = '', up = [0, 0, 1], id = null }) {
  const nn = unit(n) || [0, 0, 1];
  const w = num(size[0], 0.001, 1000, 1), h = num(size[1], 0.001, 1000, 1);
  return { id: id || newDecalId(), name: String(name).slice(0, 80), material, path: path.slice(), o: p.slice(), n: nn, u: across(nn, rot, up),
    size: [w, h], depth: Math.max(0.01, Math.min(w, h) / 2), angle: 70 };
}

export function cleanDecal(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !DECAL_ID_RE.test(x.id)) return null;
  if (typeof x.material !== 'string' || !MAT_RE.test(x.material)) return null;
  const o = vec(x.o), n = vec(x.n) && unit(x.n), u0 = vec(x.u) && unit(x.u);
  if (!o || !n || !u0) return null;
  // u made square to n (a file may carry them slightly off)
  const d = dot(u0, n), u = unit([u0[0] - n[0] * d, u0[1] - n[1] * d, u0[2] - n[2] * d]);
  if (!u) return null;
  const path = Array.isArray(x.path) && x.path.length <= 32 && x.path.every((k) => typeof k === 'string' || Number.isInteger(k)) ? x.path.map((k) => (typeof k === 'string' ? k.slice(0, 64) : k)) : null;
  if (!path) return null;
  const size = Array.isArray(x.size) && x.size.length === 2 ? [num(x.size[0], 0.001, 1000, 1), num(x.size[1], 0.001, 1000, 1)] : [1, 1];
  return { id: x.id, name: typeof x.name === 'string' ? x.name.slice(0, 80) : '', material: x.material, path, o, n, u, size,
    depth: num(x.depth, 0.001, 100, Math.min(size[0], size[1]) / 2), angle: num(x.angle, 1, 89, 70) };
}

/** A point's place on the decal: [s, t] from its lower-left corner (0–1 each way), null outside its box. */
export function decalAt(D, p) {
  const v = cross(D.n, D.u), q = [p[0] - D.o[0], p[1] - D.o[1], p[2] - D.o[2]];
  const x = dot(q, D.u) / D.size[0] + 0.5, y = dot(q, v) / D.size[1] + 0.5, z = dot(q, D.n);
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 && Math.abs(z) <= D.depth ? [x, y] : null;
}

// clipping scratch: a polygon of up to 3 + 6 corners, in decal space (x, y, z) — reused for every triangle
const MAXP = 12;
const A = new Float64Array(MAXP * 3), B = new Float64Array(MAXP * 3);
/** Keep the part of polygon src (k corners) with s·(coordinate axis) ≤ lim. → corners in dst. */
function clipAxis(src, k, dst, axis, s, lim) {
  let m = 0;
  for (let i = 0; i < k; i++) {
    const j = (i + 1) % k, a = s * src[i * 3 + axis] - lim, b = s * src[j * 3 + axis] - lim;
    if (a <= 0) { dst[m * 3] = src[i * 3]; dst[m * 3 + 1] = src[i * 3 + 1]; dst[m * 3 + 2] = src[i * 3 + 2]; m++; }
    if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
      const t = a / (a - b);
      for (let c = 0; c < 3; c++) dst[m * 3 + c] = src[i * 3 + c] + (src[j * 3 + c] - src[i * 3 + c]) * t;
      m++;
    }
    if (m >= MAXP - 1) break;
  }
  return m;
}

export function decalGeometry(D, tris) {
  const n = D.n, u = D.u, v = cross(n, u), hw = D.size[0] / 2, hh = D.size[1] / 2, cosMax = Math.cos((D.angle * Math.PI) / 180);
  const pos = [], nor = [], uv = [];
  const nt = Math.floor(tris.length / 9);
  for (let i = 0; i < nt; i++) {
    const o = i * 9;
    // the triangle's normal must face the projector
    const e1 = [tris[o + 3] - tris[o], tris[o + 4] - tris[o + 1], tris[o + 5] - tris[o + 2]], e2 = [tris[o + 6] - tris[o], tris[o + 7] - tris[o + 1], tris[o + 8] - tris[o + 2]];
    const fn = unit(cross(e1, e2));
    if (!fn || dot(fn, n) < cosMax) continue;
    // into decal space; a quick box reject before clipping
    let out = 0;
    for (let c = 0; c < 3; c++) {
      const q = [tris[o + c * 3] - D.o[0], tris[o + c * 3 + 1] - D.o[1], tris[o + c * 3 + 2] - D.o[2]];
      A[c * 3] = dot(q, u); A[c * 3 + 1] = dot(q, v); A[c * 3 + 2] = dot(q, n);
    }
    for (let ax = 0; ax < 3 && !out; ax++) {
      const lim = ax === 0 ? hw : ax === 1 ? hh : D.depth;
      if (A[ax] > lim && A[3 + ax] > lim && A[6 + ax] > lim) out = 1;
      if (A[ax] < -lim && A[3 + ax] < -lim && A[6 + ax] < -lim) out = 1;
    }
    if (out) continue;
    let k = 3;
    k = clipAxis(A, k, B, 0, 1, hw); if (k < 3) continue;
    k = clipAxis(B, k, A, 0, -1, hw); if (k < 3) continue;
    k = clipAxis(A, k, B, 1, 1, hh); if (k < 3) continue;
    k = clipAxis(B, k, A, 1, -1, hh); if (k < 3) continue;
    k = clipAxis(A, k, B, 2, 1, D.depth); if (k < 3) continue;
    k = clipAxis(B, k, A, 2, -1, D.depth); if (k < 3) continue;
    // a fan, back in the definition's coordinates, lifted along the face's normal
    for (let j = 1; j + 1 < k; j++) for (const c of [0, j, j + 1]) {
      const x = A[c * 3], y = A[c * 3 + 1], z = A[c * 3 + 2];
      for (let a = 0; a < 3; a++) pos.push(D.o[a] + u[a] * x + v[a] * y + n[a] * z + fn[a] * LIFT);
      nor.push(fn[0], fn[1], fn[2]);
      uv.push(x + hw, y + hh);   // metres from the lower-left corner: the material's tile is the decal's size
    }
  }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), uv: new Float32Array(uv), n: pos.length / 9 };
}

/** The decal's own material: its picture as the base colour and the cut-out, a satin finish, one tile = the decal. */
export function decalGraph(name, imageKey, size) {
  const g = newGraph(name), out = outputNode(g);
  out.x = 360;
  out.params.width = size[0]; out.params.height = size[1]; out.params.mapping = 'uv';
  out.values.specular_roughness = 0.6;
  g.nodes.push({ id: 2, type: 'image', x: 40, y: 40, values: defaultValues('image'), params: { ...defaultParams('image'), image: imageKey } });
  g.links.push({ from: [2, 'color'], to: [1, 'base_color'] }, { from: [2, 'alpha'], to: [1, 'geometry_opacity'] });
  return g;
}
