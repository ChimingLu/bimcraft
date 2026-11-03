/* SPDX-License-Identifier: Apache-2.0 */
/**
 * spec.js — pipe specs (0.7 LC.5 step 2, session plant-design). DOM-free (tested in Node).
 *
 * A PIPE SPEC is a named class of pipe the way a plant writes them: which material and wall (class) it is, from which size to
 * which, which valves it may carry and where, how its bends are made, and how a branch is made off a header of each size. It is
 * data (format `cadcraft-pipespec`, version 1), ours: written from the public size tables (the BimCraft MEP tables:
 * ASME B36.10M steel, ASTM B88 copper, ASTM D1785 PVC, ASTM F876 PEX) and general practice, not from any company's spec book
 * or any maker's catalogue. The sizes and walls come from the tables; the spec only chooses among them. A drafting aid:
 * a person who is responsible for the plant owns the spec.
 *
 * The runs BimCraft draws (mep-model.js) already say their material and class (`CadCraft_MepRun`); a spec is found by that pair,
 * so a run needs nothing added to be checked.
 *
 *   SPEC_FORMAT · SPEC_VERSION · STARTERS (the specs that come with the add-on)
 *   cleanSpec(raw) → spec | null            (untrusted: a file someone sent, or localStorage)
 *   specFor(specs, mat, cls) → spec | null
 *   allowedSizes(spec) → ['1/2', …]         the table sizes between min and max
 *   valveAllowed(spec, kind, size) → bool
 *   branchKind(spec, header, branch) → 'tee' | 'reducing-tee' | 'stub-in' | null      how a branch is made on a header
 *   bendRadius(spec, size) → inches         centre-line radius of its elbows (long: the table's; short: one nominal size)
 *   checkRun(spec, run) → [{ code, level, vars }]     size / valve findings (codes below)
 *   checkRuns(specs, runs) → [{ guid, code, level, vars }]   every run against its spec; a run with no spec is `spec-none`
 *
 * Codes: spec-none (warning) · spec-size (error) · spec-valve (error) · spec-bend (warning: a turn tighter than the spec's bend).
 */

import { MATERIALS, CLASSES, sizesFor, nominal, pipeSize, bendRadius as tableBendRadius } from '../../../mep/tables.js';

export const SPEC_FORMAT = 'cadcraft-pipespec';
export const SPEC_VERSION = 1;
export const VALVES = ['gate', 'globe', 'ball', 'check'];   // the kinds BimCraft's runs carry (mep-model.js VALVE_KINDS)
export const BENDS = ['long', 'short'];
export const BRANCH_KINDS = ['tee', 'reducing-tee', 'stub-in'];
export const LIMITS = { id: 24, name: 60, notes: 200, rules: 12 };

const norm = (s) => String(s ?? '').trim();
const idOk = (s) => /^[A-Za-z][A-Za-z0-9._-]{0,23}$/.test(s);

/** A spec from untrusted data → clean spec, or null. */
export function cleanSpec(raw) {
  if (!raw || typeof raw !== 'object' || raw.format !== SPEC_FORMAT || !(raw.version >= 1)) return null;
  const id = norm(raw.id);
  const material = norm(raw.material), cls = norm(raw.cls);
  if (!idOk(id) || !MATERIALS.includes(material) || !CLASSES[material].includes(cls)) return null;
  const list = sizesFor(material, cls);
  if (!list.length) return null;
  const pick = (s, dflt) => (list.includes(norm(s)) ? norm(s) : dflt);
  let min = pick(raw.sizes?.min, list[0]), max = pick(raw.sizes?.max, list[list.length - 1]);
  if (nominal(min) > nominal(max)) [min, max] = [max, min];
  const valves = {};
  if (raw.valves && typeof raw.valves === 'object') {
    for (const k of VALVES) {
      const v = raw.valves[k];
      if (!v || typeof v !== 'object') continue;
      let a = pick(v.min, min), b = pick(v.max, max);
      if (nominal(a) > nominal(b)) [a, b] = [b, a];
      valves[k] = { min: a, max: b };
    }
  }
  const branch = [];
  if (Array.isArray(raw.branch)) {
    for (const r of raw.branch.slice(0, LIMITS.rules)) {
      const ratio = Number(r?.ratio);
      if (Number.isFinite(ratio) && ratio > 0 && ratio <= 1 && BRANCH_KINDS.includes(r.kind)) branch.push({ ratio, kind: r.kind });
    }
    branch.sort((a, b) => a.ratio - b.ratio);
  }
  return {
    format: SPEC_FORMAT, version: SPEC_VERSION, id, name: norm(raw.name).slice(0, LIMITS.name) || id, material, cls,
    sizes: { min, max }, valves, bends: BENDS.includes(raw.bends) ? raw.bends : 'long', branch,
    rating: norm(raw.rating).slice(0, 12), notes: norm(raw.notes).slice(0, LIMITS.notes),
  };
}

const rules = (stub) => [{ ratio: 0.25, kind: stub ? 'stub-in' : 'reducing-tee' }, { ratio: 0.9999, kind: 'reducing-tee' }, { ratio: 1, kind: 'tee' }];

