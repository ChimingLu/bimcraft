/* SPDX-License-Identifier: Apache-2.0 */
/**
 * assets-bim.js — the facility side of a handed-over model (0.6 LC.12, session bim-extra_PART_2; spike
 * docs/spikes/LC.12_PART_2.md): the assets, their data and a maintenance record, all kept in the IFC with IFC's own sets and
 * entities so any program that reads IFC sees them. No DOM: node bin/test-bimcraft.mjs --extra2 --only assets.
 *
 *   readAssets(W, api, mid, { today }) → [{ id, guid, cls, name, tag, storey, tracked, data, log, last, nextDue, due, docs,
 *       limits: { low, high, unit } (the CadCraft_Sensor set, assets-bim-sensors.js) }]
 *       the assets: equipment and fixtures (ASSET_CLASSES, IfcBuildingElementProxy only with CadCraft_Equipment) and any
 *       element carrying asset data, a maintenance entry or our CadCraft_Asset mark. data = { maker, model, ref, serial,
 *       barcode, installed, warrantyId, warrantyStart, warrantyEnd, life (years) } (strings, '' = none); log = entries,
 *       newest first: { guid, date, work, by, next, notes }; last = the newest entry's date; nextDue = the newest entry's
 *       next date; due = 'overdue' | 'soon' (within SOON_DAYS) | '' — dates are 'YYYY-MM-DD'
 *   trackOp(guid) / untrackOp(guid)                     the CadCraft_Asset mark (an element the list doesn't offer by itself)
 *   assetDataOp(guid, patch)                            patch keys as `data`; '' clears that value (the property is removed)
 *   addEntryOp(guid, entry) / editEntryOp(taskGuid, entry) / removeEntryOp(taskGuid)
 *   Each op is `(ed) => { journal, … }` for IfcEditor.modelChange: one undo step; ops name things by GlobalId (redo safe).
 *   addDocOp(guid, { title, location, kind }) / removeDocOp(guid, relGuid)     documents per asset (0.7 LC.12 item 1, bim-ops)
 *   assetsCsv(assets) → text   one row per asset (its data, last, next due) + one per maintenance entry + one per document;
 *                              formula cells escaped
 *   isDay(s) → bool             a real calendar day 'YYYY-MM-DD'
 *   docLocation(s) → '' | error key   a document's place: a web address (http / https) or a file name or path beside the
 *                              IFC; any other scheme (javascript:, data:, file:…) refused. openable(s) → only http(s) opens.
 *
 * Documents (0.7, session bim-ops): an asset's `docs` = [{ rel, title, location, kind, ours, fromType }] — manuals,
 * warranties, photos, certificates, drawings, linked by a name or a web address; the files themselves stay where they are
 * (nothing is uploaded or copied in). Each is an IfcDocumentReference (IFC4: Location IfcURIReference, Name, Description =
 * the kind; IFC2X3: Location IfcLabel, Name) tied to the element by its own IfcRelAssociatesDocument named DOC_REL with the
 * kind as its Description (both schemas). Other programs' references (and IfcDocumentInformation) are read too, kind
 * 'other' unless they carry one of ours; references on the element's type are listed with fromType (removed on the type).
 *
 * How it is kept (IFC4 / IFC2X3 schemas):
 *   Pset_ManufacturerTypeInformation  Manufacturer, ModelLabel, ModelReference (IfcLabel)
 *   Pset_ManufacturerOccurrence       SerialNumber, BarCode (IfcIdentifier), AcquisitionDate (IFC4 IfcDate; IFC2X3 IfcLabel)
 *   Pset_Warranty                     WarrantyIdentifier (IfcIdentifier), WarrantyStartDate, WarrantyEndDate (as dates above)
 *   Pset_ServiceLife                  ServiceLifeDuration (IFC4 IfcDuration 'P<n>Y'; IFC2X3 IfcTimeMeasure, seconds)
 *   An entry = one IfcTask (IFC4 PredefinedType MAINTENANCE, IfcTaskTime ActualFinish = done, ScheduleStart = next due;
 *   IFC2X3 ObjectType 'MAINTENANCE', TaskId) named for the work, Description = notes, Status 'Done', + its own set
 *   CadCraft_Maintenance (Date, By, NextDue: the same in both schemas), tied to the element by IfcRelAssignsToProcess.
 *   IFC2X3's standard sets want IfcCalendarDate entities for dates; a label 'YYYY-MM-DD' is written there instead (said in help).
 */
