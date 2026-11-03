/* SPDX-License-Identifier: Apache-2.0 */
/**
 * usd-bimcraft.js — Export › USD: the open IFC models as OpenUSD by docs/USD-CONVENTIONS.md (0.7 XF.8, session `usd`).
 * DOM-free (Node tests drive it); the library is cc-usd (./usd/, a copy of lib/usd written by tools/usd/sync.mjs).
 *
 *   bimUsd(entries, { format = 'usda' | 'usdc' | 'usdz', name, appVersion, matrixOf(mi), progress(done, total) })
 *     → Promise<{ data, report: { elements, storeys, materials, models } }>
 *   entries = the federated models [{ mi, ifc: IfcModel, model: load result, name, visible }]; matrixOf(mi) = the viewer's
 *   placement of that model (viewer.modelMatrix), so federated models land where BimCraft shows them.
 *
 * What is written (one model each, under /World): Site › Building › storeys (by elevation) › discipline groups (§ 3) ›
 * one Xform per element (kind component) with a `Body` mesh (its triangles from the viewer's per-element runs, corner
 * normals, one GeomSubset per colour when it has several) and the element's IFC data (§ 5.1: class, predefined type,
 * GlobalId, name, description, object type, tag, storey, type; § 5.2: every property and quantity set, lengths, areas
 * and volumes in SI with the unit in customData). Spaces go in `Spaces` with purpose guide. Materials: one per colour the
 * model draws with (OpenPBR + preview; transparency → geometry_opacity).
 * **Coordinates:** points are the viewer's (metres, the model moved near the origin so floats keep precision), turned Z up;
 * each Site's own transform takes them back to the IFC file's coordinates (the coordination offset, as doubles). Element
 * geometry is written in those coordinates with no placement of its own (BimCraft reads triangles, not IFC placements).
 */
import { UsdBuilder, V } from './usd/index.js';
import { disciplineOf, writeIfcElement } from './usd/ifc.js';
import { lengthUnitMm } from './ifc-util.js';

/** Y up (the viewer) → Z up: (x, y, z) → (x, −z, y). */
const A = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
const AI = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
function mmul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
function inv(m) {
  // rigid + uniform scale placements: transpose the rotation part, scale back, move back
  const s2 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] || 1;
  const r = [m[0] / s2, m[4] / s2, m[8] / s2, 0, m[1] / s2, m[5] / s2, m[9] / s2, 0, m[2] / s2, m[6] / s2, m[10] / s2, 0, 0, 0, 0, 1];
  const t = [m[12], m[13], m[14]];
  r[12] = -(r[0] * t[0] + r[4] * t[1] + r[8] * t[2]);
  r[13] = -(r[1] * t[0] + r[5] * t[1] + r[9] * t[2]);
  r[14] = -(r[2] * t[0] + r[6] * t[1] + r[10] * t[2]);
  return r;
}
const str = (v) => (v && typeof v === 'object' && 'value' in v ? (v.value === '' || v.value === null || v.value === undefined ? null : v.value) : v ?? null);
const hexOf = (c) => '#' + [0, 1, 2].map((k) => Math.round(Math.min(1, Math.max(0, c[k])) * 255).toString(16).padStart(2, '0')).join('');

