/* SPDX-License-Identifier: Apache-2.0 */
/**
 * pt-bsdf.js — the OpenPBR Surface model as the JS reference evaluates it (0.7 RN.2; RENDER-SPEC § 5.1). The specification's own
 * "reduction to a mixture of lobes" with albedo scaling:
 *
 *   f = F·f_fuzz + (1 − F·E_fuzz(μo)) · [ C·f_coat + ((1 − C) + C·T_coat(μo, μi)·(1 − E_coat(μo))) · Δ · f_base ]
 *   f_base = M·(f_metal + f_metal,ms) + (1 − M)·[ T·f_glass + (1 − T)·( f_spec + (1 − E_spec(μo))·((1 − S)·f_EON + S·f_sss) ) ]
 *
 * F fuzz_weight (Charlie sheen, fuzz_color), C coat_weight (GGX dielectric, coat_ior, untinted; T_coat from coat_color through
 * both paths; Δ = lerp(1, the darkening factor, C·coat_darkening)), M base_metalness (GGX with F82-tint × specular_weight, plus
 * Kulla–Conty multiple scattering), T transmission_weight (a rough or smooth dielectric with reflection and refraction coupled
 * per microfacet — exact for glass —, or a thin sheet), S subsurface_weight (RN.2: a diffuse lobe of subsurface_color; thin-walled:
 * reflection ½S(1−g) and transmission ½S(1+g)), f_spec the dielectric specular layer (IOR from specular_ior, the coat rule and
 * specular_weight; tinted by specular_color), f_EON the energy-preserving Oren–Nayar diffuse of base_color × base_weight.
 * Thin film (thin_film_*) modulates the Fresnel of the metal and the dielectric specular layer per RGB wavelength.
 *
 * Local frame: n = +z, wo.z ≥ 0 (the caller flips the frame toward wo). `front` = the ray met the surface's front (outside);
 * `chan` = the path's dispersion channel (0 = all three; 1, 2, 3 = one wavelength of pt-ggx LAMBDA_NM, after a dispersive hit).
 * Nothing allocates per call (KICKOFF rule 18): params and results live in caller-owned objects and Float64Arrays.
 *
 *   params(rec, offset, p?) → p                 a material record (§ 6.4, 64 floats) → the reused params object
 *   evalBsdf(p, front, chan, wo, wi, out)       out[3..5] = f·|cos θi| (rgb), out[6] = pdf (the non-delta mixture)
 *   sampleBsdf(p, front, chan, wo, u1, u2, uL, out) → bool   out[0..2] wi, out[3..5] f·|cos|/pdf, out[6] pdf (0 = delta),
 *                                               out[7] = 1 for a delta lobe
 *   etaFor(p, front, chan) → the relative IOR a refraction uses here
 *   frDielectric (re-exported from pt-ggx.js for the shadow test)
 *
 * Sources (formulas only): the OpenPBR Surface specification v1.1 (Apache-2.0) and its EON, F82-tint and thin-film references
 * (pt-ggx.js header); pbrt-v4 §§ 9.4–9.5 for the coupled rough dielectric (Walter et al. 2007, 1/η² radiance scaling);
 * Kulla & Conty 2017 for the conductor's multiple-scattering lobe.
 */
import { MIN_ALPHA, MAT_FLAG } from './pt-spec.js';
import { frDielectric, f82, f82Avg, thinFilm, anisoAlphas, ggxD, ggxG1, ggxG2, ggxDv, sampleVNDF, refract, charlieD, charlieV,
  eonEval, eonAlbedo, eonAvg, LAMBDA_NM } from './pt-ggx.js';
import { tables, lookupSpec, lookupCond, lookupCondAvg, lookupFuzz } from './pt-tables.js';

export { frDielectric };
const INV_PI = 1 / Math.PI;
const lum = (c) => 0.2722 * c[0] + 0.6741 * c[1] + 0.0537 * c[2];
const v3 = () => [0, 0, 0];

