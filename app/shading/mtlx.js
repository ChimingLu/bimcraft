/* SPDX-License-Identifier: Apache-2.0 */
/**
 * shading/mtlx.js — MaterialX in and out (0.7 MT.4, session `materials`). Our own reader and writer, written from the MaterialX
 * specification (v1.38/1.39, Apache-2.0: the document, node graph and standard node library chapters) and the OpenPBR Surface and
 * Autodesk Standard Surface parameter lists; no MaterialX code read. No DOM: it carries its own small, strict XML reader (the two
 * apps' xml.js differ), so Node, workers and both apps run it alike.
 *
 *   readMaterialX(text, {resolve(file, info) → picture key | null}) → {materials: [{name, graph, notes}], notes}
 *       Every surfacematerial (or the shader nodes when there is none) → a node graph: an open_pbr_surface, standard_surface,
 *       UsdPreviewSurface or gltf_pbr shader becomes the Material output (Standard Surface and the others by name, the colours
 *       linear Rec.709); what feeds an input becomes our nodes: image / tiledimage → Picture (+ Texture coordinates for tiling),
 *       texcoord, constant, normalmap, heighttonormal, extract, the arithmetic (add, subtract, multiply, divide, power, min, max,
 *       clamp, modulo, absval, floor, sqrt, sin, cos, smoothstep, mix, invert), hsvadjust, checkerboard, noise2d / fractal3d (as
 *       Noise), worleynoise2d / cellnoise2d (as Voronoi); a displacement shader → the displacement input. Anything else is left at
 *       its value and named in `notes`. `resolve` turns a file input into a picture key (fileprefix applied first).
 *   writeMaterialX(list, {flavor = 'open_pbr' | 'standard_surface'}) → {xml, files: [{name, data: Uint8Array PNG}], notes}
 *       list = [{name, bake}] (bake.js): constants as values, every texture layer as a PNG beside the document (sRGB base and
 *       emission colours, roughness, metalness, opacity, an OpenGL normal map, the height for displacement) read by tiledimage
 *       nodes whose uvtiling is 1 / the tile size (UVs in metres, as ModelCraft's faces and the path tracer use them).
 *   XML: parseXmlLite(text) → {name, attrs, children}   ident(s) → a MaterialX name
 */
import { newGraph, cleanGraph } from './graph.js';
import { defaultValues, defaultParams } from './nodes.js';
import { pngBytes } from '../render/pt-output.js';
import { AP1_TO_REC709, mul3, LIGHT_SCALE } from '../render/pt-spec.js';

// ---------------------------------------------------------------- XML (strict, small; entities: the five + numeric)
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const dec = (s) => (s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => {
  if (e[0] !== '#') return ENT[e];
  const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function parseXmlLite(text, { maxElements = 200000 } = {}) {
  const stack = [{ name: '#doc', attrs: {}, children: [] }];
  let i = 0, n = 0;
  const bad = (why) => { throw Object.assign(new Error('MaterialX: ' + why), { code: 'bad_xml' }); };   // i18n-ignore: caught, shown by code
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) { const e = text.indexOf('-->', lt + 4); if (e < 0) bad('comment'); i = e + 3; continue; }
    if (text.startsWith('<?', lt)) { const e = text.indexOf('?>', lt + 2); if (e < 0) bad('instruction'); i = e + 2; continue; }
    if (text.startsWith('<![CDATA[', lt)) { const e = text.indexOf(']]>', lt); if (e < 0) bad('cdata'); i = e + 3; continue; }
    if (text.startsWith('<!', lt)) { const e = text.indexOf('>', lt); if (e < 0) bad('declaration'); i = e + 1; continue; }
    const gt = text.indexOf('>', lt);
    if (gt < 0) bad('tag');
    const body = text.slice(lt + 1, gt);
    if (body[0] === '/') {
      const name = body.slice(1).trim().replace(/^.*:/, ''), top = stack.pop();
      if (!top || top.name !== name) bad('mismatched </' + name + '>');
      i = gt + 1; continue;
    }
    const self = body.endsWith('/'), m = /^([A-Za-z_][\w.:-]*)/.exec(body);
    if (!m) bad('tag name');   // i18n-ignore: parser detail, caught and shown by code (bad_xml)
    if (++n > maxElements) bad('too many elements');   // i18n-ignore: parser detail, caught and shown by code (bad_xml)
    const el = { name: m[1].replace(/^.*:/, ''), attrs: {}, children: [] };
    const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a;
    const rest = body.slice(m[1].length, self ? -1 : undefined);
    while ((a = re.exec(rest))) el.attrs[a[1].replace(/^.*:/, '')] = dec(a[3] ?? a[4]);
    stack[stack.length - 1].children.push(el);
    if (!self) stack.push(el);
    if (stack.length > 256) bad('too deep');   // i18n-ignore: parser detail, caught and shown by code (bad_xml)
    i = gt + 1;
  }
  if (stack.length !== 1) bad('unclosed <' + stack[stack.length - 1].name + '>');
  return stack[0].children.find((c) => c.name === 'materialx') || bad('no <materialx> element');
}
export const ident = (s) => { const x = String(s || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^([^A-Za-z_])/, '_$1'); return x || 'M'; };

