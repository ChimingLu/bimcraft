/* SPDX-License-Identifier: Apache-2.0 */
/**
 * shading/bake.js — a material graph → what the renderers read (0.7 MT.1; RENDER-SPEC § 6.6): the OpenPBR parameters of the
 * record and up to three texture layers over one tile. No DOM. The JS bake here is the reference; shading/bake-gpu.js runs the
 * same graph compiled to WGSL and hands its pixels to `finishBake`, so both paths end in the same numbers.
 *
 *   planBake(graph) → {need: {base, data, emit, height}, linked: Set<input id>, averaged: [input id]}
 *   bakeMaterial(graph, {size = 512, images}) → bake      images: Map key → {w, h, data RGBA8 rows bottom-up} (shading/images.js)
 *   finishBake(graph, plan, pixels, {size, images}) → bake   pixels = {base, data, emit: Uint8Array size²·4 | null, height: Float32Array | null}
 *   bake = {pbr: {OpenPBR name: value} (colours linear AP1), layers: {base, data, emit}, height, flags: {rough, normal, metal,
 *           opacity}, size: [w, h] metres, mapping: 0 UV | 1 box | 2 triplanar, sharpness, normalStrength, displacementScale,
 *           color '#rrggbb' (the colour from afar), rough, metal, opacity, glass, notes: [input ids the path tracer averages],
 *           linked: [the output's linked input ids]}
 *   LAYER_INPUTS   which output inputs each layer carries
 *
 * Layer bytes (RENDER-SPEC § 6.6): base = sRGB base colour + roughness; data = normal x, y (⌊127·x + 128.5⌋), metalness, opacity;
 * emission = sRGB emission colour, 255. A value is quantised as ⌊255·x + ½⌋ (clamped), on both paths.
 */
import { compileJS, constValue } from './compile-js.js';
import { outputNode } from './graph.js';
import { nodeType, PBR_INPUTS } from './nodes.js';
import { srgbEncode, srgbDecode, linearHex } from './lib.js';
import { rgbToAp1, MAPPING } from '../render/pt-spec.js';

export const LAYER_INPUTS = Object.freeze({
  base: ['base_color', 'specular_roughness'], data: ['normal', 'base_metalness', 'geometry_opacity'], emit: ['emission_color'], height: ['displacement'],
});
const IN_LAYER = new Set(Object.values(LAYER_INPUTS).flat());
const AVG = 64;   // the grid an input the path tracer cannot vary is averaged over
const q8 = (x) => (x <= 0 ? 0 : x >= 1 ? 255 : Math.floor(x * 255 + 0.5));
/** A normal component −1…1 → a byte, 0 → exactly 128 (RENDER-SPEC § 6.6). */
const qn = (x) => Math.min(255, Math.max(0, Math.floor(127 * x + 128.5)));

export function planBake(graph) {
  const out = outputNode(graph), linked = new Set();
  for (const l of graph.links) if (l.to[0] === out.id) linked.add(l.to[1]);
  const has = (ids) => ids.some((i) => linked.has(i));
  return {
    need: { base: has(LAYER_INPUTS.base), data: has(LAYER_INPUTS.data), emit: has(LAYER_INPUTS.emit), height: has(LAYER_INPUTS.height) },
    linked,
    averaged: PBR_INPUTS.map((i) => i.id).filter((id) => linked.has(id) && !IN_LAYER.has(id)),
  };
}

const ctxOf = (graph, size, images) => {
  const P = outputNode(graph).params;
  return { size, tile: [P.width, P.height], image: (k) => (images && images.get(k)) || null };
};

