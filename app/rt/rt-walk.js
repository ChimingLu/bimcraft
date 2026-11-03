/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-walk.js — walking through the model in the live view (0.7 RT.3, session `realtime`). DOM-free (Node tests). Canonical in
 * modelcraft/dev/rt/ (tools/rt/sync.mjs). Collisions and the floor come from compute's BVH (compute/bvh-scene.js, CU.4): the
 * plain scene's triangles once, two levels (a component placed many times costs its triangles once), any up axis.
 *
 *   walkScene(plain, {ground}) → bvh   the plain scene's solid items (edges left out) as compute/bvh-scene.js buildScene input,
 *     built; with the ground (default on, as the renderers draw it): the tracer's square of side 120 R at groundAt, square to up
 *   createWalker(bvh, {up, eye, forward, opts}) → walker
 *     eye = [x, y, z] where the walk starts (the eye; settled onto the floor below it when there is one), forward = view direction
 *     opts = {height 1.6, speed 1.4 m/s (× 3 running), radius 0.25, step 0.4, gravity true, collide true, fov 60°}: BimCraft's
 *     own walk (viewer3d.js) uses the same numbers, so both apps walk alike
 *   walker.step(dt, keys) → true while anything moves     keys: Set of 'forward' 'back' 'left' 'right' 'up' 'down' 'run'
 *   walker.look(dx, dy)                                     a drag of dx, dy pixels turns and tilts the view
 *   walker.camera(aspect) → {world, proj}                   for the renderer (OpenGL convention, as the apps' cameras)
 *   walker.eye, walker.forward()                            where it stands, where it looks
 *
 * Moving: the step's horizontal move is checked by rays at knee and eye height (radius ahead); a wall stops the part of the
 * move into it and keeps the part along it (sliding); a second wall there stops it. Gravity: the floor under the eye, looked for
 * from just above the knees, so a step up to `step` metres (a stair) is climbed and anything higher is a wall; falling at 9.81.
 */
import { buildScene, sceneHit } from '../compute/bvh-scene.js';
import { basis } from '../render/looks.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Plain items → bvh-scene input: one mesh per geometry (object space), one instance per placement. */
export function walkScene(plain, { ground = true } = {}) {
  const meshOf = new Map(), meshes = [], instances = [];
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (ground) {
    const up = basis(plain.up || [0, 0, 1]).up, { e1, e2 } = basis(up), bb = plain.bounds;
    const c = bb ? [0, 1, 2].map((k) => (bb.min[k] + bb.max[k]) / 2) : [0, 0, 0];
    const R = bb ? Math.max(Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) / 2, 0.5) : 5, s = R * 60;
    const lift = dot(c, up) - (plain.groundAt ?? 0);
    const g0 = [c[0] - up[0] * lift, c[1] - up[1] * lift, c[2] - up[2] * lift];
    const q = (a, b) => [g0[0] + e1[0] * a + e2[0] * b, g0[1] + e1[1] * a + e2[1] * b, g0[2] + e1[2] * a + e2[2] * b];
    const tri = (A, B, C) => [...A, 0, B[0] - A[0], B[1] - A[1], B[2] - A[2], 0, C[0] - A[0], C[1] - A[1], C[2] - A[2], 0];
    meshes.push({ tris: new Float32Array([...tri(q(-s, -s), q(s, -s), q(s, s)), ...tri(q(-s, -s), q(s, s), q(-s, s))]) });
    instances.push({ mesh: 0, m: I });
  }
  for (const it of plain.items || []) {
    if (!it || it.lines || !it.geometry || it.walkThrough) continue;
    let mi = meshOf.get(it.geometry);
    if (mi === undefined) {
      const g = it.geometry, pa = g.getAttribute('position');
      if (!pa) continue;
      const idx = g.index ? g.index.array : null, n = Math.floor((idx ? idx.length : pa.count) / 3);
      const tris = new Float32Array(n * 12);
      const P = (k, o) => { const v = idx ? idx[k] : k; tris[o] = pa.getX(v); tris[o + 1] = pa.getY(v); tris[o + 2] = pa.getZ(v); };
      const a = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        const o = i * 12;
        P(i * 3, o); a[0] = tris[o]; a[1] = tris[o + 1]; a[2] = tris[o + 2];
        P(i * 3 + 1, o + 4); P(i * 3 + 2, o + 8);
        for (let k = 0; k < 3; k++) { tris[o + 4 + k] -= a[k]; tris[o + 8 + k] -= a[k]; }   // e1, e2 (RENDER-SPEC § 6.2)
      }
      mi = meshes.length;
      meshOf.set(it.geometry, mi);
      meshes.push({ tris });
    }
    instances.push({ mesh: mi, m: it.matrix || I });
  }
  return buildScene({ meshes, instances: instances.length ? instances : null });
}