import { ModelWriter } from './model-write.js';
import { ids, val, deleteLine } from './ifc-util.js';
import { SENSOR_SET, readSensorSet } from './assets-bim-sensors.js';

export const ASSET_CLASSES = ['IFCFURNITURE', 'IFCFURNISHINGELEMENT', 'IFCSANITARYTERMINAL', 'IFCLIGHTFIXTURE', 'IFCELECTRICAPPLIANCE', 'IFCAIRTERMINAL',
  'IFCFLOWTERMINAL', 'IFCVALVE', 'IFCFLOWCONTROLLER', 'IFCPUMP', 'IFCFAN', 'IFCFLOWMOVINGDEVICE', 'IFCBOILER', 'IFCCHILLER', 'IFCUNITARYEQUIPMENT',
  'IFCENERGYCONVERSIONDEVICE', 'IFCTANK', 'IFCFLOWSTORAGEDEVICE', 'IFCFIRESUPPRESSIONTERMINAL', 'IFCOUTLET', 'IFCSWITCHINGDEVICE',
  'IFCELECTRICDISTRIBUTIONBOARD', 'IFCTRANSPORTELEMENT'];
export const SOON_DAYS = 30;
export const MARK = 'CadCraft_Asset', LOG_SET = 'CadCraft_Maintenance';
export const DOC_REL = 'CadCraft_AssetDocument';
export const DOC_KINDS = ['manual', 'warranty', 'photo', 'certificate', 'drawing', 'other'];
export const FIELDS = ['maker', 'model', 'ref', 'serial', 'barcode', 'installed', 'warrantyId', 'warrantyStart', 'warrantyEnd', 'life'];
const DATE_FIELDS = new Set(['installed', 'warrantyStart', 'warrantyEnd']);
/** field → [set, property, IFC4 type, IFC2X3 type] */
const MAP = {
  maker: ['Pset_ManufacturerTypeInformation', 'Manufacturer', 'IFCLABEL', 'IFCLABEL'],
  model: ['Pset_ManufacturerTypeInformation', 'ModelLabel', 'IFCLABEL', 'IFCLABEL'],
  ref: ['Pset_ManufacturerTypeInformation', 'ModelReference', 'IFCLABEL', 'IFCLABEL'],
  serial: ['Pset_ManufacturerOccurrence', 'SerialNumber', 'IFCIDENTIFIER', 'IFCIDENTIFIER'],
  barcode: ['Pset_ManufacturerOccurrence', 'BarCode', 'IFCIDENTIFIER', 'IFCIDENTIFIER'],
  installed: ['Pset_ManufacturerOccurrence', 'AcquisitionDate', 'IFCDATE', 'IFCLABEL'],
  warrantyId: ['Pset_Warranty', 'WarrantyIdentifier', 'IFCIDENTIFIER', 'IFCIDENTIFIER'],
  warrantyStart: ['Pset_Warranty', 'WarrantyStartDate', 'IFCDATE', 'IFCLABEL'],
  warrantyEnd: ['Pset_Warranty', 'WarrantyEndDate', 'IFCDATE', 'IFCLABEL'],
  life: ['Pset_ServiceLife', 'ServiceLifeDuration', 'IFCDURATION', 'IFCTIMEMEASURE'],
};
const YEAR_S = 365.25 * 86400;

export function isDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
const dayNum = (s) => Math.round(Date.parse(s + 'T00:00:00Z') / 86400000);
const err = (key) => Object.assign(new Error(key), { key });
const clip = (s, n = 255) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);