/** Record (§ 6.4) → params. The derived words (14.z eta, 14.w coat E_F, 15 μt + Cauchy B) are filled by pt-pack.js. */
export function params(rec, o = 0, p = null) {
  p = p || { base: v3(), spec: v3(), tcol: v3(), emis: v3(), coatCol: v3(), fuzzCol: v3(), sssCol: v3(), mut: v3() };
  const r = (i) => rec[o + i];
  for (let k = 0; k < 3; k++) {
    p.base[k] = r(k) * r(3); p.spec[k] = r(4 + k); p.tcol[k] = r(12 + k); p.emis[k] = r(20 + k) * r(23);
    p.coatCol[k] = r(24 + k); p.fuzzCol[k] = r(32 + k); p.sssCol[k] = r(40 + k); p.mut[k] = r(60 + k);
  }
  p.sw = r(7); p.rough = Math.min(1, Math.max(0, r(8))); p.ior = Math.max(1.0001, r(9)); p.metal = Math.min(1, Math.max(0, r(10)));
  p.trans = Math.min(1, Math.max(0, r(11))); p.flags = r(15) | 0; p.thin = (p.flags & MAT_FLAG.THIN) !== 0;
  p.diffRough = Math.min(1, Math.max(0, r(19)));
  p.coat = Math.min(1, Math.max(0, r(27))); p.coatRough = Math.min(1, Math.max(0, r(28))); p.coatIor = Math.max(1.0001, r(29));
  p.coatDark = Math.min(1, Math.max(0, r(30))); p.aniso = Math.min(1, Math.max(0, r(31)));
  p.fuzz = Math.min(1, Math.max(0, r(35))); p.fuzzRough = Math.min(1, Math.max(0, r(36)));
  p.film = Math.min(1, Math.max(0, r(37))); p.filmUm = Math.max(0, r(38)); p.filmIor = Math.max(1.0001, r(39));
  p.sss = Math.min(1, Math.max(0, r(43))); p.sssG = Math.min(1, Math.max(-1, r(55)));
  p.disp = Math.max(0, r(53)); p.opacity = Math.min(1, Math.max(0, r(56))); p.coatAniso = Math.min(1, Math.max(0, r(57)));
  p.eta = Math.max(1e-4, r(58) || p.ior); p.coatEF = r(59); p.cauchyB = r(63);
  p.beer = p.mut[0] > 0 || p.mut[1] > 0 || p.mut[2] > 0;
  return p;
}

/** The relative IOR of the base interface for this side and dispersion channel (Cauchy n(λ) = A + B/λ², n(λ_d) = eta). */
export function etaFor(p, front, chan) {
  let e = p.eta;
  if (chan > 0 && p.cauchyB > 0) { const l = LAMBDA_NM[chan - 1] / 1000, ld = 0.5876; e = Math.max(1.0001, e - p.cauchyB / (ld * ld) + p.cauchyB / (l * l)); }
  return front ? e : 1 / e;
}

// ---- per-call state, reused ----
const W = { // layer weights and selection, by wo
  eFuzz: 0, topF: 1, eCoat: 0, etaC: 1.6, base: 1, dark: 1, eSpec: 0, eCond: 0, condAvg: 1, rSpec: 0.3, ax: 0.09, ay: 0.09,
  cax: 0, cay: 0, eta: 1.5, etaBase: 1.5, fAvg: v3(), fms: v3(), pr: new Float64Array(10), tco: v3(),
};
const K = { FUZZ: 0, COAT: 1, METAL: 2, METAL_MS: 3, SPEC: 4, DIFF: 5, SSS: 6, SSS_T: 7, GLASS: 8 };
const T0 = { t: null };
const tab = () => (T0.t ||= tables());

