/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-look.js — what the real-time view draws, as numbers (0.7 RT.2, session `realtime`). DOM-free (Node tests); the GPU side
 * (rt-mats.js, rt-post.js, rt-gi.js) reads these. Canonical in modelcraft/dev/rt/, copied to BimCraft by tools/rt/sync.mjs.
 *
 *   QUALITY ('low' | 'medium' | 'high'), presetFor(tier, quality?) → a frozen preset   the effects a tier gets by default
 *     (compute/probe.js TIER_DEFAULTS[tier].realtime / .shadowMap / .textureMax: the one place per-tier numbers live); a
 *     person's own choice (Settings) overrides it. Lowest tier (cpu, the 8 GB laptop with no usable GPU): one 1024 shadow map,
 *     FXAA, no AO, no reflections, no bloom, a 4 × 4 × 3 probe grid baked slowly in the background, 20 000 scattered instances
 *     (the real item within 25 m, a box per part beyond) — a usable view, not a pretty one.
 *   physicalParams(record) → {color, metalness, roughness, ior, transmission, …}   one OpenPBR record (render/pt-pack.js
 *     materialRecord, RENDER-SPEC § 6.4, AP1) → MeshPhysicalNodeMaterial's inputs, linear Rec.709 (three's working space).
 *     The real-time look approximates the path tracer's lobes: base + specular (GGX, IOR, tint) + metal (F0 = base colour) + coat
 *     + fuzz → sheen + thin film → iridescence + transmission (thin sheet or a solid with Beer–Lambert depth) + emission + opacity.
 *     Not drawn in real time: subsurface (shown as its colour in the base), dispersion, anisotropy's own tangent.
 *   displayParams(settings) → {exposure (linear factor), wb (row-major 3 × 3 on linear Rec.709), view, contrast, highlights,
 *     bloom, bloomSize, vignette}   RN.8's chain in the same order (render/pt-post.js post()): × white balance → × 2^stops →
 *     bloom → vignette → highlight knee → contrast → the view transform → sRGB. Glare and the .cube LUT are left to the stills.
 *   displayPixel709(rgb, d) → display-linear rgb   the per-pixel part of that chain in JS (the test oracle for the TSL chain)
 *
 * Units: the path tracer's (RENDER-SPEC § 5.2: the clear sky's sun irradiance 3.2), so a three DirectionalLight of intensity E
 * lights a Lambert surface exactly as the tracer's sun does (three's BRDF_Lambert is albedo/π, as § 5.1's diffuse lobe).
 */
import { TIER_DEFAULTS } from '../compute/probe.js';
import { AP1_TO_REC709, REC709_TO_AP1, mul3 } from '../render/pt-spec.js';
import { whiteBalance, cameraStops } from '../render/pt-camera.js';
import { cleanPost, viewTransform } from '../render/pt-post.js';
import { LIGHT_SCALE, SKIES, NIGHT } from '../render/looks.js';

/** The sky the tracer uses for this scene (RENDER-SPEC § 5.3): night when the sun is down (not the white studio), × 1.2 white. */
export function skyFor(plain, settings) {
  const sky0 = SKIES[settings && settings.sky] || SKIES.clear;
  const night = !sky0.plain && !(plain && plain.sun);
  return { sky: night ? NIGHT : sky0, envK: sky0.plain ? 1.2 : 1, night };
}

export const QUALITY = ['low', 'medium', 'high'];

const PRESETS = {
  low: { quality: 'low', shadow: { cascades: 1, size: 1024 }, aa: 'fxaa', ao: false, ssr: false, bloom: false, clustered: false, probes: [4, 4, 3], probeSpp: 4, probePx: [16, 8], pixelRatio: 1, maxLamps: 8, lod: { near: 25, maxNear: 2000 } },
  medium: { quality: 'medium', shadow: { cascades: 3, size: 2048 }, aa: 'taa', ao: true, ssr: false, bloom: true, clustered: true, probes: [6, 6, 4], probeSpp: 8, probePx: [16, 8], pixelRatio: 1, maxLamps: 256, lod: { near: 50, maxNear: 10000 } },
  high: { quality: 'high', shadow: { cascades: 4, size: 4096 }, aa: 'taa', ao: true, ssr: true, bloom: true, clustered: true, probes: [8, 8, 5], probeSpp: 16, probePx: [24, 12], pixelRatio: 2, maxLamps: 1024, lod: { near: 80, maxNear: 50000 } },
};

