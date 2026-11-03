/* SPDX-License-Identifier: Apache-2.0 */
/**
 * energy-bim.js — heating and cooling loads per room (0.7 LC.20 item 7, session bim-ops). A design aid, not a compliance
 * calculation: a steady-state heat loss, a degree-day year and a cooling peak, every input shown. NOT the ISO 52016-1 monthly
 * method (a paid standard; see the log). DOM-free: node bin/test-bimcraft.mjs --ops --only energy (hand-worked case E1).
 *
 * What bounds each room (no IfcRelSpaceBoundary needed; any program's model):
 *   gatherEnergy(g, { spacing, onProgress }) → { rooms: [{ id, guid, name, longName, storey, floorArea, volume, lowest,
 *       parts: [{ id, cls, name, exposure: 'outside' | 'ground' | 'adjacent', adj, area }], open }], ids: Set }
 *       g = daylight-bim.js gatherRooms(…, { keep: true }). Each triangle of the room's own shell is cut into small pieces
 *       (`spacing` 0.25 m); from each piece a ray goes outward, square to the surface: the first building element it meets
 *       (walls, windows, doors, slabs, roofs, coverings, curtain walls, plates, members, columns, beams) bounds that piece;
 *       just past that element's far face either another room (adjacent), or nothing: outside — or the ground, for a floor
 *       of a room on the lowest level (rays look 1.5 m out, 8 m up). A ray that meets no element but goes into another room is an open connection to it
 *       (cls 'OPENING', adjacent); rays that meet nothing are `open` (listed, not counted). Windows and
 *       doors then take their own size (OverallWidth × OverallHeight) from the wall they sit in, so they come out exact.
 * U-values (W/m²K), first found wins, the source shown:
 *   uValues(W, api, mid, ids, { lambdas }) → Map(id → { u, source: 'ifc' | 'layers' | 'default', set, shared, layers })
 *       'ifc': Pset_<Class>Common.ThermalTransmittance on the element or its type (any program's, or typed here);
 *       'layers': its material layers, R = Rsi + Σ d/λ + Rse (ISO 6946 surface resistances: sideways 0.13 / 0.04, upward
 *       0.10 / 0.04, downward 0.17 / 0.04) with λ per material typed (`lambdas`: name → W/mK) or from LAMBDA by keyword;
 *       'default': DEFAULT_U by kind (typical new-build figures, labelled so).
 *   uOp(guid, value) → op: write ThermalTransmittance (IfcThermalTransmittanceMeasure) into the element's Pset_<Class>Common
 *       — the set it already reads from, so elements sharing that set change together ('' removes it). One undo step.
 * The loads (EN 12831-style simple method, steady state):
 *   loads(e, uMap, inputs, { solar }) → rooms with { H: { out, ground, vent }, heat: { fabric, ground, vent, total },
 *       annual, cool: { fabric, vent, people, lights, equip, solar, total, at }, rows }
 *   heat = Σ U·A (θi − θe) over outside parts + Σ U·A (θi − θg) over ground parts + 0.335 · n · V (θi − θe)
 *       (0.335 Wh/m³K = air's density 1.2 kg/m³ × heat capacity 1005 J/kgK); adjacent rooms at the same temperature: 0
 *   annual (kWh) = (H_out + H_vent + H_ground (θi − θg)/(θi − θe)) × degree-days × 24 / 1000
 *   cooling peak = the room's peak solar gain on the cooling date (daylight-bim-sky.js solarDay) + people + lights +
 *       equipment (per m² of floor) + (H_out + H_vent)(θe,summer − θi,cool)
 *   degreeDaysCsv(text) → { total, rows }   the sum of a CSV's degree-day column (the last numeric column), for a year
 */
import { ModelWriter } from './model-write.js';
import { ids, val, lengthUnitMm } from './ifc-util.js';

