/* SPDX-License-Identifier: Apache-2.0 */
/**
 * res-takeoff.js — the model's quantities to TakeoffCraft in one file (0.5 part 4, RC.8). No DOM: bin/test-bimcraft.mjs --res
 * builds one and reads it back with TakeoffCraft's own modules.
 *
 * TakeoffCraft measures marks on scaled PDF sheets (it has no "typed quantity" item), so the hand-off is what it already
 * opens: a PDF of the plan of each level at a standard scale with the takeoff ATTACHED inside it (TakeoffCraft's T10 format,
 * takeoffcraft/dev/embed.js: "takeoff.takeoffcraft.json" = { format 'takeoffcraft-embedded', version 1, standsFor, takeoff }).
 * The takeoff's marks lie on the drawing — walls as runs along their centrelines (the item's height gives the wall area),
 * roofs as areas with their pitch (TakeoffCraft gives the sloped area), ridges / hips / valleys / eaves as runs (hips and
 * valleys sloped), foundations as runs and areas, openings, cabinets fronts and electrical devices as runs and counts — so
 * TakeoffCraft works out every quantity itself, and an estimator can check each one on the sheet. The lumber cut list (no
 * plan position) is counted on a sheet of its own. Items take the trade packs' assemblies where one fits
 * (res-takeoff-packs.js, generated from TakeoffCraft's packs), without rates.
 *
 *   buildTakeoff(input) → Promise<{ pdf, takeoff, standsFor, sheets }>
 *     input = { name, units 'ftin' | 'mm', paper, project, date,
 *               levels: [{ title, scene, runs: [{ item, pts }], areas: [{ item, pts, holes }], counts: [{ item, at }] }]  (plan mm),
 *               items: { key: { name, type linear | area | count, pack?, heightFt?, pitch? (degrees), slope? rake | hip } },
 *               cutList: [{ item, n, label }] }
 *   ftPerUnit(ratio) — feet per PDF point on a sheet drawn at 1:ratio
 */
import { planSheet, blankSheet, setPdf, PAPERS } from './res-sheets.js';
import { PACK_ITEMS } from './res-takeoff-packs.js';
import { t as tr } from './i18n.js';
import { isMetric } from './model-units.js';

export const EMBED_NAME = 'takeoff.takeoffcraft.json';
const PT = 72 / 25.4;
const COLORS = ['#D9480F', '#1971C2', '#2F9E44', '#9C36B5', '#E8590C', '#0C8599', '#C2255C', '#5C940D', '#3B5BDB', '#F08C00', '#862E9C', '#087F5B'];
export const ftPerUnit = (ratio) => ratio / 864;   // one point = 25.4 / 72 mm of paper = ratio × that in the building; 304.8 mm a foot
const r2 = (v) => Math.round(v * 100) / 100;

async function sha256Hex(bytes) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function unitFor(type, units) { return type === 'count' ? 'EA' : type === 'area' ? (isMetric(units) ? 'm²' : 'SF') : (isMetric(units) ? 'm' : 'LF'); }

