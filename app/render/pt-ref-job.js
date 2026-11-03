/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: developer errors */
/**
 * pt-ref-job.js — the JS reference path tracer as a pool job (0.7 RN.1, for `compute`'s CPU path, CU.5): `cpu-render.js` shares
 * the packed scene once and runs tiles on every core through `cpu-render-job.js`, which calls renderTile here. DOM-free; one
 * tracer per worker, made the first time a scene's buffers arrive and reused for every tile of that scene.
 *
 *   renderTile({x0, y0, tw, th, sample0, spp}, ctx) → Float32Array (tw·th·4: Σr, Σg, Σb, n; AP1)
 *   SHARED      the names the buffers are shared under (ctx.shared[name], pool.share): pt-pack.js's output field by field —
 *               'pt.header' (128 words), 'pt.tris', 'pt.attrs', 'pt.nodes', 'pt.mats', 'pt.ldat', 'pt.tex', and 'pt.mask'
 *               (the blue-noise mask; made here when not shared)
 *   shareable(packed, mask?) → {name: typedArray}   what to hand pool.share / cpu-render's share()
 */
import { makeTracer } from './pt-ref.js';
import { blueNoise } from './pt-sampler.js';

export const SHARED = Object.freeze({ header: 'pt.header', tris: 'pt.tris', attrs: 'pt.attrs', nodes: 'pt.nodes', mats: 'pt.mats', ldat: 'pt.ldat', textures: 'pt.tex', mask: 'pt.mask' });

export function shareable(pk, mask = null) {
  const out = {
    [SHARED.header]: new Uint32Array(pk.header), [SHARED.tris]: pk.tris, [SHARED.attrs]: pk.attrs, [SHARED.nodes]: pk.nodes,
    [SHARED.mats]: pk.mats, [SHARED.ldat]: pk.ldat, [SHARED.textures]: pk.textures,
  };
  if (mask) out[SHARED.mask] = mask;
  return out;
}

let cache = null;   // { header (the shared array it was made from), tracer }
export function renderTile({ x0, y0, tw, th, sample0 = 0, spp = 1 }, ctx) {
  const sh = ctx.shared || {};
  const header = sh[SHARED.header];
  if (!header) throw new Error('pt-ref-job: no shared scene (' + SHARED.header + ')');
  if (!cache || cache.header !== header) {
    const pk = { header, tris: sh[SHARED.tris], attrs: sh[SHARED.attrs], nodes: sh[SHARED.nodes], mats: sh[SHARED.mats], ldat: sh[SHARED.ldat], textures: sh[SHARED.textures] };
    cache = { header, tracer: makeTracer(pk, { mask: sh[SHARED.mask] || blueNoise(), caustics: false }) };   // RN.7: tiles cannot light-trace, so they keep the old way (and need no suppression)
  }
  const T = cache.tracer, out = new Float32Array(tw * th * 4);
  for (let s = sample0; s < sample0 + spp; s++) {
    if (ctx.cancelled && ctx.cancelled()) break;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const c = T.radiance(x0 + x, y0 + y, s), o = (y * tw + x) * 4;
      if (Number.isFinite(c[0]) && Number.isFinite(c[1]) && Number.isFinite(c[2])) { out[o] += Math.max(0, c[0]); out[o + 1] += Math.max(0, c[1]); out[o + 2] += Math.max(0, c[2]); }
      out[o + 3] += 1;
    }
  }
  return out;
}
