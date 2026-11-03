/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: developer errors */
/**
 * rt-probe-job.js — irradiance probes on every core (0.7 RT.2, session `realtime`): a pool job (compute/pool.js,
 * docs/apps/compute.md § pool). The packed scene arrives once through pool.share under render/pt-ref-job.js's SHARED names;
 * each job bakes a run of probes. One tracer per worker, made on a private copy of the header and reused for every probe:
 * a probe only rewrites that copy's camera words (pt-ref.js reads them on every ray), so nothing is allocated per probe or ray
 * beyond the panorama sums (KICKOFF rule 18).
 *
 *   bakeProbes({headers: Uint32Array(k·128), w, h, spp, dirs: Float32Array(w·h·3)}, ctx) → Float32Array(k·12)   rt-probes.js
 *     projectL1 of each probe's panorama (linear Rec.709)
 *   bakeWith(tracer, header, job, out?) → the same, for a caller that owns its tracer (Node tests)
 */
import { makeTracer } from '../render/pt-ref.js';
import { blueNoise } from '../render/pt-sampler.js';
import { SHARED } from '../render/pt-ref-job.js';
import { projectL1 } from './rt-probes.js';

let cache = null;   // { shared header it was made from, own header copy, tracer, accum }

export function bakeWith(tracer, own, { headers, w, h, spp, dirs }, ctx = null, out = null) {
  const k = headers.length / 128;
  out = out || new Float32Array(k * 12);
  const acc = new Float32Array(w * h * 4);
  for (let p = 0; p < k; p++) {
    if (ctx && ctx.cancelled && ctx.cancelled()) break;
    own.set(headers.subarray(p * 128, p * 128 + 128));
    acc.fill(0);
    for (let s = 0; s < spp; s++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = tracer.radiance(x, y, s), o = (y * w + x) * 4;
      if (Number.isFinite(c[0]) && Number.isFinite(c[1]) && Number.isFinite(c[2])) { acc[o] += Math.max(0, c[0]); acc[o + 1] += Math.max(0, c[1]); acc[o + 2] += Math.max(0, c[2]); }
      acc[o + 3] += 1;
    }
    projectL1(acc, dirs, w, h, out, p * 12);
    if (ctx && ctx.progress) ctx.progress((p + 1) / k);
  }
  return out;
}

export function bakeProbes(job, ctx) {
  const sh = ctx.shared || {};
  const header = sh[SHARED.header];
  if (!header) throw new Error('rt-probe-job: no shared scene (' + SHARED.header + ')');
  if (!cache || cache.header !== header) {
    const own = new Uint32Array(128);
    own.set(header.subarray(0, 128));
    const pk = { header: own, tris: sh[SHARED.tris], attrs: sh[SHARED.attrs], nodes: sh[SHARED.nodes], mats: sh[SHARED.mats], ldat: sh[SHARED.ldat], textures: sh[SHARED.textures] };
    cache = { header, own, tracer: makeTracer(pk, { mask: sh[SHARED.mask] || blueNoise(), caustics: false }) };
  }
  return bakeWith(cache.tracer, cache.own, job, ctx);
}
