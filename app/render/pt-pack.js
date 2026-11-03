/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-pack.js — the adapter's plain scene (render-core.js header) → the buffers every path-tracing kernel reads (RENDER-SPEC § 6;
 * 0.7 RN.1). No DOM: geometries are read through three.js's BufferGeometry accessors (getAttribute / index / drawRange), so Node
 * packs the same scenes the page does. Allocates growable typed arrays, never an object per vertex.
 *
 *   packScene(scene, settings, {w, h, images?: Map<lookKey, Uint8Array 512×512×4 (rows bottom-up)>, instancing = true}) → packed
 *   packed = {header: ArrayBuffer (64 words), tris, attrs, nodes (§ 6.3 v2 records: nodes then instances), mats, lights:
 *             Float32Array, textures: Uint8Array (layers × 512 × 512 × 4), counts {tris, nodes, instances, mats, lights,
 *             textures}, keys [material keys by index], maxBounces, bounds {c, R}, flags, twoLevel}
 *   bakeTriangles(items, planes, ids) → {n, pos (9n), nor (9n), uv (6n), look: [key per triangle], obj: [object id per triangle]}
 *                                                     world space, section cuts made (ids[i] = items[i]'s object id; default i)
 *   recordFrom(openpbrParams, tex?) → Float32Array(80)  the § 6.4 record from OpenPBR names (OPENPBR_DEFAULTS), finishRecord'ed;
 *                                                     tex = {layer, scale, rough, data?, normal?, metal?, opacity?, emit?, mapping?,
 *                                                     sharpness?, normalStrength?} (v8, MT.1: the layers of § 6.6)
 *   materialRecord(key, settings, scene, tex) → record   the apps' looks / mat: / img: / ground mapped onto OpenPBR (§ 5.1)
 *   buildLights(parts) → {ldat, words, count, env, sun, triBase, …}   every light, the light tree, IES grids, the sky's map and
 *                                                     CDFs, portals → the `ldat` buffer (§ 6.8) and its header words (RN.3)
 *   appLightParts(scene, settings, R, {hdri}) → parts the app's sky (gradient, physical, HDRI), sun, lamps (+ IES by name)
 *   emissionOf(record), portalsFrom(tris, offsets)      emissive triangles become lights; window glass becomes sky portals
 *   assemble(parts) → packed                                                                      the shared back end
 *   packBench(expandedBenchScene, {w, h}) → packed      `compute`'s bench scenes (CU.8), materials by § 5.1 names
 *   openpbrRecord(namedMaterial) → Float32Array(32)
 *
 * Ground: a square of side 120 R (two triangles) at `groundAt`, material 0. Lamps are lights, not triangles (RN.1).
 * BVH: `compute`'s builder (CU.4, ../compute/bvh-scene.js — the copy `tools/compute/sync.mjs` keeps beside render/ in both
 * apps), packed as RENDER-SPEC § 6.3 layout 2: two levels (an instance per placement of a shared geometry, each with its own
 * material) when nothing is cut, else one level; triangles and their shading attributes in its slot order.
 */
import { MAT_FLOATS, LIGHT_FLOATS, TRI_FLOATS, ATTR_FLOATS, HEADER_WORDS, MAGIC, SPEC_VERSION, TEX_SIZE, LIGHT, MAT_FLAG,
  HDR_FLAG, SUN_HALF_ANGLE_DEG, MAX_LAMPS, hexToAp1, rgbToAp1, srgbToLinear, HW, IES_THETA, IES_PHI, PORTAL_FLOATS, MAX_PORTALS,
  MAX_TRI_LIGHTS, LIGHT_SCALE, MIN_ALPHA, MAX_GROUPS, ELEMENT_COUNT, GUIDE_COUNT, GROUND_OBJ, MAPPING } from './pt-spec.js';
import { modulatedEta, frDielectric } from './pt-ggx.js';
import { buildLightTree } from './pt-lighttree.js';
import { fogSigma, packVolumes, placeBox, cloudGrid, plumeGrid } from './pt-volume.js';
import { causticBlock } from './pt-caustic.js';
import { preetham, sunTransmittance, bakeEnvMap, envFromImage, envTables } from './pt-sky.js';
import { readIes, profileGrid } from './pt-ies.js';
import { buildScene, packV2, sceneFromV2, sceneHit } from '../compute/bvh-scene.js';
import { levelCamera, cameraWords, writeMotion, cameraRay } from './pt-camera.js';
import { SKIES, NIGHT, lookFor, farPlane, basis, lampCandela } from './looks.js';
import { material as libDef, materialLayers } from './materials.js';
import { makeTexture } from './textures.js';

class Grow {
  constructor(n = 1024) { this.a = new Float32Array(n); this.n = 0; }
  push3(x, y, z) { if (this.n + 3 > this.a.length) this.grow(); this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z; }
  push2(x, y) { if (this.n + 2 > this.a.length) this.grow(); this.a[this.n++] = x; this.a[this.n++] = y; }
  grow() { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
  done() { return this.a.subarray(0, this.n); }
}

/** Every mesh item in world space (matrix applied, drawRange and index honoured), cut by the planes (keep n·p ≤ d). */
export function bakeTriangles(items, planes = [], ids = null) {
  planes = planes || [];
  const P = new Grow(), N = new Grow(), U = new Grow(), look = [], obj = [];
  // a clipped polygon has at most 3 + planes vertices: fixed scratch, reused
  const cap = 3 + planes.length * 2, pp = new Float64Array(cap * 3), pn = new Float64Array(cap * 3), pu = new Float64Array(cap * 2);
  const qp = new Float64Array(cap * 3), qn = new Float64Array(cap * 3), qu = new Float64Array(cap * 2);
  for (let ii = 0; ii < items.length; ii++) {
    const it = items[ii];
    if (!it || it.lines || !it.geometry) continue;
    const oid = ids ? ids[ii] : ii;
    const g = it.geometry, pa = g.getAttribute('position'), na = g.getAttribute('normal'), ua = g.getAttribute('uv');
    if (!pa) continue;
    const m = it.matrix || null;
    // normal matrix = inverse transpose of the upper 3 × 3 (column-major m)
    let nm = null;
    if (m) {
      const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], gg = m[2], h = m[6], i = m[10];
      const A = e * i - f * h, B = -(d * i - f * gg), C = d * h - e * gg, det = a * A + b * B + c * C || 1;
      // inverse transpose, row-major rows
      nm = [A / det, B / det, C / det, -(b * i - c * h) / det, (a * i - c * gg) / det, -(a * h - b * gg) / det, (b * f - c * e) / det, -(a * f - c * d) / det, (a * e - b * d) / det];
    }
    const idx = g.index ? g.index.array : null, start = (g.drawRange && g.drawRange.start) || 0;
    const total = idx ? idx.length : pa.count;
    const rc = g.drawRange && Number.isFinite(g.drawRange.count) ? g.drawRange.count : Infinity;
    const end = Math.min(total, start + rc);
    const key = it.look || 'default';
    for (let t = start; t + 2 < end; t += 3) {
      let nv = 3;
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx[t + k] : t + k;
        const x = pa.getX(vi), y = pa.getY(vi), z = pa.getZ(vi);
        if (m) { pp[k * 3] = m[0] * x + m[4] * y + m[8] * z + m[12]; pp[k * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]; pp[k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]; }
        else { pp[k * 3] = x; pp[k * 3 + 1] = y; pp[k * 3 + 2] = z; }
        let nx = na ? na.getX(vi) : 0, ny = na ? na.getY(vi) : 0, nz = na ? na.getZ(vi) : 0;
        if (nm) { const X = nm[0] * nx + nm[1] * ny + nm[2] * nz, Y = nm[3] * nx + nm[4] * ny + nm[5] * nz, Z = nm[6] * nx + nm[7] * ny + nm[8] * nz; nx = X; ny = Y; nz = Z; }
        const l = Math.hypot(nx, ny, nz);
        pn[k * 3] = l ? nx / l : 0; pn[k * 3 + 1] = l ? ny / l : 0; pn[k * 3 + 2] = l ? nz / l : 0;
        pu[k * 2] = ua ? ua.getX(vi) : 0; pu[k * 2 + 1] = ua ? ua.getY(vi) : 0;
      }
      // section cuts (Sutherland–Hodgman against each plane)
      let src = [pp, pn, pu], dst = [qp, qn, qu];
      for (const pl of planes) {
        if (nv < 3) break;
        const [sp, sn, su] = src, [dp, dn, du] = dst;
        let out = 0;
        for (let i = 0; i < nv; i++) {
          const j = (i + 1) % nv;
          const di = pl.n[0] * sp[i * 3] + pl.n[1] * sp[i * 3 + 1] + pl.n[2] * sp[i * 3 + 2] - pl.d;
          const dj = pl.n[0] * sp[j * 3] + pl.n[1] * sp[j * 3 + 1] + pl.n[2] * sp[j * 3 + 2] - pl.d;
          if (di <= 0) { for (let k = 0; k < 3; k++) { dp[out * 3 + k] = sp[i * 3 + k]; dn[out * 3 + k] = sn[i * 3 + k]; } du[out * 2] = su[i * 2]; du[out * 2 + 1] = su[i * 2 + 1]; out++; }
          if ((di <= 0) !== (dj <= 0)) {
            const f = di / (di - dj);
            for (let k = 0; k < 3; k++) { dp[out * 3 + k] = sp[i * 3 + k] + (sp[j * 3 + k] - sp[i * 3 + k]) * f; dn[out * 3 + k] = sn[i * 3 + k] + (sn[j * 3 + k] - sn[i * 3 + k]) * f; }
            du[out * 2] = su[i * 2] + (su[j * 2] - su[i * 2]) * f; du[out * 2 + 1] = su[i * 2 + 1] + (su[j * 2 + 1] - su[i * 2 + 1]) * f;
            out++;
          }
        }
        nv = out;
        const tmp = src; src = dst; dst = tmp;
      }
      if (nv < 3) continue;
      const [sp, sn, su] = src;
      for (let i = 1; i + 1 < nv; i++) {
        for (const k of [0, i, i + 1]) { P.push3(sp[k * 3], sp[k * 3 + 1], sp[k * 3 + 2]); N.push3(sn[k * 3], sn[k * 3 + 1], sn[k * 3 + 2]); U.push2(su[k * 2], su[k * 2 + 1]); }
        look.push(key); obj.push(oid);
      }
    }
  }
  return { n: look.length, pos: P.done(), nor: N.done(), uv: U.done(), look, obj };
}

