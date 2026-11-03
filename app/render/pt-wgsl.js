/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: WGSL shader source and its bindings, never shown */
/**
 * pt-wgsl.js — the WGSL wavefront path tracer's kernels (0.7 RN.1; RENDER-SPEC § 8). A line-for-line port of pt-sampler.js,
 * pt-bsdf.js and pt-ref.js, cut into stages that each run as their own compute pass over a queue of paths:
 *
 *   gen       camera rays for one tile × one sample → queue 0 (and one more sample counted per pixel)
 *   argsB     indirect dispatch size for this bounce's queue; empties the next queue and the shadow queue
 *   isect     closest hit for every path in the queue (BVH layout 2, § 6.3: both levels in one loop) and the surface it is
 *             on: world normals, uv, material (an instance's own when it has one)
 *   shade     lamps / sky / sun with MIS, NEE (one shadow ray), BSDF sample → next queue (Russian roulette)
 *   argsS     indirect size of the shadow queue; next bounce
 *   shadow    the segment's transmittance (an opaque triangle blocks, smooth thin sheets multiply); → add to the pixel
 *   resolve   the display image from the accumulation buffer (§ 2)
 *
 * No DOM, no imports but pt-spec.js: `stageSource(stage)` returns one stage's WGSL (bindings it uses + the shared functions), so
 * every pipeline's bind group lists exactly what its stage reads (≤ 8 storage buffers; uniforms carry the header, the
 * blue-noise mask and the albedo tables; the lights are the `ldat` storage buffer, RN.3). Binding numbers are global (BIND), so the host builds bind groups from one table.
 */
import { DIMS, RR_START, MIN_ALPHA, R2_A, GOLD_A, LIGHT, MAT_FLAG, LIGHT_SCALE, LIGHT_FLOATS, HW, IES_THETA, IES_PHI, PORTAL_FLOATS, GROUND_OBJ, ELEMENT_COUNT, MAT_VEC4, MAPPING, TEXPROJ_DIM0 } from './pt-spec.js';
import { TABLE_LAYOUT, TABLE_FLOATS, N_SPEC, N_COND, N_FUZZ } from './pt-tables.js';
import { LAMBDA_NM } from './pt-ggx.js';
import { VOL } from './pt-volume.js';
import { CAUS } from './pt-caustic.js';

export const WG = 64;
export const PATH_BYTES = 128;    // 8 × vec4
export const SHADOW_BYTES = 96;   // 6 × vec4

export const BIND = Object.freeze({
  header: 0, pass: 1, bn: 2, lights: 3, tris: 4, nodes: 5, attrs: 6, mats: 7,
  rin: 8, rout: 9, shq: 10, accum: 11, counts: 12, args: 13, tex: 14, samp: 15, out: 16, view: 17, tab: 18, aux: 19, adp: 20, act: 21, adpar: 22, csp: 23, cq: 24,
});

/** Which bindings each stage declares (the host's bind groups follow this). */
export const STAGE_BINDINGS = Object.freeze({
  gen: ['header', 'pass', 'bn', 'rout', 'accum', 'counts', 'act'],
  argsB: ['counts', 'args'],
  isect: ['header', 'pass', 'rin', 'counts', 'tris', 'attrs', 'nodes', 'lights', 'mats', 'tex', 'samp'],   // MT.1: mats + tex for mapping and normal maps (7 storage buffers)
  shade: ['header', 'pass', 'bn', 'lights', 'tab', 'rin', 'rout', 'shq', 'accum', 'counts', 'mats', 'tex', 'samp', 'aux'],
  argsS: ['counts', 'args'],
  shadow: ['header', 'pass', 'shq', 'counts', 'tris', 'nodes', 'mats', 'accum', 'aux', 'lights'],
  resolve: ['header', 'view', 'accum', 'out'],
  adapt: ['pass', 'accum', 'counts', 'adp', 'act', 'adpar'],   // RN.7: adaptive sampling, after each pass of samples
  lgen: ['header', 'pass', 'lights', 'tab', 'mats', 'rout', 'counts'],   // RN.7: the light paths of a chunk into queue 0 (then isect traces them, as for the eye paths)
  lshade: ['header', 'pass', 'lights', 'tab', 'rin', 'rout', 'counts', 'mats', 'tex', 'samp', 'cq'],   // RN.7: a light path's vertex: its camera connection kept, the BSDF sample, the next ray
  cconn: ['header', 'pass', 'lights', 'tab', 'tris', 'nodes', 'mats', 'tex', 'samp', 'cq', 'csp'],       // RN.7: the kept connections: BSDF toward the camera, visibility, the splat
  cmerge: ['pass', 'accum', 'csp'],
});

const DECL = {
  header: 'var<uniform> H: array<vec4f, 32>;',
  pass: 'var<uniform> PS: Pass;',
  bn: 'var<uniform> BN: array<vec4u, 1024>;',
  lights: 'var<storage, read> LD: array<f32>;',
  tris: 'var<storage, read> TRI: array<vec4f>;',
  nodes: 'var<storage, read> NODE: array<vec4f>;',
  attrs: 'var<storage, read> ATTR: array<vec4f>;',
  mats: 'var<storage, read> MAT: array<vec4f>;',
  rin: null,   // per stage: isect writes hits into it
  rout: 'var<storage, read_write> ROUT: array<Path>;',
  shq: null,
  accum: 'var<storage, read_write> ACC: array<vec4f>;',
  counts: 'var<storage, read_write> CNT: array<atomic<u32>, 8>;',
  args: 'var<storage, read_write> ARGS: array<u32, 8>;',
  tex: 'var TEX: texture_2d_array<f32>;',
  samp: 'var SMP: sampler;',
  out: 'var<storage, read_write> OUT: array<u32>;',
  view: 'var<uniform> VW: array<vec4f, 2>;',   // (exposure, view transform 0 ACES 1 AgX 2 filmic 3 standard, contrast, highlights), (white-balance gains AP1, vignette)
  tab: `var<uniform> TAB: array<vec4f, ${Math.ceil(TABLE_FLOATS / 4)}>;`,
  aux: 'var<storage, read_write> AUX: array<vec4f>;',
  adp: 'var<storage, read_write> ADP: array<vec4f>;',   // RN.7: per pixel (S1, S2, Y before, N before) of the pass means (pt-adapt.js)
  act: 'var<storage, read_write> ACT: array<u32>;',     // 1 = the pixel is still sampled
  adpar: 'var<uniform> AD: vec4f;',
  cq: 'var<storage, read_write> CQ: array<CQrec>;',          // RN.7: a light path's camera connection, waiting for its visibility test
  csp: 'var<storage, read_write> CSP: array<atomic<u32>>;',   // RN.7: the light tracer's splats, fixed point (3 per pixel)                       // (noise, floor, first pass count, passes' sample count)   // RN.6: render elements, then light groups, per pixel
};

const STRUCTS = `
// a path in a queue: origin + pixel, direction + MIS pdf of the last BSDF sample, throughput + flags (depth | delta 256),
// the last non-delta vertex, and the surface the intersect stage found: (t, material bits | NONE = missed, u, v),
// the geometric and shading normals in world space
// RN.6: pp.w = the distance travelled from the camera; cat = (the first bounce's category ratio rgb, bits: bounces so far 0–7 |
// category 8–10 | guides recorded 11); ns.w = the hit's object (bits: instance index | 0x80000000, else the triangle's e1.w).
// A shadow ray carries its light group and where its light goes in the render elements: c.w bits = group 0–7 | direct split 8 |
// indirect element slot 9–12; e0..e2 = the diffuse / specular / transmission parts (direct), or e0 = the category's (indirect)
struct Path { o: vec4f, d: vec4f, beta: vec4f, pp: vec4f, hit: vec4f, ng: vec4f, ns: vec4f, cat: vec4f }
struct Shadow { o: vec4f, d: vec4f, c: vec4f, e0: vec4f, e1: vec4f, e2: vec4f }
struct Pass { x0: u32, y0: u32, tw: u32, th: u32, s: u32, w: u32, h: u32, pad: u32 }
// RN.7: a light-path vertex that connects to the camera: a = (point, flags: front 1 | channel << 1), b = (geometric normal, material),
// c = (shading normal, u), d = (the way the light was travelling, v), e = (the throughput, 1 = this slot is used). A path owns the
// slots path · maxBounces … + maxBounces − 1, one a vertex (no atomics: they hang SwiftShader's compiler inside the traversal loop)
struct CQrec { a: vec4f, b: vec4f, c: vec4f, d: vec4f, e: vec4f }
const PI = 3.14159265358979;
const INF = 1e30;
const NONE = 0x7f7fffffu;     // "no triangle" (bits of FLT_MAX: a NaN pattern cannot be a WGSL constant)
const NOLIGHT = 0xffffffffu;  // header words 11/59 when there is no sky / sun light
const MEDIUM = 0x7f7ffffeu;   // RN.7: a path's hit is a medium collision (hit.x = its distance; ng = the albedo, g)
`;

const MATH = `
fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn hash4(a: u32, b: u32, c: u32, d: u32) -> u32 { return pcg(a ^ pcg(b ^ pcg(c ^ pcg(d)))); }
fn basisE1(u: vec3f) -> vec3f {
  let ax = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(u.z) < 0.9);
  return normalize(cross(u, ax));
}
fn lum(c: vec3f) -> f32 { return 0.2722 * c.x + 0.6741 * c.y + 0.0537 * c.z; }
fn srgbToLinear(c: f32) -> f32 { return select(pow((c + 0.055) / 1.055, 2.4), c / 12.92, c <= 0.04045); }
`;

const SAMPLER = `
fn smp(px: u32, py: u32, s: u32, d: u32) -> f32 {
  if (d < ${DIMS.BN_LIMIT}u) {
    let q = d >> 2u;
    let ox = (13u * q) & 63u;
    let oy = (29u * q) & 63u;
    let idx = ((py + oy) & 63u) * 64u + ((px + ox) & 63u);
    let word = BN[idx >> 2u][idx & 3u];
    let bn = (word >> (8u * (d & 3u))) & 255u;
    let off = (bn << 24u) | (hash4(px, py, d, 0x5bd1e995u) & 0xffffffu);
    // pt-spec.js alphaFor: R2 pairs for the 2-D dimensions, the golden ratio for the 1-D ones
    var a = ${GOLD_A}u;
    if (d < 4u) { a = select(${R2_A[0]}u, ${R2_A[1]}u, (d & 1u) == 1u); }
    else if (d > 4u) { let r = (d - 5u) % ${DIMS.PER_BOUNCE}u; if (r == 0u || r == 4u) { a = ${R2_A[0]}u; } else if (r == 1u || r == 5u) { a = ${R2_A[1]}u; } }
    return f32((s * a + off) >> 8u) * (1.0 / 16777216.0);
  }
  return f32(hash4(px, py, s, d) >> 8u) * (1.0 / 16777216.0);
}
`;

const TRAVERSE = `
// RENDER-SPEC § 6.3 layout 2: 16-word records (4 × vec4): wide nodes (TLAS first, then each BLAS), then the instance
// records from record H[0].w (the node count). The stack holds (node, instance slot | NOINST, entry t); a TLAS leaf pushes its
// instances' BLAS roots, so both levels run in one loop. mode 'closest' keeps the nearest hit; 'transmit' visits every
// triangle on the segment (an opaque one ends it, smooth thin sheets multiply att), so no order is needed.
const NOINST = 0xffffffffu;
var<private> STN: array<u32, 64>;
var<private> STI: array<u32, 64>;
var<private> STT: array<f32, 64>;
fn safeInv(d: vec3f) -> vec3f { return 1.0 / select(d, vec3f(1e-30), d == vec3f(0.0)); }
fn instBase(s: u32) -> u32 { return (bitcast<u32>(H[0].w) + s) * 4u; }
fn instMat(slot: u32, ins: u32) -> u32 {
  if (ins != NOINST) { let ov = bitcast<u32>(NODE[instBase(ins) + 3u].w); if (ov != 0xffffffffu) { return ov; } }
  return bitcast<u32>(TRI[slot * 3u].w);
}
`;
const TRACE_CLOSEST = `
struct THit { t: f32, slot: u32, inst: u32, u: f32, v: f32 }
fn traceClosest(o: vec3f, d: vec3f, tmaxIn: f32) -> THit {
  var best = tmaxIn;
  var hs = NONE; var hi = NOINST; var hu = 0.0; var hv = 0.0;
  let two = bitcast<u32>(H[15].z) > 0u;
  var sp = 1u;
  STN[0] = 0u; STI[0] = NOINST; STT[0] = 0.0;
  var cur = NOINST;
  var lo = o;
  var ld = d;
  var id = safeInv(d);
  loop {
    if (sp == 0u) { break; }
    sp -= 1u;
    if (STT[sp] > best) { continue; }
    let node = STN[sp];
    let ins = STI[sp];
    if (ins != cur) {
      cur = ins;
      if (ins == NOINST) { lo = o; ld = d; }
      else {
        let b = instBase(ins);
        let r0 = NODE[b]; let r1 = NODE[b + 1u]; let r2 = NODE[b + 2u];
        lo = vec3f(dot(r0.xyz, o) + r0.w, dot(r1.xyz, o) + r1.w, dot(r2.xyz, o) + r2.w);
        ld = vec3f(dot(r0.xyz, d), dot(r1.xyz, d), dot(r2.xyz, d));
      }
      id = safeInv(ld);
    }
    let n0 = NODE[node * 4u];
    let n1 = bitcast<vec4u>(NODE[node * 4u + 1u]);
    let qa = bitcast<vec4u>(NODE[node * 4u + 2u]);
    let qb = bitcast<vec4u>(NODE[node * 4u + 3u]);
    let e = bitcast<u32>(n0.w);
    let mask = e >> 24u;
    let sc = vec3f(bitcast<f32>((e & 255u) << 23u), bitcast<f32>(((e >> 8u) & 255u) << 23u), bitcast<f32>(((e >> 16u) & 255u) << 23u));
    var ci = n1.x;
    var slot = n1.y;
    let counts = n1.z;
    // the nearer inner children are pushed last (popped first)
    var kt = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
    var kn = array<u32, 4>(0u, 0u, 0u, 0u);
    var nk = 0u;
    for (var i = 0u; i < 4u; i++) {
      let sh = 8u * i;
      let inner = ((mask >> i) & 1u) == 1u;
      let c = (counts >> sh) & 255u;
      if (!inner && c == 0u) { continue; }
      let bmin = n0.xyz + vec3f(f32((qa.x >> sh) & 255u), f32((qa.y >> sh) & 255u), f32((qa.z >> sh) & 255u)) * sc;
      let bmax = n0.xyz + vec3f(f32((qa.w >> sh) & 255u), f32((qb.x >> sh) & 255u), f32((qb.y >> sh) & 255u)) * sc;
      let t0 = (bmin - lo) * id;
      let t1 = (bmax - lo) * id;
      let tn = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
      let tf = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z)) * 1.0000004;
      let hit = tn <= tf && tf >= 0.0 && tn <= best;
      if (inner) {
        if (hit) {
          var j = nk;
          let te = max(tn, 0.0);
          loop { if (j == 0u || kt[j - 1u] >= te) { break; } kt[j] = kt[j - 1u]; kn[j] = kn[j - 1u]; j -= 1u; }
          kt[j] = te; kn[j] = ci; nk += 1u;
        }
        ci += 1u;
      } else {
        if (hit) {
          if (two && cur == NOINST) {
            // TLAS leaf: its instances' BLAS roots
            for (var s = slot; s < slot + c; s++) {
              if (sp < 64u) { STN[sp] = bitcast<u32>(NODE[instBase(s) + 3u].x); STI[sp] = s; STT[sp] = max(tn, 0.0); sp += 1u; }
            }
          } else {
        for (var j = slot; j < slot + c; j++) {
          let v0 = TRI[j * 3u].xyz;
          let e1 = TRI[j * 3u + 1u].xyz;
          let e2 = TRI[j * 3u + 2u].xyz;
          let pv = cross(ld, e2);
          let det = dot(e1, pv);
          if (abs(det) < 1e-12) { continue; }
          let inv = 1.0 / det;
          let tv = lo - v0;
          let u = dot(tv, pv) * inv;
          if (u < 0.0 || u > 1.0) { continue; }
          let q = cross(tv, e1);
          let v = dot(ld, q) * inv;
          if (v < 0.0 || u + v > 1.0) { continue; }
          let t = dot(e2, q) * inv;
          if (!(t > 0.0 && t < best)) { continue; }
          best = t; hs = j; hi = cur; hu = u; hv = v;
        }
          }
        }
        slot += c;
      }
    }
    for (var i = 0u; i < nk; i++) { if (sp < 64u) { STN[sp] = kn[i]; STI[sp] = cur; STT[sp] = kt[i]; sp += 1u; } }
  }
  return THit(best, hs, hi, hu, hv);
}
`;
const TRACE_TRANSMIT = `
fn traceTransmit(o: vec3f, d: vec3f, tmaxIn: f32) -> vec4f {
  var best = tmaxIn;
  var att = vec3f(1.0);
  let two = bitcast<u32>(H[15].z) > 0u;
  var sp = 1u;
  STN[0] = 0u; STI[0] = NOINST; STT[0] = 0.0;
  var cur = NOINST;
  var lo = o;
  var ld = d;
  var id = safeInv(d);
  loop {
    if (sp == 0u) { break; }
    sp -= 1u;
    if (STT[sp] > best) { continue; }
    let node = STN[sp];
    let ins = STI[sp];
    if (ins != cur) {
      cur = ins;
      if (ins == NOINST) { lo = o; ld = d; }
      else {
        let b = instBase(ins);
        let r0 = NODE[b]; let r1 = NODE[b + 1u]; let r2 = NODE[b + 2u];
        lo = vec3f(dot(r0.xyz, o) + r0.w, dot(r1.xyz, o) + r1.w, dot(r2.xyz, o) + r2.w);
        ld = vec3f(dot(r0.xyz, d), dot(r1.xyz, d), dot(r2.xyz, d));
      }
      id = safeInv(ld);
    }
    let n0 = NODE[node * 4u];
    let n1 = bitcast<vec4u>(NODE[node * 4u + 1u]);
    let qa = bitcast<vec4u>(NODE[node * 4u + 2u]);
    let qb = bitcast<vec4u>(NODE[node * 4u + 3u]);
    let e = bitcast<u32>(n0.w);
    let mask = e >> 24u;
    let sc = vec3f(bitcast<f32>((e & 255u) << 23u), bitcast<f32>(((e >> 8u) & 255u) << 23u), bitcast<f32>(((e >> 16u) & 255u) << 23u));
    var ci = n1.x;
    var slot = n1.y;
    let counts = n1.z;
    // the nearer inner children are pushed last (popped first)
    var kt = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
    var kn = array<u32, 4>(0u, 0u, 0u, 0u);
    var nk = 0u;
    for (var i = 0u; i < 4u; i++) {
      let sh = 8u * i;
      let inner = ((mask >> i) & 1u) == 1u;
      let c = (counts >> sh) & 255u;
      if (!inner && c == 0u) { continue; }
      let bmin = n0.xyz + vec3f(f32((qa.x >> sh) & 255u), f32((qa.y >> sh) & 255u), f32((qa.z >> sh) & 255u)) * sc;
      let bmax = n0.xyz + vec3f(f32((qa.w >> sh) & 255u), f32((qb.x >> sh) & 255u), f32((qb.y >> sh) & 255u)) * sc;
      let t0 = (bmin - lo) * id;
      let t1 = (bmax - lo) * id;
      let tn = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
      let tf = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z)) * 1.0000004;
      let hit = tn <= tf && tf >= 0.0 && tn <= best;
      if (inner) {
        if (hit) {
          var j = nk;
          let te = max(tn, 0.0);
          loop { if (j == 0u || kt[j - 1u] >= te) { break; } kt[j] = kt[j - 1u]; kn[j] = kn[j - 1u]; j -= 1u; }
          kt[j] = te; kn[j] = ci; nk += 1u;
        }
        ci += 1u;
      } else {
        if (hit) {
          if (two && cur == NOINST) {
            // TLAS leaf: its instances' BLAS roots
            for (var s = slot; s < slot + c; s++) {
              if (sp < 64u) { STN[sp] = bitcast<u32>(NODE[instBase(s) + 3u].x); STI[sp] = s; STT[sp] = max(tn, 0.0); sp += 1u; }
            }
          } else {
        for (var j = slot; j < slot + c; j++) {
          let v0 = TRI[j * 3u].xyz;
          let e1 = TRI[j * 3u + 1u].xyz;
          let e2 = TRI[j * 3u + 2u].xyz;
          let pv = cross(ld, e2);
          let det = dot(e1, pv);
          if (abs(det) < 1e-12) { continue; }
          let inv = 1.0 / det;
          let tv = lo - v0;
          let u = dot(tv, pv) * inv;
          if (u < 0.0 || u > 1.0) { continue; }
          let q = cross(tv, e1);
          let v = dot(ld, q) * inv;
          if (v < 0.0 || u + v > 1.0) { continue; }
          let t = dot(e2, q) * inv;
          if (!(t > 0.0 && t < best)) { continue; }
          let m = instMat(j, cur);
          let p = matParams(m);
          // OpenPBR's transparent shadow: lerp(1, (1 − M)·T_sheet, opacity), T_sheet only for a smooth thin transmissive sheet
          let sheet = p.thin && p.trans > 0.0 && isSmooth(p);
          if (!sheet && p.opacity >= 1.0) { return vec4f(0.0, 0.0, 0.0, -1.0); }
          var kk = 0.0;
          if (sheet) {
            let ng = cross(e1, e2);
            let cosT = abs(dot(ng, ld)) / max(1e-30, length(ng) * length(ld));
            kk = (1.0 - p.metal) * p.trans * (1.0 - thinR(frDielectric(cosT, p.eta)));
          }
          att = att * (vec3f(1.0 - p.opacity) + p.opacity * kk * select(vec3f(0.0), p.tcol, sheet));
          if (!any(att > vec3f(0.0))) { return vec4f(0.0, 0.0, 0.0, -1.0); }
        }
          }
        }
        slot += c;
      }
    }
    for (var i = 0u; i < nk; i++) { if (sp < 64u) { STN[sp] = kn[i]; STI[sp] = cur; STT[sp] = kt[i]; sp += 1u; } }
  }
  return vec4f(att, 1.0);
}
`;


