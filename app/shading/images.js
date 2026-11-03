/* SPDX-License-Identifier: Apache-2.0 */
/**
 * shading/images.js — the pictures a material graph reads, made ready for both bakes (0.7 MT.1): every one becomes the same
 * IMG_SIZE × IMG_SIZE RGBA8 array (rows bottom-up, v = 0 first), so the JS reference and the WGSL bake sample identical bytes.
 * DOM-free except `decodeImage`, which only the page calls.
 *
 *   IMG_SIZE                          512 (= RENDER-SPEC § 6.6's layer size)
 *   resample({w, h, data}, flipRows = false) → {w: IMG_SIZE, h: IMG_SIZE, data}   area average down, bilinear up, wrapping
 *   libraryImage(materialId, 'albedo' | 'data') → image | null   a library material's texture (render/textures.js): albedo =
 *                                                  its colours; data = height in red, roughness in green
 *   imageKeys(graph) → [key]          the picture keys a graph's nodes name (every 'image' and 'library' setting)
 *   decodeImage(mime, base64) → Promise<image>   (page only) an imported picture, decoded by the browser
 */
import { material } from '../render/materials.js';
import { makeTexture } from '../render/textures.js';
import { nodeType } from './nodes.js';

export const IMG_SIZE = 512;

export function resample(src, flipRows = false) {
  const S = IMG_SIZE, out = new Uint8Array(S * S * 4), { w, h, data } = src;
  const row = (y) => (flipRows ? h - 1 - y : y);
  if (w === S && h === S && !flipRows) { out.set(data.subarray(0, S * S * 4)); return { w: S, h: S, data: out }; }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const o = (y * S + x) * 4;
      if (w >= S && h >= S) {
        // area average of the source pixels this one covers
        const x0 = Math.floor((x * w) / S), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / S)), y0 = Math.floor((y * h) / S), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / S));
        let r = 0, g = 0, b = 0, a = 0, k = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const q = (row(yy) * w + xx) * 4; r += data[q]; g += data[q + 1]; b += data[q + 2]; a += data[q + 3]; k++; }
        out[o] = Math.round(r / k); out[o + 1] = Math.round(g / k); out[o + 2] = Math.round(b / k); out[o + 3] = Math.round(a / k);
      } else {
        const fx = ((x + 0.5) * w) / S - 0.5, fy = ((y + 0.5) * h) / S - 0.5, xi = Math.floor(fx), yi = Math.floor(fy), tx = fx - xi, ty = fy - yi;
        for (let c = 0; c < 4; c++) {
          let s = 0;
          for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
            const sx = (((xi + i) % w) + w) % w, sy = (((yi + j) % h) + h) % h;
            s += (i ? tx : 1 - tx) * (j ? ty : 1 - ty) * data[(row(sy) * w + sx) * 4 + c];
          }
          out[o + c] = Math.round(s);
        }
      }
    }
  }
  return { w: S, h: S, data: out };
}

const LIB = new Map();
export function libraryImage(id, which) {
  const key = id + ':' + which;
  if (LIB.has(key)) return LIB.get(key);
  const m = material(id);
  let im = null;
  if (m && m.tex) {
    const t = makeTexture(m.tex, IMG_SIZE), n = t.w * t.h, d = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      if (which === 'albedo') { d[i * 4] = t.albedo[i * 4]; d[i * 4 + 1] = t.albedo[i * 4 + 1]; d[i * 4 + 2] = t.albedo[i * 4 + 2]; d[i * 4 + 3] = 255; }
      else { d[i * 4] = Math.round(t.height[i] * 255); d[i * 4 + 1] = Math.round(t.rough[i] * 255); d[i * 4 + 2] = 0; d[i * 4 + 3] = 255; }
    }
    im = resample({ w: t.w, h: t.h, data: d });
  }
  LIB.set(key, im);
  return im;
}

export function imageKeys(graph) {
  const keys = new Set();
  for (const n of graph.nodes) {
    const t = nodeType(n.type);
    for (const p of t ? t.params : []) {
      const v = n.params ? n.params[p.id] : '';
      if (!v) continue;
      if (p.kind === 'image') keys.add(v);   // Picture, Wear (its curvature and occlusion), …
      if (p.kind === 'library') { keys.add('lib:' + v + ':albedo'); keys.add('lib:' + v + ':data'); }
    }
  }
  return [...keys];
}

/** Page only: a picture from base64 → RGBA rows bottom-up at IMG_SIZE. */
export async function decodeImage(mime, base64) {
  const bin = atob(base64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([u8], { type: mime }));
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const g = cv.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const id = g.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close?.();
  return resample({ w: id.width, h: id.height, data: new Uint8Array(id.data.buffer) }, true);   // canvas rows top-down → ours bottom-up
}