/**
 * The OpenPBR record (§ 6.4, 16 × vec4) from named parameters (OpenPBR v1.1 names and defaults; colours as linear AP1 triples)
 * with the derived words filled in by finishRecord. Unknown names are ignored; numbers are clamped where OpenPBR bounds them.
 */
export const OPENPBR_DEFAULTS = Object.freeze({
  base_weight: 1, base_color: [0.8, 0.8, 0.8], base_diffuse_roughness: 0, base_metalness: 0,
  specular_weight: 1, specular_color: [1, 1, 1], specular_roughness: 0.3, specular_roughness_anisotropy: 0, specular_ior: 1.5,
  transmission_weight: 0, transmission_color: [1, 1, 1], transmission_depth: 0, transmission_scatter: [0, 0, 0],
  transmission_scatter_anisotropy: 0, transmission_dispersion_scale: 0, transmission_dispersion_abbe_number: 20,
  subsurface_weight: 0, subsurface_color: [0.8, 0.8, 0.8], subsurface_radius: 1, subsurface_radius_scale: [1, 0.5, 0.25], subsurface_scatter_anisotropy: 0,
  coat_weight: 0, coat_color: [1, 1, 1], coat_roughness: 0, coat_roughness_anisotropy: 0, coat_ior: 1.6, coat_darkening: 1,
  fuzz_weight: 0, fuzz_color: [1, 1, 1], fuzz_roughness: 0.5,
  thin_film_weight: 0, thin_film_thickness: 0.5, thin_film_ior: 1.4,
  emission_luminance: 0, emission_color: [1, 1, 1], geometry_opacity: 1, geometry_thin_walled: false,
});
export function recordFrom(o, tex = null) {
  const d = OPENPBR_DEFAULTS, g = (k) => (o[k] !== undefined && o[k] !== null ? o[k] : d[k]);
  const n = (k, lo = -Infinity, hi = Infinity) => { const v = Number(g(k)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d[k]; };
  const c = (k) => { const v = g(k); return Array.isArray(v) && v.length >= 3 && v.every(Number.isFinite) ? v.slice(0, 3).map((x) => Math.max(0, x)) : d[k]; };
  const r = new Float32Array(MAT_FLOATS);
  let flags = g('geometry_thin_walled') ? MAT_FLAG.THIN : 0;
  // v8 (§ 6.6): a base layer (colour + roughness), a data layer (normal, metalness, opacity), an emission layer
  const lay = (x) => (Number.isInteger(x) && x >= 0 ? x : -1);
  const base = tex ? lay(tex.layer) : -1, data = tex ? lay(tex.data) : -1, emit = tex ? lay(tex.emit) : -1;
  if (base >= 0) { flags |= MAT_FLAG.BASE_TEX; if (tex.rough) flags |= MAT_FLAG.ROUGH_TEX; }
  if (data >= 0) { if (tex.normal) flags |= MAT_FLAG.NORMAL_TEX; if (tex.metal) flags |= MAT_FLAG.METAL_TEX; if (tex.opacity) flags |= MAT_FLAG.OPACITY_TEX; }
  if (emit >= 0) flags |= MAT_FLAG.EMIT_TEX;
  const T0 = tex;
  tex = base >= 0 ? tex : null;   // below, `tex` = has a base layer (as before v8)
  const bc = tex ? [1, 1, 1] : c('base_color');
  r.set([...bc, n('base_weight', 0, 1)], 0);
  r.set([...c('specular_color'), n('specular_weight', 0)], 4);
  r.set([tex && tex.rough ? 1 : n('specular_roughness', 0, 1), n('specular_ior', 1e-4), n('base_metalness', 0, 1), n('transmission_weight', 0, 1)], 8);
  r.set([...c('transmission_color'), flags], 12);
  r.set([tex ? tex.layer : -1, tex ? tex.scale[0] : 1, tex ? tex.scale[1] : 1, n('base_diffuse_roughness', 0, 1)], 16);
  r.set([...c('emission_color'), n('emission_luminance', 0)], 20);
  r.set([...c('coat_color'), n('coat_weight', 0, 1)], 24);
  r.set([n('coat_roughness', 0, 1), n('coat_ior', 1e-4), n('coat_darkening', 0, 1), n('specular_roughness_anisotropy', 0, 1)], 28);
  r.set([...c('fuzz_color'), n('fuzz_weight', 0, 1)], 32);
  r.set([n('fuzz_roughness', 0, 1), n('thin_film_weight', 0, 1), n('thin_film_thickness', 0), n('thin_film_ior', 1e-4)], 36);
  r.set([...c('subsurface_color'), n('subsurface_weight', 0, 1)], 40);
  r.set([...c('subsurface_radius_scale'), n('subsurface_radius', 0)], 44);
  r.set([...c('transmission_scatter'), n('transmission_depth', 0)], 48);
  r.set([n('transmission_scatter_anisotropy', -1, 1), n('transmission_dispersion_scale', 0, 1), n('transmission_dispersion_abbe_number', 1, 1000), n('subsurface_scatter_anisotropy', -1, 1)], 52);
  r.set([n('geometry_opacity', 0, 1), n('coat_roughness_anisotropy', 0, 1), 0, 0], 56);
  if (data >= 0 || emit >= 0 || base >= 0) {
    const t = T0, m = t.mapping === MAPPING.BOX || t.mapping === MAPPING.TRIPLANAR ? t.mapping : MAPPING.UV;
    const k = Number.isFinite(t.sharpness) ? Math.min(64, Math.max(1, t.sharpness)) : 4;
    const ns = Number.isFinite(t.normalStrength) ? Math.min(8, Math.max(0, t.normalStrength)) : 1;
    if (base < 0 && t.scale) { r[17] = t.scale[0]; r[18] = t.scale[1]; }   // the tile's scale also places the data and emission layers
    r.set([data, emit, m, k], 64);
    r.set([ns, 0, 0, 0], 68);
  } else r.set([-1, -1, MAPPING.UV, 4], 64);
  return finishRecord(r);
}

/**
 * The derived words of a record (§ 6.4 vec4 14.zw, 15): the base interface's relative IOR after OpenPBR's coat rule (η_s =
 * lerp(n_b, n_b/n_c or n_c/n_b when n_c > n_b, C)) and its specular_weight modulation; the coat's hemispherical Fresnel
 * average E_F (for the darkening); the medium's extinction μt = −ln(transmission_color) / transmission_depth (0 = none: the
 * colour then tints at the surface); Cauchy's B for dispersion (n(λ) = A + B/λ², λ in µm, n(λ_d) = η, V_d = abbe / scale).
 */
export function finishRecord(r) {
  const nb = Math.max(1e-4, r[9]), nc = Math.max(1e-4, r[29]), C = r[27];
  const ebc = nc > nb ? nc / nb : nb / nc;
  const etaS = nb + (ebc - nb) * C;
  r[58] = modulatedEta(etaS, r[7]);
  let ef = 0;
  for (let i = 0; i < 32; i++) { const mu = (i + 0.5) / 32; ef += 2 * frDielectric(mu, nc) * mu / 32; }
  r[59] = ef;
  const depth = r[51], T = r[11];
  for (let k = 0; k < 3; k++) r[60 + k] = depth > 0 && T > 0 ? -Math.log(Math.max(1e-6, Math.min(1, r[12 + k]))) / depth : 0;
  const scale = r[53], abbe = r[54];
  r[63] = scale > 0 && T > 0 ? (r[58] - 1) / ((abbe / scale) * (1 / 0.4861 ** 2 - 1 / 0.6563 ** 2)) : 0;
  return r;
}

/** The record for one of the apps' material keys (looks.js looks, materials.js mat: ids, imported img: textures, the ground). */
export function materialRecord(key, settings, scene, tex = null) {
  let color = '#e6e3dc', rough = 0.78, metal = 0, glass = 0;
  if (key === '__ground') { color = settings && SKIES[settings.sky] && SKIES[settings.sky].plain ? '#f4f4f2' : '#cbc6bb'; rough = 1; }
  else if (key.startsWith('mat:') && libDef(key.slice(4))) {
    const m = libDef(key.slice(4));
    if (m.pbr) return recordFrom(m.pbr, tex);   // a node material (MT.1): its own OpenPBR parameters (materials.js)
    color = m.color; rough = m.rough; metal = m.metal; glass = m.glass;
  } else if (key.startsWith('img:')) {
    const avg = /#[0-9a-f]{6}$/i.exec(key);
    color = avg ? avg[0] : '#b4b4b4'; rough = 0.7;
  } else {
    const L = lookFor(key, settings, scene.defaultColor, scene.looks && scene.looks[key]);
    color = L.color; rough = L.rough; metal = L.metal; glass = L.glass;
  }
  const c = hexToAp1(color);
  // the mapping of today's looks (RENDER-SPEC § 5.1): roughness drives the specular lobe; glass is a thin sheet tinted by its colour
  return recordFrom({ base_color: c, specular_roughness: rough, base_metalness: metal, transmission_weight: glass, transmission_color: c, geometry_thin_walled: glass > 0 }, tex);
}

/**
 * RN.3: every light into the `ldat` buffer (RENDER-SPEC § 6.5, § 6.8). parts = {
 *   env: {zen, hor, gnd (AP1), I, map?: {w, h, rgb} (pt-sky.js, AP1), rotation, scale},   sun: {dir (toward it), E (AP1)} | null,
 *   lamps: render-core's lamps (+ `ies`: an index into `ies`),  tris: [{v0, e1, e2, mat, L (AP1, for the power), two}],
 *   ies: [Float32Array grids (pt-ies.js profileGrid)],  portals: [{p0, a, b}],  up, R }
 * → {ldat: Float32Array, words: {header word: value}, count, env, sun, triBase}
 * Bounded lights (lamps, then triangles) are in the tree; the sky and the sun come after them. A vertex picks the sky, the sun
 * or the tree by their power shares (each ≥ 10 % of an even share), then a light in the tree by importance.
 */
export function buildLights({ env, sun = null, lamps = [], tris = [], ies = [], portals = [], up, R, hasGlow = false }) {
  const lum = (a) => 0.2722 * a[0] + 0.6741 * a[1] + 0.0537 * a[2];
  const recs = [], meta = [], items = [], groupKey = [];
  const addBounded = (rec, item, iesIndex = -1, gk = 'glow') => { recs.push(rec); meta.push(iesIndex); items.push(item); groupKey.push(gk); };
  for (const L of (lamps || []).filter((x) => x && x.on !== false && x.lumens > 0).slice(0, MAX_LAMPS)) {
    const col = hexToAp1(L.color || '#ffe7c4'), I = lampCandela(L);
    const q = L.dir ? Math.hypot(L.dir[0], L.dir[1], L.dir[2]) || 1 : 1, d = L.dir ? [L.dir[0] / q, L.dir[1] / q, L.dir[2] / q] : [0, 0, -1];
    if (L.kind === 'area' || L.kind === 'disc') {
      const disc = L.kind === 'disc', w = Math.max(1e-3, L.size[0]), h = disc ? w : Math.max(1e-3, L.size[1]);
      const A = disc ? Math.PI * (w / 2) * (w / 2) : w * h, Le = col.map((x) => (x * I) / A), r = disc ? w / 2 : Math.hypot(w, h) / 2;
      const gk = 'lamp:' + (L.name || '');
      addBounded(disc ? [LIGHT.DISC, 0, 0, 0, L.p[0], L.p[1], L.p[2], w / 2, d[0], d[1], d[2], 0, Le[0], Le[1], Le[2], 0]
        : [LIGHT.AREA, 0, 0, 0, L.p[0], L.p[1], L.p[2], w, d[0], d[1], d[2], h, Le[0], Le[1], Le[2], 0],
      { bmin: L.p.map((x) => x - r), bmax: L.p.map((x) => x + r), power: lum(col) * Math.PI * I, axis: d, cosO: 1, cosE: 0, twoSided: false }, -1, gk);
    } else {
      const r = Math.max(0.01, (L.size ? L.size[0] : 0.06) / 2), Le = col.map((x) => (x * I) / (Math.PI * r * r));
      const prof = Number.isInteger(L.ies) && L.ies >= 0 && L.ies < ies.length ? L.ies : -1;
      const spot = L.kind === 'spot' && prof < 0, half = spot ? (L.angle * Math.PI) / 360 : Math.PI;
      addBounded([spot ? LIGHT.SPOT : LIGHT.POINT, 0, 0, 0, L.p[0], L.p[1], L.p[2], r, d[0], d[1], d[2], Math.cos(half), Le[0], Le[1], Le[2], 0.35],
        { bmin: L.p.map((x) => x - r), bmax: L.p.map((x) => x + r), power: lum(col) * 4 * Math.PI * I * (spot ? (1 - Math.cos(half)) / 2 : 1), axis: d, cosO: spot ? Math.cos(half) : -1, cosE: 0, twoSided: false }, prof, 'lamp:' + (L.name || ''));
    }
  }
  const triBase = recs.length;
  for (const t of tris.slice(0, MAX_TRI_LIGHTS)) {
    const nx = t.e1[1] * t.e2[2] - t.e1[2] * t.e2[1], ny = t.e1[2] * t.e2[0] - t.e1[0] * t.e2[2], nz = t.e1[0] * t.e2[1] - t.e1[1] * t.e2[0];
    const nl = Math.hypot(nx, ny, nz), A = nl / 2;
    if (!(A > 0)) continue;
    const vs = [t.v0, t.v0.map((x, k) => x + t.e1[k]), t.v0.map((x, k) => x + t.e2[k])];
    addBounded([t.two ? LIGHT.TRI2 : LIGHT.TRI, t.e2[0], t.e2[1], t.e2[2], t.v0[0], t.v0[1], t.v0[2], A, t.e1[0], t.e1[1], t.e1[2], t.mat, t.L[0], t.L[1], t.L[2], 0],
      { bmin: [0, 1, 2].map((k) => Math.min(vs[0][k], vs[1][k], vs[2][k])), bmax: [0, 1, 2].map((k) => Math.max(vs[0][k], vs[1][k], vs[2][k])), power: lum(t.L) * Math.PI * A * (t.two ? 2 : 1), axis: [nx / nl, ny / nl, nz / nl], cosO: 1, cosE: 0, twoSided: !!t.two });
  }
  const nBounded = recs.length;
  const tree = buildLightTree(items);
  // the sky and the sun (not in the tree)
  const mapAvg = env.map ? (() => { let s0 = 0; const n = env.map.w * env.map.h; for (let i = 0; i < n; i++) s0 += lum([env.map.rgb[i * 4], env.map.rgb[i * 4 + 1], env.map.rgb[i * 4 + 2]]); return (s0 / n) * (env.scale ?? 1); })() : env.I * (lum(env.zen) + lum(env.hor)) / 2;
  const envIdx = recs.length;
  recs.push([LIGHT.ENV, 0, 0, 0, up[0], up[1], up[2], 0, 0, 0, 0, 0, env.I, env.I, env.I, 0]); meta.push(-1); groupKey.push('sky');
  let sunIdx = 0xffffffff;
  if (sun) {
    const s0 = sun.dir, l = Math.hypot(s0[0], s0[1], s0[2]) || 1;
    sunIdx = recs.length;
    recs.push([LIGHT.SUN, 0, 0, 0, s0[0] / l, s0[1] / l, s0[2] / l, Math.cos((SUN_HALF_ANGLE_DEG * Math.PI) / 180), 0, 0, 0, 0, sun.E[0], sun.E[1], sun.E[2], 0]); meta.push(-1); groupKey.push('sun');
  }
  // the pick shares
  const powEnv = Math.PI * mapAvg * Math.PI * R * R, powSun = sun ? lum(sun.E) * Math.PI * R * R : 0;
  const powTree = items.reduce((a, it) => a + it.power, 0);
  const present = [powEnv >= 0 ? 1 : 0, sun ? 1 : 0, nBounded ? 1 : 0], ng = present.reduce((x, y) => x + y, 0), tot = powEnv + powSun + powTree || 1;
  const share = (pw, on) => (on ? 0.9 * (pw / tot) + 0.1 / ng : 0);
  let pEnv = share(powEnv, true), pSun = share(powSun, !!sun), pTree = share(powTree, nBounded > 0);
  const ps = pEnv + pSun + pTree; pEnv /= ps; pSun /= ps; pTree /= ps;
  // RN.6 light groups: the sky, the sun, lamps by name (strongest first), glowing surfaces; ≤ MAX_GROUPS (the rest of the lamps
  // share "other lamps"). A light's group is its meta word 3.
  const lampPow = new Map();
  items.forEach((it, i) => { if (groupKey[i] !== 'glow') lampPow.set(groupKey[i], (lampPow.get(groupKey[i]) || 0) + it.power); });
  const lampKeys = [...lampPow.keys()].sort((a, b) => lampPow.get(b) - lampPow.get(a));
  const glowOn = hasGlow || tris.length > 0;
  const fixed = ['sky', ...(sun ? ['sun'] : []), ...(glowOn ? ['glow'] : [])];
  const room = MAX_GROUPS - fixed.length, named = lampKeys.length > room ? lampKeys.slice(0, room - 1) : lampKeys;
  const groups = [...fixed.slice(0, 1 + (sun ? 1 : 0)).map((k) => ({ key: k, kind: k })), ...named.map((k) => ({ key: k, kind: 'lamp', name: k.slice(5) })),
    ...(lampKeys.length > named.length ? [{ key: 'others', kind: 'others' }] : []), ...(glowOn ? [{ key: 'glow', kind: 'glow' }] : [])];
  const gIndex = new Map(groups.map((g, i) => [g.key, i]));
  const groupOf = groupKey.map((k) => gIndex.get(k) ?? gIndex.get(k === 'glow' ? 'glow' : 'others') ?? 0);
  // ldat: records, meta, tree, IES grids, the environment map + its CDFs, portals
  const n = recs.length, envT = env.map ? envTables(env.map) : null;
  const sizes = { rec: n * LIGHT_FLOATS, meta: n * 4, tree: tree.nodes.length, ies: ies.length * IES_THETA * IES_PHI,
    map: env.map ? env.map.w * env.map.h * 4 : 0, marg: envT ? envT.marginal.length : 0, cond: envT ? envT.conditional.length : 0, portal: Math.min(MAX_PORTALS, portals.length) * PORTAL_FLOATS };
  const off = {}; let cur = 0;
  for (const k of ['rec', 'meta', 'tree', 'ies', 'map', 'marg', 'cond', 'portal']) { off[k] = cur; cur += Math.ceil(sizes[k] / 4) * 4; }
  const ldat = new Float32Array(Math.max(4, cur)), lu = new Uint32Array(ldat.buffer);
  recs.forEach((r, i) => ldat.set(r, off.rec + i * LIGHT_FLOATS));
  for (let i = 0; i < n; i++) {
    const o = off.meta + i * 4;
    lu[o] = i < nBounded ? tree.bits[i] : 0; lu[o + 1] = i < nBounded ? tree.depth[i] : 0; lu[o + 2] = meta[i] >= 0 ? meta[i] : 0xffffffff; lu[o + 3] = groupOf[i];
  }
  ldat.set(tree.nodes, off.tree);
  ies.forEach((g, i) => ldat.set(g, off.ies + i * IES_THETA * IES_PHI));
  if (env.map) { ldat.set(env.map.rgb, off.map); ldat.set(envT.marginal, off.marg); ldat.set(envT.conditional, off.cond); }
  portals.slice(0, MAX_PORTALS).forEach((pt, i) => ldat.set([pt.p0[0], pt.p0[1], pt.p0[2], 0, pt.a[0], pt.a[1], pt.a[2], 0, pt.b[0], pt.b[1], pt.b[2], 0], off.portal + i * PORTAL_FLOATS));
  const f = (x) => { const b = new Float32Array([x]); return new Uint32Array(b.buffer)[0]; };   // header floats as their bits
  const words = {
    [HW.ENV_KIND]: env.map ? 1 : 0, [HW.MAP_W]: env.map ? env.map.w : 0, [HW.MAP_H]: env.map ? env.map.h : 0, [HW.MAP_OFF]: off.map,
    [HW.MARG_OFF]: off.marg, [HW.COND_OFF]: off.cond, [HW.ENV_ROT]: f(env.rotation || 0), [HW.ENV_SCALE]: f(env.scale ?? 1),
    [HW.NBOUNDED]: nBounded, [HW.LREC_OFF]: off.rec, [HW.LMETA_OFF]: off.meta, [HW.TREE_OFF]: off.tree, [HW.TREE_N]: tree.count,
    [HW.IES_OFF]: off.ies, [HW.IES_N]: ies.length, [HW.IES_DIM]: (IES_THETA << 16) | IES_PHI, [HW.PORTAL_N]: Math.min(MAX_PORTALS, portals.length),
    [HW.PORTAL_OFF]: off.portal, [HW.P_ENV]: f(pEnv), [HW.P_SUN]: f(pSun), [HW.P_TREE]: f(pTree),
    [HW.GLOW_GROUP]: glowOn ? gIndex.get('glow') : 0,
  };
  return { ldat, words, count: n, env: envIdx, sun: sunIdx, triBase, nBounded, tree, off, groups };
}

/** The app's sky, sun, lamps and their options (looks.js SKIES / NIGHT; physical sky, HDRI, IES profiles) → buildLights parts. */
export function appLightParts(scene, settings, R, { hdri = null } = {}) {
  const s = settings || {};
  const skyKey = SKIES[s.sky] ? s.sky : 'clear', sky0 = SKIES[skyKey];
  const up = basis(scene.up || [0, 0, 1]).up;
  const night = !sky0.plain && !sky0.hdri && !scene.sun;
  const sky = night ? NIGHT : sky0, envI = sky.plain ? 1.2 : 1.0;
  const env = { zen: hexToAp1(sky.zenith), hor: hexToAp1(sky.horizon), gnd: hexToAp1(sky.ground), I: envI, rotation: ((s.envRotation || 0) * Math.PI) / 180, scale: Math.pow(2, s.envExposure || 0) };
  const sunUp = scene.sun && !night && sky.sun > 0 && (scene.sun[0] * up[0] + scene.sun[1] * up[1] + scene.sun[2] * up[2]) > 0.02;
  let sun = sunUp ? { dir: scene.sun, E: hexToAp1(sky.tint).map((x) => x * sky.sun) } : null;
  const notes = [];
  if (!night && sky0.physical) {
    // Preetham's sky in the scene's daylight scale (sun 3.2 ⇔ ~100 klux: 1 kcd/m² → 0.032), the sun through the atmosphere
    const T = s.turbidity || 3, sd = scene.sun || [0, 0, 1], P = preetham(sd, up, T);
    env.map = bakeEnvMap((d) => rgbToAp1(P.radiance(d)).map((x) => x * 0.032), 256, 128, up, 0);
    env.rotation = 0;
    if (sun) {
      const cs = (sd[0] * up[0] + sd[1] * up[1] + sd[2] * up[2]) / (Math.hypot(sd[0], sd[1], sd[2]) || 1), tau = sunTransmittance(cs, T), ref = sunTransmittance(1, 3)[1];
      sun = { dir: sd, E: rgbToAp1(tau.map((x) => (x / ref) * SKIES.clear.sun)) };
    }
  } else if (sky0.hdri) {
    if (hdri) { env.map = envFromImage(hdri, 2048); sun = null; }   // an HDRI carries its own sun
    else notes.push('no_hdri');
  }
  // IES profiles by lamp name (settings.ies: {name: {file, text}})
  const ies = [], byName = new Map();
  for (const [name, v] of Object.entries(s.ies || {})) {
    try { const prof = readIes(v.text); byName.set(name, ies.length); ies.push(profileGrid(prof, IES_THETA, IES_PHI)); } catch (e) { notes.push('ies:' + (e.code || 'bad') + ':' + name); }
  }
  const lamps = (scene.lights || []).map((L) => (L && byName.has(L.name) ? { ...L, ies: byName.get(L.name) } : L));
  return { env, sun, lamps, ies, up, R, night, sky, envI, notes };
}

/** A library texture → one 512 × 512 RGBA layer (rgb sRGB albedo, a = roughness), bilinear-resampled from the tile's own shape. */
function libLayer(id) {
  const m = libDef(id);
  if (!m || !m.tex) return null;
  const t = makeTexture(m.tex, TEX_SIZE);
  const out = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  for (let y = 0; y < TEX_SIZE; y++) {
    const sy = Math.min(t.h - 1, Math.floor(((y + 0.5) * t.h) / TEX_SIZE));
    for (let x = 0; x < TEX_SIZE; x++) {
      const sx = Math.min(t.w - 1, Math.floor(((x + 0.5) * t.w) / TEX_SIZE)), si = sy * t.w + sx, o = (y * TEX_SIZE + x) * 4;
      out[o] = t.albedo[si * 4]; out[o + 1] = t.albedo[si * 4 + 1]; out[o + 2] = t.albedo[si * 4 + 2]; out[o + 3] = Math.round(t.rough[si] * 255);
    }
  }
  return { px: out, size: m.tex.size || [1, 1] };
}

/** One mesh's § 6.2 records (12 floats) and shading attributes (16 floats) from baked triangles; mat(i) → material index. */
function meshRecords(baked, mat) {
  const n = baked.n, tris = new Float32Array(n * TRI_FLOATS), attrs = new Float32Array(n * ATTR_FLOATS), tu = new Uint32Array(tris.buffer);
  const P = baked.pos, N = baked.nor, UV = baked.uv;
  for (let i = 0; i < n; i++) {
    const o = i * TRI_FLOATS, a = i * ATTR_FLOATS, p = i * 9;
    tris[o] = P[p]; tris[o + 1] = P[p + 1]; tris[o + 2] = P[p + 2]; tu[o + 3] = mat(i);
    tu[o + 7] = baked.obj ? baked.obj[i] >>> 0 : 0;   // RN.6: the object id (render elements), e1.w
    for (let k = 0; k < 3; k++) { tris[o + 4 + k] = P[p + 3 + k] - P[p + k]; tris[o + 8 + k] = P[p + 6 + k] - P[p + k]; }
    for (let k = 0; k < 3; k++) {
      let nx = N[p + k * 3], ny = N[p + k * 3 + 1], nz = N[p + k * 3 + 2];
      if (!(nx || ny || nz)) {   // no normals: the face's own
        const e1x = tris[o + 4], e1y = tris[o + 5], e1z = tris[o + 6], e2x = tris[o + 8], e2y = tris[o + 9], e2z = tris[o + 10];
        nx = e1y * e2z - e1z * e2y; ny = e1z * e2x - e1x * e2z; nz = e1x * e2y - e1y * e2x;
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      }
      attrs[a + k * 4] = nx; attrs[a + k * 4 + 1] = ny; attrs[a + k * 4 + 2] = nz; attrs[a + k * 4 + 3] = UV[i * 6 + k * 2];
      attrs[a + 12 + k] = UV[i * 6 + k * 2 + 1];
    }
  }
  return { tris, attrs, n };
}

/** What a record means for lights (RN.3): {glow (emits), L (AP1 radiance at normal incidence, the scene's scale), thin, sheet
 * (a smooth thin transmissive sheet: window glass, a portal for the sky)}. */
export function emissionOf(r) {
  // a textured glow (emission layer, v8) is found by camera and BSDF rays only: never a light (RENDER-SPEC § 5.2)
  const glow = r[23] > 0 && (r[20] > 0 || r[21] > 0 || r[22] > 0) && !(r[15] & MAT_FLAG.EMIT_TEX);
  const thin = (r[15] & MAT_FLAG.THIN) !== 0;
  const rB = r[8], rC = r[28], C = r[27];
  const rs = C > 0 ? rB + (Math.min(1, Math.pow(rB ** 4 + 2 * rC ** 4, 0.25)) - rB) * C : rB;
  const sheet = thin && r[11] > 0 && rs * rs < MIN_ALPHA;
  return { glow, thin, sheet, L: [r[20] * r[23] * LIGHT_SCALE, r[21] * r[23] * LIGHT_SCALE, r[22] * r[23] * LIGHT_SCALE] };
}

/**
 * Portals from window glass (RN.3): the glass triangles grouped by plane (normal and offset, quantised), each group's bounding
 * rectangle in its plane → {p0, a, b} (a corner and two edges). The largest MAX_PORTALS by area. Rectangles may span more than a
 * pane (two windows in one wall become one portal): sampling through a portal is still exact, only less focused.
 */
export function portalsFrom(tris, offsets) {
  const groups = new Map();
  for (const o of offsets) {
    const e1 = [tris[o + 4], tris[o + 5], tris[o + 6]], e2 = [tris[o + 8], tris[o + 9], tris[o + 10]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(n[0], n[1], n[2]);
    if (!(l > 0)) continue;
    n = n.map((x) => x / l);
    const big = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
    if (n[big] < 0) n = n.map((x) => -x);
    const d = n[0] * tris[o] + n[1] * tris[o + 1] + n[2] * tris[o + 2];
    const key = n.map((x) => Math.round(x * 100)).join(',') + '|' + Math.round(d * 50);
    let g = groups.get(key);
    if (!g) { g = { n, pts: [] }; groups.set(key, g); }
    for (const v of [[tris[o], tris[o + 1], tris[o + 2]], [tris[o] + e1[0], tris[o + 1] + e1[1], tris[o + 2] + e1[2]], [tris[o] + e2[0], tris[o + 1] + e2[1], tris[o + 2] + e2[2]]]) g.pts.push(v);
  }
  const out = [];
  for (const g of groups.values()) {
    const { e1, e2 } = basis(g.n);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, dsum = 0;
    for (const p of g.pts) {
      const u = p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2], v = p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2];
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      dsum += p[0] * g.n[0] + p[1] * g.n[1] + p[2] * g.n[2];
    }
    const dd = dsum / g.pts.length, area = (u1 - u0) * (v1 - v0);
    if (!(area > 1e-6)) continue;
    const p0 = [0, 1, 2].map((k) => g.n[k] * dd + e1[k] * u0 + e2[k] * v0);
    out.push({ p0, a: e1.map((x) => x * (u1 - u0)), b: e2.map((x) => x * (v1 - v0)), area });
  }
  return out.sort((x, y) => y.area - x.area).slice(0, MAX_PORTALS);
}