// ---------------------------------------------------------------- the shaders' parameter names → OpenPBR (ours)
const OPENPBR = new Set(['base_weight', 'base_color', 'base_diffuse_roughness', 'base_metalness', 'specular_weight', 'specular_color', 'specular_roughness',
  'specular_ior', 'specular_roughness_anisotropy', 'transmission_weight', 'transmission_color', 'transmission_depth', 'subsurface_weight', 'subsurface_color',
  'subsurface_radius', 'coat_weight', 'coat_color', 'coat_roughness', 'coat_ior', 'fuzz_weight', 'fuzz_color', 'fuzz_roughness', 'thin_film_weight',
  'thin_film_thickness', 'thin_film_ior', 'emission_color', 'emission_luminance', 'geometry_opacity']);
/** name in the shader → [our input, value transform] */
const STANDARD = {
  base: ['base_weight'], base_color: ['base_color'], diffuse_roughness: ['base_diffuse_roughness'], metalness: ['base_metalness'],
  specular: ['specular_weight'], specular_color: ['specular_color'], specular_roughness: ['specular_roughness'], specular_IOR: ['specular_ior'],
  specular_anisotropy: ['specular_roughness_anisotropy'], transmission: ['transmission_weight'], transmission_color: ['transmission_color'],
  transmission_depth: ['transmission_depth'], subsurface: ['subsurface_weight'], subsurface_color: ['subsurface_color'], subsurface_scale: ['subsurface_radius'],
  sheen: ['fuzz_weight'], sheen_color: ['fuzz_color'], sheen_roughness: ['fuzz_roughness'], coat: ['coat_weight'], coat_color: ['coat_color'],
  coat_roughness: ['coat_roughness'], coat_IOR: ['coat_ior'], thin_film_thickness: ['thin_film_thickness', (v) => (typeof v === 'number' ? v / 1000 : v)],
  thin_film_IOR: ['thin_film_ior'], emission: ['emission_luminance', (v) => (typeof v === 'number' ? v / LIGHT_SCALE : v)], emission_color: ['emission_color'],
  opacity: ['geometry_opacity', (v) => (Array.isArray(v) ? (v[0] + v[1] + v[2]) / 3 : v)], normal: ['normal'],
};
const USDPS = { diffuseColor: ['base_color'], metallic: ['base_metalness'], roughness: ['specular_roughness'], ior: ['specular_ior'], opacity: ['geometry_opacity'],
  emissiveColor: ['emission_color'], clearcoat: ['coat_weight'], clearcoatRoughness: ['coat_roughness'], normal: ['normal'] };
const GLTF = { base_color: ['base_color'], metallic: ['base_metalness'], roughness: ['specular_roughness'], normal: ['normal'], transmission: ['transmission_weight'],
  emissive: ['emission_color'], emissive_strength: ['emission_luminance', (v) => (typeof v === 'number' ? v / LIGHT_SCALE : v)], alpha: ['geometry_opacity'], ior: ['specular_ior'] };
