/* SPDX-License-Identifier: Apache-2.0 */
/**
 * register.js — registering several scans (0.7 LC.3, session `scans`). No DOM, no three.js: bin/test-register.mjs runs all
 * of it in Node. Canonical here in bimcraft/dev; CadCraft carries a byte-identical copy (`node tools/pointcloud/sync.mjs`).
 * Everything is JavaScript (the Rust E57 crate, RS.7, is not built).
 *
 * A scan keeps its points exactly as read. Registering gives each scan ONE transform — a rigid 4 × 4 matrix, row-major
 * (`[r00 r01 r02 tx, r10 …, 0 0 0 1]`), from the scan's own file coordinates (absolute, file units) to the registered frame.
 * No point is ever rewritten; exports apply the matrix on the way out (scan-export.js).
 *
 *   fitRigid(src[], dst[]) → { M, rms, residuals[] }       rigid transform from ≥ 3 point pairs, least squares (Horn's
 *                                                         quaternion method); `residuals[k]` = |M·src[k] − dst[k]|, one per pair.
 *                                                         Throws code 'few' (< 3 pairs) | 'collinear' (the points lie on a line)
 *   new Session({ workPoints })                            the scans, their transforms, pairs and history
 *     .addScan({ name, size, head, cloud }) → i            cloud = pointcloud.js loadCloud's result
 *     .matrix(i) · .setMatrix(i, M, label) · .undo(i) · .reset(i)
 *     .addPair(i, p, target) · .removePair(i, k) · .pairs(i) · .setTarget(i, k, target)
 *     .solvePairs(i) → { M, rms, residuals[], used }       places scan i from its pairs (pushes history)
 *     await .icp(i, against[], opts) → { iterations[], converged, stopped, rms, M }
 *         opts { mode 'p2p' | 'plane' | 'both' (point-to-point first, then point-to-plane), p2pIterations 20, planeIterations 20,
 *                movingPoints 20000, fixedPoints 60000 (the decimation), maxDistance (auto: 5% of the fixed scans' size),
 *                tolerance 1e-5 (relative change in the error that ends a phase), signal (AbortSignal: the Stop button),
 *                onIteration({ n, phase, rms, planeRms, matched, of, M }) }
 *         `iterations[k]` = { n, phase 'p2p' | 'plane', rms, planeRms | null, matched, of } — the error of each step
 *     .toProject() → object (JSON) · Session.checkProject(obj) → project | throws { code } · .applyProject(project)
 *     .registered() → [{ name, cloud, M }] (what scan-export.js writes)
 *   Project file (`.ccscans.json`, format 'cadcraft-scan-registration'): the transforms plus REFERENCES to the scan files
 *   (name, size, sha-256 of the first 64 KB) — never the points. Untrusted on the way in: shapes, counts and matrices checked.
 * Local math: ICP works in coordinates relative to `origin` (the first scan's origin, in whole units) so state-plane numbers
 * keep their millimetres in float64; the matrices a caller sees are always in the files' absolute coordinates.
 */

export const PROJECT_FORMAT = 'cadcraft-scan-registration';
const tick = () => new Promise((r) => setTimeout(r, 0));
const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

// --------------------------------------------------------------------- 4 × 4, row-major
export const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function mul4(a, b) {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c]; o[r * 4 + c] = s; }
  return o;
}
export const apply4 = (M, p) => [
  M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3],
  M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7],
  M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11]];