/** A value read back from the file into the form's text: dates 'YYYY-MM-DD', service life in whole years. */
function fromFile(field, v) {
  if (v === null || v === undefined) return '';
  if (field === 'life') {
    if (typeof v === 'number' || /^[\d.]+$/.test(String(v))) { const y = Number(v) / YEAR_S; return y > 0 ? String(Math.round(y * 10) / 10) : ''; }
    const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+)M)?/.exec(String(v));
    return m && (m[1] || m[2]) ? String(Math.round(((Number(m[1]) || 0) + (Number(m[2]) || 0) / 12) * 10) / 10) : '';
  }
  const s = String(v);
  return DATE_FIELDS.has(field) ? (isDay(s.slice(0, 10)) ? s.slice(0, 10) : '') : s;
}

/** Every IfcRelDefinesByProperties once: object → [{ name, values }]. */
function setsIndex(api, mid) {
  const out = new Map();
  for (const rid of ids(api, mid, 'IFCRELDEFINESBYPROPERTIES')) {
    const r = api.GetLine(mid, rid, false), d = r?.RelatingPropertyDefinition?.value;
    if (!d) continue;
    const ps = api.GetLine(mid, d, false);
    if (!ps || !ps.HasProperties) continue;
    const values = {};
    for (const h of ps.HasProperties) { const p = api.GetLine(mid, h.value, false); if (p?.Name) values[val(p.Name)] = val(p.NominalValue); }
    for (const h of r.RelatedObjects || []) { if (!out.has(h.value)) out.set(h.value, []); out.get(h.value).push({ name: val(ps.Name), values }); }
  }
  return out;
}
const isMaintenance = (t) => String(val(t.PredefinedType) ?? '').toUpperCase() === 'MAINTENANCE' || String(val(t.ObjectType) ?? '').toUpperCase() === 'MAINTENANCE';
const tryIds = (api, mid, cls) => { try { return ids(api, mid, cls); } catch { return []; } };

