/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-adapt.js — adaptive sampling for the path tracers (0.7 RN.7; RENDER-SPEC § 3.2). Samples are drawn in passes of PASS; after
 * each pass every pixel still active is judged on how much its pass means disagree: the standard error of the mean of its pass
 * means against the picture's own value. A converged pixel is never sampled again. No DOM, no imports; the WGSL `adapt` stage
 * (pt-wgsl.js) does the same arithmetic in f32 on the graphics card.
 *
 *   makeAdaptive(w, h, {noise, min}) → { active: Uint8Array (1 = still sampled), count, update(accum) → count }
 *       accum = Σ r, g, b and the sample count per pixel (Float32Array or Float64Array, w·h·4: the tracers' accumulation)
 *   runAdaptive(tracer, adaptive, {spp, s0, accum}) → accum      the reference tracer pass by pass until converged or spp samples
 *   ADAPT { PASS, FLOOR }, minPasses(min)
 *
 * Per pixel, from the pass means m_j = (Y_now − Y_before)/ΔN (Y = the luminance of Σ rgb, AP1 weights): S1 = Σ m_j, S2 = Σ m_j²,
 * J = n/PASS passes. From J ≥ minPasses: μ = S1/J, v = max(0, (S2 − S1²/J)/(J − 1)), se = √(v/J); converged when
 * se ≤ noise · (μ + FLOOR).
 */
export const ADAPT = Object.freeze({ PASS: 4, FLOOR: 0.02 });
/** The first pass count a pixel may stop at: `min` samples, at least four passes. */
export const minPasses = (min) => Math.max(4, Math.ceil((min || 16) / ADAPT.PASS));

export function makeAdaptive(w, h, { noise = 0.02, min = 16 } = {}) {
  const n = w * h, active = new Uint8Array(n).fill(1), S = new Float64Array(n * 4);   // S1, S2, Y before, N before
  const j0 = minPasses(min);
  let count = n;
  return {
    active, noise, min, w, h,
    get count() { return count; },
    update(accum) {
      for (let i = 0; i < n; i++) {
        if (!active[i]) continue;
        const o = i * 4, N = accum[o + 3], Y = 0.2722 * accum[o] + 0.6741 * accum[o + 1] + 0.0537 * accum[o + 2], dn = N - S[o + 3];
        if (!(dn > 0)) continue;
        const m = (Y - S[o + 2]) / dn;
        S[o] += m; S[o + 1] += m * m; S[o + 2] = Y; S[o + 3] = N;
        const J = Math.round(N / ADAPT.PASS);
        if (J >= j0) {
          const mu = S[o] / J, v = Math.max(0, (S[o + 1] - (S[o] * S[o]) / J) / (J - 1)), se = Math.sqrt(v / J);
          if (se <= noise * (mu + ADAPT.FLOOR)) { active[i] = 0; count--; }
        }
      }
      return count;
    },
  };
}

/** The reference tracer's passes: PASS samples of every active pixel, then the judgement; stops when none is left. */
export function runAdaptive(T, adaptive, { spp = 64, s0 = 0, accum = null } = {}) {
  accum = accum || new Float64Array(T.w * T.h * 4);
  for (let s = s0; s < spp && adaptive.count > 0; s += ADAPT.PASS) {
    T.render({ spp: Math.min(ADAPT.PASS, spp - s), s0: s, accum, active: adaptive.active });
    adaptive.update(accum);
  }
  return accum;
}