export const RHO_C = 1.2 * 1005 / 3600;   // 0.335 Wh/m³K
/** How far a ray from a room's surface looks for what bounds it (m): sideways and down, and up (a roof over an attic). */
export const REACH = 1.5, REACH_UP = 8;
export const INPUTS = Object.freeze({ ti: 21, te: -3, tg: 10, ach: 0.5, dd: 2000, teSummer: 30, tiCool: 24, perPerson: 10, wPerson: 75, wLights: 8, wEquip: 10 });
export const DEFAULT_U = Object.freeze({ wall: 0.3, roof: 0.2, floor: 0.25, window: 1.4, door: 1.6, other: 0.5 });
/** Thermal conductivity by a keyword in the material's name (W/mK): typical published values; type the maker's to replace.
 *  The first keyword found wins, so the more specific come first ("plasterboard" before "plaster" before "gypsum"). */
export const LAMBDA = Object.freeze([
  ['mineral wool', 0.035], ['glass wool', 0.035], ['rock wool', 0.035], ['insulation', 0.035], ['eps', 0.035], ['xps', 0.033], ['pir', 0.022], ['pur', 0.022], ['polyurethane', 0.022],   // i18n-ignore: material keywords matched against names in the file
  ['aerated', 0.15], ['aac', 0.15], ['brick', 0.77], ['concrete', 1.4], ['screed', 1.15], ['block', 1.13], ['stone', 2.3], ['plasterboard', 0.25], ['plaster', 0.5], ['gypsum', 0.25],
  ['timber', 0.13], ['wood', 0.13], ['plywood', 0.13], ['osb', 0.13], ['clt', 0.13], ['steel', 50], ['aluminium', 160], ['aluminum', 160], ['glass', 1.0], ['gravel', 2.0], ['membrane', 0.2], ['bitumen', 0.2],
]);
const SURFACE = { side: [0.13, 0.04], up: [0.10, 0.04], down: [0.17, 0.04] };
const BOUND = /^IFC(WALL|WALLSTANDARDCASE|WALLELEMENTEDCASE|WINDOW|WINDOWSTANDARDCASE|DOOR|DOORSTANDARDCASE|SLAB|SLABSTANDARDCASE|SLABELEMENTEDCASE|ROOF|COVERING|CURTAINWALL|PLATE|PLATESTANDARDCASE|MEMBER|MEMBERSTANDARDCASE|COLUMN|COLUMNSTANDARDCASE|BEAM|BEAMSTANDARDCASE)$/;
export const kindOf = (cls, slabType = '') => (/WINDOW/.test(cls) ? 'window' : /DOOR/.test(cls) ? 'door' : /ROOF/.test(cls) || /ROOF/.test(slabType) ? 'roof' : /SLAB|COVERING/.test(cls) ? 'floor' : /WALL|PLATE|MEMBER|COLUMN|BEAM/.test(cls) ? 'wall' : 'other');
const PSET = (cls) => { const c = cls.replace(/^IFC/, '').replace(/(STANDARDCASE|ELEMENTEDCASE)$/, ''); const m = { WALL: 'Wall', WINDOW: 'Window', DOOR: 'Door', SLAB: 'Slab', ROOF: 'Roof', COVERING: 'Covering', CURTAINWALL: 'CurtainWall', PLATE: 'Plate', MEMBER: 'Member', COLUMN: 'Column', BEAM: 'Beam' }[c]; return m ? 'Pset_' + m + 'Common' : null; };
const err = (key) => Object.assign(new Error(key), { key });
const tryIds = (api, mid, cls, inh = false) => { try { return ids(api, mid, cls, inh); } catch { return []; } };

