/* SPDX-License-Identifier: Apache-2.0 */
/**
 * family-edit.js — what the family editor does to a recipe (0.6 DC.114, session bim-families_PART_2). No DOM:
 * bin/test-bimcraft.mjs --families runs it in Node; family-editor.js is its page.
 *
 * Every function takes a recipe (family-model.js format) and returns { ok, fam } with a changed copy, or { ok: false, error:
 * { key, fill } }; the recipe passed in is never changed. Nothing here writes IFC: the editor saves through family-ops.js
 * saveFamily (one undo step).
 *
 *   names(fam)                               the names an expression may use: parameters, then WallThickness / Face (hosted)
 *   usesOf(fam, key) → [where]               every field that names a parameter
 *   addParam(fam, { key, kind, value, label }) · removeParam(fam, key) (refused while used) · renameParam(fam, from, to)
 *       (every expression follows) · setParam(fam, key, { kind, value, formula, label })
 *   addSolid(fam, op) · removeSolid(fam, id) (its Booleans go too) · duplicateSolid(fam, id) · setSolid(fam, id, patch)
 *   addBoolean(fam, { op, a, b }) · removeBoolean(fam, id) · setBoolean(fam, id, patch) · operands(fam, exceptId) (free ones)
 *   addConnector(fam, { domain, system }) · removeConnector(fam, id) · setConnector(fam, id, patch) (unhosted families only)
 *   setFixture(fam, kind) ('' = not a plumbing fixture)
 *   points: pointsOf(s) · movePoint(fam, id, i, [u, v]) · insertPoint(fam, id, i, [u, v]) · removePoint(fam, id, i) ·
 *       setBulge(fam, id, i, b) · cycleArc(b) (straight → quarter arc left → quarter arc right → straight) · snap(v, step)
 *   handles: sizeHandles(fam, values, ctx) and solidHandles(fam, values, id, ctx) → [{ p, axis, label, target }] in the
 *       family's own mm (x, y, z up); dragHandle(fam, values, handle, to, ctx) → { ok, fam, values } — a literal field is set
 *       to the number; a field bound to parameters moves the input parameter it depends on (solved numerically through any
 *       formulas), so the size being previewed changes and the recipe keeps its formulas.
 */
import { parse, evaluate, renameIn, formatNumber, literal, NAME_RE, RESERVED } from './expr.js';
import { SYMBOL_KINDS, SYMBOL_FIELDS, SYMBOL_LIMITS, FILL_KEYS as SYM_FILLS } from './family-symbol.js';
import { partExprs, hotspotExprs } from './family-model.js';
import { fullValues, readFamily, evaluateFamily, inputParams, sizeValues, planBounds, CONTEXT_NAMES, PARAM_KINDS, SOLID_OPS, STYLES, LIMITS, isWordKind, cleanValue,
  CONNECTOR_DOMAINS, CONNECTOR_DIRS, CONNECTOR_FIELDS } from './family-model.js';

const err = (key, fill = {}) => ({ ok: false, error: { key, fill } });
const copy = (fam) => JSON.parse(JSON.stringify(fam));
const done = (fam) => ({ ok: true, fam });

export const names = (fam) => [...fam.params.filter((p) => !isWordKind(p.kind)).map((p) => p.key), ...(fam.host === 'wall' ? CONTEXT_NAMES : [])];   // words (text, material, fill) are not in expressions

/** Every expression field of a solid as [field label, getter, setter] (getter/setter on the raw recipe solid). */
function exprFields(s) {
  const out = [];
  const plain = (k) => out.push([k, () => s[k], (v) => { s[k] = v; }]);
  if (s.visible) plain('visible');
  if (s.array) for (const k of ['count', 'dx', 'dy', 'dz']) out.push(['array ' + k, () => s.array[k], (v) => { s.array[k] = v; }]);
  if (s.op === 'box') for (const k of ['x0', 'y0', 'z0', 'x1', 'y1', 'z1']) plain(k);
  else if (s.op === 'extrude' || s.op === 'revolve') {
    plain('at');
    (s.profile || []).forEach((p, i) => { for (const j of [0, 1]) out.push(['profile ' + (i + 1), () => p[j], (v) => { p[j] = v; }]); });
    if (s.op === 'extrude') plain('depth');
    else { (s.axis || []).forEach((a, i) => out.push(['axis ' + (i + 1), () => s.axis[i], (v) => { s.axis[i] = v; }])); plain('angle'); }
  } else {
    (s.path || []).forEach((p, i) => { for (const j of [0, 1, 2]) out.push(['path ' + (i + 1), () => p[j], (v) => { p[j] = v; }]); });
    plain('radius');
  }
  return out;
}
/** Every expression field of a symbol part as [label, getter, setter]. */
function symFields(p) {
  const out = [], plain = (k) => { if (p[k] !== undefined) out.push([k, () => p[k], (v) => { p[k] = v; }]); };
  for (const k of ['visible', 'pen', 'zmin', 'zmax', 'rot', ...(SYMBOL_FIELDS[p.kind] || [])]) plain(k);
  if (p.array) for (const k of ['count', 'dx', 'dy']) out.push(['array ' + k, () => p.array[k], (v) => { p.array[k] = v; }]);
  if (p.kind === 'poly') p.pts.forEach((pt, i) => { for (const j of [0, 1]) out.push(['point ' + (i + 1), () => pt[j], (v) => { pt[j] = v; }]); });
  return out;
}
const usesName = (src, key) => { const p = parse(String(src ?? '')); return p.ok && p.uses.includes(key); };

export function usesOf(fam, key) {
  const out = [];
  for (const p of fam.params) if (p.formula && usesName(p.formula, key)) out.push(p.key);
  for (const s of fam.solids) for (const [label, get] of exprFields(s)) if (usesName(get(), key)) out.push((s.name || s.id) + ' ' + label);
  for (const p of fam.symbol?.parts || []) for (const [label, get] of symFields(p)) if (usesName(get(), key)) out.push('symbol ' + p.id + ' ' + label);
  for (const h of fam.hotspots || []) { for (const [label, src] of hotspotExprs(h)) if (usesName(src, key)) out.push('hotspot ' + h.id + ' ' + label); if (h.drives === key) out.push('hotspot ' + h.id + ' drives'); }
  for (const p of fam.parts || []) { for (const [label, src] of partExprs(p)) if (usesName(src, key)) out.push('part ' + p.id + ' ' + label); for (const [k, v] of Object.entries(p.values || {})) if (usesName(v, key) || v === key) out.push('part ' + p.id + ' ' + k); }
  for (const c of fam.connectors || []) for (const k of CONNECTOR_FIELDS) if (usesName(c[k], key)) out.push((c.name || c.id) + ' ' + k);
  return out;
}