/** The inverse of a rigid transform. */
export function inv4(M) {
  const R = [M[0], M[4], M[8], M[1], M[5], M[9], M[2], M[6], M[10]];
  const t = [-(R[0] * M[3] + R[1] * M[7] + R[2] * M[11]), -(R[3] * M[3] + R[4] * M[7] + R[5] * M[11]), -(R[6] * M[3] + R[7] * M[7] + R[8] * M[11])];
  return [R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2], 0, 0, 0, 1];
}
/** M expressed in coordinates shifted by `o` (local = absolute − o): out · (p − o) = M · p − o. `back` undoes it. */
export function shiftM(M, o, back = false) {
  const R = [[M[0], M[1], M[2]], [M[4], M[5], M[6]], [M[8], M[9], M[10]]];
  const Ro = R.map((r) => r[0] * o[0] + r[1] * o[1] + r[2] * o[2]);
  const t = [M[3], M[7], M[11]].map((v, k) => (back ? v - Ro[k] + o[k] : v + Ro[k] - o[k]));
  return [M[0], M[1], M[2], t[0], M[4], M[5], M[6], t[1], M[8], M[9], M[10], t[2], 0, 0, 0, 1];
}
/** Is M a rigid transform (orthonormal rotation, determinant 1, last row 0 0 0 1)? */
export function isRigid(M, tol = 1e-6) {
  if (!Array.isArray(M) || M.length !== 16 || !M.every(Number.isFinite)) return false;
  if (Math.abs(M[12]) > tol || Math.abs(M[13]) > tol || Math.abs(M[14]) > tol || Math.abs(M[15] - 1) > tol) return false;
  const r = [[M[0], M[1], M[2]], [M[4], M[5], M[6]], [M[8], M[9], M[10]]];
  for (let a = 0; a < 3; a++) for (let b = a; b < 3; b++) {
    const d = r[a][0] * r[b][0] + r[a][1] * r[b][1] + r[a][2] * r[b][2];
    if (Math.abs(d - (a === b ? 1 : 0)) > tol) return false;
  }
  const det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
  return Math.abs(det - 1) <= tol;
}
/** A rotation of `angle` radians about the (unit) axis, as a 4 × 4. */
export function rotation4(axis, angle, centre = [0, 0, 0]) {
  const [x, y, z] = axis, c = Math.cos(angle), s = Math.sin(angle), k = 1 - c;
  const R = [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k];
  const t = [0, 1, 2].map((r) => centre[r] - (R[r * 3] * centre[0] + R[r * 3 + 1] * centre[1] + R[r * 3 + 2] * centre[2]));
  return [R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2], 0, 0, 0, 1];
}
/** Rotation angle (degrees) and translation length of a rigid transform: for reading a result in words. */
export function describeM(M) {
  const tr = M[0] + M[5] + M[10];
  return { angle: Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2))) * 180 / Math.PI, shift: Math.hypot(M[3], M[7], M[11]) };
}

// --------------------------------------------------------------------- symmetric eigenproblem (Jacobi, n ≤ 4)
/** Eigenvalues (descending) and eigenvectors (columns of V as arrays, same order) of a symmetric matrix. */
export function eigenSym(A0) {
  const n = A0.length, A = A0.map((r) => r.slice()), V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-300) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  const order = [...Array(n).keys()].sort((a, b) => A[b][b] - A[a][a]);
  return { values: order.map((i) => A[i][i]), vectors: order.map((i) => V.map((r) => r[i])) };
}

// --------------------------------------------------------------------- the rigid fit from pairs
/** Horn's closed form: the rotation is the top eigenvector (a quaternion) of a 4 × 4 built from the pairs' cross-covariance. */
export function fitRigid(src, dst) {
  const n = Math.min(src.length, dst.length);
  if (n < 3) throw fail('few', { n });
  const cs = [0, 0, 0], cd = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { cs[a] += src[i][a] / n; cd[a] += dst[i][a] / n; }
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) {
    const s = [src[i][0] - cs[0], src[i][1] - cs[1], src[i][2] - cs[2]], d = [dst[i][0] - cd[0], dst[i][1] - cd[1], dst[i][2] - cd[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) { S[a][b] += s[a] * d[b]; C[a][b] += s[a] * s[b]; }
  }
  const ev = eigenSym(C).values;
  if (!(ev[0] > 0) || ev[1] < 1e-9 * ev[0]) throw fail('collinear');   // a line fixes no turn about itself
  const [Sxx, Sxy, Sxz] = S[0], [Syx, Syy, Syz] = S[1], [Szx, Szy, Szz] = S[2];
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz]];
  const [w, x, y, z] = eigenSym(N).vectors[0];
  const R = [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
  const t = [0, 1, 2].map((r) => cd[r] - (R[r * 3] * cs[0] + R[r * 3 + 1] * cs[1] + R[r * 3 + 2] * cs[2]));
  const M = [R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2], 0, 0, 0, 1];
  const residuals = [];
  let ss = 0;
  for (let i = 0; i < n; i++) { const p = apply4(M, src[i]); const r = Math.hypot(p[0] - dst[i][0], p[1] - dst[i][1], p[2] - dst[i][2]); residuals.push(r); ss += r * r; }
  return { M, rms: Math.sqrt(ss / n), residuals };
}

