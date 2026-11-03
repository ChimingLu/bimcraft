/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-output.js — saving a path-traced picture (0.7 RN.9; RENDER-SPEC § 7). No DOM: bytes in, bytes out (the dialog makes JPEG and
 * WebP through the browser's own encoders). Uses lib/exr's EXR writer and zlib (the app's `../exr/` copy) and webm.js's stored
 * ZIP writer.
 *
 *   pngBytes(w, h, rgb, bits = 8) → Uint8Array   an RGB PNG; rgb = Uint8Array (8 bits) or Uint16Array (16 bits), w·h·3
 *   png16(displayFloats, w, h) → Uint8Array      a 16-bit PNG from pt-post.js post(…, {float: true})
 *   exrChannels(layers) → [{name, type 'float', data}]   every layer as linear ACEScg (AP1) floats: R G B (the picture as
 *     rendered: no exposure, white balance or grade — an EXR stays scene-referred), the render elements (albedo.RGB,
 *     N.XYZ, Z, diffuse_direct.RGB … emission.RGB, objectId, materialId) and each light group (light_<key>.RGB)
 *   exrBytes(layers, meta) → Uint8Array          one-part EXR, ZIP compression, ACEScg chromaticities, CadCraft attributes
 *   writeRenderFile(layers, settings, meta) → Uint8Array   the .ccrender file: a stored ZIP of render.json (format, version, size,
 *     samples, groups, settings incl. the mix and the post) and layers.exr (every layer as Σ values + the sample counts, so
 *     reopening gives back exactly the buffers the dialog mixes and grades)
 *   readRenderFile(bytes, readExr) → {layers, settings, meta} | throws {code: 'not_render' | 'damaged' | 'too_new' | 'too_big'}
 *     untrusted: sizes, names and numbers checked; the caller cleans settings (looks.js cleanSettings)
 */
import { ELEMENTS, MAX_GROUPS, GUIDE_COUNT } from './pt-spec.js';
import { deflateZlib } from '../exr/zlib.js';
import { writeExr } from '../exr/exr.js';
import { zipStored, crc32 } from './webm.js';

export const RENDER_FORMAT = 'cadcraft-render', RENDER_VERSION = 1;
export const MAX_RENDER_PIXELS = 8192 * 8192;
const ACESCG = { red: [0.713, 0.293], green: [0.165, 0.83], blue: [0.128, 0.044], white: [0.32168, 0.33767] };

// ---- PNG (own: signature, IHDR, one IDAT, IEND; filter 0 rows) ----
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
export function pngBytes(w, h, rgb, bits = 8) {
  const bpp = bits === 16 ? 6 : 3, row = w * bpp + 1, raw = new Uint8Array(row * h);
  for (let y = 0; y < h; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < w * 3; x++) {
      const v = rgb[y * w * 3 + x], o = y * row + 1 + (bits === 16 ? x * 2 : x);
      if (bits === 16) { raw[o] = v >>> 8; raw[o + 1] = v & 255; } else raw[o] = v;
    }
  }
  const ihdr = new Uint8Array(13), hv = new DataView(ihdr.buffer);
  hv.setUint32(0, w); hv.setUint32(4, h); ihdr[8] = bits; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', ihdr), chunk('IDAT', deflateZlib(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function png16(f, w, h) {
  const v = new Uint16Array(w * h * 3);
  for (let i = 0; i < v.length; i++) v[i] = Math.round(Math.min(1, Math.max(0, f[i])) * 65535);
  return pngBytes(w, h, v, 16);
}

// ---- EXR layers ----
const safe = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60) || 'x';
const elementNames = { albedo: 'albedo', normalDepth: null, diffuseDirect: 'diffuse_direct', diffuseIndirect: 'diffuse_indirect', specularDirect: 'specular_direct',
  specularIndirect: 'specular_indirect', transmissionDirect: 'transmission_direct', transmissionIndirect: 'transmission_indirect', emission: 'emission', ids: null };
export const groupChannel = (g) => 'light_' + safe(g.kind === 'lamp' ? 'lamp_' + (g.name || '') : g.kind);