// ======================================================================================================== parameters
const PARAM_RE = NAME_RE;
function keyProblem(fam, key, except = null) {
  if (typeof key !== 'string' || !PARAM_RE.test(key) || RESERVED.has(key) || CONTEXT_NAMES.includes(key)) return err('fam.err.param', { name: String(key ?? '').slice(0, 40) });
  if (fam.params.some((p) => p.key === key && p.key !== except)) return err('fam.err.param', { name: key });
  return null;
}
export function addParam(fam, { key, kind = 'length', value = 0, label = '' } = {}) {
  if (fam.params.length >= LIMITS.params) return err('fam.err.toomany', { what: 'params', n: LIMITS.params });
  const bad = keyProblem(fam, key);
  if (bad) return bad;
  const f = copy(fam);
  const k = PARAM_KINDS.includes(kind) ? kind : 'number';
  const q = { key, kind: k, value: cleanValue(k, isWordKind(k) ? (typeof value === 'string' ? value : k === 'fill' ? 'none' : '') : value) };
  if (label) q.label = String(label).slice(0, LIMITS.name);
  f.params.push(q);
  return done(f);
}
/** A free parameter name: "P1", "P2", … (or `base` + a number). */
export function freeParamKey(fam, base = 'P') {
  for (let i = 1; ; i++) { const k = base + i; if (!keyProblem(fam, k)) return k; }
}
export function removeParam(fam, key) {
  if (!fam.params.some((p) => p.key === key)) return err('fam.err.noparam', { name: key });
  if (fam.host === 'wall' && (key === 'Width' || key === 'Height')) return err('fam.err.needs', { name: key });
  const used = usesOf(fam, key);
  if (used.length) return err('fam.err.paramused', { name: key, where: used.slice(0, 3).join(', ') });
  const f = copy(fam);
  f.params = f.params.filter((p) => p.key !== key);
  return done(f);
}
export function renameParam(fam, from, to) {
  if (from === to) return done(copy(fam));
  if (!fam.params.some((p) => p.key === from)) return err('fam.err.noparam', { name: from });
  if (fam.host === 'wall' && (from === 'Width' || from === 'Height')) return err('fam.err.needs', { name: from });
  const bad = keyProblem(fam, to, from);
  if (bad) return bad;
  const f = copy(fam);
  for (const p of f.params) { if (p.key === from) p.key = to; if (p.formula) p.formula = renameIn(p.formula, from, to); }
  for (const s of f.solids) for (const [, get, set] of exprFields(s)) { const v = get(); if (typeof v === 'string') set(renameIn(v, from, to)); }
  for (const p of f.symbol?.parts || []) {
    for (const [, get, set] of symFields(p)) { const v = get(); if (typeof v === 'string') set(renameIn(v, from, to)); }
    if (p.fill === from) p.fill = to;   // a Fill parameter's name
    if (p.kind === 'text') p.text = p.text.split('{' + from + '}').join('{' + to + '}');
  }
  for (const s of f.solids) if (s.material === from) s.material = to;   // a Material parameter's name
  for (const h of f.hotspots || []) { h.at = h.at.map((x) => renameIn(x, from, to)); if (h.to) h.to = h.to.map((x) => renameIn(x, from, to)); if (h.drives === from) h.drives = to; }
  for (const p of f.parts || []) {
    p.at = p.at.map((x) => renameIn(x, from, to));
    if (p.rot !== undefined) p.rot = renameIn(p.rot, from, to);
    if (p.visible !== undefined) p.visible = renameIn(p.visible, from, to);
    for (const [k, v] of Object.entries(p.values || {})) p.values[k] = v === from ? to : (parse(v).ok ? renameIn(v, from, to) : v);   // a word parameter's name, or an expression
  }
  for (const c of f.connectors || []) for (const k of CONNECTOR_FIELDS) if (typeof c[k] === 'string') c[k] = renameIn(c[k], from, to);
  if (Array.isArray(f.sizes)) for (const z of f.sizes) if (z.values && from in z.values) { z.values[to] = z.values[from]; delete z.values[from]; }
  return done(f);
}
export function setParam(fam, key, patch = {}) {
  const f = copy(fam), p = f.params.find((x) => x.key === key);
  if (!p) return err('fam.err.noparam', { name: key });
  if ('kind' in patch && PARAM_KINDS.includes(patch.kind)) {
    if (isWordKind(patch.kind) !== isWordKind(p.kind)) {   // between a number and a word the old value means nothing
      const used = usesOf(fam, key);
      if (isWordKind(patch.kind) && (used.length || p.formula)) return err('fam.err.paramused', { name: key, where: (used.length ? used : [key]).slice(0, 3).join(', ') });
      p.value = patch.kind === 'fill' ? 'none' : isWordKind(patch.kind) ? '' : 0; delete p.formula;
    }
    p.kind = patch.kind; p.value = cleanValue(p.kind, p.value);
  }
  if ('value' in patch) {
    if (isWordKind(p.kind)) { p.value = cleanValue(p.kind, patch.value); if (p.kind === 'material' && patch.value && !p.value) return err('fam.err.value', { name: key }); }
    else { const v = Number(patch.value); if (!Number.isFinite(v) || Math.abs(v) > LIMITS.value) return err('fam.err.value', { name: key }); p.value = cleanValue(p.kind, v); }
  }
  if ('instance' in patch) {   // set per placed element instead of per size
    if (patch.instance && (p.formula || (fam.host === 'wall' && (key === 'Width' || key === 'Height')))) return err('fam.err.instance', { name: key });
    if (patch.instance) p.instance = true; else delete p.instance;
  }
  if ('label' in patch) { const l = String(patch.label ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name); if (l) p.label = l; else delete p.label; }
  if ('formula' in patch) {
    const src = String(patch.formula ?? '').trim();
    if (!src) delete p.formula;
    else {
      if (fam.host === 'wall' && (key === 'Width' || key === 'Height')) return err('fam.err.needs', { name: key });
      const ps = parse(src, names(f).filter((n) => n !== key));
      if (!ps.ok) return err('fam.err.unknown', { where: key, why: ps.error });
      p.formula = src;
    }
  }
  const r = checked(f);
  if (r.ok && 'formula' in patch) {   // a formula that depends on itself is refused at once (other problems show in the preview)
    const ev = evaluateFamily(r.fam, {}, { wallThickness: 140 });
    if (!ev.ok && ev.error.key === 'fam.err.cycle') return { ok: false, error: ev.error, fam: f };
  }
  return r;
}
/** The copy, read back by the untrusted reader (so the editor never keeps a recipe the model would refuse). */
function checked(f) {
  const r = readFamily({ ...f, sizes: undefined });
  if (!r.ok) return { ok: false, error: r.errors[0], fam: f };
  return done(f);
}