// --------------------------------------------------------------------- a bucket grid: nearest and k nearest
/** Points (Float64Array of triples) in a dense grid of cells, sized so a cell holds ~6 points on average. */
export class Grid {
  constructor(pts) {
    const n = pts.length / 3;
    this.pts = pts; this.n = n;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { const v = pts[i * 3 + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
    if (!n) { lo.fill(0); hi.fill(0); }
    this.lo = lo; this.hi = hi;
    const ext = [0, 1, 2].map((a) => Math.max(hi[a] - lo[a], 1e-9));
    this.diag = Math.hypot(...ext);
    let cell = Math.cbrt((ext[0] * ext[1] * ext[2]) / Math.max(1, n / 6));
    cell = Math.max(cell, this.diag / 1500);
    for (let round = 0; round < 12; round++) {
      const dims = ext.map((e) => Math.max(1, Math.ceil(e / cell)));
      if (dims[0] * dims[1] * dims[2] > 4e6) { cell *= 1.4; continue; }
      this.cell = cell; this.dims = dims;
      const cells = dims[0] * dims[1] * dims[2], counts = new Int32Array(cells + 1);
      for (let i = 0; i < n; i++) counts[this.idx(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]) + 1]++;
      let used = 0; for (let c = 1; c <= cells; c++) if (counts[c]) used++;
      if (n && used && n / used < 4 && round < 11) { cell *= 1.4; continue; }
      for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
      this.start = counts;
      this.order = new Int32Array(n);
      const fill = counts.slice(0, cells);
      for (let i = 0; i < n; i++) this.order[fill[this.idx(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2])]++] = i;
      return;
    }
  }
  cellOf(v, a) { return Math.min(this.dims[a] - 1, Math.max(0, Math.floor((v - this.lo[a]) / this.cell))); }
  idx(x, y, z) { return (this.cellOf(z, 2) * this.dims[1] + this.cellOf(y, 1)) * this.dims[0] + this.cellOf(x, 0); }
  /** Visit every point in the cells at Chebyshev distance exactly r from (cx, cy, cz). */
  ring(cx, cy, cz, r, fn) {
    const [nx, ny, nz] = this.dims;
    for (let dz = -r; dz <= r; dz++) {
      const z = cz + dz; if (z < 0 || z >= nz) continue;
      for (let dy = -r; dy <= r; dy++) {
        const y = cy + dy; if (y < 0 || y >= ny) continue;
        const edge = Math.abs(dz) === r || Math.abs(dy) === r;
        for (let dx = -r; dx <= r; dx += (edge || r === 0 ? 1 : 2 * r)) {
          const x = cx + dx; if (x < 0 || x >= nx) continue;
          const c = (z * ny + y) * nx + x;
          for (let k = this.start[c]; k < this.start[c + 1]; k++) fn(this.order[k]);
        }
      }
    }
  }
  /** Index of the point nearest (x, y, z) within maxR, else −1; `out.d` = the distance. */
  nearest(x, y, z, maxR, out = {}) {
    const cx = this.cellOf(x, 0), cy = this.cellOf(y, 1), cz = this.cellOf(z, 2);
    const R = Math.min(Math.ceil(maxR / this.cell), Math.max(...this.dims));
    let best = -1, bd = Infinity;
    const p = this.pts;
    for (let r = 0; r <= R; r++) {
      this.ring(cx, cy, cz, r, (i) => { const dx = p[i * 3] - x, dy = p[i * 3 + 1] - y, dz = p[i * 3 + 2] - z, d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; best = i; } });
      if (best >= 0 && Math.sqrt(bd) <= r * this.cell) break;
    }
    out.d = Math.sqrt(bd);
    return best >= 0 && out.d <= maxR ? best : -1;
  }
  /** The k nearest points' indices (fewer when the grid has fewer), nearest first. */
  knn(x, y, z, k) {
    const cx = this.cellOf(x, 0), cy = this.cellOf(y, 1), cz = this.cellOf(z, 2);
    const R = Math.max(...this.dims), bi = [], bd = [];
    const p = this.pts;
    for (let r = 0; r <= R; r++) {
      this.ring(cx, cy, cz, r, (i) => {
        const dx = p[i * 3] - x, dy = p[i * 3 + 1] - y, dz = p[i * 3 + 2] - z, d = dx * dx + dy * dy + dz * dz;
        if (bi.length === k && d >= bd[k - 1]) return;
        let at = bi.length; while (at > 0 && bd[at - 1] > d) at--;
        bi.splice(at, 0, i); bd.splice(at, 0, d);
        if (bi.length > k) { bi.pop(); bd.pop(); }
      });
      if (bi.length === k && Math.sqrt(bd[k - 1]) <= r * this.cell) break;
    }
    return bi;
  }
}

