/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: kernel ids and developer errors */
/**
 * bench-kernels.js — the path tracers `compute`'s bench and parity harness time and compare (0.7 RN.1 for CU.8 / CU.6):
 * the WGSL wavefront kernel (where the browser has WebGPU) and the JS reference (everywhere; the oracle). Each takes a bench
 * scene as `compute/bench-scenes.js` expandScene() gives it and packs it with pt-pack.js packBench.
 *
 *   kernels = [{ id, device: 'gpu' | 'js', reference?: true,
 *                run(scene, {w, h, spp, signal}) → Promise<{samples, ms, setupMs}>      ms = rendering only
 *                batches(scene, {w, h, spp, k, seed = 0}) → Promise<Float32Array[k]>     each w·h·3: the mean of its own spp
 *                                                                                        samples (disjoint indices), AP1
 *                makeDevice(scene, {w, h}) → { kind, renderRange(s0, spp, {signal}) → Promise<Float32Array w·h·4>, release() } }]
 * Radiance is in the kernels' working space (linear ACEScg, RENDER-SPEC § 2), the same for every kernel.
 */
import { packBench } from './pt-pack.js';
import { makeTracer } from './pt-ref.js';
import { blueNoise } from './pt-sampler.js';
import { createGpuTracer, gpuAdapter } from './pt-gpu.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const mean3 = (acc, w, h) => {
  const out = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { const n = acc[i * 4 + 3] || 1; out[i * 3] = acc[i * 4] / n; out[i * 3 + 1] = acc[i * 4 + 1] / n; out[i * 3 + 2] = acc[i * 4 + 2] / n; }
  return out;
};
const stop = () => Object.assign(new Error('stopped'), { code: 'cancelled' });

const reference = {
  id: 'js-reference', device: 'js', reference: true,
  async run(scene, { w, h, spp = 1, signal = null }) {
    const t0 = now(), T = makeTracer(packBench(scene, { w, h }), { mask: blueNoise() }), t1 = now();
    const acc = new Float64Array(w * h * 4);
    let s = 0;
    for (; s < spp; s++) { if (signal?.aborted) break; T.render({ spp: 1, s0: s, accum: acc }); }
    return { samples: s, ms: now() - t1, setupMs: t1 - t0 };
  },
  async batches(scene, { w, h, spp = 1, k = 4, seed = 0 }) {
    const T = makeTracer(packBench(scene, { w, h }), { mask: blueNoise() }), out = [];
    for (let b = 0; b < k; b++) out.push(mean3(T.render({ spp, s0: seed + b * spp }), w, h));
    return out;
  },
  makeDevice(scene, { w, h }) {
    const T = makeTracer(packBench(scene, { w, h }), { mask: blueNoise() });
    return {
      kind: 'js',
      async renderRange(s0, spp, { signal = null } = {}) {
        const acc = new Float64Array(w * h * 4);
        for (let s = s0; s < s0 + spp; s++) { if (signal?.aborted) throw stop(); T.render({ spp: 1, s0: s, accum: acc }); }
        return new Float32Array(acc);
      },
      release() {},
    };
  },
};

const wgsl = {
  id: 'wgsl-wavefront', device: 'gpu',
  async run(scene, { w, h, spp = 1, signal = null }) {
    const t0 = now(), tr = await createGpuTracer(packBench(scene, { w, h }), { adapter: await gpuAdapter(), mask: blueNoise() }), t1 = now();
    try {
      const r = await tr.run({ spp, signal });
      return { samples: r.samples, ms: now() - t1, setupMs: t1 - t0 };
    } finally { tr.dispose(); }
  },
  async batches(scene, { w, h, spp = 1, k = 4, seed = 0 }) {
    const tr = await createGpuTracer(packBench(scene, { w, h }), { adapter: await gpuAdapter(), mask: blueNoise() }), out = [];
    try { for (let b = 0; b < k; b++) out.push(mean3(await tr.renderRange(seed + b * spp, spp), w, h)); } finally { tr.dispose(); }
    return out;
  },
  makeDevice(scene, { w, h }) {
    let tr = null;
    return {
      kind: 'gpu',
      async renderRange(s0, spp, { signal = null } = {}) {
        tr ||= await createGpuTracer(packBench(scene, { w, h }), { adapter: await gpuAdapter(), mask: blueNoise() });
        return tr.renderRange(s0, spp, { signal });
      },
      release() { tr?.dispose(); tr = null; },
    };
  },
};

/** The JS reference always; the WGSL kernel where the browser has WebGPU at all (an adapter is asked for when it runs). */
export const kernels = typeof navigator !== 'undefined' && navigator.gpu ? [wgsl, reference] : [reference];
