/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: WGSL source and socket ids, never shown (every word a person sees is a shading.* key) */
/**
 * shading/nodes.js — the node types of a material graph (0.7 MT.1; MT.2 adds the procedural textures). No DOM. Each type says
 * its sockets and settings once and carries its two implementations side by side, so they cannot drift: `js(P, C)` makes the
 * reference evaluator (shading/compile-js.js), `wgsl(P, C)` the same maths as WGSL (shading/compile-wgsl.js).
 *
 *   NODE_TYPES   Map type → {type, cat, inputs: [{id, kind, def, min?, max?, more?}], outputs: [{id, kind}],
 *                params: [{id, kind: 'enum'|'int'|'float'|'bool'|'color'|'image'|'library'|'stops', def, options?, min?, max?}],
 *                js(P, C) → (u, v, I, O) => void,   wgsl(P, C) → {pre: string, out: {id: expr}}}
 *   CATEGORIES   the add-node menu's order        KINDS  socket kinds: f (number), c (colour, linear Rec.709), v2, v3
 *   nodeType(type) → def | null                 defaultValues(type) → {input id: value}, defaultParams(type) → {param id: value}
 *
 * Coordinates: a graph is evaluated over **one tile** of the texture, u and v in [0, 1) (the output node says how many metres
 * the tile covers). Everything a node makes repeats across that tile: lattices wrap, repeats are whole numbers. Colours entered
 * as '#rrggbb' (sRGB) are linear inside the graph; the bake encodes them back for the texture layers.
 * Words: `shading.node.<type>`, `shading.in.<id>`, `shading.out.<id>`, `shading.param.<id>`, `shading.opt.<value>` (lang files).
 *
 * In `js`, I(id) reads an input (converted to the input's kind) at the current u, v, and I.at(id, u, v) at another point (the bump
 * node); O holds the node's outputs (numbers, or arrays to fill); C.used = the outputs something reads (others may be skipped). In `wgsl`, C.in(id, uv = 'uv') gives an input's expression.
 */
import { vnoise, fbm, hexLinear, rgbToHsv, hsvToRgb, smooth, luminance, srgbDecode, hash01, voronoi, waveProfile } from './lib.js';

export const KINDS = Object.freeze({ f: 'f32', c: 'vec3f', v2: 'vec2f', v3: 'vec3f' });
export const CATEGORIES = ['input', 'texture', 'color', 'math', 'vector', 'output'];
export const NODE_TYPES = new Map();

const f = (x) => {   // a WGSL f32 literal
  const v = Number.isFinite(x) ? x : 0;
  const s = String(v);
  return /[.e]/.test(s) ? s : s + '.0';
};
const v3 = (a) => `vec3f(${f(a[0])}, ${f(a[1])}, ${f(a[2])})`;
const lin = (hex) => hexLinear(hex);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function def(t) { NODE_TYPES.set(t.type, Object.freeze({ inputs: [], outputs: [], params: [], ...t })); }
export const nodeType = (type) => NODE_TYPES.get(type) || null;
export function defaultValues(type) {
  const t = nodeType(type), o = {};
  for (const i of t ? t.inputs : []) if (i.def !== 'uv') o[i.id] = Array.isArray(i.def) ? i.def.slice() : i.def;
  return o;
}
export function defaultParams(type) {
  const t = nodeType(type), o = {};
  for (const p of t ? t.params : []) o[p.id] = Array.isArray(p.def) ? JSON.parse(JSON.stringify(p.def)) : p.def;
  return o;
}

// ---------------------------------------------------------------- output
/** The OpenPBR inputs the material output offers (RENDER-SPEC § 5.1 names); `more` ones sit behind "More" in the editor. */
export const PBR_INPUTS = [
  { id: 'base_color', kind: 'c', def: '#cccccc' }, { id: 'base_metalness', kind: 'f', def: 0, min: 0, max: 1 },
  { id: 'specular_roughness', kind: 'f', def: 0.5, min: 0, max: 1 }, { id: 'normal', kind: 'v3', def: [0, 0, 1] },
  { id: 'geometry_opacity', kind: 'f', def: 1, min: 0, max: 1 }, { id: 'emission_color', kind: 'c', def: '#ffffff' },
  { id: 'emission_luminance', kind: 'f', def: 0, min: 0, max: 100000 }, { id: 'displacement', kind: 'f', def: 0, more: true },
  { id: 'base_weight', kind: 'f', def: 1, min: 0, max: 1, more: true }, { id: 'base_diffuse_roughness', kind: 'f', def: 0, min: 0, max: 1, more: true },
  { id: 'specular_weight', kind: 'f', def: 1, min: 0, max: 1, more: true }, { id: 'specular_color', kind: 'c', def: '#ffffff', more: true },
  { id: 'specular_ior', kind: 'f', def: 1.5, min: 1, max: 3, more: true }, { id: 'specular_roughness_anisotropy', kind: 'f', def: 0, min: 0, max: 1, more: true },
  { id: 'transmission_weight', kind: 'f', def: 0, min: 0, max: 1, more: true }, { id: 'transmission_color', kind: 'c', def: '#ffffff', more: true },
  { id: 'transmission_depth', kind: 'f', def: 0, min: 0, max: 100, more: true },
  { id: 'subsurface_weight', kind: 'f', def: 0, min: 0, max: 1, more: true }, { id: 'subsurface_color', kind: 'c', def: '#cccccc', more: true },
  { id: 'subsurface_radius', kind: 'f', def: 1, min: 0, max: 100, more: true },
  { id: 'coat_weight', kind: 'f', def: 0, min: 0, max: 1, more: true }, { id: 'coat_color', kind: 'c', def: '#ffffff', more: true },
  { id: 'coat_roughness', kind: 'f', def: 0, min: 0, max: 1, more: true }, { id: 'coat_ior', kind: 'f', def: 1.6, min: 1, max: 3, more: true },
  { id: 'fuzz_weight', kind: 'f', def: 0, min: 0, max: 1, more: true }, { id: 'fuzz_color', kind: 'c', def: '#ffffff', more: true },
  { id: 'fuzz_roughness', kind: 'f', def: 0.5, min: 0, max: 1, more: true },
  { id: 'thin_film_weight', kind: 'f', def: 0, min: 0, max: 1, more: true }, { id: 'thin_film_thickness', kind: 'f', def: 0.5, min: 0, max: 2, more: true },
  { id: 'thin_film_ior', kind: 'f', def: 1.4, min: 1, max: 3, more: true },
];
def({
  type: 'output', cat: 'output', single: true,
  inputs: PBR_INPUTS,
  params: [
    { id: 'mapping', kind: 'enum', def: 'uv', options: ['uv', 'box', 'triplanar'] },
    { id: 'width', kind: 'float', def: 1, min: 0.001, max: 1000 }, { id: 'height', kind: 'float', def: 1, min: 0.001, max: 1000 },
    { id: 'sharpness', kind: 'float', def: 4, min: 1, max: 64 }, { id: 'normal_strength', kind: 'float', def: 1, min: 0, max: 8 },
    { id: 'displacement_scale', kind: 'float', def: 0.02, min: 0, max: 10 }, { id: 'thin_walled', kind: 'bool', def: false },
  ],
  js: () => () => {},
  wgsl: () => ({ pre: '', out: {} }),
});

