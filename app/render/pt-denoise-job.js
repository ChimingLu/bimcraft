/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-denoise-job.js — the denoiser's tiles on every core (0.7 RN.5): a job module for compute's page pool (compute/runtime.js
 * pagePool; docs/apps/compute.md § pool). The weights come once per worker through `pool.share('pt.oidn', bytes)`.
 *
 *   tile({input: Float32Array 9·h·w, h, w}, ctx) → {out: Float32Array 3·h·w}   the U-Net on one tile (pt-denoise.js unet)
 */
import { readTza, unet } from './pt-denoise.js';

let cache = null;   // { bytes (the shared array it was read from), net }
export function tile({ input, h, w }, ctx) {
  const bytes = ctx.shared['pt.oidn'];
  if (!cache || cache.bytes !== bytes) cache = { bytes, net: readTza(bytes) };
  const y = unet(cache.net, { c: 9, h, w, d: input });
  return { out: y.d };
}
