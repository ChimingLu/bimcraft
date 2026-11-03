/* SPDX-License-Identifier: Apache-2.0 */
/** F04: read-only plan graphics. The wall's existing joined envelope owns the
 * clipping; this module never changes a physical join, recipe or reference.
 * Layer offsets are in the analytic wall frame, exterior to interior. Screen,
 * plan PDF and sheet PDF consume the same polygons and open boundary paths.
 */
import { wallMap } from './model-arcs.js';
import { wallPieces, inPoly, segDist } from './model-plan.js';
import { hatchSegments } from './drafting.js';

export const PLAN_DETAILS = ['coarse', 'medium', 'fine'];
// Rendering chord error, not a model tolerance. Analytic layer offsets are exact.
export const PLAN_CHORD_ERROR = 0.002;

function clip(poly, axis, at, side) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ia = side * (a[axis] - at) >= -1e-9, ib = side * (b[axis] - at) >= -1e-9;
    if (ia) out.push(a);
    if (ia !== ib) { const t = (at - a[axis]) / (b[axis] - a[axis]); out.push(a.map((v, j) => j === axis ? at : v + (b[j] - v) * t)); }
  }
  return out;
}

// Includes a zero-width membrane on either outer face, where an even/odd
// interior-only segment clip would otherwise drop the upper boundary.
function boundarySegments(poly, offset) {
  const xs = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (Math.abs(a[1] - offset) < 1e-7) xs.push(a[0]);
    if ((a[1] < offset && b[1] > offset) || (a[1] > offset && b[1] < offset)) xs.push(a[0] + (b[0] - a[0]) * (offset - a[1]) / (b[1] - a[1]));
  }
  xs.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < xs.length - 1; i++) {
    if (xs[i + 1] - xs[i] < 1e-7) continue;
    const x = (xs[i] + xs[i + 1]) / 2;
    if (inPoly(x, offset, poly) || poly.some((a, j) => segDist(x, offset, a, poly[(j + 1) % poly.length]) < 1e-7)) out.push([[xs[i], offset], [xs[i + 1], offset]]);
  }
  return out;
}

/** Envelope in (arc station, lateral offset). Bulged faces become horizontal
 * lines. Straight end caps are sampled before mapping to preserve existing caps.
 */
function localEnvelope(poly, map) {
  if (!map.geom.arc || !poly.bulged) return poly.map(map.toL);
  const out = [], p = poly.bulged;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    out.push(map.toL(a));
    if (!a[2] && Math.abs(map.toL(a)[0] - map.toL(b)[0]) > 1e-6) {
      const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2);
      for (let j = 1; j < n; j++) out.push(map.toL([a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n]));
    }
  }
  return out;
}
function mappedPath(points, map, closed = false) {
  if (!map.geom.arc) return points.map(map.toW);
  const { R } = map.geom.arc, out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    out.push(map.toW(a));
    if (!closed && i === points.length - 1) break;
    const radius = R + Math.max(Math.abs(a[1]), Math.abs(b[1]));
    const step = 2 * Math.acos(Math.max(-1, 1 - PLAN_CHORD_ERROR / radius));
    const n = Math.max(1, Math.ceil(Math.abs(b[0] - a[0]) / R / step));
    for (let j = 1; j < n; j++) out.push(map.toW(a.map((v, k) => v + (b[k] - v) * j / n)));
  }
  return out;
}

/** Returns scene wall rows; invalid/unknown recipes keep the envelope only and
 * carry a diagnostic. No defaults stand in for an unsupported authored record.
 */
export function wallPlanGraphics(walls, outlines, openings, materials, { detail = 'coarse', cutZ = 1200, scale = 50, keyBase = 0 } = {}) {
  if (!PLAN_DETAILS.includes(detail)) throw new Error('Invalid plan detail')   // i18n-ignore: a programming error (callers pass PLAN_DETAILS);
  const byMaterial = new Map((materials || []).map(m => [m.id, m]));
  return walls.map(wall => {
    const poly = outlines.get(wall.guid) || [], ops = openings.filter(o => o.wall === wall.id);
    const row = { key: keyBase + wall.id, guid: wall.guid, poly, pieces: poly.length ? wallPieces(wall, poly, ops, cutZ) : [] };
    const layers = wall.assembly?.layers;
    if (detail === 'coarse' || !poly.length) return row;
    if (!materials || !layers?.length || layers.some(l => !Number.isFinite(l.t) || l.t < 0 || (l.kind !== 'cavity' && !byMaterial.has(l.materialId))) || Math.abs(layers.reduce((s, l) => s + l.t, 0) - wall.t) > 0.005) {
      row.graphicWarning = 'unavailable'; return row;
    }
    const map = wallMap(wall), local = localEnvelope(poly, map);
    let pieces = [local];
    for (const o of ops) {
      if (!(o.width > 0) || cutZ < o.sill || cutZ > o.sill + o.height) continue;
      pieces = pieces.flatMap(p => [clip(p, 0, o.offset, -1), clip(p, 0, o.offset + o.width, 1)]).filter(p => p.length >= 3);
    }
    // Refine the same analytic envelope for the visible outline, including in PDF.
    row.poly = mappedPath(local, map, true);
    row.pieces = pieces.map(p => mappedPath(p, map, true));
    row.layers = [];
    row.boundaries = [];
    const sign = wall.extSide === 'right' ? -1 : 1;
    let off = sign * wall.t / 2;
    const boundaries = new Map();
    for (const [index, layer] of layers.entries()) {
      const end = off - sign * layer.t, material = byMaterial.get(layer.materialId);
      const polys = layer.t === 0 ? [] : pieces.map(p => clip(clip(p, 1, Math.min(off, end), 1), 1, Math.max(off, end), -1)).filter(p => p.length >= 3).map(p => mappedPath(p, map, true));
      const fill = layer.kind === 'cavity' ? 'none' : material.fill;
      const hatch = detail === 'fine' && ['diagonal', 'crosshatch'].includes(fill) ? polys.flatMap(p => hatchSegments(p, [], fill === 'crosshatch' ? 'cross' : 'diagonal', (scale || 50) / 75)) : [];
      row.layers.push({ index, materialId: layer.materialId, kind: layer.kind, thickness: layer.t, from: off, to: end, polys, fill, color: material?.color, fillColor: material?.fillColor, hatch });
      if (index > 0 && layer.t > 0 && !boundaries.has(off)) boundaries.set(off, { offset: off });
      if (layer.t === 0) boundaries.set(off, { offset: off, membrane: true, color: material.fillColor });
      off = end;
    }
    for (const boundary of boundaries.values()) {
      const paths = [];
      for (const p of pieces) {
        for (const segment of boundarySegments(p, boundary.offset)) paths.push(mappedPath(segment, map));
      }
      row.boundaries.push({ ...boundary, paths });
    }
    return row;
  });
}