/**
 * The scene → the kernels' buffers. Two levels (§ 6.3 v2 instances) when placements share a geometry and nothing is cut
 * (a section cut is made on world-space triangles, so it bakes everything); else one level, every placement baked.
 */
/**
 * RN.7: the media of `settings` (fog layer, one volume) as packVolumes' input. Presets are made here (deterministic); a file's grid
 * comes from `volumeData` {nx, ny, nz, data} (kept by the page for the session). Null when no medium is on.
 */
export function volumeParts(settings, { up, c, R, groundAt = 0, volumeData = null }) {
  const f = settings && settings.fog, v = settings && settings.volume;
  const fog = f && f.on ? { sigma: fogSigma(f.visibility), top: groundAt + f.top, albedo: hexToAp1(f.color), g: f.g } : null;
  const grids = [];
  if (v && v.on) {
    let g = null;
    if (v.kind === 'file') g = volumeData && volumeData.data ? volumeData : null;
    else { const n = v.res || 48; g = { nx: n, ny: n, nz: n, data: v.kind === 'plume' ? plumeGrid(n, v.seed || 1) : cloudGrid(n, v.seed || 1) }; }
    if (g) {
      const size = v.size > 0 ? v.size : Math.max(1, R * 0.8);
      const place = placeBox({ centre: [c[0] + v.dx, c[1] + v.dy, c[2] + v.dz], size, nx: g.nx, ny: g.ny, nz: g.nz, up, yaw: v.yaw || 0 });
      // density: ρ at its maximum 1 gives `density` per 10th of the box: an optical depth of about density × 10 across the box's longest side
      grids.push({ data: g.data, nx: g.nx, ny: g.ny, nz: g.nz, rows: place.rows, scale: (v.density * 10) / size, albedo: hexToAp1(v.color), g: v.g });
    }
  }
  return fog || grids.length ? { fog, grids } : null;
}