/** Means for viewing (raw = false) or the Σ values + counts for reopening (raw = true). */
export function exrChannels(L, { raw = false } = {}) {
  const { w, h, accum, aux, stride = 0, nElements: nE = 0, groups = [] } = L, n = w * h, out = [];
  const ch = (name, fill) => { const d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = fill(i); out.push({ name, type: 'float', data: d }); };
  const cnt = (i) => accum[i * 4 + 3] || 1;
  const div = (i, v) => (raw ? v : v / cnt(i));
  for (const [k, c] of [['R', 0], ['G', 1], ['B', 2]]) ch(k, (i) => div(i, accum[i * 4 + c]));
  if (raw) ch('samples', (i) => accum[i * 4 + 3]);
  if (aux && nE) {
    const gC = (i) => aux[(i * stride + 0) * 4 + 3] || 1;   // the guides' own count (surfaces seen)
    ELEMENTS.slice(0, nE).forEach((e, k) => {   // nE = 2: the denoiser's guides alone
      const at = (i, c) => aux[(i * stride + k) * 4 + c];
      if (e === 'normalDepth') {
        for (const [nm, c] of [['N.X', 0], ['N.Y', 1], ['N.Z', 2]]) ch(nm, (i) => (raw ? at(i, c) : at(i, c) / gC(i)));
        ch('Z', (i) => (raw ? at(i, 3) : aux[(i * stride) * 4 + 3] ? at(i, 3) / gC(i) : 0));
      } else if (e === 'ids') {
        ch('objectId', (i) => at(i, 0)); ch('materialId', (i) => at(i, 1));
        if (raw) { ch('ids.inst', (i) => at(i, 2)); ch('ids.set', (i) => at(i, 3)); }
      } else if (e === 'albedo') {
        for (const [c, x] of [['R', 0], ['G', 1], ['B', 2]]) ch('albedo.' + c, (i) => (raw ? at(i, x) : at(i, x) / gC(i)));
        if (raw) ch('albedo.count', (i) => at(i, 3));
      } else for (const [c, x] of [['R', 0], ['G', 1], ['B', 2]]) ch(elementNames[e] + '.' + c, (i) => div(i, at(i, x)));
    });
  }
  if (aux && groups.length && stride > nE) groups.forEach((g, k) => { for (const [c, x] of [['R', 0], ['G', 1], ['B', 2]]) ch(groupChannel(g) + '.' + c, (i) => div(i, aux[(i * stride + nE + k) * 4 + x])); });
  return out;
}
export function exrBytes(L, meta = {}, { raw = false } = {}) {
  return writeExr({
    width: L.w, height: L.h, channels: exrChannels(L, { raw }), compression: 'zip',
    attributes: {
      chromaticities: { type: 'chromaticities', value: ACESCG },
      'cadcraft.app': { type: 'string', value: String(meta.app || 'CadCraft') },
      'cadcraft.samples': { type: 'int', value: Math.round(meta.samples || 0) },
    },
  });
}

// ---- the .ccrender file ----
export function writeRenderFile(L, settings, meta = {}) {
  const json = {
    format: RENDER_FORMAT, version: RENDER_VERSION, app: meta.app || 'CadCraft', created: meta.created || null,
    w: L.w, h: L.h, samples: meta.samples || 0, elements: L.nElements || 0, stride: L.stride || 0,
    groups: (L.groups || []).map((g) => ({ kind: g.kind, name: g.name || '' })), exposure: L.exposure || 0, wb: L.wb || [1, 1, 1], settings,
  };
  const enc = new TextEncoder();
  return zipStored([{ name: 'render.json', data: enc.encode(JSON.stringify(json)) }, { name: 'layers.exr', data: exrBytes(L, meta, { raw: true }) }]);
}