export function createWalker(bvh, { up = [0, 0, 1], eye, forward = [0, 1, 0], opts = {} } = {}) {
  const o = { height: 1.6, speed: 1.4, radius: 0.25, step: 0.4, gravity: true, collide: true, fov: 60, ...opts };
  const U = norm(up), { e1, e2 } = basis(U);
  const pos = eye.slice();
  const f0 = norm(forward), fh = [f0[0] - U[0] * dot(f0, U), f0[1] - U[1] * dot(f0, U), f0[2] - U[2] * dot(f0, U)];
  let yaw = Math.atan2(dot(fh, e2), dot(fh, e1)), pitch = 0, vy = 0;
  const hit = { t: 0, slot: -1, mesh: -1, tri: -1, inst: -1, u: 0, v: 0 };
  const ray = (from, dir, far) => (bvh.triCount ? sceneHit(bvh, from, dir, far, hit) : null);
  /** The hit triangle's normal in world space (instance rows: n_world = rowsᵀ · n_object, RENDER-SPEC § 6.3). */
  const normalOf = (h) => {
    const T = bvh.tris, k = h.slot * 12;
    let n = cross([T[k + 4], T[k + 5], T[k + 6]], [T[k + 8], T[k + 9], T[k + 10]]);
    if (h.instSlot >= 0) {
      const I = bvh.inst, q = h.instSlot * 16;
      n = [I[q] * n[0] + I[q + 4] * n[1] + I[q + 8] * n[2], I[q + 1] * n[0] + I[q + 5] * n[1] + I[q + 9] * n[2], I[q + 2] * n[0] + I[q + 6] * n[1] + I[q + 10] * n[2]];
    }
    return norm(n);
  };
  const along = (s) => [pos[0] + U[0] * s, pos[1] + U[1] * s, pos[2] + U[2] * s];
  const fwd = (withPitch) => {
    const c = withPitch ? Math.cos(pitch) : 1, s = withPitch ? Math.sin(pitch) : 0;
    return norm([0, 1, 2].map((k) => (Math.cos(yaw) * e1[k] + Math.sin(yaw) * e2[k]) * c + U[k] * s));
  };
  /** The floor under the eye (its height along up), looked for from just above the knees. */
  const floorUnder = () => {
    const h = ray(along(-o.height + o.step + 0.01), [-U[0], -U[1], -U[2]], 200);
    return h ? dot(pos, U) - o.height + o.step + 0.01 - h.t : null;
  };
  const settle = () => { if (!o.gravity) return; const f = floorUnder(); if (f !== null) { const d = f + o.height - dot(pos, U); for (let k = 0; k < 3; k++) pos[k] += U[k] * d; vy = 0; } };
  settle();
  const W = {
    get eye() { return pos.slice(); },
    forward: () => fwd(true),
    opts: o,
    look(dx, dy) { yaw -= dx * 0.004; pitch = Math.max(-1.45, Math.min(1.45, pitch - dy * 0.004)); },
    step(dt, keys) {
      const K = keys || new Set();
      const f = fwd(false), r = cross(f, U);
      let v = [0, 0, 0];
      const addv = (a, s) => { v = [v[0] + a[0] * s, v[1] + a[1] * s, v[2] + a[2] * s]; };
      if (K.has('forward')) addv(f, 1);
      if (K.has('back')) addv(f, -1);
      if (K.has('right')) addv(r, 1);
      if (K.has('left')) addv(r, -1);
      let moved = false;
      const L = Math.hypot(v[0], v[1], v[2]);
      if (L > 0) {
        const s = (o.speed * (K.has('run') ? 3 : 1) * dt) / L;
        v = v.map((x) => x * s);
        if (o.collide) {
          // look ahead at knee and eye height: stop short of a wall, slide along it
          for (const hgt of [o.step + 0.05, o.height - 0.1]) {
            const len = Math.hypot(v[0], v[1], v[2]);
            if (!len) break;
            const from = along(-o.height + hgt);
            const h = ray(from, v.map((x) => x / len), len + o.radius);
            if (!h) continue;
            let n = normalOf(h);
            n = [n[0] - U[0] * dot(n, U), n[1] - U[1] * dot(n, U), n[2] - U[2] * dot(n, U)];
            const nl = Math.hypot(n[0], n[1], n[2]);
            if (nl < 1e-6) { v = [0, 0, 0]; break; }
            n = n.map((x) => x / nl);
            const into = dot(v, n);
            v = [v[0] - n[0] * into, v[1] - n[1] * into, v[2] - n[2] * into];   // keep only the part along the wall
            const l2 = Math.hypot(v[0], v[1], v[2]);
            if (l2 && ray(from, v.map((x) => x / l2), l2 + o.radius)) v = [0, 0, 0];
          }
        }
        for (let k = 0; k < 3; k++) pos[k] += v[k];
        moved = Math.hypot(v[0], v[1], v[2]) > 0;
      }
      if (o.gravity) {
        const fl = floorUnder();
        if (fl !== null) {
          const want = fl + o.height, now = dot(pos, U);
          if (now < want) { for (let k = 0; k < 3; k++) pos[k] += U[k] * (want - now); vy = 0; }   // a step up
          else if (now > want + 1e-3) {
            vy -= 9.81 * dt;
            const next = Math.max(want, now + vy * dt);
            for (let k = 0; k < 3; k++) pos[k] += U[k] * (next - now);
            if (next === want) vy = 0;
            moved = true;
          }
        }
      } else {
        if (K.has('down')) { for (let k = 0; k < 3; k++) pos[k] -= U[k] * o.speed * dt; moved = true; }
        if (K.has('up')) { for (let k = 0; k < 3; k++) pos[k] += U[k] * o.speed * dt; moved = true; }
      }
      return moved || K.size > 0;
    },
    camera(aspect) {
      const f = fwd(true), right = norm(cross(f, U)), cu = cross(right, f);
      const world = [right[0], right[1], right[2], 0, cu[0], cu[1], cu[2], 0, -f[0], -f[1], -f[2], 0, pos[0], pos[1], pos[2], 1];
      const t = 1 / Math.tan((o.fov * Math.PI) / 360), n = 0.05, fr = 2000;
      const proj = [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (fr + n) / (n - fr), -1, 0, 0, (2 * fr * n) / (n - fr), 0];
      return { world, proj };
    },
  };
  return W;
}