// ---------------------------------------------------------------- input
def({
  type: 'texcoord', cat: 'input',
  outputs: [{ id: 'uv', kind: 'v2' }],
  params: [{ id: 'repeat_u', kind: 'int', def: 1, min: 1, max: 256 }, { id: 'repeat_v', kind: 'int', def: 1, min: 1, max: 256 },
    { id: 'offset_u', kind: 'float', def: 0, min: -1000, max: 1000 }, { id: 'offset_v', kind: 'float', def: 0, min: -1000, max: 1000 },
    { id: 'rotate', kind: 'enum', def: '0', options: ['0', '90', '180', '270'] }],
  js: (P) => (u, v, I, O) => {
    let a = u * P.repeat_u + P.offset_u, b = v * P.repeat_v + P.offset_v;
    if (P.rotate === '90') { const t = a; a = -b; b = t; } else if (P.rotate === '180') { a = -a; b = -b; } else if (P.rotate === '270') { const t = a; a = b; b = -t; }
    O.uv[0] = a; O.uv[1] = b;
  },
  wgsl: (P) => {
    const base = `(uv * vec2f(${f(P.repeat_u)}, ${f(P.repeat_v)}) + vec2f(${f(P.offset_u)}, ${f(P.offset_v)}))`;
    const rot = { 0: 'q', 90: 'vec2f(-q.y, q.x)', 180: '-q', 270: 'vec2f(q.y, -q.x)' }[P.rotate] || 'q';
    return { pre: `let q = ${base};`, out: { uv: rot } };
  },
});
def({
  type: 'value', cat: 'input', outputs: [{ id: 'value', kind: 'f' }],
  params: [{ id: 'value', kind: 'float', def: 0.5, min: -100000, max: 100000 }],
  js: (P) => (u, v, I, O) => { O.value = P.value; },
  wgsl: (P) => ({ pre: '', out: { value: f(P.value) } }),
});
def({
  type: 'rgb', cat: 'input', outputs: [{ id: 'color', kind: 'c' }],
  params: [{ id: 'color', kind: 'color', def: '#808080' }],
  js: (P) => { const c = lin(P.color); return (u, v, I, O) => { O.color[0] = c[0]; O.color[1] = c[1]; O.color[2] = c[2]; }; },
  wgsl: (P) => ({ pre: '', out: { color: v3(lin(P.color)) } }),
});

// ---------------------------------------------------------------- textures
/** Bilinear lookup, wrapping, of a prepared image ({w, h, data RGBA8, rows bottom-up}) — the same taps as the WGSL `img`. */
export function imageAt(im, u, v, out) {
  const fx = (u - Math.floor(u)) * im.w - 0.5, fy = (v - Math.floor(v)) * im.h - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, d = im.data;
  out[0] = out[1] = out[2] = out[3] = 0;
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const x = (((x0 + i) % im.w) + im.w) % im.w, y = (((y0 + j) % im.h) + im.h) % im.h;
    const wgt = (i ? tx : 1 - tx) * (j ? ty : 1 - ty), q = (y * im.w + x) * 4;
    out[0] += (wgt * d[q]) / 255; out[1] += (wgt * d[q + 1]) / 255; out[2] += (wgt * d[q + 2]) / 255; out[3] += (wgt * d[q + 3]) / 255;
  }
  return out;
}
const UVIN = { id: 'uv', kind: 'v2', def: 'uv' };
def({
  type: 'image', cat: 'texture', inputs: [UVIN],
  outputs: [{ id: 'color', kind: 'c' }, { id: 'alpha', kind: 'f' }],
  params: [{ id: 'image', kind: 'image', def: '' }, { id: 'space', kind: 'enum', def: 'color', options: ['color', 'data'] }],
  js: (P, C) => {
    const im = C.image(P.image), t = [0, 0, 0, 0], dec = P.space === 'color';
    return (u, v, I, O) => {
      if (!im) { O.color[0] = O.color[1] = O.color[2] = 0.5; O.alpha = 1; return; }
      const q = I('uv'); imageAt(im, q[0], q[1], t);
      O.color[0] = dec ? srgbDecode(t[0]) : t[0]; O.color[1] = dec ? srgbDecode(t[1]) : t[1]; O.color[2] = dec ? srgbDecode(t[2]) : t[2]; O.alpha = t[3];
    };
  },
  wgsl: (P, C) => {
    const L = C.imageLayer(P.image);
    if (L < 0) return { pre: '', out: { color: 'vec3f(0.5)', alpha: '1.0' } };
    const dec = P.space === 'color';
    return { pre: `let t = img(${L}, ${C.in('uv')});`, out: { color: dec ? 'srgbDecode3(t.xyz)' : 't.xyz', alpha: 't.w' } };
  },
});
def({
  type: 'library', cat: 'texture', inputs: [UVIN],
  outputs: [{ id: 'color', kind: 'c' }, { id: 'roughness', kind: 'f' }, { id: 'height', kind: 'f' }],
  params: [{ id: 'material', kind: 'library', def: 'brick-red' }],
  js: (P, C) => {
    const a = C.image('lib:' + P.material + ':albedo'), b = C.image('lib:' + P.material + ':data'), t = [0, 0, 0, 0];
    return (u, v, I, O) => {
      const q = I('uv');
      if (a) { imageAt(a, q[0], q[1], t); O.color[0] = srgbDecode(t[0]); O.color[1] = srgbDecode(t[1]); O.color[2] = srgbDecode(t[2]); } else O.color[0] = O.color[1] = O.color[2] = 0.5;
      if (b) { imageAt(b, q[0], q[1], t); O.height = t[0]; O.roughness = t[1]; } else { O.height = 0.5; O.roughness = 0.5; }
    };
  },
  wgsl: (P, C) => {
    const La = C.imageLayer('lib:' + P.material + ':albedo'), Lb = C.imageLayer('lib:' + P.material + ':data');
    return {
      pre: `let q = ${C.in('uv')};` + (La >= 0 ? `let ta = img(${La}, q);` : '') + (Lb >= 0 ? `let tb = img(${Lb}, q);` : ''),
      out: { color: La >= 0 ? 'srgbDecode3(ta.xyz)' : 'vec3f(0.5)', roughness: Lb >= 0 ? 'tb.y' : '0.5', height: Lb >= 0 ? 'tb.x' : '0.5' },
    };
  },
});
def({
  type: 'checker', cat: 'texture',
  inputs: [UVIN, { id: 'color1', kind: 'c', def: '#e8e8e8' }, { id: 'color2', kind: 'c', def: '#303030' }],
  outputs: [{ id: 'color', kind: 'c' }, { id: 'fac', kind: 'f' }],
  params: [{ id: 'scale', kind: 'int', def: 8, min: 1, max: 1024 }],
  js: (P) => (u, v, I, O) => {
    const q = I('uv'), k = (Math.floor(q[0] * P.scale) + Math.floor(q[1] * P.scale)) & 1, c = I(k ? 'color2' : 'color1');
    O.fac = k; O.color[0] = c[0]; O.color[1] = c[1]; O.color[2] = c[2];
  },
  wgsl: (P, C) => ({
    pre: `let q = floor(${C.in('uv')} * ${f(P.scale)}); let k = f32((i32(q.x) + i32(q.y)) & 1);`,
    out: { fac: 'k', color: `select(${C.in('color1')}, ${C.in('color2')}, k > 0.5)` },
  }),
});
def({
  type: 'noise', cat: 'texture', inputs: [UVIN],
  outputs: [{ id: 'fac', kind: 'f' }, { id: 'color', kind: 'c' }],
  params: [{ id: 'scale', kind: 'int', def: 4, min: 1, max: 1024 }, { id: 'detail', kind: 'int', def: 4, min: 1, max: 10 },
    { id: 'roughness', kind: 'float', def: 0.5, min: 0, max: 1 }, { id: 'seed', kind: 'int', def: 0, min: 0, max: 99999 }],
  js: (P, C) => {
    const col = !C.used || C.used.has('color');
    return (u, v, I, O) => {
      const q = I('uv'), x = q[0] * P.scale, y = q[1] * P.scale, s = P.seed >>> 0;
      O.fac = fbm(x, y, P.scale, P.scale, P.detail, P.roughness, s);
      if (col) { O.color[0] = O.fac; O.color[1] = fbm(x, y, P.scale, P.scale, P.detail, P.roughness, (s + 7919) >>> 0); O.color[2] = fbm(x, y, P.scale, P.scale, P.detail, P.roughness, (s + 15881) >>> 0); }
    };
  },
  wgsl: (P, C) => {
    const a = `x.x, x.y, ${P.scale | 0}, ${P.scale | 0}, ${P.detail | 0}, ${f(P.roughness)}`;
    return { pre: `let x = ${C.in('uv')} * ${f(P.scale)};`,
      out: { fac: `fbm(${a}, ${P.seed >>> 0}u)`, color: `vec3f(fbm(${a}, ${P.seed >>> 0}u), fbm(${a}, ${(P.seed + 7919) >>> 0}u), fbm(${a}, ${(P.seed + 15881) >>> 0}u))` } };
  },
});