/** sqrt(coat_color)^(1/μt) for one path through the coat at cosine mu (μt: the refracted cosine inside the coat). */
function coatPass(p, mu, out, acc = false) {
  const s2 = Math.max(0, 1 - mu * mu) / (p.coatIor * p.coatIor), mt = Math.sqrt(Math.max(1e-4, 1 - s2));
  for (let k = 0; k < 3; k++) { const t = Math.pow(Math.max(1e-6, Math.sqrt(Math.max(0, p.coatCol[k]))), 1 / mt); out[k] = acc ? out[k] * t : t; }
  return out;
}

/** Everything that depends on wo only: layer albedos, the darkening, the lobe selection probabilities (W.pr). */
function weigh(p, front, chan, woz) {
  const T = tab(), mu = Math.max(1e-4, woz);
  W.eFuzz = p.fuzz > 0 ? lookupFuzz(T, mu, p.fuzzRough) : 0;
  W.topF = 1 - p.fuzz * W.eFuzz;
  W.etaC = p.coatIor;
  W.eCoat = p.coat > 0 ? lookupSpec(T, mu, p.coatRough, W.etaC) : 0;
  [W.cax, W.cay] = anisoAlphas(p.coatRough, p.coatAniso);
  // the base's specular roughness, roughened by a rough coat (OpenPBR)
  const rB = p.rough, rC = p.coatRough;
  W.rSpec = p.coat > 0 ? rB + (Math.min(1, Math.pow(rB ** 4 + 2 * rC ** 4, 0.25)) - rB) * p.coat : rB;
  [W.ax, W.ay] = anisoAlphas(W.rSpec, p.aniso);
  W.etaBase = etaFor(p, true, chan);
  W.eta = etaFor(p, front, chan);
  W.eSpec = lookupSpec(T, mu, W.rSpec, Math.max(1.0001, W.etaBase));
  W.eCond = lookupCond(T, mu, W.rSpec);
  W.condAvg = lookupCondAvg(T, W.rSpec);
  for (let k = 0; k < 3; k++) {
    W.fAvg[k] = p.sw * f82Avg(p.base[k], p.spec[k]);
    W.fms[k] = (W.fAvg[k] * W.fAvg[k] * W.condAvg) / Math.max(1e-6, 1 - W.fAvg[k] * (1 - W.condAvg));
  }
  // coat darkening (OpenPBR): Δ = (1 − K) / (1 − E_b·K), applied as lerp(1, Δ, C·δ)
  W.dark = 1;
  if (p.coat > 0 && p.coatDark > 0) {
    const F0s = ((W.etaBase - 1) / (W.etaBase + 1)) ** 2, xiF = Math.min(1, p.sw * F0s);
    const rb = (1 + (p.rough - 1) * xiF) * (1 - p.metal) + p.rough * p.metal;
    const Ks = frDielectric(mu, W.etaC), Kr = 1 - (1 - p.coatEF) / (W.etaC * W.etaC), Kk = Ks + (Kr - Ks) * rb;
    const Ediel = (1 - p.trans) * (F0s + (1 - F0s) * ((1 - p.sss) * lum(p.base) + p.sss * lum(p.sssCol))) + p.trans * F0s;
    const Eb = Ediel * (1 - p.metal) + p.metal * lum(p.base) * p.sw;
    const delta = (1 - Kk) / Math.max(1e-6, 1 - Eb * Kk);
    W.dark = 1 + (delta - 1) * p.coat * p.coatDark;
  }
  coatPass(p, mu, W.tco); coatPass(p, mu, W.tco, true);   // both paths at μo, for the selection only
  W.base = W.topF * ((1 - p.coat) + p.coat * lum(W.tco) * (1 - W.eCoat)) * W.dark;
  // selection probabilities ∝ each lobe's expected contribution (by wo)
  const pr = W.pr, bw = W.base, diel = (1 - p.metal) * bw, opaque = diel * (1 - p.trans), rest = opaque * (1 - W.eSpec);
  pr[K.FUZZ] = p.fuzz * W.eFuzz * Math.max(0.05, lum(p.fuzzCol));
  pr[K.COAT] = W.topF * p.coat * W.eCoat;
  pr[K.METAL] = p.metal * bw * W.eCond * Math.max(0.05, lum(W.fAvg));
  pr[K.METAL_MS] = p.metal * bw * (1 - W.eCond) * lum(W.fms);
  pr[K.SPEC] = opaque * W.eSpec * Math.max(0.05, lum(p.spec));
  pr[K.DIFF] = rest * (1 - p.sss) * Math.max(0.02, lum(p.base));
  const sssL = rest * p.sss * Math.max(0.02, lum(p.sssCol));
  pr[K.SSS] = p.thin ? sssL * (1 - p.sssG) / 2 : sssL;
  pr[K.SSS_T] = p.thin ? sssL * (1 + p.sssG) / 2 : 0;
  pr[K.GLASS] = diel * p.trans;
  // inside a transmissive solid (the back of a non-thin surface with transmission) only the dielectric interface acts; an
  // opaque surface is two-sided, so its back face shades like its front (models often show the back of a face)
  if (insideOf(p, front)) { pr.fill(0); pr[K.GLASS] = 1; }
  let s = 0;
  for (let k = 0; k < 9; k++) s += pr[k];
  if (s > 0) for (let k = 0; k < 9; k++) pr[k] /= s;
  return W;
}