// ---- RN.2: the OpenPBR model (pt-ggx.js, pt-tables.js, pt-bsdf.js, line for line) ----
const BSDF_CORE = `
struct Mat {
  base: vec3f, spec: vec3f, tcol: vec3f, emis: vec3f, coatCol: vec3f, fuzzCol: vec3f, sssCol: vec3f, extinct: vec3f,
  sw: f32, rough: f32, ior: f32, metal: f32, trans: f32, flags: u32, thin: bool, diffRough: f32,
  coat: f32, coatRough: f32, coatIor: f32, coatDark: f32, aniso: f32,
  fuzz: f32, fuzzRough: f32, film: f32, filmUm: f32, filmIor: f32,
  sss: f32, sssG: f32, opacity: f32, coatAniso: f32, eta: f32, coatEF: f32, cauchyB: f32, beer: bool,
}
fn matParams(m: u32) -> Mat {
  let o = m * ${MAT_VEC4}u;
  let v0 = MAT[o]; let v1 = MAT[o + 1u]; let v2 = MAT[o + 2u]; let v3 = MAT[o + 3u]; let v4 = MAT[o + 4u]; let v5 = MAT[o + 5u];
  let v6 = MAT[o + 6u]; let v7 = MAT[o + 7u]; let v8 = MAT[o + 8u]; let v9 = MAT[o + 9u]; let v10 = MAT[o + 10u];
  let v13 = MAT[o + 13u]; let v14 = MAT[o + 14u]; let v15 = MAT[o + 15u];
  let fl = u32(v3.w);
  let mut3 = v15.xyz;
  return Mat(v0.xyz * v0.w, v1.xyz, v3.xyz, v5.xyz * v5.w, v6.xyz, v8.xyz, v10.xyz, mut3,
    v1.w, clamp(v2.x, 0.0, 1.0), max(1.0001, v2.y), clamp(v2.z, 0.0, 1.0), clamp(v2.w, 0.0, 1.0), fl, (fl & ${MAT_FLAG.THIN}u) != 0u, clamp(v4.w, 0.0, 1.0),
    clamp(v6.w, 0.0, 1.0), clamp(v7.x, 0.0, 1.0), max(1.0001, v7.y), clamp(v7.z, 0.0, 1.0), clamp(v7.w, 0.0, 1.0),
    clamp(v8.w, 0.0, 1.0), clamp(v9.x, 0.0, 1.0), clamp(v9.y, 0.0, 1.0), max(0.0, v9.z), max(1.0001, v9.w),
    clamp(v10.w, 0.0, 1.0), clamp(v13.w, -1.0, 1.0), clamp(v14.x, 0.0, 1.0), clamp(v14.y, 0.0, 1.0), select(v2.y, max(1e-4, v14.z), v14.z > 0.0), v14.w, v15.w,
    any(mut3 > vec3f(0.0)));
}
fn frDielectric(cosI: f32, etaIn: f32) -> f32 {
  var c = clamp(cosI, -1.0, 1.0);
  var eta = etaIn;
  if (c < 0.0) { eta = 1.0 / eta; c = -c; }
  let t2 = (1.0 - c * c) / (eta * eta);
  if (t2 >= 1.0) { return 1.0; }
  let ct = sqrt(1.0 - t2);
  let rpa = (eta * c - ct) / (eta * c + ct);
  let rpe = (c - eta * ct) / (c + eta * ct);
  return (rpa * rpa + rpe * rpe) / 2.0;
}
fn thinR(F: f32) -> f32 { return 2.0 * F / (1.0 + F); }
fn anisoAlphas(rough: f32, aniso: f32) -> vec2f {
  let r2 = clamp(rough, 0.0, 1.0) * clamp(rough, 0.0, 1.0);
  let a = clamp(aniso, 0.0, 1.0);
  if (a == 0.0) { return vec2f(r2, r2); }
  let at = min(1.0, r2 * sqrt(2.0 / (1.0 + (1.0 - a) * (1.0 - a))));
  return vec2f(at, (1.0 - a) * at);
}
// the base's specular roughness after a rough coat (OpenPBR)
fn specRough(p: Mat) -> f32 {
  let rB = p.rough; let rC = p.coatRough;
  if (p.coat > 0.0) { return rB + (min(1.0, pow(rB * rB * rB * rB + 2.0 * rC * rC * rC * rC, 0.25)) - rB) * p.coat; }
  return rB;
}
fn isSmooth(p: Mat) -> bool { let a = anisoAlphas(specRough(p), p.aniso); return max(a.x, a.y) < ${MIN_ALPHA}; }
`;

