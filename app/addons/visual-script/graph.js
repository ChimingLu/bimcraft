/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — errors here are codes and developer text; the editor (main.js) says them through api.t. */
/**
 * graph.js — the visual script's graph and how it runs (no DOM, no imports: tests/bin/test-bimcraft-visual-script.mjs runs
 * it in Node with a stand-in for the Draw tools).
 *
 * A graph (what the editor saves, JSON):
 *   { format: 'bimcraft-visual-script', version: 1,
 *     nodes: [{ id: 'n1', type: 'number', x, y, v: { value: 3000, … } }],      v = the values typed into unwired inputs
 *     links: [{ from: 'n1', out: 'value', to: 'n2', in: 'width' }] }             one link per input
 *
 * A node type (nodes.js): { type, cat, inputs: [{ key, kind, default, wire? }], outputs: [{ key, kind }], run(inputs, cx) }.
 * kind says how deep a value nests (DEPTH): a number is 0, a point [x, y] is 1, points (an outline) are 2. A value deeper
 * than its input takes runs the node once per item (the longest list wins; shorter ones repeat their last item), and its
 * outputs become lists — as Dynamo's "longest" lacing. kind 'any' takes whatever comes.
 *
 *   await runGraph(graph, types, cx, { onNode }) → { out: Map(id → outputs), errors: Map(id → message), order: [ids] }
 *   cx is handed to every run(): the editor passes { draw(name, args) → Promise<result>, … }.
 *   A node that fails stops only the nodes downstream of it (their error: 'upstream').
 *   cleanGraph(json, types) → a graph that is safe to keep (unknown types, bad links and values dropped)
 */

export const FORMAT = 'bimcraft-visual-script';
export const VERSION = 1;
export const LIMITS = { nodes: 500, links: 2000, items: 10000 };
export const DEPTH = { number: 0, text: 0, bool: 0, choice: 0, guid: 0, point: 1, numbers: 1, guids: 1, texts: 1, points: 2, any: Infinity };

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/i;
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/i;

/** How deep a value nests: 0 for a plain value, 1 for [x, y], 2 for [[x, y], …]. */
export function depthOf(v) {
  let d = 0;
  while (Array.isArray(v)) { d++; if (!v.length) break; v = v[0]; }
  return d;
}

export function newGraph() { return { format: FORMAT, version: VERSION, nodes: [], links: [] }; }

/** A fresh node id in this graph. */
export function nextId(graph) {
  let n = graph.nodes.length + 1;
  const used = new Set(graph.nodes.map((x) => x.id));
  while (used.has('n' + n)) n++;
  return 'n' + n;
}

/** A plain value kept in v: numbers, text, booleans and short arrays of them. */
function cleanValue(x, depth = 0) {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string') return x.slice(0, 2000);
  if (typeof x === 'boolean') return x;
  if (Array.isArray(x) && depth < 3 && x.length <= 1000) { const a = x.map((y) => cleanValue(y, depth + 1)); return a.includes(null) ? null : a; }
  return null;
}

/** A graph read from a file or storage, made safe: unknown node types, bad ids and links that do not fit are dropped. */
export function cleanGraph(json, types) {
  const g = newGraph();
  if (!json || typeof json !== 'object' || json.format !== FORMAT) return g;
  const byType = types instanceof Map ? types : new Map(types.map((t) => [t.type, t]));
  for (const n of Array.isArray(json.nodes) ? json.nodes.slice(0, LIMITS.nodes) : []) {
    const def = n && byType.get(n.type);
    if (!def || typeof n.id !== 'string' || !ID_RE.test(n.id) || g.nodes.some((x) => x.id === n.id)) continue;
    const v = {};
    for (const inp of def.inputs) if (n.v && Object.prototype.hasOwnProperty.call(n.v, inp.key)) { const c = cleanValue(n.v[inp.key]); if (c !== null) v[inp.key] = c; }
    g.nodes.push({ id: n.id, type: n.type, x: Number.isFinite(n.x) ? n.x : 0, y: Number.isFinite(n.y) ? n.y : 0, v });
  }
  const node = (id) => g.nodes.find((x) => x.id === id);
  for (const l of Array.isArray(json.links) ? json.links.slice(0, LIMITS.links) : []) {
    if (!l || !KEY_RE.test(String(l.out)) || !KEY_RE.test(String(l.in))) continue;
    const a = node(l.from), b = node(l.to);
    if (!a || !b || a === b) continue;
    if (!byType.get(a.type).outputs.some((o) => o.key === l.out)) continue;
    const inp = byType.get(b.type).inputs.find((i) => i.key === l.in);
    if (!inp || inp.wire === false) continue;
    if (g.links.some((x) => x.to === l.to && x.in === l.in)) continue;
    g.links.push({ from: l.from, out: l.out, to: l.to, in: l.in });
  }
  if (cycleIn(g)) g.links = [];
  return g;
}

