/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: WGSL source, never shown */
/**
 * shading/compile-wgsl.js — a material graph → a WGSL compute shader that bakes its layers on the GPU (0.7 MT.1; RENDER-SPEC
 * § 6.6). No DOM. The same graph as compile-js.js, node by node (each node's `wgsl` beside its `js` in nodes.js), so the GPU's
 * bytes equal the reference's to within f32 rounding (± 1 level; tools/shading-test/browser.mjs checks it).
 *
 *   compileWGSL(graph, {size, tile: [w, h] metres, imageKeys: [key]}) → {code, plan, bindings: {images?, base?, data?, emit?, height?}}
 *     one invocation per texel (workgroups of 8 × 8); writes the layers the plan needs as packed RGBA8 words (u32, little end
 *     first: the same bytes as a Uint8Array) and the height as f32. Pictures: a texture_2d_array of IMG_SIZE² layers in
 *     `imageKeys` order, read with textureLoad and filtered by hand (the reference's taps).
 *   graphFunctions(graph, ctx) → {code, input(id, uv) → expr}   the graph as WGSL functions alone (for a renderer that wants to
 *     evaluate a material in its own shader: `realtime`); `input` gives the material output input's expression at uv
 */
import { nodeType } from './nodes.js';
import { WGSL_LIB } from './lib.js';
import { outputNode } from './graph.js';
import { constValue } from './compile-js.js';
import { planBake } from './bake.js';
import { IMG_SIZE } from './images.js';

const f = (x) => { const v = Number.isFinite(x) ? x : 0, s = String(v); return /[.e]/.test(s) ? s : s + '.0'; };
const TYPE = { f: 'f32', c: 'vec3f', v3: 'vec3f', v2: 'vec2f' };

function convert(expr, from, to) {
  if (from === to || ((from === 'c' || from === 'v3') && (to === 'c' || to === 'v3'))) return expr;
  if (from === 'f') return to === 'v2' ? `vec2f(${expr})` : `vec3f(${expr})`;
  if (to === 'f') return from === 'c' ? `luminance(${expr})` : from === 'v3' ? `avg3(${expr})` : `avg2(${expr})`;
  if (to === 'v2') return `(${expr}).xy`;
  return `vec3f(${expr}, 0.0)`;
}
function literal(inp, v) {
  const c = constValue(inp, v);
  if (inp.kind === 'f') return f(c);
  if (inp.kind === 'v2') return `vec2f(${f(c[0])}, ${f(c[1])})`;
  return `vec3f(${f(c[0])}, ${f(c[1])}, ${f(c[2])})`;
}

export function graphFunctions(graph, { size, tile, imageKeys = [] }) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const linkOf = (nid, iid) => graph.links.find((l) => l.to[0] === nid && l.to[1] === iid) || null;
  const fns = [], done = new Set();
  const inputExpr = (n, inp, uv) => {
    const l = linkOf(n.id, inp.id);
    if (l && byId.has(l.from[0])) {
      const src = byId.get(l.from[0]), so = nodeType(src.type).outputs.find((o) => o.id === l.from[1]);
      if (so) { emit(src); return convert(`n${src.id}_${so.id}(${uv})`, so.kind, inp.kind); }
    }
    if (inp.def === 'uv') return uv;
    return literal(inp, n.values ? n.values[inp.id] : undefined);
  };
  function emit(n) {
    if (done.has(n.id)) return;
    done.add(n.id);
    const t = nodeType(n.type);
    const C = {
      size, tile,
      in: (id, uv = 'uv') => inputExpr(n, t.inputs.find((i) => i.id === id), uv),
      imageLayer: (key) => imageKeys.indexOf(key),
    };
    const g = t.wgsl(n.params || {}, C);
    for (const o of t.outputs) fns.push(`fn n${n.id}_${o.id}(uv: vec2f) -> ${TYPE[o.kind]} { ${g.pre} return ${g.out[o.id]}; }`);
  }
  const out = outputNode(graph), ot = nodeType('output');
  return {
    get code() { return fns.join('\n'); },
    input: (id, uv = 'uv') => inputExpr(out, ot.inputs.find((i) => i.id === id), uv),
  };
}