/** Fresnel of the base's dielectric specular layer, thin film included, per channel, into out. */
function specF(p, c, out) {
  const F = frDielectric(c, W.etaBase);
  for (let k = 0; k < 3; k++) out[k] = p.film > 0 ? F + (thinFilm(c, 1, p.filmIor, W.etaBase, p.filmUm, LAMBDA_NM[k]) - F) * p.film : F;
  return out;
}
/** Metal Fresnel (F82-tint × specular_weight), thin film included, per channel. */
function metalF(p, c, out) {
  for (let k = 0; k < 3; k++) {
    const F = p.sw * f82(p.base[k], p.spec[k], c);
    out[k] = p.film > 0 ? F + (thinFilm(c, 1, p.filmIor, 1, p.filmUm, LAMBDA_NM[k], F) - F) * p.film : F;
  }
  return out;
}
const thinR = (F) => (2 * F) / (1 + F);
/** Is the path inside a transmissive solid (the back of a non-thin surface that transmits)? */
export const insideOf = (p, front) => !front && !p.thin && p.trans > 0;

const H = new Float64Array(3), FC = v3(), TC = v3(), BFC = v3(), WR = new Float64Array(3);
/** The full non-delta mixture: f·|cos θi| and pdf. */
export const CAT = Object.freeze({ DIFFUSE: 1, SPECULAR: 2, TRANSMISSION: 4, ALL: 7 });
/** `mask` (RN.6 render elements): which lobes add to f — CAT.DIFFUSE (fuzz, diffuse, subsurface reflection), CAT.SPECULAR (coat,
 * metal, specular, the glass's reflection), CAT.TRANSMISSION (thin subsurface through, the glass's transmission); the pdf is
 * always the whole mixture's. */