function shaderMap(cat) {
  if (cat === 'open_pbr_surface') return (name) => (OPENPBR.has(name) ? [name] : name === 'geometry_normal' ? ['normal'] : null);
  const T = cat === 'standard_surface' ? STANDARD : cat === 'UsdPreviewSurface' ? USDPS : cat === 'gltf_pbr' ? GLTF : null;
  return T ? (name) => T[name] || null : null;
}
const SHADERS = ['open_pbr_surface', 'standard_surface', 'UsdPreviewSurface', 'gltf_pbr'];

function parseValue(s, type) {
  if (s === undefined) return undefined;
  if (type === 'boolean') return s === 'true';
  if (type === 'string' || type === 'filename') return s;
  const v = String(s).split(',').map((x) => Number(x.trim()));
  if (!v.every(Number.isFinite)) return undefined;
  return v.length === 1 ? v[0] : v;
}
const KIND = { float: 'f', integer: 'f', color3: 'c', color4: 'c', vector3: 'v3', vector4: 'v3', vector2: 'v2' };

// ---------------------------------------------------------------- reading
export function readMaterialX(text, { resolve = () => null } = {}) {
  const doc = parseXmlLite(text), notes = [];
  const top = doc.children;
  const byName = new Map(top.filter((e) => e.attrs.name).map((e) => [e.attrs.name, e]));
  const docPrefix = doc.attrs.fileprefix || '';
  const mats = top.filter((e) => e.name === 'surfacematerial' || e.attrs.type === 'material');
  const shaderOf = (mat) => {
    const inp = mat.children.find((c) => c.name === 'input' && c.attrs.name === 'surfaceshader');
    return inp && inp.attrs.nodename ? byName.get(inp.attrs.nodename) || null : null;
  };
  const list = mats.length ? mats.map((m) => ({ name: m.attrs.name, shader: shaderOf(m), disp: (() => { const d = m.children.find((c) => c.name === 'input' && c.attrs.name === 'displacementshader'); return d ? byName.get(d.attrs.nodename) : null; })() }))
    : top.filter((e) => SHADERS.includes(e.name)).map((s) => ({ name: s.attrs.name, shader: s, disp: null }));
  const materials = [];
  for (const { name, shader, disp } of list) {
    if (!shader || !shaderMap(shader.name)) { notes.push('shader:' + (shader ? shader.name : '?')); continue; }
    materials.push(oneMaterial(name, shader, disp, { byName, docPrefix, resolve }));
  }
  return { materials, notes };
}

