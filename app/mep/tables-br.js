/* SPDX-License-Identifier: Apache-2.0 */
/**
 * tables-br.js — pipe sizes of the Brazilian standards (ABNT NBR) for building water and drainage, and their drain slopes.
 * DOM-free. Sizes are named by their DN in millimetres; dimensions are in millimetres as the standards give them (the makers'
 * technical sheets that reproduce them were checked: Wavin "Soldável Água Fria", "Esgoto Série Normal", "Esgoto Série
 * Reforçada"; CEHOP-SE's table of PVC drainage pipe). Not part of CadCraft's Piping add-on (mep/tables.js is its copy).
 *
 *   PVC-U pipe with solvent-weld joints for cold water, NBR 5648 (one pressure class, PN 750 kPa): DN = outside diameter
 *     20 to 110; the usual inch "reference size" (bitola de referência) is kept for labels people know (DN 25 = 3/4").
 *   PVC-U pipe for drainage, rainwater and vents, NBR 5688: DN 40 to 200, Série Normal (SN, sanitary drainage and vents) and
 *     Série Reforçada (SR, also rainwater and buried pipe); DN 100 is 101.6 outside.
 *   Smallest slope of a horizontal drain, NBR 8160 (Sistemas prediais de esgoto sanitário): 2 % up to DN 75, 1 % from DN 100.
 *   Water pipes sized by flow keep the water at or under 3 m/s, NBR 5626 (Sistemas prediais de água fria e água quente).
 *
 *   BR_MATERIALS, BR_CLASSES, BR_DEFAULT_CLASS · brSizesFor(mat, cls) (smallest first) · brPipeSize(mat, cls, size) → { mat, cls,
 *   size, od, wall, id (inches, as mep/tables.js gives them), odMm, wallMm, dn, nps (DN in inches), label, metric: true } | null
 *   brDrainSlope(dn) → rise per run
 */

// DN: wall (mm); the outside diameter is the DN  — NBR 5648
export const PVC_SOLD = { 20: 1.5, 25: 1.7, 32: 2.1, 40: 2.4, 50: 3.0, 60: 3.3, 75: 4.2, 85: 4.7, 110: 6.1 };
export const PVC_SOLD_REF = { 20: '1/2', 25: '3/4', 32: '1', 40: '1-1/4', 50: '1-1/2', 60: '2', 75: '2-1/2', 85: '3', 110: '4' };
// DN: [outside diameter, wall] (mm)  — NBR 5688, Série Normal and Série Reforçada
export const PVC_ESG = {
  SN: { 40: [40, 1.2], 50: [50.7, 1.6], 75: [75.5, 1.7], 100: [101.6, 1.8], 150: [150, 2.6], 200: [200, 3.6] },
  SR: { 40: [40, 1.8], 50: [50.7, 1.8], 75: [75.5, 2], 100: [101.6, 2.5], 150: [150, 3.6] },
};

export const BR_MATERIALS = ['pvc-sold', 'pvc-esg'];
export const BR_MAX_VELOCITY = 3;   // m/s
export const BR_CLASSES = { 'pvc-sold': ['PN750'], 'pvc-esg': ['SN', 'SR'] };
export const BR_DEFAULT_CLASS = { 'pvc-sold': 'PN750', 'pvc-esg': 'SN' };
export const isBrMaterial = (mat) => BR_MATERIALS.includes(mat);

/** The sizes made in a material and class, smallest first (DN as text). */
export function brSizesFor(mat, cls) {
  const t = mat === 'pvc-sold' && cls === 'PN750' ? PVC_SOLD : mat === 'pvc-esg' ? PVC_ESG[cls] : null;
  return t ? Object.keys(t).map(Number).sort((a, b) => a - b).map(String) : [];
}

/** One size, with its dimensions in inches beside millimetres (the run code works in the US tables' inches). */
export function brPipeSize(mat, cls, size) {
  const dn = Number(size);
  let od, wall;
  if (mat === 'pvc-sold' && cls === 'PN750' && PVC_SOLD[dn]) { od = dn; wall = PVC_SOLD[dn]; }
  else if (mat === 'pvc-esg' && PVC_ESG[cls]?.[dn]) [od, wall] = PVC_ESG[cls][dn];
  else return null;
  const IN = 25.4;
  return { mat, cls, size: String(dn), od: od / IN, wall: wall / IN, id: (od - 2 * wall) / IN, odMm: od, wallMm: wall, dn, nps: dn / IN, label: 'DN' + dn, ref: mat === 'pvc-sold' ? PVC_SOLD_REF[dn] : null, metric: true };   // i18n-ignore: a size mark
}

/** The smallest slope NBR 8160 allows a horizontal drain of this DN (rise per run). */
export function brDrainSlope(dn) {
  if (!(dn > 0)) return null;
  return dn <= 75 ? 0.02 : 0.01;
}