export function packScene(scene, settings, { w, h, images = null, instancing = true, hdri = null, camera1 = null, volumeData = null } = {}) {
  const up = basis(scene.up || [0, 0, 1]).up, bb = scene.bounds;
  const c = bb ? [0, 1, 2].map((k) => (bb.min[k] + bb.max[k]) / 2) : [0, 0, 0];
  const R = bb ? Math.max(Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) / 2, 0.5) : 5;
  // materials: 0 = ground, then one per key (textures as layers)
  const keys = ['__ground'], index = new Map([['__ground', 0]]), texLayers = [], texOf = new Map(), matRecs = [];
  const layerFor = (key) => {
    if (texOf.has(key)) return texOf.get(key);
    let t = null;
    const nl = key.startsWith('mat:') ? materialLayers(key.slice(4), TEX_SIZE) : null;   // a node material's baked layers (MT.1, § 6.6)
    if (nl) {
      const push = (px) => (px ? (texLayers.push(px), texLayers.length - 1) : -1);
      t = { layer: push(nl.base), data: push(nl.data), emit: push(nl.emit), scale: [1 / nl.size[0], 1 / nl.size[1]], rough: !!nl.rough,
        normal: !!nl.normal, metal: !!nl.metal, opacity: !!nl.opacity, mapping: nl.mapping, sharpness: nl.sharpness, normalStrength: nl.normalStrength };
    } else if (key.startsWith('mat:')) { const Lr = libLayer(key.slice(4)); if (Lr) { texLayers.push(Lr.px); t = { layer: texLayers.length - 1, scale: [1 / Lr.size[0], 1 / Lr.size[1]], rough: true }; } }
    else if (key.startsWith('img:') && images && images.get(key)) { texLayers.push(images.get(key)); t = { layer: texLayers.length - 1, scale: [1, 1], rough: false }; }
    texOf.set(key, t);
    return t;
  };
  matRecs.push(materialRecord('__ground', settings, scene, null));
  const matIndex = (k) => {
    let mi = index.get(k);
    if (mi === undefined) { mi = keys.length; index.set(k, mi); keys.push(k); matRecs.push(materialRecord(k, settings, scene, layerFor(k))); }
    return mi;
  };
  // the ground: a square of side 120 R, square to up, at groundAt (world space)
  const ground = settings && settings.ground !== false;
  let groundMesh = null;
  if (ground) {
    const { e1, e2 } = basis(up), s = R * 60;
    const lift = (c[0] * up[0] + c[1] * up[1] + c[2] * up[2]) - (scene.groundAt ?? 0) + R * 1e-4;
    const g0 = [c[0] - up[0] * lift, c[1] - up[1] * lift, c[2] - up[2] * lift];
    const q = (a, b) => [g0[0] + e1[0] * a + e2[0] * b, g0[1] + e1[1] * a + e2[1] * b, g0[2] + e1[2] * a + e2[2] * b];
    const pos = new Float32Array([q(-s, -s), q(s, -s), q(s, s), q(-s, -s), q(s, s), q(-s, s)].flat());
    const nor = new Float32Array(18);
    for (let k = 0; k < 6; k++) nor.set(up, k * 3);
    groundMesh = meshRecords({ n: 2, pos, nor, uv: new Float32Array(12), obj: [GROUND_OBJ, GROUND_OBJ] }, () => 0);
  }
  // one level or two?
  const items = (scene.items || []).filter((it) => it && !it.lines && it.geometry);
  const geoms = new Map();
  for (const it of items) geoms.set(it.geometry, (geoms.get(it.geometry) || 0) + 1);
  // emissive placements are baked to world space (their triangles become lights, one each, RN.3)
  const emissive = (it) => { const r = matRecs[matIndex(it.look || 'default')]; return r[23] > 0 && (r[20] > 0 || r[21] > 0 || r[22] > 0); };
  const two = instancing && !(scene.clip && scene.clip.length) && items.length > 1 && [...geoms.values()].some((n) => n > 1);
  let meshes, instances = null;
  if (two) {
    // a mesh per distinct geometry (object space, its first placement's look); an instance per placement (its own look)
    const meshOf = new Map();
    meshes = [];
    instances = [];
    const glowIdx = items.map((it, i) => (emissive(it) ? i : -1)).filter((i) => i >= 0), glow = glowIdx.map((i) => items[i]);
    if (glow.length) {
      const baked = bakeTriangles(glow, [], glowIdx);
      if (baked.n) { meshes.push(meshRecords(baked, (i) => matIndex(baked.look[i]))); instances.push({ mesh: meshes.length - 1, m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], material: 0xffffffff, obj: -1 }); }
    }
    for (let ii = 0; ii < items.length; ii++) {
      const it = items[ii];
      if (emissive(it)) continue;
      let mi = meshOf.get(it.geometry);
      if (mi === undefined) {
        const baked = bakeTriangles([{ geometry: it.geometry, look: it.look }], []);
        if (!baked.n) { meshOf.set(it.geometry, -1); continue; }
        const m0 = matIndex(it.look || 'default');
        meshes.push(meshRecords(baked, () => m0));
        mi = meshes.length - 1;
        meshOf.set(it.geometry, mi);
      }
      if (mi < 0) continue;
      instances.push({ mesh: mi, m: it.matrix || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], material: matIndex(it.look || 'default'), obj: ii });
    }
    if (groundMesh) { meshes.push(groundMesh); instances.push({ mesh: meshes.length - 1, m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], material: 0, obj: -2 }); }
    if (!instances.length) { meshes = null; instances = null; }
  }
  if (!meshes) {
    const baked = bakeTriangles(items, scene.clip);
    const mesh = meshRecords(baked, (i) => matIndex(baked.look[i]));
    if (groundMesh) {   // the ground joins the one mesh
      const t = new Float32Array((mesh.n + 2) * TRI_FLOATS), a = new Float32Array((mesh.n + 2) * ATTR_FLOATS);
      t.set(mesh.tris); t.set(groundMesh.tris, mesh.n * TRI_FLOATS); a.set(mesh.attrs); a.set(groundMesh.attrs, mesh.n * ATTR_FLOATS);
      meshes = [{ tris: t, attrs: a, n: mesh.n + 2 }];
    } else meshes = [mesh];
    instances = null;
  }
  const parts = appLightParts(scene, settings, R, { hdri });
  // RN.4: two-point perspective levels the camera (a normal projection only); camera1 = the camera at the shutter's close
  const s0 = settings || {};
  let camera = scene.camera(w / h);
  if (s0.twoPoint && (!s0.projection || s0.projection === 'normal')) camera = levelCamera(camera.world, camera.proj, up);
  if (camera1 && s0.twoPoint) camera1 = levelCamera(camera1.world, camera1.proj, up);
  const volParts = volumeParts(s0, { up, c, R, groundAt: scene.groundAt ?? 0, volumeData });
  const out = assemble({ up, c, R, meshes, instances, matRecs, texLayers, lightParts: parts, night: parts.night, camera, camera1, camSettings: s0, w, h, keys, volParts });
  out.notes = parts.notes;
  return out;
}

