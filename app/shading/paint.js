/* SPDX-License-Identifier: Apache-2.0 */
/**
 * shading/paint.js — simple texture painting (0.7 MT.6, session `materials`): a round brush stamped into a material's picture at a
 * place on its tile. No DOM. Pictures are the bakes' (shading/images.js: IMG_SIZE² RGBA8, rows bottom-up, v = 0 first), so a
 * stroke shows in the next bake at once; the page encodes the picture as a PNG when the stroke ends (`pictureRgb` → pngBytes).
 *
 *   blankPicture(hex = '#ffffff') → image      a new IMG_SIZE² picture of one colour
 *   stamp(im, u, v, brush) → bool              brush {radius (texels), color '#rrggbb', strength 0–1, hardness 0–1}: a soft
 *                                               disc centred on (u, v) (tile units, wrapping), each texel blended toward the colour
 *   strokeDabs(a, b, spacing) → [[u, v]]       dabs every `spacing` (tile units) from a (not included) to b (included)
 *   tileUV(uv, tile) → [u, v]                  metres along a face → tile units
 *   pictureRgb(im) → Uint8Array                RGB rows top-down (for a PNG)
 *   snapshot(im) / restore(im, snap)           a stroke's undo
 */
import { IMG_SIZE } from './images.js';

const hex3 = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export function blankPicture(hex = '#ffffff') {
  const S = IMG_SIZE, data = new Uint8Array(S * S * 4), [r, g, b] = hex3(/^#[0-9a-f]{6}$/i.test(hex) ? hex : '#ffffff');
  for (let i = 0; i < S * S; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  return { w: S, h: S, data };
}

export function stamp(im, u, v, { radius = 8, color = '#000000', strength = 1, hardness = 0.5 } = {}) {
  const W = im.w, H = im.h, d = im.data, [cr, cg, cb] = hex3(color);
  const cx = (u - Math.floor(u)) * W, cy = (v - Math.floor(v)) * H, R = Math.max(0.5, radius), inner = R * Math.min(0.999, Math.max(0, hardness));
  const k = Math.max(0, Math.min(1, strength));
  if (!(k > 0)) return false;
  const x0 = Math.floor(cx - R), x1 = Math.ceil(cx + R), y0 = Math.floor(cy - R), y1 = Math.ceil(cy + R);
  for (let y = y0; y <= y1; y++) {
    const yy = ((y % H) + H) % H, dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, r = Math.hypot(dx, dy);
      if (r >= R) continue;
      // full strength inside the hard core, then a smooth falloff to the rim
      let a = r <= inner ? 1 : 1 - (r - inner) / (R - inner);
      a = a * a * (3 - 2 * a) * k;
      const q = (yy * W + (((x % W) + W) % W)) * 4;
      d[q] = Math.round(d[q] + (cr - d[q]) * a); d[q + 1] = Math.round(d[q + 1] + (cg - d[q + 1]) * a); d[q + 2] = Math.round(d[q + 2] + (cb - d[q + 2]) * a);
      d[q + 3] = 255;
    }
  }
  return true;
}

export function strokeDabs(a, b, spacing) {
  const du = b[0] - a[0], dv = b[1] - a[1], L = Math.hypot(du, dv);
  if (!(spacing > 0) || L > 4) return [b.slice()];   // a jump (another face, a seam): one dab where it landed
  const n = Math.max(1, Math.floor(L / spacing)), out = [];
  for (let i = 1; i <= n; i++) out.push([a[0] + (du * i) / n, a[1] + (dv * i) / n]);
  return out;
}

export const tileUV = (uv, tile) => [uv[0] / (tile[0] || 1), uv[1] / (tile[1] || 1)];

export function pictureRgb(im) {
  const W = im.w, H = im.h, out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = ((H - 1 - y) * W + x) * 4, o = (y * W + x) * 3;
    out[o] = im.data[s]; out[o + 1] = im.data[s + 1]; out[o + 2] = im.data[s + 2];
  }
  return out;
}

export const snapshot = (im) => im.data.slice();
export function restore(im, snap) { im.data.set(snap); }