// ======================================================================================================== solids
const SOLID_ID_RE = /^[a-z][a-z0-9_-]{0,23}$/;
function freeId(fam, prefix) {
  const have = new Set([...fam.solids.map((s) => s.id), ...(fam.booleans || []).map((b) => b.id)]);
  for (let i = 1; ; i++) if (!have.has(prefix + i)) return prefix + i;
}
/** Where a new solid starts: inside the family's size when it has Width / Depth / Height, else a 300 mm block. */
function frameOf(fam) {
  const has = (k) => fam.params.some((p) => p.key === k);
  const W = has('Width') ? 'Width' : '300', D = has('Depth') ? 'Depth' : fam.host === 'wall' ? 'WallThickness' : '300', H = has('Height') ? 'Height' : '300';
  return { W, D, H, hosted: fam.host === 'wall', centred: fam.host !== 'wall' };
}
export function addSolid(fam, op = 'box') {
  if (!SOLID_OPS.includes(op)) return err('fam.err.solid', { id: String(op) });
  if (fam.solids.length >= LIMITS.solids) return err('fam.err.toomany', { what: 'solids', n: LIMITS.solids });
  const f = copy(fam), id = freeId(f, 's'), F = frameOf(f);
  const half = (x) => `(${x} / 2)`;
  let s;
  if (op === 'box') s = F.hosted ? { id, op, x0: '0', y0: `(-${F.D} / 2)`, z0: '0', x1: F.W, y1: half(F.D), z1: F.H }
    : { id, op, x0: `(-${F.W} / 2)`, y0: '0', z0: '0', x1: half(F.W), y1: F.D, z1: F.H };
  else if (op === 'extrude') s = { id, op, plane: 'xy', at: '0', profile: [['0', '0'], ['200', '0'], ['200', '200'], ['0', '200']], depth: '100' };
  else if (op === 'revolve') s = { id, op, plane: 'xz', at: '0', profile: [['0', '0'], ['150', '0'], ['100', '300'], ['0', '300']], axis: ['0', '0', '0', '1'], angle: '360' };
  else s = { id, op, path: [['0', '0', '0'], ['0', '0', '300'], ['300', '0', '300']], radius: '15' };
  s.style = op === 'box' ? 'solid' : op === 'sweep' ? 'metal' : 'solid';
  f.solids.push(s);
  return { ...checked(f), id };
}
export function removeSolid(fam, id) {
  if (!fam.solids.some((s) => s.id === id)) return err('fam.err.solid', { id });
  if (fam.solids.length === 1) return err('fam.err.nosolids');
  const f = copy(fam);
  f.solids = f.solids.filter((s) => s.id !== id);
  // Booleans that used it, then those that used them
  const gone = new Set([id]);
  let more = true;
  while (more) {
    more = false;
    for (const b of f.booleans || []) if (!gone.has(b.id) && (gone.has(b.a) || gone.has(b.b))) { gone.add(b.id); more = true; }
  }
  f.booleans = (f.booleans || []).filter((b) => !gone.has(b.id));
  return checked(f);
}
export function duplicateSolid(fam, id) {
  const s = fam.solids.find((x) => x.id === id);
  if (!s) return err('fam.err.solid', { id });
  if (fam.solids.length >= LIMITS.solids) return err('fam.err.toomany', { what: 'solids', n: LIMITS.solids });
  const f = copy(fam), nid = freeId(f, 's');
  const c = { ...copy(s), id: nid };
  f.solids.splice(f.solids.findIndex((x) => x.id === id) + 1, 0, c);
  return { ...checked(f), id: nid };
}
/** Change a solid's fields: name, style, visible ('' = always), op-specific fields (numbers or expressions), plane, profile,
 *  path, axis. A field that does not read is refused, naming it. */
export function setSolid(fam, id, patch = {}) {
  const f = copy(fam), s = f.solids.find((x) => x.id === id);
  if (!s) return err('fam.err.solid', { id });
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'name') { const n = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 60); if (n) s.name = n; else delete s.name; continue; }
    if (k === 'style') { if (STYLES[v]) s.style = v; continue; }
    if (k === 'detail') { if (v === 'medium' || v === 'fine') s.detail = v; else delete s.detail; continue; }   // shown from that level on
    if (k === 'material') { const m = String(v ?? '').trim(); if (!m) { delete s.material; continue; } if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(m)) return err('fam.err.field', { id, field: k }); s.material = m; continue; }
    if (k === 'plane') { if (['xy', 'xz', 'yz'].includes(v)) s.plane = v; continue; }
    if (k === 'visible') { const src = String(v ?? '').trim(); if (!src) { delete s.visible; continue; } }
    if (['profile', 'path', 'axis'].includes(k)) { s[k] = copy(v); continue; }
    if (typeof v === 'number') { if (!Number.isFinite(v)) return err('fam.err.field', { id, field: k }); s[k] = formatNumber(v); continue; }
    const src = String(v ?? '').trim();
    if (!src) return err('fam.err.field', { id, field: k });
    const ps = parse(src, names(f));
    if (!ps.ok) return err('fam.err.unknown', { where: (s.name || id) + ' ' + k, why: ps.error });
    s[k] = src;
  }
  return checked(f);
}