// ---------------------------------------------------------------- rays
function rayBox(o, d, b, tMax) {
  let t0 = 0, t1 = tMax;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) { if (o[k] < b.lo[k] - 1e-9 || o[k] > b.hi[k] + 1e-9) return false; continue; }
    let a = (b.lo[k] - 1e-9 - o[k]) / d[k], c = (b.hi[k] + 1e-9 - o[k]) / d[k];
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, c);
    if (t1 < t0) return false;
  }
  return true;
}
/** Every t (0 < t ≤ tMax) where the ray crosses a triangle of tr (Möller–Trumbore). */
function rayTris(o, d, tr, tMax, out) {
  for (let i = 0; i + 8 < tr.length; i += 9) {
    const e1x = tr[i + 3] - tr[i], e1y = tr[i + 4] - tr[i + 1], e1z = tr[i + 5] - tr[i + 2], e2x = tr[i + 6] - tr[i], e2y = tr[i + 7] - tr[i + 1], e2z = tr[i + 8] - tr[i + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-14) continue;
    const inv = 1 / det, tx = o[0] - tr[i], ty = o[1] - tr[i + 1], tz = o[2] - tr[i + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 1e-7 && t <= tMax) out.push(t);
  }
  return out;
}
/** A point inside a closed shell: crossings along a slanted ray, counted. */
function inside(p, sp) {
  const b = sp.box;
  if (p[0] < b.lo[0] || p[0] > b.hi[0] || p[1] < b.lo[1] || p[1] > b.hi[1] || p[2] < b.lo[2] || p[2] > b.hi[2]) return false;
  const d = [0.8660254, 0.3826834, 0.3213938];
  return rayTris(p, d, sp.tr, 1e9, []).length % 2 === 1;
}
function meshVolume(tr) {
  let v = 0;
  for (let i = 0; i + 8 < tr.length; i += 9) v += (tr[i] * (tr[i + 4] * tr[i + 8] - tr[i + 5] * tr[i + 7]) - tr[i + 1] * (tr[i + 3] * tr[i + 8] - tr[i + 5] * tr[i + 6]) + tr[i + 2] * (tr[i + 3] * tr[i + 7] - tr[i + 4] * tr[i + 6])) / 6;
  return Math.abs(v);
}