/** The specs that come with the add-on: general-service classes over the public tables. Ours; rename or copy them freely. */
export const STARTERS = [
  { id: 'CS40', name: 'Carbon steel, Sch 40, general service', material: 'steel', cls: '40', sizes: { min: '1/2', max: '24' }, bends: 'long', rating: '150',   // i18n-ignore: the starter spec record (its file text); shown as t(spec.starter.<id>.*) by main.js
    valves: { gate: { min: '1/2', max: '24' }, globe: { min: '1/2', max: '12' }, ball: { min: '1/2', max: '12' }, check: { min: '1/2', max: '24' } }, branch: rules(true), notes: 'Welded and threaded pipe; stub-in branches up to a quarter of the header.' },   // i18n-ignore: the starter spec record (its file text); shown as t(spec.starter.<id>.*) by main.js
  { id: 'CS80', name: 'Carbon steel, Sch 80, heavy wall', material: 'steel', cls: '80', sizes: { min: '1/2', max: '12' }, bends: 'long', rating: '300',   // i18n-ignore: the starter spec record (its file text); shown as t(spec.starter.<id>.*) by main.js
    valves: { gate: { min: '1/2', max: '12' }, globe: { min: '1/2', max: '8' }, ball: { min: '1/2', max: '8' }, check: { min: '1/2', max: '12' } }, branch: rules(true), notes: 'For higher pressure or a corrosion allowance.' },   // i18n-ignore: the starter spec record (its file text); shown as t(spec.starter.<id>.*) by main.js
  { id: 'CU-L', name: 'Copper tube, type L', material: 'copper', cls: 'L', sizes: { min: '1/4', max: '4' }, bends: 'short', rating: '',   // i18n-ignore: the starter spec record (its file text); shown as t(spec.starter.<id>.*) by main.js
    valves: { gate: { min: '1/4', max: '4' }, globe: { min: '1/4', max: '2' }, ball: { min: '1/4', max: '4' }, check: { min: '1/4', max: '4' } }, branch: rules(false), notes: 'Soldered or brazed.' },   // i18n-ignore: the starter spec record (its file text); shown as t(spec.starter.<id>.*) by main.js
  { id: 'PVC40', name: 'PVC, Sch 40', material: 'pvc', cls: '40', sizes: { min: '1/2', max: '12' }, bends: 'short', rating: '',   // i18n-ignore: the starter spec record (its file text); shown as t(spec.starter.<id>.*) by main.js
    valves: { gate: { min: '1/2', max: '12' }, ball: { min: '1/2', max: '6' }, check: { min: '1/2', max: '6' } }, branch: rules(false), notes: 'Solvent welded; no globe valves.' },   // i18n-ignore: the starter spec record (its file text); shown as t(spec.starter.<id>.*) by main.js
  { id: 'PEX9', name: 'PEX tubing, SDR 9', material: 'pex', cls: 'SDR9', sizes: { min: '3/8', max: '2' }, bends: 'short', rating: '',   // i18n-ignore: the starter spec record (its file text); shown as t(spec.starter.<id>.*) by main.js
    valves: { ball: { min: '3/8', max: '2' }, check: { min: '3/8', max: '2' } }, branch: rules(false), notes: 'Crimped or expanded fittings.' },   // i18n-ignore: the starter spec record (its file text); shown as t(spec.starter.<id>.*) by main.js
].map((s) => cleanSpec({ ...s, format: SPEC_FORMAT, version: SPEC_VERSION }));

export const specFor = (specs, mat, cls) => specs.find((s) => s.material === mat && s.cls === cls) || null;

export function allowedSizes(spec) {
  const lo = nominal(spec.sizes.min), hi = nominal(spec.sizes.max);
  return sizesFor(spec.material, spec.cls).filter((s) => nominal(s) >= lo - 1e-9 && nominal(s) <= hi + 1e-9);
}

export function valveAllowed(spec, kind, size) {
  const v = spec.valves[kind];
  return !!v && nominal(size) >= nominal(v.min) - 1e-9 && nominal(size) <= nominal(v.max) + 1e-9 && allowedSizes(spec).includes(String(size));
}

/** How a branch of one size is made on a header of another, by the spec's rules; null when the branch is larger than the header. */
export function branchKind(spec, header, branch) {
  const h = nominal(header), b = nominal(branch);
  if (!(h > 0) || !(b > 0) || b > h + 1e-9) return null;
  const ratio = b / h;
  const rule = spec.branch.find((r) => ratio <= r.ratio + 1e-9);
  return rule ? rule.kind : (ratio >= 1 - 1e-9 ? 'tee' : 'reducing-tee');
}

/** Centre-line radius of the spec's elbows in inches: the table's long radius (1.5 × nominal from 3/4), or one nominal size. */
export function bendRadius(spec, size) {
  const p = pipeSize(spec.material, spec.cls, size);
  if (!p) return null;
  return spec.bends === 'short' ? Math.max(nominal(size), p.od) : tableBendRadius(p);
}

/** One run ({ mat, cls, size, valves: [{ s, kind }] }) against a spec. */
export function checkRun(spec, run) {
  const out = [];
  if (!allowedSizes(spec).includes(String(run.size))) out.push({ code: 'spec-size', level: 'error', vars: { size: run.size, spec: spec.id, min: spec.sizes.min, max: spec.sizes.max } });
  for (const v of run.valves || []) {
    if (!valveAllowed(spec, v.kind, run.size)) out.push({ code: 'spec-valve', level: 'error', vars: { kind: v.kind, size: run.size, spec: spec.id } });
  }
  return out;
}

/** Every run against the spec its material and class name. runs: [{ guid, mat, cls, size, valves }]. */
export function checkRuns(specs, runs) {
  const out = [];
  for (const r of runs) {
    const spec = specFor(specs, r.mat, r.cls);
    if (!spec) { out.push({ guid: r.guid, code: 'spec-none', level: 'warning', vars: { mat: r.mat, cls: r.cls } }); continue; }
    for (const f of checkRun(spec, r)) out.push({ guid: r.guid, ...f });
  }
  return out;
}
