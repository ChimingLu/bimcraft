/* SPDX-License-Identifier: Apache-2.0 */
/**
 * mep/structure.js — MEP against the structure (0.7 LC.9 item 4, session `mep-07`). No DOM: bin/test-bimcraft.mjs --mep07 runs it.
 *
 *   SETS                    the clash sets the Clash check offers ready to run on clash.js (hard clashes): pipes and ducts
 *                           against walls, slabs, beams, columns (by IFC class, IFC4 and IFC2X3 names)
 *   setKeys(classOf, set)   the element keys of one set in a model's class map (keyBase applied by the caller)
 *   clearances({ mep, structure, gapMm, insulationOf, skip }) → [{ a, b, gap (m), need (m) }]   soft: an MEP element closer to
 *                           a structural one than its insulation + gapMm (and not touching it: those are hard clashes), from
 *                           the triangles (clash.js elementsOf shape, metres)
 *   openings({ runs, structure, toViewer, gapMm }) → [{ run, part, element, at, enter, exit, through, size, shape, w, h, … }]
 *                           where a run's centre line passes through a wall or a slab: the opening it needs = its outside size
 *                           + 2 × its insulation + 2 × the gap typed (default 25 mm). Nothing is cut: a list, CSV and BCF.
 *   openingsCsv(rows, head, cells) · openingTopics(rows, …) → BCF topics (bcf.js writeBcf)
 * The run's centre line comes from its layout (mep-model.js mepLayout: segments and bends, plan mm in its storey);
 * toViewer(storey, [x, y, z]) → the viewer's metres (what elementsOf returns) so both meet in one frame.
 * A drafting and coordination aid: sizes are the drawn ones; no code says how big an opening must be.
 */
import { readRuns, mepLayout, planLayout, sectionOf, runVertices } from '../mep-model.js';

export const MEP_CLASSES = ['IfcPipeSegment', 'IfcPipeFitting', 'IfcDuctSegment', 'IfcDuctFitting', 'IfcValve', 'IfcFlowSegment', 'IfcFlowFitting'];
export const SETS = {
  mep: MEP_CLASSES,
  walls: ['IfcWall', 'IfcWallStandardCase', 'IfcCurtainWall'],
  slabs: ['IfcSlab', 'IfcRoof'],
  beams: ['IfcBeam', 'IfcBeamStandardCase'],
  columns: ['IfcColumn', 'IfcColumnStandardCase'],
};
SETS.structure = [...SETS.walls, ...SETS.slabs, ...SETS.beams, ...SETS.columns];
/** Walls and slabs need openings; beams and columns are clashes (a pipe through a beam is the engineer's call). */
const OPENING_SETS = new Set([...SETS.walls, ...SETS.slabs]);
export const DEFAULT_GAP = 25;   // mm round a sleeve or duct in an opening, a typed default, not a code value

/** keys of a set in one model: classOf = Map(id → 'IfcWall'), keyBase added. */
export function setKeys(classOf, set, keyBase = 0) {
  const want = new Set(SETS[set] || []), out = [];
  for (const [id, c] of classOf) if (want.has(c)) out.push(keyBase + id);
  return out;
}

