/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: IES keywords and developer errors; the messages a person reads come from the render.ies.* keys */
/**
 * pt-ies.js — IES photometric files (IESNA LM-63) for the path tracer's lamps (0.7 RN.3; RENDER-SPEC § 5.2). Our own reader,
 * written from the LM-63-1995 / LM-63-2002 file layout. No DOM, no imports. The file is untrusted input: every count is
 * checked and capped, the text is never evaluated, and a file that does not parse is refused with a code.
 *
 *   readIes(text) → {format, keywords {KEYWORD: value}, lamps, lumens, multiplier, type, vertical: Float64Array (degrees),
 *                    horizontal: Float64Array (degrees), candela: Float64Array (h × v, horizontal major), flux}   | throws IesError
 *   profileGrid(ies, nTheta = 64, nPhi = 32) → Float32Array (nTheta × nPhi)   a directional MULTIPLIER whose average over the
 *                    sphere is 1: candela(θ, φ) · 4π / flux. θ from the lamp's axis (0 = its aim: nadir for a ceiling light),
 *                    φ around it; cell centres; bilinear-ready. The lamp keeps its own lumens; the file gives the shape.
 *   gridLookup(grid, nTheta, nPhi, cosT, phi) → multiplier (bilinear, φ wraps)
 *   IesError {code: 'not_ies' | 'bad_numbers' | 'too_big' | 'unsupported'}
 *
 * LM-63 numbers after the TILT line: lamps, lumens per lamp (−1 = absolute photometry), candela multiplier, vertical angle
 * count, horizontal angle count, photometric type (1 = C, 2 = B, 3 = A), units (1 feet, 2 metres), width, length, height,
 * ballast factor, (future use / ballast-lamp factor), input watts, the vertical angles, the horizontal angles, then the candela
 * values for each horizontal angle in turn. Type C (luminaires; vertical 0 = nadir … 180 = zenith; horizontal 0 … 360, or
 * a last angle of 0 / 90 / 180 for full, quadrant and bilateral symmetry) is what lamp makers publish and what is read; types
 * A and B (floodlights, automotive) are refused as unsupported. TILT=INCLUDE data is read past and ignored (the lamp is assumed
 * upright); TILT=<file> is refused.
 */

export class IesError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const MAX_ANGLES = 4096, MAX_VALUES = 1 << 20, MAX_TEXT = 4 << 20;

export function readIes(text) {
  if (typeof text !== 'string' || !text.length) throw new IesError('not_ies', 'empty');
  if (text.length > MAX_TEXT) throw new IesError('too_big', 'file too large');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0, format = 'LM-63-1986';
  const first = lines[0].trim();
  if (/^IESNA\s*:?\s*LM-63-(\d{4})/i.test(first)) { format = 'LM-63-' + /LM-63-(\d{4})/i.exec(first)[1]; i = 1; }
  else if (/^IESNA91/i.test(first)) { format = 'LM-63-1991'; i = 1; }
  const keywords = {};
  let tilt = null;
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^TILT\s*=/i.test(l)) { tilt = l.split('=')[1].trim().toUpperCase(); i++; break; }
    const m = /^\[([A-Z0-9_]+)\]\s*(.*)$/i.exec(l);
    if (m && Object.keys(keywords).length < 200) keywords[m[1].toUpperCase()] = (keywords[m[1].toUpperCase()] ? keywords[m[1].toUpperCase()] + ' ' : '') + m[2].slice(0, 500);
  }
  if (tilt === null) throw new IesError('not_ies', 'no TILT line');
  // the rest: numbers separated by spaces, tabs, commas or new lines
  const nums = [];
  for (; i < lines.length; i++) {
    for (const tok of lines[i].split(/[\s,]+/)) {
      if (!tok) continue;
      const v = Number(tok);
      if (!Number.isFinite(v)) throw new IesError('bad_numbers', 'not a number: ' + tok.slice(0, 20));
      nums.push(v);
      if (nums.length > MAX_VALUES + 2 * MAX_ANGLES + 64) throw new IesError('too_big', 'too many values');
    }
  }
  let k = 0;
  const take = (n) => { if (k + n > nums.length) throw new IesError('bad_numbers', 'the file ends early'); const out = nums.slice(k, k + n); k += n; return out; };
  if (tilt === 'INCLUDE') {
    take(1);   // lamp-to-luminaire geometry
    const n = take(1)[0];
    if (!(Number.isInteger(n) && n >= 0 && n <= MAX_ANGLES)) throw new IesError('bad_numbers', 'tilt angle count');
    take(n); take(n);
  } else if (tilt !== 'NONE') throw new IesError('unsupported', 'TILT data in another file');
  const [lamps, lumens, multiplier, nv, nh, type, units, width, length, height] = take(10);
  take(3);   // ballast factor, future use, input watts
  if (!(Number.isInteger(nv) && Number.isInteger(nh) && nv >= 1 && nh >= 1 && nv <= MAX_ANGLES && nh <= MAX_ANGLES && nv * nh <= MAX_VALUES)) throw new IesError('bad_numbers', 'angle counts');
  if (type !== 1) throw new IesError('unsupported', 'photometric type ' + type + ' (only type C)');
  const vertical = Float64Array.from(take(nv)), horizontal = Float64Array.from(take(nh));
  const candela = Float64Array.from(take(nv * nh), (c) => Math.max(0, c * (multiplier > 0 ? multiplier : 1)));
  for (let a = 1; a < nv; a++) if (!(vertical[a] > vertical[a - 1])) throw new IesError('bad_numbers', 'vertical angles not increasing');
  for (let a = 1; a < nh; a++) if (!(horizontal[a] > horizontal[a - 1])) throw new IesError('bad_numbers', 'horizontal angles not increasing');
  if (vertical[0] < 0 || vertical[nv - 1] > 180 || horizontal[0] < 0 || horizontal[nh - 1] > 360) throw new IesError('bad_numbers', 'angles out of range');
  const ies = { format, keywords, lamps, lumens, multiplier, type, units, size: [width, length, height], vertical, horizontal, candela, flux: 0 };
  ies.flux = fluxOf(ies);
  if (!(ies.flux > 0)) throw new IesError('bad_numbers', 'no light in the file');
  return ies;
}