// ---------------------------------------------------------------- procedural textures (MT.2): everything tiles
const wrapI = (a, n) => ((a % n) + n) % n;
const sstep = (lo, hi, x) => { const t = clamp01((x - lo) / (hi - lo)); return t * t * (3 - 2 * t); };
const WGSL_SSTEP = (lo, hi, x) => `smooth1(clamp(((${x}) - (${lo})) / ((${hi}) - (${lo})), 0.0, 1.0))`;
def({
  type: 'voronoi', cat: 'texture', inputs: [UVIN],
  outputs: [{ id: 'distance', kind: 'f' }, { id: 'edge', kind: 'f' }, { id: 'color', kind: 'c' }],
  params: [{ id: 'scale', kind: 'int', def: 6, min: 1, max: 1024 }, { id: 'randomness', kind: 'float', def: 1, min: 0, max: 1 },
    { id: 'metric', kind: 'enum', def: 'euclidean', options: ['euclidean', 'manhattan'] }, { id: 'seed', kind: 'int', def: 0, min: 0, max: 99999 }],
  js: (P) => { const r = [0, 0, 0, 0], s = P.seed >>> 0, man = P.metric === 'manhattan'; return (u, v, I, O) => {
    const q = I('uv'); voronoi(q[0] * P.scale, q[1] * P.scale, P.scale, P.scale, P.randomness, s, man, r);
    O.distance = r[0]; O.edge = r[1] - r[0];
    O.color[0] = hash01(r[2], r[3], (s + 2) >>> 0); O.color[1] = hash01(r[2], r[3], (s + 3) >>> 0); O.color[2] = hash01(r[2], r[3], (s + 4) >>> 0);
  }; },
  wgsl: (P, C) => {
    const s = P.seed >>> 0;
    return { pre: `let x = ${C.in('uv')} * ${f(P.scale)}; let r = voronoi(x.x, x.y, ${P.scale | 0}, ${P.scale | 0}, ${f(P.randomness)}, ${s}u, ${P.metric === 'manhattan'}); let cx = i32(r.z); let cy = i32(r.w);`,
      out: { distance: 'r.x', edge: 'r.y - r.x', color: `vec3f(hash01(cx, cy, ${(s + 2) >>> 0}u), hash01(cx, cy, ${(s + 3) >>> 0}u), hash01(cx, cy, ${(s + 4) >>> 0}u))` } };
  },
});
const WAVE_DIRS = ['across', 'up', 'diagonal'], PROFILES = ['sine', 'saw', 'triangle'];
def({
  type: 'wave', cat: 'texture', inputs: [UVIN],
  outputs: [{ id: 'fac', kind: 'f' }, { id: 'color', kind: 'c' }],
  params: [{ id: 'bands', kind: 'int', def: 6, min: 1, max: 1024 }, { id: 'direction', kind: 'enum', def: 'across', options: WAVE_DIRS },
    { id: 'profile', kind: 'enum', def: 'sine', options: PROFILES }, { id: 'distortion', kind: 'float', def: 0, min: 0, max: 20 },
    { id: 'detail', kind: 'int', def: 2, min: 1, max: 10 }, { id: 'seed', kind: 'int', def: 0, min: 0, max: 99999 }],
  js: (P) => { const k = PROFILES.indexOf(P.profile), s = P.seed >>> 0; return (u, v, I, O) => {
    const q = I('uv'), t = P.direction === 'up' ? q[1] : P.direction === 'diagonal' ? q[0] + q[1] : q[0];
    const p = P.bands * t + (P.distortion > 0 ? P.distortion * (fbm(q[0] * 4, q[1] * 4, 4, 4, P.detail, 0.5, s) - 0.5) : 0);
    O.fac = waveProfile(p, k); O.color[0] = O.color[1] = O.color[2] = O.fac;
  }; },
  wgsl: (P, C) => {
    const t = P.direction === 'up' ? 'q.y' : P.direction === 'diagonal' ? '(q.x + q.y)' : 'q.x';
    const d = P.distortion > 0 ? ` + ${f(P.distortion)} * (fbm(q.x * 4.0, q.y * 4.0, 4, 4, ${P.detail | 0}, 0.5, ${P.seed >>> 0}u) - 0.5)` : '';
    return { pre: `let q = ${C.in('uv')}; let w = waveProfile(${f(P.bands)} * ${t}${d}, ${PROFILES.indexOf(P.profile)});`, out: { fac: 'w', color: 'vec3f(w)' } };
  },
});
/** Bricks and tiles (MT.2): rows × columns over the tile, every other row shifted by `offset`, a gap (metres) between them, a
 * bevel (metres) rounding the height at the edges; a random number per brick (wrapping, so the pattern tiles). */