export function readAssets(W, api, mid, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const sets = setsIndex(api, mid);
  // the type's sets (HasPropertySets) under the element's own: exports often keep maker and model on the type
  const typeSets = new Map();
  for (const rid of tryIds(api, mid, 'IFCRELDEFINESBYTYPE')) {
    const r = api.GetLine(mid, rid, false), ty = r?.RelatingType?.value ? api.GetLine(mid, r.RelatingType.value, false) : null;
    if (!ty?.HasPropertySets) continue;
    const list = [];
    for (const h of ty.HasPropertySets) {
      const ps = api.GetLine(mid, h.value, false);
      if (!ps?.HasProperties) continue;
      const values = {};
      for (const q of ps.HasProperties) { const p = api.GetLine(mid, q.value, false); if (p?.Name) values[val(p.Name)] = val(p.NominalValue); }
      list.push({ name: val(ps.Name), values });
    }
    for (const h of r.RelatedObjects || []) typeSets.set(h.value, list);
  }
  const setOf = (id, name) => {
    const own = (sets.get(id) || []).find((s) => s.name === name)?.values || null;
    const ty = (typeSets.get(id) || []).find((s) => s.name === name)?.values || null;
    return own && ty ? { ...ty, ...own } : own || ty;
  };
  // maintenance entries by element
  const logs = new Map();
  for (const rid of tryIds(api, mid, 'IFCRELASSIGNSTOPROCESS')) {
    const r = api.GetLine(mid, rid, false), tid = r?.RelatingProcess?.value;
    const task = tid ? api.GetLine(mid, tid, false) : null;
    if (!task || String(task.constructor?.name || '').toUpperCase() !== 'IFCTASK' || !isMaintenance(task)) continue;
    const own = setOf(tid, LOG_SET) || {};
    const tt = task.TaskTime?.value ? api.GetLine(mid, task.TaskTime.value, false) : null;
    const day = (x) => { const s = String(x ?? '').slice(0, 10); return isDay(s) ? s : ''; };
    const entry = { guid: val(task.GlobalId), date: day(own.Date) || day(val(tt?.ActualFinish)), work: String(val(task.Name) ?? ''), by: String(own.By ?? ''),
      next: day(own.NextDue) || day(val(tt?.ScheduleStart)), notes: String(val(task.Description) ?? '') };
    for (const h of r.RelatedObjects || []) { if (!logs.has(h.value)) logs.set(h.value, []); logs.get(h.value).push(entry); }
  }
  // documents by element (and by type: an element shows its type's too)
  const docs = new Map(), typeOf = new Map();
  for (const rid of tryIds(api, mid, 'IFCRELDEFINESBYTYPE')) { const r = api.GetLine(mid, rid, false); for (const h of r?.RelatedObjects || []) typeOf.set(h.value, r.RelatingType?.value); }
  for (const rid of tryIds(api, mid, 'IFCRELASSOCIATESDOCUMENT')) {
    const r = api.GetLine(mid, rid, false), dref = r?.RelatingDocument?.value;
    const d = dref ? api.GetLine(mid, dref, false) : null;
    if (!d) continue;
    const ours = val(r.Name) === DOC_REL;
    const k0 = String((ours ? val(r.Description) : val(d.Description)) ?? '').toLowerCase();
    const entry = { rel: val(r.GlobalId), title: String(val(d.Name) ?? ''), location: String(val(d.Location) ?? ''), kind: DOC_KINDS.includes(k0) ? k0 : 'other', ours };
    for (const h of r.RelatedObjects || []) { if (!docs.has(h.value)) docs.set(h.value, []); docs.get(h.value).push(entry); }
  }
  const docsOf = (id) => [...(docs.get(id) || []).map((x) => ({ ...x, fromType: false })), ...(docs.get(typeOf.get(id)) || []).map((x) => ({ ...x, fromType: true }))];
  // where each element is: its spatial container, climbed through aggregation (a space → its storey)
  const inside = new Map(), parent = new Map();
  for (const rid of tryIds(api, mid, 'IFCRELCONTAINEDINSPATIALSTRUCTURE')) { const r = api.GetLine(mid, rid, false); for (const h of r?.RelatedElements || []) inside.set(h.value, r.RelatingStructure?.value); }
  for (const rid of tryIds(api, mid, 'IFCRELAGGREGATES')) { const r = api.GetLine(mid, rid, false); for (const h of r?.RelatedObjects || []) parent.set(h.value, r.RelatingObject?.value); }
  const storeys = new Set(tryIds(api, mid, 'IFCBUILDINGSTOREY'));
  const storeyOf = (id) => { let s = inside.get(id); for (let k = 0; s && !storeys.has(s) && k < 6; k++) s = parent.get(s); return s && storeys.has(s) ? s : null; };
  const cand = new Map();
  for (const cls of ASSET_CLASSES) for (const id of tryIds(api, mid, cls)) cand.set(id, cls);
  for (const id of tryIds(api, mid, 'IFCBUILDINGELEMENTPROXY')) if (setOf(id, 'CadCraft_Equipment')) cand.set(id, 'IFCBUILDINGELEMENTPROXY');
  for (const [id, list] of sets) if (!cand.has(id) && list.some((s) => s.name === MARK || s.name === SENSOR_SET || Object.values(MAP).some((m) => m[0] === s.name))) cand.set(id, null);
  for (const id of logs.keys()) if (!cand.has(id)) cand.set(id, null);
  for (const [id, list] of docs) if (!cand.has(id) && list.some((x) => x.ours) && !/TYPE$/.test(String(api.GetLine(mid, id, false)?.constructor?.name || '').toUpperCase())) cand.set(id, null);
  const out = [];
  for (const [id, cls0] of cand) {
    const e = api.GetLine(mid, id, false);
    if (!e || !e.GlobalId) continue;
    const cls = cls0 || String(e.constructor?.name || '').toUpperCase();
    if (/^IFC(TASK|PROJECT|SITE|BUILDING|BUILDINGSTOREY|SPACE)$/.test(cls) || /TYPE$|STYLE$/.test(cls)) continue;
    const data = {};
    for (const f of FIELDS) { const [set, prop] = MAP[f]; data[f] = fromFile(f, setOf(id, set)?.[prop]); }
    const eq = setOf(id, 'CadCraft_Equipment');   // a library item's maker / model when the standard set has none
    if (eq) { if (!data.maker && eq.Maker) data.maker = String(eq.Maker); if (!data.model && eq.Model) data.model = String(eq.Model); }
    const log = (logs.get(id) || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.guid.localeCompare(b.guid));
    const last = log.find((x) => x.date)?.date || '', nextDue = log.find((x) => x.date)?.next || log[0]?.next || '';
    let due = '';
    if (nextDue && isDay(today)) { const d = dayNum(nextDue) - dayNum(today); due = d < 0 ? 'overdue' : d <= SOON_DAYS ? 'soon' : ''; }
    const storey = storeyOf(id);
    out.push({ id, guid: val(e.GlobalId), cls, name: String(val(e.Name) ?? '') || String(val(e.ObjectType) ?? ''), tag: String(val(e.Tag) ?? ''), storey,
      tracked: !!setOf(id, MARK), data, log, last, nextDue, due, docs: docsOf(id), limits: readSensorSet(setOf(id, SENSOR_SET)) });
  }
  return out.sort((a, b) => (a.due === 'overdue' ? 0 : a.due === 'soon' ? 1 : 2) - (b.due === 'overdue' ? 0 : b.due === 'soon' ? 1 : 2) || a.name.localeCompare(b.name) || a.id - b.id);
}

