#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
/**
 * test-bimcraft-pipes-br.mjs — the Brazilian pipe tables (mep/tables-br.js: PVC soldável NBR 5648, PVC esgoto NBR 5688 série
 * normal and reforçada, drain slopes of NBR 8160) and the catalog that puts them beside the US ones (mep/pipes.js): sizes in
 * order, runs drawn with them (mep-model.js) and what the IFC file gets. On a new building made here (IFC4, mm).
 *   node bin/test-bimcraft-pipes-br.mjs [--verbose]
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
const BR = await imp('mep/tables-br.js');
const P = await imp('mep/pipes.js');
const M = await imp('mep-model.js');

let pass = 0, fail = 0;
const ok = (c, m, detail = '') => { if (c) { pass++; if (VERBOSE) console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (detail ? ' (' + detail + ')' : '')); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const quiet = (fn) => async (...a) => { const l = console.log, w = console.warn; console.log = console.warn = () => {}; try { return await fn(...a); } finally { console.log = l; console.warn = w; } };

console.log('== the tables (mep/tables-br.js)');
let p = BR.brPipeSize('pvc-sold', 'PN750', '25');
ok(p && p.odMm === 25 && p.wallMm === 1.7 && near(p.id * 25.4, 21.6) && p.dn === 25 && p.label === 'DN25' && p.ref === '3/4', 'PVC soldável DN 25: 25 × 1.7 (NBR 5648), bore 21.6, "3/4" reference size', JSON.stringify(p));
ok(BR.brSizesFor('pvc-sold', 'PN750').join() === '20,25,32,40,50,60,75,85,110', 'PVC soldável: DN 20 to 110, smallest first');
p = BR.brPipeSize('pvc-esg', 'SN', '100');
ok(p && p.odMm === 101.6 && p.wallMm === 1.8 && p.label === 'DN100', 'PVC esgoto série normal DN 100: 101.6 × 1.8 (NBR 5688)');
ok(BR.brPipeSize('pvc-esg', 'SR', '100').wallMm === 2.5 && BR.brPipeSize('pvc-esg', 'SR', '200') === null && BR.brPipeSize('pvc-esg', 'SN', '200').odMm === 200, 'série reforçada DN 100: wall 2.5; DN 200 made in série normal only');
ok(BR.brSizesFor('pvc-esg', 'SN').join() === '40,50,75,100,150,200' && BR.brPipeSize('pvc-sold', 'PN750', '22') === null && BR.brPipeSize('pvc-sold', 'SN', '25') === null, 'sizes not made: refused');
ok(BR.brDrainSlope(40) === 0.02 && BR.brDrainSlope(75) === 0.02 && BR.brDrainSlope(100) === 0.01 && BR.brDrainSlope(150) === 0.01, 'NBR 8160 drain slopes: 2 % up to DN 75, 1 % from DN 100');

console.log('== the catalog (mep/pipes.js)');
ok(P.MATERIALS.includes('pvc-sold') && P.MATERIALS.includes('pvc-esg') && P.MATERIALS.includes('copper') && P.DEFAULT_CLASS['pvc-esg'] === 'SN', 'US and Brazilian materials side by side');
ok(P.sizesFor('pvc', '40').slice(0, 4).join() === '1/2,3/4,1,1-1/4' && P.sizesFor('steel', '40').at(-1) === '24', 'US sizes smallest first (the table lists "1", "2" … before "1/2")');
ok(P.standardOf('pvc-esg') === 'br' && P.standardOf('copper') === 'us', 'the standard follows the material');
ok(near(P.drainSlope(P.pipeSize('pvc-esg', 'SN', '75')), 0.02) && near(P.drainSlope(P.pipeSize('pvc', '40', '3')), 0.125 / 12), 'drain slope by the material\'s code: NBR 8160 for DN 75 PVC esgoto, IPC for 3" PVC Schedule 40');

console.log('== runs (mep-model.js)');
const s = M.sectionOf({ kind: 'pipe', mat: 'pvc-esg', cls: 'SN', size: '100' });
ok(near(s.od, 101.6, 1e-6) && near(s.wall, 1.8, 1e-6) && s.label === 'DN100' && near(s.R, 101.6, 1e-6), 'a DN 100 drain: 101.6 outside, labelled DN100, bends at one outside diameter');
let d = M.runDefaults('pipe', 'san', undefined, 'br');
ok(d.mat === 'pvc-esg' && d.cls === 'SN' && d.size === '100' && near(d.slope, 0.01), 'a new sanitary run in Brazil: PVC esgoto série normal DN 100 at 1 %', JSON.stringify(d));
d = M.runDefaults('pipe', 'cw', undefined, 'br');
ok(d.mat === 'pvc-sold' && d.size === '25' && d.slope === 0, 'cold water in Brazil: PVC soldável DN 25');
d = M.runDefaults('pipe', 'san');
ok(d.mat === 'pvc' && d.cls === '40' && d.size === '3' && near(d.slope, 0.125 / 12), 'without a standard, as before: PVC Schedule 40, 3", 1/8"/ft');
ok(near(M.drainMinimum({ kind: 'pipe', system: 'san', mat: 'pvc-esg', cls: 'SN', size: '50' }), 0.02), 'drain minimum of a DN 50 PVC esgoto run: 2 %');
const f = M.pipeForFlow('pvc-sold', 'PN750', 1.0, 3, 'mm');
ok(f && f.size === '25' && f.v <= 3, '1 L/s at 3 m/s or less (NBR 5626): DN 25 (DN 20 would run at 4.4 m/s)', JSON.stringify(f));

const text = N.newBuilding({ name: 'BR', levels: N.stackLevels(1, 3000, () => 'Térreo'), fileName: 'br.ifc', now: new Date('2026-10-23T12:00:00Z') });
const eng = await quiet(IfcModel.create)(WebIFC, null);
await quiet((b) => eng.load(b))(new TextEncoder().encode(text));
const ed = new IfcEditor(WebIFC, eng);
const L1 = OPS.snapshotModel(ed).levels[0].guid;
ed.modelChange(M.placeRun({ storey: L1, kind: 'pipe', system: 'san', mat: 'pvc-esg', cls: 'SN', size: '100', slope: 0.01, points: [[0, 0, -300], [4000, 0, -300], [4000, 3000, -300]] }), { label: 'Pipe run' });
ed.modelChange(M.placeRun({ storey: L1, kind: 'pipe', system: 'cw', mat: 'pvc-sold', cls: 'PN750', size: '25', points: [[0, 1000, 2400], [3000, 1000, 2400]] }), { label: 'Pipe run' });
const w = new ModelWriter(WebIFC, ed.api, ed.mid);
const runs = M.readRuns(w);
ok(runs.length === 2 && runs[0].parts.length === 3, 'two runs drawn; the drain: segment, elbow, segment');
const txt = new TextDecoder().decode(ed.save());
ok(/'Pipe: PVC drain pipe, series SN, NBR 5688'/.test(txt) && /'Pipe: PVC water pipe, NBR 5648'/.test(txt), 'their types are named by the Brazilian pipe');
ok(/'Elbow DN100 Sanitary drain'/.test(txt) && /IFCPOSITIVELENGTHMEASURE\(100\.\)/.test(txt) && /IFCPOSITIVELENGTHMEASURE\(101\.6\)/.test(txt), 'parts named by DN; Pset_PipeSegmentTypeCommon: nominal 100, outside 101.6', (txt.match(/'[^']*DN100[^']*'/g) || []).slice(0, 2).join(' '));
const sch = M.runSchedules(w);
ok(sch.pipes.length === 2 && sch.pipes.find((x) => x.mat === 'pvc-esg').size === '100', 'the Pipes schedule lists them by material and DN');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
