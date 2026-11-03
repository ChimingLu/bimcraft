/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-mix.js — light mixing and render elements after a render (0.7 RN.6; RENDER-SPEC § 7). No DOM; imports only pt-spec.js.
 * The kernels leave per pixel the picture (`accum`: Σ rgb, samples) and, when asked, `aux`: the render elements then one Σ rgb
 * per light group. Everything here works on those numbers, so changing a group's colour or brightness, or looking at an element,
 * never renders again.
 *
 *   mixKey(group) → the key a group's mix is kept under ('sky', 'sun', 'glow', 'others', 'lamp:<name>')
 *   cleanMix(obj, groups?) → {[key]: {on, color '#rrggbb', stops}}   untrusted (settings, a .ccrender file)
 *   mixGains(mix, groups) → Float64Array(3 · groups)   linear AP1 gains (on × colour × 2^stops)
 *   isPlainMix(mix) → true when every group is on, white, 0 stops (the picture as rendered)
 *   compose(layers, mix, {exposure, wb, show, post, lut}) → Uint8ClampedArray RGBA   the display picture: show = 'beauty' (the
 *     mix) or an element name (pt-spec ELEMENTS); layers = {w, h, accum, aux, stride, nElements, groups}; light (the picture and
 *     the lighting elements) goes through pt-post.js post() with `post` (RN.8), guides (albedo, normals, depth, ids) as they are
 *   SHOW = ['beauty', 'noisy' (the picture before denoising), …ELEMENTS but 'ids' → 'objects', 'materials']
 *   mixedLinear(layers, mix) → Float32Array w·h·3   the mixed picture, linear (what the denoiser takes for a mix)
 */
import { ELEMENTS, linearToSrgb, hexToAp1, AP1_TO_REC709, mul3 } from './pt-spec.js';
import { post as postImage } from './pt-post.js';

export const SHOW = ['beauty', 'noisy', 'albedo', 'normal', 'depth', 'diffuseDirect', 'diffuseIndirect', 'specularDirect', 'specularIndirect',
  'transmissionDirect', 'transmissionIndirect', 'emission', 'objects', 'materials'];
export const MAX_PRESETS = 20;

export const mixKey = (g) => (g.kind === 'lamp' ? 'lamp:' + (g.name || '') : g.kind);

export function cleanMix(o, groups = null) {
  const out = {};
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  const keys = groups ? new Set(groups.map(mixKey)) : null;
  let n = 0;
  for (const [k, v] of Object.entries(o)) {
    if (typeof k !== 'string' || k.length > 130 || !v || typeof v !== 'object') continue;
    if (keys && !keys.has(k)) continue;
    const color = typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color) ? v.color.toLowerCase() : '#ffffff';
    const stops = typeof v.stops === 'number' && Number.isFinite(v.stops) ? Math.min(6, Math.max(-6, Math.round(v.stops * 10) / 10)) : 0;
    out[k] = { on: v.on !== false, color, stops };
    if (++n >= 64) break;
  }
  return out;
}

export function isPlainMix(mix) {
  return Object.values(mix || {}).every((m) => m.on !== false && (m.color || '#ffffff') === '#ffffff' && !m.stops);
}

export function mixGains(mix, groups) {
  const g = new Float64Array(groups.length * 3);
  groups.forEach((gr, i) => {
    const m = (mix || {})[mixKey(gr)];
    if (m && m.on === false) return;
    // the colour is a tint: its AP1 value scaled so white is 1 (a tint never changes brightness by its own lightness alone)
    const c = m && m.color ? hexToAp1(m.color) : [1, 1, 1], k = Math.pow(2, (m && m.stops) || 0);
    g[i * 3] = c[0] * k; g[i * 3 + 1] = c[1] * k; g[i * 3 + 2] = c[2] * k;
  });
  return g;
}

