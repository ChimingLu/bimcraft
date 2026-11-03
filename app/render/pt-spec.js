/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-spec.js — the numbers docs/RENDER-SPEC.md fixes, in one place for every path-tracing kernel (0.7 RN.1, session `render`).
 * No DOM, no imports. The WGSL kernel (pt-wgsl.js) is generated with these values written in, the JS reference (pt-ref.js) and the
 * pack (pt-pack.js) import them, and `compute`'s CPU kernel reads them from this file's table in the spec.
 *
 *   SPEC_VERSION, MAGIC, HEADER_WORDS, MAT_FLOATS, LIGHT_FLOATS, TRI_FLOATS, ATTR_FLOATS, NODE_FLOATS, TEX_SIZE
 *   LIGHT {SUN, POINT, SPOT, AREA, ENV}, MAT_FLAG {THIN, BASE_TEX, ROUGH_TEX, NORMAL_TEX, METAL_TEX, OPACITY_TEX, EMIT_TEX}, HDR_FLAG,
 *   MAPPING {UV, BOX, TRIPLANAR}, TEXPROJ_DIM0, MAT_VEC4
 *   REC709_TO_AP1, AP1_TO_REC709 (row-major 3 × 3), mul3(M, v)
 *   srgbToLinear(c), linearToSrgb(c), hexToAp1('#rrggbb') → [r, g, b]
 *   acesFilmic(rgbRec709, exposureStops) → [r, g, b] 0…1 (three.js's ACESFilmicToneMapping fit, for parity with the fast render)
 *   displayPixel(ap1Mean, exposure, wb) → [r, g, b, 255] bytes (wb: AP1 white-balance gains, pt-camera.js whiteBalance)
 *   pcg(u32) → u32, hash4(a, b, c, d) → u32, R2_A, GOLD_A, alphaFor(d) (the u32 recurrence constants), DIMS (dimension numbers)
 *   SUN_HALF_ANGLE_DEG, MAX_LAMPS, RR_START, MIN_ALPHA
 *
 * Sources: the ACES 1.3 colour space documents (AP1 primaries; the Bradford-adapted matrices as the ACES project publishes them),
 * IEC 61966-2-1 (sRGB), Hill's RRT+ODT fit as three.js ships it (MIT, constants only), O'Neill 2014 (PCG), Roberts 2018 (R2).
 */

export const SPEC_VERSION = 8;   // 2: BVH layout 2 (§ 6.3); 3: the OpenPBR record (§ 6.4, 64 floats), 10 dimensions a bounce; 4: RN.3 lights (§ 6.5, § 6.8); 5: RN.4 the camera (words 86–127); 6: RN.6 elements + light groups (words 93–95, aux); 7: RN.7 volumes; 8: MT.1 textured materials (80-float record, data + emission layers, mapping, normal maps)
export const MAGIC = 0x43435054;   // "CCPT"
export const HEADER_WORDS = 128;
export const TRI_FLOATS = 12;      // 3 × vec4
export const ATTR_FLOATS = 16;     // 4 × vec4
export const NODE_FLOATS = 16;     // 4 × vec4 (BVH layout 2: a wide node or an instance record)
export const MAT_FLOATS = 80;      // 20 × vec4: every OpenPBR parameter + derived words + the texture layers and mapping (RENDER-SPEC § 6.4, v8)
export const MAT_VEC4 = MAT_FLOATS / 4;
export const LIGHT_FLOATS = 16;    // 4 × vec4
export const TEX_SIZE = 512;
export const SUN_HALF_ANGLE_DEG = 0.75;
export const MAX_LAMPS = 100000;   // bounded lights in the tree (RN.3: a light tree, not a list)
export const RR_START = 3;
export const MIN_ALPHA = 0.0025;    // GGX α below this (roughness ≤ 0.05) is a delta lobe (mirror, smooth glass)

export const LIGHT = Object.freeze({ SUN: 0, POINT: 1, SPOT: 2, AREA: 3, ENV: 4, DISC: 5, TRI: 6, TRI2: 7 });   // TRI2 = two-sided
/** Header words of RN.3 (§ 6.1): where the parts of the `ldat` buffer start (in floats) and the light-pick shares. */
export const HW = Object.freeze({ ENV_KIND: 64, MAP_W: 65, MAP_H: 66, MAP_OFF: 67, MARG_OFF: 68, COND_OFF: 69, ENV_ROT: 70, ENV_SCALE: 71,
  NBOUNDED: 72, LREC_OFF: 73, LMETA_OFF: 74, TREE_OFF: 75, TREE_N: 76, IES_OFF: 77, IES_N: 78, IES_DIM: 79, PORTAL_N: 80,
  PORTAL_OFF: 81, VOL_OFF: 82, P_ENV: 83, P_SUN: 84, P_TREE: 85,
  // RN.4 the physical camera (pt-camera.js): projection kind, thin lens radius (m), focus distance (m), aperture blades, their
  // rotation, camera motion (1 = words 96–127 hold the camera at the shutter's close), stereo eye distance (m)
  PROJ: 86, LENS_R: 87, FOCUS: 88, BLADES: 89, BLADE_ROT: 90, MOTION: 91, STEREO_IPD: 92, CAM1_W: 96, CAM1_PI: 112,
  // RN.6 render elements: light group count (0 = no light mixing), element count (0 or ELEMENT_COUNT), the glowing-surfaces group
  GROUPS: 93, ELEMENTS: 94, GLOW_GROUP: 95 });
/** RN.6: at most this many light groups; the render elements in the aux buffer, in this order (one vec4 per pixel each). */
export const MAX_GROUPS = 8;
export const ELEMENTS = Object.freeze(['albedo', 'normalDepth', 'diffuseDirect', 'diffuseIndirect', 'specularDirect', 'specularIndirect',
  'transmissionDirect', 'transmissionIndirect', 'emission', 'ids']);
export const ELEMENT_COUNT = ELEMENTS.length;
/** RN.5: the denoiser's guides alone (albedo, normal + depth: the first two elements) when the other elements are not asked for. */
export const GUIDE_COUNT = 2;
/** The ground's object id in a triangle record's e1.w (the ids element reads it as −1, never an item's). */
export const GROUND_OBJ = 0xfffffffe;
export const IES_THETA = 64, IES_PHI = 32, PORTAL_FLOATS = 12, MAX_PORTALS = 16, MAX_TRI_LIGHTS = 65536;
export const MAT_FLAG = Object.freeze({ THIN: 1, BASE_TEX: 2, ROUGH_TEX: 4, NORMAL_TEX: 8, METAL_TEX: 16, OPACITY_TEX: 32, EMIT_TEX: 64 });
/** MT.1 (§ 6.6): a material's mapping (record word 66) and the hashed dimension of bounce k's triplanar projection. */
export const MAPPING = Object.freeze({ UV: 0, BOX: 1, TRIPLANAR: 2 });
export const TEXPROJ_DIM0 = 0x300000;
export const HDR_FLAG = Object.freeze({ TRANSMISSION: 1, TEXTURES: 2, NIGHT: 4 });

/** Sample dimensions (RENDER-SPEC § 4). Bounce k uses BOUNCE0 + 8·k + offset. */
export const DIMS = Object.freeze({ PIXEL_X: 0, PIXEL_Y: 1, LENS_X: 2, LENS_Y: 3, TIME: 4, BOUNCE0: 5, PER_BOUNCE: 10,
  BSDF_U: 0, BSDF_V: 1, LOBE: 2, LIGHT_PICK: 3, LIGHT_U: 4, LIGHT_V: 5, RR: 6, OPACITY: 7, DISPERSION: 8, SPARE: 9, BN_LIMIT: 45 });
export const LIGHT_SCALE = 0.02;    // nits → the scene's scale (looks.js LIGHT_SCALE: the app's sun is ~3.2)

// row-major 3 × 3
export const REC709_TO_AP1 = [
  [0.6130973, 0.3395229, 0.0473793],
  [0.0701942, 0.9163556, 0.0134526],
  [0.0206156, 0.1095698, 0.8698151],
];
export const AP1_TO_REC709 = [
  [1.7050510, -0.6217921, -0.0832590],
  [-0.1302564, 1.1408047, -0.0105483],
  [-0.0240034, -0.1289690, 1.1529724],
];
// three.js ACESFilmicToneMapping (sRGB-linear in → sRGB-linear out), written row-major
export const ACES_IN = [[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]];
export const ACES_OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];

