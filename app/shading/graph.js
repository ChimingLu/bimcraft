/* SPDX-License-Identifier: Apache-2.0 */
/**
 * shading/graph.js — a material graph as data (0.7 MT.1). No DOM. The editor edits this, files carry it, the compilers read it.
 *
 *   graph = {format: 'cc-material', version: 1, name, nodes: [{id, type, x, y, values: {input: value}, params: {param: value}}],
 *            links: [{from: [nodeId, outputId], to: [nodeId, inputId]}]}
 *   newGraph(name) → a graph with one material output (grey, roughness 0.5)
 *   cleanGraph(untrusted) → {graph, dropped}   the only way a graph from a file, the clipboard or the library gets in: unknown
 *                            types, bad values and links, a second output, cycles and anything over the limits are left out
 *                            (counted in `dropped`); values are clamped to their sockets' ranges
 *   outputNode(graph) → node     linkInto(graph, nodeId, inputId) → link | null     nextId(graph) → int
 *   wouldCycle(graph, fromNode, toNode) → bool   order(graph) → [node] (inputs before the nodes that read them)
 *   LIMITS {nodes, links, name}
 */
import { nodeType, defaultValues, defaultParams, cleanStops } from './nodes.js';

export const FORMAT = 'cc-material';
export const VERSION = 1;
export const LIMITS = Object.freeze({ nodes: 256, links: 1024, name: 80 });
const HEX = /^#[0-9a-f]{6}$/i;
const KEY = /^[a-z0-9][a-z0-9:_.-]{0,95}$/i;

export function newGraph(name = '') {
  return { format: FORMAT, version: VERSION, name: String(name).slice(0, LIMITS.name),
    nodes: [{ id: 1, type: 'output', x: 360, y: 40, values: defaultValues('output'), params: defaultParams('output') }], links: [] };
}
export const outputNode = (g) => g.nodes.find((n) => n.type === 'output') || null;
export const nextId = (g) => g.nodes.reduce((m, n) => Math.max(m, n.id), 0) + 1;
export const linkInto = (g, nodeId, inputId) => g.links.find((l) => l.to[0] === nodeId && l.to[1] === inputId) || null;

const num = (x, lo, hi, d) => { const v = Number(x); return Number.isFinite(v) ? Math.min(hi ?? 1e9, Math.max(lo ?? -1e9, v)) : d; };

function cleanValue(inp, x) {
  if (inp.kind === 'c') {
    // '#rrggbb' (sRGB, what the editor writes) or [r, g, b] linear Rec.709 (exact: MaterialX imports, a normal map's flat colour)
    if (typeof x === 'string' && HEX.test(x)) return x.toLowerCase();
    if (Array.isArray(x) && x.length === 3 && x.every(Number.isFinite)) return x.map((k) => num(k, 0, 1e6, 0));
    return Array.isArray(inp.def) ? inp.def.slice() : inp.def;
  }
  if (inp.kind === 'v3') return Array.isArray(x) && x.length === 3 && x.every(Number.isFinite) ? x.map((k) => num(k, -1e6, 1e6, 0)) : inp.def.slice();
  if (inp.kind === 'f') return num(x, inp.min, inp.max, inp.def);
  return undefined;
}
function cleanParam(p, x) {
  switch (p.kind) {
    case 'enum': return p.options.includes(String(x)) ? String(x) : p.def;
    case 'int': return Math.round(num(x, p.min, p.max, p.def));
    case 'float': return num(x, p.min, p.max, p.def);
    case 'bool': return x === true;
    case 'color': return typeof x === 'string' && HEX.test(x) ? x.toLowerCase() : p.def;
    case 'image': case 'library': return typeof x === 'string' && (x === '' || KEY.test(x)) ? x : p.def;
    case 'stops': return cleanStops(x);
    default: return p.def;
  }
}

/** One node from untrusted data (its id is checked by the caller) | null. */
export function cleanNode(n) {
  const t = n && nodeType(n.type);
  if (!t) return null;
  const values = {}, params = {};
  for (const i of t.inputs) if (i.def !== 'uv') values[i.id] = cleanValue(i, n.values ? n.values[i.id] : undefined);
  for (const p of t.params) params[p.id] = cleanParam(p, n.params ? n.params[p.id] : undefined);
  return { id: n.id, type: t.type, x: num(n.x, -1e5, 1e5, 0), y: num(n.y, -1e5, 1e5, 0), values, params };
}

export function wouldCycle(g, from, to) {
  if (from === to) return true;
  // is `from` reachable downstream of `to`?
  const seen = new Set([to]), stack = [to];
  while (stack.length) {
    const a = stack.pop();
    for (const l of g.links) if (l.from[0] === a) { if (l.to[0] === from) return true; if (!seen.has(l.to[0])) { seen.add(l.to[0]); stack.push(l.to[0]); } }
  }
  return false;
}

export function cleanGraph(j) {
  let dropped = 0;
  const g = { format: FORMAT, version: VERSION, name: typeof j?.name === 'string' ? j.name.slice(0, LIMITS.name) : '', nodes: [], links: [] };
  if (!j || typeof j !== 'object' || j.format !== FORMAT) return { graph: newGraph(g.name), dropped: 1 };
  const ids = new Set();
  let haveOut = false;
  for (const n of Array.isArray(j.nodes) ? j.nodes : []) {
    if (g.nodes.length >= LIMITS.nodes) { dropped++; continue; }
    if (!n || !Number.isInteger(n.id) || n.id < 1 || n.id > 1e6 || ids.has(n.id)) { dropped++; continue; }
    const c = cleanNode(n);
    if (!c || (c.type === 'output' && haveOut)) { dropped++; continue; }
    if (c.type === 'output') haveOut = true;
    ids.add(c.id); g.nodes.push(c);
  }
  if (!haveOut) { const o = newGraph().nodes[0]; o.id = nextId(g); g.nodes.push(o); }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  for (const l of Array.isArray(j.links) ? j.links : []) {
    if (g.links.length >= LIMITS.links) { dropped++; continue; }
    const ok = l && Array.isArray(l.from) && Array.isArray(l.to) && byId.has(l.from[0]) && byId.has(l.to[0]);
    const tf = ok && nodeType(byId.get(l.from[0]).type), tt = ok && nodeType(byId.get(l.to[0]).type);
    if (!ok || !tf.outputs.some((o) => o.id === l.from[1]) || !tt.inputs.some((i) => i.id === l.to[1]) || wouldCycle(g, l.from[0], l.to[0])) { dropped++; continue; }
    const old = linkInto(g, l.to[0], l.to[1]);
    if (old) { g.links.splice(g.links.indexOf(old), 1); dropped++; }
    g.links.push({ from: [l.from[0], l.from[1]], to: [l.to[0], l.to[1]] });
  }
  return { graph: g, dropped };
}

/** The nodes in an order where every node comes after the nodes it reads (only those the output depends on, then the rest). */
export function order(g) {
  const byId = new Map(g.nodes.map((n) => [n.id, n])), out = [], state = new Map();
  const visit = (id) => {
    if (state.get(id)) return;
    state.set(id, 1);
    for (const l of g.links) if (l.to[0] === id) visit(l.from[0]);
    out.push(byId.get(id));
  };
  const o = outputNode(g);
  if (o) visit(o.id);
  for (const n of g.nodes) visit(n.id);
  return out;
}