export function evalBsdf(p, front, chan, wo, wi, out, mask = 7) {
  out[3] = out[4] = out[5] = 0; out[6] = 0;
  const mD = (mask & 1) !== 0, mS = (mask & 2) !== 0, mT = (mask & 4) !== 0;
  const co = wo[2], ci = wi[2];
  if (co <= 0 || ci === 0) return out;
  weigh(p, front, chan, co);
  const pr = W.pr, inside = insideOf(p, front);
  let fr = 0, fg = 0, fb = 0, pdf = 0;
  const acos = Math.abs(ci);
  // the base's layer factor for this pair of directions (T_coat through both paths)
  coatPass(p, co, TC); coatPass(p, acos, TC, true);
  const bfc = BFC, wT = inside ? 1 : (1 - p.metal) * p.trans;   // the glass lobe's weight (inside a solid: the bare interface)
  for (let k = 0; k < 3; k++) bfc[k] = inside ? 1 : W.topF * ((1 - p.coat) + p.coat * TC[k] * (1 - W.eCoat)) * W.dark;
  if (ci > 0) {
    let hx = wo[0] + wi[0], hy = wo[1] + wi[1], hz = wo[2] + wi[2];
    const hl = Math.hypot(hx, hy, hz);
    if (hl > 0) {
      hx /= hl; hy /= hl; hz /= hl; H[0] = hx; H[1] = hy; H[2] = hz;
      const odm = wo[0] * hx + wo[1] * hy + wo[2] * hz;
      // fuzz
      if (!inside && p.fuzz > 0 && mD) {
        const f = p.fuzz * charlieD(hz, p.fuzzRough) * charlieV(ci, co) * ci;
        fr += f * p.fuzzCol[0]; fg += f * p.fuzzCol[1]; fb += f * p.fuzzCol[2];
      }
      // coat
      if (!inside && p.coat > 0 && Math.max(W.cax, W.cay) >= MIN_ALPHA && odm > 0) {
        const f = mS ? W.topF * p.coat * ggxD(hx, hy, hz, W.cax, W.cay) * ggxG2(wo, wi, W.cax, W.cay) / (4 * co) * frDielectric(odm, W.etaC) : 0;
        fr += f; fg += f; fb += f;
        pdf += pr[K.COAT] * ggxDv(wo, H, W.cax, W.cay) / (4 * odm);
      }
      if (Math.max(W.ax, W.ay) >= MIN_ALPHA && odm > 0) {
        const DG = ggxD(hx, hy, hz, W.ax, W.ay) * ggxG2(wo, wi, W.ax, W.ay) / (4 * co);   // × F × cos θi / cos θi
        const pv = ggxDv(wo, H, W.ax, W.ay) / (4 * odm);
        if (!inside && p.metal > 0) {
          metalF(p, odm, FC);
          if (mS) { fr += bfc[0] * p.metal * DG * FC[0]; fg += bfc[1] * p.metal * DG * FC[1]; fb += bfc[2] * p.metal * DG * FC[2]; }
          pdf += pr[K.METAL] * pv;
        }
        if (!inside && pr[K.SPEC] > 0) {
          specF(p, odm, FC);
          const w0 = mS ? (1 - p.metal) * (1 - p.trans) * DG : 0;
          fr += bfc[0] * w0 * FC[0] * p.spec[0]; fg += bfc[1] * w0 * FC[1] * p.spec[1]; fb += bfc[2] * w0 * FC[2] * p.spec[2];
          pdf += pr[K.SPEC] * pv;
        }
        if (wT > 0) {
          // the coupled dielectric's reflection
          const F = p.thin ? thinR(frDielectric(odm, W.etaBase)) : frDielectric(odm, W.eta);
          const w0 = mS ? wT * DG * F : 0;
          fr += bfc[0] * w0 * p.spec[0]; fg += bfc[1] * w0 * p.spec[1]; fb += bfc[2] * w0 * p.spec[2];
          pdf += pr[K.GLASS] * pv * F;
        }
      }
    }
    if (!inside) {
      // metal multiple scattering (Kulla–Conty)
      if (p.metal > 0) {
        const eo = W.eCond, ei = lookupCond(tab(), ci, W.rSpec), k0 = mS ? p.metal * (1 - eo) * (1 - ei) / (Math.PI * Math.max(1e-6, 1 - W.condAvg)) * ci : 0;
        fr += bfc[0] * k0 * W.fms[0]; fg += bfc[1] * k0 * W.fms[1]; fb += bfc[2] * k0 * W.fms[2];
        pdf += pr[K.METAL_MS] * ci * INV_PI;
      }
      // diffuse (EON) and subsurface (diffuse in RN.2), under the specular layer
      const under = mD ? (1 - p.metal) * (1 - p.trans) * (1 - W.eSpec) : 0;
      if (under > 0) {
        if (p.sss < 1) for (let k = 0; k < 3; k++) {
          const f = bfc[k] * under * (1 - p.sss) * eonEval(p.base[k], p.diffRough, wo, wi) * ci;
          if (k === 0) fr += f; else if (k === 1) fg += f; else fb += f;
        }
        if (p.sss > 0) {
          const s = under * p.sss * INV_PI * ci * (p.thin ? (1 - p.sssG) / 2 : 1);
          fr += bfc[0] * s * p.sssCol[0]; fg += bfc[1] * s * p.sssCol[1]; fb += bfc[2] * s * p.sssCol[2];
        }
      }
      pdf += (pr[K.DIFF] + pr[K.SSS] + pr[K.FUZZ]) * ci * INV_PI;
    }
  } else {
    // transmission (wi below)
    const under = (1 - p.metal) * (1 - p.trans) * (1 - W.eSpec);
    if (p.thin && p.sss > 0 && under > 0) {
      const s = mT ? under * p.sss * INV_PI * acos * (1 + p.sssG) / 2 : 0;
      fr += bfc[0] * s * p.sssCol[0]; fg += bfc[1] * s * p.sssCol[1]; fb += bfc[2] * s * p.sssCol[2];
      pdf += pr[K.SSS_T] * acos * INV_PI;
    }
    if (wT > 0 && Math.max(W.ax, W.ay) >= MIN_ALPHA) {
      const tc = p.beer ? 1 : 0;   // a coloured medium (transmission_depth) tints along the path, not at the surface
      if (p.thin) {
        WR[0] = wi[0]; WR[1] = wi[1]; WR[2] = -wi[2];
        let hx = wo[0] + WR[0], hy = wo[1] + WR[1], hz = wo[2] + WR[2];
        const hl = Math.hypot(hx, hy, hz);
        if (hl > 0) {
          hx /= hl; hy /= hl; hz /= hl; H[0] = hx; H[1] = hy; H[2] = hz;
          const odm = wo[0] * hx + wo[1] * hy + wo[2] * hz;
          if (odm > 0) {
            const Tt = 1 - thinR(frDielectric(odm, W.etaBase));
            const k0 = mT ? wT * ggxD(hx, hy, hz, W.ax, W.ay) * ggxG2(wo, WR, W.ax, W.ay) / (4 * co) * Tt : 0;
            fr += bfc[0] * k0 * (tc || p.tcol[0]); fg += bfc[1] * k0 * (tc || p.tcol[1]); fb += bfc[2] * k0 * (tc || p.tcol[2]);
            pdf += pr[K.GLASS] * ggxDv(wo, H, W.ax, W.ay) / (4 * odm) * Tt;
          }
        }
      } else {
        const eta = W.eta;
        let mx = wi[0] * eta + wo[0], my = wi[1] * eta + wo[1], mz = wi[2] * eta + wo[2];
        const ml = Math.hypot(mx, my, mz);
        if (ml > 0) {
          mx /= ml; my /= ml; mz /= ml;
          if (mz < 0) { mx = -mx; my = -my; mz = -mz; }
          H[0] = mx; H[1] = my; H[2] = mz;
          const idm = wi[0] * mx + wi[1] * my + wi[2] * mz, odm = wo[0] * mx + wo[1] * my + wo[2] * mz;
          if (idm < 0 && odm > 0) {
            const Tt = 1 - frDielectric(odm, eta), denom = idm + odm / eta, d2 = denom * denom;
            const f = (Tt * ggxD(mx, my, mz, W.ax, W.ay) * ggxG2(wo, wi, W.ax, W.ay) * Math.abs(idm * odm)) / (acos * co * d2) / (eta * eta);
            const k0 = mT ? wT * f * acos : 0;
            fr += bfc[0] * k0 * (tc || p.tcol[0]); fg += bfc[1] * k0 * (tc || p.tcol[1]); fb += bfc[2] * k0 * (tc || p.tcol[2]);
            pdf += pr[K.GLASS] * ggxDv(wo, H, W.ax, W.ay) * (Math.abs(idm) / d2) * Tt;
          }
        }
      }
    }
  }
  out[3] = fr; out[4] = fg; out[5] = fb; out[6] = pdf;
  return out;
}