const BSDF = `
fn schlick1(f0: f32, c: f32) -> f32 { return f0 + (1.0 - f0) * pow(1.0 - clamp(c, 0.0, 1.0), 5.0); }
const MU_BAR = 0.142857142857;
const F82_K = 0.056652548;   // μ̄ (1 − μ̄)⁶
fn f82(f0: vec3f, tint: vec3f, cIn: f32) -> vec3f {
  let c = clamp(cIn, 0.0, 1.0);
  let fs = f0 + (vec3f(1.0) - f0) * pow(1.0 - c, 5.0);
  let fb = f0 + (vec3f(1.0) - f0) * pow(1.0 - MU_BAR, 5.0);
  return max(vec3f(0.0), fs - (c * pow(1.0 - c, 6.0) / F82_K) * (fb - tint * fb));
}
fn f82Avg(f0: vec3f, tint: vec3f) -> vec3f {
  let fb = f0 + (vec3f(1.0) - f0) * pow(1.0 - MU_BAR, 5.0);
  return max(vec3f(0.0), f0 + (vec3f(1.0) - f0) / 21.0 - (1.0 / 126.0 / F82_K) * (fb - tint * fb));
}
fn thinFilm(cos1: f32, eta1: f32, etaF: f32, eta3: f32, dUm: f32, lambdaNm: f32, metalR: f32) -> f32 {
  let c1 = clamp(cos1, 0.0, 1.0);
  let s1 = 1.0 - c1 * c1;
  let s2 = eta1 * eta1 * s1 / (etaF * etaF);
  if (s2 >= 1.0) { return 1.0; }
  let c2 = sqrt(1.0 - s2);
  let r12s = (eta1 * c1 - etaF * c2) / (eta1 * c1 + etaF * c2);
  let r12p = (etaF * c1 - eta1 * c2) / (etaF * c1 + eta1 * c2);
  var r23s = 1.0; var r23p = 1.0;
  if (metalR >= 0.0) { r23s = -sqrt(min(1.0, metalR)); r23p = r23s; }
  else {
    let s3 = eta1 * eta1 * s1 / (eta3 * eta3);
    if (s3 < 1.0) {
      let c3 = sqrt(1.0 - s3);
      r23s = (etaF * c2 - eta3 * c3) / (etaF * c2 + eta3 * c3);
      r23p = (eta3 * c2 - etaF * c3) / (eta3 * c2 + etaF * c3);
    }
  }
  let cp = cos(4.0 * PI / lambdaNm * etaF * dUm * 1000.0 * c2);
  let Rs = (r12s * r12s + r23s * r23s + 2.0 * r12s * r23s * cp) / (1.0 + r12s * r12s * r23s * r23s + 2.0 * r12s * r23s * cp);
  let Rp = (r12p * r12p + r23p * r23p + 2.0 * r12p * r23p * cp) / (1.0 + r12p * r12p * r23p * r23p + 2.0 * r12p * r23p * cp);
  return clamp((Rs + Rp) / 2.0, 0.0, 1.0);
}
fn ggxD(m: vec3f, ax: f32, ay: f32) -> f32 {
  if (m.z <= 0.0) { return 0.0; }
  let x = m.x / ax; let y = m.y / ay;
  let d = x * x + y * y + m.z * m.z;
  return 1.0 / (PI * ax * ay * d * d);
}
fn ggxLambda(w: vec3f, ax: f32, ay: f32) -> f32 {
  let c2 = w.z * w.z;
  if (c2 <= 0.0) { return 1e9; }
  return (sqrt(1.0 + (ax * ax * w.x * w.x + ay * ay * w.y * w.y) / c2) - 1.0) / 2.0;
}
fn ggxG1(w: vec3f, ax: f32, ay: f32) -> f32 { return 1.0 / (1.0 + ggxLambda(w, ax, ay)); }
fn ggxG2(wo: vec3f, wi: vec3f, ax: f32, ay: f32) -> f32 { return 1.0 / (1.0 + ggxLambda(wo, ax, ay) + ggxLambda(wi, ax, ay)); }
fn ggxDv(wo: vec3f, m: vec3f, ax: f32, ay: f32) -> f32 { return ggxG1(wo, ax, ay) / max(1e-12, abs(wo.z)) * ggxD(m, ax, ay) * abs(dot(wo, m)); }
fn sampleVNDF(wo: vec3f, ax: f32, ay: f32, u1: f32, u2: f32) -> vec3f {
  let h = normalize(vec3f(ax * wo.x, ay * wo.y, wo.z));
  var t1 = vec3f(1.0, 0.0, 0.0);
  if (h.z < 0.99999) { let l = max(1e-20, length(h.xy)); t1 = vec3f(-h.y / l, h.x / l, 0.0); }
  let t2 = cross(h, t1);
  let r = sqrt(u1);
  let phi = 2.0 * PI * u2;
  let p1 = r * cos(phi);
  let s = 0.5 * (1.0 + h.z);
  let p2 = (1.0 - s) * sqrt(max(0.0, 1.0 - p1 * p1)) + s * r * sin(phi);
  let p3 = sqrt(max(0.0, 1.0 - p1 * p1 - p2 * p2));
  let n = p1 * t1 + p2 * t2 + p3 * h;
  return normalize(vec3f(ax * n.x, ay * n.y, max(1e-6, n.z)));
}
fn refr(wo: vec3f, m: vec3f, eta: f32) -> vec4f {
  let c = dot(wo, m);
  let t2 = max(0.0, 1.0 - c * c) / (eta * eta);
  if (t2 >= 1.0) { return vec4f(0.0); }
  let ct = sqrt(1.0 - t2);
  return vec4f(-wo / eta + (c / eta - ct) * m, 1.0);
}
fn charlieD(cosM: f32, rough: f32) -> f32 {
  let a = max(0.07, rough);
  let inv = 1.0 / a;
  let s2 = max(0.0, 1.0 - cosM * cosM);
  return (2.0 + inv) * pow(s2, inv * 0.5) / (2.0 * PI);
}
fn charlieV(nl: f32, nv: f32) -> f32 { return 1.0 / (4.0 * max(1e-6, nl + nv - nl * nv)); }
const EON_C1 = ${0.5 - 2 / (3 * Math.PI)};
const EON_C2 = ${2 / 3 - 28 / (15 * Math.PI)};
fn eonAlbedo(mu: f32, r: f32) -> f32 {
  let m = 1.0 - clamp(mu, 0.0, 1.0);
  let g = m * (0.0571085289 + m * (0.491881867 + m * (-0.332181442 + m * 0.0714429953)));
  return (1.0 + r * g) / (1.0 + EON_C1 * r);
}
fn eonEval(rho: vec3f, r: f32, wo: vec3f, wi: vec3f) -> vec3f {
  let mo = wo.z; let mi = wi.z;
  if (mo <= 0.0 || mi <= 0.0) { return vec3f(0.0); }
  let AF = 1.0 / (1.0 + EON_C1 * r);
  let s = dot(wo, wi) - mo * mi;
  let sOverT = select(s, s / max(mo, mi), s > 0.0);
  let fss = rho / PI * AF * (1.0 + r * sOverT);
  if (!(r > 0.0)) { return fss; }
  let avg = AF * (1.0 + EON_C2 * r);
  let rhoMs = rho * rho * avg / (vec3f(1.0) - rho * (1.0 - avg));
  let k = max(1e-7, 1.0 - eonAlbedo(mo, r)) * max(1e-7, 1.0 - eonAlbedo(mi, r)) / max(1e-7, 1.0 - avg);
  return fss + rhoMs / PI * k;
}
// albedo tables (pt-tables.js): grid points with the end points included
fn tabAt(i: u32) -> f32 { return TAB[i >> 2u][i & 3u]; }
fn cellAx(x: f32, n: u32, lo: f32, hi: f32) -> vec3f {
  let f = clamp((x - lo) / (hi - lo) * f32(n - 1u), 0.0, f32(n - 1u));
  let i0 = floor(f);
  return vec3f(i0, min(f32(n - 1u), i0 + 1.0), f - i0);
}
fn lookup2(off: u32, n: u32, mu: f32, rough: f32) -> f32 {
  let a = cellAx(mu, n, 0.0, 1.0); let b = cellAx(rough, n, 0.0, 1.0);
  let a0 = u32(a.x); let a1 = u32(a.y); let b0 = u32(b.x); let b1 = u32(b.y);
  let l0 = tabAt(off + b0 * n + a0) * (1.0 - a.z) + tabAt(off + b0 * n + a1) * a.z;
  let l1 = tabAt(off + b1 * n + a0) * (1.0 - a.z) + tabAt(off + b1 * n + a1) * a.z;
  return l0 * (1.0 - b.z) + l1 * b.z;
}
fn lookupSpec(mu: f32, rough: f32, eta: f32) -> f32 {
  let n = ${N_SPEC}u;
  let c = cellAx(eta, n, 1.0, 3.0);
  let k0 = u32(c.x); let k1 = u32(c.y);
  return lookup2(${TABLE_LAYOUT.spec.offset}u + k0 * n * n, n, mu, rough) * (1.0 - c.z) + lookup2(${TABLE_LAYOUT.spec.offset}u + k1 * n * n, n, mu, rough) * c.z;
}
fn lookupCond(mu: f32, rough: f32) -> f32 { return lookup2(${TABLE_LAYOUT.cond.offset}u, ${N_COND}u, mu, rough); }
fn lookupFuzz(mu: f32, rough: f32) -> f32 { return lookup2(${TABLE_LAYOUT.fuzz.offset}u, ${N_FUZZ}u, mu, rough); }
fn lookupCondAvg(rough: f32) -> f32 {
  let b = cellAx(rough, ${N_COND}u, 0.0, 1.0);
  return tabAt(${TABLE_LAYOUT.condAvg.offset}u + u32(b.x)) * (1.0 - b.z) + tabAt(${TABLE_LAYOUT.condAvg.offset}u + u32(b.y)) * b.z;
}
fn etaFor(p: Mat, front: bool, chan: u32) -> f32 {
  var e = p.eta;
  if (chan > 0u && p.cauchyB > 0.0) {
    let l = select(select(${LAMBDA_NM[2] / 1000}, ${LAMBDA_NM[1] / 1000}, chan == 2u), ${LAMBDA_NM[0] / 1000}, chan == 1u);
    e = max(1.0001, e - p.cauchyB / (0.5876 * 0.5876) + p.cauchyB / (l * l));
  }
  return select(1.0 / e, e, front);
}
fn coatPass(p: Mat, mu: f32) -> vec3f {
  let mt = sqrt(max(1e-4, 1.0 - max(0.0, 1.0 - mu * mu) / (p.coatIor * p.coatIor)));
  return pow(max(vec3f(1e-6), sqrt(max(vec3f(0.0), p.coatCol))), vec3f(1.0 / mt));
}
fn insideOf(p: Mat, front: bool) -> bool { return !front && !p.thin && p.trans > 0.0; }
struct Wt { eFuzz: f32, topF: f32, eCoat: f32, dark: f32, eSpec: f32, eCond: f32, condAvg: f32, rSpec: f32,
  ax: f32, ay: f32, cax: f32, cay: f32, eta: f32, etaBase: f32, fAvg: vec3f, fms: vec3f, pr: array<f32, 9> }
const K_FUZZ = 0u; const K_COAT = 1u; const K_METAL = 2u; const K_METAL_MS = 3u; const K_SPEC = 4u; const K_DIFF = 5u; const K_SSS = 6u; const K_SSS_T = 7u; const K_GLASS = 8u;
fn weigh(p: Mat, front: bool, chan: u32, woz: f32) -> Wt {
  var W: Wt;
  let mu = max(1e-4, woz);
  W.eFuzz = select(0.0, lookupFuzz(mu, p.fuzzRough), p.fuzz > 0.0);
  W.topF = 1.0 - p.fuzz * W.eFuzz;
  W.eCoat = select(0.0, lookupSpec(mu, p.coatRough, p.coatIor), p.coat > 0.0);
  let ca = anisoAlphas(p.coatRough, p.coatAniso); W.cax = ca.x; W.cay = ca.y;
  W.rSpec = specRough(p);
  let sa = anisoAlphas(W.rSpec, p.aniso); W.ax = sa.x; W.ay = sa.y;
  W.etaBase = etaFor(p, true, chan);
  W.eta = etaFor(p, front, chan);
  W.eSpec = lookupSpec(mu, W.rSpec, max(1.0001, W.etaBase));
  W.eCond = lookupCond(mu, W.rSpec);
  W.condAvg = lookupCondAvg(W.rSpec);
  W.fAvg = p.sw * f82Avg(p.base, p.spec);
  W.fms = W.fAvg * W.fAvg * W.condAvg / max(vec3f(1e-6), vec3f(1.0) - W.fAvg * (1.0 - W.condAvg));
  W.dark = 1.0;
  if (p.coat > 0.0 && p.coatDark > 0.0) {
    let F0s = (W.etaBase - 1.0) / (W.etaBase + 1.0) * (W.etaBase - 1.0) / (W.etaBase + 1.0);
    let xiF = min(1.0, p.sw * F0s);
    let rb = (1.0 + (p.rough - 1.0) * xiF) * (1.0 - p.metal) + p.rough * p.metal;
    let Ks = frDielectric(mu, p.coatIor);
    let Kr = 1.0 - (1.0 - p.coatEF) / (p.coatIor * p.coatIor);
    let Kk = Ks + (Kr - Ks) * rb;
    let Ediel = (1.0 - p.trans) * (F0s + (1.0 - F0s) * ((1.0 - p.sss) * lum(p.base) + p.sss * lum(p.sssCol))) + p.trans * F0s;
    let Eb = Ediel * (1.0 - p.metal) + p.metal * lum(p.base) * p.sw;
    let delta = (1.0 - Kk) / max(1e-6, 1.0 - Eb * Kk);
    W.dark = 1.0 + (delta - 1.0) * p.coat * p.coatDark;
  }
  let tco = coatPass(p, mu) * coatPass(p, mu);
  let bw = W.topF * ((1.0 - p.coat) + p.coat * lum(tco) * (1.0 - W.eCoat)) * W.dark;
  let diel = (1.0 - p.metal) * bw;
  let opaque = diel * (1.0 - p.trans);
  let rest = opaque * (1.0 - W.eSpec);
  W.pr[K_FUZZ] = p.fuzz * W.eFuzz * max(0.05, lum(p.fuzzCol));
  W.pr[K_COAT] = W.topF * p.coat * W.eCoat;
  W.pr[K_METAL] = p.metal * bw * W.eCond * max(0.05, lum(W.fAvg));
  W.pr[K_METAL_MS] = p.metal * bw * (1.0 - W.eCond) * lum(W.fms);
  W.pr[K_SPEC] = opaque * W.eSpec * max(0.05, lum(p.spec));
  W.pr[K_DIFF] = rest * (1.0 - p.sss) * max(0.02, lum(p.base));
  let sssL = rest * p.sss * max(0.02, lum(p.sssCol));
  W.pr[K_SSS] = select(sssL, sssL * (1.0 - p.sssG) / 2.0, p.thin);
  W.pr[K_SSS_T] = select(0.0, sssL * (1.0 + p.sssG) / 2.0, p.thin);
  W.pr[K_GLASS] = diel * p.trans;
  if (insideOf(p, front)) { for (var i = 0u; i < 9u; i++) { W.pr[i] = 0.0; } W.pr[K_GLASS] = 1.0; }
  var sum = 0.0;
  for (var i = 0u; i < 9u; i++) { sum += W.pr[i]; }
  if (sum > 0.0) { for (var i = 0u; i < 9u; i++) { W.pr[i] = W.pr[i] / sum; } }
  return W;
}
fn specF(p: Mat, W: Wt, c: f32) -> vec3f {
  let F = frDielectric(c, W.etaBase);
  if (p.film <= 0.0) { return vec3f(F); }
  let tf = vec3f(thinFilm(c, 1.0, p.filmIor, W.etaBase, p.filmUm, ${LAMBDA_NM[0]}.0, -1.0), thinFilm(c, 1.0, p.filmIor, W.etaBase, p.filmUm, ${LAMBDA_NM[1]}.0, -1.0), thinFilm(c, 1.0, p.filmIor, W.etaBase, p.filmUm, ${LAMBDA_NM[2]}.0, -1.0));
  return vec3f(F) + (tf - vec3f(F)) * p.film;
}
fn metalF(p: Mat, c: f32) -> vec3f {
  let F = p.sw * f82(p.base, p.spec, c);
  if (p.film <= 0.0) { return F; }
  let tf = vec3f(thinFilm(c, 1.0, p.filmIor, 1.0, p.filmUm, ${LAMBDA_NM[0]}.0, F.x), thinFilm(c, 1.0, p.filmIor, 1.0, p.filmUm, ${LAMBDA_NM[1]}.0, F.y), thinFilm(c, 1.0, p.filmIor, 1.0, p.filmUm, ${LAMBDA_NM[2]}.0, F.z));
  return F + (tf - F) * p.film;
}
fn baseFac(p: Mat, W: Wt, inside: bool, muo: f32, mui: f32) -> vec3f {
  if (inside) { return vec3f(1.0); }
  let tc = coatPass(p, muo) * coatPass(p, mui);
  return W.topF * ((1.0 - p.coat) + p.coat * tc * (1.0 - W.eCoat)) * W.dark;
}
// f·|cos θi| (rgb) and the non-delta mixture pdf (w)
fn evalBsdf(p: Mat, front: bool, chan: u32, wo: vec3f, wi: vec3f) -> vec4f { return evalBsdfM(p, front, chan, wo, wi, 7u); }
// RN.6: mask = which lobes add to f (1 diffuse: fuzz, diffuse, subsurface; 2 specular: coat, metal, specular, the glass's
// reflection; 4 transmission); the pdf is always the whole mixture's (pt-bsdf.js evalBsdf's mask)
fn evalBsdfM(p: Mat, front: bool, chan: u32, wo: vec3f, wi: vec3f, mask: u32) -> vec4f {
  let mD = select(0.0, 1.0, (mask & 1u) != 0u);
  let mS = select(0.0, 1.0, (mask & 2u) != 0u);
  let mT = select(0.0, 1.0, (mask & 4u) != 0u);
  let co = wo.z; let ci = wi.z;
  if (co <= 0.0 || ci == 0.0) { return vec4f(0.0); }
  let W = weigh(p, front, chan, co);
  let inside = insideOf(p, front);
  let acos = abs(ci);
  let bfc = baseFac(p, W, inside, co, acos);
  let wT = select((1.0 - p.metal) * p.trans, 1.0, inside);
  var f = vec3f(0.0);
  var pdf = 0.0;
  if (ci > 0.0) {
    let hs = wo + wi;
    let hl = length(hs);
    if (hl > 0.0) {
      let h = hs / hl;
      let odm = dot(wo, h);
      if (!inside && p.fuzz > 0.0) { f += mD * p.fuzz * charlieD(h.z, p.fuzzRough) * charlieV(ci, co) * ci * p.fuzzCol; }
      if (!inside && p.coat > 0.0 && max(W.cax, W.cay) >= ${MIN_ALPHA} && odm > 0.0) {
        f += vec3f(mS * W.topF * p.coat * ggxD(h, W.cax, W.cay) * ggxG2(wo, wi, W.cax, W.cay) / (4.0 * co) * frDielectric(odm, p.coatIor));
        pdf += W.pr[K_COAT] * ggxDv(wo, h, W.cax, W.cay) / (4.0 * odm);
      }
      if (max(W.ax, W.ay) >= ${MIN_ALPHA} && odm > 0.0) {
        let DG = ggxD(h, W.ax, W.ay) * ggxG2(wo, wi, W.ax, W.ay) / (4.0 * co);
        let pv = ggxDv(wo, h, W.ax, W.ay) / (4.0 * odm);
        if (!inside && p.metal > 0.0) { f += mS * bfc * p.metal * DG * metalF(p, odm); pdf += W.pr[K_METAL] * pv; }
        if (!inside && W.pr[K_SPEC] > 0.0) { f += mS * bfc * (1.0 - p.metal) * (1.0 - p.trans) * DG * specF(p, W, odm) * p.spec; pdf += W.pr[K_SPEC] * pv; }
        if (wT > 0.0) {
          let F = select(frDielectric(odm, W.eta), thinR(frDielectric(odm, W.etaBase)), p.thin);
          f += mS * bfc * wT * DG * F * p.spec;
          pdf += W.pr[K_GLASS] * pv * F;
        }
      }
    }
    if (!inside) {
      if (p.metal > 0.0) {
        let k0 = p.metal * (1.0 - W.eCond) * (1.0 - lookupCond(ci, W.rSpec)) / (PI * max(1e-6, 1.0 - W.condAvg)) * ci;
        f += mS * bfc * k0 * W.fms;
        pdf += W.pr[K_METAL_MS] * ci / PI;
      }
      let under = (1.0 - p.metal) * (1.0 - p.trans) * (1.0 - W.eSpec);
      if (under > 0.0) {
        if (p.sss < 1.0) { f += mD * bfc * under * (1.0 - p.sss) * eonEval(p.base, p.diffRough, wo, wi) * ci; }
        if (p.sss > 0.0) { f += mD * bfc * under * p.sss / PI * ci * select(1.0, (1.0 - p.sssG) / 2.0, p.thin) * p.sssCol; }
      }
      pdf += (W.pr[K_DIFF] + W.pr[K_SSS] + W.pr[K_FUZZ]) * ci / PI;
    }
  } else {
    let under = (1.0 - p.metal) * (1.0 - p.trans) * (1.0 - W.eSpec);
    if (p.thin && p.sss > 0.0 && under > 0.0) {
      f += mT * bfc * under * p.sss / PI * acos * (1.0 + p.sssG) / 2.0 * p.sssCol;
      pdf += W.pr[K_SSS_T] * acos / PI;
    }
    if (wT > 0.0 && max(W.ax, W.ay) >= ${MIN_ALPHA}) {
      let tc = select(p.tcol, vec3f(1.0), p.beer);
      if (p.thin) {
        let wr = vec3f(wi.x, wi.y, -wi.z);
        let hs = wo + wr;
        let hl = length(hs);
        if (hl > 0.0) {
          let h = hs / hl;
          let odm = dot(wo, h);
          if (odm > 0.0) {
            let Tt = 1.0 - thinR(frDielectric(odm, W.etaBase));
            f += mT * bfc * wT * ggxD(h, W.ax, W.ay) * ggxG2(wo, wr, W.ax, W.ay) / (4.0 * co) * Tt * tc;
            pdf += W.pr[K_GLASS] * ggxDv(wo, h, W.ax, W.ay) / (4.0 * odm) * Tt;
          }
        }
      } else {
        let eta = W.eta;
        var m = wi * eta + wo;
        let ml = length(m);
        if (ml > 0.0) {
          m = m / ml;
          if (m.z < 0.0) { m = -m; }
          let idm = dot(wi, m); let odm = dot(wo, m);
          if (idm < 0.0 && odm > 0.0) {
            let Tt = 1.0 - frDielectric(odm, eta);
            let denom = idm + odm / eta;
            let d2 = denom * denom;
            let fv = Tt * ggxD(m, W.ax, W.ay) * ggxG2(wo, wi, W.ax, W.ay) * abs(idm * odm) / (acos * co * d2) / (eta * eta);
            f += mT * bfc * wT * fv * acos * tc;
            pdf += W.pr[K_GLASS] * ggxDv(wo, m, W.ax, W.ay) * (abs(idm) / d2) * Tt;
          }
        }
      }
    }
  }
  return vec4f(f, pdf);
}
struct BS { wi: vec3f, w: vec3f, pdf: f32, delta: bool, ok: bool }
var<private> LASTK: u32;   // the lobe sampleBsdf chose (RN.6: its render-element category, catOfK)
fn catOfK(k: u32, wiz: f32) -> u32 {
  if (k == K_FUZZ || k == K_DIFF || k == K_SSS) { return 1u; }
  if (k == K_SSS_T || (k == K_GLASS && wiz < 0.0)) { return 4u; }
  return 2u;
}
fn sampleBsdf(p: Mat, front: bool, chan: u32, wo: vec3f, u1: f32, u2: f32, uL: f32) -> BS {
  var r = BS(vec3f(0.0), vec3f(0.0), 0.0, false, false);
  if (wo.z <= 0.0) { return r; }
  let W = weigh(p, front, chan, wo.z);
  let inside = insideOf(p, front);
  var k = 8u; var acc = 0.0; var u = uL;
  for (var i = 0u; i < 9u; i++) { if (W.pr[i] > 0.0 && u < acc + W.pr[i]) { k = i; u = (u - acc) / W.pr[i]; break; } acc += W.pr[i]; }
  let pk = W.pr[k];
  if (!(pk > 0.0)) { return r; }
  LASTK = k;
  let mirror = vec3f(-wo.x, -wo.y, wo.z);
  var wi = vec3f(0.0);
  if (k == K_FUZZ || k == K_METAL_MS || k == K_DIFF || k == K_SSS || k == K_SSS_T) {
    let rr = sqrt(u1); let ph = 2.0 * PI * u2;
    wi = vec3f(rr * cos(ph), rr * sin(ph), sqrt(max(0.0, 1.0 - u1)));
    if (k == K_SSS_T) { wi.z = -wi.z; }
  } else if (k == K_COAT) {
    if (max(W.cax, W.cay) < ${MIN_ALPHA}) { return BS(mirror, vec3f(W.topF * p.coat * frDielectric(wo.z, p.coatIor)) / pk, 0.0, true, true); }
    let m = sampleVNDF(wo, W.cax, W.cay, u1, u2);
    wi = -wo + 2.0 * dot(wo, m) * m;
  } else if (k == K_METAL || k == K_SPEC) {
    if (max(W.ax, W.ay) < ${MIN_ALPHA}) {
      let bfc = baseFac(p, W, inside, wo.z, wo.z);
      if (k == K_METAL) { return BS(mirror, bfc * p.metal * metalF(p, wo.z) / pk, 0.0, true, true); }
      return BS(mirror, bfc * (1.0 - p.metal) * (1.0 - p.trans) * specF(p, W, wo.z) * p.spec / pk, 0.0, true, true);
    }
    let m = sampleVNDF(wo, W.ax, W.ay, u1, u2);
    wi = -wo + 2.0 * dot(wo, m) * m;
  } else {
    let eta = W.eta;
    let w0 = select((1.0 - p.metal) * p.trans, 1.0, inside);
    if (max(W.ax, W.ay) < ${MIN_ALPHA}) {
      let F = select(frDielectric(wo.z, eta), thinR(frDielectric(wo.z, W.etaBase)), p.thin);
      if (u < F) { return BS(mirror, baseFac(p, W, inside, wo.z, wo.z) * w0 * p.spec / pk, 0.0, true, true); }
      let tc = select(p.tcol, vec3f(1.0), p.beer);
      if (p.thin) { return BS(-wo, baseFac(p, W, inside, wo.z, wo.z) * w0 * tc / pk, 0.0, true, true); }
      let t = refr(wo, vec3f(0.0, 0.0, 1.0), eta);
      if (t.w == 0.0) { return BS(mirror, baseFac(p, W, inside, wo.z, wo.z) * w0 / pk, 0.0, true, true); }
      return BS(t.xyz, baseFac(p, W, inside, wo.z, abs(t.z)) * w0 * tc / (eta * eta) / pk, 0.0, true, true);
    }
    let m = sampleVNDF(wo, W.ax, W.ay, u1, u2);
    let d = dot(wo, m);
    let F = select(frDielectric(d, eta), thinR(frDielectric(d, W.etaBase)), p.thin);
    if (u < F) { wi = -wo + 2.0 * d * m; }
    else if (p.thin) { wi = -wo + 2.0 * d * m; wi.z = -wi.z; }
    else { let t = refr(wo, m, eta); if (t.w == 0.0) { return r; } wi = t.xyz; }
  }
  let l = length(wi);
  if (!(l > 0.0)) { return r; }
  wi = wi / l;
  let ev = evalBsdf(p, front, chan, wo, wi);
  if (!(ev.w > 0.0)) { return r; }
  return BS(wi, ev.xyz / ev.w, ev.w, false, true);
}
fn emitted(p: Mat, mu: f32) -> vec3f {
  if (!any(p.emis > vec3f(0.0))) { return vec3f(0.0); }
  return p.emis * ${LIGHT_SCALE} * (vec3f(1.0) + (coatPass(p, max(1e-4, mu)) - vec3f(1.0)) * p.coat);
}
`;

// RN.3 (RENDER-SPEC § 5.2, § 5.3, § 6.5, § 6.8): pt-lights.js line for line. LD = the ldat buffer (f32; u32 words by bitcast);
// header words by hw()/hf(). A vertex picks the sky, the sun or the light tree by the header shares, then a light of the tree
// by importance (pbrt-v4 LightBounds, no normal); BSDF rays meet lamp shapes through the same tree as a BVH.
const HDR = `
fn hw(i: u32) -> u32 { return bitcast<u32>(H[i >> 2u][i & 3u]); }
fn hf(i: u32) -> f32 { return H[i >> 2u][i & 3u]; }
`;

// RN.4 (RENDER-SPEC § 1, § 6.1 words 86–127): pt-camera.js cameraRay line for line
const CAMERA = `
fn unproj(Pi: mat4x4f, x: f32, y: f32, z: f32) -> vec3f { let p = Pi * vec4f(x, y, z, 1.0); return p.xyz / p.w; }
struct CRay { o: vec3f, d: vec3f }
fn pinhole(Wm: mat4x4f, Pi: mat4x4f, x: f32, y: f32) -> CRay {
  let a = unproj(Pi, x, y, -1.0);
  let b = unproj(Pi, x, y, 1.0);
  return CRay((Wm * vec4f(a, 1.0)).xyz, normalize((Wm * vec4f(b - a, 0.0)).xyz));
}
fn hmat(w0: u32) -> mat4x4f { let k = w0 >> 2u; return mat4x4f(H[k], H[k + 1u], H[k + 2u], H[k + 3u]); }
fn lensPoint(u: f32, v: f32, blades: u32, rot: f32) -> vec2f {
  if (blades < 3u) {
    let a = 2.0 * u - 1.0;
    let b = 2.0 * v - 1.0;
    if (a == 0.0 && b == 0.0) { return vec2f(0.0); }
    var r = 0.0;
    var ph = 0.0;
    if (abs(a) > abs(b)) { r = a; ph = (PI / 4.0) * (b / a); } else { r = b; ph = PI / 2.0 - (PI / 4.0) * (a / b); }
    return vec2f(r * cos(ph), r * sin(ph));
  }
  let n = f32(blades);
  let k = min(n - 1.0, floor(u * n));
  let uu = u * n - k;
  let a0 = rot + 2.0 * PI * k / n;
  let a1 = a0 + 2.0 * PI / n;
  let su = sqrt(uu);
  let b1 = su * (1.0 - v);
  let b2 = su * v;
  return vec2f(b1 * cos(a0) + b2 * cos(a1), b1 * sin(a0) + b2 * sin(a1));
}
fn cameraRay(px: u32, py: u32, w: u32, h: u32, jx: f32, jy: f32, l1: f32, l2: f32, tm: f32) -> CRay {
  let kind = hw(${HW.PROJ}u);
  let Wm = mat4x4f(H[4], H[5], H[6], H[7]);
  if (kind != 0u) {
    let u = (f32(px) + jx) / f32(w);
    let v = (f32(py) + jy) / f32(h);
    var c = vec3f(0.0);
    var eye = vec3f(0.0);
    if (kind == 3u) {
      let fx = min(2.0, floor(u * 3.0));
      let fy = select(1.0, 0.0, v < 0.5);
      let a = (u * 3.0 - fx) * 2.0 - 1.0;
      let b = 1.0 - fract(v * 2.0) * 2.0;
      let f = u32(fx + 3.0 * fy);
      if (f == 0u) { c = vec3f(1.0, b, a); }
      else if (f == 1u) { c = vec3f(-1.0, b, -a); }
      else if (f == 2u) { c = vec3f(a, 1.0, -b); }
      else if (f == 3u) { c = vec3f(a, -1.0, b); }
      else if (f == 4u) { c = vec3f(a, b, -1.0); }
      else { c = vec3f(-a, b, 1.0); }
    } else {
      let vv = select(v, fract(v * 2.0), kind == 2u);
      let lon = 2.0 * PI * (u - 0.5);
      let lat = PI * (0.5 - vv);
      c = vec3f(cos(lat) * sin(lon), sin(lat), -cos(lat) * cos(lon));
      if (kind == 2u) { let sg = select(1.0, -1.0, v < 0.5) * hf(${HW.STEREO_IPD}u) / 2.0; eye = vec3f(sg * cos(lon), 0.0, sg * sin(lon)); }
    }
    c = normalize(c);
    let d = normalize(Wm[0].xyz * c.x + Wm[1].xyz * c.y + Wm[2].xyz * c.z);
    return CRay(Wm[3].xyz + Wm[0].xyz * eye.x + Wm[1].xyz * eye.y + Wm[2].xyz * eye.z, d);
  }
  let x = 2.0 * (f32(px) + jx) / f32(w) - 1.0;
  let y = 1.0 - 2.0 * (f32(py) + jy) / f32(h);
  var r = pinhole(Wm, mat4x4f(H[8], H[9], H[10], H[11]), x, y);
  if (hw(${HW.MOTION}u) == 1u && tm > 0.0) {
    let r1 = pinhole(hmat(${HW.CAM1_W}u), hmat(${HW.CAM1_PI}u), x, y);
    r = CRay(r.o + (r1.o - r.o) * tm, normalize(r.d + (r1.d - r.d) * tm));
  }
  let R = hf(${HW.LENS_R}u);
  if (R > 0.0) {
    let fwd = -Wm[2].xyz;
    let cc = dot(r.d, fwd) / max(length(fwd), 1e-30);
    if (!(cc > 1e-6)) { return r; }
    let ahead = dot(r.o - Wm[3].xyz, fwd) / max(length(fwd), 1e-30);   // the focus plane: focus m in front of the eye
    let pf = r.o + r.d * ((hf(${HW.FOCUS}u) - ahead) / cc);
    let ab = lensPoint(l1, l2, hw(${HW.BLADES}u), hf(${HW.BLADE_ROT}u));
    let o = r.o + normalize(Wm[0].xyz) * ab.x * R + normalize(Wm[1].xyz) * ab.y * R;
    return CRay(o, normalize(pf - o));
  }
  return r;
}
`;