// ---- writing ----
function elementOf(w, guid) {
  for (const id of ids(w.api, w.mid, 'IFCROOT', true)) { const l = w.api.GetLine(w.mid, id, false); if (l && val(l.GlobalId) === guid) return id; }
  throw err('assets.err.gone');
}
/**
 * The element's own copy of a set before it changes (copy-on-write, as ifc-edit.js does for property edits): exports often
 * share one set between many elements, so a set related to anything else is copied — new set, new property lines with the
 * same values — and the element moves to the copy. → the set's def entry, or null when the element has none.
 */
function ownSet(w, id, setName) {
  const d = w.defNamed(id, setName);
  if (!d) return null;
  let shared = false;
  for (const rid of ids(w.api, w.mid, 'IFCRELDEFINESBYPROPERTIES')) {
    const r = w.api.GetLine(w.mid, rid, false);
    if (r?.RelatingPropertyDefinition?.value === d.def && (rid !== d.rel || (r.RelatedObjects || []).length > 1)) { shared = true; break; }
  }
  if (!shared) return d;
  const rel = w.touch(d.rel);
  rel.RelatedObjects = (rel.RelatedObjects || []).filter((h) => h.value !== id);
  if (rel.RelatedObjects.length) w.write(rel);
  else w.dropProduct([d.rel]);
  const props = (d.line.HasProperties || []).map((h) => { const p = w.api.GetLine(w.mid, h.value, false); return w.H(w.make('IFCPROPERTYSINGLEVALUE', p.Name, p.Description ?? null, p.NominalValue ?? null, p.Unit ?? null)); });
  const ps = w.make('IFCPROPERTYSET', w.guid(), w.ownerHistory(), d.line.Name, d.line.Description ?? null, props);
  w._defs = null;
  w.relateDef(id, ps);
  return w.defNamed(id, setName);
}
/** Remove these properties from the element's own set (the set and its relation go when it is left empty). */
function dropProps(w, id, setName, names) {
  const d = ownSet(w, id, setName);
  if (!d) return;
  const keep = [], gone = [];
  for (const h of d.line.HasProperties || []) { const p = w.api.GetLine(w.mid, h.value, false); (names.includes(val(p?.Name)) ? gone : keep).push(h); }
  if (!gone.length) return;
  if (!keep.length) { w.dropProduct([d.def]); for (const h of gone) w.dropTree(h.value); w._defs = null; return; }
  const ps = w.touch(d.def); ps.HasProperties = keep; w.write(ps);
  for (const h of gone) w.dropTree(h.value);
}
function typed(w, field, v) {
  const [, , t4, t3] = MAP[field];
  const type = w.v4 ? t4 : t3;
  if (field === 'life') return [type, w.v4 ? 'P' + v + 'Y' : Math.round(Number(v) * YEAR_S)];
  return [type, v];
}
function cleanData(patch) {
  const out = {};
  for (const f of FIELDS) {
    if (!(f in patch)) continue;
    const v = clip(patch[f]);
    if (v && DATE_FIELDS.has(f) && !isDay(v)) throw err('assets.err.date');
    if (v && f === 'life' && !(Number(v) > 0 && Number(v) <= 200 && /^\d+(\.\d+)?$/.test(v))) throw err('assets.err.life');
    out[f] = v;
  }
  return out;
}