/** Surface normals of a point set by the smallest axis of its k nearest neighbours; null where the points are too few or lie on a line. */
export function estimateNormals(grid, k = 10, into = null, from = 0, to = grid.n) {
  const n = grid.n, out = into?.normals || new Float32Array(n * 3), ok = into?.ok || new Uint8Array(n), p = grid.pts;
  for (let i = from; i < to; i++) {
    const nb = grid.knn(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], k);
    if (nb.length < 5) continue;
    const c = [0, 0, 0];
    for (const j of nb) for (let a = 0; a < 3; a++) c[a] += p[j * 3 + a] / nb.length;
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const j of nb) { const d = [p[j * 3] - c[0], p[j * 3 + 1] - c[1], p[j * 3 + 2] - c[2]]; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += d[a] * d[b]; }
    const e = eigenSym(C);
    if (!(e.values[0] > 0) || e.values[1] < 1e-6 * e.values[0]) continue;   // a line: no normal
    const v = e.vectors[2];
    out[i * 3] = v[0]; out[i * 3 + 1] = v[1]; out[i * 3 + 2] = v[2]; ok[i] = 1;
  }
  return { normals: out, ok };
}

/** Solve A x = b (n × n, Gaussian elimination with partial pivoting); null when singular. */
function solveLinear(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}

/** Every `stride`-th triple of a Float64Array, so at most `max` points. */
export function decimate(pts, max) {
  const n = pts.length / 3;
  if (n <= max) return pts;
  const stride = n / max, out = new Float64Array(Math.floor(max) * 3);
  for (let k = 0; k < out.length / 3; k++) { const i = Math.floor(k * stride); out[k * 3] = pts[i * 3]; out[k * 3 + 1] = pts[i * 3 + 1]; out[k * 3 + 2] = pts[i * 3 + 2]; }
  return out;
}
const transformPts = (pts, M) => {
  const o = new Float64Array(pts.length);
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1], z = pts[i + 2];
    o[i] = M[0] * x + M[1] * y + M[2] * z + M[3]; o[i + 1] = M[4] * x + M[5] * y + M[6] * z + M[7]; o[i + 2] = M[8] * x + M[9] * y + M[10] * z + M[11];
  }
  return o;
};