const LIGHTS = `
fn ldu(i: u32) -> u32 { return bitcast<u32>(LD[i]); }
fn nLights() -> u32 { return bitcast<u32>(H[1].y); }
fn recBase(i: u32) -> u32 { return hw(${HW.LREC_OFF}u) + i * ${LIGHT_FLOATS}u; }
fn rv(i: u32, k: u32) -> vec4f { let o = recBase(i) + k * 4u; return vec4f(LD[o], LD[o + 1u], LD[o + 2u], LD[o + 3u]); }
fn kindOf(i: u32) -> u32 { return u32(LD[recBase(i)]); }
fn oneMinusCos(s2: f32, c: f32) -> f32 { return s2 / (1.0 + c); }

// ---- the sky: gradient, or a map (physical sky / picture) with its CDFs, and portals ----
fn mapFrame() -> mat3x3f {
  let up = H[2].xyz;
  var e1 = basisE1(up);
  var e2 = cross(up, e1);
  let r = hf(${HW.ENV_ROT}u);
  if (r != 0.0) { let c = cos(r); let sn = sin(r); let a = e1 * c + e2 * sn; let b = -e1 * sn + e2 * c; e1 = a; e2 = b; }
  return mat3x3f(e1, e2, up);
}
fn envPixel(d: vec3f, F: mat3x3f) -> vec2f {
  let W = f32(hw(${HW.MAP_W}u));
  let Hh = f32(hw(${HW.MAP_H}u));
  let ct = clamp(dot(d, F[2]), -1.0, 1.0);
  var phi = atan2(dot(d, F[1]), dot(d, F[0]));
  if (phi < 0.0) { phi += 2.0 * PI; }
  return vec2f(phi / (2.0 * PI) * W, acos(ct) / PI * Hh);
}
fn envRad(d: vec3f) -> vec3f {
  if (hw(${HW.ENV_KIND}u) == 1u) {
    let W = hw(${HW.MAP_W}u);
    let Hh = hw(${HW.MAP_H}u);
    let xy = envPixel(d, mapFrame());
    let i = u32(clamp(floor(xy.x), 0.0, f32(W - 1u)));
    let j = u32(clamp(floor(xy.y), 0.0, f32(Hh - 1u)));
    let o = hw(${HW.MAP_OFF}u) + (j * W + i) * 4u;
    return vec3f(LD[o], LD[o + 1u], LD[o + 2u]) * hf(${HW.ENV_SCALE}u);
  }
  let up = H[2].xyz;
  let z = dot(d, up);
  if (z >= 0.0) { return mix(H[13].xyz, H[12].xyz, pow(z, 0.6)) * H[12].w; }
  return mix(H[13].xyz, H[14].xyz, pow(-z, 0.4)) * H[12].w;
}
fn findCdf(off: u32, n: u32, u: f32) -> u32 {
  var lo = 0u;
  var hi = n - 1u;
  loop { if (lo >= hi) { break; } let m = (lo + hi) >> 1u; if (LD[off + m + 1u] > u) { hi = m; } else { lo = m + 1u; } }
  return lo;
}
fn envGlobalPdf(d: vec3f) -> f32 {
  if (hw(${HW.ENV_KIND}u) != 1u) { return 1.0 / (4.0 * PI); }
  let W = hw(${HW.MAP_W}u);
  let Hh = hw(${HW.MAP_H}u);
  let xy = envPixel(d, mapFrame());
  let i = u32(clamp(floor(xy.x), 0.0, f32(W - 1u)));
  let j = u32(clamp(floor(xy.y), 0.0, f32(Hh - 1u)));
  let mg = hw(${HW.MARG_OFF}u);
  let pj = LD[mg + j + 1u] - LD[mg + j];
  let o = hw(${HW.COND_OFF}u) + j * (W + 1u);
  let pi = LD[o + i + 1u] - LD[o + i];
  let st = sin(PI * xy.y / f32(Hh));
  return select(0.0, pj * pi * f32(W) * f32(Hh) / (2.0 * PI * PI * st), st > 0.0);
}
fn envGlobalSample(u: f32, v: f32) -> vec3f {
  if (hw(${HW.ENV_KIND}u) != 1u) {
    let z = 1.0 - 2.0 * u;
    let r = sqrt(max(0.0, 1.0 - z * z));
    let ph = 2.0 * PI * v;
    return vec3f(r * cos(ph), r * sin(ph), z);
  }
  let W = hw(${HW.MAP_W}u);
  let Hh = hw(${HW.MAP_H}u);
  let mg = hw(${HW.MARG_OFF}u);
  let j = findCdf(mg, Hh, u);
  let pj = LD[mg + j + 1u] - LD[mg + j];
  let fy = select(0.5, (u - LD[mg + j]) / pj, pj > 0.0);
  let o = hw(${HW.COND_OFF}u) + j * (W + 1u);
  let i = findCdf(o, W, v);
  let pi = LD[o + i + 1u] - LD[o + i];
  let fx = select(0.5, (v - LD[o + i]) / pi, pi > 0.0);
  let phi = 2.0 * PI * (f32(i) + fx) / f32(W);
  let th = PI * (f32(j) + fy) / f32(Hh);
  let F = mapFrame();
  return F[0] * cos(phi) * sin(th) + F[1] * sin(phi) * sin(th) + F[2] * cos(th);
}
fn portalPdf(p: vec3f, d: vec3f) -> f32 {
  let np = hw(${HW.PORTAL_N}u);
  var sum = 0.0;
  for (var k = 0u; k < np; k++) {
    let o = hw(${HW.PORTAL_OFF}u) + k * ${PORTAL_FLOATS}u;
    let p0 = vec3f(LD[o], LD[o + 1u], LD[o + 2u]);
    let a = vec3f(LD[o + 4u], LD[o + 5u], LD[o + 6u]);
    let b = vec3f(LD[o + 8u], LD[o + 9u], LD[o + 10u]);
    let nn = cross(a, b);
    let A = length(nn);
    if (!(A > 0.0)) { continue; }
    let n = nn / A;
    let dn = dot(d, n);
    if (abs(dn) < 1e-9) { continue; }
    let t = dot(p0 - p, n) / dn;
    if (!(t > 0.0)) { continue; }
    let q = p + d * t - p0;
    let sa = dot(q, a) / dot(a, a);
    let sb = dot(q, b) / dot(b, b);
    if (sa < 0.0 || sa > 1.0 || sb < 0.0 || sb > 1.0) { continue; }
    sum += t * t / (A * abs(dn));
  }
  return sum / f32(np);
}
fn envPdf(p: vec3f, d: vec3f) -> f32 {
  if (hw(${HW.PORTAL_N}u) > 0u) { return 0.5 * envGlobalPdf(d) + 0.5 * portalPdf(p, d); }
  return envGlobalPdf(d);
}

// ---- the light tree ----
fn cosSubC(sa: f32, ca: f32, sb: f32, cb: f32) -> f32 { return select(ca * cb + sa * sb, 1.0, ca > cb); }
fn sinSubC(sa: f32, ca: f32, sb: f32, cb: f32) -> f32 { return select(sa * cb - ca * sb, 0.0, ca > cb); }
fn importance(ni: u32, p: vec3f) -> f32 {
  let o = hw(${HW.TREE_OFF}u) + ni * 16u;
  let power = LD[o + 3u];
  if (!(power > 0.0)) { return 0.0; }
  let lo = vec3f(LD[o], LD[o + 1u], LD[o + 2u]);
  let hi = vec3f(LD[o + 4u], LD[o + 5u], LD[o + 6u]);
  let pc = (lo + hi) * 0.5;
  let diag = length(hi - lo);
  let dv = p - pc;
  let d2c = dot(dv, dv);
  let d2 = max(d2c, diag / 2.0);
  let l = sqrt(d2c);
  let dn = select(dv, dv / l, l > 0.0);
  var cosW = dot(vec3f(LD[o + 8u], LD[o + 9u], LD[o + 10u]), dn);
  if ((ldu(o + 13u) & 2u) != 0u) { cosW = abs(cosW); }
  let sinW = sqrt(max(0.0, 1.0 - cosW * cosW));
  let inside = all(p >= lo) && all(p <= hi);
  let r2 = (diag / 2.0) * (diag / 2.0);
  var cosB = -1.0;
  if (!(inside || d2c <= r2)) { cosB = sqrt(max(0.0, 1.0 - r2 / d2c)); }
  let sinB = sqrt(max(0.0, 1.0 - cosB * cosB));
  let cosO = LD[o + 7u];
  let sinO = sqrt(max(0.0, 1.0 - cosO * cosO));
  let cosX = cosSubC(sinW, cosW, sinO, cosO);
  let sinX = sinSubC(sinW, cosW, sinO, cosO);
  let cosP = cosSubC(sinX, cosX, sinB, cosB);
  if (cosP <= LD[o + 11u]) { return 0.0; }
  return max(0.0, power * cosP / d2);
}
struct LPick { i: u32, prob: f32, u: f32 }
fn pickLight(p: vec3f, u0: f32) -> LPick {
  let pE = hf(${HW.P_ENV}u);
  let pS = hf(${HW.P_SUN}u);
  let pT = hf(${HW.P_TREE}u);
  let ei = bitcast<u32>(H[2].w);
  let si = bitcast<u32>(H[14].w);
  if (u0 < pE && ei != NOLIGHT) { return LPick(ei, pE, u0 / pE); }
  if (u0 < pE + pS && si != NOLIGHT) { return LPick(si, pS, (u0 - pE) / pS); }
  if (!(pT > 0.0) || hw(${HW.TREE_N}u) == 0u) { return LPick(NOLIGHT, 0.0, 0.0); }
  var uu = min(0.99999994, (u0 - pE - pS) / pT);
  var ni = 0u;
  var prob = pT;
  if (!(importance(0u, p) > 0.0)) { return LPick(NOLIGHT, 0.0, 0.0); }
  let T = hw(${HW.TREE_OFF}u);
  for (var step = 0u; step < 40u; step++) {
    let o = T + ni * 16u;
    if ((ldu(o + 13u) & 1u) != 0u) { return LPick(ldu(o + 12u), prob, uu); }
    let c = ldu(o + 12u);
    let il = importance(c, p);
    let ir = importance(c + 1u, p);
    if (!(il + ir > 0.0)) { return LPick(NOLIGHT, 0.0, 0.0); }
    let pl = il / (il + ir);
    if (uu < pl) { uu = uu / pl; ni = c; prob *= pl; } else { uu = (uu - pl) / (1.0 - pl); ni = c + 1u; prob *= 1.0 - pl; }
    uu = min(uu, 0.99999994);
  }
  return LPick(NOLIGHT, 0.0, 0.0);
}
fn pickProb(i: u32, p: vec3f) -> f32 {
  if (i == bitcast<u32>(H[2].w)) { return hf(${HW.P_ENV}u); }
  if (i == bitcast<u32>(H[14].w)) { return hf(${HW.P_SUN}u); }
  if (i >= hw(${HW.NBOUNDED}u) || hw(${HW.TREE_N}u) == 0u) { return 0.0; }
  if (!(importance(0u, p) > 0.0)) { return 0.0; }
  let M = hw(${HW.LMETA_OFF}u) + i * 4u;
  let bits = ldu(M);
  let depth = ldu(M + 1u);
  let T = hw(${HW.TREE_OFF}u);
  var ni = 0u;
  var prob = hf(${HW.P_TREE}u);
  for (var k = 0u; k < depth; k++) {
    let c = ldu(T + ni * 16u + 12u);
    let il = importance(c, p);
    let ir = importance(c + 1u, p);
    if (!(il + ir > 0.0)) { return 0.0; }
    let right = (bits >> k) & 1u;
    prob *= select(il, ir, right == 1u) / (il + ir);
    ni = c + right;
  }
  return prob;
}

// ---- one light ----
fn spotFall(i: u32, dirFromLamp: vec3f) -> f32 {
  let r2 = rv(i, 2u);
  let c = dot(r2.xyz, dirFromLamp);
  let c0 = r2.w;
  let c1 = cos(acos(c0) * (1.0 - rv(i, 3u).w));
  if (c <= c0) { return 0.0; }
  if (c >= c1) { return 1.0; }
  let x = (c - c0) / (c1 - c0);
  return x * x * (3.0 - 2.0 * x);
}
fn iesMul(i: u32, d: vec3f) -> f32 {
  let g = ldu(hw(${HW.LMETA_OFF}u) + i * 4u + 2u);
  if (g == 0xffffffffu) { return 1.0; }
  let ax = rv(i, 2u).xyz;
  let a1 = basisE1(ax);
  let a2 = cross(ax, a1);
  let NT = ${IES_THETA}u;
  let NP = ${IES_PHI}u;
  let base = hw(${HW.IES_OFF}u) + g * NT * NP;
  let t = acos(clamp(dot(ax, d), -1.0, 1.0)) / PI * f32(NT) - 0.5;
  let phi = atan2(dot(a2, d), dot(a1, d));
  var pp = fract(phi / (2.0 * PI)) * f32(NP) - 0.5;
  let t0 = u32(clamp(floor(t), 0.0, f32(NT - 1u)));
  let t1 = min(NT - 1u, t0 + 1u);
  let ft = clamp(t - f32(t0), 0.0, 1.0);
  if (pp < 0.0) { pp += f32(NP); }
  let p0 = u32(floor(pp)) % NP;
  let p1 = (p0 + 1u) % NP;
  let fp = pp - floor(pp);
  let a = LD[base + t0 * NP + p0] * (1.0 - fp) + LD[base + t0 * NP + p1] * fp;
  let b = LD[base + t1 * NP + p0] * (1.0 - fp) + LD[base + t1 * NP + p1] * fp;
  return a * (1.0 - ft) + b * ft;
}
fn lampFactor(i: u32, k: u32, d: vec3f) -> f32 {
  var f = 1.0;
  if (k == ${LIGHT.SPOT}u) { f = spotFall(i, d); }
  return f * iesMul(i, d);
}
struct LSmp { wi: vec3f, dist: f32, L: vec3f, pdf: f32, ok: bool }
fn triNormal(i: u32) -> vec3f { return normalize(cross(rv(i, 2u).xyz, rv(i, 0u).yzw)); }
fn sampleLight(i: u32, p: vec3f, u: f32, v: f32, uRest: f32) -> LSmp {
  var r = LSmp(vec3f(0.0), INF, vec3f(0.0), 0.0, false);
  let k = kindOf(i);
  let r1 = rv(i, 1u);
  let r2 = rv(i, 2u);
  let r3 = rv(i, 3u);
  if (k == ${LIGHT.ENV}u) {
    let np = hw(${HW.PORTAL_N}u);
    if (np > 0u && uRest < 0.5) {
      let kk = min(np - 1u, u32(floor(uRest / 0.5 * f32(np))));
      let o = hw(${HW.PORTAL_OFF}u) + kk * ${PORTAL_FLOATS}u;
      let q = vec3f(LD[o], LD[o + 1u], LD[o + 2u]) + vec3f(LD[o + 4u], LD[o + 5u], LD[o + 6u]) * u + vec3f(LD[o + 8u], LD[o + 9u], LD[o + 10u]) * v - p;
      let l = length(q);
      if (!(l > 0.0)) { return r; }
      r.wi = q / l;
    } else { r.wi = envGlobalSample(u, v); }
    r.L = envRad(r.wi); r.pdf = envPdf(p, r.wi); r.ok = r.pdf > 0.0; return r;
  }
  if (k == ${LIGHT.SUN}u) {
    let omc = 1.0 - r1.w;
    let ct = 1.0 - u * omc;
    let st = sqrt(max(0.0, 1.0 - ct * ct));
    let ph = 2.0 * PI * v;
    let e1 = basisE1(r1.xyz);
    let e2 = cross(r1.xyz, e1);
    r.wi = r1.xyz * ct + (e1 * cos(ph) + e2 * sin(ph)) * st;
    let omega = 2.0 * PI * omc;
    r.L = r3.xyz / omega; r.pdf = 1.0 / omega; r.ok = true; return r;
  }
  if (k == ${LIGHT.AREA}u || k == ${LIGHT.DISC}u || k == ${LIGHT.TRI}u || k == ${LIGHT.TRI2}u) {
    var q = vec3f(0.0);
    var n = vec3f(0.0);
    var A = 0.0;
    let isTri = k == ${LIGHT.TRI}u || k == ${LIGHT.TRI2}u;
    if (isTri) {
      let su = sqrt(u);
      q = r1.xyz + r2.xyz * (1.0 - su) + rv(i, 0u).yzw * (v * su);
      n = triNormal(i);
      A = r1.w;
    } else {
      n = r2.xyz;
      let e1 = basisE1(n);
      let e2 = cross(n, e1);
      var a = 0.0;
      var b = 0.0;
      if (k == ${LIGHT.AREA}u) { a = (u - 0.5) * r1.w; b = (v - 0.5) * r2.w; A = r1.w * r2.w; }
      else { let rr = r1.w * sqrt(u); let ph = 2.0 * PI * v; a = rr * cos(ph); b = rr * sin(ph); A = PI * r1.w * r1.w; }
      q = r1.xyz + e1 * a + e2 * b;
    }
    let dv = q - p;
    let d2 = dot(dv, dv);
    let d = sqrt(d2);
    if (!(d > 0.0)) { return r; }
    let wi = dv / d;
    var cl = -dot(wi, n);
    if (k == ${LIGHT.TRI2}u) { cl = abs(cl); }
    if (cl <= 0.0) { return r; }
    r.wi = wi; r.dist = d; r.pdf = d2 / (A * cl); r.ok = true;
    if (isTri) { r.L = emitted(matParams(u32(r2.w)), cl); } else { r.L = r3.xyz; }
    return r;
  }
  let c = r1.xyz;
  let rad = r1.w;
  let tv = c - p;
  let d2 = dot(tv, tv);
  let d = sqrt(d2);
  if (d <= rad) { return r; }
  let t = tv / d;
  let s2 = rad * rad / d2;
  let cm = sqrt(max(0.0, 1.0 - s2));
  let omc = oneMinusCos(s2, cm);
  let ct = 1.0 - u * omc;
  let st = sqrt(max(0.0, 1.0 - ct * ct));
  let ph = 2.0 * PI * v;
  let e1 = basisE1(t);
  let e2 = cross(t, e1);
  r.wi = t * ct + (e1 * cos(ph) + e2 * sin(ph)) * st;
  let b = d * ct;
  let disc = rad * rad - (d2 - b * b);
  r.dist = b - sqrt(max(0.0, disc));
  let f = lampFactor(i, k, -t);
  if (f <= 0.0) { return r; }
  r.L = r3.xyz * f; r.pdf = 1.0 / (2.0 * PI * omc); r.ok = true; return r;
}
fn lightPdf(i: u32, p: vec3f, wi: vec3f, dist: f32) -> f32 {
  let k = kindOf(i);
  let r1 = rv(i, 1u);
  let r2 = rv(i, 2u);
  if (k == ${LIGHT.ENV}u) { return envPdf(p, wi); }
  if (k == ${LIGHT.SUN}u) { return 1.0 / (2.0 * PI * (1.0 - r1.w)); }
  if (k == ${LIGHT.AREA}u || k == ${LIGHT.DISC}u) {
    let cl = -dot(wi, r2.xyz);
    let A = select(PI * r1.w * r1.w, r1.w * r2.w, k == ${LIGHT.AREA}u);
    return select(0.0, dist * dist / (A * cl), cl > 0.0);
  }
  if (k == ${LIGHT.TRI}u || k == ${LIGHT.TRI2}u) {
    var cl = -dot(wi, triNormal(i));
    if (k == ${LIGHT.TRI2}u) { cl = abs(cl); }
    return select(0.0, dist * dist / (r1.w * cl), cl > 0.0);
  }
  let dv = r1.xyz - p;
  let d2 = dot(dv, dv);
  let rad = r1.w;
  if (d2 <= rad * rad) { return 0.0; }
  let s2 = rad * rad / d2;
  return 1.0 / (2.0 * PI * oneMinusCos(s2, sqrt(max(0.0, 1.0 - s2))));
}
// lamp shapes along a ray: the tree as a ray BVH (spheres, rectangles, discs; triangles are geometry)
struct LHit { i: u32, t: f32, L: vec3f }
var<private> LST: array<u32, 64>;
fn lampHit(o: vec3f, d: vec3f, tmax: f32) -> LHit {
  var h = LHit(NONE, tmax, vec3f(0.0));
  if (hw(${HW.TREE_N}u) == 0u) { return h; }
  let T = hw(${HW.TREE_OFF}u);
  let inv = safeInvL(d);
  var sp = 1u;
  LST[0] = 0u;
  loop {
    if (sp == 0u) { break; }
    sp -= 1u;
    let ni = LST[sp];
    let no = T + ni * 16u;
    let t0 = (vec3f(LD[no], LD[no + 1u], LD[no + 2u]) - o) * inv;
    let t1 = (vec3f(LD[no + 4u], LD[no + 5u], LD[no + 6u]) - o) * inv;
    let lo = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
    let hi = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
    if (!(hi >= max(lo, 0.0) && lo < h.t)) { continue; }
    if ((ldu(no + 13u) & 1u) == 0u) { if (sp < 63u) { LST[sp] = ldu(no + 12u); LST[sp + 1u] = ldu(no + 12u) + 1u; sp += 2u; } continue; }
    let i = ldu(no + 12u);
    let k = kindOf(i);
    let r1 = rv(i, 1u);
    let r2 = rv(i, 2u);
    let r3 = rv(i, 3u);
    if (k == ${LIGHT.POINT}u || k == ${LIGHT.SPOT}u) {
      let oc = o - r1.xyz;
      let b = dot(oc, d);
      let c = dot(oc, oc) - r1.w * r1.w;
      let disc = b * b - c;
      if (disc < 0.0 || c <= 0.0) { continue; }
      let t = -b - sqrt(disc);
      if (t > 0.0 && t < h.t) { h = LHit(i, t, r3.xyz * lampFactor(i, k, -d)); }
    } else if (k == ${LIGHT.AREA}u || k == ${LIGHT.DISC}u) {
      let nd = dot(d, r2.xyz);
      if (nd >= 0.0) { continue; }
      let t = dot(r1.xyz - o, r2.xyz) / nd;
      if (!(t > 0.0 && t < h.t)) { continue; }
      let e1 = basisE1(r2.xyz);
      let e2 = cross(r2.xyz, e1);
      let q = o + d * t - r1.xyz;
      let a = dot(q, e1);
      let bb = dot(q, e2);
      if (k == ${LIGHT.AREA}u) { if (abs(a) > r1.w / 2.0 || abs(bb) > r2.w / 2.0) { continue; } }
      else if (a * a + bb * bb > r1.w * r1.w) { continue; }
      h = LHit(i, t, r3.xyz);
    }
  }
  return h;
}
fn safeInvL(d: vec3f) -> vec3f { return 1.0 / select(d, vec3f(1e-30), d == vec3f(0.0)); }
`;