function unzipStored(b) {
  // our own files only: stored entries, local headers read in order
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), files = {};
  let o = 0;
  while (o + 30 <= b.length && v.getUint32(o, true) === 0x04034b50) {
    const method = v.getUint16(o + 8, true), crc = v.getUint32(o + 14, true), size = v.getUint32(o + 18, true), nl = v.getUint16(o + 26, true), xl = v.getUint16(o + 28, true);
    if (method !== 0) throw Object.assign(new Error('compressed entry'), { code: 'not_render' });   // i18n-ignore: caught by the caller
    const name = new TextDecoder().decode(b.subarray(o + 30, o + 30 + nl)), start = o + 30 + nl + xl;
    if (start + size > b.length) throw Object.assign(new Error('cut short'), { code: 'damaged' });   // i18n-ignore: caught by the caller
    const data = b.subarray(start, start + size);
    if (crc32(data) !== crc) throw Object.assign(new Error('crc'), { code: 'damaged' });   // i18n-ignore: caught by the caller
    files[name] = data;
    o = start + size;
  }
  return files;
}
export function readRenderFile(bytes, readExr) {
  const fail = (code) => { throw Object.assign(new Error(code), { code }); };   // i18n-ignore: caught by the caller
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 30 || b[0] !== 0x50 || b[1] !== 0x4b) fail('not_render');
  const files = unzipStored(b);
  if (!files['render.json'] || !files['layers.exr']) fail('not_render');
  let j;
  try { j = JSON.parse(new TextDecoder().decode(files['render.json'])); } catch { fail('damaged'); }
  if (!j || j.format !== RENDER_FORMAT) fail('not_render');
  if (!(j.version >= 1)) fail('damaged');
  if (j.version > RENDER_VERSION) fail('too_new');
  const w = j.w | 0, h = j.h | 0;
  if (!(w >= 1 && h >= 1) || w * h > MAX_RENDER_PIXELS) fail('too_big');
  const ex = readExr(files['layers.exr']);
  if (ex.width !== w || ex.height !== h) fail('damaged');
  const C = new Map(ex.channels.map((c) => [c.name, c.data]));
  const need = (name) => { const d = C.get(name); if (!d || d.length !== w * h) fail('damaged'); return d; };
  const n = w * h, accum = new Float32Array(n * 4), R = need('R'), G = need('G'), B = need('B'), S = need('samples');
  for (let i = 0; i < n; i++) { accum[i * 4] = R[i]; accum[i * 4 + 1] = G[i]; accum[i * 4 + 2] = B[i]; accum[i * 4 + 3] = S[i]; }
  const groups = Array.isArray(j.groups) ? j.groups.slice(0, MAX_GROUPS).map((g) => ({ kind: ['sky', 'sun', 'glow', 'others', 'lamp'].includes(g && g.kind) ? g.kind : 'others', name: typeof g?.name === 'string' ? g.name.slice(0, 120) : '' })) : [];
  const nE = j.elements === ELEMENTS.length || j.elements === GUIDE_COUNT ? j.elements : 0, hasG = groups.length > 0 && C.has(groupChannel(groups[0]) + '.R');
  const stride = nE + (hasG ? groups.length : 0);
  let aux = null;
  if (stride) {
    aux = new Float32Array(n * stride * 4);
    const put = (slot, c, d) => { for (let i = 0; i < n; i++) aux[(i * stride + slot) * 4 + c] = d[i]; };
    if (nE) {
      ELEMENTS.slice(0, nE).forEach((e, k) => {
        if (e === 'normalDepth') { put(k, 0, need('N.X')); put(k, 1, need('N.Y')); put(k, 2, need('N.Z')); put(k, 3, need('Z')); }
        else if (e === 'ids') { put(k, 0, need('objectId')); put(k, 1, need('materialId')); put(k, 2, need('ids.inst')); put(k, 3, need('ids.set')); }
        else if (e === 'albedo') { put(k, 0, need('albedo.R')); put(k, 1, need('albedo.G')); put(k, 2, need('albedo.B')); put(k, 3, need('albedo.count')); }
        else { const nm = elementNames[e]; put(k, 0, need(nm + '.R')); put(k, 1, need(nm + '.G')); put(k, 2, need(nm + '.B')); }
      });
    }
    if (hasG) groups.forEach((g, k) => { const nm = groupChannel(g); put(nE + k, 0, need(nm + '.R')); put(nE + k, 1, need(nm + '.G')); put(nE + k, 2, need(nm + '.B')); });
  }
  const fin = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  const wb = Array.isArray(j.wb) && j.wb.length === 3 ? j.wb.map((x) => Math.min(10, Math.max(0.01, fin(x, 1)))) : [1, 1, 1];
  const layers = { w, h, accum, aux, stride, nElements: nE, groups: hasG ? groups : [], exposure: Math.min(20, Math.max(-20, fin(j.exposure, 0))), wb, reopened: true };
  return { layers, settings: j.settings && typeof j.settings === 'object' ? j.settings : {}, meta: { app: typeof j.app === 'string' ? j.app.slice(0, 40) : '', samples: fin(j.samples, 0), created: typeof j.created === 'string' ? j.created.slice(0, 40) : '' } };
}
