/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-tables.js — the directional-albedo tables the OpenPBR layering needs (0.7 RN.2; RENDER-SPEC § 5.1, § 6.7). OpenPBR's
 * reduction to a mixture of lobes scales each layer's substrate by (1 − E_layer(μo)) ("albedo scaling"), and rough conductors
 * get their multiple-scattering energy back (Kulla & Conty 2017); both need E(μ, …) that has no closed form. The tables are
 * made here once per page by deterministic quadrature (Hammersley points, GGX visible-normal importance sampling), so every
 * kernel reads the same numbers: the JS reference directly, the WGSL kernel from one uniform buffer (`tableWords()`).
 *
 *   tables() → {spec, cond, condAvg, fuzz, words: Float32Array}      made once, cached
 *   lookupSpec(T, mu, rough, eta)   E of GGX dielectric reflection (Fresnel exact; eta = relative IOR ≥ 1)    16 × 16 × 16
 *   lookupCond(T, mu, rough)        E of a GGX conductor with F = 1 (single scattering)                      32 × 32
 *   lookupCondAvg(T, rough)         its cosine-weighted hemispherical average                                 32
 *   lookupFuzz(T, mu, rough)        E of the fuzz lobe (Charlie sheen, F = 1)                                 32 × 32
 *   TABLE_LAYOUT   offsets (in floats) and sizes inside `words`
 *
 * Axes: mu = cos θ ∈ [0, 1] and roughness ∈ [0, 1] on n grid points with the end points included (μ = 0 is evaluated at
 * 10⁻⁴: grazing hits must not clamp to a less-grazing value); eta ∈ [1, 3]. Lookups are bilinear / trilinear with clamping —
 * written identically in pt-wgsl.js.
 * Sources: Kulla & Conty, "Revisiting Physically Based Shading at Imageworks" (SIGGRAPH 2017 course) for the compensation;
 * Estevez & Kulla, "Production Friendly Microfacet Sheen BRDF" (2017) for the Charlie distribution; Neubelt & Pettineo (2013)
 * for its visibility term; Heitz 2018 for visible-normal sampling. Formulas only.
 */
import { MIN_ALPHA } from './pt-spec.js';
import { frDielectric, sampleVNDF, ggxLambda, charlieD, charlieV } from './pt-ggx.js';

export const N_SPEC = 16, N_COND = 32, N_FUZZ = 32, Q = 256;
export const TABLE_LAYOUT = Object.freeze({
  spec: { offset: 0, size: N_SPEC * N_SPEC * N_SPEC },
  cond: { offset: N_SPEC ** 3, size: N_COND * N_COND },
  condAvg: { offset: N_SPEC ** 3 + N_COND * N_COND, size: N_COND },
  fuzz: { offset: N_SPEC ** 3 + N_COND * N_COND + N_COND, size: N_FUZZ * N_FUZZ },
});
export const TABLE_FLOATS = TABLE_LAYOUT.fuzz.offset + TABLE_LAYOUT.fuzz.size;

/** Radical inverse base 2 (Hammersley's second coordinate). */
function vdc(i) { let b = i >>> 0, r = 0, f = 0.5; while (b) { if (b & 1) r += f; b >>>= 1; f *= 0.5; } return r; }

const axis = (i, n) => i / (n - 1);   // grid points from 0 to 1, end points included (grazing angles must not clamp)
const ETA0 = 1, ETA1 = 3;

const M = new Float64Array(3);
function specAlbedo(mu, rough, eta) {
  const a = Math.max(MIN_ALPHA, rough * rough);
  const wo = [Math.sqrt(Math.max(0, 1 - mu * mu)), 0, Math.max(1e-4, mu)];
  const g1o = 1 / (1 + ggxLambda(wo[0], wo[1], wo[2], a, a));
  let s = 0;
  for (let i = 0; i < Q; i++) {
    const m = sampleVNDF(wo, a, a, (i + 0.5) / Q, vdc(i), M);
    const d = wo[0] * m[0] + wo[1] * m[1] + wo[2] * m[2];
    const wi = [2 * d * m[0] - wo[0], 2 * d * m[1] - wo[1], 2 * d * m[2] - wo[2]];
    if (wi[2] <= 0) continue;
    const g2 = 1 / (1 + ggxLambda(wo[0], wo[1], wo[2], a, a) + ggxLambda(wi[0], wi[1], wi[2], a, a));
    s += (eta === null ? 1 : frDielectric(d, eta)) * (g2 / g1o);   // weight of a VNDF sample of the reflection lobe
  }
  return s / Q;
}
function fuzzAlbedo(mu, rough) {
  const nv = Math.max(1e-4, mu), sv = Math.sqrt(Math.max(0, 1 - nv * nv));
  let s = 0;
  for (let i = 0; i < Q; i++) {
    // cosine-weighted wi: E = mean of π f(wo, wi)
    const u1 = (i + 0.5) / Q, u2 = vdc(i), r = Math.sqrt(u1), ph = 2 * Math.PI * u2;
    const wi = [r * Math.cos(ph), r * Math.sin(ph), Math.sqrt(Math.max(0, 1 - u1))];
    const hx = wi[0] + sv, hy = wi[1], hz = wi[2] + nv, hl = Math.hypot(hx, hy, hz) || 1;
    s += Math.PI * charlieD(hz / hl, rough) * charlieV(wi[2], nv);
  }
  return s / Q;
}