export async function buildTakeoff(input) {
  const units = isMetric(input.units) ? 'mm' : 'ftin', paper = PAPERS[input.paper] ? input.paper : (isMetric(units) ? 'a3' : 'tabloid');
  const opts = { paper, units, project: input.project || '', date: input.date || '' };
  // items: the keys used, in the order first met
  const used = [];
  const use = (k) => { if (input.items[k] && !used.includes(k)) used.push(k); };
  for (const lv of input.levels || []) for (const m of [...(lv.runs || []), ...(lv.areas || []), ...(lv.counts || [])]) use(m.item);
  for (const c of input.cutList || []) use(c.item);
  let seq = 0;
  const id = (p) => p + (++seq);
  const itemId = new Map();
  const items = used.map((k, i) => {
    const d = input.items[k];
    const pk = d.pack && PACK_ITEMS[d.pack] ? PACK_ITEMS[d.pack][units] : null;
    const base = pk && pk.type === d.type ? pk : null;
    const it = {
      id: id('i'), name: String(d.name || base?.name || k).slice(0, 200), type: d.type, color: COLORS[i % COLORS.length],
      unit: base?.unit || unitFor(d.type, units), heightFt: Number.isFinite(d.heightFt) ? d.heightFt : (base?.heightFt || 0),
      waste: base?.waste || 0, mat: 0, lab: 0,
      components: (base?.components || []).map((c) => ({ id: id('c'), name: c.name, unit: c.unit, formula: c.formula, waste: c.waste || 0, mat: 0, lab: 0 })),
      ...(base?.csi ? { csi: base.csi } : {}),
      ...(d.type !== 'count' && d.pitch > 0 ? { pitch: Math.round(12 * Math.tan(d.pitch * Math.PI / 180) * 10000) / 10000 } : {}),   // TakeoffCraft: rise per 12
      ...(d.type === 'linear' && (d.slope === 'rake' || d.slope === 'hip') ? { slope: d.slope } : {}),
    };
    itemId.set(k, it.id);
    return it;
  });
  // the sheets: one plan a level (marks laid on it), then the cut list
  const sheets = [], pageMarks = [], scales = [];
  (input.levels || []).forEach((lv, i) => {
    const extra = [...(lv.runs || []).flatMap((m) => m.pts), ...(lv.areas || []).flatMap((m) => m.pts), ...(lv.counts || []).map((m) => m.at)];
    const sh = planSheet('Q-' + (i + 1), lv.title, lv.scene, { ...opts, extra });
    if (!sh) return;
    const P = (q) => { const s = sh.place.P(q); return [r2(s[0] * PT), r2(s[1] * PT)]; };
    const marks = [];
    for (const m of lv.runs || []) if (itemId.has(m.item) && m.pts.length >= 2) marks.push({ item: itemId.get(m.item), kind: 'linear', pts: m.pts.map(P) });
    for (const m of lv.areas || []) if (itemId.has(m.item) && m.pts.length >= 3) marks.push({ item: itemId.get(m.item), kind: 'area', pts: m.pts.map(P), holes: (m.holes || []).filter((h) => h.length >= 3).map((h) => h.map(P)) });
    for (const m of lv.counts || []) if (itemId.has(m.item)) marks.push({ item: itemId.get(m.item), kind: 'count', pts: [P(m.at)] });
    sheets.push(sh); pageMarks.push(marks); scales.push(sh.place);
  });
  const cut = (input.cutList || []).filter((c) => itemId.has(c.item) && c.n > 0);
  if (cut.length) {
    const [PW, PH] = PAPERS[paper];
    const perLine = 30, gap = 5, x0 = 130;
    let page = null, y = 0;
    const next = () => { page = blankSheet('Q-' + (sheets.length + 1), tr('res.to.cutsheet'), opts); page.items.push({ t: 'text', s: tr('res.to.cutnote'), x: 20, y: PH - 22, size: 9, align: 'left', g: 0.25 }); sheets.push(page); pageMarks.push([]); scales.push(null); y = PH - 34; };
    next();
    for (const c of cut) {
      const lines = Math.ceil(c.n / perLine), h = lines * gap + 3;
      if (y - h < 34) next();
      page.items.push({ t: 'text', s: c.label, x: 20, y: y - 3.5, size: 9, align: 'left' });
      page.items.push({ t: 'line', pts: [[20, y - h + 1], [PW - 20, y - h + 1]], w: 0.1, g: 0.7 });
      const marks = pageMarks[pageMarks.length - 1];
      for (let k = 0; k < c.n; k++) { const cx = x0 + (k % perLine) * gap, cy = y - 3 - Math.floor(k / perLine) * gap; marks.push({ item: itemId.get(c.item), kind: 'count', pts: [[r2(cx * PT), r2(cy * PT)]] }); }
      y -= h + 2;
    }
  }
  if (!sheets.length) return { pdf: null, takeoff: null, standsFor: null, sheets };
  const title = String(input.name || 'Takeoff');
  const plain = setPdf(sheets, { paper, title });
  const standsFor = await sha256Hex(plain);
  const name = title + '.pdf';
  const sheetMap = {}, marks = [];
  sheets.forEach((s, i) => {
    const key = standsFor + ':' + i;
    if (scales[i]) sheetMap[key] = { scale: { method: 'preset', ftPerUnit: ftPerUnit(scales[i].ratio), preset: null, label: scales[i].label } };
    for (const m of pageMarks[i]) marks.push({ id: id('m'), sheet: key, ...m });
  });
  const takeoff = { format: 'takeoffcraft-project', version: 1, name: title, seq, files: [{ hash: standsFor, name, size: plain.length, pages: sheets.length }], sheets: sheetMap, items, marks, areas: [] };
  const payload = new TextEncoder().encode(JSON.stringify({ format: 'takeoffcraft-embedded', version: 1, standsFor, takeoff }));
  const pdf = setPdf(sheets, { paper, title, attach: { name: EMBED_NAME, bytes: payload, mime: 'application/json', desc: 'TakeoffCraft takeoff' } });   // i18n-ignore: file metadata
  return { pdf, takeoff, standsFor, sheets, name };
}

