/* SPDX-License-Identifier: Apache-2.0 */
/**
 * clipboard.js — what Copy, Paste and Duplicate carry in BimCraft. No DOM: bin/test-bimcraft.mjs --clipboard runs it.
 *
 * What copy and paste mean here (owner's brief, 2026-10-11):
 *   - a placed library item (an element with the CadCraft_Placement pset, ifc-place.js) is copied as a *placement clip*:
 *     which item it is (uuid@version or sha:<sha256>), its place, storey, item number, quantity, notes, the box the ghost
 *     shows, and — when this tab still has it — the library item itself. Paste places the same item again
 *     (IfcEditor.placeLike in the model it came from; IfcEditor.placeItem with the kept item in any other model).
 *   - any other element, or several elements, is copied as an *elements clip* (0.4 B1): which elements, where (an anchor
 *     point and the box round them, for the ghost) and whether it was a Cut. The geometry is NOT in the clip: the page
 *     keeps IfcEditor.snapshot() in memory, so these paste only into the model they came from, in the same tab
 *     (ifc-elements.js). Their names and properties also go to the system clipboard as text (elementText).
 *   - kind 'element' (one element as text only) is what builds before 0.4 wrote; it is still read, and says so.
 * The clip lives in memory and in localStorage "bimcraft.clipboard" (another tab can paste); everything read back from
 * storage goes through validateClip — it is untrusted input like a file.
 *
 *   placementClip(p, ctx)  elementClip(p, ctx)  elementsClip(list, ctx)  validateClip(obj)  readClip(storage)  writeClip(storage, clip)
 *   libKey(p)  boxFromItem(item)  boxFromEquipment(eq, unitMm)  ghostItem(clip)  besideSpot(clip)  pickStorey(clip, storeys, same)
 *   pasteMove(clip, at)  an elements clip → IfcEditor.pasteElements opts { dx, dy, rot (the turn BY), about }
 *   elementText(p)   the text Copy puts on the system clipboard for any element (IfcModel.properties() shape)
 */
import { validateItem, planBounds } from './libitem.js';
import { t } from "./i18n.js";
import { tableCsv } from "./ifc-qto.js";

export const CLIP_KEY = 'bimcraft.clipboard';
export const CLIP_FORMAT = 'bimcraft-clipboard';
export const CLIP_VERSION = 1;
export const GAP_MM = 100;   // paste in place beside the original: this much clear space between them

const MAX = { name: 255, file: 255, number: 40, notes: 200, key: 120, model: 64, cls: 64, guid: 64, library: 40, ids: 50000 };
const cut = (s, n) => String(s ?? '').slice(0, n);

/** The library key a placement's type is found by (ifc-place.js typeFor): "uuid@version[#variant]" or "sha:<sha256>". */
/** A placement's variant as the clip keeps it ({ id, name, values } with plain values), or null when it is not one. */
function variantMeta(v) {
  if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !/^[A-Za-z0-9_.-]{1,60}$/.test(v.id)) return null;
  const values = {};
  for (const [k, x] of Object.entries(v.values && typeof v.values === 'object' ? v.values : {}).slice(0, 24)) if (typeof x === 'number' || typeof x === 'string') values[String(k).slice(0, 80)] = typeof x === 'string' ? x.slice(0, 200) : x;
  return { id: v.id, name: String(v.name ?? v.id).slice(0, 200), values };
}

export function libKey(p) {
  return p.uuid ? p.uuid + '@' + p.version + (p.variant ? '#' + p.variant : '') : 'sha:' + (p.sha256 || '');   // 0.7 W3.19: "#variant" for an item with variants
}

/**
 * A placement clip from IfcPlacer.placements() row `p`.
 * ctx: { model (this open model's session tag), file, storeyName, storeyElevation, item, meta, box, now }
 */
