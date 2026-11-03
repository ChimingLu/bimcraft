/* SPDX-License-Identifier: Apache-2.0 */
/**
 * assets-bim-sensors.js — sensor values on the model (0.7 LC.12 items 3 and 4, session bim-ops). DOM-free:
 * node bin/test-bimcraft.mjs --ops --only sensors.
 *
 * Readings come from a CSV the person opens (item 3) or a live feed (item 4, assets-bim-live.js); both end in one
 * SensorStore. Readings are this session's only: never written into the IFC, never sent anywhere. What IS written into
 * the IFC is each asset's limits — the CadCraft_Sensor set (Low, High, Unit; IfcReal / IfcLabel), one undo step — so the
 * next person who opens the file sees the same flags.
 *
 *   parseSensorCsv(text) → { times: [ms], cols: [{ head, values: Float64Array }], rows, bad: { time, value }, sep }
 *       the first column is the time, every other column one sensor named by its header (an asset's tag, name or
 *       GlobalId). Separators , ; or tab (the most common in the header line); quoted fields; a decimal comma when the
 *       separator is not a comma. Times: ISO 8601 ('2026-10-23T14:05', '2026-10-23 14:05:00Z', '2026-10-23'), or Unix
 *       seconds / milliseconds. Untrusted: ≤ MAX_ROWS rows, ≤ MAX_COLS sensors; a time or value that does not read is
 *       counted and left out, never guessed.
 *   matchSensors(heads, assets) → { byHead: Map(head → asset), unmatched: [head] }   tag first, then name, then GlobalId
 *                                  (case-insensitive, trimmed); a head that fits two assets by tag or name stays unmatched
 *   new SensorStore({ max }) — .set(guid, times, values) (a CSV: replaces), .push(guid, time, value) (a feed: appends, keeps
 *       the newest `max`), .latest(guid) → { t, v } | null, .series(guid) → { times, values }, .guids(), .version (+1 per change)
 *   flagOf(v, { low, high }) → 'low' | 'high' | ''      outside the limits (either may be missing)
 *   colorOf(v, scale) → '#rrggbb'   scale = { low, high } → below blue, inside green, above red; else { min, max } → a
 *                                   light-to-dark blue ramp (CVD-safe, one hue)
 *   chartPath(times, values, w, h, { limits }) → { d, lines: [{ y, kind }], min, max, t0, t1, n }   an SVG polyline path,
 *                                   at most w points (min/max per pixel column, so a spike never disappears)
 *   readSensorSet(setValues) → { low, high, unit } (numbers or null, '' unit) · sensorOp(guid, { low, high, unit })
 */
import { ModelWriter } from './model-write.js';
import { ids, val } from './ifc-util.js';

export const SENSOR_SET = 'CadCraft_Sensor';
export const MAX_ROWS = 200000, MAX_COLS = 500, MAX_KEEP = 20000;
export const COLORS = Object.freeze({ low: '#2b6cb0', ok: '#2f855a', high: '#c53030', ramp: ['#deebf7', '#9ecae1', '#4292c6', '#2171b5', '#08306b'] });
const err = (key) => Object.assign(new Error(key), { key });

// ---------------------------------------------------------------- CSV
function splitLine(line, sep) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"' && cur === '') q = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
/** A time cell → ms since 1970 (UTC), or NaN. A time with no zone is read in the browser's own zone, as people write them. */
export function timeOf(s) {
  const v = String(s ?? '').trim();
  if (!v) return NaN;
  if (/^\d{9,13}(\.\d+)?$/.test(v)) { const x = Number(v); return x < 1e11 ? x * 1000 : x; }   // Unix seconds or milliseconds
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(v);
  if (!m) return NaN;
  const [, Y, Mo, D, h = '0', mi = '0', se = '0', frac = '0', z] = m;
  const ms = Number(('0.' + frac).slice(0, 5)) * 1000;
  const parts = [+Y, +Mo - 1, +D, +h, +mi, +se, ms];
  const d = new Date(Date.UTC(...parts));
  if (d.getUTCFullYear() !== +Y || d.getUTCMonth() !== +Mo - 1 || d.getUTCDate() !== +D || +h > 23 || +mi > 59 || +se > 59) return NaN;
  if (!z) return new Date(...parts).getTime();
  if (z === 'Z') return d.getTime();
  const zm = /^([+-])(\d{2}):?(\d{2})$/.exec(z);
  return d.getTime() - (zm[1] === '-' ? -1 : 1) * (+zm[2] * 60 + +zm[3]) * 60000;
}
export function numOf(s, decimalComma = false) {
  let v = String(s ?? '').trim();
  if (!v) return NaN;
  if (decimalComma) v = v.replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(v) ? Number(v) : NaN;
}