/**
 * The hand-off's input from the model, as plain data (res-ui.js gathers it; the test reads it from a saved model):
 *   { name, units, levels [{ id, name }], scenes Map(level id → plan scene), walls (model-walls readWalls, + typeName),
 *     openings (model-openings readOpenings, + typeName), roofs [{ storey, plan (res-roof roofGeometry) }],
 *     founds [{ storey, geo (res-foundation foundationGeometry), prm }], cabinets [{ storey, poly, fronts }],
 *     devs (res-elec readDevices), rooms [{ storey, poly, holes }], lumber (res-framing lumberList rows), fmtLen }
 */
const FT = 304.8, IN = 25.4;
const nearest = (v, list) => list.reduce((b, x) => (Math.abs(x - v) < Math.abs(b - v) ? x : b));
const EL_PACK = { 'socket': 'el.receptacle', 'socket.double': 'el.receptacle', 'socket.earth': 'el.receptacle', 'appliance': 'el.receptacle', 'switch': 'el.switch', 'switch.2way': 'el.switch3',
  'switch.dimmer': 'el.dimmer', 'junction': 'el.junction', 'downlight': 'el.downlight', 'luminaire': 'el.fixture', 'board': 'el.panel' };
export function modelQuantities(d, t = tr) {
  const items = {}, by = new Map();
  const level = (id) => { if (!by.has(id)) by.set(id, { runs: [], areas: [], counts: [] }); return by.get(id); };
  const def = (key, v) => { if (!items[key]) items[key] = v; return key; };
  const ring = (poly) => [...poly, poly[0]];
  // walls by type and height: runs along their centrelines
  for (const w of d.walls || []) {
    const hFt = Math.round(w.height / FT * 100) / 100;
    const ext = /^ext-2x6/.test(w.typeKey) ? 'wall.ext.2x6' : /^int-2x4/.test(w.typeKey) ? 'wall.int.2x4.' + nearest(hFt, [8, 9, 10, 12]) : null;
    const k = def('wall:' + w.typeKey + ':' + hFt, { name: t('res.to.walls', { type: w.typeName || w.typeKey, h: d.fmtLen(w.height) }), type: 'linear', heightFt: hFt, pack: ext });
    level(w.storey).runs.push({ item: k, pts: [w.a, w.b] });
  }
  // doors and windows: counts at their middles; interior doors take the prehung-door assembly, windows the trim too
  const wallOf = new Map((d.walls || []).map((w) => [w.id, w]));
  for (const o of d.openings || []) {
    const w = wallOf.get(o.wall);
    if (!w) continue;
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1, s = o.offset + o.width / 2;
    const at = [w.a[0] + (w.b[0] - w.a[0]) / L * s, w.a[1] + (w.b[1] - w.a[1]) / L * s];
    const interior = !w.exterior;
    const k = def(o.kind + ':' + o.typeKey + ':' + (o.kind === 'door' ? (interior ? 'i' : 'x') : ''), { name: (o.typeName || o.typeKey) + (o.kind === 'door' && interior ? ' ' + t('res.to.interior') : ''), type: 'count', pack: o.kind === 'door' && interior ? 'door.interior' : null });
    level(w.storey).counts.push({ item: k, at });
    if (o.kind === 'window') level(w.storey).counts.push({ item: def('window.trim', { name: t('res.to.windowtrim'), type: 'count', pack: 'window.trim' }), at });
  }
  // roofs: the faces by pitch (sloped area), ridges, hips, valleys, eaves and rakes
  for (const r of d.roofs || []) {
    const P = r.plan;
    if (!P || P.error) continue;
    const lv = level(r.storey);
    for (const f of P.faces) { const p = Math.round(f.pitch * 100) / 100; lv.areas.push({ item: def('roof:' + p, { name: t('res.to.roof', { pitch: p.toFixed(1) }), type: 'area', pitch: p, pack: 'roof.shingles' }), pts: f.poly }); }
    const pitch = Math.max(...P.faces.map((f) => f.pitch));
    for (const l of P.lines) {
      const kind = l.kind === 'ridge' ? 'ridge' : l.kind === 'hip' ? 'hip' : 'valley';
      const k = def('roofline:' + kind + (kind === 'ridge' ? '' : ':' + pitch.toFixed(2)), { name: t('res.to.roofline.' + kind), type: 'linear', pack: kind === 'valley' ? 'roof.valley' : 'roof.ridge', ...(kind === 'ridge' ? {} : { slope: 'hip', pitch }) });
      lv.runs.push({ item: k, pts: [[l.a[0], l.a[1]], [l.b[0], l.b[1]]] });
    }
    for (const fa of P.fascia) {
      const k = fa.kind === 'eave' ? def('roofline:eave', { name: t('res.to.roofline.eave'), type: 'linear', pack: 'roof.eave' }) : def('roofline:rake:' + pitch.toFixed(2), { name: t('res.to.roofline.rake'), type: 'linear', slope: 'rake', pitch });
      lv.runs.push({ item: k, pts: [[fa.a[0], fa.a[1]], [fa.b[0], fa.b[1]]] });
    }
  }
  // foundations: footings and stem walls as runs round their middles, slabs as areas
  for (const f of d.founds || []) {
    if (!f.geo) continue;
    const lv = level(f.storey);
    for (const p of f.geo) {
      if (p.role === 'slab') {
        const tIn = (p.z1 - p.z0) / IN;
        lv.areas.push({ item: def('slab:' + Math.round(tIn * 100) / 100, { name: t('res.to.slab', { t: d.fmtLen(p.z1 - p.z0) }), type: 'area', heightFt: (p.z1 - p.z0) / FT, pack: 'slab.' + nearest(tIn, [4, 5, 6]) }), pts: p.outer });
        continue;
      }
      if (!p.inner || p.inner.length !== p.outer.length) continue;
      const mid = p.outer.map((q, i) => [(q[0] + p.inner[i][0]) / 2, (q[1] + p.inner[i][1]) / 2]);
      const wIn = Math.abs(polyPerimeterGap(p.outer, p.inner)) / IN, hFt = (p.z1 - p.z0) / FT;
      let k;
      if (p.role === 'footing') k = def('footing:' + Math.round(wIn) + ':' + Math.round((p.z1 - p.z0) / IN), { name: t('res.to.footing', { w: d.fmtLen(wIn * IN), d: d.fmtLen(p.z1 - p.z0) }), type: 'linear', pack: 'footing.' + nearest(wIn, [16, 20, 24]) });
      else if (p.role === 'stem') k = def('stem:' + Math.round(wIn) + ':' + Math.round(hFt * 100), { name: t('res.to.stem', { w: d.fmtLen(wIn * IN), h: d.fmtLen(p.z1 - p.z0) }), type: 'linear', heightFt: Math.round(hFt * 100) / 100, pack: 'stem.' + nearest(wIn, [8, 10]) + '.' + nearest(hFt, [4, 8]) });
      else k = def('edge:' + Math.round(wIn), { name: t('res.to.edge', { w: d.fmtLen(wIn * IN) }), type: 'linear', heightFt: Math.round(hFt * 100) / 100 });
      lv.runs.push({ item: k, pts: ring(mid) });
    }
  }
  // base cabinets: their fronts
  for (const c of d.cabinets || []) for (const [i, j] of c.fronts) level(c.storey).runs.push({ item: def('cab.base', { name: t('res.to.cabinets'), type: 'linear', pack: 'cab.base' }), pts: [c.poly[i], c.poly[j]] });
  // electrical devices
  for (const v of d.devs || []) level(v.storey).counts.push({ item: def('el:' + v.kind, { name: t('res.el.kind.' + v.kind), type: 'count', pack: EL_PACK[v.kind] || null }), at: v.at });
  // floor area per level
  for (const r of d.rooms || []) { const lvName = (d.levels || []).find((l) => l.id === r.storey)?.name || ''; level(r.storey).areas.push({ item: def('floor:' + r.storey, { name: t('res.to.floor', { level: lvName }), type: 'area' }), pts: r.poly, holes: r.holes || [] }); }
  const levels = (d.levels || []).filter((l) => by.has(l.id) && d.scenes?.get(l.id)).map((l) => ({ title: t('res.sh.plan', { level: l.name }), scene: d.scenes.get(l.id), ...by.get(l.id) }));
  const cutList = (d.lumber || []).map((r) => ({ item: def('lumber:' + r.size + ':' + Math.round(r.stock), { name: t('res.to.lumber', { size: r.size, len: d.fmtLen(r.stock) }), type: 'count' }), n: r.count, label: t('res.to.lumberrow', { size: r.size, len: d.fmtLen(r.stock), n: r.count }) }));
  return { name: d.name, units: d.units, levels, items, cutList, project: d.name, date: d.date || '' };
}
/** The width of a ring: the distance between its outer and inner outlines (both parallel insets of one outline). */
function polyPerimeterGap(outer, inner) {
  const a = outer[0], b = outer[1], q = inner[0];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])) / L;
}