let CACHE = null;
export function tables() {
  if (CACHE) return CACHE;
  const words = new Float32Array(TABLE_FLOATS);
  const L = TABLE_LAYOUT;
  for (let k = 0; k < N_SPEC; k++) for (let j = 0; j < N_SPEC; j++) for (let i = 0; i < N_SPEC; i++) {
    const eta = ETA0 + (ETA1 - ETA0) * axis(k, N_SPEC);
    words[L.spec.offset + (k * N_SPEC + j) * N_SPEC + i] = specAlbedo(axis(i, N_SPEC), axis(j, N_SPEC), eta);
  }
  for (let j = 0; j < N_COND; j++) {
    let avg = 0;
    for (let i = 0; i < N_COND; i++) {
      const mu = axis(i, N_COND), e = specAlbedo(mu, axis(j, N_COND), null);
      words[L.cond.offset + j * N_COND + i] = e;
      avg += (2 * e * mu * (i === 0 || i === N_COND - 1 ? 0.5 : 1)) / (N_COND - 1);   // E_avg = 2 ∫ E(μ) μ dμ (trapezoid rule)
    }
    words[L.condAvg.offset + j] = avg;
  }
  for (let j = 0; j < N_FUZZ; j++) for (let i = 0; i < N_FUZZ; i++) words[L.fuzz.offset + j * N_FUZZ + i] = Math.min(1, fuzzAlbedo(axis(i, N_FUZZ), axis(j, N_FUZZ)));
  CACHE = { words };
  return CACHE;
}

/** Linear interpolation on an axis of n grid points from lo to hi (end points included): the two indices and the weight. */
function cell(x, n, lo = 0, hi = 1) {
  const f = Math.min(n - 1, Math.max(0, ((x - lo) / (hi - lo)) * (n - 1)));
  const i0 = Math.floor(f), i1 = Math.min(n - 1, i0 + 1);
  return [i0, i1, f - i0];
}
export function lookupSpec(T, mu, rough, eta) {
  const w = T.words, o = TABLE_LAYOUT.spec.offset, n = N_SPEC;
  const [a0, a1, ta] = cell(mu, n), [b0, b1, tb] = cell(rough, n), [c0, c1, tc] = cell(eta, n, ETA0, ETA1);
  const at = (i, j, k) => w[o + (k * n + j) * n + i];
  const l = (k) => (at(a0, b0, k) * (1 - ta) + at(a1, b0, k) * ta) * (1 - tb) + (at(a0, b1, k) * (1 - ta) + at(a1, b1, k) * ta) * tb;
  return l(c0) * (1 - tc) + l(c1) * tc;
}
function lookup2(T, off, n, mu, rough) {
  const w = T.words, [a0, a1, ta] = cell(mu, n), [b0, b1, tb] = cell(rough, n);
  const at = (i, j) => w[off + j * n + i];
  return (at(a0, b0) * (1 - ta) + at(a1, b0) * ta) * (1 - tb) + (at(a0, b1) * (1 - ta) + at(a1, b1) * ta) * tb;
}
export const lookupCond = (T, mu, rough) => lookup2(T, TABLE_LAYOUT.cond.offset, N_COND, mu, rough);
export const lookupFuzz = (T, mu, rough) => lookup2(T, TABLE_LAYOUT.fuzz.offset, N_FUZZ, mu, rough);
export function lookupCondAvg(T, rough) {
  const [b0, b1, tb] = cell(rough, N_COND), o = TABLE_LAYOUT.condAvg.offset;
  return T.words[o + b0] * (1 - tb) + T.words[o + b1] * tb;
}