function oneMaterial(name, shader, disp, ctx) {
  const g = newGraph(name), out = g.nodes[0], notes = [];
  out.x = 900; out.y = 20;
  let nextId = 2, col = 0;
  const memo = new Map();
  const add = (type, params = {}, values = {}, depth = 1) => {
    const id = nextId++;
    g.nodes.push({ id, type, x: Math.max(20, 900 - depth * 230), y: 20 + (col++ % 12) * 170, values: { ...defaultValues(type), ...values }, params: { ...defaultParams(type), ...params } });
    return id;
  };
  const link = (a, o, b, i) => g.links.push({ from: [a, o], to: [b, i] });
  const tiling = [];
  // where an input's value comes from: {value} | {node: our id, out: our output} (following nodegraph outputs and interface names)
  function source(inp, scope, depth) {
    if (inp.attrs.interfacename && scope && scope.graph) {
      const gi = scope.graph.children.find((c) => c.name === 'input' && c.attrs.name === inp.attrs.interfacename);
      if (gi) return source(gi, scope.outer, depth);
    }
    if (inp.attrs.nodegraph) {
      const ng = ctx.byName.get(inp.attrs.nodegraph);
      const o = ng && ng.children.find((c) => c.name === 'output' && (!inp.attrs.output || c.attrs.name === inp.attrs.output));
      if (!o || !o.attrs.nodename) return { value: parseValue(inp.attrs.value, inp.attrs.type) };
      const node = ng.children.find((c) => c.attrs.name === o.attrs.nodename);
      return node ? translate(node, { graph: ng, outer: scope, prefix: (ng.attrs.fileprefix || '') }, depth, o.attrs.output) : { value: undefined };
    }
    if (inp.attrs.nodename) {
      const pool = scope && scope.graph ? scope.graph.children : null;
      const node = (pool && pool.find((c) => c.attrs.name === inp.attrs.nodename)) || ctx.byName.get(inp.attrs.nodename);
      return node ? translate(node, scope, depth, inp.attrs.output) : { value: undefined };
    }
    return { value: parseValue(inp.attrs.value, inp.attrs.type) };
  }
  const inputEl = (node, nm) => node.children.find((c) => c.name === 'input' && c.attrs.name === nm) || null;
  // put an input of a MaterialX node into our node's input
  function feed(node, nm, scope, depth, ourNode, ourIn, conv = (v) => v) {
    const e = inputEl(node, nm);
    if (!e) return;
    const s = source(e, scope, depth + 1);
    if (s.node) link(s.node, s.out, ourNode, ourIn);
    else if (s.value !== undefined) g.nodes.find((n) => n.id === ourNode).values[ourIn] = conv(s.value);
  }
  const color3 = (v) => (Array.isArray(v) ? v.slice(0, 3) : typeof v === 'number' ? [v, v, v] : v);
  function translate(node, scope, depth, outName) {
    const key = node.attrs.name + '@' + (scope && scope.graph ? scope.graph.attrs.name : '') + '#' + (outName || '');
    if (memo.has(key)) return memo.get(key);
    const r = translate1(node, scope, depth, outName);
    memo.set(key, r);
    return r;
  }
  function translate1(node, scope, depth, outName) {
    const cat = node.name, type = node.attrs.type;
    const val = (nm) => { const e = inputEl(node, nm); return e ? parseValue(e.attrs.value, e.attrs.type) : undefined; };
    if (cat === 'constant') return { value: val('value') };
    if (cat === 'image' || cat === 'tiledimage') {
      const fe = inputEl(node, 'file');
      const file = fe ? (scope && scope.prefix ? scope.prefix : '') + (ctx.docPrefix || '') + (fe.attrs.value || '') : '';
      const cs = fe && fe.attrs.colorspace ? fe.attrs.colorspace : '';
      const isColor = (type === 'color3' || type === 'color4') && cs !== 'raw' && !/lin/.test(cs);
      const key = file ? ctx.resolve(file, { type, colorspace: cs }) : null;
      if (!key) { notes.push('file:' + file); return { value: val('default') }; }
      const id = add('image', { image: key, space: isColor ? 'color' : 'data' }, {}, depth);
      if (cat === 'tiledimage') {
        const t = val('uvtiling'), o = val('uvoffset');
        if (Array.isArray(t) || Array.isArray(o)) tiling.push({ id, t: Array.isArray(t) ? t : [1, 1], o: Array.isArray(o) ? o : [0, 0] });
      }
      const tc = inputEl(node, 'texcoord');
      if (tc) { const s = source(tc, scope, depth + 1); if (s.node) link(s.node, s.out, id, 'uv'); }
      if (type === 'float') { const sep = add('separate', {}, {}, depth - 1); link(id, 'color', sep, 'color'); return { node: sep, out: 'r' }; }   // a float image reads its first channel
      return { node: id, out: 'color' };
    }
    if (cat === 'texcoord') return { node: add('texcoord', {}, {}, depth), out: 'uv' };
    if (cat === 'normalmap') {
      const id = add('normalmap', { convention: 'opengl' }, {}, depth);
      feed(node, 'in', scope, depth, id, 'color');
      const sc = val('scale');
      if (typeof sc === 'number') g.nodes.find((n) => n.id === id).values.strength = sc;
      return { node: id, out: 'normal' };
    }
    if (cat === 'heighttonormal') {
      const id = add('bump', { distance: 0.01 }, {}, depth);
      feed(node, 'in', scope, depth, id, 'height');
      return { node: id, out: 'normal' };
    }
    if (cat === 'extract') {
      const id = add('separate', {}, {}, depth);
      feed(node, 'in', scope, depth, id, 'color');
      return { node: id, out: ['r', 'g', 'b'][Math.max(0, Math.min(2, val('index') | 0))] };
    }
    const MATHS = { add: 'add', subtract: 'subtract', multiply: 'multiply', divide: 'divide', power: 'power', min: 'minimum', max: 'maximum', modulo: 'modulo',
      absval: 'absolute', floor: 'floor', sqrt: 'sqrt', sin: 'sine', cos: 'cosine', clamp: 'clamp', smoothstep: 'smoothstep' };
    const COLOR_BLEND = { add: 'add', subtract: 'subtract', multiply: 'multiply', min: 'darken', max: 'lighten' };
    if ((type === 'color3' || type === 'color4' || type === 'vector3') && COLOR_BLEND[cat]) {
      const id = add('mix', { mode: COLOR_BLEND[cat] }, { fac: 1 }, depth);
      feed(node, 'in1', scope, depth, id, 'a', color3); feed(node, 'in2', scope, depth, id, 'b', color3);
      return { node: id, out: 'color' };
    }
    if (type === 'float' && MATHS[cat]) {
      const id = add('math', { op: MATHS[cat] }, {}, depth);
      if (cat === 'clamp') { feed(node, 'in', scope, depth, id, 'a'); feed(node, 'low', scope, depth, id, 'b'); feed(node, 'high', scope, depth, id, 'c'); if (val('high') === undefined && !inputEl(node, 'high')) g.nodes.find((n) => n.id === id).values.c = 1; }
      else if (cat === 'smoothstep') { feed(node, 'in', scope, depth, id, 'a'); feed(node, 'low', scope, depth, id, 'b'); feed(node, 'high', scope, depth, id, 'c'); if (!inputEl(node, 'high')) g.nodes.find((n) => n.id === id).values.c = 1; }
      else { feed(node, inputEl(node, 'in') ? 'in' : 'in1', scope, depth, id, 'a'); feed(node, 'in2', scope, depth, id, 'b'); }
      return { node: id, out: 'value' };
    }
    if (cat === 'mix') {
      if (type === 'float') {
        const id = add('math', { op: 'mix' }, {}, depth);
        feed(node, 'bg', scope, depth, id, 'a'); feed(node, 'fg', scope, depth, id, 'b'); feed(node, 'mix', scope, depth, id, 'c');
        return { node: id, out: 'value' };
      }
      const id = add('mix', { mode: 'mix' }, {}, depth);
      feed(node, 'bg', scope, depth, id, 'a', color3); feed(node, 'fg', scope, depth, id, 'b', color3); feed(node, 'mix', scope, depth, id, 'fac');
      return { node: id, out: 'color' };
    }
    if (cat === 'invert') {
      if (type === 'float') { const id = add('math', { op: 'oneminus' }, {}, depth); feed(node, 'in', scope, depth, id, 'a'); return { node: id, out: 'value' }; }
      const id = add('invert', {}, { fac: 1 }, depth); feed(node, 'in', scope, depth, id, 'color', color3); return { node: id, out: 'color' };
    }
    if (cat === 'hsvadjust') {
      const id = add('hsv', {}, {}, depth);
      feed(node, 'in', scope, depth, id, 'color', color3);
      const a = val('amount');
      if (Array.isArray(a)) Object.assign(g.nodes.find((n) => n.id === id).values, { hue: 0.5 + a[0], saturation: a[1], value: a[2] });
      return { node: id, out: 'color' };
    }
    if (cat === 'checkerboard') {
      const id = add('checker', { scale: Math.max(1, Math.round((val('uvtiling') || [8])[0] || 8)) }, {}, depth);
      feed(node, 'color1', scope, depth, id, 'color1', color3); feed(node, 'color2', scope, depth, id, 'color2', color3);
      return { node: id, out: type === 'float' ? 'fac' : 'color' };
    }
    if (cat === 'noise2d' || cat === 'fractal3d' || cat === 'noise3d' || cat === 'fractal2d') {
      notes.push('approx:' + cat);
      return { node: add('noise', { scale: 8, detail: cat.startsWith('fractal') ? Math.max(1, Math.min(10, val('octaves') | 0 || 3)) : 1 }, {}, depth), out: type === 'float' ? 'fac' : 'color' };
    }
    if (cat === 'worleynoise2d' || cat === 'cellnoise2d' || cat === 'worleynoise3d' || cat === 'cellnoise3d') {
      notes.push('approx:' + cat);
      return { node: add('voronoi', { scale: 8, randomness: typeof val('jitter') === 'number' ? Math.max(0, Math.min(1, val('jitter'))) : 1 }, {}, depth), out: cat.startsWith('cell') ? 'color' : 'distance' };
    }
    if (cat === 'convert' || cat === 'dot' || cat === 'swizzle') { const e = inputEl(node, 'in'); return e ? source(e, scope, depth) : { value: undefined }; }
    notes.push('node:' + cat);
    return { value: undefined };
  }
  const map = shaderMap(shader.name);
  for (const inp of shader.children.filter((c) => c.name === 'input')) {
    const m = map(inp.attrs.name);
    if (!m) {
      if (inp.attrs.name === 'geometry_thin_walled' || inp.attrs.name === 'thin_walled') out.params.thin_walled = parseValue(inp.attrs.value, 'boolean') === true || inp.attrs.value === '1';
      continue;
    }
    const [ours, conv = (v) => v] = m;
    const s = source(inp, null, 1);
    if (s.node) link(s.node, s.out, 1, ours);
    else if (s.value !== undefined) {
      let v = conv(s.value);
      if (ours.endsWith('_color')) v = color3(v);
      if (ours === 'normal') continue;
      out.values[ours] = v;
    }
  }
  if (shader.name === 'standard_surface') {
    const tf = inputEl(shader, 'thin_film_thickness');
    if (tf && Number(tf.attrs.value) > 0) out.values.thin_film_weight = 1;
  }
  if (shader.name === 'gltf_pbr' || shader.name === 'UsdPreviewSurface') {
    if (out.values.emission_color && !out.values.emission_luminance && (out.values.emission_color.some?.((x) => x > 0))) out.values.emission_luminance = 1 / LIGHT_SCALE;
  }
  if (disp) {
    const d = inputEl(disp, 'displacement');
    if (d) { const s = source(d, null, 1); if (s.node) link(s.node, s.out, 1, 'displacement'); }
    const sc = inputEl(disp, 'scale');
    out.params.displacement_scale = sc ? Math.max(0, Math.min(10, Number(sc.attrs.value) || 0)) : 1;
  }
  // tiledimage tiling: one shared uvtiling becomes the tile's size (UVs in metres); differing ones a Texture coordinates node each
  if (tiling.length) {
    const t0 = tiling[0].t;
    if (tiling.every((x) => x.t[0] === t0[0] && x.t[1] === t0[1] && x.o[0] === 0 && x.o[1] === 0) && t0[0] > 0 && t0[1] > 0) { out.params.width = 1 / t0[0]; out.params.height = 1 / t0[1]; }
    else for (const x of tiling) {
      if (g.links.some((l) => l.to[0] === x.id && l.to[1] === 'uv')) continue;
      const tc = add('texcoord', { repeat_u: Math.max(1, Math.round(x.t[0])), repeat_v: Math.max(1, Math.round(x.t[1])), offset_u: x.o[0], offset_v: x.o[1] }, {}, 3);
      link(tc, 'uv', x.id, 'uv');
      if (Math.round(x.t[0]) !== x.t[0] || Math.round(x.t[1]) !== x.t[1]) notes.push('tiling');
    }
  }
  const r = cleanGraph(g);
  if (r.dropped) notes.push('dropped:' + r.dropped);
  return { name, graph: r.graph, notes };
}