function decls(stage) {
  const out = [];
  for (const name of STAGE_BINDINGS[stage]) {
    let d = DECL[name];
    if (name === 'rin') d = stage === 'isect' ? 'var<storage, read_write> RIN: array<Path>;' : 'var<storage, read> RIN: array<Path>;';
    if (name === 'shq') d = stage === 'shadow' ? 'var<storage, read> SHQ: array<Shadow>;' : 'var<storage, read_write> SHQ: array<Shadow>;';
    out.push(`@group(0) @binding(${BIND[name]}) ${d}`);
  }
  return out.join('\n');
}

const PHASE = `
// RN.7 (pt-volume.js): Henyey–Greenstein, cos θ = dot(travel direction, the new direction)
fn hgPhase(c: f32, g: f32) -> f32 {
  let d = 1.0 + g * g - 2.0 * g * c;
  return (1.0 - g * g) / (4.0 * PI * pow(max(d, 1e-9), 1.5));
}
fn hgSampleCos(u: f32, g: f32) -> f32 {
  if (abs(g) < 1e-3) { return 1.0 - 2.0 * u; }
  let q = (1.0 - g * g) / (1.0 - g + 2.0 * g * u);
  return clamp((1.0 + g * g - q * q) / (2.0 * g), -1.0, 1.0);
}
`;

const MEDIA = `
// RN.7 participating media (RENDER-SPEC § 3.1, § 6.9): pt-volume.js makeMedia() line for line. The block is in ldat at header word
// ${HW.VOL_OFF}; draw k of a vertex is the hashed dimension DIM0 + STRIDE · depth + k (a shadow ray: SHADOW_DIM0).
var<private> MPT: array<f32, 12>;
var<private> MGA: array<f32, 4>;
var<private> MGB: array<f32, 4>;
var<private> MFAB: vec2f;
var<private> MNP: u32;
fn lv(i: u32) -> f32 { return LD[i]; }
fn lu(i: u32) -> u32 { return bitcast<u32>(LD[i]); }
fn mediaOn() -> bool { let V = hw(${HW.VOL_OFF}u); return V != 0u && (lu(V + 1u) & ${VOL.MEDIA_FLAG}u) != 0u; }
fn vrnd(px: u32, py: u32, s: u32, d: u32) -> f32 { return f32(hash4(px, py, s, d) >> 8u) * (1.0 / 16777216.0); }
fn clampi(i: i32, n: i32) -> u32 { return u32(clamp(i, 0, n - 1)); }
fn gridRho(r: u32, V: u32, p: vec3f) -> f32 {
  let nx = i32(lv(r + 12u)); let ny = i32(lv(r + 13u)); let nz = i32(lv(r + 14u));
  let o = V + lu(r + 15u);
  let x = lv(r) * p.x + lv(r + 1u) * p.y + lv(r + 2u) * p.z + lv(r + 3u);
  let y = lv(r + 4u) * p.x + lv(r + 5u) * p.y + lv(r + 6u) * p.z + lv(r + 7u);
  let z = lv(r + 8u) * p.x + lv(r + 9u) * p.y + lv(r + 10u) * p.z + lv(r + 11u);
  let fx = x * f32(nx) - 0.5; let fy = y * f32(ny) - 0.5; let fz = z * f32(nz) - 0.5;
  let x0 = i32(floor(fx)); let y0 = i32(floor(fy)); let z0 = i32(floor(fz));
  let tx = fx - f32(x0); let ty = fy - f32(y0); let tz = fz - f32(z0);
  let X0 = clampi(x0, nx); let X1 = clampi(x0 + 1, nx); let Y0 = clampi(y0, ny); let Y1 = clampi(y0 + 1, ny);
  let Z0 = clampi(z0, nz); let Z1 = clampi(z0 + 1, nz);
  let a = o + Z0 * u32(ny * nx); let b = o + Z1 * u32(ny * nx); let r0 = Y0 * u32(nx); let r1 = Y1 * u32(nx);
  let c00 = LD[a + r0 + X0] * (1.0 - tx) + LD[a + r0 + X1] * tx; let c10 = LD[a + r1 + X0] * (1.0 - tx) + LD[a + r1 + X1] * tx;
  let c01 = LD[b + r0 + X0] * (1.0 - tx) + LD[b + r0 + X1] * tx; let c11 = LD[b + r1 + X0] * (1.0 - tx) + LD[b + r1 + X1] * tx;
  return (c00 * (1.0 - ty) + c10 * ty) * (1.0 - tz) + (c01 * (1.0 - ty) + c11 * ty) * tz;
}
fn gridSigma(i: u32, V: u32, p: vec3f) -> f32 {
  let r = V + ${VOL.HEAD}u + ${VOL.REC}u * i;
  return lv(r + 20u) * gridRho(r, V, p);
}
fn gridMajor(i: u32, V: u32) -> f32 { let r = V + ${VOL.HEAD}u + ${VOL.REC}u * i; return lv(r + 20u) * lv(r + 21u); }
fn mGather(o: vec3f, d: vec3f, tmax: f32, V: u32) {
  let nG = lu(V);
  var sigF = 0.0;
  if ((lu(V + 1u) & ${VOL.FOG_FLAG}u) != 0u) { sigF = lv(V + 2u); }
  MPT[0] = 0.0; MPT[1] = tmax;
  var np = 2u;
  MFAB = vec2f(1.0, 0.0);
  if (sigF > 0.0) {
    let up = vec3f(lv(V + 8u), lv(V + 9u), lv(V + 10u));
    let top = lv(V + 3u);
    let h0 = dot(up, o); let dz = dot(up, d);
    var a = 1.0; var b = 0.0;
    if (dz > 0.0) { if (h0 <= top) { a = 0.0; b = (top - h0) / dz; } }
    else if (dz < 0.0) { a = select((top - h0) / dz, 0.0, h0 <= top); b = INF; }
    else if (h0 <= top) { a = 0.0; b = INF; }
    a = max(a, 0.0); b = min(b, tmax);
    if (a < b) { MFAB = vec2f(a, b); MPT[np] = a; MPT[np + 1u] = b; np = np + 2u; }
  }
  for (var i = 0u; i < nG; i++) {
    let r = V + ${VOL.HEAD}u + ${VOL.REC}u * i;
    var a = 0.0; var b = tmax; var ok = true;
    for (var k = 0u; k < 3u; k++) {
      let rk = r + 4u * k;
      let oo = lv(rk) * o.x + lv(rk + 1u) * o.y + lv(rk + 2u) * o.z + lv(rk + 3u);
      let dd = lv(rk) * d.x + lv(rk + 1u) * d.y + lv(rk + 2u) * d.z;
      if (abs(dd) < 1e-30) { if (oo < 0.0 || oo > 1.0) { ok = false; } continue; }
      var t1 = (0.0 - oo) / dd; var t2 = (1.0 - oo) / dd;
      if (t1 > t2) { let tt = t1; t1 = t2; t2 = tt; }
      a = max(a, t1); b = min(b, t2);
      if (!(a < b)) { ok = false; }
    }
    if (ok && a < b) { MGA[i] = a; MGB[i] = b; MPT[np] = a; MPT[np + 1u] = b; np = np + 2u; } else { MGA[i] = 1.0; MGB[i] = 0.0; }
  }
  for (var i = 1u; i < np; i++) {
    let v = MPT[i];
    var j = i;
    while (j > 0u && MPT[j - 1u] > v) { MPT[j] = MPT[j - 1u]; j = j - 1u; }
    MPT[j] = v;
  }
  MNP = np;
}
fn mFogIn(sigF: f32, p: f32, q: f32) -> bool { return sigF > 0.0 && MFAB.x <= p && MFAB.y >= q && MFAB.x < MFAB.y; }
fn mGridIn(i: u32, p: f32, q: f32) -> bool { return MGA[i] <= p && MGB[i] >= q && MGA[i] < MGB[i]; }
struct MEv { hit: bool, t: f32, albedo: vec3f, g: f32 }
// delta tracking: the first real collision on [0, tmax), or none
fn mediaEvent(o: vec3f, d: vec3f, tmax: f32, px: u32, py: u32, s: u32, depth: u32) -> MEv {
  let V = hw(${HW.VOL_OFF}u);
  var ev = MEv(false, 0.0, vec3f(1.0), 0.0);
  mGather(o, d, tmax, V);
  let nG = lu(V);
  var sigF = 0.0;
  if ((lu(V + 1u) & ${VOL.FOG_FLAG}u) != 0u) { sigF = lv(V + 2u); }
  let base = ${VOL.DIM0}u + ${VOL.STRIDE}u * depth;
  var draws = 0u;
  for (var sI = 0u; sI + 1u < MNP; sI++) {
    let p = MPT[sI]; let q = MPT[sI + 1u];
    if (!(q > p)) { continue; }
    let fogC = mFogIn(sigF, p, q);
    var major = select(0.0, sigF, fogC);
    for (var i = 0u; i < nG; i++) { if (mGridIn(i, p, q)) { major = major + gridMajor(i, V); } }
    if (!(major > 0.0)) { continue; }
    var t = p;
    loop {
      if (draws >= ${VOL.MAX_DRAWS}u) { return ev; }
      t = t + (-log(1.0 - vrnd(px, py, s, base + draws))) / major; draws = draws + 1u;
      if (t >= q) { break; }
      let xw = o + d * t;
      var st = select(0.0, sigF, fogC);
      var sg = vec4f(0.0);
      for (var i = 0u; i < nG; i++) { if (mGridIn(i, p, q)) { sg[i] = gridSigma(i, V, xw); } st = st + sg[i]; }
      if (draws >= ${VOL.MAX_DRAWS}u) { return ev; }
      let u2 = vrnd(px, py, s, base + draws); draws = draws + 1u;
      if (!(u2 * major < st)) { continue; }
      var n = select(0u, 1u, fogC);
      var pick = -1;
      for (var i = 0u; i < nG; i++) { if (sg[i] > 0.0) { n = n + 1u; if (!fogC || n > 1u) { pick = i32(i); } } }
      if (n > 1u) {
        if (draws >= ${VOL.MAX_DRAWS}u) { return ev; }
        let uc = vrnd(px, py, s, base + draws) * st; draws = draws + 1u;
        var cum = 0.0; var last = -1;
        pick = -2;
        if (fogC) { cum = sigF; if (uc < cum) { pick = -1; } }
        for (var i = 0u; i < nG; i++) { if (pick == -2 && sg[i] > 0.0) { last = i32(i); cum = cum + sg[i]; if (uc < cum) { pick = i32(i); } } }
        if (pick == -2) { pick = last; }
      }
      ev.hit = true; ev.t = t;
      if (pick < 0) { ev.albedo = vec3f(lv(V + 4u), lv(V + 5u), lv(V + 6u)); ev.g = lv(V + 7u); }
      else { let r = V + ${VOL.HEAD}u + ${VOL.REC}u * u32(pick); ev.albedo = vec3f(lv(r + 16u), lv(r + 17u), lv(r + 18u)); ev.g = lv(r + 19u); }
      return ev;
    }
  }
  return ev;
}
// the transmittance along [0, len]: the fog's exactly, the grids' by ratio tracking
fn mediaTransmit(o: vec3f, d: vec3f, len: f32, px: u32, py: u32, s: u32, depth: u32) -> f32 {
  let V = hw(${HW.VOL_OFF}u);
  mGather(o, d, len, V);
  let nG = lu(V);
  var sigF = 0.0;
  if ((lu(V + 1u) & ${VOL.FOG_FLAG}u) != 0u) { sigF = lv(V + 2u); }
  var T = 1.0;
  if (sigF > 0.0 && MFAB.x < MFAB.y) { T = exp(-sigF * (MFAB.y - MFAB.x)); }
  if (nG == 0u) { return T; }
  let base = ${VOL.SHADOW_DIM0}u + ${VOL.STRIDE}u * depth;
  var draws = 0u;
  for (var sI = 0u; sI + 1u < MNP; sI++) {
    let p = MPT[sI]; let q = MPT[sI + 1u];
    if (!(q > p)) { continue; }
    var major = 0.0;
    for (var i = 0u; i < nG; i++) { if (mGridIn(i, p, q)) { major = major + gridMajor(i, V); } }
    if (!(major > 0.0)) { continue; }
    var t = p;
    loop {
      if (draws >= ${VOL.MAX_DRAWS}u) { return T; }
      t = t + (-log(1.0 - vrnd(px, py, s, base + draws))) / major; draws = draws + 1u;
      if (t >= q) { break; }
      let xw = o + d * t;
      var st = 0.0;
      for (var i = 0u; i < nG; i++) { if (mGridIn(i, p, q)) { st = st + gridSigma(i, V, xw); } }
      T = T * max(0.0, 1.0 - st / major);
    }
  }
  return T;
}
`;