function gridJs(P, C, rows, cols, offset) {
  const bw = C.tile[0] / cols, bh = C.tile[1] / rows;
  return (q, out) => {
    const y = q[1] * rows, row = Math.floor(y), rw = wrapI(row, rows), x = q[0] * cols + (rw & 1 ? offset : 0), col = Math.floor(x), cw = wrapI(col, cols);
    const e = Math.min(Math.min(x - col, 1 - (x - col)) * bw, Math.min(y - row, 1 - (y - row)) * bh) - P.gap / 2;
    out[0] = e > 0 ? 1 : 0; out[1] = smooth(P.bevel > 0 ? clamp01(e / P.bevel) : out[0]); out[2] = hash01(cw, rw, P.seed >>> 0);
    return out;
  };
}
function gridWgsl(P, C, rows, cols, offset, uv) {
  const bw = C.tile[0] / cols, bh = C.tile[1] / rows;
  return `let q = ${uv}; let y = q.y * ${f(rows)}; let row = floor(y); let rw = wrapI(i32(row), ${rows | 0}); let x = q.x * ${f(cols)} + select(0.0, ${f(offset)}, (rw & 1) == 1);`
    + ` let col = floor(x); let cw = wrapI(i32(col), ${cols | 0});`
    + ` let e = min(min(x - col, 1.0 - (x - col)) * ${f(bw)}, min(y - row, 1.0 - (y - row)) * ${f(bh)}) - ${f(P.gap / 2)};`
    + ` let inside = select(0.0, 1.0, e > 0.0); let hgt = smooth1(${P.bevel > 0 ? `clamp(e / ${f(P.bevel)}, 0.0, 1.0)` : 'inside'}); let rnd = hash01(cw, rw, ${P.seed >>> 0}u);`;
}
const GRID_PARAMS = [{ id: 'gap', kind: 'float', def: 0.01, min: 0, max: 1 }, { id: 'bevel', kind: 'float', def: 0.004, min: 0, max: 1 }, { id: 'seed', kind: 'int', def: 0, min: 0, max: 99999 }];
def({
  type: 'brick', cat: 'texture',
  inputs: [UVIN, { id: 'color1', kind: 'c', def: '#9c4a35' }, { id: 'color2', kind: 'c', def: '#7a3626' }, { id: 'mortar', kind: 'c', def: '#bdb5a8' }],
  outputs: [{ id: 'color', kind: 'c' }, { id: 'fac', kind: 'f' }, { id: 'height', kind: 'f' }, { id: 'id', kind: 'f' }],
  params: [{ id: 'rows', kind: 'int', def: 8, min: 1, max: 256 }, { id: 'columns', kind: 'int', def: 4, min: 1, max: 256 }, { id: 'offset', kind: 'float', def: 0.5, min: 0, max: 1 }, ...GRID_PARAMS],
  js: (P, C) => { const g = gridJs(P, C, P.rows, P.columns, P.offset), r = [0, 0, 0]; return (u, v, I, O) => {
    g(I('uv'), r);
    const a = I('color1'), b = I('color2'), m = I('mortar');
    for (let k = 0; k < 3; k++) O.color[k] = r[0] ? a[k] + (b[k] - a[k]) * r[2] : m[k];
    O.fac = r[0]; O.height = r[1]; O.id = r[2];
  }; },
  wgsl: (P, C) => ({ pre: gridWgsl(P, C, P.rows, P.columns, P.offset, C.in('uv')),
    out: { color: `select(${C.in('mortar')}, mix(${C.in('color1')}, ${C.in('color2')}, rnd), e > 0.0)`, fac: 'inside', height: 'hgt', id: 'rnd' } }),
});
def({
  type: 'tiles', cat: 'texture',
  inputs: [UVIN, { id: 'color', kind: 'c', def: '#eceae4' }, { id: 'grout', kind: 'c', def: '#a5a39e' }],
  outputs: [{ id: 'color', kind: 'c' }, { id: 'fac', kind: 'f' }, { id: 'height', kind: 'f' }, { id: 'id', kind: 'f' }],
  params: [{ id: 'across', kind: 'int', def: 4, min: 1, max: 256 }, { id: 'up', kind: 'int', def: 4, min: 1, max: 256 }, { id: 'variation', kind: 'float', def: 0.15, min: 0, max: 1 }, ...GRID_PARAMS],
  js: (P, C) => { const g = gridJs(P, C, P.up, P.across, 0), r = [0, 0, 0]; return (u, v, I, O) => {
    g(I('uv'), r);
    const c = I('color'), m = I('grout'), k0 = 1 - P.variation * r[2];
    for (let k = 0; k < 3; k++) O.color[k] = r[0] ? c[k] * k0 : m[k];
    O.fac = r[0]; O.height = r[1]; O.id = r[2];
  }; },
  wgsl: (P, C) => ({ pre: gridWgsl(P, C, P.up, P.across, 0, C.in('uv')),
    out: { color: `select(${C.in('grout')}, ${C.in('color')} * (1.0 - ${f(P.variation)} * rnd), e > 0.0)`, fac: 'inside', height: 'hgt', id: 'rnd' } }),
});
def({
  type: 'wood', cat: 'texture',
  inputs: [UVIN, { id: 'light', kind: 'c', def: '#c99a63' }, { id: 'dark', kind: 'c', def: '#7a4e2a' }],
  outputs: [{ id: 'color', kind: 'c' }, { id: 'fac', kind: 'f' }],
  params: [{ id: 'rings', kind: 'int', def: 12, min: 1, max: 256 }, { id: 'distortion', kind: 'float', def: 0.6, min: 0, max: 10 },
    { id: 'sharpness', kind: 'float', def: 2, min: 0.1, max: 16 }, { id: 'grain', kind: 'float', def: 0.2, min: 0, max: 1 }, { id: 'seed', kind: 'int', def: 0, min: 0, max: 99999 }],
  // the grain runs across the tile (u); rings are bands up it (v), bent by slow noise; fine fibres on top
  js: (P) => { const s = P.seed >>> 0; return (u, v, I, O) => {
    const q = I('uv'), r = q[1] * P.rings + P.distortion * 4 * (fbm(q[0] * 2, q[1] * 4, 2, 4, 3, 0.5, s) - 0.5);
    const fr = r - Math.floor(r), ring = Math.pow(1 - Math.abs(2 * fr - 1), P.sharpness);
    const t = clamp01(ring + P.grain * (fbm(q[0] * 48, q[1] * 3, 48, 3, 3, 0.5, (s + 5) >>> 0) - 0.5) * 2);
    const a = I('light'), b = I('dark');
    for (let k = 0; k < 3; k++) O.color[k] = a[k] + (b[k] - a[k]) * t;
    O.fac = t;
  }; },
  wgsl: (P, C) => {
    const s = P.seed >>> 0;
    return { pre: `let q = ${C.in('uv')}; let r = q.y * ${f(P.rings)} + ${f(P.distortion * 4)} * (fbm(q.x * 2.0, q.y * 4.0, 2, 4, 3, 0.5, ${s}u) - 0.5);`
      + ` let fr = r - floor(r); let ring = pow(max(1.0 - abs(2.0 * fr - 1.0), 0.0), ${f(P.sharpness)});`
      + ` let t = clamp(ring + ${f(P.grain)} * (fbm(q.x * 48.0, q.y * 3.0, 48, 3, 3, 0.5, ${(s + 5) >>> 0}u) - 0.5) * 2.0, 0.0, 1.0);`,
    out: { color: `mix(${C.in('light')}, ${C.in('dark')}, t)`, fac: 't' } };
  },
});
def({
  type: 'marble', cat: 'texture',
  inputs: [UVIN, { id: 'color', kind: 'c', def: '#e8e4dc' }, { id: 'vein', kind: 'c', def: '#5a5c60' }],
  outputs: [{ id: 'color', kind: 'c' }, { id: 'fac', kind: 'f' }],
  params: [{ id: 'bands', kind: 'int', def: 3, min: 1, max: 256 }, { id: 'turbulence', kind: 'float', def: 3, min: 0, max: 20 },
    { id: 'detail', kind: 'int', def: 5, min: 1, max: 10 }, { id: 'sharpness', kind: 'float', def: 8, min: 0.1, max: 64 }, { id: 'seed', kind: 'int', def: 0, min: 0, max: 99999 }],
  js: (P) => { const s = P.seed >>> 0; return (u, v, I, O) => {
    const q = I('uv'), ph = (q[0] + q[1]) * P.bands + P.turbulence * (fbm(q[0] * 4, q[1] * 4, 4, 4, P.detail, 0.5, s) - 0.5);
    const t = Math.pow(1 - Math.abs(Math.sin(Math.PI * ph)), P.sharpness);
    const a = I('color'), b = I('vein');
    for (let k = 0; k < 3; k++) O.color[k] = a[k] + (b[k] - a[k]) * t;
    O.fac = t;
  }; },
  wgsl: (P, C) => ({
    pre: `let q = ${C.in('uv')}; let ph = (q.x + q.y) * ${f(P.bands)} + ${f(P.turbulence)} * (fbm(q.x * 4.0, q.y * 4.0, 4, 4, ${P.detail | 0}, 0.5, ${P.seed >>> 0}u) - 0.5);`
      + ` let t = pow(max(1.0 - abs(sin(3.141592653589793 * ph)), 0.0), ${f(P.sharpness)});`,
    out: { color: `mix(${C.in('color')}, ${C.in('vein')}, t)`, fac: 't' },
  }),
});
const GRADIENTS = ['linear', 'vertical', 'diagonal', 'quadratic', 'radial', 'spherical'];
def({
  type: 'gradient', cat: 'texture', inputs: [UVIN],
  outputs: [{ id: 'fac', kind: 'f' }, { id: 'color', kind: 'c' }],
  params: [{ id: 'kind', kind: 'enum', def: 'linear', options: GRADIENTS }],
  js: (P) => (u, v, I, O) => {
    const q = I('uv'), x = q[0], y = q[1];
    let t;
    switch (P.kind) {
      case 'vertical': t = clamp01(y); break;
      case 'diagonal': t = clamp01((x + y) / 2); break;
      case 'quadratic': t = clamp01(x) * clamp01(x); break;
      case 'radial': t = Math.atan2(y - 0.5, x - 0.5) / (2 * Math.PI) + 0.5; break;
      case 'spherical': t = Math.max(0, 1 - 2 * Math.hypot(x - 0.5, y - 0.5)); break;
      default: t = clamp01(x);
    }
    O.fac = t; O.color[0] = O.color[1] = O.color[2] = t;
  },
  wgsl: (P, C) => {
    const e = { vertical: 'clamp(q.y, 0.0, 1.0)', diagonal: 'clamp((q.x + q.y) / 2.0, 0.0, 1.0)', quadratic: 'clamp(q.x, 0.0, 1.0) * clamp(q.x, 0.0, 1.0)',
      radial: 'atan2(q.y - 0.5, q.x - 0.5) / 6.283185307179586 + 0.5', spherical: 'max(0.0, 1.0 - 2.0 * length(q - vec2f(0.5)))' }[P.kind] || 'clamp(q.x, 0.0, 1.0)';
    return { pre: `let q = ${C.in('uv')}; let t = ${e};`, out: { fac: 't', color: 'vec3f(t)' } };
  },
});
/**
 * Dirt and edge wear (MT.2): a mesh's curvature (0.5 flat, above convex, below hollow) and ambient occlusion (1 open, 0 shut in)
 * — pictures baked for that mesh in its UV layout (MT.5, ws-shading's Bake) — wear the convex edges and dirty the hollows, broken
 * up by noise. Without the pictures nothing is worn. Place the material by UV so tile coordinates are the mesh's UVs.
 */