export function trackOp(guid) {
  return (ed) => { const w = new ModelWriter(ed.W, ed.api, ed.mid); return w.run(() => { const id = elementOf(w, guid); w.upsertPset(id, MARK, [['Tracked', 'IFCBOOLEAN', true]]); return { id }; }); };
}
export function untrackOp(guid) {
  return (ed) => { const w = new ModelWriter(ed.W, ed.api, ed.mid); return w.run(() => { const id = elementOf(w, guid); dropProps(w, id, MARK, ['Tracked']); return { id }; }); };
}

/** Write cleaned data on element id with writer w (the body of assetDataOp and importOp). */
function writeData(w, id, data) {
  const bySet = new Map(), clear = new Map();
  for (const [f, v] of Object.entries(data)) {
    const [set, prop] = MAP[f];
    if (v) { if (!bySet.has(set)) bySet.set(set, []); bySet.get(set).push([prop, ...typed(w, f, v)]); }
    else { if (!clear.has(set)) clear.set(set, []); clear.get(set).push(prop); }
  }
  for (const [set, rows] of bySet) { ownSet(w, id, set); w.upsertPset(id, set, rows); }
  for (const [set, props] of clear) dropProps(w, id, set, props);
}
function checkData(patch) {
  const data = cleanData(patch);
  if (data.warrantyStart && data.warrantyEnd && data.warrantyEnd < data.warrantyStart) throw err('assets.err.warranty');
  return data;
}
export function assetDataOp(guid, patch) {
  const data = checkData(patch);
  return (ed) => {
    const w = new ModelWriter(ed.W, ed.api, ed.mid);
    return w.run(() => { const id = elementOf(w, guid); writeData(w, id, data); return { id }; });
  };
}
/**
 * Many assets at once, one undo step (a COBie spreadsheet read back): changes = [{ guid, data?: patch, docs?: [{ title,
 * location, kind }] }]. Every patch and document is checked before anything is written; the first bad one throws with
 * `row` set to its index.
 */
export function importOp(changes) {
  const clean = changes.map((c, row) => {
    try {
      const docs = (c.docs || []).map((d) => { const loc = String(d.location ?? '').trim(), bad = docLocation(loc); if (bad) throw err(bad); return { loc, kind: DOC_KINDS.includes(d.kind) ? d.kind : 'other', name: clip(d.title) || clip(lastPart(loc)) }; });
      return { guid: c.guid, data: c.data ? checkData(c.data) : null, docs };
    } catch (e) { e.row = row; throw e; }
  });
  return (ed) => {
    const w = new ModelWriter(ed.W, ed.api, ed.mid);
    return w.run(() => {
      const ids2 = [];
      for (const c of clean) {
        const id = elementOf(w, c.guid);
        if (c.data && Object.keys(c.data).length) writeData(w, id, c.data);
        for (const d of c.docs) writeDoc(w, id, d);
        ids2.push(id);
      }
      return { id: ids2[0] ?? null, ids: ids2 };
    });
  };
}

