/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pdf-snap.js — snapping to a PDF underlay's own lines (0.7 D7.24). DOM-free. The grid index is a copy of TakeoffCraft's
 * snap.js (SnapIndex, distSeg, intersect: each app keeps its own copies); the segments come from pdf-vector.js `segmentsOf`.
 *
 *   const idx = new SnapIndex(segmentsOf(pageVector))      in the page's points (origin lower-left, y up)
 *   idx.snap({x, y}, tol, { end, mid, int, near })          → { x, y, kind: 'end'|'mid'|'int'|'near', d } | null
 */

/** A uniform grid over the segments, for "what is near the pointer". */
export class SnapIndex {
  constructor({ segs, curve, n }) {
    this.segs = segs; this.curve = curve || new Uint8Array(n); this.n = n;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n * 4; i += 2) { const x = segs[i], y = segs[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (!n) { x0 = y0 = 0; x1 = y1 = 1; }
    const span = Math.max(x1 - x0, y1 - y0, 1);
    const cols = Math.max(1, Math.min(1024, Math.round(Math.sqrt(n) * 2)));
    this.cell = span / cols;
    this.x0 = x0; this.y0 = y0;
    this.cols = Math.max(1, Math.ceil((x1 - x0) / this.cell) + 1);
    this.rows = Math.max(1, Math.ceil((y1 - y0) / this.cell) + 1);
    this.grid = new Map();
    for (let s = 0; s < n; s++) this.insert(s);
  }
  cellOf(x, y) { return [Math.floor((x - this.x0) / this.cell), Math.floor((y - this.y0) / this.cell)]; }
  insert(s) {
    const g = this.segs, ax = g[s * 4], ay = g[s * 4 + 1], bx = g[s * 4 + 2], by = g[s * 4 + 3];
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len / (this.cell * 0.5)));
    let last = -1;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const [cx, cy] = this.cellOf(ax + (bx - ax) * t, ay + (by - ay) * t);
      const key = cy * this.cols + cx;
      if (key === last) continue;
      last = key;
      let list = this.grid.get(key);
      if (!list) this.grid.set(key, (list = []));
      if (list[list.length - 1] !== s) list.push(s);
    }
  }
  /** Segment numbers whose cells are within `r` of p (deduped). */
  near(p, r) {
    const [c0, r0] = this.cellOf(p.x - r, p.y - r), [c1, r1] = this.cellOf(p.x + r, p.y + r);
    const seen = new Set();
    for (let cy = Math.max(0, r0); cy <= Math.min(this.rows - 1, r1); cy++) {
      for (let cx = Math.max(0, c0); cx <= Math.min(this.cols - 1, c1); cx++) {
        const list = this.grid.get(cy * this.cols + cx);
        if (list) for (const s of list) seen.add(s);
      }
    }
    return [...seen];
  }
  /**
   * The snap point for p within tol (user units), or null.
   * `kinds` limits what is offered: { end, mid, int, near } (all true by default).
   */
  snap(p, tol, kinds = {}) {
    const want = { end: true, mid: true, int: true, near: true, ...kinds };
    const g = this.segs, cur = this.curve;
    const cand = this.near(p, tol).filter((s) => distSeg(p, g, s) <= tol);
    if (!cand.length) return null;
    let best = null;
    const RANK = { end: 0, int: 1, mid: 2 };     // the same spot found twice (a crossing at a midpoint): the stronger name
    const offer = (x, y, kind) => {
      const d = Math.hypot(x - p.x, y - p.y);
      if (d > tol) return;
      if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && RANK[kind] < RANK[best.kind])) best = { x, y, kind, d };
    };
    for (const s of cand) {
      const ax = g[s * 4], ay = g[s * 4 + 1], bx = g[s * 4 + 2], by = g[s * 4 + 3];
      if (want.end) {
        // a flattened curve's inner chord points are not ends; its own two ends are
        if (!cur[s] || cur[s] & 2) offer(ax, ay, 'end');
        if (!cur[s] || cur[s] & 4) offer(bx, by, 'end');
      }
      if (want.mid && !cur[s]) offer((ax + bx) / 2, (ay + by) / 2, 'mid');
    }
    if (want.int) {
      const list = cand.slice(0, 80);
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const q = intersect(g, list[i], list[j]);
        if (q) offer(q.x, q.y, 'int');
      }
    }
    if (best) return best;
    if (!want.near) return null;
    for (const s of cand) {
      const q = closestOnSeg(p, g, s);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (!best || d < best.d) best = { x: q.x, y: q.y, kind: 'near', d };
    }
    return best && best.d <= tol ? best : null;
  }
}

function closestOnSeg(p, g, s) {
  const ax = g[s * 4], ay = g[s * 4 + 1], bx = g[s * 4 + 2], by = g[s * 4 + 3];
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / L)) : 0;
  return { x: ax + dx * t, y: ay + dy * t };
}
function distSeg(p, g, s) { const q = closestOnSeg(p, g, s); return Math.hypot(q.x - p.x, q.y - p.y); }

/** Where two segments cross (ends included), or null (parallel, or apart). */
export function intersect(g, s, t) {
  const ax = g[s * 4], ay = g[s * 4 + 1], bx = g[s * 4 + 2], by = g[s * 4 + 3];
  const cx = g[t * 4], cy = g[t * 4 + 1], dx = g[t * 4 + 2], dy = g[t * 4 + 3];
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12 * Math.max(1, Math.hypot(rx, ry) * Math.hypot(sx, sy))) return null;
  const u = ((cx - ax) * sy - (cy - ay) * sx) / den, v = ((cx - ax) * ry - (cy - ay) * rx) / den;
  const e = 1e-9;
  if (u < -e || u > 1 + e || v < -e || v > 1 + e) return null;
  // two pieces that only meet end to end (a corner, a curve's chords) do not cross: that point is an end, or nothing
  const atEnd = (w) => w < e || w > 1 - e;
  if (atEnd(u) && atEnd(v)) return null;
  return { x: ax + rx * u, y: ay + ry * u };
}

