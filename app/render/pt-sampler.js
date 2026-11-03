/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-sampler.js — the blue-noise mask and the sample function every path-tracing kernel uses (RENDER-SPEC § 4; 0.7 RN.1). No
 * DOM. The WGSL kernel reads the same mask bytes from a buffer and computes the same function in u32 arithmetic.
 *
 *   blueNoise() → Uint8Array (64 × 64 × 4, row-major, channel-interleaved), made once per page by void-and-cluster
 *                 (Ulichney 1993) from a fixed seed: the same bytes every run, so a picture is repeatable
 *   sample(mask, px, py, s, d) → [0, 1)
 *   BN_SIZE
 *
 * Void-and-cluster, as published: a Gaussian energy (σ = 1.5, toroidal) over a binary pattern; phase 0 relaxes a random
 * initial pattern (swap the tightest cluster into the largest void until stable), phase 1 ranks the initial ones by removing
 * clusters, phases 2–3 rank the rest by filling voids. Ranks → 0…255.
 */
import { hash4, alphaFor, u32ToUnit, DIMS } from './pt-spec.js';

export const BN_SIZE = 64;
const N = BN_SIZE * BN_SIZE;

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** One channel's ranks 0 … N−1 (Float64 energy, toroidal Gaussian kernel precomputed). */
function voidAndCluster(seed, kernel) {
  const S = BN_SIZE, bits = new Uint8Array(N), energy = new Float64Array(N), rank = new Int32Array(N);
  const r = rng(seed);
  const add = (i, sgn) => {
    const ix = i % S, iy = (i / S) | 0;
    for (let y = 0; y < S; y++) {
      const ky = ((y - iy + S) % S) * S, row = y * S;
      for (let x = 0; x < S; x++) energy[row + x] += sgn * kernel[ky + ((x - ix + S) % S)];
    }
  };
  const tightest = () => { let b = -1, e = -Infinity; for (let i = 0; i < N; i++) if (bits[i] && energy[i] > e) { e = energy[i]; b = i; } return b; };
  const largestVoid = () => { let b = -1, e = Infinity; for (let i = 0; i < N; i++) if (!bits[i] && energy[i] < e) { e = energy[i]; b = i; } return b; };
  // initial pattern: ~10% ones
  const ones0 = Math.round(N * 0.1);
  let placed = 0;
  while (placed < ones0) { const i = Math.floor(r() * N); if (!bits[i]) { bits[i] = 1; add(i, 1); placed++; } }
  for (let guard = 0; guard < N; guard++) {
    const c = tightest(); bits[c] = 0; add(c, -1);
    const v = largestVoid();
    if (v === c) { bits[c] = 1; add(c, 1); break; }
    bits[v] = 1; add(v, 1);
  }
  const proto = bits.slice(), protoE = energy.slice();
  // phase 1: rank the prototype's ones by removing clusters
  let ones = ones0;
  while (ones > 0) { const c = tightest(); bits[c] = 0; add(c, -1); ones--; rank[c] = ones; }
  // phases 2–3: from the prototype, fill voids
  bits.set(proto); energy.set(protoE);
  ones = ones0;
  while (ones < N) { const v = largestVoid(); bits[v] = 1; add(v, 1); rank[v] = ones; ones++; }
  return rank;
}

let MASK = null;
export function blueNoise() {
  if (MASK) return MASK;
  const S = BN_SIZE, kernel = new Float64Array(N), s2 = 2 * 1.5 * 1.5;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = Math.min(x, S - x), dy = Math.min(y, S - y);
    kernel[y * S + x] = Math.exp(-(dx * dx + dy * dy) / s2);
  }
  const out = new Uint8Array(N * 4);
  for (let c = 0; c < 4; c++) {
    const rank = voidAndCluster(1 + c * 7919, kernel);
    for (let i = 0; i < N; i++) out[i * 4 + c] = Math.floor((rank[i] * 256) / N);
  }
  MASK = out;
  return out;
}

/**
 * The sample for pixel (px, py), sample index s, dimension d (RENDER-SPEC § 4). d < BN_LIMIT: an additive recurrence (R2 for
 * the 2-D dimensions, the golden ratio for the 1-D ones: alphaFor) rotated by blue noise, in 32-bit fixed point; else a PCG hash.
 */
export function sample(mask, px, py, s, d) {
  if (d < DIMS.BN_LIMIT) {
    const q = d >> 2, ox = (13 * q) & 63, oy = (29 * q) & 63;
    const bn = mask[((((py + oy) & 63) * 64 + ((px + ox) & 63)) << 2) + (d & 3)];
    const off = ((bn << 24) | (hash4(px, py, d, 0x5bd1e995) & 0xffffff)) >>> 0;
    return u32ToUnit((Math.imul(s >>> 0, alphaFor(d)) + off) >>> 0);
  }
  return u32ToUnit(hash4(px, py, s, d));
}
