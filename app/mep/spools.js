/* SPDX-License-Identifier: Apache-2.0 */
/**
 * mep/spools.js — steel pipe spools (0.7 LC.9 item 5, session `mep-07`). No DOM: bin/test-bimcraft.mjs --mep07 runs it.
 *
 * Only steel butt-weld pipe is cut into spools (ASME B36.10M pipe; elbows at the ASME B16.9 long radius as DF.29 draws them).
 * Tees and reducers keep DF.29's generic lengths (not B16.9's centre-to-end or end-to-end figures: the sheet says so). Copper,
 * PVC and PEX are refused (`mep.sp.err.steel`): their joints are not butt welds.
 *
 * A run is spooled when its CadCraft_MepRun has SpoolMaxMm > 0. Its rules: SpoolMaxMm (the longest spool, centre-line length),
 * FieldWelds (JSON: mm along the run's drawn line from its first point, placed by the person) and Line (its line number, part of
 * every spool id). regenMep (mep-model.js) asks planSpools for where the straight pipe is cut (a field weld inside a straight
 * length, or a straight length longer than a spool), lays the run out again with those cuts, then assignSpools gives each part
 * its spool: CadCraft_Spool { SpoolId (e.g. CHW-3-S02, unique in the model), Run (GlobalId), Index, StartMm, EndMm }.
 *
 *   spooled(r) · SPOOL_DEFAULT_MAX · spoolPrefix(r)
 *   partSpans(r, parts) → [{ s0, s1, len }]   where each part of a layout lies along the run (mm along its drawn line) and its own
 *                                             centre-line length
 *   planSpools(r, parts) → { cuts: [s], breaks: [{ s, kind: 'field' | 'auto' }] }
 *   assignSpools(r, parts, breaks) → [{ index, id, parts: [i], s0, s1, length }]
 *   readSpools(w) → [{ id, run, index, s0, s1, parts: [ids] }]
 *   spoolSheet(w, id) → { id, run, system, size, sch, parts, cuts, fittings, welds, bom, lines (3D centre lines, plan mm) }
 *   sheetsFor(w, { runs: [guids] | null }) → spool sheets of every spooled run (or those runs), laid out as regenMep writes them
 *   ductCutList(runs, layouts, pieceMm) → rows · ductCutListOf(w, pieceMm) · csvOf(rows)
 */
import { steelWeightKgM, pipeSize } from './tables.js';
import { readRuns, planLayout, sectionOf, runVertices } from '../mep-model.js';

export const SPOOL_PSET = 'CadCraft_Spool';
export const SPOOL_DEFAULT_MAX = 6000;
export const DUCT_PIECE_DEFAULT = 1500;
export const SYS_CODE = { cw: 'CW', hw: 'HW', hwr: 'HWR', san: 'SAN', vent: 'V', storm: 'ST', chw: 'CHW', hhw: 'HHW', gas: 'G', fire: 'FP' };
export const spooled = (r) => r.kind === 'pipe' && r.mat === 'steel' && Number(r.spoolMax) > 0;
export const spoolPrefix = (r) => (SYS_CODE[r.system] || 'P') + '-' + (String(r.line || '').trim() || '0');

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const dist = (a, b) => len(sub(a, b));

/** Where a point lies along a polyline (verts), mm from its first point: the nearest leg, projected. */
function sOf(verts, p) {
  let best = null, s0 = 0;
  for (let i = 0; i + 1 < verts.length; i++) {
    const a = verts[i], b = verts[i + 1], L = dist(a, b), d = sub(b, a).map((x) => x / (L || 1));
    const t = Math.max(0, Math.min(L, dot(sub(p, a), d)));
    const q = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t], off = dist(p, q);
    if (!best || off < best.off - 1e-6) best = { s: s0 + t, off };
    s0 += L;
  }
  return best ? best.s : 0;
}
/** A part's two ends along the run and its own centre-line length. parts in run order (mepLayout). */
export function partSpans(r, parts) {
  return parts.map((p) => {
    const [a, b] = p.kind === 'bend' ? [p.p0, p.p1] : p.kind === 'tee' ? [sub(p.at, p.d.map((x) => x * p.m)), [p.at[0] + p.d[0] * p.m, p.at[1] + p.d[1] * p.m, p.at[2] + p.d[2] * p.m]] : [p.a, p.b];
    let s0 = sOf(r.verts, a), s1 = sOf(r.verts, b);
    if (s1 < s0) [s0, s1] = [s1, s0];
    const own = p.kind === 'bend' ? p.R * p.th : p.kind === 'tee' ? 2 * p.m : dist(p.a, p.b);
    return { s0, s1, len: own, kind: p.kind };
  });
}