export function gatherEnergy(W, api, mid, g, { spacing = 0.25, onProgress = null } = {}) {
  const prods = g.prods, spaces = [...prods].filter(([, p]) => p.cls === 'IFCSPACE');
  const bound = [...prods].filter(([, p]) => BOUND.test(p.cls));
  const lowestZ = Math.min(...spaces.map(([, p]) => p.box.lo[2]));
  const ids2 = new Set();
  const out = g.rooms.map((r, ri) => {
    const sp = prods.get(r.id);
    const c = [(sp.box.lo[0] + sp.box.hi[0]) / 2, (sp.box.lo[1] + sp.box.hi[1]) / 2, (sp.box.lo[2] + sp.box.hi[2]) / 2];
    const lowest = sp.box.lo[2] <= lowestZ + 0.3;
    const near = bound.filter(([, p]) => p.box.hi[0] >= sp.box.lo[0] - 1.6 && p.box.lo[0] <= sp.box.hi[0] + 1.6 && p.box.hi[1] >= sp.box.lo[1] - 1.6 && p.box.lo[1] <= sp.box.hi[1] + 1.6 && p.box.hi[2] >= sp.box.lo[2] - 1.6 && p.box.lo[2] <= sp.box.hi[2] + REACH_UP + 0.1);
    const others = spaces.filter(([id]) => id !== r.id);
    const parts = new Map();
    let open = 0, floorArea = 0;
    const openAt = [];   // where the shell meets nothing (up to 200 sample points with their outward direction)
    const add = (id, cls, exposure, adj, a) => { const k = id + '|' + exposure + '|' + (adj ?? ''); const e = parts.get(k) || { id, cls, exposure, adj: adj ?? null, area: 0 }; e.area += a; parts.set(k, e); if (id !== null) ids2.add(id); };
    const tr = sp.tr;
    for (let i = 0; i + 8 < tr.length; i += 9) {
      const A = [tr[i], tr[i + 1], tr[i + 2]], B = [tr[i + 3], tr[i + 4], tr[i + 5]], C = [tr[i + 6], tr[i + 7], tr[i + 8]];
      const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], ac = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      let n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const l = Math.hypot(...n);
      if (l < 1e-12) continue;
      n = n.map((x) => x / l);
      const area = l / 2;
      const mid0 = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3];
      if ((mid0[0] - c[0]) * n[0] + (mid0[1] - c[1]) * n[1] + (mid0[2] - c[2]) * n[2] < 0) n = n.map((x) => -x);   // outward
      if (n[2] < -0.7) floorArea += area;
      const k = Math.max(1, Math.ceil(Math.max(Math.hypot(...ab), Math.hypot(...ac), Math.hypot(B[0] - C[0], B[1] - C[1], B[2] - C[2])) / spacing));
      const sub = area / (k * k);
      // the k² small triangles of the barycentric subdivision: (i, j) upright and (i, j) upside down; their centres
      for (let a = 0; a < k; a++) for (let b = 0; a + b < k; b++) {
        const cells = [[a + 1 / 3, b + 1 / 3]];
        if (a + b < k - 1) cells.push([a + 2 / 3, b + 2 / 3]);
        for (const [u, v] of cells) {
          const s = u / k, t2 = v / k;
          const p = [A[0] + ab[0] * s + ac[0] * t2 + n[0] * 1e-4, A[1] + ab[1] * s + ac[1] * t2 + n[1] * 1e-4, A[2] + ab[2] * s + ac[2] * t2 + n[2] * 1e-4];
          // the first element out along n (upward up to REACH_UP: a pitched roof over a room with no ceiling of its own)
          let first = null, tF = Infinity;
          const reach = n[2] > 0.7 ? REACH_UP : REACH;
          for (const [id, q] of near) {
            if (!rayBox(p, n, q.box, reach)) continue;
            const ts = rayTris(p, n, q.tr, reach, []);
            if (ts.length) { const m = Math.min(...ts); if (m < tF) { tF = m; first = [id, q]; } }
          }
          if (!first) {
            // no element: an open doorway or a gap — into another room (a connection, no loss at the same temperature) or nowhere
            const into = [0.15, 0.4, 0.8, 1.4].map((tt) => [p[0] + n[0] * tt, p[1] + n[1] * tt, p[2] + n[2] * tt]).map((q) => others.find(([, sq]) => inside(q, sq))).find(Boolean);
            if (into) add(null, 'OPENING', 'adjacent', into[0], sub); else { open += sub; if (openAt.length < 200) openAt.push({ p: p.map((x) => Math.round(x * 1000) / 1000), n: n.map((x) => Math.round(x * 1000) / 1000) }); }
            continue;
          }
          const ts = rayTris(p, n, first[1].tr, tF + 1.2, []);
          const exitT = Math.max(...ts);
          const probe = [p[0] + n[0] * (exitT + 0.25), p[1] + n[1] * (exitT + 0.25), p[2] + n[2] * (exitT + 0.25)];
          const adj = others.find(([, q]) => inside(probe, q));
          const exposure = adj ? 'adjacent' : n[2] < -0.7 && lowest ? 'ground' : 'outside';
          add(first[0], first[1].cls, exposure, adj ? adj[0] : null, sub);
        }
      }
    }
    // windows and doors take their own size from the wall they sit in (the rays find which wall and which side)
    const list = [...parts.values()];
    for (const e of list.filter((x) => /WINDOW|DOOR/.test(x.cls))) {
      const l2 = api.GetLine(mid, e.id, false), mm = lengthUnitMm(api, mid) / 1000;
      const ow = Number(val(l2?.OverallWidth)), oh = Number(val(l2?.OverallHeight));
      if (!(ow > 0 && oh > 0)) continue;
      const want = ow * mm * oh * mm, d = want - e.area;
      const host = list.filter((x) => /WALL|CURTAINWALL|PLATE/.test(x.cls) && x.exposure === e.exposure).sort((x, y) => y.area - x.area)[0];
      if (host && host.area - d > 0) { host.area -= d; e.area = want; }
    }
    onProgress?.(ri + 1, g.rooms.length);
    const named = (id) => { if (id === null) return ''; const l3 = api.GetLine(mid, id, false); return String(val(l3?.Name) ?? '') || String(val(l3?.Tag) ?? '') || '#' + id; };
    return { id: r.id, guid: r.guid, name: r.name, longName: r.longName, storey: r.storey, floorArea, volume: meshVolume(sp.tr), lowest, open, openAt,
      parts: list.filter((x) => x.area > 1e-6).map((x) => ({ ...x, name: named(x.id) })).sort((x, y) => y.area - x.area) };
  });
  return { rooms: out, ids: ids2 };
}