/** Candela at (θ, φ) degrees (θ from nadir), honouring the horizontal symmetry and the vertical range (0 outside). */
export function candelaAt(ies, thetaDeg, phiDeg) {
  const { vertical: V, horizontal: H, candela: C } = ies, nv = V.length, nh = H.length;
  if (thetaDeg < V[0] || thetaDeg > V[nv - 1]) return 0;
  let phi = ((phiDeg % 360) + 360) % 360;
  const last = H[nh - 1];
  if (nh === 1 || last === 0) phi = 0;                                  // rotationally symmetric
  else if (last === 90) { phi = phi % 180; if (phi > 90) phi = 180 - phi; }   // quadrant symmetry
  else if (last === 180) { if (phi > 180) phi = 360 - phi; }          // bilateral symmetry
  const seg = (A, x) => { let a = 0; while (a < A.length - 2 && x > A[a + 1]) a++; const t = A.length > 1 ? Math.min(1, Math.max(0, (x - A[a]) / ((A[a + 1] - A[a]) || 1))) : 0; return [a, Math.min(A.length - 1, a + 1), t]; };
  const [v0, v1, tv] = seg(V, thetaDeg);
  let h0 = 0, h1 = 0, th = 0;
  if (nh > 1) {
    if (phi > last) { h0 = nh - 1; h1 = 0; th = (phi - last) / (360 - last + H[0] || 1); }   // a full 0…<360 set wraps
    else [h0, h1, th] = seg(H, phi);
  }
  const at = (h, v) => C[h * nv + v];
  const a = at(h0, v0) * (1 - tv) + at(h0, v1) * tv, b = at(h1, v0) * (1 - tv) + at(h1, v1) * tv;
  return a * (1 - th) + b * th;
}

function fluxOf(ies) {
  // ∫ I dω over the sphere, midpoint rule on a fine grid
  const NT = 360, NP = 180;
  let f = 0;
  for (let a = 0; a < NT; a++) {
    const t = (a + 0.5) * (180 / NT), dw = Math.sin((t * Math.PI) / 180) * (Math.PI / NT) * ((2 * Math.PI) / NP);
    for (let b = 0; b < NP; b++) f += candelaAt(ies, t, (b + 0.5) * (360 / NP)) * dw;
  }
  return f;
}

export function profileGrid(ies, nTheta = 64, nPhi = 32) {
  const g = new Float32Array(nTheta * nPhi), k = (4 * Math.PI) / ies.flux;
  for (let a = 0; a < nTheta; a++) for (let b = 0; b < nPhi; b++) g[a * nPhi + b] = candelaAt(ies, ((a + 0.5) * 180) / nTheta, ((b + 0.5) * 360) / nPhi) * k;
  return g;
}

export function gridLookup(grid, nTheta, nPhi, cosT, phi) {
  const t = (Math.acos(Math.min(1, Math.max(-1, cosT))) / Math.PI) * nTheta - 0.5;
  let p = ((phi / (2 * Math.PI)) % 1 + 1) % 1 * nPhi - 0.5;
  const t0 = Math.min(nTheta - 1, Math.max(0, Math.floor(t))), t1 = Math.min(nTheta - 1, t0 + 1), ft = Math.min(1, Math.max(0, t - t0));
  if (p < 0) p += nPhi;
  const p0 = Math.floor(p) % nPhi, p1 = (p0 + 1) % nPhi, fp = p - Math.floor(p);
  const a = grid[t0 * nPhi + p0] * (1 - fp) + grid[t0 * nPhi + p1] * fp, b = grid[t1 * nPhi + p0] * (1 - fp) + grid[t1 * nPhi + p1] * fp;
  return a * (1 - ft) + b * ft;
}
