#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
/**
 * test-bimcraft-drainage.mjs — sanitary drains sized by fixture units: the tables of NBR 8160 (UHC) and the IPC (DFU), the
 * network (what flows into what, which fixture drains where; mep/drainage.js), and in a building: a water closet and a lavatory
 * drawn to a building drain, sized in Brazilian PVC and in US PVC (mep-model.js drainPlan / sizeDrains, one undo step).
 *   node bin/test-bimcraft-drainage.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'public_html/assets/apps/bimcraft/dev');
const VERBOSE = process.argv.includes('--verbose');
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(spec, ctx, next) {
  if (spec === 'manifold-3d') return { url: ${JSON.stringify(pathToFileURL(path.join(ROOT, 'public_html/assets/vendor/manifold-3d/current/manifold.js')).href)}, shortCircuit: true };
  return next(spec, ctx);
}`), import.meta.url);
(await import(pathToFileURL(path.join(APP, 'i18n.js')).href)).init({ strings: JSON.parse(fs.readFileSync(path.join(APP, 'lang/en.json'), 'utf8')) });
const imp = (f) => import(pathToFileURL(path.join(APP, f)).href);
const WebIFC = await imp('ifc/api.js');
const { IfcModel } = await imp('ifc-model.js');
const { IfcEditor } = await imp('ifc-edit.js');
const { ModelWriter } = await imp('model-write.js');
const OPS = await imp('model-ops.js');
const N = await imp('new-model.js');
const FO = await imp('family-ops.js');
const D = await imp('mep/drainage.js');
const M = await imp('mep-model.js');

let pass = 0, fail = 0;
const ok = (c, m, detail = '') => { if (c) { pass++; if (VERBOSE) console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (detail ? ' (' + detail + ')' : '')); } };
const quiet = (fn) => async (...a) => { const l = console.log, w = console.warn; console.log = console.warn = () => {}; try { return await fn(...a); } finally { console.log = l; console.warn = w; } };

console.log('== the tables (mep/drainage.js)');
ok(D.capacity('br', 40, 0.02) === 3 && D.capacity('br', 50, 0.02) === 6 && D.capacity('br', 75, 0.02) === 20 && D.capacity('br', 100, 0.01) === 160, 'NBR 8160 branches: DN 40 3, DN 50 6, DN 75 20, DN 100 160 UHC');
ok(D.capacity('br', 100, 0.01, 'main') === 180 && D.capacity('br', 100, 0.02, 'main') === 216 && D.capacity('br', 100, 0.04, 'main') === 250 && D.capacity('br', 150, 0.015, 'main') === 700,
  'NBR 8160 building drains: DN 100 180 / 216 / 250 at 1 / 2 / 4 %; DN 150 at 1.5 % reads the 1 % column (700)');
ok(D.capacity('br', 100, 0.004, 'main') === 160 && D.capacity('br', 150, 0.01) === 700, 'too flat for the main table: a DN 100 falls back to the branch table; a DN 150 branch, not in the branch table, reads the main one');
ok(D.capacity('us', 3, 0.25 / 12) === 20 && D.capacity('us', 3, 0.25 / 12, 'main') === 42 && D.capacity('us', 4, 0.125 / 12, 'main') === 180 && D.capacity('us', 1.5, 0.25 / 12) === 3,
  'IPC: a 3" fixture branch 20 DFU, a 3" building drain at 1/4"/ft 42, a 4" at 1/8"/ft 180, 1-1/2" branch 3');
const sizes = [40, 50, 75, 100, 150].map((n) => ({ key: String(n), nominal: n }));
ok(D.smallestSize('br', sizes, 7, { slope: 0.02 }).key === '75' && D.smallestSize('br', sizes, 7, { slope: 0.02, floor: 100 }).key === '100' && D.smallestSize('br', sizes, 5000, { slope: 0.02 }) === null,
  '7 UHC: DN 75; with a water closet upstream: DN 100; 5000 UHC: none of these');

console.log('== the network');
const run = (guid, verts, od = 100) => ({ guid, verts, od });
const net = D.drainNetwork([run('main', [[0, 0, 0], [5000, 0, 0]]), run('a', [[1000, 2000, 0], [1000, 0, 0]], 50), run('b', [[3000, 2000, 0], [3000, 0, 0]], 50), run('c', [[3000, 4000, 0], [3000, 2000, 0]], 50)],
  [{ id: 1, p: [1000, 2000, 0], size: 100, kind: 'wc' }, { id: 2, p: [3000, 4000, 0], size: 40, kind: 'lav' }, { id: 3, p: [3000, 3000, 0], size: 40, kind: 'shower' }, { id: 4, p: [9000, 0, 0], size: 40, kind: 'lav' }]);
const g = (k) => net.get(k);
ok(g('a').down === 'main' && g('b').down === 'main' && g('c').down === 'b' && g('main').down === null && g('main').up.sort().join() === 'a,b', 'a and b flow into the main, c into b');
ok(g('c').uhc === 3 && g('b').uhc === 3 && g('a').uhc === 6 && g('main').uhc === 9 && g('main').dfu === 3 + 1 + 2, 'UHC add up downstream (lavatory 1 + shower 2 on c; water closet 6 on a; 9 on the main); DFU too (6)');
ok(g('main').minDn === 100 && g('b').minDn === 40 && g('main').minIn === 3, 'the main serves a water closet: DN 100 / 3 in. at least');
ok(D.upstreamFirst(net).indexOf('c') < D.upstreamFirst(net).indexOf('b') && D.upstreamFirst(net).indexOf('b') < D.upstreamFirst(net).indexOf('main'), 'sized upstream first');
const loop = D.drainNetwork([run('x', [[0, 0, 0], [1000, 0, 0]]), run('y', [[1000, 0, 0], [0, 0, 0]])], [{ id: 1, p: [500, 0, 0], kind: 'lav' }]);
ok(loop.get('x').uhc === 1 && loop.get('y').uhc === 0, 'two runs flowing into each other: counted once, no endless loop');

// a bathroom: a water closet and a lavatory, their branches into a building drain falling 2 %
async function bathroom(mat, cls, small, tiny) {
  const text = N.newBuilding({ name: 'WC', levels: N.stackLevels(1, 3000, () => 'Ground'), fileName: 'd.ifc', now: new Date('2026-10-23T12:00:00Z') });
  const eng = await quiet(IfcModel.create)(WebIFC, null);
  await quiet((b) => eng.load(b))(new TextEncoder().encode(text));
  const ed = new IfcEditor(WebIFC, eng);
  const L1 = OPS.snapshotModel(ed).levels[0].guid;
  const W = () => new ModelWriter(WebIFC, ed.api, ed.mid);
  ed.modelChange(FO.placeFamily({ storey: L1, family: 'fam-wc', x: 0, y: 0 }), { label: 'WC' });   // drain at (0, 380, 0), down
  ed.modelChange(FO.placeFamily({ storey: L1, family: 'fam-lavatory', x: 1500, y: 0 }), { label: 'Lavatory' });   // drain at (1500, 450, 500), into the wall
  const pr = (points, size, extra = {}) => ed.modelChange(M.placeRun({ storey: L1, kind: 'pipe', system: 'san', mat, cls, size, slope: 0, points, ...extra }), { label: 'Drain' });
  pr([[-500, 2000, -300], [4000, 2000, -300 - 0.02 * 4500]], small, { slope: 0.02, role: 'main', points: [[-500, 2000, -300], [4000, 2000, -300]] });
  pr([[0, 380, 0], [0, 380, -310], [0, 2000, -310]], small);
  pr([[1500, 450, 500], [1500, 1000, 500], [1500, 1000, -340], [1500, 2000, -340]], tiny);
  return { ed, W };
}

console.log('== a bathroom in Brazilian PVC (NBR 8160)');
let B = await bathroom('pvc-esg', 'SN', '75', '40');
let runs = M.readRuns(B.W());
let plan = M.drainPlan(B.W());
const by = (pred) => runs.find(pred);
const main = by((r) => r.role === 'main'), wcRun = by((r) => r.points[0][0] === 0 && r.role !== 'main'), lavRun = by((r) => r.points[0][0] === 1500);
ok(main && wcRun && lavRun && M.readFixturePorts(B.W()).filter((q) => q.system === 'san').every((q) => q.connected), 'three drains drawn, both fixtures\' drains connected');
ok(plan.get(wcRun.guid).units === 6 && plan.get(lavRun.guid).units === 1 && plan.get(main.guid).units === 7, 'UHC: the water closet\'s branch 6, the lavatory\'s 1, the building drain 7', [...plan.values()].map((q) => q.units).join());
ok(plan.get(wcRun.guid).need === '100' && plan.get(wcRun.guid).grow && plan.get(lavRun.guid).need === '40' && !plan.get(lavRun.guid).grow && plan.get(main.guid).need === '100',
  'needed: DN 100 for the water closet (drawn DN 75), DN 40 for the lavatory (as drawn), DN 100 for the building drain');
const n0 = B.ed.changes.length;
B.ed.modelChange(M.sizeDrains(), { label: 'Size the drains' });
runs = M.readRuns(B.W());
ok(B.ed.changes.length === n0 + 1 && runs.find((r) => r.guid === wcRun.guid).size === '100' && runs.find((r) => r.guid === main.guid).size === '100' && runs.find((r) => r.guid === lavRun.guid).size === '40',
  'Size the drains: one undo step; the two too small made DN 100, the lavatory\'s left at DN 40');
const txt = new TextDecoder().decode(B.ed.save());
ok(/'Pipe run DN100 Sanitary drain'/.test(txt) && !/'Pipe run DN75 Sanitary drain'/.test(txt), 'their names follow the size');
ok([...M.drainPlan(B.W()).values()].every((q) => !q.grow), 'sized again: nothing left to change');
B.ed.undo();
ok(M.readRuns(B.W()).find((r) => r.guid === wcRun.guid).size === '75', 'undo: back to DN 75');
// a branch drawn bigger than it needs is left as drawn
B.ed.modelChange(M.changeRun(lavRun.guid, { size: '75' }), { label: 'Change' });
B.ed.modelChange(M.sizeDrains(), { label: 'Size the drains' });
ok(M.readRuns(B.W()).find((r) => r.guid === lavRun.guid).size === '75', 'a drain bigger than it needs is never made smaller');

// a Brazilian building drain is DN 100 at least, even carrying one lavatory
{
  const text = N.newBuilding({ name: 'Lav', levels: N.stackLevels(1, 3000, () => 'Ground'), fileName: 'l.ifc', now: new Date('2026-10-23T12:00:00Z') });
  const eng = await quiet(IfcModel.create)(WebIFC, null);
  await quiet((b) => eng.load(b))(new TextEncoder().encode(text));
  const ed = new IfcEditor(WebIFC, eng), L1 = OPS.snapshotModel(ed).levels[0].guid, W = () => new ModelWriter(WebIFC, ed.api, ed.mid);
  ed.modelChange(FO.placeFamily({ storey: L1, family: 'fam-lavatory', x: 0, y: 0 }), { label: 'Lavatory' });
  ed.modelChange(M.placeRun({ storey: L1, kind: 'pipe', system: 'san', mat: 'pvc-esg', cls: 'SN', size: '40', slope: 0.02, role: 'main', points: [[0, 450, 500], [0, 3000, 500]] }), { label: 'Drain' });
  const q = [...M.drainPlan(W()).values()][0];
  ok(q.units === 1 && q.need === '100' && q.grow, 'a building drain in PVC drain pipe carrying 1 UHC: DN 100 (the smallest building drain of NBR 8160)', JSON.stringify(q));
  ed.modelChange(M.changeRun(M.readRuns(W())[0].guid, { role: 'branch' }), { label: 'Role' });
  ok([...M.drainPlan(W()).values()][0].need === '40', 'the same run as a branch: DN 40');
}

console.log('== the same bathroom in US PVC (IPC)');
B = await bathroom('pvc', '40', '2', '1-1/2');
runs = M.readRuns(B.W());
plan = M.drainPlan(B.W());
const wcU = runs.find((r) => r.points[0][0] === 0 && r.role !== 'main'), lavU = runs.find((r) => r.points[0][0] === 1500), mainU = runs.find((r) => r.role === 'main');
ok(plan.get(wcU.guid).units === 3 && plan.get(lavU.guid).units === 1 && plan.get(mainU.guid).units === 4 && plan.get(wcU.guid).std === 'us', 'DFU: 3 + 1 = 4 on the building drain');
ok(plan.get(wcU.guid).need === '3' && plan.get(lavU.guid).need === '1-1/2' && plan.get(mainU.guid).need === '3', 'needed: 3" for the water closet and the building drain, 1-1/2" for the lavatory', [...plan.values()].map((q) => q.need).join());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