export function placementClip(p, ctx = {}) {
  return {
    format: CLIP_FORMAT, version: CLIP_VERSION, kind: 'placement',
    copiedAt: ctx.now || new Date().toISOString(),
    model: cut(ctx.model, MAX.model), file: cut(ctx.file, MAX.file),
    id: p.id, key: libKey(p), name: cut(p.equipment?.Name || p.name || t('clip.name.libitem'), MAX.name),
    itemNumber: cut(p.itemNumber, MAX.number), quantity: Math.max(1, Math.round(Number(p.quantity) || 1)), notes: cut(p.notes, MAX.notes),
    storey: Number.isInteger(p.storey) && p.storey > 0 ? p.storey : null,
    storeyName: cut(ctx.storeyName, MAX.name), storeyElevation: Number.isFinite(ctx.storeyElevation) ? ctx.storeyElevation : null,
    x: p.x, y: p.y, rot: p.rot,
    box: ctx.box || null,
    item: ctx.item || null,
    meta: ctx.meta ? { library: cut(ctx.meta.library, MAX.library), sha256: cut(ctx.meta.sha256, 64), sourceFile: cut(ctx.meta.sourceFile, MAX.file), ...(ctx.meta.variant ? { variant: variantMeta(ctx.meta.variant) } : {}) } : null,
  };
}

/** A clip for any other element: what it was, for the message Paste gives. Its text goes to the system clipboard. */
export function elementClip(p, ctx = {}) {
  return {
    format: CLIP_FORMAT, version: CLIP_VERSION, kind: 'element',
    copiedAt: ctx.now || new Date().toISOString(),
    model: cut(ctx.model, MAX.model), file: cut(ctx.file, MAX.file),
    id: p.id, name: cut(p.name || t('clip.unnamed'), MAX.name), cls: cut(p.cls, MAX.cls), guid: cut(p.guid, MAX.guid),
  };
}

/**
 * A clip for elements copied or cut in this model: list = [{ id, name, cls, guid }] (the elements asked for).
 * ctx: { model, file, now, storey, storeyName, storeyElevation, x, y (anchor, model mm), rot (degrees: the axes `box` is
 * measured in — IfcEditor.snapshot().frame, turned like the element, so a door in a building turned in its site gets a
 * ghost the shape of the door, not of its box along the model's axes), box (round the anchor, mm), cut }
 */
export function elementsClip(list, ctx = {}) {
  const first = list[0] || {};
  return {
    format: CLIP_FORMAT, version: CLIP_VERSION, kind: 'elements',
    copiedAt: ctx.now || new Date().toISOString(),
    model: cut(ctx.model, MAX.model), file: cut(ctx.file, MAX.file),
    id: first.id, ids: list.map((e) => e.id).slice(0, MAX.ids), count: list.length,
    name: cut(first.name || t('clip.unnamed'), MAX.name), cls: cut(first.cls, MAX.cls), guid: cut(first.guid, MAX.guid),
    storey: Number.isInteger(ctx.storey) && ctx.storey > 0 ? ctx.storey : null,
    storeyName: cut(ctx.storeyName, MAX.name), storeyElevation: Number.isFinite(ctx.storeyElevation) ? ctx.storeyElevation : null,
    x: ctx.x ?? 0, y: ctx.y ?? 0, rot: Number.isFinite(ctx.rot) ? ((ctx.rot % 360) + 360) % 360 : 0, box: ctx.box || null, cut: !!ctx.cut,
  };
}

/**
 * Where an elements clip goes: `at` = { x, y, rot } from the placing bar / ghost / wall snap (rot = the turn the ghost
 * shows, in model axes, as for a library item). The snapshot is still turned clip.rot, so it is turned BY the
 * difference; the anchor lands on at.x, at.y. → { dx, dy, rot, about } for IfcEditor.pasteElements.
 */
export function pasteMove(clip, at) {
  let rot = (Number(at.rot) || 0) - (Number(clip.rot) || 0);
  rot = ((rot % 360) + 360) % 360;
  if (Math.abs(rot - 360) < 1e-9) rot = 0;
  return { dx: at.x - clip.x, dy: at.y - clip.y, rot, about: [clip.x, clip.y] };
}

/**
 * Check a clip (from storage, so untrusted). → { ok, clip, errors, notes }: `clip` holds only known, checked fields.
 * A library item that fails validateItem is dropped (noted), not trusted; the rest of the clip still works in the
 * model it came from.
 */