export function compileWGSL(graph, { size = 512, tile = null, imageKeys = [] } = {}) {
  const out = outputNode(graph), plan = planBake(graph);
  tile = tile || [out.params.width, out.params.height];
  const G = graphFunctions(graph, { size, tile, imageKeys });
  const b = {}, decl = [];
  let k = 0;
  if (imageKeys.length) { b.images = k; decl.push(`@group(0) @binding(${k++}) var IMGS: texture_2d_array<f32>;`); }
  for (const L of ['base', 'data', 'emit']) if (plan.need[L]) { b[L] = k; decl.push(`@group(0) @binding(${k++}) var<storage, read_write> OUT_${L.toUpperCase()}: array<u32>;`); }
  if (plan.need.height) { b.height = k; decl.push(`@group(0) @binding(${k++}) var<storage, read_write> OUT_HEIGHT: array<f32>;`); }
  const body = [];
  if (plan.need.base) body.push(`{ let c = ${G.input('base_color')}; OUT_BASE[o] = pack4(q8(srgbEncode(c.x)), q8(srgbEncode(c.y)), q8(srgbEncode(c.z)), q8(${G.input('specular_roughness')})); }`);
  if (plan.need.data) body.push(`{ let n = ${G.input('normal')}; let l = length(n); let m = select(n, n / l, l > 0.0); OUT_DATA[o] = pack4(qn(m.x), qn(m.y), q8(${G.input('base_metalness')}), q8(${G.input('geometry_opacity')})); }`);
  if (plan.need.emit) body.push(`{ let c = ${G.input('emission_color')}; OUT_EMIT[o] = pack4(q8(srgbEncode(c.x)), q8(srgbEncode(c.y)), q8(srgbEncode(c.z)), 255u); }`);
  if (plan.need.height) body.push(`OUT_HEIGHT[o] = ${G.input('displacement')};`);
  const code = [
    decl.join('\n'),
    WGSL_LIB,
    `fn avg3(v: vec3f) -> f32 { return (v.x + v.y + v.z) / 3.0; }`,
    `fn avg2(v: vec2f) -> f32 { return (v.x + v.y) / 2.0; }`,
    `fn q8(x: f32) -> u32 { if (!(x > 0.0)) { return 0u; } if (x >= 1.0) { return 255u; } return u32(floor(x * 255.0 + 0.5)); }`,
    `fn qn(x: f32) -> u32 { return u32(clamp(floor(127.0 * x + 128.5), 0.0, 255.0)); }`,
    `fn pack4(a: u32, b: u32, c: u32, d: u32) -> u32 { return a | (b << 8u) | (c << 16u) | (d << 24u); }`,
    imageKeys.length ? `fn img(layer: i32, uv: vec2f) -> vec4f {
  let S = ${IMG_SIZE};
  let fx = (uv.x - floor(uv.x)) * f32(S) - 0.5; let fy = (uv.y - floor(uv.y)) * f32(S) - 0.5;
  let x0 = floor(fx); let y0 = floor(fy); let tx = fx - x0; let ty = fy - y0;
  let ix = i32(x0); let iy = i32(y0);
  let xa = wrapI(ix, S); let xb = wrapI(ix + 1, S); let ya = wrapI(iy, S); let yb = wrapI(iy + 1, S);
  let a = textureLoad(IMGS, vec2i(xa, ya), layer, 0); let bb = textureLoad(IMGS, vec2i(xb, ya), layer, 0);
  let c = textureLoad(IMGS, vec2i(xa, yb), layer, 0); let d = textureLoad(IMGS, vec2i(xb, yb), layer, 0);
  return a * ((1.0 - tx) * (1.0 - ty)) + bb * (tx * (1.0 - ty)) + c * ((1.0 - tx) * ty) + d * (tx * ty);
}` : '',
    G.code,
    `@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= ${size}u || g.y >= ${size}u) { return; }
  let uv = (vec2f(g.xy) + vec2f(0.5)) / ${f(size)};
  let o = g.y * ${size}u + g.x;
  ${body.join('\n  ')}
}`,
  ].join('\n');
  return { code, plan, bindings: b };
}