export const mul3 = (M, v) => [
  M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
  M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
  M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
];

export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** '#rrggbb' → linear AP1 (the kernels' working space). Bad input → a neutral grey. */
export function hexToAp1(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const n = m ? parseInt(m[1], 16) : 0xb4b4b4;
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => srgbToLinear(x / 255));
  return mul3(REC709_TO_AP1, lin);
}
export const rgbToAp1 = (lin709) => mul3(REC709_TO_AP1, lin709);

/** three.js's ACES filmic fit with its exposure handling (× 2^stops / 0.6), so this engine matches the fast render. */
export function acesFilmic(c, exposure = 0) {
  const k = Math.pow(2, exposure) / 0.6;
  const v = mul3(ACES_IN, [c[0] * k, c[1] * k, c[2] * k]);
  const f = v.map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081));
  return mul3(ACES_OUT, f).map((x) => Math.min(1, Math.max(0, x)));
}

/** A pixel's mean (AP1, linear) → display bytes: AP1 → Rec.709, exposure, ACES filmic, sRGB, ½-LSB rounding. */
export function displayPixel(ap1, exposure = 0, wb = null) {
  const lin = mul3(AP1_TO_REC709, wb ? [ap1[0] * wb[0], ap1[1] * wb[1], ap1[2] * wb[2]] : ap1).map((x) => (Number.isFinite(x) ? Math.max(0, x) : 0));
  const t = acesFilmic(lin, exposure);
  return [Math.round(linearToSrgb(t[0]) * 255), Math.round(linearToSrgb(t[1]) * 255), Math.round(linearToSrgb(t[2]) * 255), 255];
}