/**
 * Where a spooled run is cut (inside straight pipe) and where its spools break (joints included), from a layout made without
 * cuts. A field weld inside a straight length cuts it there (it must be 1 mm clear of either end); one in a fitting or a valve
 * moves to the nearer joint. A spool grows part by part; the part that would make it longer than SpoolMaxMm starts the next
 * one (a joint break), and a straight length longer than that is cut where the spool reaches it ('auto').
 */
export function planSpools(r, parts) {
  const max = Number(r.spoolMax) || 0;
  const spans = partSpans(r, parts);
  const cuts = [], breaks = [];
  const fw = [...new Set((r.fieldWelds || []).map((s) => Math.round(Number(s) * 1000) / 1000))].filter(Number.isFinite).sort((a, b) => a - b);
  // the person's welds first: inside a straight length → a cut, else the nearest joint
  const fieldAt = [];
  for (const s of fw) {
    const i = spans.findIndex((x) => s >= x.s0 - 1e-6 && s <= x.s1 + 1e-6);
    if (i < 0) continue;
    const x = spans[i];
    if (x.kind === 'segment' && s - x.s0 >= 1 && x.s1 - s >= 1) { cuts.push(s); fieldAt.push({ s, kind: 'field', inside: i }); }
    else { const j = s - x.s0 <= x.s1 - s ? x.s0 : x.s1; if (j > spans[0].s0 + 1e-6 && j < spans[spans.length - 1].s1 - 1e-6) fieldAt.push({ s: j, kind: 'field' }); }
  }
  for (const f of fieldAt) if (!breaks.some((b) => Math.abs(b.s - f.s) < 0.5)) breaks.push({ s: f.s, kind: 'field' });
  if (!(max > 0)) return { cuts, breaks: breaks.sort((a, b) => a.s - b.s) };
  // then the longest spool: walk the parts (a straight length split by a field weld counts as two)
  const pieces = [];
  for (let i = 0; i < spans.length; i++) {
    const x = spans[i], inner = cuts.filter((s) => s > x.s0 + 1e-6 && s < x.s1 - 1e-6).sort((a, b) => a - b);
    let a = x.s0;
    for (const s of [...inner, x.s1]) { pieces.push({ s0: a, s1: s, len: x.kind === 'segment' ? s - a : x.len, kind: x.kind }); a = s; }
  }
  let have = 0;
  for (const pc of pieces) {
    if (breaks.some((b) => Math.abs(b.s - pc.s0) < 0.5)) have = 0;   // a field weld starts a new spool here
    if (have + pc.len <= max + 1e-6) { have += pc.len; continue; }
    if (have > 0 && pc.len <= max + 1e-6) { breaks.push({ s: pc.s0, kind: 'auto' }); have = pc.len; continue; }
    if (pc.kind !== 'segment') { if (have > 0) breaks.push({ s: pc.s0, kind: 'auto' }); have = pc.len; continue; }   // a fitting longer than a spool: its own
    // a straight length that does not fit: cut where the spool is full, as often as it takes
    let s = pc.s0 + (max - have);
    while (pc.s1 - s > 1) {
      if (s - pc.s0 >= 1) { cuts.push(s); breaks.push({ s, kind: 'auto' }); }
      else if (have > 0) breaks.push({ s: pc.s0, kind: 'auto' });
      s += max;
    }
    have = pc.s1 - (s - max);
  }
  const uniq = (list) => list.sort((a, b) => (a.s ?? a) - (b.s ?? b)).filter((x, i, all) => !i || Math.abs((x.s ?? x) - (all[i - 1].s ?? all[i - 1])) > 0.5);
  return { cuts: uniq(cuts), breaks: uniq(breaks) };
}

/** The spools of a layout made with the cuts: parts between breaks. → [{ index, id, parts: [part index], s0, s1, length }] */
export function assignSpools(r, parts, breaks) {
  const spans = partSpans(r, parts), pre = spoolPrefix(r);
  const out = [];
  let cur = null;
  spans.forEach((x, i) => {
    const starts = !cur || breaks.some((b) => Math.abs(b.s - x.s0) < 0.5);
    if (starts) { cur = { index: out.length + 1, parts: [], s0: x.s0, s1: x.s1, length: 0 }; out.push(cur); }
    cur.parts.push(i); cur.s1 = Math.max(cur.s1, x.s1); cur.length += x.len;
  });
  for (const sp of out) sp.id = pre + '-S' + String(sp.index).padStart(2, '0');
  return out;
}