const SURFACE = `
// the surface a hit is on: world normals (instance rows R: n = Rᵀ n_object), uv, the material (an instance may override it), the
// light this triangle is (bits; 0xffffffff = none, RN.3), the object (instance index | 0x80000000, else the triangle's e1.w)
struct Surf { ng: vec3f, ns: vec3f, uv: vec2f, mat: u32, light: u32, obj: u32 }
// MT.1 (RENDER-SPEC § 6.6, pt-ref.js texSurface line for line): box / triplanar mapping and the normal map, in the mesh's own space
struct TexS { uv: vec2f, ns: vec3f }
fn upAxis() -> u32 {
  let u = abs(H[2].xyz);
  if (u.y > u.x) { return select(1u, 2u, u.z > u.y); }
  return select(0u, 2u, u.z > u.x);
}
fn unitAx(i: u32) -> vec3f { var v = vec3f(0.0); v[i] = 1.0; return v; }
fn texSurface(tri: u32, hu: f32, hv: f32, inst: u32, mi: u32, ngW: vec3f, nsIn: vec3f, uvIn: vec2f, pathIx: u32, s: u32, k: u32) -> TexS {
  let mo = mi * ${MAT_VEC4}u;
  let r16 = MAT[mo + 16u];
  let mapping = u32(r16.z);
  let flags = u32(MAT[mo + 3u].w);
  let e1 = TRI[tri * 3u + 1u].xyz;
  let e2 = TRI[tri * 3u + 2u].xyz;
  var uv = uvIn;
  var dpu = vec3f(0.0);
  var dpv = vec3f(0.0);
  var frame = false;
  if (mapping == ${MAPPING.BOX}u || mapping == ${MAPPING.TRIPLANAR}u) {
    let pm = TRI[tri * 3u].xyz + hu * e1 + hv * e2;
    let gr = cross(e1, e2);
    let gl = length(gr);
    let a = select(vec3f(0.0, 0.0, 1.0), abs(gr) / gl, gl > 0.0);
    var ax = 0u;
    if (mapping == ${MAPPING.BOX}u) {
      if (a.y > a.x) { ax = select(1u, 2u, a.z > a.y); } else if (a.z > a.x) { ax = 2u; }
    } else {
      let wv = pow(a, vec3f(r16.w));
      let xi = f32(hash4(pathIx, s, k, ${TEXPROJ_DIM0}u) >> 8u) * (1.0 / 16777216.0) * (wv.x + wv.y + wv.z);
      ax = select(select(2u, 1u, xi < wv.x + wv.y), 0u, xi < wv.x);
    }
    let upA = upAxis();
    var iu = (ax + 1u) % 3u;
    var iv = (ax + 2u) % 3u;
    if (ax != upA) { iu = 3u - ax - upA; iv = upA; }
    uv = vec2f(pm[iu], pm[iv]);
    dpu = unitAx(iu);
    dpv = unitAx(iv);
    frame = true;
  }
  let n = nsIn;
  if ((flags & ${MAT_FLAG.NORMAL_TEX}u) == 0u) { return TexS(uv, n); }
  if (!frame) {
    let A0 = ATTR[tri * 4u]; let A1 = ATTR[tri * 4u + 1u]; let A2 = ATTR[tri * 4u + 2u]; let A3 = ATTR[tri * 4u + 3u];
    let du1 = A1.w - A0.w; let dv1 = A3.y - A3.x; let du2 = A2.w - A0.w; let dv2 = A3.z - A3.x;
    let det = du1 * dv2 - du2 * dv1;
    if (!(abs(det) > 1e-20)) { return TexS(uv, n); }
    dpu = (dv2 * e1 - dv1 * e2) / det;
    dpv = (du1 * e2 - du2 * e1) / det;
  }
  if (inst != NOINST) {
    let b = instBase(inst);
    let r0 = NODE[b].xyz; let r1 = NODE[b + 1u].xyz; let r2 = NODE[b + 2u].xyz;
    dpu = r0 * dpu.x + r1 * dpu.y + r2 * dpu.z;
    dpv = r0 * dpv.x + r1 * dpv.y + r2 * dpv.z;
  }
  if (!(length(dpu) > 0.0) || !(length(dpv) > 0.0)) { return TexS(uv, n); }
  let tw = normalize(dpu);
  let bw = normalize(dpv);
  let tx = textureSampleLevel(TEX, SMP, uv * MAT[mo + 4u].yz, i32(r16.x), 0.0);
  let str = MAT[mo + 17u].x;
  var x = clamp((255.0 * tx.x - 128.0) / 127.0, -1.0, 1.0);
  var y = clamp((255.0 * tx.y - 128.0) / 127.0, -1.0, 1.0);
  let z = sqrt(max(0.0, 1.0 - x * x - y * y));
  x = x * str;
  y = y * str;
  let tr = tw - n * dot(n, tw);
  if (!(length(tr) > 1e-12)) { return TexS(uv, n); }
  let T = normalize(tr);
  var B = cross(n, T);
  if (dot(B, bw) < 0.0) { B = -B; }
  let nr = x * T + y * B + z * n;
  if (!(length(nr) > 0.0)) { return TexS(uv, n); }
  let n2 = normalize(nr);
  if (dot(n, ngW) * dot(n2, ngW) <= 0.0) { return TexS(uv, n); }
  return TexS(uv, n2);
}
fn surfaceAt(h: THit, pathIx: u32, s: u32, k: u32) -> Surf {
  let tri = h.slot;
  let b0 = 1.0 - h.u - h.v;
  var ng = cross(TRI[tri * 3u + 1u].xyz, TRI[tri * 3u + 2u].xyz);
  let A0 = ATTR[tri * 4u]; let A1 = ATTR[tri * 4u + 1u]; let A2 = ATTR[tri * 4u + 2u]; let A3 = ATTR[tri * 4u + 3u];
  var ns = b0 * A0.xyz + h.u * A1.xyz + h.v * A2.xyz;
  var obj = bitcast<u32>(TRI[tri * 3u + 1u].w);
  if (h.inst != NOINST) {
    let b = instBase(h.inst);
    let r0 = NODE[b].xyz; let r1 = NODE[b + 1u].xyz; let r2 = NODE[b + 2u].xyz;
    ng = r0 * ng.x + r1 * ng.y + r2 * ng.z;
    ns = r0 * ns.x + r1 * ns.y + r2 * ns.z;
    obj = bitcast<u32>(NODE[b + 3u].y) | 0x80000000u;
  }
  ng = normalize(ng);
  ns = select(ng, normalize(ns), length(ns) > 0.0);
  let uv = vec2f(b0 * A0.w + h.u * A1.w + h.v * A2.w, b0 * A3.x + h.u * A3.y + h.v * A3.z);
  let mi = instMat(tri, h.inst);
  let mo = mi * ${MAT_VEC4}u;
  if (u32(MAT[mo + 16u].z) != ${MAPPING.UV}u || (u32(MAT[mo + 3u].w) & ${MAT_FLAG.NORMAL_TEX}u) != 0u) {
    let ts = texSurface(tri, h.u, h.v, h.inst, mi, ng, ns, uv, pathIx, s, k);
    return Surf(ng, ts.ns, ts.uv, mi, bitcast<u32>(A3.w), obj);
  }
  return Surf(ng, ns, uv, mi, bitcast<u32>(A3.w), obj);
}
`;

const TEXMAT = `
fn texBase(layer: f32, uv: vec2f) -> vec4f {
  return textureSampleLevel(TEX, SMP, uv, i32(layer), 0.0);
}
// a material at a surface point: its record, with the base colour (and roughness) taken from the texture where it has one
fn toAp1(tx: vec4f) -> vec3f {
  let lin = vec3f(srgbToLinear(tx.x), srgbToLinear(tx.y), srgbToLinear(tx.z));
  return vec3f(dot(vec3f(0.6130973, 0.3395229, 0.0473793), lin), dot(vec3f(0.0701942, 0.9163556, 0.0134526), lin), dot(vec3f(0.0206156, 0.1095698, 0.8698151), lin));
}
fn matAt(mi: u32, uv: vec2f) -> Mat {
  var p = matParams(mi);
  let mo = mi * ${MAT_VEC4}u;
  let m4 = MAT[mo + 4u];
  let mflags = u32(MAT[mo + 3u].w);
  let tuv = uv * m4.yz;
  if ((mflags & ${MAT_FLAG.BASE_TEX}u) != 0u) {
    let tx = texBase(m4.x, tuv);
    p.base = toAp1(tx) * MAT[mo].w;
    if ((mflags & ${MAT_FLAG.ROUGH_TEX}u) != 0u) { p.rough = clamp(tx.w * MAT[mo + 2u].x, 0.0, 1.0); }
  }
  // MT.1 (§ 6.6): the data layer's metalness and opacity, the emission layer's colour, replacing the record's words
  let r16 = MAT[mo + 16u];
  if ((mflags & ${MAT_FLAG.METAL_TEX | MAT_FLAG.OPACITY_TEX}u) != 0u) {
    let td = texBase(r16.x, tuv);
    if ((mflags & ${MAT_FLAG.METAL_TEX}u) != 0u) { p.metal = clamp(td.z, 0.0, 1.0); }
    if ((mflags & ${MAT_FLAG.OPACITY_TEX}u) != 0u) { p.opacity = clamp(td.w, 0.0, 1.0); }
  }
  if ((mflags & ${MAT_FLAG.EMIT_TEX}u) != 0u) { p.emis = toAp1(texBase(r16.y, tuv)) * MAT[mo + 5u].w; }
  return p;
}
`;

const CAUSTIC = `
// RN.7 caustics by light tracing (RENDER-SPEC § 3.3, § 6.9): pt-lights.js emit(), pt-caustic.js connect() and pt-ref.js lightPath() line
// for line. The block is behind the volume header: ldat[ldat[V + 11] + V], V = header word ${HW.VOL_OFF}.
fn rw(i: u32, k: u32) -> f32 { return LD[recBase(i) + k]; }
struct Em { ok: bool, pos: vec3f, dir: vec3f, n: vec3f, alpha: vec3f }
fn emitLight(i: u32, u1: f32, u2: f32, u3: f32, u4: f32) -> Em {
  var E = Em(false, vec3f(0.0), vec3f(0.0, 0.0, 1.0), vec3f(0.0), vec3f(0.0));
  let k = kindOf(i);
  if (k == ${LIGHT.SUN}u) {
    let ax = rv(i, 1u).xyz;
    let omc = 1.0 - rw(i, 7u);
    let ct = 1.0 - u3 * omc;
    let st = sqrt(max(0.0, 1.0 - ct * ct));
    let ph = 2.0 * PI * u4;
    let f1 = basisE1(ax); let f2 = cross(ax, f1);
    let Rd = 1.05 * hf(15u);
    let r = Rd * sqrt(u1); let a = 2.0 * PI * u2;
    E.dir = -(ax * ct + (f1 * cos(ph) + f2 * sin(ph)) * st);
    E.pos = vec3f(hf(12u), hf(13u), hf(14u)) + ax * Rd + (f1 * cos(a) + f2 * sin(a)) * r;
    E.alpha = rv(i, 3u).xyz * PI * Rd * Rd * ct;
    E.ok = true;
    return E;
  }
  if (k == ${LIGHT.POINT}u || k == ${LIGHT.SPOT}u) {
    let spot = k == ${LIGHT.SPOT}u;
    let omc = select(2.0, 1.0 - rw(i, 11u), spot);
    let omega = select(4.0 * PI, 2.0 * PI * omc, spot);
    let ct = select(1.0 - 2.0 * u3, 1.0 - u3 * omc, spot);
    let st = sqrt(max(0.0, 1.0 - ct * ct));
    let ph = 2.0 * PI * u4;
    let ax = rv(i, 2u).xyz;
    let f1 = basisE1(ax); let f2 = cross(ax, f1);
    E.dir = ax * ct + (f1 * cos(ph) + f2 * sin(ph)) * st;
    E.pos = rv(i, 1u).xyz;
    let f = lampFactor(i, k, E.dir);
    if (!(f > 0.0)) { return E; }
    let r = rw(i, 7u);
    E.alpha = rv(i, 3u).xyz * (PI * r * r * f * omega);
    E.ok = true;
    return E;
  }
  var A = 0.0;
  var nn = vec3f(0.0, 0.0, 1.0);
  var side = 1.0;
  var uu = u3;
  let isTri = k == ${LIGHT.TRI}u || k == ${LIGHT.TRI2}u;
  if (isTri) {
    let su = sqrt(u1); let b1 = 1.0 - su; let b2 = u2 * su;
    let e1 = rv(i, 2u).xyz; let e2 = vec3f(rw(i, 1u), rw(i, 2u), rw(i, 3u));
    E.pos = rv(i, 1u).xyz + e1 * b1 + e2 * b2;
    nn = normalize(cross(e1, e2));
    A = rw(i, 7u);
    if (k == ${LIGHT.TRI2}u) { if (u3 < 0.5) { uu = u3 * 2.0; } else { uu = (u3 - 0.5) * 2.0; side = -1.0; } }
  } else if (k == ${LIGHT.AREA}u || k == ${LIGHT.DISC}u) {
    nn = rv(i, 2u).xyz;
    let f1 = basisE1(nn); let f2 = cross(nn, f1);
    var a = 0.0; var b = 0.0;
    if (k == ${LIGHT.AREA}u) { a = (u1 - 0.5) * rw(i, 7u); b = (u2 - 0.5) * rw(i, 11u); A = rw(i, 7u) * rw(i, 11u); }
    else { let r = rw(i, 7u) * sqrt(u1); let ph = 2.0 * PI * u2; a = r * cos(ph); b = r * sin(ph); A = PI * rw(i, 7u) * rw(i, 7u); }
    E.pos = rv(i, 1u).xyz + f1 * a + f2 * b;
  } else { return E; }
  nn = nn * side;
  let e1h = basisE1(nn); let e2h = cross(nn, e1h);
  let r = sqrt(uu); let ph = 2.0 * PI * u4; let z = sqrt(max(0.0, 1.0 - uu));
  E.dir = e1h * (r * cos(ph)) + e2h * (r * sin(ph)) + nn * z;
  E.n = nn;
  if (isTri) { E.alpha = emitted(matParams(u32(rw(i, 11u))), max(1e-4, z)) * (PI * A * select(1.0, 2.0, k == ${LIGHT.TRI2}u)); }
  else { E.alpha = rv(i, 3u).xyz * (PI * A); }
  E.ok = true;
  return E;
}
`;

const CAUSTIC_CONN = `
fn cu32(i: u32) -> u32 { return bitcast<u32>(LD[i]); }
fn crnd(kx: u32, ky: u32, s: u32, v: u32, j: u32) -> f32 { return f32(hash4(kx, ky, s, ${CAUS.DIM0}u + ${CAUS.STRIDE}u * v + j) >> 8u) * (1.0 / 16777216.0); }
struct Cn { ok: bool, px: u32, py: u32, dist: f32, dir: vec3f, w: f32 }
fn connectCam(C: u32, p: vec3f, w: u32, h: u32) -> Cn {
  var o = Cn(false, 0u, 0u, 0.0, vec3f(0.0), 0.0);
  let vx = LD[C + 16u] * p.x + LD[C + 17u] * p.y + LD[C + 18u] * p.z + LD[C + 19u];
  let vy = LD[C + 20u] * p.x + LD[C + 21u] * p.y + LD[C + 22u] * p.z + LD[C + 23u];
  let vz = LD[C + 24u] * p.x + LD[C + 25u] * p.y + LD[C + 26u] * p.z + LD[C + 27u];
  let cx = LD[C] * vx + LD[C + 4u] * vy + LD[C + 8u] * vz + LD[C + 12u];
  let cy = LD[C + 1u] * vx + LD[C + 5u] * vy + LD[C + 9u] * vz + LD[C + 13u];
  let cw = LD[C + 3u] * vx + LD[C + 7u] * vy + LD[C + 11u] * vz + LD[C + 15u];
  if (!(cw > 0.0)) { return o; }
  let nx = cx / cw; let ny = cy / cw;
  if (!(abs(nx) < 1.0 && abs(ny) < 1.0)) { return o; }
  o.px = min(w - 1u, u32(floor((nx + 1.0) * 0.5 * f32(w))));
  o.py = min(h - 1u, u32(floor((1.0 - ny) * 0.5 * f32(h))));
  let Aj = LD[C + 31u];
  if (LD[C + 32u] == 1.0) {
    let depth = -vz;
    if (!(depth > 0.0)) { return o; }
    let d = sqrt(vx * vx + vy * vy + vz * vz);
    let cosC = depth / d;
    o.dist = d;
    o.dir = (vec3f(LD[C + 28u], LD[C + 29u], LD[C + 30u]) - p) / d;
    o.w = 1.0 / (d * d * cosC * cosC * cosC * Aj);
  } else {
    o.dist = -vz;
    if (!(o.dist > 0.0)) { return o; }
    let zr = vec3f(LD[C + 24u], LD[C + 25u], LD[C + 26u]);
    o.dir = zr / length(zr);
    o.w = 1.0 / Aj;
  }
  o.ok = true;
  return o;
}
fn fixedU(v: f32) -> u32 { return u32(clamp(v * ${CAUS.FIXED}.0, 0.0, 4.0e9)); }
`;

const MIS = 'fn mis(a: f32, b: f32) -> f32 { return a * a / (a * a + b * b); }';