const hashColor = (id) => {
  let x = (Math.imul(id | 0, 2654435761) >>> 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return [64 + (x & 127), 64 + ((x >>> 8) & 127), 64 + ((x >>> 16) & 127)];
};

export function mixedLinear(L, mix) {
  const { w, h, accum, aux, stride, nElements: nE, groups } = L, lin = new Float32Array(w * h * 3), gains = mixGains(mix, groups);
  for (let i = 0; i < w * h; i++) {
    const n = accum[i * 4 + 3] || 1;
    for (let k = 0; k < groups.length; k++) { const o = (i * stride + nE + k) * 4; lin[i * 3] += aux[o] * gains[k * 3] / n; lin[i * 3 + 1] += aux[o + 1] * gains[k * 3 + 1] / n; lin[i * 3 + 2] += aux[o + 2] * gains[k * 3 + 2] / n; }
  }
  return lin;
}

export function compose(L, mix, { exposure = 0, wb = null, show = 'beauty', post = null, lut = null, float = false } = {}) {
  const { w, h, accum, aux, stride, nElements: nE, groups } = L;
  const el = (name) => ELEMENTS.indexOf(name);
  const light = show === 'beauty' || show === 'noisy' || !aux || !['albedo', 'normal', 'depth', 'objects', 'materials'].includes(show);
  if (light) {
    // a linear AP1 picture (the mix, the beauty or one lighting element), then the post and the view transform
    const useMix = (show === 'beauty' || show === 'noisy') && aux && groups && groups.length && !isPlainMix(mix);
    // RN.5: the denoised picture (or the denoised mix, when it was made for this mix) stands in for the beauty
    if (show === 'beauty') {
      const dn = useMix ? (L.denoisedMix && L.denoisedMix.key === JSON.stringify(mix) ? L.denoisedMix.lin : null) : L.denoised;
      if (dn) return postImage(dn, w, h, post, { exposure, wb, lut, float });
    }
    const lin = new Float32Array(w * h * 3);
    const gains = useMix ? mixGains(mix, groups) : null, slot = show === 'beauty' || show === 'noisy' || !aux ? -1 : el(show);
    for (let i = 0; i < w * h; i++) {
      const n = accum[i * 4 + 3] || 1;
      if (gains) {
        let r = 0, g = 0, b = 0;
        for (let k = 0; k < groups.length; k++) { const o = (i * stride + nE + k) * 4; r += aux[o] * gains[k * 3]; g += aux[o + 1] * gains[k * 3 + 1]; b += aux[o + 2] * gains[k * 3 + 2]; }
        lin[i * 3] = r / n; lin[i * 3 + 1] = g / n; lin[i * 3 + 2] = b / n;
      } else if (slot >= 0) { const o = (i * stride + slot) * 4; lin[i * 3] = aux[o] / n; lin[i * 3 + 1] = aux[o + 1] / n; lin[i * 3 + 2] = aux[o + 2] / n; }
      else { lin[i * 3] = accum[i * 4] / n; lin[i * 3 + 1] = accum[i * 4 + 1] / n; lin[i * 3 + 2] = accum[i * 4 + 2] / n; }
    }
    return postImage(lin, w, h, post, { exposure, wb, lut, float });
  }
  const out = new Uint8ClampedArray(w * h * 4);   // guides are 8-bit pictures (a 16-bit save widens them)
  let depthMax = 0;
  if (show === 'depth') for (let i = 0; i < w * h; i++) { const b = (i * stride + el('normalDepth')) * 4, n = aux[(i * stride + el('albedo')) * 4 + 3]; if (n > 0) depthMax = Math.max(depthMax, aux[b + 3] / n); }
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    let rgb;
    if (show === 'albedo') {
      const b = (i * stride + el('albedo')) * 4, c = aux[b + 3] || 1;
      // a colour, not light: AP1 → Rec.709 → sRGB, no view transform
      rgb = aux[b + 3] ? mul3(AP1_TO_REC709, [aux[b] / c, aux[b + 1] / c, aux[b + 2] / c]).map((x) => Math.round(linearToSrgb(Math.min(1, Math.max(0, x))) * 255)).concat(255) : [0, 0, 0, 255];
    } else if (show === 'normal') {
      const b = (i * stride + el('normalDepth')) * 4, c = aux[(i * stride + el('albedo')) * 4 + 3];
      rgb = c ? [0, 1, 2].map((k) => Math.round((0.5 + 0.5 * Math.max(-1, Math.min(1, aux[b + k] / c))) * 255)).concat(255) : [0, 0, 0, 255];
    } else if (show === 'depth') {
      const b = (i * stride + el('normalDepth')) * 4, c = aux[(i * stride + el('albedo')) * 4 + 3];
      const v = c && depthMax > 0 ? 1 - aux[b + 3] / c / depthMax : 0, s0 = Math.round(linearToSrgb(Math.max(0, v)) * 255);
      rgb = [s0, s0, s0, 255];
    } else {
      const b = (i * stride + el('ids')) * 4, id = aux[b + (show === 'objects' ? 0 : 1)];
      rgb = id ? hashColor(Math.round(id)).concat(255) : [0, 0, 0, 255];
    }
    out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 255;
  }
  return out;
}