export function parseSensorCsv(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw err('assets.sensor.err.empty');
  if (lines.length - 1 > MAX_ROWS) throw err('assets.sensor.err.too-big');
  const counts = [',', ';', '\t'].map((s) => [s, splitLine(lines[0], s).length]);
  const sep = counts.sort((a, b) => b[1] - a[1])[0][0];
  const head = splitLine(lines[0], sep);
  if (head.length < 2) throw err('assets.sensor.err.columns');
  if (head.length - 1 > MAX_COLS) throw err('assets.sensor.err.too-big');
  const dc = sep !== ',';
  const n = lines.length - 1, times = [], cols = head.slice(1).map((h) => ({ head: h.slice(0, 120), values: new Float64Array(n).fill(NaN) }));
  const bad = { time: 0, value: 0 };
  let r = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], sep);
    const t = timeOf(cells[0]);
    if (!Number.isFinite(t)) { bad.time++; continue; }
    times.push(t);
    for (let c = 0; c < cols.length; c++) {
      const s = cells[c + 1];
      if (s === undefined || s === '') continue;
      const v = numOf(s, dc);
      if (Number.isFinite(v)) cols[c].values[r] = v; else bad.value++;
    }
    r++;
  }
  for (const c of cols) c.values = c.values.slice(0, r);
  return { times, cols, rows: r, bad, sep };
}

export function matchSensors(heads, assets) {
  const index = (key) => { const m = new Map(); for (const a of assets) { const k = String(key(a) || '').trim().toLowerCase(); if (!k) continue; m.set(k, m.has(k) ? null : a); } return m; };
  const byTag = index((a) => a.tag), byName = index((a) => a.name), byGuid = new Map(assets.map((a) => [a.guid.toLowerCase(), a]));
  const byHead = new Map(), unmatched = [];
  for (const h of heads) {
    const k = String(h).trim().toLowerCase();
    const a = byTag.get(k) || byName.get(k) || byGuid.get(k) || null;
    if (a) byHead.set(h, a); else unmatched.push(h);
  }
  return { byHead, unmatched };
}

// ---------------------------------------------------------------- the store
export class SensorStore {
  constructor({ max = MAX_KEEP } = {}) { this.max = max; this.map = new Map(); this.version = 0; }
  /** A whole series (from a CSV): sorted by time, blanks left out, the newest `max` kept. */
  set(guid, times, values) {
    const pts = [];
    for (let i = 0; i < times.length; i++) if (Number.isFinite(values[i]) && Number.isFinite(times[i])) pts.push([times[i], values[i]]);
    pts.sort((a, b) => a[0] - b[0]);
    const keep = pts.slice(-this.max);
    this.map.set(guid, { times: keep.map((p) => p[0]), values: keep.map((p) => p[1]) });
    this.version++;
  }
  push(guid, t, v) {
    if (!Number.isFinite(t) || !Number.isFinite(v)) return false;
    const s = this.map.get(guid) || { times: [], values: [] };
    if (!this.map.has(guid)) this.map.set(guid, s);
    let i = s.times.length;
    while (i > 0 && s.times[i - 1] > t) i--;   // late readings slot in by time
    s.times.splice(i, 0, t); s.values.splice(i, 0, v);
    if (s.times.length > this.max) { s.times.splice(0, s.times.length - this.max); s.values.splice(0, s.values.length - this.max); }
    this.version++;
    return true;
  }
  latest(guid) { const s = this.map.get(guid); return s && s.times.length ? { t: s.times[s.times.length - 1], v: s.values[s.values.length - 1] } : null; }
  series(guid) { return this.map.get(guid) || null; }
  guids() { return [...this.map.keys()]; }
  clear() { this.map.clear(); this.version++; }
}

