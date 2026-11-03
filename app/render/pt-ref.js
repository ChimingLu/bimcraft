/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-ref.js — the JS reference path tracer (0.7 RN.1): RENDER-SPEC's estimator, pixel by pixel, in doubles. Slow on purpose —
 * it is the oracle the WGSL kernel and `compute`'s CPU kernel are compared against (CU.8), so it favours plainness over speed.
 * Tiny pictures only on the VPS (≤ 128 × 128, ≤ 16 spp; KICKOFF rule 14). No DOM. Scratch arrays are made once per tracer,
 * never per ray (KICKOFF rule 18).
 *
 *   const T = makeTracer(packed, {mask})        packed = pt-pack.js packScene() (or the same buffers as typed-array views, e.g.
 *                                               shared with a worker: pt-ref-job.js); mask = pt-sampler.js blueNoise()
 *   T.render({spp, s0 = 0, accum?, x0, y0, x1, y1, active?}) → accum: Float64Array (w·h·4: Σr, Σg, Σb, samples, AP1); active = pt-adapt.js's mask
 *   T.radiance(px, py, s) → [r, g, b]           one sample of one pixel (the returned array is reused)
 *   T.trace(ro, rd, tmax, out) → hit?           closest hit (BVH layout 2 through compute's sceneHit), out = {t, slot, inst, u, v}
 *   T.transmit(ro, rd, tmax, att) → bool        can a shadow ray get through? (att *= the smooth thin sheets it passes)
 *   toBytes(accum, w, h, exposure, wb) → Uint8ClampedArray RGBA   (the display image, § 2; wb = white-balance gains)
 *
 * Estimator (RENDER-SPEC § 3): NEE with one light per vertex + BSDF sampling, power-heuristic MIS; Russian roulette from bounce
 * RR_START; a smooth thin sheet (window glass) passes a path straight through without resetting MIS, which is exact because
 * it does not bend light, and lets shadow rays through it attenuated (§ 5.1). The shadow test visits every triangle on the
 * segment in any order (an opaque one blocks; sheets and cut-outs multiply), so it never steps past an opaque wall.
 * RN.2: emission (seen by camera and BSDF rays, weight 1), geometry_opacity as a stochastic cut-out (the path passes straight
 * through with probability 1 − opacity, MIS state kept), a medium's Beer–Lambert extinction on the way out of a solid
 * (transmission_depth), and dispersion: the first dispersive glass a path meets picks one of three wavelengths (× 3 on it).
 */
import { TRI_FLOATS, ATTR_FLOATS, MAT_FLOATS, LIGHT_FLOATS, TEX_SIZE, LIGHT, MAT_FLAG, DIMS, RR_START, MIN_ALPHA, LIGHT_SCALE,
  srgbToLinear, REC709_TO_AP1, displayPixel, HW, GROUND_OBJ, ELEMENT_COUNT, MAPPING, TEXPROJ_DIM0, hash4 } from './pt-spec.js';
import { sample } from './pt-sampler.js';
import { params, evalBsdf, sampleBsdf, frDielectric, emitted, CAT } from './pt-bsdf.js';
import { anisoAlphas } from './pt-ggx.js';
import { makeLights } from './pt-lights.js';
import { cameraRay } from './pt-camera.js';
import { makeMedia, VOL, hgPhase, hgSampleCos } from './pt-volume.js';
import { CAUS, readCaustic } from './pt-caustic.js';
import { sceneFromV2, sceneHit } from '../compute/bvh-scene.js';
import { traverseWide, newStack } from '../compute/bvh-wide.js';
import { intersectTri } from '../compute/bvh-core.js';

const INF = 1e30;
const NOLIGHT = 0xffffffff;

/** e1, e2 square to unit u, written into t and b (the same basis() as looks.js and the kernels). */
function basisInto(u, t, b) {
  let ax = 0, ay = 0, az = 1;
  if (!(Math.abs(u[2]) < 0.9)) { ax = 1; az = 0; }
  let x = u[1] * az - u[2] * ay, y = u[2] * ax - u[0] * az, z = u[0] * ay - u[1] * ax;
  const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
  t[0] = x; t[1] = y; t[2] = z;
  b[0] = u[1] * z - u[2] * y; b[1] = u[2] * x - u[0] * z; b[2] = u[0] * y - u[1] * x;
}

export function makeTracer(pk, { mask, caustics = true, measure = false }) {
  // the header as an ArrayBuffer (pack) or a typed-array view of one (shared with a worker)
  const hb = ArrayBuffer.isView(pk.header) ? pk.header : new Uint8Array(pk.header);
  const hu = new Uint32Array(hb.buffer, hb.byteOffset, 128), hf = new Float32Array(hb.buffer, hb.byteOffset, 128);
  const nTri = hu[2], nLights = hu[5], w = hu[60], h = hu[61];
  const tris = pk.tris, attrs = pk.attrs, mats = pk.mats, tex = pk.textures;
  const attrU = new Uint32Array(attrs.buffer, attrs.byteOffset, attrs.length);
  const triU = new Uint32Array(tris.buffer, tris.byteOffset, tris.length);
  const records = new Uint32Array(pk.nodes.buffer, pk.nodes.byteOffset, pk.nodes.length);
  const scene = sceneFromV2({ records, tris, header: { 3: hu[3], 62: hu[62], 63: hu[63] } });
  const inst = scene.inst, instU = inst ? new Uint32Array(inst.buffer, inst.byteOffset, inst.length) : null;
  const up = [hf[8], hf[9], hf[10]], R = hf[15];
  const maxB = hf[55] | 0;
  // per-material params made once (textured ones are refreshed per hit into `pT`)
  const P = [], SMOOTH = [];
  for (let i = 0; i < hu[4]; i++) {
    const p = params(mats, i * MAT_FLOATS);
    P.push(p);
    const [ax, ay] = anisoAlphas(p.coat > 0 ? p.rough + (Math.min(1, Math.pow(p.rough ** 4 + 2 * p.coatRough ** 4, 0.25)) - p.rough) * p.coat : p.rough, p.aniso);
    SMOOTH.push(Math.max(ax, ay) < MIN_ALPHA);
  }
  const pT = params(mats, 0);
  const LT = makeLights(pk, { P, emitted });   // RN.3: every light (pt-lights.js)
  const envIndex = LT.envIndex, sunIndex = LT.sunIndex;
  const SUN = sunIndex >= 0 ? (() => { const o = hu[73] + sunIndex * LIGHT_FLOATS; return [pk.ldat[o + 4], pk.ldat[o + 5], pk.ldat[o + 6], pk.ldat[o + 7]]; })() : null;

  // RN.7: media (pt-volume.js): fog layer and grid volumes. Draw k of the vertex of depth d: dimension DIM0 + STRIDE·d + k (§ 3.1)
  const media = hu[HW.VOL_OFF] ? makeMedia(pk.ldat, hu[HW.VOL_OFF]) : null;
  let vpx = 0, vpy = 0, vs = 0, vd = 0, vk = 0, sk = 0;
  const rndV = () => sample(mask, vpx, vpy, vs, VOL.DIM0 + VOL.STRIDE * vd + vk++);
  const rndS = () => sample(mask, vpx, vpy, vs, VOL.SHADOW_DIM0 + VOL.STRIDE * vd + sk++);
  const MV = { t: 0, albedo: [1, 1, 1], g: 0 }, xp = [0, 0, 0];
  // RN.7 caustics: the light tracer's data (pt-caustic.js); with it on, the eye paths leave the light a specular chain ends in to the light paths
  const cu32 = new Uint32Array(pk.ldat.buffer, pk.ldat.byteOffset, pk.ldat.length), VO = hu[HW.VOL_OFF];
  const SUP = measure ? new Float64Array(w * h * 3) : null;   // tests: what the eye paths left to the light tracer (Σ rgb per pixel)
  let curPix = 0;
  const CB = caustics && VO && (cu32[VO + 1] & VOL.CAUSTIC_FLAG) ? readCaustic(pk.ldat, VO + cu32[VO + 11], w, h) : null;

  // ---- rays against the scene ----
  const hitOut = { t: 0, slot: -1, mesh: -1, tri: -1, inst: -1, instSlot: -1, u: 0, v: 0 };
  function trace(ro, rd, tmax, out) {
    if (!nTri || !sceneHit(scene, ro, rd, tmax, hitOut)) return false;
    out.t = hitOut.t; out.slot = hitOut.slot; out.inst = hitOut.instSlot ?? -1; out.u = hitOut.u; out.v = hitOut.v;
    return true;
  }
  const matOf = (slot, instSlot) => (instSlot >= 0 && instU[instSlot * 16 + 15] !== 0xffffffff ? instU[instSlot * 16 + 15] : triU[slot * TRI_FLOATS + 3]);
  // transmittance: every triangle on the segment; an opaque one ends it (leaf returns 0 with any = true)
  const stS = newStack(), stS2 = newStack(), tq = { t: 0, u: 0, v: 0 };
  let tAtt = null, tInst = -1;
  const sheetLeaf = (first, count, ray, best) => {
    for (let s = first; s < first + count; s++) {
      if (!intersectTri(tris, s, ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz, 0, best, tq)) continue;
      const m = matOf(s, tInst), p = P[m];
      // OpenPBR's transparent shadow: T = lerp(1, (1 − M)·T_sheet, opacity), T_sheet only for a smooth thin transmissive sheet
      const sheet = p.thin && p.trans > 0 && SMOOTH[m];
      if (!sheet && p.opacity >= 1) return 0;
      let kk = 0;
      if (sheet) {
        // (1 − metal) · transmission · (1 − R') · colour, R' at this direction (normal in this space; only |cos| matters)
        const k = s * TRI_FLOATS;
        const e1x = tris[k + 4], e1y = tris[k + 5], e1z = tris[k + 6], e2x = tris[k + 8], e2y = tris[k + 9], e2z = tris[k + 10];
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        const cosT = Math.abs(nx * ray.dx + ny * ray.dy + nz * ray.dz) / ((Math.hypot(nx, ny, nz) * Math.hypot(ray.dx, ray.dy, ray.dz)) || 1);
        const F = frDielectric(cosT, p.eta);
        kk = (1 - p.metal) * p.trans * (1 - (2 * F) / (1 + F));
      }
      for (let c = 0; c < 3; c++) tAtt[c] *= 1 - p.opacity + p.opacity * kk * (sheet ? p.tcol[c] : 0);
      if (!(tAtt[0] > 0 || tAtt[1] > 0 || tAtt[2] > 0)) return 0;
    }
    return Infinity;
  };
  const wray = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 0, inst: -1 }, lray = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 0, inst: -1 };
  const instLeaf = (first, count, r, best) => {
    for (let s = first; s < first + count; s++) {
      const k = s * 16;
      lray.ox = inst[k] * r.ox + inst[k + 1] * r.oy + inst[k + 2] * r.oz + inst[k + 3];
      lray.oy = inst[k + 4] * r.ox + inst[k + 5] * r.oy + inst[k + 6] * r.oz + inst[k + 7];
      lray.oz = inst[k + 8] * r.ox + inst[k + 9] * r.oy + inst[k + 10] * r.oz + inst[k + 11];
      lray.dx = inst[k] * r.dx + inst[k + 1] * r.dy + inst[k + 2] * r.dz;
      lray.dy = inst[k + 4] * r.dx + inst[k + 5] * r.dy + inst[k + 6] * r.dz;
      lray.dz = inst[k + 8] * r.dx + inst[k + 9] * r.dy + inst[k + 10] * r.dz;
      tInst = s;
      const t = traverseWide(scene.nodes, scene.f, instU[k + 12], lray, best, sheetLeaf, true, stS2);
      tInst = -1;
      if (t < best) return t;
    }
    return Infinity;
  };
  function transmit(ro, rd, tmax, att) {
    if (!nTri) return true;
    tAtt = att;
    wray.ox = ro[0]; wray.oy = ro[1]; wray.oz = ro[2]; wray.dx = rd[0]; wray.dy = rd[1]; wray.dz = rd[2];
    const t = scene.two ? traverseWide(scene.nodes, scene.f, 0, wray, tmax, instLeaf, true, stS) : traverseWide(scene.nodes, scene.f, 0, wray, tmax, sheetLeaf, true, stS);
    return !(t < tmax);
  }

  // ---- shading points: world position, geometric and shading normals (instance rows: n_world = Rᵀ n), uv, material ----
  const S = { p: [0, 0, 0], ng: [0, 0, 0], ns: [0, 0, 0], uv: [0, 0], mat: 0, light: -1 };
  const toWorldN = (x, y, z, instSlot, out) => {
    if (instSlot >= 0) {
      const k = instSlot * 16;
      const X = inst[k] * x + inst[k + 4] * y + inst[k + 8] * z, Y = inst[k + 1] * x + inst[k + 5] * y + inst[k + 9] * z, Z = inst[k + 2] * x + inst[k + 6] * y + inst[k + 10] * z;
      x = X; y = Y; z = Z;
    }
    const l = Math.hypot(x, y, z);
    if (!(l > 0)) return false;
    out[0] = x / l; out[1] = y / l; out[2] = z / l;
    return true;
  };
  function surface(ro, rd, hr, pathIx = 0, s = 0, k = 0) {
    const o = hr.slot * TRI_FLOATS, a = hr.slot * ATTR_FLOATS, b1 = hr.u, b2 = hr.v, b0 = 1 - b1 - b2;
    for (let k = 0; k < 3; k++) S.p[k] = ro[k] + rd[k] * hr.t;
    const e1x = tris[o + 4], e1y = tris[o + 5], e1z = tris[o + 6], e2x = tris[o + 8], e2y = tris[o + 9], e2z = tris[o + 10];
    toWorldN(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x, hr.inst, S.ng);
    const nx = b0 * attrs[a] + b1 * attrs[a + 4] + b2 * attrs[a + 8], ny = b0 * attrs[a + 1] + b1 * attrs[a + 5] + b2 * attrs[a + 9], nz = b0 * attrs[a + 2] + b1 * attrs[a + 6] + b2 * attrs[a + 10];
    if (!toWorldN(nx, ny, nz, hr.inst, S.ns)) { S.ns[0] = S.ng[0]; S.ns[1] = S.ng[1]; S.ns[2] = S.ng[2]; }
    S.uv[0] = b0 * attrs[a + 3] + b1 * attrs[a + 7] + b2 * attrs[a + 11];
    S.uv[1] = b0 * attrs[a + 12] + b1 * attrs[a + 13] + b2 * attrs[a + 14];
    S.mat = matOf(hr.slot, hr.inst);
    const mo = S.mat * MAT_FLOATS;
    if (mats[mo + 66] !== MAPPING.UV || (mats[mo + 15] & MAT_FLAG.NORMAL_TEX)) texSurface(o, a, mo, b1, b2, hr.inst, pathIx, s, k);
    const li = attrU[a + 15];
    S.light = hr.inst < 0 || li !== 0xffffffff ? (li === 0xffffffff ? -1 : li) : -1;
    return S;
  }
  // ---- MT.1 (RENDER-SPEC § 6.6): box / triplanar mapping and normal maps, at the hit (the intersect stage on the GPU) ----
  const upAx = Math.abs(up[1]) > Math.abs(up[0]) ? (Math.abs(up[2]) > Math.abs(up[1]) ? 2 : 1) : Math.abs(up[2]) > Math.abs(up[0]) ? 2 : 0;
  const pm = [0, 0, 0], gm = [0, 0, 0], dpu = [0, 0, 0], dpv = [0, 0, 0], tw = [0, 0, 0], bw = [0, 0, 0];
  /** The projection on axis ax (§ 6.6 box): uv from the mesh-space point pm, and its u and v directions into dpu, dpv. */
  function project(ax) {
    let iu, iv;
    if (ax === upAx) { iu = (ax + 1) % 3; iv = (ax + 2) % 3; } else { iv = upAx; iu = 3 - ax - upAx; }
    S.uv[0] = pm[iu]; S.uv[1] = pm[iv];
    dpu[0] = dpu[1] = dpu[2] = 0; dpv[0] = dpv[1] = dpv[2] = 0; dpu[iu] = 1; dpv[iv] = 1;
  }
  function texSurface(o, a, mo, b1, b2, instSlot, pathIx, s, k) {
    const mapping = mats[mo + 66], flags = mats[mo + 15];
    const e1x = tris[o + 4], e1y = tris[o + 5], e1z = tris[o + 6], e2x = tris[o + 8], e2y = tris[o + 9], e2z = tris[o + 10];
    let haveFrame = false;
    if (mapping === MAPPING.BOX || mapping === MAPPING.TRIPLANAR) {
      for (let c = 0; c < 3; c++) pm[c] = tris[o + c] + b1 * tris[o + 4 + c] + b2 * tris[o + 8 + c];   // the mesh's own space
      gm[0] = e1y * e2z - e1z * e2y; gm[1] = e1z * e2x - e1x * e2z; gm[2] = e1x * e2y - e1y * e2x;
      const gl = Math.hypot(gm[0], gm[1], gm[2]), ax0 = gl > 0 ? Math.abs(gm[0]) / gl : 0, ay0 = gl > 0 ? Math.abs(gm[1]) / gl : 0, az0 = gl > 0 ? Math.abs(gm[2]) / gl : 1;
      let ax;
      if (mapping === MAPPING.BOX) ax = ay0 > ax0 ? (az0 > ay0 ? 2 : 1) : az0 > ax0 ? 2 : 0;
      else {
        const kk = mats[mo + 67], wx = Math.pow(ax0, kk), wy = Math.pow(ay0, kk), wz = Math.pow(az0, kk), tot = wx + wy + wz;
        const xi = ((hash4(pathIx >>> 0, s >>> 0, k >>> 0, TEXPROJ_DIM0) >>> 8) / 16777216) * tot;
        ax = xi < wx ? 0 : xi < wx + wy ? 1 : 2;
      }
      project(ax);
      haveFrame = true;
    }
    if (!(flags & MAT_FLAG.NORMAL_TEX)) return;
    if (!haveFrame) {
      // dP/du, dP/dv of the triangle from its edges and UV differences (§ 6.6)
      const du1 = attrs[a + 7] - attrs[a + 3], dv1 = attrs[a + 13] - attrs[a + 12], du2 = attrs[a + 11] - attrs[a + 3], dv2 = attrs[a + 14] - attrs[a + 12];
      const det = du1 * dv2 - du2 * dv1;
      if (!(Math.abs(det) > 1e-20)) return;
      dpu[0] = (dv2 * e1x - dv1 * e2x) / det; dpu[1] = (dv2 * e1y - dv1 * e2y) / det; dpu[2] = (dv2 * e1z - dv1 * e2z) / det;
      dpv[0] = (du1 * e2x - du2 * e1x) / det; dpv[1] = (du1 * e2y - du2 * e1y) / det; dpv[2] = (du1 * e2z - du2 * e1z) / det;
    }
    if (!toWorldN(dpu[0], dpu[1], dpu[2], instSlot, tw) || !toWorldN(dpv[0], dpv[1], dpv[2], instSlot, bw)) return;
    const t = texLookup(mats[mo + 64], S.uv[0] * mats[mo + 17], S.uv[1] * mats[mo + 18]), str = mats[mo + 68];
    let x = Math.min(1, Math.max(-1, (255 * t[0] - 128) / 127)), y = Math.min(1, Math.max(-1, (255 * t[1] - 128) / 127));
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    x *= str; y *= str;
    const n = S.ns, d = n[0] * tw[0] + n[1] * tw[1] + n[2] * tw[2];
    let Tx = tw[0] - n[0] * d, Ty = tw[1] - n[1] * d, Tz = tw[2] - n[2] * d;
    const tl = Math.hypot(Tx, Ty, Tz);
    if (!(tl > 1e-12)) return;
    Tx /= tl; Ty /= tl; Tz /= tl;
    let Bx = n[1] * Tz - n[2] * Ty, By = n[2] * Tx - n[0] * Tz, Bz = n[0] * Ty - n[1] * Tx;
    if (Bx * bw[0] + By * bw[1] + Bz * bw[2] < 0) { Bx = -Bx; By = -By; Bz = -Bz; }
    let nx = x * Tx + y * Bx + z * n[0], ny = x * Ty + y * By + z * n[1], nz = x * Tz + y * Bz + z * n[2];
    const nl = Math.hypot(nx, ny, nz);
    if (!(nl > 0)) return;
    nx /= nl; ny /= nl; nz /= nl;
    const g = S.ng, side0 = n[0] * g[0] + n[1] * g[1] + n[2] * g[2], side1 = nx * g[0] + ny * g[1] + nz * g[2];
    if (side0 * side1 <= 0) return;   // n′ on the other side of the surface from n: n stays
    n[0] = nx; n[1] = ny; n[2] = nz;
  }
  const texel = [0, 0, 0, 0];
  function texLookup(layer, u, v) {
    const fx = (u - Math.floor(u)) * TEX_SIZE - 0.5, fy = (v - Math.floor(v)) * TEX_SIZE - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, base = layer * TEX_SIZE * TEX_SIZE * 4;
    texel[0] = texel[1] = texel[2] = texel[3] = 0;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const x = (x0 + i + TEX_SIZE) % TEX_SIZE, y = (y0 + j + TEX_SIZE) % TEX_SIZE, wgt = (i ? tx : 1 - tx) * (j ? ty : 1 - ty), q = base + (y * TEX_SIZE + x) * 4;
      for (let k = 0; k < 4; k++) texel[k] += (wgt * tex[q + k]) / 255;
    }
    return texel;
  }
  const TEXP = MAT_FLAG.BASE_TEX | MAT_FLAG.METAL_TEX | MAT_FLAG.OPACITY_TEX | MAT_FLAG.EMIT_TEX;
  function matAt(s) {
    const o = s.mat * MAT_FLOATS, flags = mats[o + 15];
    if (!(flags & TEXP)) return P[s.mat];
    params(mats, o, pT);
    const u = s.uv[0] * mats[o + 17], v = s.uv[1] * mats[o + 18];
    if (flags & MAT_FLAG.BASE_TEX) {
      const t = texLookup(mats[o + 16], u, v);
      const r = srgbToLinear(t[0]), g = srgbToLinear(t[1]), b = srgbToLinear(t[2]);
      for (let k = 0; k < 3; k++) pT.base[k] = (REC709_TO_AP1[k][0] * r + REC709_TO_AP1[k][1] * g + REC709_TO_AP1[k][2] * b) * mats[o + 3];
      if (flags & MAT_FLAG.ROUGH_TEX) pT.rough = Math.min(1, Math.max(0, t[3] * mats[o + 8]));
    }
    // v8 (§ 6.6): the data layer's metalness and opacity, the emission layer's colour, replacing the record's words
    if (flags & (MAT_FLAG.METAL_TEX | MAT_FLAG.OPACITY_TEX)) {
      const t = texLookup(mats[o + 64], u, v);
      if (flags & MAT_FLAG.METAL_TEX) pT.metal = Math.min(1, Math.max(0, t[2]));
      if (flags & MAT_FLAG.OPACITY_TEX) pT.opacity = Math.min(1, Math.max(0, t[3]));
    }
    if (flags & MAT_FLAG.EMIT_TEX) {
      const t = texLookup(mats[o + 65], u, v);
      const r = srgbToLinear(t[0]), g = srgbToLinear(t[1]), b = srgbToLinear(t[2]);
      for (let k = 0; k < 3; k++) pT.emis[k] = (REC709_TO_AP1[k][0] * r + REC709_TO_AP1[k][1] * g + REC709_TO_AP1[k][2] * b) * mats[o + 23];
    }
    return pT;
  }

  // ---- lights: pt-lights.js ----
  const LS = { wi: [0, 0, 0], dist: 0, L: [0, 0, 0], pdf: 0 };
  const LH = { i: -1, t: 0, L: [0, 0, 0] };

  // ---- one sample of one pixel ----
  const ro = [0, 0, 0], rd = [0, 0, 0], wo = [0, 0, 0], woL = [0, 0, 0], wiL = [0, 0, 0], nd = [0, 0, 0], so = [0, 0, 0], n = [0, 0, 0];
  const tB = [0, 0, 0], bB = [0, 0, 0], tmp = new Float64Array(8), bs = new Float64Array(9), env = [0, 0, 0], att = [1, 1, 1];
  const hit = { t: 0, slot: -1, inst: -1, u: 0, v: 0 };
  const mis = (a, b) => (a * a) / (a * a + b * b);
  const local = (v, out) => {
    out[0] = v[0] * tB[0] + v[1] * tB[1] + v[2] * tB[2];
    out[1] = v[0] * bB[0] + v[1] * bB[1] + v[2] * bB[2];
    out[2] = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
    return out;
  };
  // the camera (RN.4, pt-camera.js): pixel sample, lens sample (dims 2–3), shutter time (dim 4)
  const lensOn = hf[HW.LENS_R] > 0, motionOn = hu[HW.MOTION] === 1;
  function camera(px, py, s) {
    const jx = sample(mask, px, py, s, DIMS.PIXEL_X), jy = sample(mask, px, py, s, DIMS.PIXEL_Y);
    const l1 = lensOn ? sample(mask, px, py, s, DIMS.LENS_X) : 0, l2 = lensOn ? sample(mask, px, py, s, DIMS.LENS_Y) : 0;
    const tm = motionOn ? sample(mask, px, py, s, DIMS.TIME) : 0;
    cameraRay(hf, hu, px, py, w, h, jx, jy, l1, l2, tm, ro, rd);
  }
  const L = [0, 0, 0], beta = [1, 1, 1], prevP = [0, 0, 0], emis = [0, 0, 0];
  // RN.6 render elements and light groups (RENDER-SPEC § 7): one sample's share of each, added to `aux` by render()
  // nE: 0, 2 (the guides only: albedo, normal + depth — RN.5's denoiser) or all ELEMENT_COUNT
  const nG = hu[HW.GROUPS], nE = hu[HW.ELEMENTS], STRIDE = nG + nE, glowGroup = hu[HW.GLOW_GROUP], lit = nE >= ELEMENT_COUNT;
  const AX = new Float64Array(Math.max(1, STRIDE) * 4), ratio = [1, 1, 1], f3 = [new Float64Array(8), new Float64Array(8), new Float64Array(8)];
  const EL = { ALBEDO: 0, ND: 1, DIRECT: [2, 4, 6], INDIRECT: [3, 5, 7], EMISSION: 8, IDS: 9 };
  const catSlot = (c) => (c === CAT.DIFFUSE ? 0 : c === CAT.SPECULAR ? 1 : 2);
  let scat = 0, cat = 0, recorded = false, travelled = 0;
  /** A contribution c (rgb) from light group g: to the beauty, its group, and its element (emission before any bounce; else the
   * first bounce's category, direct after one bounce, indirect after more — the category's share carried in `ratio`). */
  const addTo = (o, c0, c1, c2) => { AX[o] += c0; AX[o + 1] += c1; AX[o + 2] += c2; };
  function add(c0, c1, c2, g, bounces) {
    L[0] += c0; L[1] += c1; L[2] += c2;
    if (!STRIDE) return;
    if (nG) addTo((nE + Math.min(nG - 1, g)) * 4, c0, c1, c2);
    if (!lit) return;
    if (bounces === 0) addTo(EL.EMISSION * 4, c0, c1, c2);
    else addTo((bounces === 1 ? EL.DIRECT : EL.INDIRECT)[catSlot(cat)] * 4, c0 * ratio[0], c1 * ratio[1], c2 * ratio[2]);
  }
  const groupOf = (i) => LT.groupOf(i);
  function radiance(px, py, s) {
    camera(px, py, s); curPix = py * w + px;
    L[0] = L[1] = L[2] = 0; beta[0] = beta[1] = beta[2] = 1;
    if (STRIDE) AX.fill(0);
    scat = 0; cat = 0; recorded = false; travelled = 0; ratio[0] = ratio[1] = ratio[2] = 1;
    let prevPdf = 0, delta = true, chan = 0, sawND = false, specBefore = false;   // RN.7: a non-delta vertex seen; a delta one before the first non-delta
    prevP[0] = ro[0]; prevP[1] = ro[1]; prevP[2] = ro[2];
    for (let depth = 0; depth <= maxB; depth++) {
      const dim = DIMS.BOUNCE0 + DIMS.PER_BOUNCE * depth;
      const got = trace(ro, rd, INF, hit);
      // RN.7: a medium collision before the surface (or the sky) ends the segment there
      let evented = false;
      if (media) { vpx = px; vpy = py; vs = s; vd = depth; vk = 0; evented = media.event(ro, rd, got ? hit.t : INF, rndV, MV); }
      if (nLights && LT.lampHit(ro, rd, evented ? MV.t : got ? hit.t : INF, LH)) {
        const wgt = delta ? 1 : mis(prevPdf, LT.pickProb(LH.i, prevP) * LT.pdf(LH.i, prevP, rd, LH.t));
        if (!(CB && delta && sawND && !specBefore)) add(beta[0] * LH.L[0] * wgt, beta[1] * LH.L[1] * wgt, beta[2] * LH.L[2] * wgt, groupOf(LH.i), scat);
        else if (SUP) for (let k = 0; k < 3; k++) SUP[curPix * 3 + k] += beta[k] * LH.L[k] * wgt;
        break;
      }
      if (evented) {
        // ---- a medium vertex (§ 3.1): the throughput takes the albedo; NEE and a phase sample, with MIS, as at a surface ----
        for (let k = 0; k < 3; k++) xp[k] = ro[k] + rd[k] * MV.t;
        travelled += MV.t;
        for (let k = 0; k < 3; k++) beta[k] *= MV.albedo[k];
        if (lit && scat === 0) { cat = CAT.DIFFUSE; ratio[0] = ratio[1] = ratio[2] = 1; }
        const mdim = DIMS.BOUNCE0 + DIMS.PER_BOUNCE * depth;
        const pkm = nLights ? LT.pick(xp, sample(mask, px, py, s, mdim + DIMS.LIGHT_PICK)) : null;
        if (pkm && pkm.i >= 0 && LT.sample(pkm.i, xp, sample(mask, px, py, s, mdim + DIMS.LIGHT_U), sample(mask, px, py, s, mdim + DIMS.LIGHT_V), pkm.u, LS)) {
          const ph = hgPhase(rd[0] * LS.wi[0] + rd[1] * LS.wi[1] + rd[2] * LS.wi[2], MV.g);
          if (ph > 0 && (LS.L[0] > 0 || LS.L[1] > 0 || LS.L[2] > 0)) {
            att[0] = att[1] = att[2] = 1;
            const epsm = 1e-4 * Math.max(1, Math.abs(xp[0]), Math.abs(xp[1]), Math.abs(xp[2]));
            const tEndm = LS.dist >= INF ? INF : LS.dist - epsm;
            if (tEndm > 0 && transmit(xp, LS.wi, tEndm, att)) {
              sk = 0;
              const Tm = media.transmit(xp, LS.wi, tEndm, rndS);
              const pl = pkm.prob * LS.pdf, wgt = mis(pl, ph), k0 = (ph * Tm * wgt) / pl;
              if (Tm > 0) add(beta[0] * att[0] * LS.L[0] * k0, beta[1] * att[1] * LS.L[1] * k0, beta[2] * att[2] * LS.L[2] * k0, groupOf(pkm.i), scat + 1);
            }
          }
        }
        if (depth >= maxB) break;
        const cT = hgSampleCos(sample(mask, px, py, s, mdim + DIMS.BSDF_U), MV.g), sT = Math.sqrt(Math.max(0, 1 - cT * cT)), phi = 2 * Math.PI * sample(mask, px, py, s, mdim + DIMS.BSDF_V);
        basisInto(rd, tB, bB);
        const cp = Math.cos(phi) * sT, sp2 = Math.sin(phi) * sT;
        for (let k = 0; k < 3; k++) nd[k] = rd[k] * cT + tB[k] * cp + bB[k] * sp2;
        scat++;
        prevPdf = hgPhase(cT, MV.g); delta = false;
        for (let k = 0; k < 3; k++) { prevP[k] = xp[k]; ro[k] = xp[k]; rd[k] = nd[k]; }
        if (depth >= RR_START) {
          const q = Math.min(0.95, Math.max(0.05, Math.max(beta[0], beta[1], beta[2])));
          if (sample(mask, px, py, s, mdim + DIMS.RR) >= q) break;
          for (let k = 0; k < 3; k++) beta[k] /= q;
        }
        if (!(beta[0] > 0 || beta[1] > 0 || beta[2] > 0)) break;
        continue;
      }
      if (!got) {
        LT.env(rd, env);
        const we = delta || envIndex < 0 ? 1 : mis(prevPdf, LT.pickProb(envIndex, prevP) * LT.envPdf(prevP, rd));
        add(beta[0] * env[0] * we, beta[1] * env[1] * we, beta[2] * env[2] * we, envIndex >= 0 ? groupOf(envIndex) : 0, scat);
        if (sunIndex >= 0 && depth > 0 && LT.sample(sunIndex, prevP, 0, 0, 0, LS)) {
          const sd = SUN, c = rd[0] * sd[0] + rd[1] * sd[1] + rd[2] * sd[2];
          if (c >= SUN[3]) {
            const ws = delta ? 1 : mis(prevPdf, LT.pickProb(sunIndex, prevP) * LS.pdf);
            if (!(CB && delta && sawND && !specBefore)) add(beta[0] * LS.L[0] * ws, beta[1] * LS.L[1] * ws, beta[2] * LS.L[2] * ws, groupOf(sunIndex), scat);
            else if (SUP) for (let k = 0; k < 3; k++) SUP[curPix * 3 + k] += beta[k] * LS.L[k] * ws;
          }
        }
        break;
      }
      const sp = surface(ro, rd, hit, curPix, s, depth), p = matAt(sp);
      travelled += hit.t;
      // the frame faces the incoming ray (wo side)
      const front = sp.ng[0] * rd[0] + sp.ng[1] * rd[1] + sp.ng[2] * rd[2] < 0;
      const eps = 1e-4 * Math.max(1, Math.abs(sp.p[0]), Math.abs(sp.p[1]), Math.abs(sp.p[2]));
      // leaving a coloured solid: Beer–Lambert over the segment just travelled inside it
      if (!front && !p.thin && p.beer) for (let k = 0; k < 3; k++) beta[k] *= Math.exp(-p.mut[k] * hit.t);
      // a cut-out (geometry_opacity): pass straight through, the path's MIS state kept
      if (p.opacity < 1 && sample(mask, px, py, s, dim + DIMS.OPACITY) >= p.opacity) {
        const g = sp.ng[0] * rd[0] + sp.ng[1] * rd[1] + sp.ng[2] * rd[2] >= 0 ? eps : -eps;
        for (let k = 0; k < 3; k++) ro[k] = sp.p[k] + sp.ng[k] * g;
        continue;
      }
      // emission (camera and BSDF rays; the emitter's front, or both sides of a thin sheet)
      if (front || p.thin) {
        const cl = Math.abs(sp.ng[0] * rd[0] + sp.ng[1] * rd[1] + sp.ng[2] * rd[2]);
        emitted(p, cl, LIGHT_SCALE, emis);
        if (emis[0] > 0 || emis[1] > 0 || emis[2] > 0) {
          // an emissive triangle that is a light: MIS against sampling it (RN.3); else the BSDF ray alone finds it
          const wgt = delta || sp.light < 0 ? 1 : mis(prevPdf, LT.pickProb(sp.light, prevP) * LT.pdf(sp.light, prevP, rd, hit.t));
          if (!(CB && sp.light >= 0 && delta && sawND && !specBefore)) add(beta[0] * emis[0] * wgt, beta[1] * emis[1] * wgt, beta[2] * emis[2] * wgt, sp.light >= 0 ? groupOf(sp.light) : glowGroup, scat);
          else if (SUP) for (let k = 0; k < 3; k++) SUP[curPix * 3 + k] += beta[k] * emis[k] * wgt;
        }
      }
      // dispersion: the first dispersive glass picks one wavelength for the rest of the path
      if (chan === 0 && p.cauchyB > 0 && p.trans > 0 && !p.thin) {
        chan = 1 + Math.min(2, Math.floor(sample(mask, px, py, s, dim + DIMS.DISPERSION) * 3));
        for (let k = 0; k < 3; k++) beta[k] = k === chan - 1 ? beta[k] * 3 : 0;
      }
      n[0] = sp.ns[0]; n[1] = sp.ns[1]; n[2] = sp.ns[2];
      if (n[0] * rd[0] + n[1] * rd[1] + n[2] * rd[2] > 0) { n[0] = -n[0]; n[1] = -n[1]; n[2] = -n[2]; }
      basisInto(n, tB, bB);
      wo[0] = -rd[0]; wo[1] = -rd[1]; wo[2] = -rd[2];
      local(wo, woL);
      if (woL[2] <= 0) woL[2] = 1e-6;
      // the guides (albedo, normal, depth, ids) at the first surface that is not a perfect mirror or clear glass (seen through them)
      if (nE && !recorded && !(SMOOTH[sp.mat] && (p.metal > 0.5 || p.trans > 0.5))) {
        recorded = true;
        for (let k = 0; k < 3; k++) AX[EL.ALBEDO * 4 + k] = Math.min(1, (1 - p.trans) * p.base[k] + p.trans * p.tcol[k]);
        AX[EL.ALBEDO * 4 + 3] = 1;
        AX[EL.ND * 4] = n[0]; AX[EL.ND * 4 + 1] = n[1]; AX[EL.ND * 4 + 2] = n[2]; AX[EL.ND * 4 + 3] = travelled;
        const raw = hit.inst >= 0 ? instU[hit.inst * 16 + 13] : triU[hit.slot * TRI_FLOATS + 7];   // the instance's own index, else e1.w
        if (lit) AX[EL.IDS * 4] = raw === GROUND_OBJ ? -1 : raw + 1; if (lit) { AX[EL.IDS * 4 + 1] = sp.mat + 1; AX[EL.IDS * 4 + 2] = hit.inst >= 0 ? 1 : 0; AX[EL.IDS * 4 + 3] = 1; }
      }
      // (origins are offset along the geometric normal, to the side each new ray leaves from)
      // NEE
      const pk0 = nLights ? LT.pick(sp.p, sample(mask, px, py, s, dim + DIMS.LIGHT_PICK)) : null;
      if (pk0 && pk0.i >= 0) {
        const li = pk0.i, pick = pk0.prob;
        if (LT.sample(li, sp.p, sample(mask, px, py, s, dim + DIMS.LIGHT_U), sample(mask, px, py, s, dim + DIMS.LIGHT_V), pk0.u, LS)) {
          local(LS.wi, wiL);
          evalBsdf(p, front, chan, woL, wiL, tmp);
          // the first bounce's light split by category (diffuse, specular, transmission) for the direct elements
          const split = lit && scat === 0;
          if (split) for (let c = 0; c < 3; c++) evalBsdf(p, front, chan, woL, wiL, f3[c], 1 << c);
          if ((tmp[3] > 0 || tmp[4] > 0 || tmp[5] > 0) && (LS.L[0] > 0 || LS.L[1] > 0 || LS.L[2] > 0)) {
            const g = sp.ng[0] * LS.wi[0] + sp.ng[1] * LS.wi[1] + sp.ng[2] * LS.wi[2] >= 0 ? eps : -eps;
            for (let k = 0; k < 3; k++) so[k] = sp.p[k] + sp.ng[k] * g;
            att[0] = att[1] = att[2] = 1;
            // the segment ends short of the light by the origin's own offset (an emissive triangle is geometry: never shadow itself)
            const tEnd = LS.dist >= INF ? INF : LS.dist - ((so[0] - sp.p[0]) * LS.wi[0] + (so[1] - sp.p[1]) * LS.wi[1] + (so[2] - sp.p[2]) * LS.wi[2]) - eps;
            if (tEnd > 0 && transmit(so, LS.wi, tEnd, att)) {
              if (media) { vpx = px; vpy = py; vs = s; vd = depth; sk = 0; const Tm = media.transmit(so, LS.wi, tEnd, rndS); att[0] *= Tm; att[1] *= Tm; att[2] *= Tm; }
              const pl = pick * LS.pdf, wgt = mis(pl, tmp[6]), gi = groupOf(li);
              if (!split) add((beta[0] * tmp[3] * att[0] * LS.L[0] * wgt) / pl, (beta[1] * tmp[4] * att[1] * LS.L[1] * wgt) / pl, (beta[2] * tmp[5] * att[2] * LS.L[2] * wgt) / pl, gi, scat + 1);
              else {
                // direct light: the beauty and the group get the whole; each category's element its own lobes' part
                const c0 = (beta[0] * tmp[3] * att[0] * LS.L[0] * wgt) / pl, c1 = (beta[1] * tmp[4] * att[1] * LS.L[1] * wgt) / pl, c2 = (beta[2] * tmp[5] * att[2] * LS.L[2] * wgt) / pl;
                L[0] += c0; L[1] += c1; L[2] += c2;
                if (nG) addTo((nE + Math.min(nG - 1, gi)) * 4, c0, c1, c2);
                for (let c = 0; c < 3; c++) {
                  const F = f3[c], k0 = (beta[0] * att[0] * LS.L[0] * wgt) / pl, k1 = (beta[1] * att[1] * LS.L[1] * wgt) / pl, k2 = (beta[2] * att[2] * LS.L[2] * wgt) / pl;
                  addTo(EL.DIRECT[c] * 4, F[3] * k0, F[4] * k1, F[5] * k2);
                }
              }
            }
          }
        }
      }
      if (depth >= maxB) break;
      // BSDF sample
      if (!sampleBsdf(p, front, chan, woL, sample(mask, px, py, s, dim + DIMS.BSDF_U), sample(mask, px, py, s, dim + DIMS.BSDF_V), sample(mask, px, py, s, dim + DIMS.LOBE), bs)) break;
      for (let k = 0; k < 3; k++) nd[k] = tB[k] * bs[0] + bB[k] * bs[1] + n[k] * bs[2];
      for (let k = 0; k < 3; k++) beta[k] *= bs[3 + k];
      // the first bounce fixes the path's category: a delta lobe's own; otherwise one category picked by its share of f (its
      // probability q), the path then carrying f_c / (f · q) per channel so each category's element stays unbiased
      if (scat === 0 && lit) {
        if (bs[7] === 1) { cat = bs[8]; ratio[0] = ratio[1] = ratio[2] = 1; }
        else {
          wiL[0] = bs[0]; wiL[1] = bs[1]; wiL[2] = bs[2];
          let tot = 0; const q = [0, 0, 0];
          for (let c = 0; c < 3; c++) { evalBsdf(p, front, chan, woL, wiL, f3[c], 1 << c); q[c] = Math.max(0, 0.2722 * f3[c][3] + 0.6741 * f3[c][4] + 0.0537 * f3[c][5]); tot += q[c]; }
          let u = sample(mask, px, py, s, dim + DIMS.SPARE) * tot, c = 0;
          while (c < 2 && u >= q[c]) { u -= q[c]; c++; }
          cat = 1 << c;
          const qc = tot > 0 ? q[c] / tot : 1, F = f3[c];
          evalBsdf(p, front, chan, woL, wiL, tmp);
          for (let k = 0; k < 3; k++) ratio[k] = tmp[3 + k] > 0 && qc > 0 ? F[3 + k] / tmp[3 + k] / qc : 0;
        }
      }
      scat++;
      const straight = bs[7] === 1 && p.thin && Math.abs(nd[0] + wo[0]) + Math.abs(nd[1] + wo[1]) + Math.abs(nd[2] + wo[2]) < 1e-6;
      if (!straight) { prevPdf = bs[6]; delta = bs[7] === 1; prevP[0] = sp.p[0]; prevP[1] = sp.p[1]; prevP[2] = sp.p[2]; if (delta) { if (!sawND) specBefore = true; } else sawND = true; }
      const g = sp.ng[0] * nd[0] + sp.ng[1] * nd[1] + sp.ng[2] * nd[2] >= 0 ? eps : -eps;
      for (let k = 0; k < 3; k++) { ro[k] = sp.p[k] + sp.ng[k] * g; rd[k] = nd[k]; }
      if (depth >= RR_START) {
        const q = Math.min(0.95, Math.max(0.05, Math.max(beta[0], beta[1], beta[2])));
        if (sample(mask, px, py, s, dim + DIMS.RR) >= q) break;
        for (let k = 0; k < 3; k++) beta[k] /= q;
      }
      if (!(beta[0] > 0 || beta[1] > 0 || beta[2] > 0)) break;
    }
    return L;
  }


  // ---- RN.7: caustics by light tracing (RENDER-SPEC § 3.3) ----
  // Paths from the lights: through ≥ 1 specular bounce first, then every vertex that has a non-delta lobe is connected to the
  // camera. Draw j of the vertex v is dimension CAUS.DIM0 + CAUS.STRIDE · v + j (v = 0 the emission: 0 pick, 1–4 the point and
  // the direction; v ≥ 1: 0–1 the BSDF direction, 2 the lobe, 3 roulette, 4 the cut-out, 5 the dispersion channel).
  const EM = { pos: [0, 0, 0], dir: [0, 0, 0], alpha: [0, 0, 0], n: null }, PKR = { i: -1, prob: 0 }, CC = { px: 0, py: 0, dist: 0, dir: [0, 0, 0], w: 0 };
  const lbeta = [1, 1, 1], lro = [0, 0, 0], lrd = [0, 0, 0], lhit = { t: 0, slot: -1, inst: -1, u: 0, v: 0 }, latt = [1, 1, 1], lso = [0, 0, 0];
  let lkx = 0, lky = 0, lsi = 0;
  const dl = (v, j) => sample(mask, lkx, lky, lsi, CAUS.DIM0 + CAUS.STRIDE * v + j);
  /** One light path (index k of NL paths of sample s); `direct` = a test mode: connect the first vertex whatever came before, then stop. */
  function lightPath(k, s, accum, NL, direct) {
    lkx = k & 0xffff; lky = k >>> 16; lsi = s;
    CB.pick(dl(0, 0), PKR);
    if (!(PKR.prob > 0) || !LT.emit(PKR.i, dl(0, 1), dl(0, 2), dl(0, 3), dl(0, 4), EM)) return;
    for (let c = 0; c < 3; c++) { lbeta[c] = EM.alpha[c] / PKR.prob; lrd[c] = EM.dir[c]; }
    const e0 = 1e-4 * Math.max(1, Math.abs(EM.pos[0]), Math.abs(EM.pos[1]), Math.abs(EM.pos[2]));
    for (let c = 0; c < 3; c++) lro[c] = EM.pos[c] + (EM.n ? EM.n[c] * e0 : 0);
    if (!(lbeta[0] > 0 || lbeta[1] > 0 || lbeta[2] > 0)) return;
    let spec = 0, chanL = 0;
    for (let v = 1; v <= (direct ? 1 : maxB); v++) {
      if (!trace(lro, lrd, INF, lhit)) return;
      const sp = surface(lro, lrd, lhit, k, s, v), p = matAt(sp);
      const front = sp.ng[0] * lrd[0] + sp.ng[1] * lrd[1] + sp.ng[2] * lrd[2] < 0;
      const eps = 1e-4 * Math.max(1, Math.abs(sp.p[0]), Math.abs(sp.p[1]), Math.abs(sp.p[2]));
      if (!front && !p.thin && p.beer) for (let c = 0; c < 3; c++) lbeta[c] *= Math.exp(-p.mut[c] * lhit.t);
      if (p.opacity < 1 && dl(v, 4) >= p.opacity) {   // a cut-out: straight through
        const g = sp.ng[0] * lrd[0] + sp.ng[1] * lrd[1] + sp.ng[2] * lrd[2] >= 0 ? eps : -eps;
        for (let c = 0; c < 3; c++) lro[c] = sp.p[c] + sp.ng[c] * g;
        continue;
      }
      if (chanL === 0 && p.cauchyB > 0 && p.trans > 0 && !p.thin) {
        chanL = 1 + Math.min(2, Math.floor(dl(v, 5) * 3));
        for (let c = 0; c < 3; c++) lbeta[c] = c === chanL - 1 ? lbeta[c] * 3 : 0;
      }
      n[0] = sp.ns[0]; n[1] = sp.ns[1]; n[2] = sp.ns[2];
      if (n[0] * lrd[0] + n[1] * lrd[1] + n[2] * lrd[2] > 0) { n[0] = -n[0]; n[1] = -n[1]; n[2] = -n[2]; }
      basisInto(n, tB, bB);
      wo[0] = -lrd[0]; wo[1] = -lrd[1]; wo[2] = -lrd[2];
      local(wo, woL);
      if (woL[2] <= 0) woL[2] = 1e-6;
      // connect to the camera (the eye convention: wo = toward the camera, wi = back along the light's way)
      if ((spec > 0 || direct) && CB.connect(sp.p, CC)) {
        local(CC.dir, wiL);
        evalBsdf(p, front, chanL, wiL, woL, tmp);
        const fl = 1 / Math.max(1e-6, Math.abs(woL[2])), cosC = Math.abs(wiL[2]);
        if ((tmp[3] > 0 || tmp[4] > 0 || tmp[5] > 0) && cosC > 0) {
          const g = sp.ng[0] * CC.dir[0] + sp.ng[1] * CC.dir[1] + sp.ng[2] * CC.dir[2] >= 0 ? eps : -eps;
          for (let c = 0; c < 3; c++) lso[c] = sp.p[c] + sp.ng[c] * g;
          latt[0] = latt[1] = latt[2] = 1;
          if (transmit(lso, CC.dir, CC.dist - eps, latt)) {
            const o = (CC.py * w + CC.px) * 4, k0 = (CC.w * cosC * fl) / NL;
            for (let c = 0; c < 3; c++) accum[o + c] += lbeta[c] * tmp[3 + c] * latt[c] * k0;
          }
        }
      }
      if (direct) return;
      if (!sampleBsdf(p, front, chanL, woL, dl(v, 0), dl(v, 1), dl(v, 2), bs)) return;
      for (let c = 0; c < 3; c++) nd[c] = tB[c] * bs[0] + bB[c] * bs[1] + n[c] * bs[2];
      for (let c = 0; c < 3; c++) lbeta[c] *= bs[3 + c];
      const straight = bs[7] === 1 && p.thin && Math.abs(nd[0] + wo[0]) + Math.abs(nd[1] + wo[1]) + Math.abs(nd[2] + wo[2]) < 1e-6;
      if (!straight) { if (bs[7] === 1) spec++; else if (spec === 0) return; }   // a path whose first vertex scatters diffusely is the eye path's
      const g = sp.ng[0] * nd[0] + sp.ng[1] * nd[1] + sp.ng[2] * nd[2] >= 0 ? eps : -eps;
      for (let c = 0; c < 3; c++) { lro[c] = sp.p[c] + sp.ng[c] * g; lrd[c] = nd[c]; }
      if (v >= RR_START) {
        const q = Math.min(0.95, Math.max(0.05, Math.max(lbeta[0], lbeta[1], lbeta[2])));
        if (dl(v, 3) >= q) return;
        for (let c = 0; c < 3; c++) lbeta[c] /= q;
      }
      if (!(lbeta[0] > 0 || lbeta[1] > 0 || lbeta[2] > 0)) return;
    }
  }
  /** The light paths of sample s, added to accum (Σ rgb): `paths` of them (the data's own count by default). */
  function lightTrace({ s = 0, accum = null, paths = 0, direct = false } = {}) {
    if (!CB) return accum;
    accum = accum || new Float64Array(w * h * 4);
    const NL = paths || CB.paths;
    for (let k = 0; k < NL; k++) lightPath(k, s, accum, NL, direct);
    return accum;
  }

  /** accum: (Σ rgb, samples) per pixel; aux (RN.6, when the header asks for elements or groups): per pixel STRIDE vec4s —
   * elements summed per sample (ids written by sample 0), then each light group's Σ rgb. */
  function render({ spp = 1, s0 = 0, accum = null, aux = null, x0 = 0, y0 = 0, x1 = w, y1 = h, active = null } = {}) {   // active (RN.7, pt-adapt.js): 0 = this pixel gets no sample
    accum = accum || new Float64Array(w * h * 4);
    if (STRIDE) aux = aux || new Float64Array(w * h * STRIDE * 4);
    for (let s = s0; s < s0 + spp; s++) {
      for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
        if (active && !active[py * w + px]) continue;
        const c = radiance(px, py, s), o = (py * w + px) * 4;
        const fine = Number.isFinite(c[0]) && Number.isFinite(c[1]) && Number.isFinite(c[2]);
        if (fine) { accum[o] += Math.max(0, c[0]); accum[o + 1] += Math.max(0, c[1]); accum[o + 2] += Math.max(0, c[2]); }
        accum[o + 3] += 1;
        if (STRIDE && fine) {
          const b = (py * w + px) * STRIDE * 4;
          for (let i = 0; i < STRIDE * 4; i++) {
            if (lit && i >= EL.IDS * 4 && i < EL.IDS * 4 + 4) { if (s === 0) aux[b + i] = AX[i]; continue; }
            aux[b + i] += Number.isFinite(AX[i]) ? AX[i] : 0;
          }
        }
      }
    }
    return STRIDE ? Object.assign(accum, { aux }) : accum;
  }
  return { render, radiance, trace, transmit, lightTrace, suppressed: SUP, caustics: !!CB, w, h, counts: { tris: nTri, nodes: hu[3], instances: hu[62], lights: nLights }, R };
}

export function toBytes(accum, w, h, exposure = 0, wb = null) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const n = accum[i * 4 + 3] || 1;
    const px = displayPixel([accum[i * 4] / n, accum[i * 4 + 1] / n, accum[i * 4 + 2] / n], exposure, wb);
    out[i * 4] = px[0]; out[i * 4 + 1] = px[1]; out[i * 4 + 2] = px[2]; out[i * 4 + 3] = 255;
  }
  return out;
}