const BODY = {
  gen: `
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= PS.tw * PS.th) { return; }
  let px = PS.x0 + i % PS.tw;
  let py = PS.y0 + i / PS.tw;
  let w = PS.w;
  let h = PS.h;
  let s = PS.s;
  let jx = smp(px, py, s, ${DIMS.PIXEL_X}u);
  let jy = smp(px, py, s, ${DIMS.PIXEL_Y}u);
  var l1 = 0.0;
  var l2 = 0.0;
  if (hf(${HW.LENS_R}u) > 0.0) { l1 = smp(px, py, s, ${DIMS.LENS_X}u); l2 = smp(px, py, s, ${DIMS.LENS_Y}u); }
  var tm = 0.0;
  if (hw(${HW.MOTION}u) == 1u) { tm = smp(px, py, s, ${DIMS.TIME}u); }
  let cr = cameraRay(px, py, w, h, jx, jy, l1, l2, tm);
  let o = cr.o;
  let d = cr.d;
  let pix = py * w + px;
  var qi = i;
  // RN.7 adaptive sampling (pass word 7 = 1): converged pixels get no ray; the others are queued without gaps
  if (PS.pad == 1u) {
    if (ACT[pix] == 0u) { return; }
    qi = atomicAdd(&CNT[0], 1u);
  }
  ROUT[qi] = Path(vec4f(o, bitcast<f32>(pix)), vec4f(d, 0.0), vec4f(1.0, 1.0, 1.0, bitcast<f32>(256u)), vec4f(o, 0.0), vec4f(INF, bitcast<f32>(NONE), 0.0, 0.0), vec4f(0.0), vec4f(0.0), vec4f(1.0, 1.0, 1.0, 0.0));
  ACC[pix].w += 1.0;
}`,
  argsB: `
@compute @workgroup_size(1) fn main() {
  let b = atomicLoad(&CNT[3]);
  let par = b & 1u;
  let n = atomicLoad(&CNT[par]);
  ARGS[0] = (n + ${WG - 1}u) / ${WG}u; ARGS[1] = 1u; ARGS[2] = 1u;
  atomicStore(&CNT[1u - par], 0u);
  atomicStore(&CNT[2], 0u);
}`,
  argsS: `
@compute @workgroup_size(1) fn main() {
  let n = atomicLoad(&CNT[2]);
  ARGS[4] = (n + ${WG - 1}u) / ${WG}u; ARGS[5] = 1u; ARGS[6] = 1u;
  atomicAdd(&CNT[3], 1u);
}`,
  isect: `
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let par = atomicLoad(&CNT[3]) & 1u;
  if (g.x >= atomicLoad(&CNT[par])) { return; }
  let P = RIN[g.x];
  let h = traceClosest(P.o.xyz, P.d.xyz, INF);
  // RN.7: a collision in a medium before the surface (or the sky) ends the segment there
  if (mediaOn()) {
    let pixM = bitcast<u32>(P.o.w);
    let ev = mediaEvent(P.o.xyz, P.d.xyz, select(INF, h.t, h.slot != NONE), pixM % PS.w, pixM / PS.w, PS.s, bitcast<u32>(P.beta.w) & 255u);
    if (ev.hit) {
      RIN[g.x].hit = vec4f(ev.t, bitcast<f32>(MEDIUM), 0.0, 0.0);
      RIN[g.x].ng = vec4f(ev.albedo, ev.g);
      return;
    }
  }
  if (h.slot == NONE) { RIN[g.x].hit = vec4f(INF, bitcast<f32>(NONE), 0.0, 0.0); return; }
  let S = surfaceAt(h, bitcast<u32>(P.o.w), PS.s, bitcast<u32>(P.beta.w) & 255u);
  RIN[g.x].hit = vec4f(h.t, bitcast<f32>(S.mat), S.uv.x, S.uv.y);
  RIN[g.x].ng = vec4f(S.ng, bitcast<f32>(S.light));   // the light this triangle is (bits; 0xffffffff = none), RN.3
  RIN[g.x].ns = vec4f(S.ns, bitcast<f32>(S.obj));
}`,
  shade: `
fn pushShadow(o: vec3f, d: vec3f, tmax: f32, c: vec3f, pix: u32, bits: u32, e0: vec3f, e1: vec3f, e2: vec3f) {
  let k = atomicAdd(&CNT[2], 1u);
  SHQ[k] = Shadow(vec4f(o, bitcast<f32>(pix)), vec4f(d, tmax), vec4f(c, bitcast<f32>(bits)), vec4f(e0, 0.0), vec4f(e1, 0.0), vec4f(e2, 0.0));
}
fn finite3(c: vec3f) -> bool { return all(c == c) && all(abs(c) < vec3f(1e30)); }
fn causticsOn() -> bool { let V = hw(${HW.VOL_OFF}u); return V != 0u && (ldu(V + 1u) & ${VOL.CAUSTIC_FLAG}u) != 0u; }
fn addPixel(pix: u32, c: vec3f) {
  if (finite3(c)) { ACC[pix] += vec4f(max(c, vec3f(0.0)), 0.0); }
}
// RN.6 (pt-ref.js add): a contribution to the beauty, its light group and its render element
fn nGroups() -> u32 { return hw(${HW.GROUPS}u); }
fn nElems() -> u32 { return hw(${HW.ELEMENTS}u); }
fn auxAdd(pix: u32, slot: u32, c: vec3f) { AUX[pix * (nGroups() + nElems()) + slot] += vec4f(c, 0.0); }
fn catSlot(c: u32) -> u32 { if (c == 1u) { return 0u; } if (c == 2u) { return 1u; } return 2u; }
fn groupOfL(i: u32) -> u32 { return ldu(hw(${HW.LMETA_OFF}u) + i * 4u + 3u); }
fn contrib(pix: u32, c: vec3f, g: u32, bounces: u32, catv: u32, ratio: vec3f) {
  addPixel(pix, c);
  let nG = nGroups();
  let nE = nElems();
  if (nG + nE == 0u || !finite3(c)) { return; }
  if (nG > 0u) { auxAdd(pix, nE + min(g, nG - 1u), c); }
  if (nE < ${ELEMENT_COUNT}u) { return; }   // 2 = the denoiser's guides only
  if (bounces == 0u) { auxAdd(pix, 8u, c); }
  else { auxAdd(pix, select(3u, 2u, bounces == 1u) + 2u * catSlot(catv), c * ratio); }
}
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let bounce = atomicLoad(&CNT[3]);
  let par = bounce & 1u;
  if (g.x >= atomicLoad(&CNT[par])) { return; }
  let P = RIN[g.x];
  let pix = bitcast<u32>(P.o.w);
  let w = PS.w;
  let px = pix % w;
  let py = pix / w;
  let s = PS.s;
  let flags = bitcast<u32>(P.beta.w);
  let depth = flags & 255u;
  let delta = (flags & 256u) != 0u;
  var chan = (flags >> 9u) & 3u;   // the dispersion channel (0 = all three)
  let dim = ${DIMS.BOUNCE0}u + ${DIMS.PER_BOUNCE}u * depth;
  let ro = P.o.xyz;
  let rd = P.d.xyz;
  var beta = P.beta.xyz;
  let prevPdf = P.d.w;
  let prevP = P.pp.xyz;
  let got = bitcast<u32>(P.hit.y) != NONE;
  let nl = nLights();
  let cbits = bitcast<u32>(P.cat.w);
  var scat = cbits & 255u;
  var catv = (cbits >> 8u) & 7u;
  var recorded = (cbits & 2048u) != 0u;
  var ratio = P.cat.xyz;
  // RN.7: with caustics on, the light a specular chain ends in is the light tracer's (pt-ref.js: sawND, specBefore)
  let sawND = (cbits & 4096u) != 0u;
  let specBefore = (cbits & 8192u) != 0u;
  let csup = causticsOn() && delta && sawND && !specBefore;
  // lamps a BSDF ray meets first
  if (nl > 0u) {
    let lh = lampHit(ro, rd, select(INF, P.hit.x, got));
    if (lh.i != NONE) {
      var wgt = 1.0;
      if (!delta) { wgt = mis(prevPdf, pickProb(lh.i, prevP) * lightPdf(lh.i, prevP, rd, lh.t)); }
      if (!csup) { contrib(pix, beta * lh.L * wgt, groupOfL(lh.i), scat, catv, ratio); }
      return;
    }
  }
  if (bitcast<u32>(P.hit.y) == MEDIUM) {
    // ---- a medium vertex (RENDER-SPEC § 3.1; pt-ref.js): the albedo into the throughput, NEE and a phase sample with MIS ----
    let xp = ro + rd * P.hit.x;
    let travelledM = P.pp.w + P.hit.x;
    let gM = P.ng.w;
    let betaM = beta * P.ng.xyz;
    let nEm = nElems();
    var catM = catv;
    var ratioM = ratio;
    if (nEm >= ${ELEMENT_COUNT}u && scat == 0u) { catM = 1u; ratioM = vec3f(1.0); }
    var pkM = LPick(NOLIGHT, 0.0, 0.0);
    if (nl > 0u) { pkM = pickLight(xp, smp(px, py, s, dim + ${DIMS.LIGHT_PICK}u)); }
    if (pkM.i != NOLIGHT) {
      let lsM = sampleLight(pkM.i, xp, smp(px, py, s, dim + ${DIMS.LIGHT_U}u), smp(px, py, s, dim + ${DIMS.LIGHT_V}u), pkM.u);
      if (lsM.ok) {
        let phM = hgPhase(dot(rd, lsM.wi), gM);
        if (phM > 0.0 && any(lsM.L > vec3f(0.0))) {
          let epsM = 1e-4 * max(1.0, max(abs(xp.x), max(abs(xp.y), abs(xp.z))));
          let tEndM = select(lsM.dist - epsM, INF, lsM.dist >= INF);
          if (tEndM > 0.0) {
            let plM = pkM.prob * lsM.pdf;
            let kLM = betaM * lsM.L * (phM * mis(plM, phM) / plM);
            var bitsM = groupOfL(pkM.i) | (depth << 13u);
            var e0M = vec3f(0.0);
            if (nEm >= ${ELEMENT_COUNT}u) { bitsM = bitsM | ((select(3u, 2u, scat == 0u) + 2u * catSlot(catM)) << 9u); e0M = kLM * ratioM; }
            pushShadow(xp, lsM.wi, tEndM, kLM, pix, bitsM, e0M, vec3f(0.0), vec3f(0.0));
          }
        }
      }
    }
    if (depth >= u32(H[13].w)) { return; }
    let cT = hgSampleCos(smp(px, py, s, dim + ${DIMS.BSDF_U}u), gM);
    let sT = sqrt(max(0.0, 1.0 - cT * cT));
    let phiM = 2.0 * PI * smp(px, py, s, dim + ${DIMS.BSDF_V}u);
    let e1M = basisE1(rd);
    let e2M = cross(rd, e1M);
    let ndM = rd * cT + e1M * (cos(phiM) * sT) + e2M * (sin(phiM) * sT);
    var betaN = betaM;
    if (depth >= ${RR_START}u) {
      let qM = clamp(max(betaN.x, max(betaN.y, betaN.z)), 0.05, 0.95);
      if (smp(px, py, s, dim + ${DIMS.RR}u) >= qM) { return; }
      betaN = betaN / qM;
    }
    if (!any(betaN > vec3f(0.0))) { return; }
    let kM = atomicAdd(&CNT[1u - par], 1u);
    let nfM = (depth + 1u) | (chan << 9u);
    let cbM = min(scat + 1u, 255u) | (catM << 8u) | select(0u, 2048u, recorded) | (cbits & 12288u);
    ROUT[kM] = Path(vec4f(xp, bitcast<f32>(pix)), vec4f(ndM, hgPhase(cT, gM)), vec4f(betaN, bitcast<f32>(nfM)), vec4f(xp, travelledM), vec4f(INF, bitcast<f32>(NONE), 0.0, 0.0), vec4f(0.0), vec4f(0.0), vec4f(ratioM, bitcast<f32>(cbM)));
    return;
  }
  if (!got) {
    var env = envRad(rd);
    var we = 1.0;
    let ei = bitcast<u32>(H[2].w);
    if (!delta && ei != NOLIGHT) { we = mis(prevPdf, pickProb(ei, prevP) * envPdf(prevP, rd)); }
    contrib(pix, beta * env * we, select(0u, groupOfL(ei), ei != NOLIGHT), scat, catv, ratio);
    let si = bitcast<u32>(H[14].w);
    if (si != NOLIGHT && depth > 0u) {
      let L1 = rv(si, 1u);
      if (dot(rd, L1.xyz) >= L1.w) {
        let omega = 2.0 * PI * (1.0 - L1.w);
        var ws = 1.0;
        if (!delta) { ws = mis(prevPdf, pickProb(si, prevP) / omega); }
        if (!csup) { contrib(pix, beta * rv(si, 3u).xyz / omega * ws, groupOfL(si), scat, catv, ratio); }
      }
    }
    return;
  }
  let travelled = P.pp.w + P.hit.x;
  // the surface (found by the intersect stage)
  let sp = ro + rd * P.hit.x;
  let ng = P.ng.xyz;
  let ns = P.ns.xyz;
  let uv = P.hit.zw;
  let mi = bitcast<u32>(P.hit.y);
  var p = matAt(mi, uv);
  let front = dot(ng, rd) < 0.0;
  let eps = 1e-4 * max(1.0, max(abs(sp.x), max(abs(sp.y), abs(sp.z))));
  // leaving a coloured solid: Beer–Lambert over the segment just travelled inside it
  if (!front && !p.thin && p.beer) { beta = beta * exp(-p.extinct * P.hit.x); }
  // a cut-out (geometry_opacity): the path passes straight through, its MIS state kept
  if (p.opacity < 1.0 && smp(px, py, s, dim + ${DIMS.OPACITY}u) >= p.opacity) {
    let gs0 = select(-1.0, 1.0, dot(ng, rd) >= 0.0);
    let k0 = atomicAdd(&CNT[1u - par], 1u);
    ROUT[k0] = Path(vec4f(sp + ng * eps * gs0, bitcast<f32>(pix)), P.d, vec4f(beta, bitcast<f32>((depth + 1u) | (flags & 0xffffff00u))), vec4f(P.pp.xyz, travelled), vec4f(INF, bitcast<f32>(NONE), 0.0, 0.0), vec4f(0.0), vec4f(0.0), P.cat);
    return;
  }
  // emission (camera and BSDF rays; the emitter's front, or both sides of a thin sheet)
  if (front || p.thin) {
    let em = emitted(p, abs(dot(ng, rd)));
    if (any(em > vec3f(0.0))) {
      // an emissive triangle that is a light: MIS against sampling it (RN.3); else the BSDF ray alone finds it
      let tl = bitcast<u32>(P.ng.w);
      var wgt = 1.0;
      if (!delta && tl != 0xffffffffu) { wgt = mis(prevPdf, pickProb(tl, prevP) * lightPdf(tl, prevP, rd, P.hit.x)); }
      if (!(csup && tl != 0xffffffffu)) { contrib(pix, beta * em * wgt, select(hw(${HW.GLOW_GROUP}u), groupOfL(tl), tl != 0xffffffffu), scat, catv, ratio); }
    }
  }
  // dispersion: the first dispersive glass picks one wavelength for the rest of the path
  if (chan == 0u && p.cauchyB > 0.0 && p.trans > 0.0 && !p.thin) {
    chan = 1u + min(2u, u32(floor(smp(px, py, s, dim + ${DIMS.DISPERSION}u) * 3.0)));
    beta = beta * 3.0 * vec3f(select(0.0, 1.0, chan == 1u), select(0.0, 1.0, chan == 2u), select(0.0, 1.0, chan == 3u));
  }
  var n = ns;
  if (dot(n, rd) > 0.0) { n = -n; }
  let e1 = basisE1(n);
  let e2 = cross(n, e1);
  let wo = -rd;
  var woL = vec3f(dot(wo, e1), dot(wo, e2), dot(wo, n));
  if (woL.z <= 0.0) { woL.z = 1e-6; }
  let nE = nElems();
  // the guides (albedo, normal, depth, ids) at the first surface that is not a perfect mirror or clear glass
  if (nE > 0u && !recorded && !(isSmooth(p) && (p.metal > 0.5 || p.trans > 0.5))) {
    recorded = true;
    auxAdd(pix, 0u, min(vec3f(1.0), (1.0 - p.trans) * p.base + p.trans * p.tcol));
    AUX[pix * (nGroups() + nE)].w += 1.0;
    AUX[pix * (nGroups() + nE) + 1u] += vec4f(n, travelled);
    if (s == 0u && nE >= ${ELEMENT_COUNT}u) {
      let raw = bitcast<u32>(P.ns.w);
      let inst = (raw & 0x80000000u) != 0u;
      let idx = raw & 0x7fffffffu;
      let idf = select(f32(idx) + 1.0, -1.0, !inst && raw == ${GROUND_OBJ}u);
      AUX[pix * (nGroups() + nE) + 9u] = vec4f(idf, f32(mi + 1u), select(0.0, 1.0, inst), 1.0);
    }
  }

  // NEE
  var pk0 = LPick(NOLIGHT, 0.0, 0.0);
  if (nl > 0u) { pk0 = pickLight(sp, smp(px, py, s, dim + ${DIMS.LIGHT_PICK}u)); }
  if (pk0.i != NOLIGHT) {
    let li = pk0.i;
    let pick = pk0.prob;
    let ls = sampleLight(li, sp, smp(px, py, s, dim + ${DIMS.LIGHT_U}u), smp(px, py, s, dim + ${DIMS.LIGHT_V}u), pk0.u);
    if (ls.ok) {
      let wiL = vec3f(dot(ls.wi, e1), dot(ls.wi, e2), dot(ls.wi, n));
      let ev = evalBsdf(p, front, chan, woL, wiL);
      if (any(ev.xyz > vec3f(0.0)) && any(ls.L > vec3f(0.0))) {
        let gs = select(-1.0, 1.0, dot(ng, ls.wi) >= 0.0);
        let pl = pick * ls.pdf;
        let kL = beta * ls.L * mis(pl, ev.w) / pl;
        let c = ev.xyz * kL;
        var bits = groupOfL(li) | (depth << 13u);
        var e0 = vec3f(0.0);
        var e1s = vec3f(0.0);
        var e2s = vec3f(0.0);
        if (nE >= ${ELEMENT_COUNT}u && scat == 0u) {
          // the first bounce's direct light split by category (diffuse, specular, transmission)
          bits = bits | 256u;
          e0 = evalBsdfM(p, front, chan, woL, wiL, 1u).xyz * kL;
          e1s = evalBsdfM(p, front, chan, woL, wiL, 2u).xyz * kL;
          e2s = evalBsdfM(p, front, chan, woL, wiL, 4u).xyz * kL;
        } else if (nE >= ${ELEMENT_COUNT}u) { bits = bits | ((3u + 2u * catSlot(catv)) << 9u); e0 = c * ratio; }
        // the segment ends short of the light by the origin's own offset (an emissive triangle never shadows itself)
        let tEnd = select(ls.dist - dot(ng * eps * gs, ls.wi) - eps, INF, ls.dist >= INF);
        if (tEnd > 0.0) { pushShadow(sp + ng * eps * gs, ls.wi, tEnd, c, pix, bits, e0, e1s, e2s); }
      }
    }
  }
  let maxB = u32(H[13].w);
  if (depth >= maxB) { return; }
  let bs = sampleBsdf(p, front, chan, woL, smp(px, py, s, dim + ${DIMS.BSDF_U}u), smp(px, py, s, dim + ${DIMS.BSDF_V}u), smp(px, py, s, dim + ${DIMS.LOBE}u));
  if (!bs.ok) { return; }
  let nd = e1 * bs.wi.x + e2 * bs.wi.y + n * bs.wi.z;
  beta = beta * bs.w;
  // the first bounce fixes the path's category (pt-ref.js): a delta lobe's own, else one picked by its share of f
  if (scat == 0u && nE >= ${ELEMENT_COUNT}u) {
    if (bs.delta) { catv = catOfK(LASTK, bs.wi.z); ratio = vec3f(1.0); }
    else {
      let fD = evalBsdfM(p, front, chan, woL, bs.wi, 1u).xyz;
      let fS = evalBsdfM(p, front, chan, woL, bs.wi, 2u).xyz;
      let fT = evalBsdfM(p, front, chan, woL, bs.wi, 4u).xyz;
      let q = vec3f(max(0.0, lum(fD)), max(0.0, lum(fS)), max(0.0, lum(fT)));
      let tot = q.x + q.y + q.z;
      var u = smp(px, py, s, dim + ${DIMS.SPARE}u) * tot;
      var c = 0u;
      if (u >= q.x) { u -= q.x; c = 1u; if (u >= q.y) { c = 2u; } }
      catv = 1u << c;
      let qc = select(1.0, q[c] / tot, tot > 0.0);
      var F = fD;
      if (c == 1u) { F = fS; } else if (c == 2u) { F = fT; }
      let fall = evalBsdf(p, front, chan, woL, bs.wi).xyz;
      ratio = select(vec3f(0.0), F / max(fall, vec3f(1e-30)) / qc, (fall > vec3f(0.0)) & vec3<bool>(qc > 0.0));
    }
  }
  scat = scat + 1u;
  let straight = bs.delta && p.thin && (abs(nd.x + wo.x) + abs(nd.y + wo.y) + abs(nd.z + wo.z)) < 1e-6;
  var npdf = bs.pdf;
  var ndelta = bs.delta;
  var npp = sp;
  if (straight) { npdf = prevPdf; ndelta = delta; npp = prevP; }
  if (depth >= ${RR_START}u) {
    let q = clamp(max(beta.x, max(beta.y, beta.z)), 0.05, 0.95);
    if (smp(px, py, s, dim + ${DIMS.RR}u) >= q) { return; }
    beta = beta / q;
  }
  if (!any(beta > vec3f(0.0))) { return; }
  let gs = select(-1.0, 1.0, dot(ng, nd) >= 0.0);
  let k = atomicAdd(&CNT[1u - par], 1u);
  let nf = (depth + 1u) | select(0u, 256u, ndelta) | (chan << 9u);
  var sawND2 = sawND;
  var spec2 = specBefore;
  if (!straight) { if (bs.delta) { if (!sawND2) { spec2 = true; } } else { sawND2 = true; } }
  let cb = min(scat, 255u) | (catv << 8u) | select(0u, 2048u, recorded) | select(0u, 4096u, sawND2) | select(0u, 8192u, spec2);
  ROUT[k] = Path(vec4f(sp + ng * eps * gs, bitcast<f32>(pix)), vec4f(nd, npdf), vec4f(beta, bitcast<f32>(nf)), vec4f(npp, travelled), vec4f(INF, bitcast<f32>(NONE), 0.0, 0.0), vec4f(0.0), vec4f(0.0), vec4f(ratio, bitcast<f32>(cb)));
}`,
  shadow: `
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= atomicLoad(&CNT[2])) { return; }
  let S = SHQ[g.x];
  let r0 = traceTransmit(S.o.xyz, S.d.xyz, S.d.w);
  if (r0.w < 0.0) { return; }
  let pix = bitcast<u32>(S.o.w);
  let bits = bitcast<u32>(S.c.w);
  var rt = r0.xyz;
  // RN.7: the media on the way (the fog exactly, grids by ratio tracking)
  if (mediaOn()) { rt = rt * mediaTransmit(S.o.xyz, S.d.xyz, S.d.w, pix % PS.w, pix / PS.w, PS.s, (bits >> 13u) & 255u); }
  let c = S.c.xyz * rt;
  if (!(all(c == c) && all(abs(c) < vec3f(1e30)))) { return; }
  ACC[pix] += vec4f(max(c, vec3f(0.0)), 0.0);
  // RN.6: the light group and the render elements
  let nG = hw(${HW.GROUPS}u);
  let nE = hw(${HW.ELEMENTS}u);
  if (nG + nE == 0u) { return; }
  let base = pix * (nG + nE);
  if (nG > 0u) { AUX[base + nE + min(bits & 255u, nG - 1u)] += vec4f(c, 0.0); }
  if (nE < ${ELEMENT_COUNT}u) { return; }
  if ((bits & 256u) != 0u) {
    AUX[base + 2u] += vec4f(S.e0.xyz * rt, 0.0);
    AUX[base + 4u] += vec4f(S.e1.xyz * rt, 0.0);
    AUX[base + 6u] += vec4f(S.e2.xyz * rt, 0.0);
  } else {
    let slot = (bits >> 9u) & 15u;
    if (slot != 0u) { AUX[base + slot] += vec4f(S.e0.xyz * rt, 0.0); }
  }
}`,
  lgen: `
// the light paths of a chunk (pt-ref.js lightPath, the start): pass x0 = the first path's index, tw = paths in this dispatch
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= PS.tw) { return; }
  let k = PS.x0 + g.x;
  let kx = k & 0xffffu;
  let ky = k >> 16u;
  let s = PS.s;
  let V = hw(${HW.VOL_OFF}u);
  let C = V + cu32(V + 11u);
  let n = u32(LD[C + 33u]);
  var lo = 0u;
  var hi = n - 1u;
  let uPick = crnd(kx, ky, s, 0u, 0u);
  loop {
    if (lo >= hi) { break; }
    let m = (lo + hi) >> 1u;
    if (LD[C + 36u + n + m + 1u] > uPick) { hi = m; } else { lo = m + 1u; }
  }
  let li = cu32(C + 36u + lo);
  let prob = LD[C + 36u + n + lo + 1u] - LD[C + 36u + n + lo];
  if (!(prob > 0.0)) { return; }
  let E = emitLight(li, crnd(kx, ky, s, 0u, 1u), crnd(kx, ky, s, 0u, 2u), crnd(kx, ky, s, 0u, 3u), crnd(kx, ky, s, 0u, 4u));
  if (!E.ok) { return; }
  // (the albedo tables are declared by the shared BSDF source; reading one keeps the binding in this stage's layout)
  let beta = E.alpha / prob * (1.0 + TAB[0].x * 0.0);
  if (!any(beta > vec3f(0.0))) { return; }
  let e0 = 1e-4 * max(1.0, max(abs(E.pos.x), max(abs(E.pos.y), abs(E.pos.z))));
  let qi = atomicAdd(&CNT[0], 1u);
  ROUT[qi] = Path(vec4f(E.pos + E.n * e0, bitcast<f32>(k)), vec4f(E.dir, 0.0), vec4f(beta, bitcast<f32>(1u)), vec4f(0.0), vec4f(INF, bitcast<f32>(NONE), 0.0, 0.0), vec4f(0.0), vec4f(0.0), vec4f(0.0));
}`,
  lshade: `
// one vertex of every light path in the queue (pt-ref.js lightPath, the loop body); flags = vertex v (bits 0–7) | specular bounces so far
// (8–15) | dispersion channel (16–17). The camera connection is kept in the path's own slot; cconn finishes it.
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let par = atomicLoad(&CNT[3]) & 1u;
  if (g.x >= atomicLoad(&CNT[par])) { return; }
  let q = RIN[g.x];
  if (bitcast<u32>(q.hit.y) == NONE) { return; }   // the path left the scene
  let k = bitcast<u32>(q.o.w);
  let kx = k & 0xffffu;
  let ky = k >> 16u;
  let s = PS.s;
  let w = PS.w;
  let h = PS.h;
  let fl = bitcast<u32>(q.beta.w);
  let v = fl & 255u;
  let spec = (fl >> 8u) & 255u;
  var chan = (fl >> 16u) & 3u;
  var beta = q.beta.xyz;
  let ro = q.o.xyz;
  let rd = q.d.xyz;
  let maxB = u32(H[13].w);
  let sp = ro + rd * q.hit.x;
  let ng = q.ng.xyz;
  let p = matAt(bitcast<u32>(q.hit.y), q.hit.zw);
  let front = dot(ng, rd) < 0.0;
  let eps = 1e-4 * max(1.0, max(abs(sp.x), max(abs(sp.y), abs(sp.z))));
  if (!front && !p.thin && p.beer) { beta = beta * exp(-p.extinct * q.hit.x); }
  if (p.opacity < 1.0 && crnd(kx, ky, s, v, 4u) >= p.opacity) {
    if (v + 1u > maxB) { return; }
    let gs0 = select(-1.0, 1.0, dot(ng, rd) >= 0.0);
    let kc = atomicAdd(&CNT[1u - par], 1u);
    ROUT[kc] = Path(vec4f(sp + ng * eps * gs0, q.o.w), q.d, vec4f(beta, bitcast<f32>((v + 1u) | (spec << 8u) | (chan << 16u))), vec4f(0.0), vec4f(INF, bitcast<f32>(NONE), 0.0, 0.0), vec4f(0.0), vec4f(0.0), vec4f(0.0));
    return;
  }
  if (chan == 0u && p.cauchyB > 0.0 && p.trans > 0.0 && !p.thin) {
    chan = 1u + min(2u, u32(floor(crnd(kx, ky, s, v, 5u) * 3.0)));
    beta = beta * 3.0 * vec3f(select(0.0, 1.0, chan == 1u), select(0.0, 1.0, chan == 2u), select(0.0, 1.0, chan == 3u));
  }
  var nrm = q.ns.xyz;
  if (dot(nrm, rd) > 0.0) { nrm = -nrm; }
  let e1 = basisE1(nrm);
  let e2 = cross(nrm, e1);
  let wo = -rd;
  var woL = vec3f(dot(wo, e1), dot(wo, e2), dot(wo, nrm));
  if (woL.z <= 0.0) { woL.z = 1e-6; }
  // a vertex that sees the camera (after a specular bounce) keeps its connection in the path's slot
  if (spec > 0u) {
    let V = hw(${HW.VOL_OFF}u);
    if (connectCam(V + cu32(V + 11u), sp, w, h).ok) {
      CQ[k * maxB + (v - 1u)] = CQrec(vec4f(sp, bitcast<f32>(select(0u, 1u, front) | (chan << 1u))), vec4f(ng, q.hit.y), vec4f(q.ns.xyz, q.hit.z), vec4f(rd, q.hit.w), vec4f(beta, 1.0));
    }
  }
  if (v >= maxB) { return; }
  let bs = sampleBsdf(p, front, chan, woL, crnd(kx, ky, s, v, 0u), crnd(kx, ky, s, v, 1u), crnd(kx, ky, s, v, 2u));
  if (!bs.ok) { return; }
  let nd = e1 * bs.wi.x + e2 * bs.wi.y + nrm * bs.wi.z;
  beta = beta * bs.w;
  let straight = bs.delta && p.thin && (abs(nd.x + wo.x) + abs(nd.y + wo.y) + abs(nd.z + wo.z)) < 1e-6;
  var spec2 = spec;
  if (!straight) {
    if (bs.delta) { spec2 = spec + 1u; } else if (spec == 0u) { return; }   // a path whose first vertex scatters diffusely is the eye path's
  }
  if (v >= ${RR_START}u) {
    let qq = clamp(max(beta.x, max(beta.y, beta.z)), 0.05, 0.95);
    if (crnd(kx, ky, s, v, 3u) >= qq) { return; }
    beta = beta / qq;
  }
  if (!any(beta > vec3f(0.0))) { return; }
  let gs2 = select(-1.0, 1.0, dot(ng, nd) >= 0.0);
  let kn = atomicAdd(&CNT[1u - par], 1u);
  ROUT[kn] = Path(vec4f(sp + ng * eps * gs2, q.o.w), vec4f(nd, 0.0), vec4f(beta, bitcast<f32>((v + 1u) | (spec2 << 8u) | (chan << 16u))), vec4f(0.0), vec4f(INF, bitcast<f32>(NONE), 0.0, 0.0), vec4f(0.0), vec4f(0.0), vec4f(0.0));
}`,
  cconn: `
// the queued camera connections (pt-ref.js lightPath, the connect block): the BSDF toward the camera, the segment's visibility, the splat
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= PS.tw * u32(H[13].w)) { return; }
  let q = CQ[g.x];
  if (q.e.w == 0.0) { return; }
  let w = PS.w;
  let h = PS.h;
  let V = hw(${HW.VOL_OFF}u);
  let C = V + cu32(V + 11u);
  let NL = f32(PS.th);
  let sp = q.a.xyz;
  let fl = bitcast<u32>(q.a.w);
  let front = (fl & 1u) != 0u;
  let chan = fl >> 1u;
  let ng = q.b.xyz;
  let p = matAt(bitcast<u32>(q.b.w), vec2f(q.c.w, q.d.w));
  var nrm = q.c.xyz;
  let rd = q.d.xyz;
  if (dot(nrm, rd) > 0.0) { nrm = -nrm; }
  let e1 = basisE1(nrm);
  let e2 = cross(nrm, e1);
  let wo = -rd;
  var woL = vec3f(dot(wo, e1), dot(wo, e2), dot(wo, nrm));
  if (woL.z <= 0.0) { woL.z = 1e-6; }
  let cn = connectCam(C, sp, w, h);
  if (!cn.ok) { return; }
  let wc = vec3f(dot(cn.dir, e1), dot(cn.dir, e2), dot(cn.dir, nrm));
  let ev = evalBsdf(p, front, chan, wc, woL);
  let cosC = abs(wc.z);
  if (!(any(ev.xyz > vec3f(0.0)) && cosC > 0.0)) { return; }
  let eps = 1e-4 * max(1.0, max(abs(sp.x), max(abs(sp.y), abs(sp.z))));
  let gs1 = select(-1.0, 1.0, dot(ng, cn.dir) >= 0.0);
  let tr = traceTransmit(sp + ng * eps * gs1, cn.dir, cn.dist - eps);
  if (tr.w < 0.0) { return; }
  let c = q.e.xyz * ev.xyz * tr.xyz * (cn.w * cosC / max(1e-6, abs(woL.z)) / NL);
  if (all(c == c) && all(abs(c) < vec3f(1e30))) {
    let idx = (cn.py * w + cn.px) * 3u;
    atomicAdd(&CSP[idx], fixedU(c.x));
    atomicAdd(&CSP[idx + 1u], fixedU(c.y));
    atomicAdd(&CSP[idx + 2u], fixedU(c.z));
  }
}`,
  cmerge: `
// the light tracer's splats of this sample (fixed point) into the accumulation, and the splat buffer back to zero
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= PS.w * PS.h) { return; }
  let c = vec3f(f32(atomicExchange(&CSP[i * 3u], 0u)), f32(atomicExchange(&CSP[i * 3u + 1u], 0u)), f32(atomicExchange(&CSP[i * 3u + 2u], 0u))) * (1.0 / ${CAUS.FIXED}.0);
  ACC[i] += vec4f(c, 0.0);
}`,
  adapt: `
// RN.7, pt-adapt.js update(): the pass mean's luminance, the standard error of the mean of the pass means against the picture
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= PS.w * PS.h) { return; }
  if (ACT[i] == 0u) { return; }
  let a = ACC[i];
  var st = ADP[i];
  let dn = a.w - st.w;
  if (!(dn > 0.0)) { atomicAdd(&CNT[4], 1u); return; }
  let Y = lum(a.xyz);
  let m = (Y - st.z) / dn;
  st = vec4f(st.x + m, st.y + m * m, Y, a.w);
  ADP[i] = st;
  let J = round(a.w / AD.w);
  var stay = true;
  if (J >= AD.z) {
    let mu = st.x / J;
    let v = max(0.0, (st.y - st.x * st.x / J) / (J - 1.0));
    if (sqrt(v / J) <= AD.x * (mu + AD.y)) { stay = false; }
  }
  if (stay) { atomicAdd(&CNT[4], 1u); } else { ACT[i] = 0u; }
}`,
  resolve: `
fn aces(c: vec3f, ex: f32) -> vec3f {
  let k = exp2(ex) / 0.6;
  let v0 = c * k;
  let v = vec3f(dot(vec3f(0.59719, 0.35458, 0.04823), v0), dot(vec3f(0.07600, 0.90834, 0.01566), v0), dot(vec3f(0.02840, 0.13383, 0.83777), v0));
  let f = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
  let o = vec3f(dot(vec3f(1.60475, -0.53108, -0.07367), f), dot(vec3f(-0.10208, 1.10813, -0.00605), f), dot(vec3f(-0.00327, -0.07276, 1.07602), f));
  return clamp(o, vec3f(0.0), vec3f(1.0));
}
fn oetf(c: f32) -> f32 { return select(1.055 * pow(c, 1.0 / 2.4) - 0.055, 12.92 * c, c <= 0.0031308); }
// RN.8 (pt-post.js, per pixel: the previews; bloom, glare and the LUT come with the finished picture)
fn rows(r0: vec3f, r1: vec3f, r2: vec3f, v: vec3f) -> vec3f { return vec3f(dot(r0, v), dot(r1, v), dot(r2, v)); }
fn agxCurve(x: vec3f) -> vec3f { let x2 = x * x; let x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; }
fn agx(c: vec3f) -> vec3f {
  var v = rows(vec3f(0.6274, 0.3293, 0.0433), vec3f(0.0691, 0.9195, 0.0113), vec3f(0.0164, 0.088, 0.8956), c);
  v = rows(vec3f(0.856627153315983, 0.0951212405381588, 0.0482516061458583), vec3f(0.137318972929847, 0.761241990602591, 0.101439036467562), vec3f(0.11189821299995, 0.0767994186031903, 0.811302368396859), v);
  v = agxCurve(clamp((log2(max(v, vec3f(1e-10))) + 12.47393) / (4.026069 + 12.47393), vec3f(0.0), vec3f(1.0)));
  v = rows(vec3f(1.1271005818144368, -0.11060664309660323, -0.016493938717834573), vec3f(-0.1413297634984383, 1.157823702216272, -0.016493938717834257), vec3f(-0.14132976349843826, -0.11060664309660294, 1.2519364065950405), v);
  v = pow(max(v, vec3f(0.0)), vec3f(2.2));
  return clamp(rows(vec3f(1.6605, -0.5876, -0.0728), vec3f(-0.1246, 1.1329, -0.0083), vec3f(-0.0182, -0.1006, 1.1187), v), vec3f(0.0), vec3f(1.0));
}
fn hable(x: vec3f) -> vec3f { return ((x * (0.15 * x + 0.05) + 0.004) / (x * (0.15 * x + 0.5) + 0.06)) - 0.02 / 0.3; }
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let w = bitcast<u32>(H[15].x);
  let h = bitcast<u32>(H[15].y);
  if (g.x >= w * h) { return; }
  let a = ACC[g.x];
  let m = a.xyz / max(1.0, a.w) * VW[1].xyz;
  var lin = max(vec3f(dot(vec3f(1.7050510, -0.6217921, -0.0832590), m), dot(vec3f(-0.1302564, 1.1408047, -0.0105483), m), dot(vec3f(-0.0240034, -0.1289690, 1.1529724), m)), vec3f(0.0));
  lin = lin * exp2(VW[0].x);
  let vig = VW[1].w;
  if (vig > 0.0) {
    let cx = f32(w - 1u) / 2.0;
    let cy = f32(h - 1u) / 2.0;
    let rr = length(vec2f(f32(g.x % w) - cx, f32(g.x / w) - cy)) / max(length(vec2f(cx, cy)), 1.0);
    let tt = clamp((rr - 0.2) / 0.8, 0.0, 1.0);
    lin = lin * (1.0 - vig * tt * tt * (3.0 - 2.0 * tt));
  }
  let hs = VW[0].w * 2.0;
  if (hs > 0.0) { let L = dot(vec3f(0.2126, 0.7152, 0.0722), lin); if (L > 1.0) { lin = lin * ((1.0 + (L - 1.0) / (1.0 + (L - 1.0) * hs)) / L); } }
  if (VW[0].z != 0.0) { lin = 0.18 * pow(lin / 0.18, vec3f(1.0 + VW[0].z)); }
  let kind = u32(VW[0].y);
  var t = aces(lin, 0.0);
  if (kind == 1u) { t = agx(lin); } else if (kind == 2u) { t = clamp(hable(2.0 * lin) / hable(vec3f(11.2)), vec3f(0.0), vec3f(1.0)); } else if (kind == 3u) { t = clamp(lin, vec3f(0.0), vec3f(1.0)); }
  let r = u32(round(oetf(t.x) * 255.0));
  let gg = u32(round(oetf(t.y) * 255.0));
  let b = u32(round(oetf(t.z) * 255.0));
  OUT[g.x] = r | (gg << 8u) | (b << 16u) | (255u << 24u);
}`,
};

