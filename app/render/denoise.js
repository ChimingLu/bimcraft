/* SPDX-License-Identifier: Apache-2.0 */
/**
 * denoise.js — denoising a finished (or stopped) path-traced picture in the page (0.7 RN.5): the network on the graphics card
 * (pt-denoise-gpu.js), else on every core through compute's page pool (pt-denoise.js denoisePool). Used by the Render dialog
 * (render-pt.js, render-ui.js) and the view's render (ipr.js).
 *
 *   beautyLinear(layers) → Float32Array w·h·3      the picture as rendered (AP1 means)
 *   denoiseLayers(layers, lin = beautyLinear(layers), {signal, onProgress}) → Promise<{lin, engine 'gpu' | 'cpu'}>
 *     needs the guides (layers.nElements ≥ 2: albedo, normal); `lin` is what to denoise (the picture, or a light mix)
 */
import { loadNet, loadWeights, denoisePool } from './pt-denoise.js';

export function beautyLinear(L) {
  const n = L.w * L.h, lin = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const c = L.accum[i * 4 + 3] || 1; lin[i * 3] = L.accum[i * 4] / c; lin[i * 3 + 1] = L.accum[i * 4 + 1] / c; lin[i * 3 + 2] = L.accum[i * 4 + 2] / c; }
  return lin;
}
function guides(L) {
  const n = L.w * L.h, S = L.stride, alb = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const g = L.aux[(i * S) * 4 + 3] || 1;
    for (let k = 0; k < 3; k++) { alb[i * 3 + k] = L.aux[(i * S) * 4 + k] / g; nrm[i * 3 + k] = L.aux[(i * S + 1) * 4 + k] / g; }
  }
  return { alb, nrm };
}
export async function denoiseLayers(L, lin = null, { signal = null, onProgress = null } = {}) {
  if (!L || !L.aux || !(L.nElements >= 2)) throw Object.assign(new Error('no guides'), { code: 'no_guides' });   // i18n-ignore: caught by the caller
  lin = lin || beautyLinear(L);
  const { alb, nrm } = guides(L);
  try {
    const [{ createGpuDenoiser }, net] = await Promise.all([import('./pt-denoise-gpu.js'), loadNet()]);
    const dn = await createGpuDenoiser(net);
    try { return { lin: await dn.run(lin, alb, nrm, L.w, L.h, { signal, onProgress }), engine: 'gpu' }; } finally { dn.dispose(); }
  } catch (e) {
    if (e.code === 'cancelled' || e.code === 'no_weights' || e.code === 'bad_weights') throw e;
    // no WebGPU device for it: every core instead
    const [{ pagePool }, bytes] = await Promise.all([import('../compute/runtime.js'), loadWeights()]);
    const pool = await pagePool({});
    return { lin: await denoisePool(pool, bytes, lin, alb, nrm, L.w, L.h, { signal, onProgress }), engine: 'cpu' };
  }
}