// --------------------------------------------------------------------- ICP
/**
 * Iterative closest point of `moving` (local points, Float64Array triples) against `fixed` (local, already in the registered
 * frame), from the starting transform `M0` (local → registered, 4 × 4 row-major). Returns the transform it reached.
 * (The normals for point to plane are made first, in slices; Stop works then too.)
 * Point to point: each step is fitRigid of the matched pairs. Point to plane: each step is the small-angle least-squares
 * solution of Σ ((R p + t − q) · n)², with the fixed points' normals; the turn is made exact (Rodrigues) before it is applied.
 */
export async function icpRun(moving, fixed, M0, o = {}) {
  const mode = o.mode || 'both';
  const p2pN = mode === 'plane' ? 0 : (o.p2pIterations ?? 20), planeN = mode === 'p2p' ? 0 : (o.planeIterations ?? 20);
  const src = decimate(moving, o.movingPoints ?? 20000), dst = decimate(fixed, o.fixedPoints ?? 60000);
  if (src.length < 9 || dst.length < 9) throw fail('empty');
  const grid = new Grid(dst);
  const maxD0 = o.maxDistance > 0 ? o.maxDistance : 0.05 * grid.diag;
  const tol = o.tolerance ?? 1e-5;
  let nrm = null;
  if (planeN) {   // in slices, so the page stays usable and Stop works while the normals are made
    nrm = { normals: new Float32Array(grid.n * 3), ok: new Uint8Array(grid.n) };
    for (let from = 0; from < grid.n; from += 8000) {
      if (o.signal?.aborted) return { M: M0.slice(), iterations: [], converged: false, stopped: true, rms: null, planeRms: null };
      estimateNormals(grid, 10, nrm, from, Math.min(grid.n, from + 8000));
      await tick();
    }
  }
  let T = M0.slice();
  const its = [];
  let cut = maxD0, stopped = false, converged = false, n = 0;
  const hit = {};
  const n_src = src.length / 3;
  for (const [phase, count] of [['p2p', p2pN], ['plane', planeN]]) {
    let prev = Infinity, settled = false;
    for (let it = 0; it < count; it++) {
      if (o.signal?.aborted) { stopped = true; break; }
      const P = [], Q = [], N = [];
      let ss = 0, sp = 0, matched = 0;
      for (let i = 0; i < n_src; i++) {
        const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
        const px = T[0] * x + T[1] * y + T[2] * z + T[3], py = T[4] * x + T[5] * y + T[6] * z + T[7], pz = T[8] * x + T[9] * y + T[10] * z + T[11];
        const j = grid.nearest(px, py, pz, cut, hit);
        if (j < 0) continue;
        if (phase === 'plane' && !nrm.ok[j]) continue;
        matched++; ss += hit.d * hit.d;
        P.push(px, py, pz); Q.push(dst[j * 3], dst[j * 3 + 1], dst[j * 3 + 2]);
        if (nrm) { const nx = nrm.normals[j * 3], ny = nrm.normals[j * 3 + 1], nz = nrm.normals[j * 3 + 2]; N.push(nx, ny, nz); const d = (px - dst[j * 3]) * nx + (py - dst[j * 3 + 1]) * ny + (pz - dst[j * 3 + 2]) * nz; sp += d * d; }
      }
      if (matched < 6) throw fail('no_overlap', { matched });
      const rms = Math.sqrt(ss / matched), planeRms = nrm ? Math.sqrt(sp / matched) : null;
      let D;
      if (phase === 'p2p') {
        const a = [], b = [];
        for (let k = 0; k < matched; k++) { a.push([P[k * 3], P[k * 3 + 1], P[k * 3 + 2]]); b.push([Q[k * 3], Q[k * 3 + 1], Q[k * 3 + 2]]); }
        try { D = fitRigid(a, b).M; } catch (e) { throw fail('degenerate'); }
      } else {
        const c = [0, 0, 0];
        for (let k = 0; k < matched; k++) for (let a = 0; a < 3; a++) c[a] += P[k * 3 + a] / matched;
        const A = Array.from({ length: 6 }, () => new Array(6).fill(0)), bb = new Array(6).fill(0);
        for (let k = 0; k < matched; k++) {
          const p = [P[k * 3] - c[0], P[k * 3 + 1] - c[1], P[k * 3 + 2] - c[2]], nn = [N[k * 3], N[k * 3 + 1], N[k * 3 + 2]];
          const row = [p[1] * nn[2] - p[2] * nn[1], p[2] * nn[0] - p[0] * nn[2], p[0] * nn[1] - p[1] * nn[0], nn[0], nn[1], nn[2]];
          const r = (P[k * 3] - Q[k * 3]) * nn[0] + (P[k * 3 + 1] - Q[k * 3 + 1]) * nn[1] + (P[k * 3 + 2] - Q[k * 3 + 2]) * nn[2];
          for (let u = 0; u < 6; u++) { for (let v = 0; v < 6; v++) A[u][v] += row[u] * row[v]; bb[u] -= row[u] * r; }
        }
        const tr = A.reduce((s, r, i) => s + r[i], 0);
        for (let u = 0; u < 6; u++) A[u][u] += 1e-9 * tr / 6 + 1e-300;
        const x = solveLinear(A, bb);
        if (!x || !x.every(Number.isFinite)) throw fail('degenerate');
        const ang = Math.hypot(x[0], x[1], x[2]);
        const Rm = ang < 1e-15 ? I4() : rotation4([x[0] / ang, x[1] / ang, x[2] / ang], ang);
        // the turn is about the matched centroid: p' = Rδ (p − c) + c + t
        D = Rm.slice();
        const Rc = [Rm[0] * c[0] + Rm[1] * c[1] + Rm[2] * c[2], Rm[4] * c[0] + Rm[5] * c[1] + Rm[6] * c[2], Rm[8] * c[0] + Rm[9] * c[1] + Rm[10] * c[2]];
        D[3] = c[0] - Rc[0] + x[3]; D[7] = c[1] - Rc[1] + x[4]; D[11] = c[2] - Rc[2] + x[5];
      }
      T = mul4(D, T);
      n++;
      const rec = { n, phase, rms, planeRms, matched, of: n_src };
      its.push(rec);
      o.onIteration?.({ ...rec, M: T });
      cut = Math.min(maxD0, Math.max(2.5 * rms, 1e-6 * grid.diag));
      const metric = phase === 'plane' ? planeRms : rms;
      const done = Math.abs(prev - metric) <= tol * Math.max(metric, 1e-12) || metric < 1e-12;
      prev = metric;
      await tick();
      if (done) { settled = true; break; }
    }
    if (stopped) break;
    if (count) converged = settled;   // the last phase that ran says whether the error stopped changing before its iterations ran out
  }
  return { M: T, iterations: its, converged, stopped, rms: its.at(-1)?.rms ?? null, planeRms: its.at(-1)?.planeRms ?? null };
}