// Shared primitives for every output. Cavities and fill:none emit no paint.
export function layerPrimitives(wall) {
  const out = [];
  for (const l of wall.layers || []) {
    if (l.fill !== 'none' && l.polys.length) out.push({ t: 'fill', polys: l.polys, color: l.color });
    if (l.hatch.length) for (let i = 0; i < l.hatch.length; i += 4) out.push({ t: 'line', pts: [[l.hatch[i], l.hatch[i + 1]], [l.hatch[i + 2], l.hatch[i + 3]]], color: l.fillColor, w: 0.10 });
  }
  for (const b of wall.boundaries || []) for (const pts of b.paths) out.push({ t: 'line', pts, color: b.color || '#333333', w: b.membrane ? 0.18 : 0.10, ...(b.membrane ? { dash: [1.2, 0.6] } : {}) });
  return out;
}
export const colorRgb = color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255);

/** Union only touching envelope pieces. Isolated finely tessellated arcs need
 * no intersection search. Returns rings or two-point boundary paths.
 */
export function wallPlanEdges(rows) {
  const pieces = rows.flatMap(w => w.pieces || []);
  const boxes = pieces.map(p => ({ x0: Math.min(...p.map(q => q[0])), x1: Math.max(...p.map(q => q[0])), y0: Math.min(...p.map(q => q[1])), y1: Math.max(...p.map(q => q[1])) }));
  const seen = new Set(), out = [];
  for (let i = 0; i < pieces.length; i++) {
    if (seen.has(i)) continue;
    const group = [i]; seen.add(i);
    for (let k = 0; k < group.length; k++) for (let j = 0; j < pieces.length; j++) {
      if (seen.has(j)) continue;
      const a = boxes[group[k]], b = boxes[j];
      if (a.x0 <= b.x1 + 1e-6 && a.x1 >= b.x0 - 1e-6 && a.y0 <= b.y1 + 1e-6 && a.y1 >= b.y0 - 1e-6) { seen.add(j); group.push(j); }
    }
    if (group.length === 1) out.push(pieces[i]);
    else out.push(...unionEdges(group.map(j => pieces[j])));
  }
  return out;
}

// Drawing union boundaries without node-grid quantization. The room loop walker's
// rounded station/grid keys can split a T junction across neighbouring bins.
// Open segments do not need that topology; endpoints retain binary64 coordinates.
function unionEdges(polys) {
  const edges = polys.flatMap(p => p.map((a, i) => [a, p[(i + 1) % p.length]]));
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0], sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const inside = p => polys.some(poly => inPoly(...p, poly)), out = [];
  for (const [a, b] of edges) {
    const d = sub(b, a), L = Math.hypot(...d); if (L < 1e-9) continue;
    const cuts = [0, 1];
    for (const [c, e] of edges) {
      const v = sub(e, c), ca = sub(c, a), den = cross(d, v);
      if (Math.abs(den) < 1e-12 * L * Math.hypot(...v)) {
        if (Math.abs(cross(ca, d)) > 1e-7 * L) continue;
        for (const q of [c, e]) { const t = ((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1]) / (L * L); if (t > 0 && t < 1) cuts.push(t); }
      } else {
        const t = cross(ca, v) / den, u = cross(ca, d) / den;
        if (t > 0 && t < 1 && u >= -1e-9 && u <= 1 + 1e-9) cuts.push(t);
      }
    }
    cuts.sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const t0 = cuts[i], t1 = cuts[i + 1]; if ((t1 - t0) * L < 1e-7) continue;
      const mid = a.map((v, j) => v + d[j] * (t0 + t1) / 2), h = Math.min(.001, (t1 - t0) * L / 4), n = [-d[1] / L * h, d[0] / L * h];
      if (inside(mid.map((v, j) => v + n[j])) === inside(mid.map((v, j) => v - n[j]))) continue;
      const p = a.map((v, j) => v + d[j] * t0), q = a.map((v, j) => v + d[j] * t1);
      const near = (x, y) => Math.hypot(x[0] - y[0], x[1] - y[1]) < 1e-7;
      if (!out.some(([x, y]) => (near(p, x) && near(q, y)) || (near(p, y) && near(q, x)))) out.push([p, q]);
    }
  }
  return out;
}