// ---- small geometry (metres) ----
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const boxesNear = (A, B, d) => A[0] - d <= B[3] && B[0] - d <= A[3] && A[1] - d <= B[4] && B[1] - d <= A[4] && A[2] - d <= B[5] && B[2] - d <= A[5];
function trisOf(el) { const out = []; for (const t of el.parts || [el.tris]) for (let i = 0; i + 8 < t.length; i += 9) out.push([[t[i], t[i + 1], t[i + 2]], [t[i + 3], t[i + 4], t[i + 5]], [t[i + 6], t[i + 7], t[i + 8]]]); return out; }
function vertsOf(el) { const seen = new Set(), out = []; for (const t of el.parts || [el.tris]) for (let i = 0; i + 2 < t.length; i += 3) { const k = Math.round(t[i] * 1e4) + ',' + Math.round(t[i + 1] * 1e4) + ',' + Math.round(t[i + 2] * 1e4); if (!seen.has(k)) { seen.add(k); out.push([t[i], t[i + 1], t[i + 2]]); } } return out; }
/** The closest point of triangle (a, b, c) to p (Ericson, Real-Time Collision Detection 5.1.5), its distance. */
function pointTri(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return len(ap);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return len(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return len(sub(p, add(a, mul(ab, d1 / (d1 - d3)))));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return len(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return len(sub(p, add(a, mul(ac, d2 / (d2 - d6)))));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return len(sub(p, add(b, mul(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))))));
  const den = 1 / (va + vb + vc);
  return len(sub(p, add(a, add(mul(ab, vb * den), mul(ac, vc * den)))));
}
/** Where segment p→q crosses triangle (a, b, c) (Möller–Trumbore): its parameter in [0, 1], or null. */
function segTri(p, q, a, b, c) {
  const d = sub(q, p), e1 = sub(b, a), e2 = sub(c, a), h = cross(d, e2), det = dot(e1, h);
  if (Math.abs(det) < 1e-14) return null;
  const f = 1 / det, s = sub(p, a), u = f * dot(s, h);
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const qv = cross(s, e1), v = f * dot(d, qv);
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const t = f * dot(e2, qv);
  return t >= -1e-9 && t <= 1 + 1e-9 ? Math.min(1, Math.max(0, t)) : null;
}

/** Soft clearances. mep / structure: elementsOf's [{ key, box, parts }] (metres); insulationOf(key) → mm; skip(a, b) → true for
 *  pairs not to report (a run that passes through the element: an opening, listed there). */
export function clearances({ mep, structure, gapMm = 0, insulationOf = () => 0, skip = () => false }) {
  const out = [];
  for (const a of mep) {
    const need = (insulationOf(a.key) + gapMm) / 1000;
    if (!(need > 0)) continue;
    let va = null, ta = null;
    for (const b of structure) {
      if (a.key === b.key || !boxesNear(a.box, b.box, need) || skip(a.key, b.key)) continue;
      va ??= vertsOf(a); ta ??= trisOf(a);
      const tb = trisOf(b), vb = vertsOf(b);
      let d = Infinity;
      for (const p of va) for (const t of tb) { const x = pointTri(p, t[0], t[1], t[2]); if (x < d) d = x; }
      for (const p of vb) for (const t of ta) { const x = pointTri(p, t[0], t[1], t[2]); if (x < d) d = x; }
      if (d > 1e-6 && d < need - 1e-6) out.push({ a: a.key, b: b.key, gap: d, need });
    }
  }
  return out.sort((x, y) => x.gap - y.gap);
}

/**
 * Openings: each run's centre line (plan mm in its storey, from its layout) taken to the viewer's frame and crossed with the walls'
 * and slabs' triangles. runs: readRuns rows (+ keyOf(part id) → viewer key); structure: elementsOf rows with `cls`.
 * → [{ run (guid), system, kind, size label, shape, w, h (mm, the opening), insulation, gap, element (key), cls, at (plan mm on
 * the run's storey), storey, through (mm along the run), part (key of the run's part there) }]
 */