// ---------------------------------------------------------------- flags, colours, charts
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
export function flagOf(v, { low = null, high = null } = {}) {
  if (!fin(v)) return '';
  if (fin(high) && v > high) return 'high';
  if (fin(low) && v < low) return 'low';
  return '';
}
export function colorOf(v, scale = {}) {
  if (!fin(v)) return null;
  if (fin(scale.low) || fin(scale.high)) { const f = flagOf(v, scale); return f === 'high' ? COLORS.high : f === 'low' ? COLORS.low : COLORS.ok; }
  const { min, max } = scale;
  if (!fin(min) || !fin(max)) return COLORS.ramp[2];
  const k = max > min ? Math.max(0, Math.min(1, (v - min) / (max - min))) : 0.5;
  return COLORS.ramp[Math.min(COLORS.ramp.length - 1, Math.floor(k * COLORS.ramp.length))];
}
export function chartPath(times, values, w, h, { limits = {} } = {}) {
  const n = times.length;
  if (!n) return null;
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  for (const x of [limits.low, limits.high]) if (fin(x)) { min = Math.min(min, x); max = Math.max(max, x); }
  if (max === min) { max += 1; min -= 1; }
  const t0 = times[0], t1 = times[n - 1], span = t1 - t0 || 1;
  const X = (t) => (n === 1 ? w / 2 : ((t - t0) / span) * w), Y = (v) => h - ((v - min) / (max - min)) * h;
  // one min and one max per pixel column, in time order inside the column
  const cols = new Map();
  for (let i = 0; i < n; i++) {
    const c = Math.min(w - 1, Math.floor(X(times[i])));
    const b = cols.get(c);
    if (!b) cols.set(c, { lo: i, hi: i, first: i });
    else { if (values[i] < values[b.lo]) b.lo = i; if (values[i] > values[b.hi]) b.hi = i; }
  }
  const pts = [];
  for (const c of [...cols.keys()].sort((a, b) => a - b)) { const b = cols.get(c); const pair = b.lo === b.hi ? [b.lo] : b.lo < b.hi ? [b.lo, b.hi] : [b.hi, b.lo]; for (const i of pair) pts.push([X(times[i]), Y(values[i])]); }
  const r = (x) => Math.round(x * 10) / 10;
  const d = pts.map(([x, y], i) => (i ? 'L' : 'M') + r(x) + ' ' + r(y)).join(' ');
  const lines = [];
  if (fin(limits.low)) lines.push({ y: r(Y(limits.low)), kind: 'low' });
  if (fin(limits.high)) lines.push({ y: r(Y(limits.high)), kind: 'high' });
  return { d, lines, min, max, t0, t1, n, points: pts.length };
}

// ---------------------------------------------------------------- limits kept in the IFC
export function readSensorSet(values) {
  const num = (x) => (x === null || x === undefined || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null);
  return { low: num(values?.Low), high: num(values?.High), unit: String(values?.Unit ?? '').slice(0, 40) };
}
function elementOf(w, guid) {
  for (const id of ids(w.api, w.mid, 'IFCROOT', true)) { const l = w.api.GetLine(w.mid, id, false); if (l && val(l.GlobalId) === guid) return id; }
  throw err('assets.err.gone');
}
/** Set (or with every value empty, remove) an asset's limits: one undo step. */
export function sensorOp(guid, { low = null, high = null, unit = '' } = {}) {
  const lo = low === '' || low === null || low === undefined ? null : Number(low), hi = high === '' || high === null || high === undefined ? null : Number(high);
  if ((lo !== null && !Number.isFinite(lo)) || (hi !== null && !Number.isFinite(hi))) throw err('assets.sensor.err.limit');
  if (lo !== null && hi !== null && hi < lo) throw err('assets.sensor.err.order');
  const u = String(unit ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return (ed) => {
    const w = new ModelWriter(ed.W, ed.api, ed.mid);
    return w.run(() => {
      const id = elementOf(w, guid);
      const rows = [['Low', 'IFCREAL', lo], ['High', 'IFCREAL', hi], ['Unit', 'IFCLABEL', u || null]];
      // the set is ours alone (written here, one per element): replace it whole — the set, its relation, its properties
      const d = w.defNamed(id, SENSOR_SET);
      if (d) { const props = (d.line.HasProperties || []).map((h) => h.value); w.dropProduct([d.def]); for (const p of props) w.dropTree(p); w._defs = null; }
      const keep = rows.filter((r) => r[2] !== null);
      if (keep.length) w.relateDef(id, w.pset(SENSOR_SET, keep));
      return { id };
    });
  };
}