/**
 * The buffers from plain parts (both front doors end here): meshes [{tris (§ 6.2), attrs, n}] in object space (world when
 * `instances` is null), instances [{mesh, m (object → world), material}] | null, material records, texture layers, light parts
 * (buildLights' input without the triangles and portals, which come from the geometry here), camera {world, proj};
 * triLights false = emissive triangles are not lights (only rays find them: the comparison in the tests).
 */
export function assemble({ up, c, R, meshes, instances, matRecs, texLayers = [], lightParts, night = false, camera, camera1 = null, camSettings = null, w, h, keys = [], triLights: useTriLights = true, volParts = null }) {
  const nTriAll = meshes.reduce((s0, m) => s0 + m.n, 0);
  let bvh, tris, attrs, slotMesh = null;
  if (!nTriAll) {
    bvh = { records: new Uint32Array(16), nodeCount: 1, instCount: 0 };   // an empty node: no children
    tris = new Float32Array(TRI_FLOATS); attrs = new Float32Array(ATTR_FLOATS);
  } else {
    const sc = buildScene({ meshes: meshes.map((m) => ({ tris: m.tris })), instances });
    const pv = packV2(sc);
    bvh = { records: pv.records, nodeCount: pv.header[3], instCount: pv.header[62] };
    tris = pv.tris;
    slotMesh = sc.triMesh;
    // shading attributes in the same slot order (slot → mesh, triangle)
    attrs = new Float32Array(Math.max(1, sc.triCount) * ATTR_FLOATS);
    for (let s0 = 0; s0 < sc.triCount; s0++) {
      const src = meshes[sc.triMesh[s0]].attrs, p = sc.triIndex[s0] * ATTR_FLOATS;
      attrs.set(src.subarray(p, p + ATTR_FLOATS), s0 * ATTR_FLOATS);
    }
  }
  const nTri = tris.length / TRI_FLOATS;
  const mats = new Float32Array(Math.max(1, matRecs.length) * MAT_FLOATS);
  matRecs.forEach((r, i) => mats.set(r, i * MAT_FLOATS));
  // RN.3: emissive triangles (world space: one level, or the baked emissive mesh of two levels) become lights; smooth thin
  // transmissive sheets (window glass) become portals for the sky
  const triU = new Uint32Array(tris.buffer, tris.byteOffset, tris.length), attrU = new Uint32Array(attrs.buffer, attrs.byteOffset, attrs.length);
  const P = matRecs.map((r) => emissionOf(r));
  const triLights = [], glass = [], glassBuf = [];
  // a portal triangle of a placed mesh: its world copy (kept apart; offsets into it are marked negative until concatGlass)
  const worldSlot = (o, M) => { const v0 = toWorld(M, [tris[o], tris[o + 1], tris[o + 2]], true), e1 = toWorld(M, [tris[o + 4], tris[o + 5], tris[o + 6]], false), e2 = toWorld(M, [tris[o + 8], tris[o + 9], tris[o + 10]], false); glassBuf.push([...v0, 0, ...e1, 0, ...e2, 0]); return -glassBuf.length; };
  const concatGlass = (t, offs) => { const out = new Float32Array(offs.length * TRI_FLOATS); offs.forEach((o, i) => out.set(o < 0 ? glassBuf[-o - 1] : t.subarray(o, o + 12), i * TRI_FLOATS)); return out; };
  // which slots can be lights: every slot of one level; with two levels, the slots of meshes placed exactly once (the ground,
  // the baked emissive mesh, a lone object), moved to world space by their placement — a mesh placed many times is never a
  // light or a portal (one slot, many places)
  const useOf = new Map();
  if (instances) for (const it of instances) { const u = useOf.get(it.mesh); useOf.set(it.mesh, u ? null : it); }   // null = placed more than once
  const worldMesh = instances ? new Map([...useOf].filter(([, it]) => it)) : null;
  const toWorld = (m, v, w) => [0, 1, 2].map((k) => m[k] * v[0] + m[4 + k] * v[1] + m[8 + k] * v[2] + (w ? m[12 + k] : 0));
  for (let sIdx = 0; sIdx < nTri; sIdx++) {
    attrU[sIdx * ATTR_FLOATS + 15] = 0xffffffff;
    if (!nTriAll || (worldMesh && !worldMesh.has(slotMesh[sIdx]))) continue;
    const o = sIdx * TRI_FLOATS;
    let m = triU[o + 3], M = null;
    if (instances) { const inst = worldMesh.get(slotMesh[sIdx]); M = inst.m; if (Number.isInteger(inst.material) && inst.material !== 0xffffffff) m = inst.material; }
    if (P[m].glow && useTriLights) {
      let v0 = [tris[o], tris[o + 1], tris[o + 2]], e1 = [tris[o + 4], tris[o + 5], tris[o + 6]], e2 = [tris[o + 8], tris[o + 9], tris[o + 10]];
      if (M) { v0 = toWorld(M, v0, true); e1 = toWorld(M, e1, false); e2 = toWorld(M, e2, false); }
      attrU[sIdx * ATTR_FLOATS + 15] = triLights.length;
      triLights.push({ v0, e1, e2, mat: m, L: P[m].L, two: P[m].thin });
    } else if (P[m].sheet) glass.push(M ? worldSlot(o, M) : o);
  }
  const portals = portalsFrom(glassBuf.length ? concatGlass(tris, glass) : tris, glassBuf.length ? glass.map((_, i) => i * TRI_FLOATS) : glass);
  const L = buildLights({ ...lightParts, tris: triLights, portals, hasGlow: P.some((x) => x.glow) });
  for (let sIdx = 0; sIdx < nTri; sIdx++) if (attrU[sIdx * ATTR_FLOATS + 15] !== 0xffffffff) attrU[sIdx * ATTR_FLOATS + 15] += L.triBase;
  const env = lightParts.env;
  const textures = new Uint8Array(Math.max(1, texLayers.length) * TEX_SIZE * TEX_SIZE * 4);
  texLayers.forEach((px, i) => textures.set(px, i * TEX_SIZE * TEX_SIZE * 4));
  const hasT = matRecs.some((r) => r[11] > 0);
  const maxBounces = hasT ? 12 : 8;
  // header (§ 6.1)
  const header = new ArrayBuffer(HEADER_WORDS * 4), hu = new Uint32Array(header), hf = new Float32Array(header);
  hu[0] = MAGIC; hu[1] = SPEC_VERSION; hu[2] = nTriAll ? nTri : 0; hu[3] = bvh.nodeCount; hu[4] = matRecs.length; hu[5] = L.count; hu[6] = texLayers.length;
  hu[7] = (hasT ? HDR_FLAG.TRANSMISSION : 0) | (texLayers.length ? HDR_FLAG.TEXTURES : 0) | (night ? HDR_FLAG.NIGHT : 0);
  hf.set([up[0], up[1], up[2]], 8); hf.set([c[0], c[1], c[2], R], 12);
  hf.set(camera.world, 16);
  hf.set(invert4(farPlane(camera.proj, R * 200)), 32);
  hf.set([env.zen[0], env.zen[1], env.zen[2], env.I], 48); hf.set([env.hor[0], env.hor[1], env.hor[2], maxBounces], 52); hf.set([env.gnd[0], env.gnd[1], env.gnd[2]], 56);
  hu[11] = L.env; hu[59] = L.sun;          // the sky and sun lights' indices (0xffffffff = none)
  hu[60] = w; hu[61] = h; hu[62] = bvh.instCount; hu[63] = 2;   // instances (0: one level), BVH layout 2 (§ 6.3)
  for (const [k, v] of Object.entries(L.words)) hu[k] = v;      // RN.3: the ldat layout and the pick shares (§ 6.1)
  const nodes = new Float32Array(bvh.records.buffer, bvh.records.byteOffset, bvh.records.length);
  // RN.4: the camera's words (projection, lens, focus); auto focus = the distance to what the middle of the view sees
  if (camSettings) {
    let focus = R;
    if (camSettings.dof && !(camSettings.focus > 0) && nTriAll) {
      const o = [0, 0, 0], d = [0, 0, 0], hit = {};
      cameraRay(hf, hu, w / 2, h / 2, w, h, 0, 0, 0, 0, 0, o, d);
      const sc = sceneFromV2({ records: new Uint32Array(bvh.records.buffer, bvh.records.byteOffset, bvh.records.length), tris, header: { 3: hu[3], 62: hu[62], 63: hu[63] } });
      if (sceneHit(sc, o, d, 1e30, hit) && hit.t > 0) focus = hit.t;
    }
    for (const [k, v] of Object.entries(cameraWords(camSettings, camera, { focus }))) hu[k] = v;
  }
  if (camera1) writeMotion(hf, hu, camera1, invert4(farPlane(camera1.proj, R * 200)));
  // RN.6: render elements and light groups (the aux buffer: per pixel ELEMENTS vec4s, then one per light group)
  const nGroups = camSettings && camSettings.lightMix ? L.groups.length : 0;
  const nElem = camSettings && camSettings.elements ? ELEMENT_COUNT : camSettings && camSettings.denoise ? GUIDE_COUNT : 0;   // RN.5: the guides alone
  hu[HW.GROUPS] = nGroups; hu[HW.ELEMENTS] = nElem;
  // RN.7: the media: the volume block after everything else in ldat (§ 6.9); header word 82 = its offset (0 = none)
  let ldat = L.ldat;
  // RN.7 caustics: light tracing needs the plain camera (no panorama, no motion), and adds light to no element or group
  const cs = camSettings || {}, hasMedia = !!(volParts && (volParts.fog || (volParts.grids && volParts.grids.length)));
  const causticOk = cs.caustics === true && !hasMedia && (!cs.projection || cs.projection === 'normal') && !camera1 && nGroups === 0 && nElem < ELEMENT_COUNT;   // (light paths ignore fog and volumes: the two do not combine)
  const caustic = causticOk ? causticBlock({ L, R, camera, w, h }) : null;
  const blk = volParts || caustic ? packVolumes({ up, fog: volParts && volParts.fog, grids: volParts ? volParts.grids : [], caustic }) : null;
  if (blk) {
    const V = Math.max(4, Math.ceil(ldat.length / 4) * 4), merged = new Float32Array(V + blk.length);
    merged.set(ldat); merged.set(blk, V); ldat = merged; hu[HW.VOL_OFF] = V;
  }
  return {
    header, tris, attrs, nodes, mats, ldat, textures,
    counts: { tris: hu[2], nodes: bvh.nodeCount, instances: bvh.instCount, mats: matRecs.length, lights: L.count, bounded: L.nBounded, triLights: triLights.length, portals: Math.min(MAX_PORTALS, portals.length), textures: texLayers.length },
    keys, maxBounces, bounds: { c, R }, flags: hu[7], w, h, twoLevel: bvh.instCount > 0,
    caustics: !!caustic, causticPaths: caustic ? caustic[34] : 0,   // RN.7: light tracing is on; the light paths a sample
    groups: L.groups, auxStride: nGroups + nElem, objOfId: instances ? instances.map((it) => (it.obj === undefined ? -1 : it.obj)) : null,
  };
}

