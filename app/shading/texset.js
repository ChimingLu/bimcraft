/* SPDX-License-Identifier: Apache-2.0 */
/**
 * shading/texset.js — a set of texture pictures → a node material (0.7 MT.3, session `materials`). No DOM. Used for the
 * library's material items (their maps) and for texture sets people import (a folder or a zip: maps found by name).
 *
 *   ROLES                         color, roughness, gloss, metalness, normal, height, ao, opacity, emission
 *   roleOf(fileName) → {role, convention?} | null   by the usual words in texture-set file names (case and separators
 *                                 ignored): albedo / basecolor / diffuse / color → color; rough → roughness; gloss → gloss
 *                                 (roughness = 1 − gloss); metal → metalness; normal / nor (gl / dx) → normal; height /
 *                                 displacement / disp / bump → height; ao / occlusion → ao; opacity / alpha / mask →
 *                                 opacity; emissive / emission → emission. Packed maps (Poly Haven's "arm", ORM) and
 *                                 previews are left out.
 *   pickMaps(names) → {maps: {role: name}, skipped: [name], convention}   one file per role (an OpenGL normal before a
 *                                 DirectX one; PNG before JPEG before WebP at one role), only picture files
 *   textureSetGraph(maps, {name, size: [w, h] metres, convention, key(role) → picture key}) → graph   Picture nodes into the
 *                                 output: color → base color, roughness (or 1 − gloss) → roughness, metalness, a Normal map
 *                                 node, opacity, emission; height → displacement (scale 0: off until set); ao → a Picture node
 *                                 left unlinked, ready for Dirt and edge wear
 */
import { newGraph, cleanGraph } from './graph.js';
import { defaultValues, defaultParams } from './nodes.js';

export const ROLES = ['color', 'roughness', 'gloss', 'metalness', 'normal', 'height', 'ao', 'opacity', 'emission'];
const PICTURE = /\.(png|jpe?g|webp)$/i;
const RULES = [
  // order matters: the first rule a name matches wins
  [/(^|[^a-z])(arm|orm|rma|mra|packed|preview|thumb(nail)?|render|sphere)([^a-z]|$)/, null],
  [/normal|(^|[^a-z])nor(m)?([^a-z]|$)|nrm/, 'normal'],
  [/rough/, 'roughness'],
  [/gloss|smooth/, 'gloss'],
  [/metal/, 'metalness'],
  [/(^|[^a-z])ao([^a-z]|$)|ambient ?occlusion|occlusion/, 'ao'],
  [/height|displacement|(^|[^a-z])disp([^a-z]|$)|bump/, 'height'],
  [/opacity|alpha|(^|[^a-z])mask([^a-z]|$)|cutout/, 'opacity'],
  [/emissi(ve|on)|(^|[^a-z])emit/, 'emission'],
  [/albedo|base ?colou?r|diff(use)?|(^|[^a-z])colou?r([^a-z]|$)|(^|[^a-z])col([^a-z]|$)/, 'color'],
];

export function roleOf(fileName) {
  const base = String(fileName).split(/[\\/]/).pop();
  if (!PICTURE.test(base)) return null;
  const s = base.replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[_\-.]+/g, ' ');
  for (const [re, role] of RULES) {
    if (!re.test(s)) continue;
    if (!role) return null;
    if (role === 'normal') return { role, convention: /(normal|nor|nrm) ?(dx|directx)|(^|[^a-z])(dx|directx)([^a-z]|$)/.test(s) ? 'directx' : 'opengl' };
    return { role };
  }
  return null;
}

export function pickMaps(names) {
  const maps = {}, skipped = [];
  // lower is better: an OpenGL normal before a DirectX one, then PNG before JPEG before WebP
  const score = (n, r) => (r.convention === 'directx' ? 10 : 0) + (/\.png$/i.test(n) ? 0 : /\.jpe?g$/i.test(n) ? 1 : 2);
  let convention = 'opengl';
  for (const n of names) {
    const r = roleOf(n);
    if (!r) { skipped.push(n); continue; }
    const old = maps[r.role];
    if (old && score(old, roleOf(old)) <= score(n, r)) { skipped.push(n); continue; }
    if (old) skipped.push(old);
    maps[r.role] = n;
    if (r.role === 'normal') convention = r.convention;
  }
  if (maps.roughness && maps.gloss) { skipped.push(maps.gloss); delete maps.gloss; }
  return { maps, skipped, convention };
}

export function textureSetGraph(maps, { name = '', size = [1, 1], convention = 'opengl', key = (role) => 'map:' + role } = {}) {
  const g = newGraph(name);
  const out = g.nodes[0];
  Object.assign(out.params, { width: size[0], height: size[1], mapping: 'uv', displacement_scale: 0 });
  out.x = 620; out.y = 20;
  let id = 2, y = 20;
  const pic = (role, space) => {
    const n = { id: id++, type: 'image', x: 40, y, values: defaultValues('image'), params: { ...defaultParams('image'), image: key(role), space } };
    y += 210;   // a Picture node is about 190 tall
    g.nodes.push(n);
    return n.id;
  };
  const link = (a, o, b, i) => g.links.push({ from: [a, o], to: [b, i] });
  if (maps.color) link(pic('color', 'color'), 'color', 1, 'base_color');
  if (maps.roughness) link(pic('roughness', 'data'), 'color', 1, 'specular_roughness');
  else if (maps.gloss) {
    const p = pic('gloss', 'data'), inv = id++;
    g.nodes.push({ id: inv, type: 'math', x: 330, y: y - 210, values: { ...defaultValues('math') }, params: { ...defaultParams('math'), op: 'oneminus' } });
    link(p, 'color', inv, 'a'); link(inv, 'value', 1, 'specular_roughness');
  }
  if (maps.metalness) link(pic('metalness', 'data'), 'color', 1, 'base_metalness');
  if (maps.normal) {
    const p = pic('normal', 'data'), nm = id++;
    g.nodes.push({ id: nm, type: 'normalmap', x: 330, y: y - 210, values: defaultValues('normalmap'), params: { ...defaultParams('normalmap'), convention } });
    link(p, 'color', nm, 'color'); link(nm, 'normal', 1, 'normal');
  }
  if (maps.opacity) link(pic('opacity', 'data'), 'color', 1, 'geometry_opacity');
  if (maps.emission) { link(pic('emission', 'color'), 'color', 1, 'emission_color'); out.values.emission_luminance = 100; }
  if (maps.height) link(pic('height', 'data'), 'color', 1, 'displacement');
  if (maps.ao) pic('ao', 'data');   // not linked: the renderer works out occlusion; Dirt and edge wear can read it
  return cleanGraph(g).graph;
}
