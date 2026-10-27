#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0 */
/**
 * test-bimcraft-visual-script.mjs — the visual script add-on (addons/visual-script) and the add-on API's draw (1.1):
 *   1. graph.js on its own: order, loops refused, lacing (a list where one value goes runs the node per item), an error
 *      stopping only what is downstream, cleanGraph dropping what does not fit — the Draw tools a stand-in.
 *   2. the example graph through api.draw on a new building (cc-ifc in Node): four walls round a room, a floor, a door, one
 *      undo step each under the add-on's name; run again with a wider slider after draw.remove = still one room, wider;
 *      draw.remove refuses what the add-on did not make; no "draw" permission = refused.
 * Runs from a clean clone (`npm test`) or the site's layout (bin/ beside public_html/).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const APP = [path.join(ROOT, 'public_html/assets/apps/bimcraft/dev'), path.join(ROOT, '../app'), path.join(ROOT, 'app')].find((d) => fs.existsSync(path.join(d, 'addons/visual-script/graph.js')));
const imp = (p) => import(pathToFileURL(path.join(APP, p)).href);
let bad = 0, good = 0;
const ok = (cond, label, detail = '') => { if (cond) good++; else bad++; console.log((cond ? '  ok   ' : '  FAIL ') + label + (!cond && detail ? ' (' + detail + ')' : '')); };

const G = await imp('addons/visual-script/graph.js');
const { NODE_TYPES, exampleGraph } = await imp('addons/visual-script/nodes.js');
const types = new Map(NODE_TYPES.map((t) => [t.type, t]));

// ------------------------------------------------------------------ 1. the graph on its own
console.log('== graph.js');
{
  const calls = [];
  let k = 0;
  const cx = { draw: async (name, a) => { calls.push([name, a]); if (name === 'walls_add') return { walls: a.points.map(() => 'W' + k++) }; if (name === 'floor_add') return { floor: 'F' + k++ }; if (name === 'opening_add') return { [a.kind]: 'O' + k++ }; if (name === 'model_describe') return { levels: [{ name: 'Level 1' }], walls: { count: 4 }, rooms: [{ area: 24 }] }; return {}; } };
  let g = G.cleanGraph(exampleGraph(), types);
  ok(g.nodes.length === 9 && g.links.length === 8, 'the example graph is kept whole by cleanGraph');
  let r = await G.runGraph(g, types, cx);
  ok(!r.errors.size && calls.map((c) => c[0]).join() === 'walls_add,floor_add,opening_add,model_describe', 'runs in order: walls, floor, door, summary', calls.map((c) => c[0]).join());
  ok(JSON.stringify(calls[0][1].points) === '[[0,0],[6000,0],[6000,4000],[0,4000]]' && calls[0][1].closed === true, 'the walls go round the 6000 × 4000 rectangle the sliders make');
  ok(calls[2][1].wall === 'W0' && r.out.get('n8').value[0] === 24, 'the door goes in the first wall; Watch shows the room area');

  // lacing: a series of origins → one rectangle per origin → one walls_add per rectangle
  g = G.newGraph();
  g.nodes.push({ id: 's', type: 'series', x: 0, y: 0, v: { start: 0, step: 8000, count: 3 } }, { id: 'p', type: 'point', x: 0, y: 0, v: {} }, { id: 'r', type: 'rectangle', x: 0, y: 0, v: {} }, { id: 'w', type: 'walls', x: 0, y: 0, v: {} });
  ok(G.connect(g, 's', 'list', 'p', 'x') && G.connect(g, 'p', 'point', 'r', 'origin') && G.connect(g, 'r', 'points', 'w', 'points'), 'connect: series → point → rectangle → walls');
  ok(!G.connect(g, 'w', 'walls', 's', 'start'), 'a wire that closes a loop is refused');
  calls.length = 0;
  r = await G.runGraph(g, types, cx);
  ok(calls.length === 3 && calls[2][1].points[0][0] === 16000 && r.out.get('w').walls.length === 3 && r.out.get('w').walls[0].length === 4, 'three origins: three rooms of four walls (lists lace like Dynamo\'s longest)', JSON.stringify(r.out.get('w')));

  // an error stops only what is downstream
  g = G.newGraph();
  g.nodes.push({ id: 'a', type: 'rectangle', x: 0, y: 0, v: { width: -1 } }, { id: 'b', type: 'walls', x: 0, y: 0, v: {} }, { id: 'c', type: 'number', x: 0, y: 0, v: { value: 5 } });
  G.connect(g, 'a', 'points', 'b', 'points');
  r = await G.runGraph(g, types, cx);
  ok(r.errors.get('a') === 'size' && r.errors.get('b') === 'upstream' && r.out.get('c').value === 5, 'a bad size: its node and the walls after it fail; the others run');
  // formulas
  g = G.newGraph();
  g.nodes.push({ id: 'e', type: 'expression', x: 0, y: 0, v: { formula: 'a * 2 + 1m', a: 500 } });
  r = await G.runGraph(g, types, cx);
  ok(r.out.get('e').value === 2000, 'Formula uses the family editor\'s language (units: 1m = 1000)');
  // cleanGraph drops what does not fit
  g = G.cleanGraph({ format: G.FORMAT, nodes: [{ id: 'a', type: 'number', v: { value: 1, junk: { x: 1 } } }, { id: 'b', type: 'nope' }, { id: 'a', type: 'text' }, { id: 'c', type: 'watch' }],
    links: [{ from: 'a', out: 'value', to: 'c', in: 'value' }, { from: 'a', out: 'value', to: 'c', in: 'value' }, { from: 'b', out: 'x', to: 'c', in: 'value' }] }, types);
  ok(g.nodes.map((n) => n.id).join() === 'a,c' && g.links.length === 1 && !('junk' in g.nodes[0].v), 'cleanGraph: unknown types, repeated ids, extra and dangling links, unknown values dropped');
  ok(G.cleanGraph({ format: 'other' }, types).nodes.length === 0, 'cleanGraph: another format → an empty graph');
}

// ------------------------------------------------------------------ 2. through api.draw on a real model
console.log('== api.draw (add-on API 1.1) on a new building');
const vendor = [path.join(ROOT, 'public_html/assets/vendor/manifold-3d/current/manifold.js'), path.join(APP, '../devshell/vendor/manifold-3d/3.5.4/manifold.js')].find((f) => fs.existsSync(f));
if (!vendor) console.log('  (skipped: manifold-3d is not here — run npm test, which fetches it)');
else {
  register('data:text/javascript,' + encodeURIComponent(`export async function resolve(spec, ctx, next) {
    if (spec === 'manifold-3d') return { url: ${JSON.stringify(pathToFileURL(vendor).href)}, shortCircuit: true };
    return next(spec, ctx);
  }`), import.meta.url);
  if (fs.existsSync(path.join(APP, 'lang/en.json'))) (await imp('i18n.js')).init({ strings: JSON.parse(fs.readFileSync(path.join(APP, 'lang/en.json'), 'utf8')) });
  const WebIFC = await imp('ifc/api.js');
  const { IfcModel } = await imp('ifc-model.js');
  const N = await imp('new-model.js');
  const { IfcEditor } = await imp('ifc-edit.js');
  const { snapshotModel } = await imp('model-ops.js');
  const { makeBimcraftApi } = await imp('addons/bimcraft-api.js');
  const quiet = (fn) => async (...a) => { const l = console.log, w = console.warn; console.log = console.warn = () => {}; try { return await fn(...a); } finally { console.log = l; console.warn = w; } };
  const text = N.newBuilding({ name: 'VS', levels: N.stackLevels(2, 3000, (i) => 'Level ' + (i + 1)), fileName: 'vs.ifc', now: new Date('2026-10-27T12:00:00Z') });
  const eng = await quiet(IfcModel.create)(WebIFC, null);
  await quiet((b) => eng.load(b))(new TextEncoder().encode(text));
  const ed = new IfcEditor(WebIFC, eng);
  const addonApi = (permissions) => makeBimcraftApi({ onDeactivate() {}, log() {} }, { id: 'visual-script', manifest: { name: 'Visual script', permissions } }, {
    registry: { importers: new Map(), exporters: new Map(), changed() {} }, changeListeners: new Set(), commands: new Map(), props: new Map(), tabs: new Map(),
    draw: { ed: () => ed, apply: async (label, op, prefix) => ed.modelChange(op, { label: prefix + label }) },
  });
  const api = addonApi(['draw']);
  ok(api.draw.tools().map((d) => d.name).join() === 'model_describe,walls_list,walls_add,opening_add,floor_add,levels_add,grid_add', 'draw.tools(): the assistant\'s Draw tools with their schemas');
  await assert.rejects(() => addonApi(['model']).draw.run('model_describe'), /permissions/);
  ok(true, 'without "draw" in its permissions an add-on is refused');
  const cx = { draw: (name, a) => api.draw.run(name, a) };
  const g = G.cleanGraph(exampleGraph(), types);
  let r = await G.runGraph(g, types, cx);
  ok(!r.errors.size, 'the example graph runs on the model', JSON.stringify([...r.errors]));
  let snap = snapshotModel(ed);
  const room = r.out.get('n8').value;
  ok(snap.walls.length === 4 && snap.openings.length === 1 && room.length === 1 && room[0] > 20 && room[0] < 24, 'four walls, a door and one room inside the 6 × 4 m walls (' + room[0] + ' m²)');
  ok(ed.changes.map((c) => c.label).join('|') === 'Visual script: add 4 walls|Visual script: add a floor|Visual script: add a door', 'one undo step each, under the add-on\'s name', ed.changes.map((c) => c.label).join('|'));
  const first = api.draw.made();
  ok(first.length >= 6, 'draw.made(): what it made (' + first.length + ' GlobalIds)');
  await assert.rejects(() => api.draw.remove([snapshotModel(ed).levels[0].guid]), /only what this add-on made/);
  ok(true, 'draw.remove refuses a GlobalId the add-on did not make');
  // run again, wider: remove what the first run made, then the graph again
  await api.draw.remove(first);
  snap = snapshotModel(ed);
  ok(snap.walls.length === 0 && snap.openings.length === 0 && ed.changes.at(-1).label === 'Visual script: remove ' + first.length + ' elements', 'draw.remove: walls, door and floor gone in one undo step');
  g.nodes.find((n) => n.id === 'n1').v.value = 8000;
  r = await G.runGraph(g, types, cx);
  snap = snapshotModel(ed);
  const room2 = r.out.get('n8').value;
  ok(!r.errors.size && snap.walls.length === 4 && room2.length === 1 && room2[0] - room[0] > 7, 'run again with the width slider at 8000: still one room, 2 m wider (' + room2 + ' m²)');
  ok(new TextDecoder().decode(ed.save()).includes('IFCWALL'), 'the model saves with the walls');
}

console.log(`${good} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