// ======================================================================================================== hotspots
function freeHotId(fam) { const have = new Set([...fam.solids.map((s) => s.id), ...(fam.booleans || []).map((b) => b.id), ...(fam.parts || []).map((p) => p.id), ...(fam.hotspots || []).map((h) => h.id)]); for (let i = 1; ; i++) if (!have.has('h' + i)) return 'h' + i; }
/** A hotspot: a point (or an edge, from `at` to `to`) in the family's axes that drags the number parameter `drives` along `axis`. */
export function addHotspot(fam, { kind = 'point', axis = 'x', drives = '', at = null, to = null, name = '' } = {}) {
  if ((fam.hotspots || []).length >= LIMITS.hotspots) return err('fam.err.toomany', { what: 'hotspots', n: LIMITS.hotspots });
  const dragable = (p) => !p.formula && !isWordKind(p.kind) && p.kind !== 'yesno' && !p.instance;
  const cand = fam.params.find((p) => p.key === drives && dragable(p)) || fam.params.find(dragable);
  if (!cand) return err('fam.err.hotspot', { id: '' });
  const has = (k) => fam.params.some((p) => p.key === k && !isWordKind(p.kind));
  const W = has('Width') ? 'Width' : '300', D = has('Depth') ? 'Depth' : '300', H = has('Height') ? 'Height' : '300';
  const centred = fam.host !== 'wall';
  const dflt = axis === 'x' ? [centred ? `(${W} / 2)` : W, `(${D} / 2)`, `(${H} / 2)`] : axis === 'y' ? ['0', D, `(${H} / 2)`] : ['0', `(${D} / 2)`, H];
  const f = copy(fam), id = freeHotId(f);
  const h = { id, kind: kind === 'edge' ? 'edge' : 'point', axis: ['x', 'y', 'z'].includes(axis) ? axis : 'x', drives: cand.key, at: (at || dflt).map(String) };
  if (name) h.name = String(name).slice(0, 60);
  if (h.kind === 'edge') h.to = (to || [h.at[0], axis === 'y' ? '0' : h.at[1], axis === 'z' ? '0' : h.at[2]]).map(String);
  (f.hotspots ||= []).push(h);
  return { ...checked(f), id };
}
export function removeHotspot(fam, id) {
  if (!(fam.hotspots || []).some((h) => h.id === id)) return err('fam.err.hotspot', { id });
  const f = copy(fam);
  f.hotspots = f.hotspots.filter((h) => h.id !== id);
  if (!f.hotspots.length) delete f.hotspots;
  return checked(f);
}
export function setHotspot(fam, id, patch = {}) {
  const f = copy(fam), h = (f.hotspots || []).find((x) => x.id === id);
  if (!h) return err('fam.err.hotspot', { id });
  if (patch.name !== undefined) { const n = String(patch.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60); if (n) h.name = n; else delete h.name; }
  if (patch.kind !== undefined) { h.kind = patch.kind === 'edge' ? 'edge' : 'point'; if (h.kind === 'point') delete h.to; else h.to ||= [...h.at]; }
  if (patch.axis !== undefined && ['x', 'y', 'z'].includes(patch.axis)) h.axis = patch.axis;
  if (patch.drives !== undefined) h.drives = String(patch.drives);
  for (const k of ['at', 'to']) if (patch[k] !== undefined) {
    if (k === 'to' && h.kind !== 'edge') continue;
    const out = [];
    for (let i = 0; i < 3; i++) {
      const v = patch[k][i], src = typeof v === 'number' ? formatNumber(v) : String(v ?? '').trim();
      if (!src) return err('fam.err.field', { id, field: k });
      const ps = parse(src, names(f));
      if (!ps.ok) return err('fam.err.unknown', { where: 'hotspot ' + id + ' ' + k, why: ps.error });
      out.push(src);
    }
    h[k] = out;
  }
  return checked(f);
}
/**
 * Drag a hotspot to `to` ([x, y, z] in the family's axes): the number parameter it drives is solved so that the hotspot's position along its axis
 * is where it was dragged, through any formulas between them → { ok, values } (the size's values with that one changed, for the caller to place as
 * a size), or the error (a length that would not be positive, no value that gets there).
 */
export function dragHotspot(fam, values, id, to, ctx = {}) {
  const h = (fam.hotspots || []).find((x) => x.id === id);
  if (!h) return err('fam.err.hotspot', { id });
  const v = { ...sizeValues(fam, values) }, axis = 'xyz'.indexOf(h.axis), key = h.drives, p = fam.params.find((x) => x.key === key);
  if (!p) return err('fam.err.hotspot', { id });
  const src = h.at[axis], want = to[axis];
  if (!Number.isFinite(want)) return err('fam.err.handle');
  const g = (x) => fieldValue(fam, { ...v, [key]: x }, ctx, src);
  let x = solve1(g, v[key], want);
  if (x === null) return err('fam.err.handle');
  if (p.kind === 'integer') x = Math.round(x);
  if (p.kind === 'pen') x = Math.min(16, Math.max(1, Math.round(x)));
  if (p.kind === 'length' && !(x > 0)) return err('fam.err.handle');
  return { ok: true, values: { ...v, [key]: round3(x) }, key };
}

// ======================================================================================================== families inside (nested)
function freePartId(fam) { const have = new Set([...fam.solids.map((s) => s.id), ...(fam.booleans || []).map((b) => b.id), ...(fam.parts || []).map((p) => p.id)]); for (let i = 1; ; i++) if (!have.has('p' + i)) return 'p' + i; }
/** A family put inside this one: at (x, y, z) in this family's axes, turned in quarter turns, with the values this one gives its parameters. */
export function addPart(fam, familyKey, { at = ['0', '0', '0'], rot = '', values = {} } = {}) {
  if ((fam.parts || []).length >= LIMITS.parts) return err('fam.err.toomany', { what: 'parts', n: LIMITS.parts });
  if (typeof familyKey !== 'string' || familyKey === fam.key) return err('fam.err.nestcycle', { name: String(familyKey ?? '') });
  const f = copy(fam), id = freePartId(f);
  const p = { id, family: familyKey, at: at.map(String) };
  if (rot !== '' && rot !== undefined) p.rot = String(rot);
  if (Object.keys(values).length) p.values = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)]));
  f.parts = [...(f.parts || []), p];
  return { ...checked(f), id };
}
export function removePart(fam, id) {
  if (!(fam.parts || []).some((p) => p.id === id)) return err('fam.err.part', { id });
  const f = copy(fam);
  f.parts = f.parts.filter((p) => p.id !== id);
  if (!f.parts.length) delete f.parts;
  if (!f.solids.length && !f.parts) return err('fam.err.nosolids');
  return checked(f);
}
/** Change a part: at [x, y, z], rot, visible ('' removes), family (another key), values { Param: number | expression | word | '' to drop }. */
export function setPart(fam, id, patch = {}) {
  const f = copy(fam), p = (f.parts || []).find((x) => x.id === id);
  if (!p) return err('fam.err.part', { id });
  const expr = (k, v, optional) => {
    const src = typeof v === 'number' ? formatNumber(v) : String(v ?? '').trim();
    if (!src) { if (optional) return null; return false; }
    const ps = parse(src, names(f));
    if (!ps.ok) return { bad: err('fam.err.unknown', { where: 'part ' + id + ' ' + k, why: ps.error }) };
    return src;
  };
  if (patch.family !== undefined) { if (typeof patch.family !== 'string' || patch.family === f.key) return err('fam.err.nestcycle', { name: id }); p.family = patch.family; }
  if (patch.at !== undefined) {
    const at = [];
    for (let i = 0; i < 3; i++) { const v = expr('at ' + 'xyz'[i], patch.at[i], false); if (v === false) return err('fam.err.field', { id, field: 'at' }); if (v?.bad) return v.bad; at.push(v); }
    p.at = at;
  }
  for (const k of ['rot', 'visible']) if (patch[k] !== undefined) { const v = expr(k, patch[k], true); if (v?.bad) return v.bad; if (v === null) delete p[k]; else p[k] = v; }
  if (patch.values !== undefined) {
    for (const [name, v] of Object.entries(patch.values)) {
      const src = typeof v === 'number' ? formatNumber(v) : String(v ?? '').trim();
      if (!src) { if (p.values) delete p.values[name]; continue; }
      if (!NAME_RE.test(name)) return err('fam.err.param', { name });
      (p.values ||= {})[name] = src;
    }
    if (p.values && !Object.keys(p.values).length) delete p.values;
  }
  return checked(f);
}