// ---------------------------------------------------------------- U-values
const lambdaOf = (name, typed) => {
  const k = String(name || '').trim().toLowerCase();
  if (typed && Number(typed[k]) > 0) return { lambda: Number(typed[k]), known: true, typed: true };
  const hit = LAMBDA.find(([w]) => k.includes(w));
  return hit ? { lambda: hit[1], known: true, typed: false } : { lambda: null, known: false, typed: false };
};
export function uValues(W, api, mid, idList, { lambdas = {} } = {}) {
  const w = new ModelWriter(W, api, mid), mm = lengthUnitMm(api, mid) / 1000;
  const typeOf = new Map();
  for (const rid of tryIds(api, mid, 'IFCRELDEFINESBYTYPE')) { const r = api.GetLine(mid, rid, false); for (const h of r?.RelatedObjects || []) typeOf.set(h.value, r.RelatingType?.value); }
  const mats = new Map();
  for (const rid of tryIds(api, mid, 'IFCRELASSOCIATESMATERIAL')) { const r = api.GetLine(mid, rid, false); for (const h of r?.RelatedObjects || []) mats.set(h.value, r.RelatingMaterial?.value); }
  const setUse = new Map();   // pset id → how many elements share it
  for (const rid of tryIds(api, mid, 'IFCRELDEFINESBYPROPERTIES')) { const r = api.GetLine(mid, rid, false); const d = r?.RelatingPropertyDefinition?.value; if (d) setUse.set(d, (setUse.get(d) || 0) + (r.RelatedObjects || []).length); }
  const out = new Map();
  for (const id of idList) {
    const l = api.GetLine(mid, id, false);
    if (!l) continue;
    const cls = String(l.constructor?.name || '').toUpperCase(), pset = PSET(cls);
    const kind = kindOf(cls, String(val(l.PredefinedType) ?? ''));
    let u = null, source = 'default', shared = 1, layers = null;
    if (pset) {
      const d = w.defNamed(id, pset);
      const own = d ? w.readPset(id, pset) : null;
      if (own && Number(own.ThermalTransmittance) > 0) { u = Number(own.ThermalTransmittance); source = 'ifc'; shared = setUse.get(d.def) || 1; }
      else {
        const ty = typeOf.get(id), tl = ty ? api.GetLine(mid, ty, false) : null;
        for (const h of tl?.HasPropertySets || []) { const ps = api.GetLine(mid, h.value, false); if (val(ps?.Name) !== pset) continue; for (const q of ps.HasProperties || []) { const p = api.GetLine(mid, q.value, false); if (val(p?.Name) === 'ThermalTransmittance' && Number(val(p.NominalValue)) > 0) { u = Number(val(p.NominalValue)); source = 'ifc-type'; } } }
      }
    }
    if (u === null) {
      let m = mats.get(id) ?? mats.get(typeOf.get(id));
      let ml = m ? api.GetLine(mid, m, false) : null;
      if (ml?.ForLayerSet) ml = api.GetLine(mid, ml.ForLayerSet.value, false);
      if (ml?.MaterialLayers?.length) {
        layers = ml.MaterialLayers.map((h) => { const ly = api.GetLine(mid, h.value, false), mat = ly?.Material?.value ? api.GetLine(mid, ly.Material.value, false) : null; const name = String(val(mat?.Name) ?? val(ly?.Name) ?? ''); return { name, d: Number(val(ly?.LayerThickness)) * mm, ...lambdaOf(name, lambdas) }; });
        if (layers.length && layers.every((x) => x.known && x.d > 0)) {
          const [rsi, rse] = kind === 'roof' ? SURFACE.up : kind === 'floor' ? SURFACE.down : SURFACE.side;
          u = 1 / (rsi + layers.reduce((s, x) => s + x.d / x.lambda, 0) + rse);
          source = 'layers';
        }
      }
    }
    if (u === null) u = DEFAULT_U[kind] ?? DEFAULT_U.other;
    out.set(id, { id, cls, kind, u, source, set: pset, shared, layers, name: String(val(l.Name) ?? '') });
  }
  return out;
}
export function uOp(guid, value) {
  const v = value === '' || value === null || value === undefined ? null : Number(value);
  if (v !== null && !(v > 0 && v <= 20)) throw err('energy.err.u');
  return (ed) => {
    const w = new ModelWriter(ed.W, ed.api, ed.mid);
    return w.run(() => {
      let id = null;
      for (const x of ids(w.api, w.mid, 'IFCROOT', true)) { const l = w.api.GetLine(w.mid, x, false); if (l && val(l.GlobalId) === guid) { id = x; break; } }
      if (id === null) throw err('energy.err.gone');
      const pset = PSET(String(w.api.GetLine(w.mid, id, false).constructor?.name || '').toUpperCase());
      if (!pset) throw err('energy.err.kind');
      const d = w.defNamed(id, pset);
      if (v === null) {
        if (!d) return { id };
        const keep = [], gone = [];
        for (const h of d.line.HasProperties || []) { const p = w.api.GetLine(w.mid, h.value, false); (val(p?.Name) === 'ThermalTransmittance' ? gone : keep).push(h); }
        if (!gone.length) return { id };
        if (!keep.length) { w.dropProduct([d.def]); for (const h of gone) w.dropTree(h.value); w._defs = null; return { id }; }
        const ps = w.touch(d.def); ps.HasProperties = keep; w.write(ps);
        for (const h of gone) w.dropTree(h.value);
        return { id };
      }
      // the set this element reads from (shared ones included: the same construction changes everywhere it is used)
      w.upsertPset(id, pset, [['ThermalTransmittance', 'IFCTHERMALTRANSMITTANCEMEASURE', v]]);
      return { id };
    });
  };
}

