/* SPDX-License-Identifier: Apache-2.0 */
/**
 * shading/compile-js.js — a material graph → a JS evaluator over the tile (0.7 MT.1): the reference the WGSL bake is checked
 * against. No DOM. Each node becomes a closure made once (its settings already read); a node's outputs are kept for the last
 * (u, v) asked, so a node read by several others runs once per texel. Nothing is allocated per texel (KICKOFF rule 18).
 *
 *   compileJS(graph, ctx) → {input(id) → (u, v) => value, linked(id) → bool, output: node}
 *     ctx = {size (texels across the tile), tile: [w, h] metres, image(key) → {w, h, data} | null}
 *     input(id) is the material output's input `id`, converted to its own kind (f number, c/v3 [x, y, z], v2 [x, y]); unlinked
 *     inputs give their constant.
 *   convertJs(fromKind, toKind) → (value) => value     constValue(input, value) → the constant an unlinked input holds
 */
import { nodeType } from './nodes.js';
import { hexLinear, luminance } from './lib.js';
import { outputNode } from './graph.js';

export function constValue(inp, v) {
  if (inp.kind === 'c') return typeof v === 'string' ? hexLinear(v) : Array.isArray(v) ? v.slice(0, 3) : hexLinear('#cccccc');
  if (inp.kind === 'v3') return Array.isArray(v) ? v.slice(0, 3) : [0, 0, 1];
  if (inp.kind === 'v2') return Array.isArray(v) ? v.slice(0, 2) : [0, 0];
  return Number.isFinite(v) ? v : 0;
}

/** A converter between socket kinds (writes into its own buffer when the result is a vector). */
export function convertJs(from, to) {
  if (from === to || ((from === 'c' || from === 'v3') && (to === 'c' || to === 'v3'))) return (x) => x;
  const b3 = [0, 0, 0], b2 = [0, 0];
  if (from === 'f') return to === 'v2' ? (x) => { b2[0] = b2[1] = x; return b2; } : (x) => { b3[0] = b3[1] = b3[2] = x; return b3; };
  if (to === 'f') return from === 'c' ? (x) => luminance(x) : from === 'v3' ? (x) => (x[0] + x[1] + x[2]) / 3 : (x) => (x[0] + x[1]) / 2;
  if (to === 'v2') return (x) => { b2[0] = x[0]; b2[1] = x[1]; return b2; };
  return (x) => { b3[0] = x[0]; b3[1] = x[1]; b3[2] = 0; return b3; };   // v2 → c / v3
}

export function compileJS(graph, ctx) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const runs = new Map();
  const linkOf = (nid, iid) => graph.links.find((l) => l.to[0] === nid && l.to[1] === iid) || null;

  function inputFn(n, inp, visiting) {
    const l = linkOf(n.id, inp.id);
    if (l && byId.has(l.from[0])) {
      const src = byId.get(l.from[0]), st = nodeType(src.type), so = st.outputs.find((o) => o.id === l.from[1]);
      if (so) {
        const run = nodeRun(src.id, visiting), conv = convertJs(so.kind, inp.kind), key = so.id;
        return (u, v) => conv(run(u, v)[key]);
      }
    }
    if (inp.def === 'uv') { const b = [0, 0]; return (u, v) => { b[0] = u; b[1] = v; return b; }; }
    const c = constValue(inp, n.values ? n.values[inp.id] : undefined);
    return () => c;
  }

  function nodeRun(id, visiting = new Set()) {
    if (runs.has(id)) return runs.get(id);
    if (visiting.has(id)) throw new Error('cycle');   // i18n-ignore: cleanGraph removes cycles; a programming error
    visiting.add(id);
    const n = byId.get(id), t = nodeType(n.type);
    const O = {};
    for (const o of t.outputs) O[o.id] = o.kind === 'f' ? 0 : o.kind === 'v2' ? [0, 0] : [0, 0, 0];
    const acc = {};
    for (const inp of t.inputs) acc[inp.id] = inputFn(n, inp, visiting);
    let cu = NaN, cv = NaN;
    const I = (iid) => acc[iid](cu, cv);
    I.at = (iid, u, v) => acc[iid](u, v);
    // the outputs something reads (a node may skip working out the others: Noise's colour costs two more noises)
    const used = new Set(graph.links.filter((l) => l.from[0] === id).map((l) => l.from[1]));
    const fn = t.js(n.params || {}, { ...ctx, used });
    const run = (u, v) => {
      if (u === cu && v === cv) return O;
      cu = u; cv = v;
      fn(u, v, I, O);
      return O;
    };
    runs.set(id, run);
    visiting.delete(id);
    return run;
  }

  const out = outputNode(graph), ot = nodeType('output'), fns = new Map();
  for (const inp of ot.inputs) fns.set(inp.id, inputFn(out, inp, new Set()));
  return {
    output: out,
    input: (id) => fns.get(id),
    linked: (id) => !!linkOf(out.id, id),
  };
}
