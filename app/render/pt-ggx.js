/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-ggx.js — the surface-scattering pieces the OpenPBR model is built from (0.7 RN.2; RENDER-SPEC § 5.1). No DOM, no imports
 * but pt-spec.js; every function takes numbers and writes into caller arrays (KICKOFF rule 18). pt-wgsl.js has the same
 * functions line for line.
 *
 *   frDielectric(cos, eta)                    unpolarised Fresnel of a dielectric interface (eta = n_t / n_i; cos may be < 0)
 *   schlick(f0, cos), f82(f0, tint, cos)      metal Fresnel (OpenPBR's F82-tint: Kutz et al. 2021), per channel
 *   f82Avg(f0, tint)                          its cosine-weighted hemispherical average (closed form, for Kulla–Conty)
 *   modulatedEta(eta, weight)                 OpenPBR's specular_weight rule: F0 × weight through a modified IOR ratio
 *   thinFilm(cos, eta1, etaFilm, eta3, thicknessUm, lambdaNm, metalR?)  Airy reflectance of a thin film on a dielectric (or,
 *                                             with metalR, on a conductor whose own reflectance is metalR: phase π assumed)
 *   ggxD(m, ax, ay), ggxLambda(w, ax, ay), ggxG1, ggxG2, ggxDv   anisotropic GGX (Trowbridge–Reitz), Smith height-correlated
 *   sampleVNDF(wo, ax, ay, u1, u2, out)       Heitz 2018 visible normals
 *   refract(wo, m, eta, out) → bool           Snell (eta = n_t / n_i), false on total internal reflection
 *   charlieD(cosM, rough), charlieV(nl, nv)   the fuzz lobe (Estevez & Kulla 2017; Neubelt & Pettineo 2013)
 *   eonAlbedo(mu, r), eonAvg(r)               Fujii Oren–Nayar's directional / average albedo (Portsmouth et al., EON, 2025)
 *   eonEval(rho, r, wo, wi) → f (one channel)  EON = Fujii ON + its energy compensation (the paper's eq. 19 / Listing 1)
 *   anisoAlphas(rough, aniso) → [αt, αb]      OpenPBR: αt = r²·√(2 / (1 + (1 − a)²)), αb = (1 − a)·αt
 *   LAMBDA_NM                                  the three wavelengths the RGB kernels use for thin film and dispersion
 *
 * Sources (formulas only): pbrt-v4 §§ 9.3–9.6 (Apache-2.0); the OpenPBR Surface specification v1.1 (Apache-2.0); Portsmouth,
 * Kutz & Hill, "EON: A practical energy-preserving rough diffuse BRDF" (JCGT 2025, CC BY 4.0); Heitz 2018; Kutz et al. 2021;
 * Born & Wolf (Airy summation of a thin film); Estevez & Kulla 2017.
 */

export const LAMBDA_NM = [650, 550, 450];

export function frDielectric(cosI, eta) {
  let c = Math.min(1, Math.max(-1, cosI));
  if (c < 0) { eta = 1 / eta; c = -c; }
  const s2 = 1 - c * c, t2 = s2 / (eta * eta);
  if (t2 >= 1) return 1;
  const ct = Math.sqrt(1 - t2);
  const rpa = (eta * c - ct) / (eta * c + ct), rpe = (c - eta * ct) / (c + eta * ct);
  return (rpa * rpa + rpe * rpe) / 2;
}
export const schlick = (f0, c) => f0 + (1 - f0) * Math.pow(1 - Math.min(1, Math.max(0, c)), 5);

const MU_BAR = 1 / 7, F82_K = MU_BAR * Math.pow(1 - MU_BAR, 6);
/** OpenPBR metal: F82(μ) = F_S(μ) − μ(1−μ)⁶ / (μ̄(1−μ̄)⁶) · (F_S(μ̄) − tint·F_S(μ̄)), μ̄ = 1/7. One channel. */
export function f82(f0, tint, c) {
  c = Math.min(1, Math.max(0, c));
  const fs = schlick(f0, c), fb = schlick(f0, MU_BAR);
  return Math.max(0, fs - ((c * Math.pow(1 - c, 6)) / F82_K) * (fb - tint * fb));
}
/** 2∫F82(μ)μ dμ: Schlick's F0 + (1 − F0)/21, minus the tint term (2∫μ²(1−μ)⁶dμ = 1/126). */
export function f82Avg(f0, tint) {
  const fb = schlick(f0, MU_BAR);
  return Math.max(0, f0 + (1 - f0) / 21 - (1 / 126 / F82_K) * (fb - tint * fb));
}

/** OpenPBR: F_s = ((1−η)/(1+η))², ε = sgn(η−1)·√(ξ·F_s), η' = (1+ε)/(1−ε); ξ clamped to [0, 1/F_s]. */
export function modulatedEta(eta, weight) {
  if (weight === 1) return eta;
  const Fs = ((1 - eta) / (1 + eta)) ** 2;
  if (!(Fs > 0)) return eta;
  const xi = Math.min(Math.max(0, weight), 1 / Fs);
  const eps = Math.sign(eta - 1) * Math.sqrt(xi * Fs);
  return Math.min(1e4, Math.max(1e-4, (1 + eps) / (1 - eps)));
}

/**
 * Reflectance of a thin film (index etaFilm, thickness d) between a medium eta1 and a base eta3 at wavelength λ — the Airy sum
 * of the film's multiple reflections, per polarisation, averaged. With metalR the base is a conductor whose reflectance is
 * metalR (its phase taken as π: the film then interferes with an inverted wave, which is what metals do to first order).
 */
export function thinFilm(cos1, eta1, etaF, eta3, dUm, lambdaNm, metalR = -1) {
  const c1 = Math.min(1, Math.max(0, cos1)), s1 = 1 - c1 * c1;
  const s2 = (eta1 * eta1 * s1) / (etaF * etaF);
  if (s2 >= 1) return 1;   // total reflection at the film
  const c2 = Math.sqrt(1 - s2);
  const r12s = (eta1 * c1 - etaF * c2) / (eta1 * c1 + etaF * c2), r12p = (etaF * c1 - eta1 * c2) / (etaF * c1 + eta1 * c2);
  let r23s, r23p;
  if (metalR >= 0) { r23s = r23p = -Math.sqrt(Math.min(1, metalR)); }
  else {
    const s3 = (eta1 * eta1 * s1) / (eta3 * eta3);
    if (s3 >= 1) { r23s = r23p = 1; } else {
      const c3 = Math.sqrt(1 - s3);
      r23s = (etaF * c2 - eta3 * c3) / (etaF * c2 + eta3 * c3); r23p = (eta3 * c2 - etaF * c3) / (eta3 * c2 + etaF * c3);
    }
  }
  const phi = ((4 * Math.PI) / lambdaNm) * etaF * dUm * 1000 * c2, cp = Math.cos(phi);
  const R = (a, b) => (a * a + b * b + 2 * a * b * cp) / (1 + a * a * b * b + 2 * a * b * cp);
  return Math.min(1, Math.max(0, (R(r12s, r23s) + R(r12p, r23p)) / 2));
}

export function anisoAlphas(rough, aniso = 0) {
  const r2 = Math.max(0, Math.min(1, rough)) ** 2, a = Math.max(0, Math.min(1, aniso));
  if (!a) return [r2, r2];
  const at = Math.min(1, r2 * Math.sqrt(2 / (1 + (1 - a) * (1 - a))));
  return [at, (1 - a) * at];
}

export function ggxD(mx, my, mz, ax, ay) {
  if (mz <= 0) return 0;
  const x = mx / ax, y = my / ay, d = x * x + y * y + mz * mz;
  return 1 / (Math.PI * ax * ay * d * d);
}
export function ggxLambda(wx, wy, wz, ax, ay) {
  const c2 = wz * wz;
  if (c2 <= 0) return 1e9;
  return (Math.sqrt(1 + (ax * ax * wx * wx + ay * ay * wy * wy) / c2) - 1) / 2;
}
export const ggxG1 = (w, ax, ay) => 1 / (1 + ggxLambda(w[0], w[1], w[2], ax, ay));
export const ggxG2 = (wo, wi, ax, ay) => 1 / (1 + ggxLambda(wo[0], wo[1], wo[2], ax, ay) + ggxLambda(wi[0], wi[1], wi[2], ax, ay));
/** D_v(wo, m) = G1(wo) / cos θo · D(m) · |wo·m|. */
export function ggxDv(wo, m, ax, ay) {
  return (ggxG1(wo, ax, ay) / Math.max(1e-12, Math.abs(wo[2]))) * ggxD(m[0], m[1], m[2], ax, ay) * Math.abs(wo[0] * m[0] + wo[1] * m[1] + wo[2] * m[2]);
}
/** Heitz 2018 (anisotropic), wo.z ≥ 0 → the microfacet normal into out. */
export function sampleVNDF(wo, ax, ay, u1, u2, out) {
  let hx = ax * wo[0], hy = ay * wo[1], hz = wo[2];
  const hl = Math.hypot(hx, hy, hz) || 1; hx /= hl; hy /= hl; hz /= hl;
  let t1x = 1, t1y = 0;
  if (hz < 0.99999) { const l = Math.hypot(hx, hy) || 1; t1x = -hy / l; t1y = hx / l; }
  const t2x = -hz * t1y, t2y = hz * t1x, t2z = hx * t1y - hy * t1x;
  const r = Math.sqrt(u1), phi = 2 * Math.PI * u2, p1 = r * Math.cos(phi), s = 0.5 * (1 + hz);
  const p2 = (1 - s) * Math.sqrt(Math.max(0, 1 - p1 * p1)) + s * r * Math.sin(phi);
  const p3 = Math.sqrt(Math.max(0, 1 - p1 * p1 - p2 * p2));
  const nx = p1 * t1x + p2 * t2x + p3 * hx, ny = p1 * t1y + p2 * t2y + p3 * hy, nz = p2 * t2z + p3 * hz;
  const mx = ax * nx, my = ay * ny, mz = Math.max(1e-6, nz), ml = Math.hypot(mx, my, mz);
  out[0] = mx / ml; out[1] = my / ml; out[2] = mz / ml;
  return out;
}
export function refract(wo, m, eta, out) {
  const c = wo[0] * m[0] + wo[1] * m[1] + wo[2] * m[2];
  const t2 = Math.max(0, 1 - c * c) / (eta * eta);
  if (t2 >= 1) return false;
  const ct = Math.sqrt(1 - t2);
  for (let k = 0; k < 3; k++) out[k] = -wo[k] / eta + (c / eta - ct) * m[k];
  return true;
}

export function charlieD(cosM, rough) {
  const a = Math.max(0.07, rough), inv = 1 / a, s2 = Math.max(0, 1 - cosM * cosM);
  return ((2 + inv) * Math.pow(s2, inv * 0.5)) / (2 * Math.PI);
}
export const charlieV = (nl, nv) => 1 / (4 * Math.max(1e-6, nl + nv - nl * nv));

// EON (Portsmouth, Kutz, Hill 2025): Fujii's Oren–Nayar with r ∈ [0, 1] and its energy compensation
const EON_C1 = 0.5 - 2 / (3 * Math.PI), EON_C2 = 2 / 3 - 28 / (15 * Math.PI);
const EON_G = [0.0571085289, 0.491881867, -0.332181442, 0.0714429953];
/** Ê_F(μ) (the paper's polynomial approximation, < 0.1% error). */
export function eonAlbedo(mu, r) {
  const m = 1 - Math.min(1, Math.max(0, mu));
  const gOverPi = m * (EON_G[0] + m * (EON_G[1] + m * (EON_G[2] + m * EON_G[3])));
  return (1 + r * gOverPi) / (1 + EON_C1 * r);
}
export const eonAvg = (r) => (1 + EON_C2 * r) / (1 + EON_C1 * r);
/** f (one channel) for local wo, wi (z up, both above); rho = the base colour; r = base_diffuse_roughness. */
export function eonEval(rho, r, wo, wi) {
  const mo = wo[2], mi = wi[2];
  if (mo <= 0 || mi <= 0) return 0;
  const AF = 1 / (1 + EON_C1 * r), s = wo[0] * wi[0] + wo[1] * wi[1] + wo[2] * wi[2] - mo * mi;
  const sOverT = s > 0 ? s / Math.max(mo, mi) : s;
  const fss = (rho / Math.PI) * AF * (1 + r * sOverT);
  if (!(r > 0)) return fss;
  const avg = AF * (1 + EON_C2 * r), rhoMs = (rho * rho * avg) / (1 - rho * (1 - avg));
  const eo = eonAlbedo(mo, r), ei = eonAlbedo(mi, r), eps = 1e-7;
  return fss + (rhoMs / Math.PI) * (Math.max(eps, 1 - eo) * Math.max(eps, 1 - ei)) / Math.max(eps, 1 - avg);
}