export function bakeMaterial(graph, { size = 512, images = null } = {}) {
  const plan = planBake(graph), C = compileJS(graph, ctxOf(graph, size, images)), n = size * size;
  const px = {
    base: plan.need.base ? new Uint8Array(n * 4) : null, data: plan.need.data ? new Uint8Array(n * 4) : null,
    emit: plan.need.emit ? new Uint8Array(n * 4) : null, height: plan.need.height ? new Float32Array(n) : null,
  };
  const fBase = C.input('base_color'), fRough = C.input('specular_roughness'), fN = C.input('normal'), fM = C.input('base_metalness');
  const fO = C.input('geometry_opacity'), fE = C.input('emission_color'), fH = C.input('displacement');
  for (let j = 0; j < size; j++) {
    const v = (j + 0.5) / size;
    for (let i = 0; i < size; i++) {
      const u = (i + 0.5) / size, o = (j * size + i) * 4;
      if (px.base) {
        const c = fBase(u, v);
        px.base[o] = q8(srgbEncode(c[0])); px.base[o + 1] = q8(srgbEncode(c[1])); px.base[o + 2] = q8(srgbEncode(c[2])); px.base[o + 3] = q8(fRough(u, v));
      }
      if (px.data) {
        const nn = fN(u, v), l = Math.hypot(nn[0], nn[1], nn[2]) || 1;
        px.data[o] = qn(nn[0] / l); px.data[o + 1] = qn(nn[1] / l); px.data[o + 2] = q8(fM(u, v)); px.data[o + 3] = q8(fO(u, v));
      }
      if (px.emit) {
        const c = fE(u, v);
        px.emit[o] = q8(srgbEncode(c[0])); px.emit[o + 1] = q8(srgbEncode(c[1])); px.emit[o + 2] = q8(srgbEncode(c[2])); px.emit[o + 3] = 255;
      }
      if (px.height) px.height[j * size + i] = fH(u, v);
    }
  }
  return finishBake(graph, plan, px, { size, images, compiled: C });
}

export function finishBake(graph, plan, px, { size, images = null, compiled = null }) {
  const out = outputNode(graph), P = out.params, ot = nodeType('output');
  const C = compiled || compileJS(graph, ctxOf(graph, size, images));
  const val = (id) => constValue(ot.inputs.find((i) => i.id === id), out.values[id]);
  const pbr = {}, notes = [];
  for (const inp of ot.inputs) {
    if (inp.id === 'normal' || inp.id === 'displacement') continue;
    let v = val(inp.id);
    if (plan.linked.has(inp.id) && !IN_LAYER.has(inp.id)) {
      // the path tracer cannot vary this input across the surface: its mean over the tile (the editor says so)
      const fn = C.input(inp.id), acc = inp.kind === 'f' ? [0] : [0, 0, 0];
      for (let j = 0; j < AVG; j++) for (let i = 0; i < AVG; i++) {
        const x = fn((i + 0.5) / AVG, (j + 0.5) / AVG);
        if (inp.kind === 'f') acc[0] += x; else { acc[0] += x[0]; acc[1] += x[1]; acc[2] += x[2]; }
      }
      v = inp.kind === 'f' ? acc[0] / (AVG * AVG) : acc.map((a) => a / (AVG * AVG));
      notes.push(inp.id);
    }
    pbr[inp.id] = inp.kind === 'c' ? rgbToAp1(v) : v;
  }
  pbr.geometry_thin_walled = !!P.thin_walled;
  // the layers' means: what a kernel reads where it reads no texture (RENDER-SPEC § 6.6), and the colour from afar
  const n = size * size, mean = (arr, k, dec) => { if (!arr) return null; let s = 0; for (let i = 0; i < n; i++) s += dec ? srgbDecode(arr[i * 4 + k] / 255) : arr[i * 4 + k] / 255; return s / n; };
  let baseLin = val('base_color'), rough = pbr.specular_roughness, metal = pbr.base_metalness, opacity = pbr.geometry_opacity;
  if (px.base) {
    if (plan.linked.has('base_color')) baseLin = [mean(px.base, 0, true), mean(px.base, 1, true), mean(px.base, 2, true)];
    if (plan.linked.has('specular_roughness')) rough = mean(px.base, 3);
  }
  if (px.data) {
    if (plan.linked.has('base_metalness')) metal = pbr.base_metalness = mean(px.data, 2);
    if (plan.linked.has('geometry_opacity')) opacity = pbr.geometry_opacity = mean(px.data, 3);
  }
  if (px.emit) pbr.emission_color = rgbToAp1([mean(px.emit, 0, true), mean(px.emit, 1, true), mean(px.emit, 2, true)]);
  if (!px.base) pbr.specular_roughness = rough;
  const mapping = P.mapping === 'box' ? MAPPING.BOX : P.mapping === 'triplanar' ? MAPPING.TRIPLANAR : MAPPING.UV;
  return {
    pbr,
    layers: { base: px.base, data: px.data, emit: px.emit },
    height: px.height,
    flags: { rough: plan.linked.has('specular_roughness'), normal: plan.linked.has('normal'), metal: plan.linked.has('base_metalness'), opacity: plan.linked.has('geometry_opacity') },
    size: [P.width, P.height], mapping, sharpness: P.sharpness, normalStrength: P.normal_strength, displacementScale: P.displacement_scale,
    color: linearHex(baseLin), rough, metal, opacity, glass: pbr.transmission_weight, notes, linked: [...plan.linked],
  };
}