// ---------------------------------------------------------------- writing
const lin709 = (ap1) => mul3(AP1_TO_REC709, ap1).map((x) => Math.max(0, x));
const f3 = (x) => (Math.round(x * 1e6) / 1e6).toString();
const v3s = (a) => a.map(f3).join(', ');
/** The standard_surface names for our OpenPBR parameters (the inverse of STANDARD). */
const TO_STANDARD = { base_weight: 'base', base_color: 'base_color', base_diffuse_roughness: 'diffuse_roughness', base_metalness: 'metalness', specular_weight: 'specular',
  specular_color: 'specular_color', specular_roughness: 'specular_roughness', specular_ior: 'specular_IOR', specular_roughness_anisotropy: 'specular_anisotropy',
  transmission_weight: 'transmission', transmission_color: 'transmission_color', transmission_depth: 'transmission_depth', subsurface_weight: 'subsurface',
  subsurface_color: 'subsurface_color', subsurface_radius: 'subsurface_scale', fuzz_weight: 'sheen', fuzz_color: 'sheen_color', fuzz_roughness: 'sheen_roughness',
  coat_weight: 'coat', coat_color: 'coat_color', coat_roughness: 'coat_roughness', coat_ior: 'coat_IOR', thin_film_thickness: 'thin_film_thickness',
  thin_film_ior: 'thin_film_IOR', emission_luminance: 'emission', emission_color: 'emission_color', geometry_opacity: 'opacity' };