/**
 * RN.11 (IPR): a packed scene's header with a new camera (and lens / projection from `settings`; the auto-focus distance stays
 * the pack's unless `focus` is given) → a new header ArrayBuffer for tracer.restart(). Nothing else is repacked.
 */
export function setCamera(pk, camera, settings = {}, { focus = null, camera1 = null } = {}) {
  const header = pk.header.slice(0), hu = new Uint32Array(header), hf = new Float32Array(header);
  const up = [hf[8], hf[9], hf[10]], R = hf[15];
  if (settings.twoPoint && (!settings.projection || settings.projection === 'normal')) camera = levelCamera(camera.world, camera.proj, up);
  hf.set(camera.world, 16);
  hf.set(invert4(farPlane(camera.proj, R * 200)), 32);
  const keep = new Float32Array(pk.header)[HW.FOCUS];
  for (const [k, v] of Object.entries(cameraWords(settings, camera, { focus: focus ?? (keep > 0 ? keep : R) }))) hu[k] = v;
  hu[HW.MOTION] = 0;
  if (camera1) {   // RN.10: the camera at the shutter's close (an animation frame's motion blur)
    const c1 = settings.twoPoint && (!settings.projection || settings.projection === 'normal') ? levelCamera(camera1.world, camera1.proj, up) : camera1;
    writeMotion(hf, hu, c1, invert4(farPlane(c1.proj, R * 200)));
  }
  return header;
}