/** Link two ports: replaces the link the input had. → false (nothing changed) when it would close a loop. */
export function connect(graph, from, out, to, inKey) {
  if (from === to) return false;
  const next = { ...graph, links: [...graph.links.filter((l) => !(l.to === to && l.in === inKey)), { from, out, to, in: inKey }] };
  if (cycleIn(next)) return false;
  graph.links = next.links;
  return true;
}

export function disconnect(graph, to, inKey) { graph.links = graph.links.filter((l) => !(l.to === to && l.in === inKey)); }

export function removeNode(graph, id) {
  graph.nodes = graph.nodes.filter((n) => n.id !== id);
  graph.links = graph.links.filter((l) => l.from !== id && l.to !== id);
}

/** The nodes in an order where every node comes after the ones feeding it. → null when the links loop. */
export function order(graph) {
  const ins = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (const l of graph.links) ins.set(l.to, (ins.get(l.to) || 0) + 1);
  const queue = graph.nodes.filter((n) => !ins.get(n.id)).map((n) => n.id), out = [];
  while (queue.length) {
    const id = queue.shift();
    out.push(id);
    for (const l of graph.links) if (l.from === id) { ins.set(l.to, ins.get(l.to) - 1); if (!ins.get(l.to)) queue.push(l.to); }
  }
  return out.length === graph.nodes.length ? out : null;
}
const cycleIn = (g) => order(g) === null;

/** Run one node over its inputs, lacing lists that nest deeper than the inputs take. */
async function laced(def, vals, cx, count) {
  const extra = def.inputs.map((i) => (DEPTH[i.kind] === Infinity ? 0 : Math.max(0, depthOf(vals[i.key]) - (DEPTH[i.kind] ?? 0))));
  if (!extra.some((e) => e > 0)) { count.n++; if (count.n > LIMITS.items) throw new Error('too-many'); return { one: await def.run(vals, cx) }; }
  const listed = def.inputs.filter((i, k) => extra[k] > 0);
  const n = Math.max(...listed.map((i) => vals[i.key].length));
  const each = [];
  for (let k = 0; k < n; k++) {
    const sub = { ...vals };
    for (const i of listed) { const a = vals[i.key]; sub[i.key] = a.length ? a[Math.min(k, a.length - 1)] : undefined; }
    const r = await laced(def, sub, cx, count);
    each.push(r.one ?? r.many);
  }
  return { many: each };
}

/** A list of output objects → one output object of lists (recursively for nested lacing). */
function gather(def, r) {
  if (r.one) return r.one;
  const flip = (list) => {
    const o = {};
    for (const out of def.outputs) o[out.key] = list.map((x) => (Array.isArray(x) ? flip(x)[out.key] : x?.[out.key]));
    return o;
  };
  return flip(r.many);
}

/** Run the whole graph. */
export async function runGraph(graph, types, cx = {}, { onNode } = {}) {
  const byType = types instanceof Map ? types : new Map(types.map((t) => [t.type, t]));
  const out = new Map(), errors = new Map();
  const seq = order(graph);
  if (!seq) throw new Error('loop');
  const count = { n: 0 };
  for (const id of seq) {
    const node = graph.nodes.find((n) => n.id === id), def = byType.get(node.type);
    const vals = {};
    let blocked = false;
    for (const inp of def.inputs) {
      const l = graph.links.find((x) => x.to === id && x.in === inp.key);
      if (l) { if (errors.has(l.from)) { blocked = true; break; } vals[inp.key] = out.get(l.from)?.[l.out]; }
      else vals[inp.key] = Object.prototype.hasOwnProperty.call(node.v || {}, inp.key) ? node.v[inp.key] : inp.default;
    }
    if (blocked) { errors.set(id, 'upstream'); onNode?.(id, null, 'upstream'); continue; }
    try {
      const r = gather(def, await laced(def, vals, cx, count));
      out.set(id, r);
      onNode?.(id, r, null);
    } catch (e) {
      const msg = String(e?.message || e);
      errors.set(id, msg);
      onNode?.(id, null, msg);
    }
  }
  return { out, errors, order: seq };
}

/** Every GlobalId in a node's outputs (what the Draw nodes made), flattened. */
export function guidsIn(outputs, keys) {
  const acc = [];
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (typeof v === 'string' && v) acc.push(v); };
  for (const k of keys) walk(outputs?.[k]);
  return acc;
}