export function writeMaterialX(list, { flavor = 'open_pbr' } = {}) {
  const files = [], notes = [], body = [], used = new Set();
  const uniq = (s) => { let n = ident(s), k = 2; while (used.has(n)) n = ident(s) + '_' + k++; used.add(n); return n; };
  for (const { name, bake } of list) {
    const M = uniq(name), size = bake.size, tile = `${f3(1 / size[0])}, ${f3(1 / size[1])}`, L = bake.layers, n = 512;
    if (bake.mapping !== 0) notes.push('mapping:' + M);
    const grey = (src, k, flip = false) => { const rgb = new Uint8Array(n * n * 3); for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const s = ((flip ? n - 1 - y : y) * n + x) * 4 + k, o = (y * n + x) * 3; rgb[o] = rgb[o + 1] = rgb[o + 2] = src[s]; } return rgb; };
    const rgbOf = (src) => { const rgb = new Uint8Array(n * n * 3); for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const s = ((n - 1 - y) * n + x) * 4, o = (y * n + x) * 3; rgb[o] = src[s]; rgb[o + 1] = src[s + 1]; rgb[o + 2] = src[s + 2]; } return rgb; };
    const normalRgb = (src) => {
      const rgb = new Uint8Array(n * n * 3);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const s = ((n - 1 - y) * n + x) * 4, o = (y * n + x) * 3;
        const nx = Math.max(-1, Math.min(1, (src[s] - 128) / 127)), ny = Math.max(-1, Math.min(1, (src[s + 1] - 128) / 127)), nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        rgb[o] = Math.round((nx * 0.5 + 0.5) * 255); rgb[o + 1] = Math.round((ny * 0.5 + 0.5) * 255); rgb[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      }
      return rgb;
    };
    const tex = [];   // [our input, file, type, colorspace]
    const png = (suffix, rgb) => { const f = M + '_' + suffix + '.png'; files.push({ name: f, data: pngBytes(n, n, rgb) }); return f; };
    const linkedIn = new Set(bake.linked || []);
    if (L.base) {
      if (linkedIn.has('base_color')) tex.push(['base_color', png('base_color', rgbOf(L.base)), 'color3', 'srgb_texture']);
      if (bake.flags.rough) tex.push(['specular_roughness', png('roughness', grey(L.base, 3, true)), 'float', '']);
    }
    if (L.data) {
      if (bake.flags.metal) tex.push(['base_metalness', png('metalness', grey(L.data, 2, true)), 'float', '']);
      if (bake.flags.opacity) tex.push(['geometry_opacity', png('opacity', grey(L.data, 3, true)), 'float', '']);
      if (bake.flags.normal) tex.push(['normal', png('normal', normalRgb(L.data)), 'vector3', '']);
    }
    if (L.emit) tex.push(['emission_color', png('emission', rgbOf(L.emit)), 'color3', 'srgb_texture']);
    let dispFile = null;
    if (bake.height && bake.displacementScale > 0) {
      let lo = Infinity, hi = -Infinity;
      for (const h of bake.height) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
      const rgb = new Uint8Array(n * n * 3), span = hi > lo ? hi - lo : 1, side = Math.round(Math.sqrt(bake.height.length)) || n;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const v = bake.height[Math.min(side - 1, Math.floor(((n - 1 - y) * side) / n)) * side + Math.min(side - 1, Math.floor((x * side) / n))]; rgb[(y * n + x) * 3] = rgb[(y * n + x) * 3 + 1] = rgb[(y * n + x) * 3 + 2] = Math.round(((v - lo) / span) * 255); }
      dispFile = png('height', rgb);
      notes.push('height:' + M);
      bake.dispRange = [lo, span];
    }
    const NG = 'NG_' + M, nodes = [], outs = [];
    for (const [ours, file, type, cs] of tex) {
      const nm = ours === 'normal' ? 'normal_map' : ours;
      nodes.push(`    <tiledimage name="${nm}" type="${type}">\n      <input name="file" type="filename" value="${esc(file)}"${cs ? ` colorspace="${cs}"` : ''} />\n      <input name="uvtiling" type="vector2" value="${tile}" />\n    </tiledimage>`);
      if (ours === 'normal') {
        nodes.push(`    <normalmap name="normal" type="vector3">\n      <input name="in" type="vector3" nodename="normal_map" />\n      <input name="scale" type="float" value="${f3(bake.normalStrength ?? 1)}" />\n    </normalmap>`);
        outs.push(`    <output name="normal_out" type="vector3" nodename="normal" />`);
      } else outs.push(`    <output name="${ours}_out" type="${type}" nodename="${nm}" />`);
    }
    if (dispFile) {
      nodes.push(`    <tiledimage name="height" type="float">\n      <input name="file" type="filename" value="${esc(dispFile)}" />\n      <input name="uvtiling" type="vector2" value="${tile}" />\n    </tiledimage>`);
      outs.push(`    <output name="height_out" type="float" nodename="height" />`);
    }
    if (nodes.length) body.push(`  <nodegraph name="${NG}">\n${nodes.join('\n')}\n${outs.join('\n')}\n  </nodegraph>`);
    const linked = new Set(tex.map((x) => x[0]));
    const SH = 'SR_' + M, cat = flavor === 'standard_surface' ? 'standard_surface' : 'open_pbr_surface';
    const ins = [];
    const p = bake.pbr;
    for (const k of Object.keys(TO_STANDARD)) {
      const nm = cat === 'standard_surface' ? TO_STANDARD[k] : k;
      if (linked.has(k)) { ins.push(`    <input name="${nm}" type="${k.endsWith('_color') ? 'color3' : 'float'}" nodegraph="${NG}" output="${k}_out" />`); continue; }
      let v = p[k];
      if (v === undefined) continue;
      if (Array.isArray(v)) v = lin709(v);
      if (cat === 'standard_surface') {
        if (k === 'emission_luminance') v = v * LIGHT_SCALE;
        if (k === 'thin_film_thickness') v = v * 1000;
      }
      ins.push(`    <input name="${nm}" type="${Array.isArray(v) ? 'color3' : 'float'}" value="${Array.isArray(v) ? v3s(v) : f3(v)}" />`);
    }
    if (linked.has('normal')) ins.push(`    <input name="${cat === 'standard_surface' ? 'normal' : 'geometry_normal'}" type="vector3" nodegraph="${NG}" output="normal_out" />`);
    if (p.geometry_thin_walled) ins.push(cat === 'standard_surface' ? '    <input name="thin_walled" type="boolean" value="true" />' : '    <input name="geometry_thin_walled" type="boolean" value="true" />');
    body.push(`  <${cat} name="${SH}" type="surfaceshader">\n${ins.join('\n')}\n  </${cat}>`);
    let dispRef = '';
    if (dispFile) {
      body.push(`  <displacement name="DS_${M}" type="displacementshader">\n    <input name="displacement" type="float" nodegraph="${NG}" output="height_out" />\n    <input name="scale" type="float" value="${f3(bake.displacementScale * bake.dispRange[1])}" />\n  </displacement>`);
      dispRef = `\n    <input name="displacementshader" type="displacementshader" nodename="DS_${M}" />`;
    }
    body.push(`  <surfacematerial name="${M}" type="material">\n    <input name="surfaceshader" type="surfaceshader" nodename="${SH}" />${dispRef}\n  </surfacematerial>`);
  }
  // i18n-ignore: a comment written into the .mtlx file (the MaterialX shader names)
  const xml = `<?xml version="1.0"?>\n<!-- Written by CadCraft ModelCraft (MaterialX, ${flavor === 'standard_surface' ? 'Standard Surface' : 'OpenPBR Surface'}); textures are PNG beside this file, UVs in metres. -->\n<materialx version="${flavor === 'standard_surface' ? '1.38' : '1.39'}" colorspace="lin_rec709">\n${body.join('\n')}\n</materialx>\n`;
  return { xml, files, notes };
}
