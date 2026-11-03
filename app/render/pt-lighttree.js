/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-lighttree.js — many-light sampling for the path tracer (0.7 RN.3; RENDER-SPEC § 5.2, § 6.5): a binary tree over the
 * bounded lights (lamps, area lights, emissive triangles), each node with the lights' bounds, total power and an orientation
 * cone, so a shading point picks a light by walking down the tree with probabilities ∝ each child's importance — a thousand
 * lamps cost a dozen steps, not a thousand. The same tree, as a ray BVH, finds the lamp a BSDF ray meets. No DOM, no imports.
 *
 *   buildLightTree(items) → {nodes: Float32Array (16 / node), bits: Uint32Array, depth: Uint8Array, leafOf: Int32Array}
 *     items[k] = {bmin: [3], bmax: [3], power, axis: [3], cosO, cosE, twoSided}   (k = the light's index in the light list)
 *   importance(nodes, ni, p, n) → value      (pbrt-v4's LightBounds::Importance: power × the best-case cosines / distance²)
 *   pick(tree, p, n, u) → {light, pdf} | null       pdfOf(tree, light, p, n) → the probability pick gives that light
 *
 * Node (16 floats): (bmin.xyz, power), (bmax.xyz, cos θo), (axis.xyz, cos θe), (child or light as u32 bits, flags u32: bit 0 leaf,
 * bit 1 two-sided, 0, 0). Inner node: children `child` and `child + 1`. Leaf: one light. The tree is built by splitting the
 * lights at the median of the longest axis of their centres (balanced, deterministic). Orientation cones merge as pbrt-v4's
 * DirectionCone union; θe is the largest. Source: Conty Estevez & Kulla, "Importance Sampling of Many Lights with Adaptive
 * Tree Splitting" (2018); pbrt-v4 § 12.6.3 (Apache-2.0, formulas only).
 */

export const NODE_FLOATS = 16;
const vlen = (v) => Math.hypot(v[0], v[1], v[2]);
const vnorm = (v) => { const l = vlen(v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/** The cone holding both cones (axis a, cos θa) and (b, cos θb) — pbrt-v4 DirectionCone Union. */
function coneUnion(a, cosA, b, cosB) {
  if (cosA <= -1 || cosB <= -1) return [a, -1];
  const ta = Math.acos(Math.min(1, Math.max(-1, cosA))), tb = Math.acos(Math.min(1, Math.max(-1, cosB)));
  const td = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  if (Math.min(td + tb, Math.PI) <= ta) return [a, cosA];
  if (Math.min(td + ta, Math.PI) <= tb) return [b, cosB];
  const to = (ta + td + tb) / 2;
  if (to >= Math.PI) return [a, -1];
  const tr = to - ta;
  let wr = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  if (vlen(wr) < 1e-9) return [a, -1];
  wr = vnorm(wr);
  // rotate a by tr around wr (Rodrigues)
  const c = Math.cos(tr), s = Math.sin(tr), d = wr[0] * a[0] + wr[1] * a[1] + wr[2] * a[2];
  const x = [wr[1] * a[2] - wr[2] * a[1], wr[2] * a[0] - wr[0] * a[2], wr[0] * a[1] - wr[1] * a[0]];
  const w = [0, 1, 2].map((k) => a[k] * c + x[k] * s + wr[k] * d * (1 - c));
  return [vnorm(w), Math.cos(to)];
}

export function buildLightTree(items) {
  const n = items.length;
  const nodes = new Float32Array(Math.max(1, 2 * n - 1) * NODE_FLOATS), U = new Uint32Array(nodes.buffer);
  const bits = new Uint32Array(n), depth = new Uint8Array(n), leafOf = new Int32Array(n).fill(-1);
  if (!n) return { nodes, bits, depth, leafOf, count: 0 };
  const idx = Array.from({ length: n }, (_, k) => k);
  let count = 1;
  const cen = items.map((it) => [0, 1, 2].map((k) => (it.bmin[k] + it.bmax[k]) / 2));
  // iterative build: [node, first, end, path bits, depth]
  const stack = [[0, 0, n, 0, 0]];
  while (stack.length) {
    const [ni, first, end, path, d] = stack.pop();
    const o = ni * NODE_FLOATS;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    let power = 0, axis = null, cosO = 1, cosE = -1, two = false;
    for (let j = first; j < end; j++) {
      const it = items[idx[j]];
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], it.bmin[k]); hi[k] = Math.max(hi[k], it.bmax[k]); }
      power += it.power;
      if (!axis) { axis = vnorm(it.axis); cosO = it.cosO; } else [axis, cosO] = coneUnion(axis, cosO, vnorm(it.axis), it.cosO);
      cosE = Math.max(cosE, -1); cosE = j === first ? it.cosE : Math.min(cosE, it.cosE);
      two = two || !!it.twoSided;
    }
    nodes.set([lo[0], lo[1], lo[2], power, hi[0], hi[1], hi[2], cosO, axis[0], axis[1], axis[2], cosE], o);
    U[o + 13] = two ? 2 : 0;
    if (end - first === 1) {
      U[o + 12] = idx[first]; U[o + 13] |= 1;
      bits[idx[first]] = path; depth[idx[first]] = d; leafOf[idx[first]] = ni;
      continue;
    }
    // split at the median of the longest axis of the centres
    const cl = [Infinity, Infinity, Infinity], ch = [-Infinity, -Infinity, -Infinity];
    for (let j = first; j < end; j++) for (let k = 0; k < 3; k++) { cl[k] = Math.min(cl[k], cen[idx[j]][k]); ch[k] = Math.max(ch[k], cen[idx[j]][k]); }
    const ex = [ch[0] - cl[0], ch[1] - cl[1], ch[2] - cl[2]], ax = ex[0] >= ex[1] && ex[0] >= ex[2] ? 0 : ex[1] >= ex[2] ? 1 : 2;
    const part = idx.slice(first, end).sort((a, b) => cen[a][ax] - cen[b][ax] || a - b);
    for (let j = first; j < end; j++) idx[j] = part[j - first];
    const mid = (first + end) >> 1, left = count;
    count += 2;
    U[o + 12] = left;
    if (d >= 31) throw new Error('light tree too deep');   // i18n-ignore: cannot happen with ≤ 2³¹ lights (balanced)
    stack.push([left + 1, mid, end, path | (1 << d), d + 1], [left, first, mid, path, d + 1]);
  }
  return { nodes: nodes.subarray(0, count * NODE_FLOATS), bits, depth, leafOf, count };
}

const cosSubClamped = (sa, ca, sb, cb) => (ca > cb ? 1 : ca * cb + sa * sb);   // cos(max(0, a − b))
const sinSubClamped = (sa, ca, sb, cb) => (ca > cb ? 0 : sa * cb - ca * sb);
const safeSqrt = (x) => Math.sqrt(Math.max(0, x));

/** pbrt-v4 LightBounds::Importance at point p with surface normal n (n = null: a point in a medium). */
export function importance(nodes, ni, p, n) {
  const o = ni * NODE_FLOATS;
  const power = nodes[o + 3];
  if (!(power > 0)) return 0;
  const lo0 = nodes[o], lo1 = nodes[o + 1], lo2 = nodes[o + 2], hi0 = nodes[o + 4], hi1 = nodes[o + 5], hi2 = nodes[o + 6];
  const pcx = (lo0 + hi0) / 2, pcy = (lo1 + hi1) / 2, pcz = (lo2 + hi2) / 2;
  const diag = Math.hypot(hi0 - lo0, hi1 - lo1, hi2 - lo2);
  let dx = p[0] - pcx, dy = p[1] - pcy, dz = p[2] - pcz;
  const d2c = dx * dx + dy * dy + dz * dz, d2 = Math.max(d2c, diag / 2);
  const l = Math.sqrt(d2c) || 1; dx /= l; dy /= l; dz /= l;
  const two = (new Uint32Array(nodes.buffer, nodes.byteOffset + (o + 13) * 4, 1)[0] & 2) !== 0;
  let cosW = nodes[o + 8] * dx + nodes[o + 9] * dy + nodes[o + 10] * dz;
  if (two) cosW = Math.abs(cosW);
  const sinW = safeSqrt(1 - cosW * cosW);
  // the angle the box subtends from p (its bounding sphere); inside it: every direction
  const inside = p[0] >= lo0 && p[0] <= hi0 && p[1] >= lo1 && p[1] <= hi1 && p[2] >= lo2 && p[2] <= hi2;
  const r2 = (diag / 2) * (diag / 2);
  const cosB = inside || d2c <= r2 ? -1 : safeSqrt(1 - r2 / d2c), sinB = safeSqrt(1 - cosB * cosB);
  const cosO = nodes[o + 7], sinO = safeSqrt(1 - cosO * cosO), cosE = nodes[o + 11];
  const cosX = cosSubClamped(sinW, cosW, sinO, cosO), sinX = sinSubClamped(sinW, cosW, sinO, cosO);
  const cosP = cosSubClamped(sinX, cosX, sinB, cosB);
  if (cosP <= cosE) return 0;
  let imp = (power * cosP) / d2;
  if (n) {
    const cosI = Math.abs(dx * n[0] + dy * n[1] + dz * n[2]), sinI = safeSqrt(1 - cosI * cosI);
    imp *= cosSubClamped(sinI, cosI, sinB, cosB);
  }
  return Math.max(0, imp);
}

export function pick(tree, p, n, u) {
  if (!tree.count) return null;
  const N = tree.nodes, U = new Uint32Array(N.buffer, N.byteOffset, N.length);
  let ni = 0, pdf = 1;
  if (!(importance(N, 0, p, n) > 0)) return null;
  for (;;) {
    const o = ni * NODE_FLOATS;
    if (U[o + 13] & 1) return { light: U[o + 12], pdf };
    const c = U[o + 12], il = importance(N, c, p, n), ir = importance(N, c + 1, p, n);
    if (!(il + ir > 0)) return null;
    const pl = il / (il + ir);
    if (u < pl) { u = u / pl; ni = c; pdf *= pl; } else { u = (u - pl) / (1 - pl); ni = c + 1; pdf *= 1 - pl; }
    u = Math.min(u, 0.99999994);
  }
}

export function pdfOf(tree, light, p, n) {
  if (!tree.count || tree.leafOf[light] < 0) return 0;
  const N = tree.nodes, U = new Uint32Array(N.buffer, N.byteOffset, N.length);
  if (!(importance(N, 0, p, n) > 0)) return 0;
  let ni = 0, pdf = 1;
  const bits = tree.bits[light], d = tree.depth[light];
  for (let k = 0; k < d; k++) {
    const c = U[ni * NODE_FLOATS + 12], il = importance(N, c, p, n), ir = importance(N, c + 1, p, n);
    if (!(il + ir > 0)) return 0;
    const right = (bits >>> k) & 1;
    pdf *= right ? ir / (il + ir) : il / (il + ir);
    ni = c + right;
  }
  return pdf;
}