// --------------------------------------------------------------------- the session
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
/** sha-256 (first 16 bytes, hex) of a file's first 64 KB: with the name and size, how a project finds its scan file again. */
export async function fileHead(file) {
  const bytes = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).slice(0, 32);
}

const LIMITS = { scans: 200, pairs: 2000, history: 50 };
export class Session {
  constructor({ workPoints = 200000 } = {}) {
    this.scans = [];
    this.workPoints = workPoints;
    this.origin = null;
    this.log = [];   // what was done: { scan, method, rms, iterations, when }
  }
  addScan({ name, size = 0, head = '', cloud }) {
    if (this.scans.length >= LIMITS.scans) throw fail('too_many_scans');
    if (!this.origin) this.origin = cloud.origin.map((v) => Math.round(v));
    const n = cloud.n, stride = Math.max(1, Math.ceil(n / this.workPoints)), m = Math.floor((n + stride - 1) / stride);
    const work = new Float64Array(m * 3), o = this.origin;
    for (let k = 0; k < m; k++) {
      const i = k * stride;
      work[k * 3] = cloud.pos[i * 3] + cloud.origin[0] - o[0]; work[k * 3 + 1] = cloud.pos[i * 3 + 1] + cloud.origin[1] - o[1]; work[k * 3 + 2] = cloud.pos[i * 3 + 2] + cloud.origin[2] - o[2];
    }
    this.scans.push({ name, size, head, cloud, M: I4(), hist: [], pairs: [], work });
    return this.scans.length - 1;
  }
  removeScan(i) { this.scans.splice(i, 1); }
  matrix(i) { return this.scans[i].M.slice(); }
  /** The transform in the working (origin-shifted) frame. */
  local(i) { return shiftM(this.scans[i].M, this.origin); }
  setMatrix(i, M, label = '') {
    if (!isRigid(M)) throw fail('bad_matrix');
    const s = this.scans[i];
    s.hist.push({ M: s.M.slice(), label });
    if (s.hist.length > LIMITS.history) s.hist.shift();
    s.M = M.slice();
  }
  undo(i) { const s = this.scans[i], h = s.hist.pop(); if (!h) return false; s.M = h.M; return true; }
  reset(i) { this.setMatrix(i, I4(), 'reset'); }
  /** Scan i's decimated points in the registered frame, working coordinates (origin shifted). */
  world(i, max = Infinity) { return transformPts(decimate(this.scans[i].work, max), this.local(i)); }
  /** Absolute coordinates (file units) of a registered point of scan i: for targets picked on another scan. */
  worldAbs(i, p) { return apply4(this.scans[i].M, p); }