// ---- reading what was written ----
export function readSpools(w, runs) {
  const out = new Map();
  for (const r of runs) {
    if (!spooled(r)) continue;
    for (const id of r.parts) {
      const ps = w.readPset(id, SPOOL_PSET);
      if (!ps?.SpoolId) continue;
      const k = String(ps.SpoolId);
      if (!out.has(k)) out.set(k, { id: k, run: r.guid, index: Number(ps.Index) || 0, s0: Number(ps.StartMm) || 0, s1: Number(ps.EndMm) || 0, parts: [] });
      const sp = out.get(k);
      sp.parts.push(id); sp.s0 = Math.min(sp.s0, Number(ps.StartMm) || 0); sp.s1 = Math.max(sp.s1, Number(ps.EndMm) || 0);
    }
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

/**
 * One spool's sheet, from the run's layout (layout = mepLayout parts of the run, in order) and its spools. Welds: a shop weld at
 * every joint inside the spool, a field weld at each end that meets another spool of this run; an end on another run, a valve's
 * flange or nothing is listed as an end, not a weld. Everything mm.
 */
export function spoolSheet(r, sec, parts, spools, id) {
  const sp = spools.find((x) => x.id === id);
  if (!sp) return null;
  const p = pipeSize(r.mat, r.cls, r.size);
  const mine = sp.parts.map((i) => ({ i, part: parts[i] }));
  const cuts = [], fittings = new Map(), welds = [], lines = [];
  let n = 0;
  const endOf = (part, e) => (part.kind === 'bend' ? (e ? part.p1 : part.p0) : part.kind === 'tee' ? (e ? [part.at[0] + part.d[0] * part.m, part.at[1] + part.d[1] * part.m, part.at[2] + part.d[2] * part.m] : sub(part.at, part.d.map((x) => x * part.m))) : (e ? part.b : part.a));
  for (const { part } of mine) {
    if (part.kind === 'segment') { cuts.push({ n: ++n, length: dist(part.a, part.b), a: part.a, b: part.b }); lines.push({ kind: 'pipe', pts: [part.a, part.b], n }); continue; }
    const key = part.kind === 'bend' ? 'bend:' + Math.round(part.th * 180 / Math.PI) : part.kind === 'tee' ? 'tee:' + part.branchSec?.label : part.kind === 'reducer' ? 'reducer:' + part.from.label + '×' + part.to.label : 'valve:' + part.valve.kind;   // i18n-ignore: keys
    const f = fittings.get(key) || { kind: part.kind, angle: part.kind === 'bend' ? Math.round(part.th * 180 / Math.PI) : null, size: part.kind === 'tee' ? sec.label + ' × ' + part.branchSec.label : part.kind === 'reducer' ? part.from.label + ' × ' + part.to.label : sec.label, valve: part.valve?.kind || null, qty: 0, generic: part.kind !== 'bend' };
    f.qty++; fittings.set(key, f);
    if (part.kind === 'bend') { const pts = []; for (let k = 0; k <= 8; k++) { const a = part.th * k / 8, c = Math.cos(a), s = Math.sin(a); pts.push([0, 1, 2].map((j) => part.center[j] + (-part.n[j] * c + part.d1[j] * s) * part.R)); } lines.push({ kind: 'bend', pts }); }
    else if (part.kind === 'tee') { const a = endOf(part, 0), b = endOf(part, 1); lines.push({ kind: 'tee', pts: [a, b] }, { kind: 'branch', pts: [part.at, [part.at[0] + part.bd[0] * part.mb, part.at[1] + part.bd[1] * part.mb, part.at[2] + part.bd[2] * part.mb]] }); }
    else lines.push({ kind: part.kind, pts: [part.a, part.b] });
  }
  // welds: the joints between this spool's parts (shop), its ends against the run's other spools (field)
  let wn = 0;
  for (let k = 0; k + 1 < mine.length; k++) welds.push({ n: 'W' + ++wn, kind: 'shop', at: endOf(mine[k].part, 1), size: sec.label });
  const all = spools.filter((x) => x.run === sp.run || x.run === undefined);
  const first = mine[0].i, last = mine[mine.length - 1].i;
  const fieldEnds = [];
  if (first > 0 && all.some((x) => x !== sp && x.parts.includes(first - 1))) fieldEnds.push(endOf(parts[first], 0));
  if (last < parts.length - 1 && all.some((x) => x !== sp && x.parts.includes(last + 1))) fieldEnds.push(endOf(parts[last], 1));
  for (const at of fieldEnds) welds.push({ n: 'FW' + (welds.filter((x) => x.kind === 'field').length + 1), kind: 'field', at, size: sec.label });
  // the bill of materials: pipe by size and schedule (cut lengths summed, steel weight), fittings by kind and size
  const pipeLen = cuts.reduce((s, c) => s + c.length, 0);
  const kgm = p ? steelWeightKgM(p.od * 25.4, p.wall * 25.4) : null;
  const bom = [{ item: 'pipe', size: sec.label, sch: r.cls, qty: pipeLen, unit: 'mm', kg: kgm ? kgm * pipeLen / 1000 : null }];
  for (const f of fittings.values()) bom.push({ item: f.kind, size: f.size, angle: f.angle, valve: f.valve, qty: f.qty, unit: 'ea', kg: null, generic: f.generic });
  return { id, run: r.guid, system: r.system, size: r.size, sizeLabel: sec.label, sch: r.cls, od: sec.od, wall: sec.wall, index: sp.index, length: sp.length, s0: sp.s0, s1: sp.s1, cuts, fittings: [...fittings.values()], welds, bom, lines };
}

const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const csvOf = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

/** Straight duct pieces by length only: each straight duct length cut into stock pieces of pieceMm and what is left. */
export function ductCutList(runs, layouts, pieceMm = DUCT_PIECE_DEFAULT) {
  const rows = new Map();
  for (const r of runs) {
    if (r.kind !== 'duct') continue;
    const parts = layouts.get(r.guid) || [];
    for (const p of parts) {
      if (p.kind !== 'segment') continue;
      const L = dist(p.a, p.b);
      const full = Math.floor((L + 0.5) / pieceMm), rest = L - full * pieceMm;
      const add = (length, qty) => { const key = [r.system, r.shape, Math.round(r.w), Math.round(r.h), Math.round(length)].join('|'); const x = rows.get(key) || { system: r.system, shape: r.shape, w: r.w, h: r.h, length: Math.round(length), qty: 0 }; x.qty += qty; rows.set(key, x); };
      if (full) add(pieceMm, full);
      if (rest > 0.5) add(rest, 1);
    }
  }
  return [...rows.values()].sort((a, b) => a.system.localeCompare(b.system) || (b.w * b.h - a.w * a.h) || (b.length - a.length));
}

/** Every spooled run's sheets (or only these runs'), from the layout regenMep writes. → [sheet] in spool id order */
export function sheetsFor(w, { runs: only = null } = {}) {
  const all = readRuns(w), out = [];
  const byStorey = new Map();
  for (const r of all) { if (!byStorey.has(r.storey)) byStorey.set(r.storey, []); byStorey.get(r.storey).push(r); }
  for (const list of byStorey.values()) {
    if (!list.some((r) => spooled(r) && (!only || only.includes(r.guid)))) continue;
    const L = planLayout(list);
    for (const r of list) {
      if (!spooled(r) || (only && !only.includes(r.guid))) continue;
      const parts = L.runs.get(r.guid)?.parts || [];
      const sps = assignSpools({ ...r, verts: runVertices(r) }, parts, r.breaks || []);
      for (const sp of sps) out.push(spoolSheet(r, sectionOf(r), parts, sps, sp.id));
    }
  }
  return out.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}
/** The duct cut list of the whole model. */
export function ductCutListOf(w, pieceMm = DUCT_PIECE_DEFAULT) {
  const all = readRuns(w), layouts = new Map();
  const byStorey = new Map();
  for (const r of all) { if (r.kind !== 'duct') continue; if (!byStorey.has(r.storey)) byStorey.set(r.storey, []); }
  for (const st of byStorey.keys()) { const list = all.filter((r) => r.storey === st); const L = planLayout(list); for (const r of list) layouts.set(r.guid, L.runs.get(r.guid)?.parts || []); }
  return ductCutList(all, layouts, pieceMm);
}