// ======================================================================================================== the 2D symbol
/** A free symbol part id: "y1", "y2" … */
function freeSymId(fam) { const have = new Set((fam.symbol?.parts || []).map((p) => p.id)); for (let i = 1; ; i++) if (!have.has('y' + i)) return 'y' + i; }
/** Where a new part starts: inside the family's footprint (Width × Depth when it has them, else 300 mm). */
function symFrame(fam) {
  const has = (k) => fam.params.some((p) => p.key === k && !isWordKind(p.kind));
  return { W: has('Width') ? 'Width' : '300', D: has('Depth') ? 'Depth' : '300' };
}
export function addSymbolPart(fam, kind = 'rect') {
  if (!SYMBOL_KINDS.includes(kind)) return err('fam.err.sympart', { id: String(kind) });
  if ((fam.symbol?.parts || []).length >= SYMBOL_LIMITS.parts) return err('fam.err.toomany', { what: 'symbols', n: SYMBOL_LIMITS.parts });
  const f = copy(fam), id = freeSymId(f), F = symFrame(f);
  const half = `(-${F.W} / 2)`, halfp = `(${F.W} / 2)`;
  const part = kind === 'rect' ? { id, kind, x0: half, y0: '0', x1: halfp, y1: F.D, fill: 'none' }
    : kind === 'line' ? { id, kind, x0: half, y0: '0', x1: halfp, y1: F.D }
    : kind === 'circle' ? { id, kind, cx: '0', cy: `(${F.D} / 2)`, r: `(${F.D} / 4)`, fill: 'none' }
    : kind === 'arc' ? { id, kind, cx: '0', cy: '0', r: `(${F.D} / 2)`, a0: '0', a1: '90' }
    : kind === 'poly' ? { id, kind, pts: [[half, '0'], [halfp, '0'], ['0', F.D]], closed: true, fill: 'none' }
    : { id, kind, x: '0', y: `(${F.D} / 2)`, h: '100', text: 'Text' };
  f.symbol = { mode: f.symbol?.mode || 'symbol', parts: [...(f.symbol?.parts || []), part] };
  return { ...checked(f), id };
}
export function removeSymbolPart(fam, id) {
  if (!(fam.symbol?.parts || []).some((p) => p.id === id)) return err('fam.err.sympart', { id });
  const f = copy(fam);
  f.symbol.parts = f.symbol.parts.filter((p) => p.id !== id);
  if (!f.symbol.parts.length) delete f.symbol;
  return checked(f);
}
export function duplicateSymbolPart(fam, id) {
  const p = (fam.symbol?.parts || []).find((x) => x.id === id);
  if (!p) return err('fam.err.sympart', { id });
  if (fam.symbol.parts.length >= SYMBOL_LIMITS.parts) return err('fam.err.toomany', { what: 'symbols', n: SYMBOL_LIMITS.parts });
  const f = copy(fam), nid = freeSymId(f);
  f.symbol.parts.splice(f.symbol.parts.findIndex((x) => x.id === id) + 1, 0, { ...copy(p), id: nid });
  return { ...checked(f), id: nid };
}
/** Change a part: expression fields (text or number; '' removes pen / fill / visible / zmin / zmax / rot), fill, text, closed, pts. */
export function setSymbolPart(fam, id, patch = {}) {
  const f = copy(fam), p = (f.symbol?.parts || []).find((x) => x.id === id);
  if (!p) return err('fam.err.sympart', { id });
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'fill') { const s = String(v ?? '').trim(); if (!s || s === 'none') { p.fill = 'none'; continue; } if (!SYM_FILLS.includes(s) && !/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(s)) return err('fam.err.symfield', { id, field: k }); p.fill = s; continue; }
    if (k === 'text') { const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, SYMBOL_LIMITS.text); if (!s.trim()) return err('fam.err.symfield', { id, field: k }); p.text = s; continue; }
    if (k === 'closed') { p.closed = !!v; continue; }
    if (k === 'detail') { if (v === 'medium' || v === 'fine') p.detail = v; else delete p.detail; continue; }
    if (k === 'pts') { p.pts = copy(v); continue; }
    const optional = ['visible', 'pen', 'zmin', 'zmax', 'rot'].includes(k);
    const src = typeof v === 'number' ? formatNumber(v) : String(v ?? '').trim();
    if (!src) { if (optional) { delete p[k]; continue; } return err('fam.err.symfield', { id, field: k }); }
    if (!optional && !(SYMBOL_FIELDS[p.kind] || []).includes(k)) return err('fam.err.symfield', { id, field: k });
    const ps = parse(src, names(f));
    if (!ps.ok) return err('fam.err.unknown', { where: 'symbol ' + id + ' ' + k, why: ps.error });
    p[k] = src;
  }
  return checked(f);
}
/** Repeat a symbol part: { count, dx, dy } or null. */
export function setSymbolArray(fam, id, spec) {
  const f = copy(fam), p = (f.symbol?.parts || []).find((x) => x.id === id);
  if (!p) return err('fam.err.sympart', { id });
  if (spec === null || spec === undefined) { delete p.array; return checked(f); }
  const a = {};
  for (const k of ['count', 'dx', 'dy']) {
    const v = spec[k], src = typeof v === 'number' ? formatNumber(v) : String(v ?? (k === 'count' ? '' : '0')).trim() || (k === 'count' ? '' : '0');
    if (!src) return err('fam.err.symfield', { id, field: 'array ' + k });
    const ps = parse(src, names(f));
    if (!ps.ok) return err('fam.err.unknown', { where: 'symbol ' + id + ' array ' + k, why: ps.error });
    a[k] = src;
  }
  p.array = a;
  return checked(f);
}
/** The symbol drawn in the plan ('symbol') or the cut of the solids ('cut'). */
export function setSymbolMode(fam, mode) {
  if (!fam.symbol) return err('fam.err.sympart', { id: '' });
  const f = copy(fam); f.symbol.mode = mode === 'cut' ? 'cut' : 'symbol';
  return checked(f);
}
/** Move a point of a poly part (symbol axes, mm). */
export function moveSymbolPoint(fam, id, i, [x, y]) {
  const f = copy(fam), p = (f.symbol?.parts || []).find((q) => q.id === id);
  if (!p || p.kind !== 'poly' || !p.pts[i]) return err('fam.err.sympart', { id });
  p.pts[i] = [formatNumber(x), formatNumber(y)];
  return checked(f);
}