export function validateClip(obj) {
  const errors = [], notes = [];
  const bad = (m) => { errors.push(m); };
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, clip: null, errors: ['not a clip'], notes };   // i18n-ignore: error code, like 'format' and 'version' below
  if (obj.format !== CLIP_FORMAT) bad('format');
  if (obj.version !== CLIP_VERSION) bad('version');
  if (obj.kind !== 'placement' && obj.kind !== 'element' && obj.kind !== 'elements') bad('kind');
  const str = (k, max, re = null) => {
    const v = obj[k];
    if (typeof v !== 'string' || v.length > max || (re && !re.test(v))) { bad(k); return ''; }
    return v;
  };
  const fin = (v, lim = 1e9) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;
  const out = { format: CLIP_FORMAT, version: CLIP_VERSION, kind: obj.kind };
  out.copiedAt = str('copiedAt', 40, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  out.model = str('model', MAX.model, /^[A-Za-z0-9-]*$/);
  out.file = str('file', MAX.file);
  if (!Number.isInteger(obj.id) || obj.id <= 0) bad('id'); else out.id = obj.id;
  out.name = str('name', MAX.name);
  const place = () => {
    if (obj.storey === null) out.storey = null; else if (Number.isInteger(obj.storey) && obj.storey > 0) out.storey = obj.storey; else bad('storey');
    out.storeyName = str('storeyName', MAX.name);
    if (obj.storeyElevation === null) out.storeyElevation = null; else if (fin(obj.storeyElevation)) out.storeyElevation = obj.storeyElevation; else bad('storeyElevation');
    for (const k of ['x', 'y']) { if (fin(obj[k])) out[k] = obj[k]; else bad(k); }
    if (fin(obj.rot, 1e6)) out.rot = obj.rot; else bad('rot');
    out.box = null;
    if (obj.box !== null && obj.box !== undefined) {
      const b = obj.box;
      const ks = ['x0', 'y0', 'z0', 'x1', 'y1', 'z1'];
      if (b && typeof b === 'object' && ks.every((k) => fin(b[k], 1e7)) && b.x1 > b.x0 && b.y1 > b.y0 && b.z1 >= b.z0) out.box = Object.fromEntries(ks.map((k) => [k, b[k]]));
      else bad('box');
    }
  };
  if (obj.kind === 'element' || obj.kind === 'elements') {
    out.cls = str('cls', MAX.cls, /^[A-Za-z0-9_]*$/);
    out.guid = str('guid', MAX.guid);
  }
  if (obj.kind === 'elements') {
    if (!Array.isArray(obj.ids) || !obj.ids.length || obj.ids.length > MAX.ids || !obj.ids.every((x) => Number.isInteger(x) && x > 0)) bad('ids'); else out.ids = obj.ids.slice();
    if (!Number.isInteger(obj.count) || obj.count < 1 || obj.count > MAX.ids) bad('count'); else out.count = obj.count;
    if (typeof obj.cut !== 'boolean') bad('cut'); else out.cut = obj.cut;
    place();
  } else if (obj.kind === 'placement') {
    out.key = str('key', MAX.key, /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@\d{1,9}(#[A-Za-z0-9_.-]{1,60})?|sha:[0-9a-f]{0,64})$/i);
    out.itemNumber = str('itemNumber', MAX.number);
    if (!Number.isInteger(obj.quantity) || obj.quantity < 1 || obj.quantity > 1e6) bad('quantity'); else out.quantity = obj.quantity;
    out.notes = str('notes', MAX.notes);
    place();
    out.meta = null;
    if (obj.meta !== null && obj.meta !== undefined) {
      const m = obj.meta;
      if (m && typeof m === 'object' && typeof m.library === 'string' && m.library.length <= MAX.library && typeof m.sha256 === 'string' && /^([0-9a-f]{64})?$/.test(m.sha256)
        && typeof m.sourceFile === 'string' && m.sourceFile.length <= MAX.file) {
        out.meta = { library: m.library, sha256: m.sha256, sourceFile: m.sourceFile };
        if (m.variant !== undefined) { const v = variantMeta(m.variant); if (v) out.meta.variant = v; else bad('meta'); }
      } else bad('meta');
    }
    out.item = null;
    if (obj.item !== null && obj.item !== undefined) {
      const full = validateItem(obj.item), part = full.ok ? full : validateItem(obj.item, { partial: true });
      const itemKey = obj.item && obj.item.uuid ? obj.item.uuid + '@' + obj.item.version + (out.meta?.variant?.id ? '#' + out.meta.variant.id : '') : 'sha:' + (out.meta?.sha256 || '');
      if (!part.ok) notes.push(t('clip.note.item_invalid', { error: part.errors[0] }));
      else if (itemKey !== out.key) notes.push(t('clip.note.item_other'));
      else out.item = obj.item;
    }
  }
  const ok = errors.length === 0;
  return { ok, clip: ok ? out : null, errors, notes };
}

/** The clip in storage, checked; null when there is none, it does not parse, or it fails the check. */
export function readClip(storage) {
  let raw = null;
  try { raw = storage ? storage.getItem(CLIP_KEY) : null; } catch (e) { return null; }
  if (!raw) return null;
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { return null; }
  const r = validateClip(obj);
  return r.ok ? r.clip : null;
}

/**
 * Keep a clip for other tabs. A large library item may not fit in storage: the clip is then kept without it (this tab
 * still has the whole clip in memory). → { stored, withoutItem }
 */
export function writeClip(storage, clip) {
  if (!storage) return { stored: false, withoutItem: false };
  try { storage.setItem(CLIP_KEY, JSON.stringify(clip)); return { stored: true, withoutItem: false }; } catch (e) { /* too big, or storage refused */ }
  if (clip.item) {
    try { storage.setItem(CLIP_KEY, JSON.stringify({ ...clip, item: null })); return { stored: true, withoutItem: true }; } catch (e) { /* refused */ }
  }
  try { storage.removeItem(CLIP_KEY); } catch (e) { /* nothing to do */ }
  return { stored: false, withoutItem: false };
}

/** Item-local box (mm, back-centre-bottom origin, front −Y) of what an item shows: its body, else its plan 900 mm tall. */
export function boxFromItem(item) {
  const b = item && item.body;
  if (b && b.type === 'box') return { x0: b.x, y0: b.y, z0: b.z || 0, x1: b.x + b.w, y1: b.y + b.d, z1: (b.z || 0) + b.h };
  if (b && b.type === 'mesh' && b.positions && b.positions.length >= 3) {
    const P = b.positions, o = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
    for (let i = 0; i + 2 < P.length; i += 3) {
      o.x0 = Math.min(o.x0, P[i]); o.x1 = Math.max(o.x1, P[i]); o.y0 = Math.min(o.y0, P[i + 1]); o.y1 = Math.max(o.y1, P[i + 1]); o.z0 = Math.min(o.z0, P[i + 2]); o.z1 = Math.max(o.z1, P[i + 2]);
    }
    if (o.x1 > o.x0 && o.y1 > o.y0) return o;
  }
  const pb = (item && planBounds(item.plan)) || { minX: -300, minY: -300, maxX: 300, maxY: 0 };
  return { x0: pb.minX, y0: pb.minY, z0: 0, x1: Math.max(pb.maxX, pb.minX + 1), y1: Math.max(pb.maxY, pb.minY + 1), z1: 900 };
}

/** The same box from a placement's CadCraft_Equipment Width/Depth/Height (file units); null without width and depth. */
export function boxFromEquipment(eq, unitMm = 1) {
  const w = Number(eq?.Width) * unitMm, d = Number(eq?.Depth) * unitMm, h = Number(eq?.Height) * unitMm;
  if (!(w > 0 && d > 0)) return null;
  return { x0: -w / 2, y0: -d, z0: 0, x1: w / 2, y1: 0, z1: h > 0 ? h : 900 };
}

/** A stand-in item for the ghost and wall snap while pasting: a box body (ifc-place.js snapToWall reads its depth). */
export function ghostItem(clip) {
  if (clip.item) return clip.item;
  const b = clip.box || { x0: -300, y0: -600, z0: 0, x1: 300, y1: 0, z1: 900 };
  return { name: clip.name, plan: null, body: { type: 'box', x: b.x0, y: b.y0, z: b.z0, w: b.x1 - b.x0, d: b.y1 - b.y0, h: Math.max(1, b.z1 - b.z0) } };
}

/**
 * Paste in place beside the original: an exact overlap (two items in one spot) is no use, so when the original is still
 * on that storey the copy goes one item width plus GAP_MM along the item's own X axis — a row, as equipment is set out.
 */
export function besideSpot(clip) {
  const b = clip.box || { x0: -300, x1: 300 };
  const step = (b.x1 - b.x0) + GAP_MM, r = (clip.rot || 0) * Math.PI / 180;
  return { x: clip.x + step * Math.cos(r), y: clip.y + step * Math.sin(r), rot: clip.rot };
}

/**
 * The storey a paste in place goes on: the same storey in the model it came from; else one with the same name; else
 * the nearest elevation; else the lowest. storeys: IfcPlacer.info().storeys. → { id, how: 'same'|'name'|'elevation'|'first' } | null
 */
export function pickStorey(clip, storeys, sameModel) {
  if (!storeys || !storeys.length) return null;
  if (sameModel && clip.storey && storeys.some((s) => s.id === clip.storey)) return { id: clip.storey, how: 'same' };
  const name = String(clip.storeyName || '').trim().toLowerCase();
  const byName = name && storeys.find((s) => String(s.name).trim().toLowerCase() === name);
  if (byName) return { id: byName.id, how: 'name' };
  if (Number.isFinite(clip.storeyElevation)) {
    const near = storeys.slice().sort((a, b) => Math.abs(a.elevation - clip.storeyElevation) - Math.abs(b.elevation - clip.storeyElevation))[0];
    return { id: near.id, how: 'elevation' };
  }
  return { id: storeys[0].id, how: 'first' };
}

/** Name and properties of an element as plain text (IfcModel.properties() shape), for pasting into another program. */
export function elementText(p) {
  const v = (x) => (x === null || x === undefined ? '' : x === true ? t('dwg.yes') : x === false ? t('dwg.no') : String(x));
  const lines = [t('clip.text.head', { cls: String(p.cls || '').replace(/^Ifc/, ''), name: v(p.name) || t('clip.unnamed') })];
  for (const [k, x] of [['dwg.prop.type', p.typeName], ['color.field.objtype', p.objectType], ['color.field.tag', p.tag], ['clip.text.description', p.description], ['color.field.guid', p.guid]]) {
    if (v(x) !== '') lines.push(t('clip.text.row', { label: t(k), value: v(x) }));
  }
  for (const s of p.sets || []) {
    const rows = (s.rows || []).filter((r) => v(r.value) !== '');
    if (!rows.length) continue;
    lines.push('', s.name);
    for (const r of rows) lines.push('  ' + t('clip.text.row', { label: r.name, value: v(r.value) }));
  }
  return lines.join('\n') + '\n';
}

/**
 * Every value Properties shows for one element (0.5 WL.3), as [group, property, value] rows: the element's own fields under
 * "Element", then each property set (instance sets, then type sets, as `properties()` orders them). Empty values are kept,
 * so a CSV lists every field. `file` (federated models) adds a Model column.
 */
export function elementCopyRows(p) {
  const v = (x) => (x === null || x === undefined ? '' : x === true ? t('dwg.yes') : x === false ? t('dwg.no') : String(x));
  const own = t('prop.copy.element');
  const rows = [[own, t('prop.copy.class'), String(p.cls || '').replace(/^Ifc/, '')], [own, t('prop.name'), v(p.name)],
    [own, t('prop.type'), v(p.typeName)], [own, t('prop.objtype'), v(p.objectType)], [own, t('prop.tag'), v(p.tag)],
    [own, t('prop.desc'), v(p.description)], [own, t('prop.guid'), v(p.guid)], [own, t('prop.line'), p.id === undefined ? '' : '#' + p.id]];
  for (const s of p.sets || []) for (const r of s.rows || []) rows.push([s.name, r.name, v(r.value)]);
  return rows;
}
/** The same rows as CSV (no BOM; formula-looking cells escaped as every other BimCraft CSV), with a Model column when given. */
export function elementCsv(p, { file } = {}) {
  const rows = elementCopyRows(p);
  // i18n-ignore: CSV headers are file content (as the other CSVs here)
  return file ? tableCsv(['Model', 'Group', 'Property', 'Value'], rows.map((r) => [file, ...r])) : tableCsv(['Group', 'Property', 'Value'], rows);
}