def({
  type: 'wear', cat: 'texture',
  inputs: [UVIN, { id: 'color', kind: 'c', def: '#808080' }, { id: 'worn', kind: 'c', def: '#c8c4bc' }, { id: 'dirt', kind: 'c', def: '#3a3228' }],
  outputs: [{ id: 'color', kind: 'c' }, { id: 'wear', kind: 'f' }, { id: 'grime', kind: 'f' }],
  params: [{ id: 'curvature', kind: 'image', def: '' }, { id: 'occlusion', kind: 'image', def: '' }, { id: 'edges', kind: 'float', def: 0.5, min: 0, max: 1 },
    { id: 'grime', kind: 'float', def: 0.5, min: 0, max: 1 }, { id: 'breakup', kind: 'int', def: 8, min: 1, max: 256 }, { id: 'seed', kind: 'int', def: 0, min: 0, max: 99999 }],
  js: (P, C) => {
    const ci = C.image(P.curvature), oi = C.image(P.occlusion), t = [0, 0, 0, 0], s = P.seed >>> 0;
    return (u, v, I, O) => {
      const q = I('uv'), cu = ci ? imageAt(ci, q[0], q[1], t)[0] : 0.5, ao = oi ? imageAt(oi, q[0], q[1], t)[0] : 1;
      const n = fbm(q[0] * P.breakup, q[1] * P.breakup, P.breakup, P.breakup, 4, 0.5, s) - 0.5;
      // a signal 0…1 each (convex; shut in), its mask from a threshold that falls as the amount grows (0 = none, 1 = nearly all)
      const w = ci ? sstep(1 - P.edges, 1.1 - P.edges, clamp01((cu - 0.5) * 2 + n * 0.3)) : 0;
      const g = ci || oi ? sstep(1 - P.grime, 1.1 - P.grime, clamp01(((1 - ao) + (0.5 - cu) * 2) * 0.5 + n * 0.3)) : 0;
      const a = I('color'), d = I('dirt'), wc = I('worn');
      for (let k = 0; k < 3; k++) { const x = a[k] + (d[k] - a[k]) * g; O.color[k] = x + (wc[k] - x) * w; }
      O.wear = w; O.grime = g;
    };
  },
  wgsl: (P, C) => {
    const Lc = C.imageLayer(P.curvature), Lo = C.imageLayer(P.occlusion), s = P.seed >>> 0;
    const n = `fbm(q.x * ${f(P.breakup)}, q.y * ${f(P.breakup)}, ${P.breakup | 0}, ${P.breakup | 0}, 4, 0.5, ${s}u) - 0.5`;
    return {
      pre: `let q = ${C.in('uv')}; let cu = ${Lc >= 0 ? `img(${Lc}, q).x` : '0.5'}; let ao = ${Lo >= 0 ? `img(${Lo}, q).x` : '1.0'}; let nn = ${n};`
        + ` let w = ${Lc >= 0 ? WGSL_SSTEP(f(1 - P.edges), f(1.1 - P.edges), 'clamp((cu - 0.5) * 2.0 + nn * 0.3, 0.0, 1.0)') : '0.0'};`
        + ` let g = ${Lc >= 0 || Lo >= 0 ? WGSL_SSTEP(f(1 - P.grime), f(1.1 - P.grime), 'clamp(((1.0 - ao) + (0.5 - cu) * 2.0) * 0.5 + nn * 0.3, 0.0, 1.0)') : '0.0'};`
        + ` let x = mix(${C.in('color')}, ${C.in('dirt')}, g);`,
      out: { color: `mix(x, ${C.in('worn')}, w)`, wear: 'w', grime: 'g' },
    };
  },
});