const EV = new Float64Array(8), M3 = new Float64Array(3), WI = new Float64Array(3), N0 = Float64Array.of(0, 0, 1);
/** The render-element category (CAT) of lobe k going to wi (the glass: reflection = specular, through = transmission). */
const catOf = (k, wiz) => (k === K.FUZZ || k === K.DIFF || k === K.SSS ? CAT.DIFFUSE : k === K.SSS_T ? CAT.TRANSMISSION : k === K.GLASS && wiz < 0 ? CAT.TRANSMISSION : CAT.SPECULAR);
/** Sample a direction. Non-delta lobes → weight = full mixture f·cos / full mixture pdf (one-sample MIS between lobes).
 * out = [wi xyz, weight rgb, pdf (0 for a delta), delta (0/1), the sampled lobe's CAT] — out needs 9 entries. */
export function sampleBsdf(p, front, chan, wo, u1, u2, uL, out) {
  out[7] = 0;
  if (wo[2] <= 0) return false;
  weigh(p, front, chan, wo[2]);
  const pr = W.pr, inside = insideOf(p, front);
  let k = 8, acc = 0, u = uL;
  for (let i = 0; i < 9; i++) { if (pr[i] > 0 && u < acc + pr[i]) { k = i; u = (u - acc) / pr[i]; break; } acc += pr[i]; }
  if (!(pr[k] > 0)) return false;
  const wi = WI, mirror = () => { wi[0] = -wo[0]; wi[1] = -wo[1]; wi[2] = wo[2]; };
  const delta = (r, g, b) => { out[0] = wi[0]; out[1] = wi[1]; out[2] = wi[2]; out[3] = r / pr[k]; out[4] = g / pr[k]; out[5] = b / pr[k]; out[6] = 0; out[7] = 1; out[8] = catOf(k, wi[2]); return true; };
  // the base's layer factor for a mirror direction (μi = μo) or a straight one: T_coat through both paths
  const baseFac = (mui) => { coatPass(p, wo[2], TC); coatPass(p, mui, TC, true); for (let c = 0; c < 3; c++) TC[c] = inside ? 1 : W.topF * ((1 - p.coat) + p.coat * TC[c] * (1 - W.eCoat)) * W.dark; return TC; };
  const cosine = (down) => { const r = Math.sqrt(u1), ph = 2 * Math.PI * u2; wi[0] = r * Math.cos(ph); wi[1] = r * Math.sin(ph); wi[2] = Math.sqrt(Math.max(0, 1 - u1)) * (down ? -1 : 1); };
  if (k === K.FUZZ || k === K.METAL_MS || k === K.DIFF || k === K.SSS) cosine(false);
  else if (k === K.SSS_T) cosine(true);
  else if (k === K.COAT) {
    if (Math.max(W.cax, W.cay) < MIN_ALPHA) { mirror(); const f = W.topF * p.coat * frDielectric(wo[2], W.etaC); return delta(f, f, f); }
    const m = sampleVNDF(wo, W.cax, W.cay, u1, u2, M3), d = wo[0] * m[0] + wo[1] * m[1] + wo[2] * m[2];
    for (let c = 0; c < 3; c++) wi[c] = 2 * d * m[c] - wo[c];
  } else if (k === K.METAL || k === K.SPEC) {
    if (Math.max(W.ax, W.ay) < MIN_ALPHA) {
      mirror();
      const bfc = baseFac(wo[2]);
      if (k === K.METAL) { metalF(p, wo[2], FC); return delta(bfc[0] * p.metal * FC[0], bfc[1] * p.metal * FC[1], bfc[2] * p.metal * FC[2]); }
      specF(p, wo[2], FC);
      const w0 = (1 - p.metal) * (1 - p.trans);
      return delta(bfc[0] * w0 * FC[0] * p.spec[0], bfc[1] * w0 * FC[1] * p.spec[1], bfc[2] * w0 * FC[2] * p.spec[2]);
    }
    const m = sampleVNDF(wo, W.ax, W.ay, u1, u2, M3), d = wo[0] * m[0] + wo[1] * m[1] + wo[2] * m[2];
    for (let c = 0; c < 3; c++) wi[c] = 2 * d * m[c] - wo[c];
  } else {
    // the coupled dielectric (glass): smooth → delta reflection or refraction, rough → a microfacet, then reflect or refract
    const eta = W.eta, smooth = Math.max(W.ax, W.ay) < MIN_ALPHA, w0 = inside ? 1 : (1 - p.metal) * p.trans;
    if (smooth) {
      const F = p.thin ? thinR(frDielectric(wo[2], W.etaBase)) : frDielectric(wo[2], eta);
      if (u < F) { mirror(); const bfc = baseFac(wo[2]); return delta(bfc[0] * w0 * F * p.spec[0] / F, bfc[1] * w0 * F * p.spec[1] / F, bfc[2] * w0 * F * p.spec[2] / F); }
      const tc = p.beer ? [1, 1, 1] : p.tcol;
      if (p.thin) { wi[0] = -wo[0]; wi[1] = -wo[1]; wi[2] = -wo[2]; const bfc = baseFac(wo[2]); return delta(bfc[0] * w0 * tc[0], bfc[1] * w0 * tc[1], bfc[2] * w0 * tc[2]); }
      if (!refract(wo, N0, eta, wi)) { mirror(); const bfc = baseFac(wo[2]); return delta(bfc[0] * w0, bfc[1] * w0, bfc[2] * w0); }
      const s = 1 / (eta * eta), bfc = baseFac(Math.abs(wi[2]));
      return delta(bfc[0] * w0 * tc[0] * s, bfc[1] * w0 * tc[1] * s, bfc[2] * w0 * tc[2] * s);
    }
    const m = sampleVNDF(wo, W.ax, W.ay, u1, u2, M3), d = wo[0] * m[0] + wo[1] * m[1] + wo[2] * m[2];
    const F = p.thin ? thinR(frDielectric(d, W.etaBase)) : frDielectric(d, eta);
    if (u < F) for (let c = 0; c < 3; c++) wi[c] = 2 * d * m[c] - wo[c];
    else if (p.thin) { for (let c = 0; c < 3; c++) wi[c] = 2 * d * m[c] - wo[c]; wi[2] = -wi[2]; }
    else if (!refract(wo, m, eta, wi)) return false;
  }
  const l = Math.hypot(wi[0], wi[1], wi[2]);
  if (!(l > 0)) return false;
  wi[0] /= l; wi[1] /= l; wi[2] /= l;
  evalBsdf(p, front, chan, wo, wi, EV);
  if (!(EV[6] > 0)) return false;
  out[0] = wi[0]; out[1] = wi[1]; out[2] = wi[2];
  out[3] = EV[3] / EV[6]; out[4] = EV[4] / EV[6]; out[5] = EV[5] / EV[6]; out[6] = EV[6]; out[7] = 0; out[8] = catOf(k, wi[2]);
  return true;
}

/** The emitted radiance (rgb, the scene's scale) seen at cosine mu: emission_color × luminance, under the coat (OpenPBR). */
export function emitted(p, mu, scale, out) {
  if (!(p.emis[0] > 0 || p.emis[1] > 0 || p.emis[2] > 0)) { out[0] = out[1] = out[2] = 0; return out; }
  coatPass(p, Math.max(1e-4, mu), TC);
  for (let k = 0; k < 3; k++) out[k] = p.emis[k] * scale * (1 + (TC[k] - 1) * p.coat);
  return out;
}
export { eonAlbedo, eonAvg, ggxG1 };