/** Repeat a solid: { count, dx, dy, dz } (numbers or expressions; count a whole number of 1–200, the steps in the family's axes), or null for one solid. */
export function setSolidArray(fam, id, spec) {
  const f = copy(fam), s = f.solids.find((x) => x.id === id);
  if (!s) return err('fam.err.solid', { id });
  if (spec === null || spec === undefined) { delete s.array; return checked(f); }
  const a = {};
  for (const k of ['count', 'dx', 'dy', 'dz']) {
    const v = spec[k];
    const src = typeof v === 'number' ? formatNumber(v) : String(v ?? (k === 'count' ? '' : '0')).trim() || (k === 'count' ? '' : '0');
    if (!src) return err('fam.err.field', { id, field: 'array ' + k });
    const ps = parse(src, names(f));
    if (!ps.ok) return err('fam.err.unknown', { where: (s.name || id) + ' array ' + k, why: ps.error });
    a[k] = src;
  }
  s.array = a;
  const r = checked(f);
  if (r.ok) { const ev = evaluateFamily(r.fam, {}, { wallThickness: 140 }); if (!ev.ok && ev.error.key === 'fam.err.arraycount') return { ok: false, error: ev.error, fam: f }; }
  return r;
}

// ======================================================================================================== Booleans
/** Solids and Booleans not yet used as an operand (what a new Boolean may take), in the recipe's order. */
export function operands(fam, exceptId = null) {
  const used = new Set();
  for (const b of fam.booleans || []) if (b.id !== exceptId) { used.add(b.a); used.add(b.b); }
  const before = exceptId ? (fam.booleans || []).slice(0, (fam.booleans || []).findIndex((b) => b.id === exceptId)).map((b) => b.id) : (fam.booleans || []).map((b) => b.id);
  return [...fam.solids.map((s) => s.id), ...before].filter((x) => !used.has(x));
}
export function addBoolean(fam, { op = 'difference', a, b } = {}) {
  if ((fam.booleans || []).length >= LIMITS.booleans) return err('fam.err.toomany', { what: 'booleans', n: LIMITS.booleans });
  const free = operands(fam);
  const A = a ?? free[0], B = b ?? free.find((x) => x !== A);
  if (!A || !B || A === B || !free.includes(A) || !free.includes(B)) return err('fam.err.nooperand');
  const f = copy(fam), id = freeId(f, 'b');
  f.booleans = [...(f.booleans || []), { id, op: op === 'union' ? 'union' : 'difference', a: A, b: B }];
  return { ...checked(f), id };
}
export function removeBoolean(fam, id) {
  if (!(fam.booleans || []).some((b) => b.id === id)) return err('fam.err.boolean', { id });
  // a Boolean another one takes as its operand goes with it (the other keeps nothing to cut)
  const f = copy(fam), gone = new Set([id]);
  let more = true;
  while (more) { more = false; for (const b of f.booleans) if (!gone.has(b.id) && (gone.has(b.a) || gone.has(b.b))) { gone.add(b.id); more = true; } }
  f.booleans = f.booleans.filter((b) => !gone.has(b.id));
  return checked(f);
}
export function setBoolean(fam, id, patch = {}) {
  const f = copy(fam), b = (f.booleans || []).find((x) => x.id === id);
  if (!b) return err('fam.err.boolean', { id });
  if (patch.op) b.op = patch.op === 'union' ? 'union' : 'difference';
  const free = new Set([...operands(fam, id)]);
  for (const k of ['a', 'b']) if (patch[k] !== undefined) { if (!free.has(patch[k]) && patch[k] !== b[k]) return err('fam.err.boolean', { id }); b[k] = patch[k]; }
  if (b.a === b.b) return err('fam.err.boolean', { id });
  return checked(f);
}

// ======================================================================================================== connectors
const freeConnectorId = (fam) => { const have = new Set((fam.connectors || []).map((c) => c.id)); for (let i = 1; ; i++) if (!have.has('c' + i)) return 'c' + i; };
/** A new connector at the family's origin, pointing down (a drain) for a pipe, up for a duct. */
export function addConnector(fam, { domain = 'pipe', system = '' } = {}) {
  if (fam.host === 'wall') return err('fam.err.connhosted');
  if (!CONNECTOR_DOMAINS.includes(domain)) return err('fam.err.connector', { id: String(domain) });
  if ((fam.connectors || []).length >= LIMITS.connectors) return err('fam.err.toomany', { what: 'connectors', n: LIMITS.connectors });
  const f = copy(fam), id = freeConnectorId(f);
  const c = domain === 'pipe' ? { id, domain, system: system || 'cw', x: '0', y: '0', z: '0', dir: '-z', size: '20', flow: 'in' }
    : { id, domain, system: system || 'supply', x: '0', y: '0', z: '0', dir: '+z', size: '150', flow: 'in' };
  f.connectors = [...(f.connectors || []), c];
  return { ...checked(f), id };
}
export function setFixture(fam, kind) {
  const f = copy(fam);
  if (kind) f.fixture = kind; else delete f.fixture;
  return checked(f);
}
export function removeConnector(fam, id) {
  if (!(fam.connectors || []).some((c) => c.id === id)) return err('fam.err.connector', { id });
  const f = copy(fam);
  f.connectors = f.connectors.filter((c) => c.id !== id);
  if (!f.connectors.length) delete f.connectors;
  return checked(f);
}
/** Change a connector: name, domain, system, dir, flow, and x, y, z, size (numbers or expressions of the parameters). */
export function setConnector(fam, id, patch = {}) {
  const f = copy(fam), c = (f.connectors || []).find((x) => x.id === id);
  if (!c) return err('fam.err.connector', { id });
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'name') { const n = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 60); if (n) c.name = n; else delete c.name; continue; }
    if (k === 'domain') { if (!CONNECTOR_DOMAINS.includes(v)) return err('fam.err.connfield', { id, field: k }); c.domain = v; continue; }
    if (k === 'dir') { if (!CONNECTOR_DIRS[v]) return err('fam.err.connfield', { id, field: k }); c.dir = v; continue; }
    if (k === 'flow') { c.flow = v === 'out' ? 'out' : 'in'; continue; }
    if (k === 'system') { c.system = String(v ?? ''); continue; }
    if (!CONNECTOR_FIELDS.includes(k)) continue;
    if (typeof v === 'number') { if (!Number.isFinite(v)) return err('fam.err.connfield', { id, field: k }); c[k] = formatNumber(v); continue; }
    const src = String(v ?? '').trim();
    if (!src) return err('fam.err.connfield', { id, field: k });
    const ps = parse(src, names(f));
    if (!ps.ok) return err('fam.err.unknown', { where: (c.name || id) + ' ' + k, why: ps.error });
    c[k] = src;
  }
  return checked(f);
}