  // ---- pairs: a point of scan i (its own absolute file coordinates) and where it must land (registered frame, absolute)
  addPair(i, p, target = null) { const s = this.scans[i]; if (s.pairs.length >= LIMITS.pairs) throw fail('too_many_pairs'); s.pairs.push({ p: p.slice(), target: target ? target.slice() : null }); return s.pairs.length - 1; }
  setTarget(i, k, target) { this.scans[i].pairs[k].target = target ? target.slice() : null; }
  removePair(i, k) { this.scans[i].pairs.splice(k, 1); }
  pairs(i) { return this.scans[i].pairs.map((q) => ({ p: q.p.slice(), target: q.target && q.target.slice() })); }
  /** Residuals of the pairs under the scan's present transform (what is left over now). */
  pairResiduals(i) {
    const s = this.scans[i];
    return s.pairs.map((q) => (q.target ? Math.hypot(...apply4(s.M, q.p).map((v, a) => v - q.target[a])) : null));
  }
  /** Place scan i from its pairs that have a target: least squares, the residual of each pair returned in pair order. */
  solvePairs(i) {
    const s = this.scans[i], idx = [];
    s.pairs.forEach((q, k) => { if (q.target && q.target.every(Number.isFinite)) idx.push(k); });
    const r = fitRigid(idx.map((k) => s.pairs[k].p), idx.map((k) => s.pairs[k].target));
    this.setMatrix(i, r.M, 'pairs');
    const residuals = s.pairs.map(() => null);
    idx.forEach((k, j) => { residuals[k] = r.residuals[j]; });
    this.log.push({ scan: i, method: 'pairs', rms: r.rms, pairs: idx.length, when: new Date().toISOString() });
    return { M: r.M, rms: r.rms, residuals, used: idx.length };
  }