export async function bimUsd(entries, { format = 'usda', name = 'model', appVersion = '', matrixOf = () => null, progress = () => {} } = {}) {
  const b = new UsdBuilder({ app: 'BimCraft', appVersion, source: name, doc: entries.map((e) => e.name).join(', ') });
  const report = { elements: 0, storeys: 0, materials: 0, models: 0 };
  const mats = new Map();
  const material = (color) => {
    const hex = hexOf(color), a = color[3] ?? 1;
    const key = hex + (a < 0.999 ? '_' + Math.round(a * 100) : '');
    if (mats.has(key)) return mats.get(key);
    const lin = [0, 1, 2].map((k) => { const v = color[k]; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    const p = { base_color: lin, specular_roughness: 0.6 };
    if (a < 0.999) { p.geometry_opacity = Math.max(0, a); p.geometry_thin_walled = true; }
    const m = b.material('Color_' + key.slice(1), p, { displayName: key });
    mats.set(key, m);
    report.materials++;
    return m;
  };
  const total = entries.reduce((s, e) => s + (e.model.elements || 0) + (e.model.spaces || 0), 0) || 1;
  let done = 0;
  for (const e of entries) {
    if (e.visible === false) continue;
    report.models++;
    const { api } = e.ifc, mid = e.model.modelID, M = e.model;
    const keyBase = M.keyBase || 0;
    const lengthToMetre = lengthUnitMm(api, mid) / 1000;
    const line = (id) => { try { return api.GetLine(mid, id, false); } catch { return null; } };
    // the viewer's placement of this model, and back to the file's own coordinates
    const P = matrixOf(e.mi) || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    let C = null;
    try { C = [...api.GetCoordinationMatrix(mid)]; } catch { C = null; }
    // scene = P·C·file (both Y up), so file = (P·C)⁻¹·scene; in Z up: A·(P·C)⁻¹·A⁻¹
    const toFile = C && C.length === 16 ? mmul(A, mmul(inv(mmul(P, C)), AI)) : null;
    const siteLine = (M.tree && findType(M.tree, 'IFCSITE')) || null;
    const bldLine = (M.tree && findType(M.tree, 'IFCBUILDING')) || null;
    const siteName = (siteLine && str(line(siteLine.expressID)?.Name)) || e.name.replace(/\.ifc$/i, '') || 'Site';
    const site = b.group(b.root, 'Site_' + siteName, { kind: 'assembly', displayName: siteName, matrix: toFile && !isIdent(toFile) ? toFile : null });
    if (siteLine) writeSpatial(b, site, line(siteLine.expressID), 'IfcSite');
    b.attr(site, 'cadcraft:source', 'string', e.name.replace(/^.*[\\/]/, ''), { custom: true, uniform: true });
    const bldName = (bldLine && str(line(bldLine.expressID)?.Name)) || 'Building';
    const bld = b.group(site, 'Building_' + bldName, { kind: 'assembly', displayName: bldName });
    if (bldLine) writeSpatial(b, bld, line(bldLine.expressID), 'IfcBuilding');
    // storeys (by elevation, numbered from 00) and their discipline groups, made when first needed
    const storeyPrim = new Map(), groupPrim = new Map();
    (M.storeys || []).forEach((s, k) => {
      const p = b.group(bld, String(k).padStart(2, '0') + '_' + s.name, { kind: 'group', displayName: s.name });
      writeSpatial(b, p, line(s.id), 'IfcBuildingStorey');
      if (Number.isFinite(s.elevation)) b.attr(p, 'ifc:elevation', 'double', s.elevation * lengthToMetre, { custom: true, uniform: true, meta: { customData: V('dictionary', new Map([['unit', V('string', 'm')]])) } });
      storeyPrim.set(s.id, p);
      report.storeys++;
    });
    const groupFor = (storey, disc) => {
      const parent = storeyPrim.get(storey) || (storeyPrim.get('other') || storeyPrim.set('other', b.group(bld, 'Unplaced', { kind: 'group' })).get('other'));
      const key = parent + '|' + disc;
      if (!groupPrim.has(key)) groupPrim.set(key, b.group(parent, disc, { kind: 'group', purpose: disc === 'Spaces' ? 'guide' : null }));
      return groupPrim.get(key);
    };
    // every element's triangles, gathered from the batches it was drawn in
    const runs = new Map();
    for (const bt of M.batches) {
      const E = bt.elems;
      for (let k = 0; k < E.ids.length; k++) {
        const key = E.ids[k];
        let a = runs.get(key);
        if (!a) runs.set(key, (a = []));
        a.push({ bt, t0: E.t0[k], tn: E.tn[k], v0: E.v0[k], vn: E.vn[k] });
      }
    }
    const storeyGuid = new Map((M.storeys || []).map((s) => [s.id, str(line(s.id)?.GlobalId)]));
    for (const [key, parts] of runs) {
      const id = key - keyBase;
      const cls = M.classOf.get(id) || 'IfcBuildingElementProxy';
      const ln = line(id) || {};
      const predefined = str(ln.PredefinedType);
      const el = {
        cls, guid: str(ln.GlobalId), name: str(ln.Name), description: str(ln.Description), objectType: str(ln.ObjectType), tag: str(ln.Tag),
        predefined, storeyGuid: storeyGuid.get(M.storeyOf.get(id)) || null, lengthToMetre, sets: [],
      };
      await readProps(api, mid, id, el, line);
      const group = groupFor(M.storeyOf.get(id), disciplineOf(cls, predefined));
      const nm = el.name || cls + (el.tag ? ' ' + el.tag : '');
      const ep = b.group(group, nm, { kind: 'component', displayName: nm });
      writeIfcElement(b, ep, el);
      // Body: the runs' vertices, Z up, in scene coordinates (P places a federated model)
      let nv = 0, nt = 0;
      for (const r of parts) { nv += r.vn; nt += r.tn; }
      const pts = new Float32Array(nv * 3), nrm = new Float32Array(nt * 9), idx = new Int32Array(nt * 3), counts = new Int32Array(nt).fill(3);
      const subsets = [];
      let vo = 0, to = 0;
      for (const r of parts) {
        const { bt } = r;
        const pos = bt.positions, nn = bt.normals, ix = bt.indices;
        for (let v = 0; v < r.vn; v++) {
          const s = (r.v0 + v) * 3;
          const x = pos[s], y = pos[s + 1], z = pos[s + 2];
          const wx = P[0] * x + P[4] * y + P[8] * z + P[12], wy = P[1] * x + P[5] * y + P[9] * z + P[13], wz = P[2] * x + P[6] * y + P[10] * z + P[14];
          pts[(vo + v) * 3] = wx; pts[(vo + v) * 3 + 1] = -wz; pts[(vo + v) * 3 + 2] = wy;
        }
        for (let t = 0; t < r.tn; t++) {
          for (let c = 0; c < 3; c++) {
            const vi = ix[(r.t0 + t) * 3 + c];
            idx[(to + t) * 3 + c] = vi - r.v0 + vo;
            const nx = nn[vi * 3], ny = nn[vi * 3 + 1], nz = nn[vi * 3 + 2];
            const wx = P[0] * nx + P[4] * ny + P[8] * nz, wy = P[1] * nx + P[5] * ny + P[9] * nz, wz = P[2] * nx + P[6] * ny + P[10] * nz;
            const o = ((to + t) * 3 + c) * 3;
            nrm[o] = wx; nrm[o + 1] = -wz; nrm[o + 2] = wy;
          }
        }
        const m = material(bt.color);
        const last = subsets[subsets.length - 1];
        if (last && last.material === m) for (let t = 0; t < r.tn; t++) last.faces.push(to + t);
        else subsets.push({ name: 'colour_' + (subsets.length + 1), faces: Array.from({ length: r.tn }, (_, t) => to + t), material: m });
        vo += r.vn; to += r.tn;
      }
      const one = subsets.length === 1 || subsets.every((s) => s.material === subsets[0].material);
      b.mesh(ep, 'Body', { points: pts, counts, indices: idx, normals: { values: nrm, interp: 'faceVarying' } }, { material: one ? subsets[0].material : null, subsets: one ? [] : subsets });
      report.elements++;
      if (++done % 200 === 0) progress(done, total);
    }
  }
  progress(total, total);
  const data = format === 'usdz' ? b.usdz() : b.write(format);
  return { data, report };
}

function isIdent(m) { return m.every((x, i) => Math.abs(x - (i % 5 === 0 ? 1 : 0)) < 1e-12); }
function findType(node, type) {
  if (!node) return null;
  if (String(node.type || '').toUpperCase() === type) return node;
  for (const c of node.children || []) { const f = findType(c, type); if (f) return f; }
  return null;
}
function writeSpatial(b, prim, ln, cls) {
  if (!ln) return;
  const S = (n, v) => { if (v !== null && v !== undefined && v !== '') b.attr(prim, n, 'string', String(v), { custom: true, uniform: true }); };
  b.attr(prim, 'ifc:class', 'token', cls, { custom: true, uniform: true });
  S('ifc:globalId', str(ln.GlobalId)); S('ifc:name', str(ln.Name)); S('ifc:longName', str(ln.LongName)); S('ifc:description', str(ln.Description));
}

/** Property and quantity sets (instance first, then its type's), each value with its IFC measure name. */
async function readProps(api, mid, id, el, line) {
  const one = (p) => {
    if (!p) return null;
    const name = str(p.Name);
    if (!name) return null;
    if (p.NominalValue !== undefined && p.NominalValue !== null) return { name, type: p.NominalValue.name || '', value: p.NominalValue.value };
    if (Array.isArray(p.EnumerationValues)) return { name, type: 'IFCLABEL', value: p.EnumerationValues.map((v) => str(v)).filter((v) => v !== null), enumerated: true };
    if (Array.isArray(p.ListValues)) return { name, type: p.ListValues[0]?.name || '', value: p.ListValues.map((v) => str(v)).filter((v) => v !== null) };
    const q = p.LengthValue ?? p.AreaValue ?? p.VolumeValue ?? p.CountValue ?? p.WeightValue ?? p.TimeValue;
    if (q !== undefined && q !== null) {
      const kind = p.LengthValue !== undefined && p.LengthValue !== null ? 'LENGTH' : p.AreaValue != null ? 'AREA' : p.VolumeValue != null ? 'VOLUME' : p.WeightValue != null ? 'WEIGHT' : p.CountValue != null ? 'IFCCOUNTMEASURE' : 'IFCTIMEMEASURE';
      return { name, type: kind, value: typeof q === 'object' ? q.value : q };
    }
    return null;
  };
  const sets = [];
  const take = (s, fromType) => {
    if (!s) return;
    const name = str(s.Name) || 'Properties';
    const props = [...(s.HasProperties || []), ...(s.Quantities || [])].map(one).filter(Boolean);
    if (props.length) sets.push({ name: fromType ? name : name, quantities: !!s.Quantities, props });
  };
  let ps = [];
  try { ps = await api.properties.getPropertySets(mid, id, true); } catch { ps = []; }
  for (const s of ps) take(s, false);
  try {
    const types = await api.properties.getTypeProperties(mid, id, true);
    const ty = types && types[0];
    if (ty) {
      el.type = { guid: str(ty.GlobalId), name: str(ty.Name), cls: ty.constructor && /^Ifc/.test(ty.constructor.name) ? ty.constructor.name : null };
      for (const s of ty.HasPropertySets || []) take(s, true);
    }
  } catch { /* no type */ }
  el.sets = sets;
  try {
    const groups = await api.properties.getGroups(mid, id);
    el.groups = groups.map((g) => g.name).filter(Boolean);
  } catch { el.groups = []; }
  void line;
}