/** The preset a tier gets; `quality` (Settings) picks another one by name. Shadow size never above the tier's shadowMap. */
export function presetFor(tier, quality = null) {
  const T = TIER_DEFAULTS[tier] || TIER_DEFAULTS.cpu;
  const q = QUALITY.includes(quality) ? quality : (QUALITY.includes(T.realtime) ? T.realtime : 'low');
  const p = PRESETS[q];
  // scattered instances: the tier's budget (TIER_DEFAULTS.instances: 1 M with a high-end graphics card), whatever quality is picked
  return Object.freeze({ ...p, tier: TIER_DEFAULTS[tier] ? tier : 'cpu', shadow: Object.freeze({ ...p.shadow, size: Math.min(p.shadow.size, T.shadowMap) }), textureMax: T.textureMax, instances: T.instances });
}

const ap1To709 = (c) => mul3(AP1_TO_REC709, c).map((x) => Math.max(0, x));
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** One OpenPBR record (Float32Array of 64, AP1) → MeshPhysicalNodeMaterial inputs (linear Rec.709). */
export function physicalParams(r) {
  const base = ap1To709([r[0], r[1], r[2]]).map((x) => x * r[3]);
  const flags = r[15] | 0, thin = (flags & 1) === 1, baseTex = (flags & 2) === 2, roughTex = (flags & 4) === 4;
  const S = r[43];   // subsurface weight: shown as its colour mixed into the base
  const ss = ap1To709([r[40], r[41], r[42]]);
  const color = base.map((x, i) => x * (1 - S) + ss[i] * S * r[3]);
  const T = r[11], depth = r[51];
  const tcol = ap1To709([r[12], r[13], r[14]]);
  const em = ap1To709([r[20], r[21], r[22]]), nits = r[23];
  const coat = r[27], fuzz = r[35], film = r[37];
  const o = {
    color, metalness: r[10], roughness: Math.min(1, Math.max(0.03, r[8])), ior: Math.min(2.333, Math.max(1, r[9])),
    specularIntensity: Math.min(1, r[7]), specularColor: ap1To709([r[4], r[5], r[6]]),
    transmission: T, thickness: thin ? 0 : (depth > 0 ? depth : 0), attenuationColor: depth > 0 ? tcol : [1, 1, 1],
    attenuationDistance: depth > 0 ? depth : Infinity, thin,
    clearcoat: coat, clearcoatRoughness: r[28],
    sheen: fuzz, sheenColor: ap1To709([r[32], r[33], r[34]]), sheenRoughness: r[36],
    iridescence: film, iridescenceIOR: r[39], iridescenceThickness: r[38] * 1000,   // µm → nm
    emissive: em.map((x) => x * nits * LIGHT_SCALE), opacity: r[56],
    texture: baseTex ? { layer: r[16], scale: [r[17], r[18]], rough: roughTex } : null,
  };
  // a thin sheet with no depth tints by its colour at the surface (§ 5.1, depth 0): carried by the base colour three multiplies in
  if (T > 0 && !(depth > 0)) o.color = o.color.map((x, i) => x * (1 - T) + tcol[i] * T);
  return o;
}

/** linear Rec.709 → AP1 → × gains → linear Rec.709, as one row-major 3 × 3 (identity at 6500 K). */
function wbMatrix(K) {
  const g = whiteBalance(K);
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => AP1_TO_REC709[i][0] * g[0] * REC709_TO_AP1[0][j] + AP1_TO_REC709[i][1] * g[1] * REC709_TO_AP1[1][j] + AP1_TO_REC709[i][2] * g[2] * REC709_TO_AP1[2][j]));
}

export function displayParams(settings) {
  const s = settings || {};
  const p = cleanPost(s.post);
  return {
    exposure: Math.pow(2, cameraStops(s)), wb: wbMatrix(s.whiteBalance || 6500),
    view: p.view, contrast: p.contrast, highlights: p.highlights, bloom: p.bloom, bloomSize: p.bloomSize, vignette: p.vignette,
  };
}

/** The per-pixel chain in JS (no bloom, no vignette: those need neighbours / the pixel's place) → display-linear rgb. */
export function displayPixel709(rgb, d) {
  let c = mul3(d.wb, rgb).map((x) => Math.max(0, x) * d.exposure);
  if (d.highlights > 0) {
    const L = lum(c), hs = d.highlights * 2;
    if (L > 1) { const s = (1 + (L - 1) / (1 + (L - 1) * hs)) / L; c = c.map((x) => x * s); }
  }
  if (d.contrast) c = c.map((x) => 0.18 * Math.pow(x / 0.18, 1 + d.contrast));
  return viewTransform(d.view, c);
}