  /** Refine scan i against the scans in `against` (their transforms as they are now). Never changes a point. */
  async icp(i, against, opts = {}) {
    if (!against.length || against.includes(i)) throw fail('no_reference');
    const fixed = [];
    for (const j of against) fixed.push(this.world(j));
    const total = fixed.reduce((n, a) => n + a.length, 0), all = new Float64Array(total);
    let at = 0; for (const a of fixed) { all.set(a, at); at += a.length; }
    const s = this.scans[i];
    s.hist.push({ M: s.M.slice(), label: 'icp' });   // one undo step for the whole run
    if (s.hist.length > LIMITS.history) s.hist.shift();
    const before = s.M.slice();
    try {
      const run = await icpRun(s.work, all, this.local(i), {
        ...opts,
        onIteration: (r) => { s.M = shiftM(r.M, this.origin, true); opts.onIteration?.({ ...r, M: s.M.slice() }); },
      });
      s.M = shiftM(run.M, this.origin, true);
      if (!isRigid(s.M, 1e-6)) throw fail('degenerate');
      this.log.push({ scan: i, method: 'icp-' + (opts.mode || 'both'), rms: run.rms, planeRms: run.planeRms, iterations: run.iterations.length, stopped: run.stopped, when: new Date().toISOString() });
      return { ...run, M: s.M.slice() };
    } catch (e) { s.M = before; s.hist.pop(); throw e; }
  }

  registered() { return this.scans.map((s) => ({ name: s.name, cloud: s.cloud, M: s.M.slice() })); }

  // ---- the project file
  toProject() {
    return {
      format: PROJECT_FORMAT, version: 1, created: new Date().toISOString(),
      scans: this.scans.map((s, k) => ({
        file: { name: s.name, size: s.size, head: s.head }, matrix: s.M.slice(),
        pairs: s.pairs.map((q) => ({ p: q.p.slice(), target: q.target ? q.target.slice() : null })),
      })),
      log: this.log.slice(-200),
    };
  }
  /** Check a project file read from outside; returns it (copied, trimmed to what is known) or throws code 'project'. */
  static checkProject(obj) {
    const bad = (why) => fail('project', { why });
    if (!obj || typeof obj !== 'object' || obj.format !== PROJECT_FORMAT) throw bad('format');
    if (obj.version !== 1) throw bad('version');
    if (!Array.isArray(obj.scans) || !obj.scans.length || obj.scans.length > LIMITS.scans) throw bad('scans');
    const v3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
    const scans = obj.scans.map((s) => {
      const f = s?.file;
      if (!f || typeof f.name !== 'string' || !f.name || f.name.length > 260 || !Number.isFinite(f.size) || f.size < 0) throw bad('file');
      if (!isRigid(s.matrix, 1e-5)) throw bad('matrix');
      const pairs = Array.isArray(s.pairs) ? s.pairs : [];
      if (pairs.length > LIMITS.pairs) throw bad('pairs');
      return {
        file: { name: f.name, size: f.size, head: typeof f.head === 'string' ? f.head.slice(0, 64) : '' }, matrix: s.matrix.slice(),
        pairs: pairs.filter((q) => v3(q?.p) && (q.target === null || v3(q.target))).map((q) => ({ p: q.p.slice(), target: q.target ? q.target.slice() : null })),
      };
    });
    return { format: PROJECT_FORMAT, version: 1, created: typeof obj.created === 'string' ? obj.created.slice(0, 40) : '', scans, log: [] };
  }
  /** Put a checked project's transforms and pairs on the scans already added (matched by name and size, the head hash when both have one). Returns { matched[], missing[] } (project scan indices). */
  applyProject(project) {
    const matched = [], missing = [], used = new Set();
    project.scans.forEach((ps, k) => {
      const i = this.scans.findIndex((s, j) => !used.has(j) && s.name === ps.file.name && (!s.size || !ps.file.size || s.size === ps.file.size) && (!s.head || !ps.file.head || s.head === ps.file.head));
      if (i < 0) { missing.push(k); return; }
      used.add(i);
      this.setMatrix(i, ps.matrix, 'project');
      this.scans[i].pairs = ps.pairs.map((q) => ({ p: q.p.slice(), target: q.target ? q.target.slice() : null }));
      matched.push(k);
    });
    return { matched, missing };
  }
}
