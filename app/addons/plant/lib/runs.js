/* SPDX-License-Identifier: Apache-2.0 */
/**
 * runs.js — pipe runs as BimCraft writes them, read through the add-on API (0.7 LC.5 step 2). DOM-free (tested in Node).
 *
 * A run is an IfcElementAssembly with the property set CadCraft_MepRun (mep-model.js): Kind, System, Material, Class, Size,
 * PointsMm (JSON text: [[x, y, z] mm]), Valves (JSON text: [{ s, kind }]), Slope. api.model.properties(id) returns those rows;
 * this turns them into the plain run the spec checks and the isometric take.
 *
 *   readRun(props) → { guid, id, tag, kind, system, mat, cls, size, od, points (slope applied), valves, slope } | null
 *   withSlope(points, slope) → the corners with the fall applied along the horizontal length (the same rule mep-model.js's runVertices has)
 *   parseJson(text, fallback)
 */
import { pipeSize } from '../../../mep/tables.js';

export function parseJson(v, fallback = null) {
  if (Array.isArray(v) || (v && typeof v === 'object')) return v;
  try { return JSON.parse(String(v).replace(/^"|"$/g, '').replace(/\\"/g, '"')); } catch { return fallback; }
}

export function withSlope(points, slope) {
  const out = [];
  let fall = 0;
  for (let i = 0; i < points.length; i++) {
    const q = points[i];
    if (i) { const p = points[i - 1]; fall += (slope || 0) * Math.hypot(q[0] - p[0], q[1] - p[1]); }
    out.push([q[0], q[1], (q[2] || 0) - fall]);
  }
  return out.filter((q, i) => !i || Math.hypot(q[0] - out[i - 1][0], q[1] - out[i - 1][1], q[2] - out[i - 1][2]) > 0.5);
}

export function readRun(p) {
  const set = p?.sets?.find((s) => s.name === 'CadCraft_MepRun');
  if (!set) return null;
  const g = (n) => set.rows.find((r) => r.name === n)?.value;
  const pts = parseJson(g('PointsMm'), null);
  if (!Array.isArray(pts) || pts.length < 2 || !pts.every((q) => Array.isArray(q) && q.length >= 2 && q.every((x, i) => i > 2 || Number.isFinite(Number(x))))) return null;
  const slope = Number(g('Slope')) || 0;
  const points = withSlope(pts.map((q) => [Number(q[0]), Number(q[1]), Number(q[2]) || 0]), slope);
  if (points.length < 2) return null;
  const kind = String(g('Kind') || 'pipe');
  const mat = String(g('Material') || ''), cls = String(g('Class') || ''), size = String(g('Size') || '');
  const ps = kind === 'pipe' ? pipeSize(mat, cls, size) : null;
  const valves = parseJson(g('Valves'), []);
  return {
    guid: String(p.guid || p.id), id: p.id, tag: String(p.name || p.tag || ''), kind, system: String(g('System') || ''), mat, cls, size,
    od: ps ? ps.od * 25.4 : 60, points, slope,
    valves: Array.isArray(valves) ? valves.filter((v) => v && Number.isFinite(Number(v.s)) && typeof v.kind === 'string').map((v) => ({ s: Number(v.s), kind: v.kind })) : [],
  };
}

/**
 * A run as add-on API 1.1's mep.runs() gives it ({ guid, id, kind, system, points, mat, cls, size, slope, valves, parts: [express ids] })
 * → the run the spec checks and the isometric take (slope applied). Null for ducts and for runs with too few points.
 */
export function fromMep(r) {
  if (!r || r.kind !== 'pipe' || !Array.isArray(r.points) || r.points.length < 2) return null;
  const slope = Number(r.slope) || 0;
  const points = withSlope(r.points.map((q) => [Number(q[0]), Number(q[1]), Number(q[2]) || 0]), slope);
  if (points.length < 2) return null;
  const ps = pipeSize(String(r.mat), String(r.cls), String(r.size));
  return {
    guid: String(r.guid), id: r.id, tag: '', kind: 'pipe', system: String(r.system || ''), mat: String(r.mat || ''), cls: String(r.cls || ''), size: String(r.size || ''),
    od: ps ? ps.od * 25.4 : 60, points, slope, parts: Array.isArray(r.parts) ? r.parts : [],
    valves: Array.isArray(r.valves) ? r.valves.filter((v) => v && Number.isFinite(Number(v.s)) && typeof v.kind === 'string').map((v) => ({ s: Number(v.s), kind: v.kind })) : [],
  };
}