// ---------------------------------------------------------------- colour
export const MIX_MODES = ['mix', 'multiply', 'add', 'subtract', 'screen', 'overlay', 'darken', 'lighten', 'difference'];
function blendJs(mode, a, b) {
  switch (mode) {
    case 'multiply': return a * b;
    case 'add': return a + b;
    case 'subtract': return a - b;
    case 'screen': return 1 - (1 - a) * (1 - b);
    case 'overlay': return a < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b);
    case 'darken': return Math.min(a, b);
    case 'lighten': return Math.max(a, b);
    case 'difference': return Math.abs(a - b);
    default: return b;
  }
}
function blendWgsl(mode) {
  switch (mode) {
    case 'multiply': return 'a * b';
    case 'add': return 'a + b';
    case 'subtract': return 'a - b';
    case 'screen': return 'vec3f(1.0) - (vec3f(1.0) - a) * (vec3f(1.0) - b)';
    case 'overlay': return 'select(vec3f(1.0) - 2.0 * (vec3f(1.0) - a) * (vec3f(1.0) - b), 2.0 * a * b, a < vec3f(0.5))';
    case 'darken': return 'min(a, b)';
    case 'lighten': return 'max(a, b)';
    case 'difference': return 'abs(a - b)';
    default: return 'b';
  }
}
def({
  type: 'mix', cat: 'color',
  inputs: [{ id: 'fac', kind: 'f', def: 0.5, min: 0, max: 1 }, { id: 'a', kind: 'c', def: '#808080' }, { id: 'b', kind: 'c', def: '#ffffff' }],
  outputs: [{ id: 'color', kind: 'c' }],
  params: [{ id: 'mode', kind: 'enum', def: 'mix', options: MIX_MODES }, { id: 'clamp', kind: 'bool', def: false }],
  js: (P) => (u, v, I, O) => {
    const t = clamp01(I('fac')), a = I('a'), b = I('b');
    for (let k = 0; k < 3; k++) { const r = a[k] + (blendJs(P.mode, a[k], b[k]) - a[k]) * t; O.color[k] = P.clamp ? clamp01(r) : r; }
  },
  wgsl: (P, C) => {
    const r = `mix(a, ${blendWgsl(P.mode)}, clamp(${C.in('fac')}, 0.0, 1.0))`;
    return { pre: `let a = ${C.in('a')}; let b = ${C.in('b')};`, out: { color: P.clamp ? `clamp(${r}, vec3f(0.0), vec3f(1.0))` : r } };
  },
});
/** Colour-ramp stops, cleaned: 1–16, sorted by position. */
export function cleanStops(st) {
  const out = (Array.isArray(st) ? st : []).filter((s) => s && Number.isFinite(s.p) && /^#[0-9a-f]{6}$/i.test(s.color || ''))
    .slice(0, 16).map((s) => ({ p: clamp01(s.p), color: s.color.toLowerCase() })).sort((a, b) => a.p - b.p);
  return out.length ? out : [{ p: 0, color: '#000000' }, { p: 1, color: '#ffffff' }];
}
def({
  type: 'ramp', cat: 'color',
  inputs: [{ id: 'fac', kind: 'f', def: 0.5, min: 0, max: 1 }],
  outputs: [{ id: 'color', kind: 'c' }],
  params: [{ id: 'stops', kind: 'stops', def: [{ p: 0, color: '#000000' }, { p: 1, color: '#ffffff' }] },
    { id: 'interpolation', kind: 'enum', def: 'linear', options: ['linear', 'constant', 'smooth'] }],
  js: (P) => {
    const st = cleanStops(P.stops), cs = st.map((s) => lin(s.color)), n = st.length;
    return (u, v, I, O) => {
      const t = clamp01(I('fac'));
      let i = 0;
      while (i + 1 < n && st[i + 1].p <= t) i++;
      let c0 = cs[i], c1 = cs[i], w = 0;
      if (t >= st[i].p && i + 1 < n && P.interpolation !== 'constant') {
        const span = st[i + 1].p - st[i].p;
        w = span > 0 ? (t - st[i].p) / span : 0;
        if (P.interpolation === 'smooth') w = smooth(w);
        c1 = cs[i + 1];
      } else if (t < st[0].p) { c0 = c1 = cs[0]; }
      for (let k = 0; k < 3; k++) O.color[k] = c0[k] + (c1[k] - c0[k]) * w;
    };
  },
  wgsl: (P, C) => {
    const st = cleanStops(P.stops), cs = st.map((s) => lin(s.color)), n = st.length;
    let pre = `let t = clamp(${C.in('fac')}, 0.0, 1.0); var c = ${v3(cs[0])};`;
    for (let i = 0; i < n; i++) {
      if (i + 1 < n && P.interpolation !== 'constant') {
        const span = st[i + 1].p - st[i].p;
        const w = span > 0 ? `(t - ${f(st[i].p)}) / ${f(span)}` : '0.0';
        const ww = P.interpolation === 'smooth' ? `smooth1(${w})` : w;
        pre += ` if (t >= ${f(st[i].p)}) { c = mix(${v3(cs[i])}, ${v3(cs[i + 1])}, ${ww}); }`;
      } else pre += ` if (t >= ${f(st[i].p)}) { c = ${v3(cs[i])}; }`;
    }
    return { pre, out: { color: 'c' } };
  },
});
def({
  type: 'hsv', cat: 'color',
  inputs: [{ id: 'color', kind: 'c', def: '#808080' }, { id: 'hue', kind: 'f', def: 0.5, min: 0, max: 1 }, { id: 'saturation', kind: 'f', def: 1, min: 0, max: 2 },
    { id: 'value', kind: 'f', def: 1, min: 0, max: 2 }, { id: 'fac', kind: 'f', def: 1, min: 0, max: 1 }],
  outputs: [{ id: 'color', kind: 'c' }],
  js: () => { const h = [0, 0, 0]; return (u, v, I, O) => {
    const c = I('color'), t = clamp01(I('fac'));
    h[0] = Math.max(0, c[0]); h[1] = Math.max(0, c[1]); h[2] = Math.max(0, c[2]); rgbToHsv(h);
    h[0] += I('hue') - 0.5; h[1] = clamp01(h[1] * I('saturation')); h[2] = Math.max(0, h[2] * I('value')); hsvToRgb(h);
    for (let k = 0; k < 3; k++) O.color[k] = c[k] + (h[k] - c[k]) * t;
  }; },
  wgsl: (P, C) => ({
    pre: `let c = ${C.in('color')}; var h = rgbToHsv(max(c, vec3f(0.0))); h = vec3f(h.x + ${C.in('hue')} - 0.5, clamp(h.y * ${C.in('saturation')}, 0.0, 1.0), max(0.0, h.z * ${C.in('value')}));`,
    out: { color: `mix(c, hsvToRgb(h), clamp(${C.in('fac')}, 0.0, 1.0))` },
  }),
});
def({
  type: 'brightcontrast', cat: 'color',
  inputs: [{ id: 'color', kind: 'c', def: '#808080' }, { id: 'bright', kind: 'f', def: 0, min: -1, max: 1 }, { id: 'contrast', kind: 'f', def: 0, min: -1, max: 1 }],
  outputs: [{ id: 'color', kind: 'c' }],
  js: () => (u, v, I, O) => {
    const c = I('color'), ct = I('contrast'), a = 1 + ct, b = I('bright') - ct * 0.5;
    for (let k = 0; k < 3; k++) O.color[k] = Math.max(0, a * c[k] + b);
  },
  wgsl: (P, C) => ({ pre: `let ct = ${C.in('contrast')};`, out: { color: `max(vec3f(0.0), (1.0 + ct) * ${C.in('color')} + vec3f(${C.in('bright')} - ct * 0.5))` } }),
});
def({
  type: 'invert', cat: 'color',
  inputs: [{ id: 'fac', kind: 'f', def: 1, min: 0, max: 1 }, { id: 'color', kind: 'c', def: '#000000' }],
  outputs: [{ id: 'color', kind: 'c' }],
  js: () => (u, v, I, O) => { const c = I('color'), t = clamp01(I('fac')); for (let k = 0; k < 3; k++) O.color[k] = c[k] + (1 - 2 * c[k]) * t; },
  wgsl: (P, C) => ({ pre: `let c = ${C.in('color')};`, out: { color: `mix(c, vec3f(1.0) - c, clamp(${C.in('fac')}, 0.0, 1.0))` } }),
});
def({
  type: 'gamma', cat: 'color',
  inputs: [{ id: 'color', kind: 'c', def: '#808080' }, { id: 'gamma', kind: 'f', def: 1, min: 0.01, max: 10 }],
  outputs: [{ id: 'color', kind: 'c' }],
  js: () => (u, v, I, O) => { const c = I('color'), g = I('gamma'); for (let k = 0; k < 3; k++) O.color[k] = c[k] > 0 ? Math.pow(c[k], g) : 0; },
  wgsl: (P, C) => ({ pre: `let c = ${C.in('color')}; let g = ${C.in('gamma')};`, out: { color: 'select(vec3f(0.0), pow(max(c, vec3f(1e-30)), vec3f(g)), c > vec3f(0.0))' } }),
});
def({
  type: 'separate', cat: 'color', inputs: [{ id: 'color', kind: 'c', def: '#808080' }],
  outputs: [{ id: 'r', kind: 'f' }, { id: 'g', kind: 'f' }, { id: 'b', kind: 'f' }],
  js: () => (u, v, I, O) => { const c = I('color'); O.r = c[0]; O.g = c[1]; O.b = c[2]; },
  wgsl: (P, C) => ({ pre: `let c = ${C.in('color')};`, out: { r: 'c.x', g: 'c.y', b: 'c.z' } }),
});
def({
  type: 'combine', cat: 'color',
  inputs: [{ id: 'r', kind: 'f', def: 0 }, { id: 'g', kind: 'f', def: 0 }, { id: 'b', kind: 'f', def: 0 }],
  outputs: [{ id: 'color', kind: 'c' }],
  js: () => (u, v, I, O) => { O.color[0] = I('r'); O.color[1] = I('g'); O.color[2] = I('b'); },
  wgsl: (P, C) => ({ pre: '', out: { color: `vec3f(${C.in('r')}, ${C.in('g')}, ${C.in('b')})` } }),
});

// ---------------------------------------------------------------- math
export const MATH_OPS = ['add', 'subtract', 'multiply', 'divide', 'power', 'minimum', 'maximum', 'absolute', 'sqrt', 'sine', 'cosine',
  'floor', 'fract', 'modulo', 'round', 'oneminus', 'greater', 'less', 'clamp', 'mix', 'smoothstep'];
/** Which of b, c an operation reads (the editor hides the others). */
export const MATH_ARITY = { absolute: 1, sqrt: 1, sine: 1, cosine: 1, floor: 1, fract: 1, round: 1, oneminus: 1, clamp: 3, mix: 3, smoothstep: 3 };
function mathJs(op, a, b, c) {
  switch (op) {
    case 'add': return a + b;
    case 'subtract': return a - b;
    case 'multiply': return a * b;
    case 'divide': return b !== 0 ? a / b : 0;
    case 'power': return a > 0 ? Math.pow(a, b) : a === 0 && b > 0 ? 0 : 0;
    case 'minimum': return Math.min(a, b);
    case 'maximum': return Math.max(a, b);
    case 'absolute': return Math.abs(a);
    case 'sqrt': return a > 0 ? Math.sqrt(a) : 0;
    case 'sine': return Math.sin(a);
    case 'cosine': return Math.cos(a);
    case 'floor': return Math.floor(a);
    case 'fract': return a - Math.floor(a);
    case 'modulo': return b !== 0 ? a - b * Math.floor(a / b) : 0;
    case 'round': return Math.floor(a + 0.5);
    case 'oneminus': return 1 - a;
    case 'greater': return a > b ? 1 : 0;
    case 'less': return a < b ? 1 : 0;
    case 'clamp': return Math.min(Math.max(a, Math.min(b, c)), Math.max(b, c));
    case 'mix': return a + (b - a) * c;
    case 'smoothstep': { if (c === b) return a < b ? 0 : 1; const t = clamp01((a - b) / (c - b)); return t * t * (3 - 2 * t); }
    default: return a;
  }
}
function mathWgsl(op) {
  switch (op) {
    case 'add': return 'a + b';
    case 'subtract': return 'a - b';
    case 'multiply': return 'a * b';
    case 'divide': return 'select(0.0, a / b, b != 0.0)';
    case 'power': return 'select(0.0, pow(max(a, 1e-30), b), a > 0.0)';
    case 'minimum': return 'min(a, b)';
    case 'maximum': return 'max(a, b)';
    case 'absolute': return 'abs(a)';
    case 'sqrt': return 'select(0.0, sqrt(max(a, 0.0)), a > 0.0)';
    case 'sine': return 'sin(a)';
    case 'cosine': return 'cos(a)';
    case 'floor': return 'floor(a)';
    case 'fract': return 'a - floor(a)';
    case 'modulo': return 'select(0.0, a - b * floor(a / b), b != 0.0)';
    case 'round': return 'floor(a + 0.5)';
    case 'oneminus': return '1.0 - a';
    case 'greater': return 'select(0.0, 1.0, a > b)';
    case 'less': return 'select(0.0, 1.0, a < b)';
    case 'clamp': return 'min(max(a, min(b, c)), max(b, c))';
    case 'mix': return 'a + (b - a) * c';
    case 'smoothstep': return 'select(select(0.0, 1.0, a >= b), smooth1(clamp((a - b) / (c - b), 0.0, 1.0)), c != b)';
    default: return 'a';
  }
}
def({
  type: 'math', cat: 'math',
  inputs: [{ id: 'a', kind: 'f', def: 0.5 }, { id: 'b', kind: 'f', def: 0.5 }, { id: 'c', kind: 'f', def: 0 }],
  outputs: [{ id: 'value', kind: 'f' }],
  params: [{ id: 'op', kind: 'enum', def: 'add', options: MATH_OPS }, { id: 'clamp', kind: 'bool', def: false }],
  js: (P) => (u, v, I, O) => { const r = mathJs(P.op, I('a'), I('b'), I('c')); O.value = P.clamp ? clamp01(r) : r; },
  wgsl: (P, C) => {
    const r = mathWgsl(P.op);
    return { pre: `let a = ${C.in('a')}; let b = ${C.in('b')}; let c = ${C.in('c')};`, out: { value: P.clamp ? `clamp(${r}, 0.0, 1.0)` : r } };
  },
});
def({
  type: 'maprange', cat: 'math',
  inputs: [{ id: 'value', kind: 'f', def: 0.5 }],
  outputs: [{ id: 'value', kind: 'f' }],
  params: [{ id: 'from_min', kind: 'float', def: 0 }, { id: 'from_max', kind: 'float', def: 1 }, { id: 'to_min', kind: 'float', def: 0 },
    { id: 'to_max', kind: 'float', def: 1 }, { id: 'clamp', kind: 'bool', def: true }],
  js: (P) => (u, v, I, O) => {
    const d = P.from_max - P.from_min, t = d !== 0 ? (I('value') - P.from_min) / d : 0, r = P.to_min + (P.to_max - P.to_min) * (P.clamp ? clamp01(t) : t);
    O.value = r;
  },
  wgsl: (P, C) => {
    const d = P.from_max - P.from_min;
    const t = d !== 0 ? `(${C.in('value')} - ${f(P.from_min)}) / ${f(d)}` : '0.0';
    return { pre: `let t = ${P.clamp ? `clamp(${t}, 0.0, 1.0)` : t};`, out: { value: `${f(P.to_min)} + ${f(P.to_max - P.to_min)} * t` } };
  },
});

// ---------------------------------------------------------------- vector (normals)
def({
  type: 'bump', cat: 'vector',
  inputs: [{ id: 'height', kind: 'f', def: 0 }, { id: 'normal', kind: 'v3', def: [0, 0, 1] }],
  outputs: [{ id: 'normal', kind: 'v3' }],
  params: [{ id: 'strength', kind: 'float', def: 1, min: 0, max: 10 }, { id: 'distance', kind: 'float', def: 0.005, min: 0, max: 1 },
    { id: 'invert', kind: 'bool', def: false }],
  // The height's slope per metre by central differences one texel apart (the tile is C.tile metres across).
  js: (P, C) => {
    const e = 1 / C.size, kx = (P.strength * P.distance * (P.invert ? -1 : 1)) / ((2 * e) * C.tile[0]), ky = (P.strength * P.distance * (P.invert ? -1 : 1)) / ((2 * e) * C.tile[1]);
    return (u, v, I, O) => {
      const dx = (I.at('height', u + e, v) - I.at('height', u - e, v)) * kx, dy = (I.at('height', u, v + e) - I.at('height', u, v - e)) * ky;
      const n = I('normal'), nz = Math.max(1e-6, n[2]);
      const x = n[0] / nz - dx, y = n[1] / nz - dy, l = Math.hypot(x, y, 1);
      O.normal[0] = x / l; O.normal[1] = y / l; O.normal[2] = 1 / l;
    };
  },
  wgsl: (P, C) => {
    const e = 1 / C.size, sgn = P.invert ? -1 : 1;
    const kx = (P.strength * P.distance * sgn) / ((2 * e) * C.tile[0]), ky = (P.strength * P.distance * sgn) / ((2 * e) * C.tile[1]);
    return {
      pre: `let dx = (${C.in('height', `uv + vec2f(${f(e)}, 0.0)`)} - ${C.in('height', `uv - vec2f(${f(e)}, 0.0)`)}) * ${f(kx)};`
        + ` let dy = (${C.in('height', `uv + vec2f(0.0, ${f(e)})`)} - ${C.in('height', `uv - vec2f(0.0, ${f(e)})`)}) * ${f(ky)};`
        + ` let n = ${C.in('normal')}; let nz = max(1e-6, n.z);`,
      out: { normal: 'normalize(vec3f(n.x / nz - dx, n.y / nz - dy, 1.0))' },
    };
  },
});
def({
  type: 'normalmap', cat: 'vector',
  inputs: [{ id: 'color', kind: 'c', def: [0.5, 0.5, 1] }, { id: 'strength', kind: 'f', def: 1, min: 0, max: 10 }],
  outputs: [{ id: 'normal', kind: 'v3' }],
  params: [{ id: 'convention', kind: 'enum', def: 'opengl', options: ['opengl', 'directx'] }],
  js: (P) => (u, v, I, O) => {
    const c = I('color'), s = I('strength'), x = (2 * c[0] - 1) * s, y = (2 * c[1] - 1) * s * (P.convention === 'directx' ? -1 : 1), z = Math.max(1e-6, 2 * c[2] - 1);
    const l = Math.hypot(x, y, z);
    O.normal[0] = x / l; O.normal[1] = y / l; O.normal[2] = z / l;
  },
  wgsl: (P, C) => ({
    pre: `let c = ${C.in('color')}; let s = ${C.in('strength')};`,
    out: { normal: `normalize(vec3f((2.0 * c.x - 1.0) * s, (2.0 * c.y - 1.0) * s * ${P.convention === 'directx' ? '-1.0' : '1.0'}, max(1e-6, 2.0 * c.z - 1.0)))` },
  }),
});

export { luminance, vnoise };