/** O'Neill's PCG output permutation on a 32-bit state (the "pcg_hash" form; the same bits in WGSL u32 arithmetic). */
export function pcg(v) {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> (((state >>> 28) + 4) >>> 0)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}
export const hash4 = (a, b, c, d) => pcg((a ^ pcg((b ^ pcg((c ^ pcg(d >>> 0)) >>> 0)) >>> 0)) >>> 0);

/** R2 additive recurrence (Roberts 2018) as 32-bit fixed point: frac(s·α) = (s·A mod 2³²) / 2³², exact in u32 maths. */
export const R2_A = [3242174889, 2447445414];   // round(2³² / φ₂), round(2³² / φ₂²), φ₂ = 1.32471795724474602596
export const GOLD_A = 2654435769;                // round(2³² / φ), φ = 1.6180339887…: the best 1-D additive recurrence
/**
 * The recurrence constant of dimension d (RENDER-SPEC § 4): the 2-D dimensions (pixel, lens, BSDF direction, light position)
 * are R2 pairs; the 1-D ones (time, lobe, light pick, roulette, spare) use the golden ratio — R2's own 1-D projection clumps
 * (α₁ ≈ ¾: a pixel's first 16 samples of one dimension land in 8 of 16 cells).
 */
export function alphaFor(d) {
  if (d < 4) return R2_A[d & 1];
  if (d === 4) return GOLD_A;
  const r = (d - 5) % 10;
  return r === 0 || r === 4 ? R2_A[0] : r === 1 || r === 5 ? R2_A[1] : GOLD_A;
}
export const u32ToUnit = (u) => (u >>> 8) * (1 / 16777216);   // [0, 1), exact in f32