// ---------------------------------------------------------------- loads
export function loads(e, uMap, inputs = {}, { solar = null } = {}) {
  const I = { ...INPUTS, ...inputs };
  const dT = I.ti - I.te, dTg = I.ti - I.tg, dTs = I.teSummer - I.tiCool;
  return e.rooms.map((r) => {
    const rows = r.parts.map((p) => { const u = uMap.get(p.id); return { ...p, u: u?.u ?? DEFAULT_U.other, source: u?.source ?? 'default', ua: (u?.u ?? DEFAULT_U.other) * p.area }; });
    const sum = (exp) => rows.filter((x) => x.exposure === exp).reduce((s, x) => s + x.ua, 0);
    const H = { out: sum('outside'), ground: sum('ground'), vent: RHO_C * I.ach * r.volume };
    const heat = { fabric: H.out * dT, ground: H.ground * dTg, vent: H.vent * dT };
    heat.total = heat.fabric + heat.ground + heat.vent;
    const annual = dT > 0 ? ((H.out + H.vent + H.ground * (dTg / dT)) * I.dd * 24) / 1000 : 0;
    const people = I.perPerson > 0 ? (r.floorArea / I.perPerson) * I.wPerson : 0;
    const sr = solar?.rooms?.find((x) => x.id === r.id) || null;
    const cool = { fabric: H.out * dTs, vent: H.vent * dTs, people, lights: I.wLights * r.floorArea, equip: I.wEquip * r.floorArea, solar: sr ? sr.peak : 0, at: sr ? sr.peakAt : null };
    cool.total = Math.max(0, cool.fabric + cool.vent + cool.people + cool.lights + cool.equip + cool.solar);
    return { ...r, rows, H, heat, annual, cool, inputs: I };
  });
}

export function degreeDaysCsv(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r\n|\n|\r/).filter((l) => l.trim());
  if (lines.length > 50000) throw err('energy.err.dd-big');
  const sep = [',', ';', '\t'].map((c) => [c, (lines[0] || '').split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const split = (l) => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map((x) => x.trim()); };
  let total = 0, rows = 0;
  for (const l of lines) {
    const cells = split(l);
    const nums = cells.map((x) => (/^[+-]?\d+([.,]\d+)?$/.test(x) ? Number(x.replace(',', '.')) : NaN)).filter((x, i) => Number.isFinite(x) && i > 0);
    if (!nums.length) continue;
    total += nums[nums.length - 1]; rows++;
  }
  if (!rows) throw err('energy.err.dd-none');
  return { total, rows };
}