function cleanEntry(e) {
  const out = { date: clip(e.date, 10), work: clip(e.work), by: clip(e.by), next: clip(e.next, 10), notes: clip(e.notes, 2000) };
  if (!isDay(out.date)) throw err('assets.err.entry-date');
  if (out.next && !isDay(out.next)) throw err('assets.err.date');
  if (out.next && out.next < out.date) throw err('assets.err.next');
  if (!out.work) throw err('assets.err.work');
  return out;
}
const dt = (day) => day + 'T00:00:00';
function writeTask(w, e) {
  const head = [w.guid(), w.ownerHistory(), w.L(e.work), w.X(e.notes || null), w.L('MAINTENANCE')];
  let task;
  if (w.v4) {
    const time = w.make('IFCTASKTIME', null, null, null, null, null, e.next ? w.T('IFCDATETIME', dt(e.next)) : null, null, null, null, null, null, null, null, null, null, null, null, w.T('IFCDATETIME', dt(e.date)), null, null);
    task = w.make('IFCTASK', ...head, null, null, w.L('Done'), null, false, null, w.H(time), 'MAINTENANCE');
  } else task = w.make('IFCTASK', ...head, w.T('IFCIDENTIFIER', 'M-' + e.date), w.L('Done'), null, false, null);
  w.relateDef(task, w.pset(LOG_SET, [['Date', 'IFCLABEL', e.date], ['By', 'IFCLABEL', e.by || null], ['NextDue', 'IFCLABEL', e.next || null]].filter((r) => r[2] !== null)));
  return task;
}
function taskOf(w, guid) {
  for (const id of ids(w.api, w.mid, 'IFCTASK')) { const l = w.api.GetLine(w.mid, id, false); if (l && val(l.GlobalId) === guid) return id; }
  throw err('assets.err.gone');
}
/** The task's own lines: its time, its CadCraft_Maintenance set, the relations that name it (dropProduct does those). */
function dropTask(w, tid) {
  const t = w.api.GetLine(w.mid, tid, false);
  const time = t?.TaskTime?.value;
  w.dropProduct([tid]);
  if (time) { try { if (w.api.GetLine(w.mid, time, false)) w.dropTree(time); } catch { /* gone */ } }
  w._defs = null;
}

export function addEntryOp(guid, entry) {
  const e = cleanEntry(entry);
  return (ed) => {
    const w = new ModelWriter(ed.W, ed.api, ed.mid);
    return w.run(() => {
      const id = elementOf(w, guid);
      const task = writeTask(w, e);
      w.make('IFCRELASSIGNSTOPROCESS', w.guid(), w.ownerHistory(), null, null, [w.H(id)], null, w.H(task), null);
      return { id, task };
    });
  };
}
/** Change an entry: the task is written again (a new GlobalId), tied to the same elements. */
export function editEntryOp(taskGuid, entry) {
  const e = cleanEntry(entry);
  return (ed) => {
    const w = new ModelWriter(ed.W, ed.api, ed.mid);
    return w.run(() => {
      const tid = taskOf(w, taskGuid);
      const objs = [];
      for (const rid of ids(w.api, w.mid, 'IFCRELASSIGNSTOPROCESS')) { const r = w.api.GetLine(w.mid, rid, false); if (r?.RelatingProcess?.value === tid) objs.push(...(r.RelatedObjects || []).map((h) => h.value)); }
      dropTask(w, tid);
      const task = writeTask(w, e);
      w.make('IFCRELASSIGNSTOPROCESS', w.guid(), w.ownerHistory(), null, null, objs.map((o) => w.H(o)), null, w.H(task), null);
      return { id: objs[0], task };
    });
  };
}
export function removeEntryOp(taskGuid) {
  return (ed) => { const w = new ModelWriter(ed.W, ed.api, ed.mid); return w.run(() => { dropTask(w, taskOf(w, taskGuid)); return {}; }); };
}