// ======================================================================================================== profiles and paths
/** The points the sketch edits: a profile's [u, v, bulge?] (extrude / revolve) or a path's [x, y, z] (sweep, x and y drawn). */
export const pointsOf = (s) => (s.op === 'sweep' ? s.path : s.profile) || [];
const ptsKey = (s) => (s.op === 'sweep' ? 'path' : 'profile');
export const snap = (v, step) => (step > 0 ? Math.round(v / step) * step : v);
/** Quarter arcs: bulge = tan(90° / 4). */
export const QUARTER = Math.tan(Math.PI / 8);
export function cycleArc(b) { const x = Number(b) || 0; return x === 0 ? round12(QUARTER) : x > 0 ? round12(-QUARTER) : 0; }
const round12 = (x) => Math.round(x * 1e12) / 1e12;

function editPoints(fam, id, fn) {
  const f = copy(fam), s = f.solids.find((x) => x.id === id);
  if (!s || s.op === 'box') return err('fam.err.solid', { id });
  const pts = pointsOf(s);
  const r = fn(pts, s);
  if (r) return r;
  s[ptsKey(s)] = pts;
  return checked(f);
}
/** A point moved to (u, v) (a path point keeps its z). A point bound to parameters is refused (change it in the table). */
export function movePoint(fam, id, i, [u, v]) {
  return editPoints(fam, id, (pts) => {
    const p = pts[i];
    if (!p) return err('fam.err.points', { id });
    if (literal(p[0]) === null || literal(p[1]) === null) return err('fam.err.bound');
    p[0] = formatNumber(u); p[1] = formatNumber(v);
    return null;
  });
}
/** A point put after point i (−1 = first). */
export function insertPoint(fam, id, i, [u, v]) {
  return editPoints(fam, id, (pts, s) => {
    if (pts.length >= LIMITS.points) return err('fam.err.toomany', { what: 'points', n: LIMITS.points });
    const p = s.op === 'sweep' ? [formatNumber(u), formatNumber(v), pts[Math.max(0, i)]?.[2] ?? '0'] : [formatNumber(u), formatNumber(v)];
    pts.splice(i + 1, 0, p);
    return null;
  });
}
export function removePoint(fam, id, i) {
  return editPoints(fam, id, (pts, s) => {
    if (!pts[i]) return err('fam.err.points', { id });
    if (pts.length <= (s.op === 'sweep' ? 2 : 3)) return err('fam.err.points', { id });
    pts.splice(i, 1);
    return null;
  });
}
/** The segment from point i to the next one: straight (0) or an arc (bulge = tan(angle / 4); + bulges to the left). */
export function setBulge(fam, id, i, b) {
  return editPoints(fam, id, (pts, s) => {
    if (s.op === 'sweep' || !pts[i]) return err('fam.err.points', { id });
    const x = round12(Number(b) || 0);
    if (Math.abs(x) > 10) return err('fam.err.points', { id });
    if (x) pts[i][2] = x; else pts[i].length = 2;
    return null;
  });
}