/** A § 5.1 OpenPBR material written by name with '#rrggbb' colours (the bench files' materials) → the record. */
export function openpbrRecord(m) {
  const o = {};
  for (const [k, v] of Object.entries(m || {})) o[k] = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? hexToAp1(v) : v;
  if (o.thin_walled !== undefined && o.geometry_thin_walled === undefined) o.geometry_thin_walled = !!o.thin_walled;
  return recordFrom(o);
}

/** `compute`'s bench scene (bench-scenes.js expandScene output) → the buffers. Linear sRGB colours there; AP1 here. */
export function packBench(sc, { w, h, triLights = true } = {}) {
  const up = basis(sc.up || [0, 0, 1]).up;
  // world bounds from each instance's mesh box (corners transformed)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const boxes = sc.meshes.map((m) => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], t = m.tris;
    for (let i = 0; i < t.length; i += 12) for (let k = 0; k < 3; k++) for (const e of [0, 4, 8]) { const v = t[i + k] + (e ? t[i + e + k] : 0); if (v < b[k]) b[k] = v; if (v > b[3 + k]) b[3 + k] = v; }
    return b;
  });
  for (const it of sc.instances) {
    const b = boxes[it.mesh], m = it.m;
    for (let cx = 0; cx < 8; cx++) {
      const p = [b[(cx & 1) ? 3 : 0], b[(cx & 2) ? 4 : 1], b[(cx & 4) ? 5 : 2]];
      for (let k = 0; k < 3; k++) { const v = m[k] * p[0] + m[4 + k] * p[1] + m[8 + k] * p[2] + m[12 + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
    }
  }
  const c = [0, 1, 2].map((k) => (Number.isFinite(lo[k]) ? (lo[k] + hi[k]) / 2 : 0));
  const R = Number.isFinite(lo[0]) ? Math.max(0.5, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2) : 5;
  const meshes = sc.meshes.map((m) => {
    const n = m.tris.length / 12, attrs = new Float32Array(n * ATTR_FLOATS), tris = new Float32Array(m.tris);
    for (let i = 0; i < n; i++) {
      const o = i * 12, e1 = [tris[o + 4], tris[o + 5], tris[o + 6]], e2 = [tris[o + 8], tris[o + 9], tris[o + 10]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      for (let k = 0; k < 3; k++) attrs.set([nx, ny, nz, 0], i * ATTR_FLOATS + k * 4);
    }
    return { tris, attrs, n };
  });
  const lin = (v) => rgbToAp1(v);
  const E = sc.env || { kind: 'black' };
  let env;
  if (E.kind === 'uniform') env = { zen: [1, 1, 1], hor: [1, 1, 1], gnd: [1, 1, 1], I: E.radiance };
  else if (E.kind === 'gradient') env = { zen: lin(hexLin(E.zenith)), hor: lin(hexLin(E.horizon)), gnd: lin(hexLin(E.ground)), I: E.intensity ?? 1 };
  else env = { zen: [0, 0, 0], hor: [0, 0, 0], gnd: [0, 0, 0], I: 0 };
  const sun = sc.sun ? { dir: sc.sun.dir, E: lin(hexLin(sc.sun.tint || '#ffffff')).map((x) => x * sc.sun.irradiance) } : null;
  const matRecs = sc.materials.map(openpbrRecord);
  const instances = sc.instances.map((it) => ({ mesh: it.mesh, m: it.m, material: it.material }));
  return assemble({ up, c, R, meshes, instances, matRecs, lightParts: { env, sun, lamps: sc.lights || [], ies: [], up, R }, camera: sc.camera(w / h), w, h, keys: sc.materials.map((m) => m.name), triLights });
}
const hexLin = (hex) => { const n = parseInt(String(hex).replace('#', ''), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => srgbToLinear(x / 255)); };

/** 4 × 4 inverse, column-major in and out (general; the projections are invertible). */
export function invert4(m) {
  const a = m, inv = new Float64Array(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  return Array.from(inv, (x) => x / (det || 1));
}