export function openings({ runs, structure, toViewer, keyOf, gapMm = DEFAULT_GAP }) {
  const walls = structure.filter((s) => OPENING_SETS.has(s.cls));
  const rows = [];
  const byStorey = new Map();
  for (const r of runs) { if (!byStorey.has(r.storey)) byStorey.set(r.storey, []); byStorey.get(r.storey).push(r); }
  for (const [storey, list] of byStorey) {
    let L;
    try { L = planLayout(list.map((r) => ({ ...r }))); } catch (e) { continue; }   // as regenMep wrote it (spools' cuts included)
    for (const r of list) {
      const sec = sectionOf(r), lay = L.runs.get(r.guid);
      if (!sec || !lay) continue;
      // the centre line as pieces, each with the part it belongs to (plan mm)
      const pieces = [];
      lay.parts.forEach((p, i) => {
        const key = keyOf(r.parts[i]);
        if (p.kind === 'bend') { const n = 8; let prev = null; for (let k = 0; k <= n; k++) { const a = p.th * k / n, c = Math.cos(a), s = Math.sin(a), q = [0, 1, 2].map((j) => p.center[j] + (-p.n[j] * c + p.d1[j] * s) * p.R); if (prev) pieces.push({ a: prev, b: q, key }); prev = q; } }
        else if (p.kind === 'tee') pieces.push({ a: sub(p.at, mul(p.d, p.m)), b: add(p.at, mul(p.d, p.m)), key });
        else pieces.push({ a: p.a, b: p.b, key });
      });
      const ins = Number(r.insulation) || 0;
      const ow = (sec.round ? sec.w : sec.w) + 2 * ins + 2 * gapMm, oh = (sec.round ? sec.w : sec.h) + 2 * ins + 2 * gapMm;
      for (const el of walls) {
        // crossings along the whole line, in order: they pair up enter → leave (a closed body)
        const hits = [];
        let s0 = 0;
        for (const pc of pieces) {
          const A = toViewer(storey, pc.a), B = toViewer(storey, pc.b), Lmm = len(sub(pc.b, pc.a));
          const bb = [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.min(A[2], B[2]), Math.max(A[0], B[0]), Math.max(A[1], B[1]), Math.max(A[2], B[2])];
          if (boxesNear(bb, el.box, 1e-6)) for (const t of trisOf(el)) { const u = segTri(A, B, t[0], t[1], t[2]); if (u !== null) hits.push({ s: s0 + u * Lmm, at: lerp(pc.a, pc.b, u), key: pc.key }); }
          s0 += Lmm;
        }
        hits.sort((x, y) => x.s - y.s);
        // one crossing per face: hits on a shared triangle edge come twice
        const uniq = hits.filter((h, i) => !i || h.s - hits[i - 1].s > 0.5);
        for (let i = 0; i + 1 < uniq.length; i += 2) {
          const a = uniq[i], b = uniq[i + 1];
          rows.push({ run: r.guid, system: r.system, kind: r.kind, sizeLabel: sec.label, shape: sec.round ? 'round' : sec.shape, w: ow, h: oh, insulation: ins, gap: gapMm,
            element: el.key, cls: el.cls, at: lerp(a.at, b.at, 0.5), storey, through: b.s - a.s, part: a.key, s: a.s });
        }
      }
    }
  }
  return rows;
}

/** CSV with the cells the caller gives (head: [labels], cells(row) → [values]); a cell starting = + - @ is text. */
export function openingsCsv(rows, head, cells) {
  const q = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [head, ...rows.map(cells)].map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}
/** BCF topics, one per opening: a camera looking at it from 3 m off, the run's part and the element selected. */
export function openingTopics(rows, { title, description, author, now, guidOf, worldOf, newGuid }) {
  return rows.map((r, i) => {
    const p = worldOf(r);   // IFC world metres, Z up
    const eye = [p[0] - 2.2, p[1] - 2.2, p[2] + 1.6], dir = [2.2, 2.2, -1.6], dl = len(dir);
    return {
      guid: newGuid(), title: title(r, i), status: 'Open', type: 'Clash', author, created: now, description: description(r, i), comments: [],
      viewpoints: [{ guid: newGuid(), camera: { kind: 'perspective', viewPoint: eye, direction: dir.map((x) => x / dl), up: [0, 0, 1], fov: 60 }, selection: [guidOf(r.part), guidOf(r.element)].filter(Boolean), visibility: { defaultVisible: true, exceptions: [] }, clipping: [], snapshot: null }],
    };
  });
}
export { readRuns };