// ======================================================================================================== handles
/** The family's visible solids' bounds (x0, y0, z0, x1, y1, z1), or null. */
export function boundsOf(ev) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const s of ev.solids.values()) {
    if (!s.visible) continue;
    const z = solidZ(s), p = planBounds(s);
    if (!p) continue;
    b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[3] = Math.max(b[3], p[2]); b[4] = Math.max(b[4], p[3]);
    b[2] = Math.min(b[2], z[0]); b[5] = Math.max(b[5], z[1]);
  }
  return Number.isFinite(b[0]) ? b : null;
}
/** A solid's height range (z0, z1). */
function solidZ(s) {
  if (s.op === 'box') return [s.box[2], s.box[5]];
  if (s.op === 'sweep') { const zs = s.path.map((p) => p[2]); return [Math.min(...zs) - s.radius, Math.max(...zs) + s.radius]; }
  const vs = s.profile.map((p) => (s.plane === 'xy' ? s.at : p[1]));
  if (s.op === 'extrude' && s.plane === 'xy') return [s.at, s.at + s.depth];
  if (s.op === 'revolve' && s.plane === 'xy') { const r = Math.max(...s.profile.map((p) => Math.hypot(p[0], p[1]))); return [s.at - r, s.at + r]; }
  return [Math.min(...vs), Math.max(...vs)];
}
const AX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** Handles for the size: one per input length parameter that pushes a face of the family out, at the middle of that face
 *  (Width → +x, Depth → +y, Height → +z for a table; a door's Width at its right jamb, Height at its head). */
export function sizeHandles(fam, values, ctx = {}) {
  const ev = evaluateFamily(fam, values, ctx);
  if (!ev.ok) return [];
  const B = boundsOf(ev);
  if (!B) return [];
  const out = [], taken = new Set();
  const lens = inputParams(fam).filter((p) => p.kind === 'length');
  // the parameter that moves each face the most (a 10 mm nudge), named ones first
  const order = [...lens].sort((a, b) => rank(a.key) - rank(b.key));
  for (const p of order) {
    const v = sizeValues(fam, values), e2 = evaluateFamily(fam, { ...v, [p.key]: v[p.key] + 10 }, ctx);
    if (!e2.ok) continue;
    const B2 = boundsOf(e2);
    if (!B2) continue;
    let best = -1, bd = 0.5;
    for (let a = 0; a < 3; a++) { const d = B2[a + 3] - B[a + 3]; if (d > bd && !taken.has(a)) { bd = d; best = a; } }
    if (best < 0) continue;
    taken.add(best);
    const c = [(B[0] + B[3]) / 2, (B[1] + B[4]) / 2, (B[2] + B[5]) / 2];
    c[best] = B[best + 3];
    out.push({ p: c, axis: AX[best], label: p.label || p.key, target: { kind: 'size', key: p.key, axis: best } });
    if (taken.size === 3) break;
  }
  return out;
}
const rank = (k) => ({ Width: 0, Depth: 1, Height: 2 }[k] ?? 3);

/** Handles for one solid: a box's six faces; an extrusion's far end (its depth) and its start (at). */
export function solidHandles(fam, values, id, ctx = {}) {
  const ev = evaluateFamily(fam, values, ctx);
  if (!ev.ok) return [];
  const s = ev.solids.get(id), raw = fam.solids.find((x) => x.id === id);
  if (!s || !raw || !s.visible) return [];
  const out = [];
  if (s.op === 'box') {
    const b = s.box, c = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
    for (let a = 0; a < 3; a++) for (const hi of [0, 1]) {
      const p = c.slice(); p[a] = b[a + hi * 3];
      // the field that holds this face: x0 / x1 are sorted by the evaluator, so find the one whose value is here
      const k0 = 'xyz'[a] + '0', k1 = 'xyz'[a] + '1';
      const v0 = fieldValue(fam, values, ctx, raw[k0]);
      const field = Math.abs(v0 - b[a + hi * 3]) < 1e-6 ? k0 : k1;
      out.push({ p, axis: AX[a].map((x) => (hi ? x : -x)), label: (raw.name || id) + ' ' + field, target: { kind: 'field', id, field, axis: a } });
    }
  } else if (s.op === 'extrude') {
    const n = s.plane === 'xy' ? 2 : s.plane === 'xz' ? 1 : 0;
    const pb = planBounds(s), z = solidZ(s);
    const c = [(pb[0] + pb[2]) / 2, (pb[1] + pb[3]) / 2, (z[0] + z[1]) / 2];
    const end = c.slice(); end[n] = s.at + s.depth;
    const start = c.slice(); start[n] = s.at;
    out.push({ p: end, axis: AX[n], label: (raw.name || id) + ' depth', target: { kind: 'field', id, field: 'depth', axis: n, base: s.at } });
    out.push({ p: start, axis: AX[n].map((x) => -x), label: (raw.name || id) + ' at', target: { kind: 'field', id, field: 'at', axis: n } });
  }
  return out;
}
/** A field's value for these values (NaN when it does not evaluate). */
function fieldValue(fam, values, ctx, src) {
  const ev = evaluateFamily(fam, values, ctx);
  if (!ev.ok) return NaN;
  const p = parse(String(src ?? ''));
  if (!p.ok) return NaN;
  try { return evaluate(p.ast, ev.values); } catch (e) { return NaN; }
}
/** The input parameters a field depends on, through the formulas of driven ones. */
export function inputsOf(fam, src) {
  const p = parse(String(src ?? ''));
  if (!p.ok) return [];
  const inputs = new Set(inputParams(fam).map((q) => q.key)), out = new Set(), seen = new Set();
  const walk = (nm) => {
    if (seen.has(nm)) return; seen.add(nm);
    if (inputs.has(nm)) { out.add(nm); return; }
    const q = fam.params.find((x) => x.key === nm);
    if (q?.formula) { const r = parse(q.formula); if (r.ok) r.uses.forEach(walk); }
  };
  p.uses.forEach(walk);
  return [...out];
}
/** Solve g(x) = target for x near x0 (secant, then a bracket and bisection). */
export function solve1(g, x0, target) {
  const f = (x) => { const y = g(x); return Number.isFinite(y) ? y - target : NaN; };
  let a = x0, fa = f(a);
  if (Number.isFinite(fa) && Math.abs(fa) < 1e-7) return a;
  let b = x0 + Math.max(1, Math.abs(x0) * 0.01), fb = f(b);
  for (let k = 0; k < 40 && Number.isFinite(fa) && Number.isFinite(fb) && fb !== fa; k++) {
    const c = b - fb * (b - a) / (fb - fa), fc = f(c);
    if (Number.isFinite(fc) && Math.abs(fc) < 1e-7) return c;
    a = b; fa = fb; b = c; fb = fc;
  }
  const g0 = f(x0);
  for (let step = 1; step < 1e7; step *= 2) for (const s of [x0 + step, x0 - step]) {
    const gs = f(s);
    if (Number.isFinite(g0) && Number.isFinite(gs) && Math.sign(gs) !== Math.sign(g0)) {
      let lo = x0, hi = s, glo = g0;
      for (let k = 0; k < 200; k++) {
        const mid = (lo + hi) / 2, gm = f(mid);
        if (!Number.isFinite(gm)) break;
        if (Math.abs(gm) < 1e-7 || Math.abs(hi - lo) < 1e-9) return mid;
        if (Math.sign(gm) === Math.sign(glo)) { lo = mid; glo = gm; } else hi = mid;
      }
    }
  }
  return null;
}
/** Drag a handle so its face lands at `to` (mm along the handle's axis line: the coordinate on that axis). */
/** The hotspots as handles for the preview: [{ p, axis (a unit vector), label, target: { kind: 'hotspot', id } }]. */
export function hotspotHandles(fam, values, ctx = {}) {
  const ev = evaluateFamily(fam, values, ctx);
  if (!ev.ok) return [];
  return (ev.hotspots || []).map((h) => {
    const p = h.kind === 'edge' && h.q ? h.p.map((x, i) => (x + h.q[i]) / 2) : h.p;   // an edge's handle sits at its middle
    return { p, axis: AX['xyz'.indexOf(h.axis)], label: h.name || h.id, target: { kind: 'hotspot', id: h.id } };
  });
}
export function dragHandle(fam, values, h, to, ctx = {}) {
  const v = sizeValues(fam, values), T = h.target;
  if (T.kind === 'hotspot') {   // `to` is where along the hotspot's own axis it was dragged
    const hs = (fam.hotspots || []).find((x) => x.id === T.id);
    if (!hs) return err('fam.err.hotspot', { id: T.id });
    const vec = [0, 0, 0];
    vec['xyz'.indexOf(hs.axis)] = to;
    const r = dragHotspot(fam, values, T.id, vec, ctx);
    return r.ok ? { ok: true, fam, values: { ...fullValues(fam, values), ...r.values } } : r;
  }
  // the parameter named for the handle's axis (Width for x, Depth for y, Height for z) when the field uses it, else the first
  const pick = (cands) => cands.find((k) => rank(k) === T.axis) || [...cands].sort((a, b) => rank(a) - rank(b))[0];
  if (T.kind === 'size') {
    const g = (x) => { const e = evaluateFamily(fam, { ...v, [T.key]: x }, ctx); const B = e.ok ? boundsOf(e) : null; return B ? B[T.axis + 3] : NaN; };
    const x = solve1(g, v[T.key], to);
    if (x === null || !(x > 0)) return err('fam.err.handle');
    return { ok: true, fam, values: { ...v, [T.key]: round3(x) } };
  }
  const raw = fam.solids.find((s) => s.id === T.id);
  if (!raw) return err('fam.err.solid', { id: T.id });
  const want = T.field === 'depth' ? to - (T.base ?? 0) : to;
  const src = raw[T.field];
  if (literal(src) !== null) {
    const r = setSolid(fam, T.id, { [T.field]: round3(want) });
    return r.ok ? { ok: true, fam: r.fam, values: v } : r;
  }
  const ins = inputsOf(fam, src);
  if (!ins.length) return err('fam.err.handle');
  const key = pick(ins);
  const g = (x) => fieldValue(fam, { ...v, [key]: x }, ctx, src);
  const x = solve1(g, v[key], want);
  if (x === null) return err('fam.err.handle');
  const p = inputParams(fam).find((q) => q.key === key);
  if (p.kind === 'length' && !(x > 0)) return err('fam.err.handle');
  return { ok: true, fam, values: { ...v, [key]: round3(x) } };
}
const round3 = (x) => Math.round(x * 1000) / 1000;