// ---- documents ----
/** '' when s can be a document's place, else the error key: http(s) addresses, or a file name / path (C:\…, \\server\…, a/b.pdf). */
export function docLocation(s) {
  const v = String(s ?? '').trim();
  if (!v) return 'assets.err.doc-location';
  if (v.length > 255 || /[\u0000-\u001f\u007f]/.test(v)) return 'assets.err.doc-location';
  if (/^[a-z]:[\\/]/i.test(v) || /^[\\/]{2}/.test(v)) return '';   // a drive letter or a network share: a file path
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (!m) return '';
  if (!/^https?$/i.test(m[1])) return 'assets.err.doc-scheme';
  try { const u = new URL(v); return u.hostname && !u.username && !u.password ? '' : 'assets.err.doc-location'; } catch { return 'assets.err.doc-location'; }
}
export const openable = (s) => /^https?:\/\//i.test(String(s ?? '').trim()) && docLocation(s) === '';
const lastPart = (s) => String(s).replace(/[?#].*$/, '').split(/[\\/]/).filter(Boolean).pop() || String(s);

export function addDocOp(guid, { title = '', location = '', kind = 'other' } = {}) {
  const loc = String(location ?? '').trim();
  const bad = docLocation(loc);
  if (bad) throw err(bad);
  const d = { loc, kind: DOC_KINDS.includes(kind) ? kind : 'other', name: clip(title) || clip(lastPart(loc)) };
  return (ed) => {
    const w = new ModelWriter(ed.W, ed.api, ed.mid);
    return w.run(() => { const id = elementOf(w, guid); return { id, ref: writeDoc(w, id, d) }; });
  };
}
function writeDoc(w, id, { loc, kind, name }) {
  const ref = w.v4
    ? w.make('IFCDOCUMENTREFERENCE', w.T('IFCURIREFERENCE', loc), null, w.L(name), w.X(kind), null)
    : w.make('IFCDOCUMENTREFERENCE', w.T('IFCLABEL', loc), null, w.L(name));
  w.make('IFCRELASSOCIATESDOCUMENT', w.guid(), w.ownerHistory(), w.L(DOC_REL), w.X(kind), [w.H(id)], w.H(ref));
  return ref;
}
/** Take a document off the element: out of the relation; the relation (and the reference, when nothing else uses it) go when emptied. */
export function removeDocOp(guid, relGuid) {
  return (ed) => {
    const w = new ModelWriter(ed.W, ed.api, ed.mid);
    return w.run(() => {
      const id = elementOf(w, guid);
      let rid = null;
      for (const r of ids(w.api, w.mid, 'IFCRELASSOCIATESDOCUMENT')) { const l = w.api.GetLine(w.mid, r, false); if (l && val(l.GlobalId) === relGuid) { rid = r; break; } }
      if (rid === null) throw err('assets.err.gone');
      const rel = w.touch(rid), dref = rel.RelatingDocument?.value;
      const keep = (rel.RelatedObjects || []).filter((h) => h.value !== id);
      if (keep.length) { rel.RelatedObjects = keep; w.write(rel); return { id }; }
      deleteLine(w.api, w.mid, rid);   // touched above: undo writes it back
      const used = dref && ids(w.api, w.mid, 'IFCRELASSOCIATESDOCUMENT').some((r) => r !== rid && w.api.GetLine(w.mid, r, false)?.RelatingDocument?.value === dref);
      if (dref && !used && /REFERENCE$/i.test(w.api.GetLine(w.mid, dref, false)?.constructor?.name || '')) w.dropTree(dref);
      return { id };
    });
  };
}

// ---- CSV ----
const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function assetsCsv(assets, { storeyName = () => '', head = null } = {}) {
  const H = head || Object.fromEntries(['kind', 'name', 'tag', 'cls', 'storey', 'guid', ...FIELDS, 'last', 'next', 'work', 'by', 'notes', 'asset', 'entry', 'document', 'location'].map((k) => [k, k]));   // the page passes `head` in the person's language
  const cols = ['kind', 'name', 'tag', 'cls', 'storey', 'guid', ...FIELDS, 'last', 'next', 'work', 'by', 'notes', 'location'];
  const rows = [cols.map((c) => H[c])];
  for (const a of assets) {
    rows.push([H.asset, a.name, a.tag, a.cls, storeyName(a.storey), a.guid, ...FIELDS.map((f) => a.data[f]), a.last, a.nextDue, '', '', '', '']);
    for (const e of a.log) rows.push([H.entry, a.name, a.tag, a.cls, storeyName(a.storey), a.guid, ...FIELDS.map(() => ''), e.date, e.next, e.work, e.by, e.notes, '']);
    for (const d of a.docs || []) rows.push([H.document, a.name, a.tag, a.cls, storeyName(a.storey), a.guid, ...FIELDS.map(() => ''), '', '', d.title, '', d.kind, d.location]);
  }
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