const NEEDS = {
  gen: [MATH, SAMPLER, HDR, CAMERA],
  argsB: [],
  argsS: [],
  isect: [MATH, HDR, TRAVERSE, TRACE_CLOSEST, SURFACE, MEDIA],
  shade: [MATH, SAMPLER, HDR, BSDF_CORE, BSDF, LIGHTS, MIS, PHASE, TEXMAT],
  shadow: [MATH, TRAVERSE, HDR, BSDF_CORE, TRACE_TRANSMIT, MEDIA],
  resolve: [],
  adapt: [MATH],
  lgen: [MATH, HDR, BSDF_CORE, BSDF, LIGHTS, CAUSTIC, CAUSTIC_CONN],
  lshade: [MATH, HDR, BSDF_CORE, BSDF, TEXMAT, CAUSTIC_CONN],
  cconn: [MATH, HDR, TRAVERSE, TRACE_TRANSMIT, BSDF_CORE, BSDF, TEXMAT, CAUSTIC_CONN],
  cmerge: [],
};

/** One stage's whole WGSL module. */
export function stageSource(stage) {
  if (!BODY[stage]) throw new Error('unknown stage ' + stage);   // i18n-ignore: a programming error, never shown
  return [STRUCTS, decls(stage), ...NEEDS[stage], BODY[stage]].join('\n');
}
export const STAGES = Object.keys(BODY);

/**
 * A test kernel (not used by the renderer): the WGSL BSDF evaluated and sampled for a list of cases, so a browser test compares
 * it value by value with pt-bsdf.js. Bindings: 0 MAT (storage), 1 TAB (uniform), 2 IN (cases: 3 × vec4 — wo.xyz + front,
 * wi.xyz + chan, (u1, u2, uL, material)), 3 OUT (3 × vec4 — eval rgb + pdf, sampled wi + delta, weight rgb + pdf).
 */
export function bsdfTestSource() {
  return [STRUCTS,
    '@group(0) @binding(0) var<storage, read> MAT: array<vec4f>;',
    `@group(0) @binding(1) var<uniform> TAB: array<vec4f, ${Math.ceil(TABLE_FLOATS / 4)}>;`,
    '@group(0) @binding(2) var<storage, read> IN: array<vec4f>;',
    '@group(0) @binding(3) var<storage, read_write> OUT: array<vec4f>;',
    MATH, BSDF_CORE, BSDF, `
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let n = arrayLength(&IN) / 3u;
  if (g.x >= n) { return; }
  let a = IN[g.x * 3u]; let b = IN[g.x * 3u + 1u]; let c = IN[g.x * 3u + 2u];
  let p = matParams(u32(c.w));
  let front = a.w > 0.5;
  let chan = u32(b.w);
  let ev = evalBsdf(p, front, chan, a.xyz, b.xyz);
  let bs = sampleBsdf(p, front, chan, a.xyz, c.x, c.y, c.z);
  OUT[g.x * 3u] = ev;
  OUT[g.x * 3u + 1u] = vec4f(bs.wi, select(0.0, 1.0, bs.delta) + select(0.0, 2.0, bs.ok));
  OUT[g.x * 3u + 2u] = vec4f(bs.w, bs.pdf);
}`].join('\n');
}
