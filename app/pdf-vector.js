/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — PDF operator names and data fields; nothing here is read by a person. */
/**
 * pdf-vector.js — the vector content of a PDF page, for PDFATTACH (snapping, plotting) and PDFIMPORT (0.7 D7.24). DOM-free,
 * tested in Node with pdf.js's legacy build. The PDF is untrusted input: nothing here evaluates anything, every count is capped
 * and every number checked.
 *
 *   const page = await extractPage(pdfjs, pdfPage, { maxShapes })
 *     → { w, h,                       the page as displayed (rotation applied), in PDF points, origin lower-left, y up
 *         shapes: [{ stroke: '#rrggbb'|null, fill: '#rrggbb'|null, eo, lw (pt), subs: [{ closed, ops: [['M',x,y], ['L',x,y], ['C',x1,y1,x2,y2,x,y], …] }] }],
 *         texts: [{ s, x, y, h, rot, w }],   position of the baseline start, text height, angle (radians), advance width
 *         images: n (pictures in the page: not read as vectors), truncated: bool }
 *   segmentsOf(page, opts)      → { segs: Float64Array [x1,y1,x2,y2, …], curve: Uint8Array, n } flattened for snapping (pdf-snap.js)
 *   viewMatrix(view, rotate)    → [a b c d e f]: PDF user space → displayed page
 */

export const MAX_SHAPES = 300000;
export const MAX_TEXTS = 60000;

const mul = (m, k) => [m[0] * k[0] + m[2] * k[1], m[1] * k[0] + m[3] * k[1], m[0] * k[2] + m[2] * k[3], m[1] * k[2] + m[3] * k[3], m[0] * k[4] + m[2] * k[5] + m[4], m[1] * k[4] + m[3] * k[5] + m[5]];

/** PDF user space → the page as displayed: lower-left origin, y up, the page's /Rotate (clockwise multiples of 90) applied. */
export function viewMatrix(view, rotate = 0) {
  const [x0, y0, x1, y1] = view, W = x1 - x0, H = y1 - y0;
  switch (((rotate % 360) + 360) % 360) {
    case 90: return [0, -1, 1, 0, -y0, W + x0];
    case 180: return [-1, 0, 0, -1, W + x0, H + y0];
    case 270: return [0, 1, -1, 0, H + y0, -x0];
    default: return [1, 0, 0, 1, -x0, -y0];
  }
}
/** The displayed page's size [w, h] in points. */
export function displaySize(view, rotate = 0) {
  const W = Math.abs(view[2] - view[0]), H = Math.abs(view[3] - view[1]);
  return ((rotate % 180) + 180) % 180 === 90 ? [H, W] : [W, H];
}

const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
/** A colour argument of pdf.js (a '#rrggbb' string, or an array of three 0–255 numbers) → '#rrggbb', or null. */
function colorOf(a) {
  if (typeof a === 'string') return /^#[0-9a-f]{6}$/i.test(a) ? a.toLowerCase() : null;
  const c = a && (a.length === 1 ? a[0] : a);
  if (typeof c === 'string') return colorOf(c);
  if (!c || c.length < 3 || ![0, 1, 2].every((i) => Number.isFinite(+c[i]))) return null;
  return '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
}

/** The page's vector shapes and text, in displayed-page points. */
export async function extractPage(pdfjs, page, { maxShapes = MAX_SHAPES, maxTexts = MAX_TEXTS, isVisible = null } = {}) {
  const OPS = pdfjs.OPS, view = page.view, rot = page.rotate || 0;
  const [w, h] = displaySize(view, rot), V = viewMatrix(view, rot);
  const ops = await page.getOperatorList();
  const fn = ops.fnArray, args = ops.argsArray;
  const shapes = [];
  let ctm = V, lw = 1, sc = '#000000', fc = '#000000', images = 0, truncated = false;
  const stack = [];
  const mc = [];   // marked content: true while that level is switched off (a layer of the PDF)
  let off = 0;
  const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const IMG = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat, OPS.paintJpegXObject].filter((x) => x !== undefined));
  const PAINT = {
    [OPS.stroke]: { s: 1 }, [OPS.closeStroke]: { s: 1, z: 1 }, [OPS.fill]: { f: 1 }, [OPS.eoFill]: { f: 1, eo: 1 },
    [OPS.fillStroke]: { f: 1, s: 1 }, [OPS.eoFillStroke]: { f: 1, s: 1, eo: 1 }, [OPS.closeFillStroke]: { f: 1, s: 1, z: 1 }, [OPS.closeEOFillStroke]: { f: 1, s: 1, eo: 1, z: 1 },
  };
  for (let i = 0; i < fn.length; i++) {
    const f = fn[i], a = args[i];
    if (f === OPS.save) stack.push({ ctm, lw, sc, fc });
    else if (f === OPS.restore) { const s = stack.pop(); if (s) ({ ctm, lw, sc, fc } = s); }
    else if (f === OPS.transform && a && a.length >= 6) ctm = mul(ctm, Array.from(a));
    else if (f === OPS.paintFormXObjectBegin) { stack.push({ ctm, lw, sc, fc }); if (a && a[0] && a[0].length >= 6) ctm = mul(ctm, Array.from(a[0])); }
    else if (f === OPS.paintFormXObjectEnd) { const s = stack.pop(); if (s) ({ ctm, lw, sc, fc } = s); }
    else if (f === OPS.setLineWidth) lw = Number.isFinite(+a?.[0]) ? +a[0] : 1;
    else if (f === OPS.setStrokeRGBColor) sc = colorOf(a) || sc;
    else if (f === OPS.setFillRGBColor) fc = colorOf(a) || fc;
    else if (f === OPS.beginMarkedContentProps || f === OPS.beginMarkedContent) {
      let hide = false;
      if (isVisible && f === OPS.beginMarkedContentProps && a?.[0] === 'OC' && a[1] && typeof a[1] === 'object') { try { hide = isVisible(a[1]) === false; } catch { hide = false; } }
      mc.push(hide); if (hide) off++;
    } else if (f === OPS.endMarkedContent) { if (mc.pop()) off--; }
    else if (IMG.has(f)) { if (!off) images++; }
    else if (f === OPS.constructPath) {
      const kind = PAINT[a?.[0]];
      const d = a?.[1]?.[0];
      if (off || !kind || !d || typeof d.length !== 'number') continue;   // endPath (a clip or nothing drawn), or a shape this reader cannot follow
      if (shapes.length >= maxShapes) { truncated = true; continue; }
      const m = ctm, X = (x, y) => m[0] * x + m[2] * y + m[4], Y = (x, y) => m[1] * x + m[3] * y + m[5];
      const subs = [];
      let cur = null, sx = 0, sy = 0, px = 0, py = 0;
      const ok = (...v) => v.every(Number.isFinite);
      for (let k = 0; k < d.length;) {
        const c = d[k];
        if (c === 0) { const x = X(d[k + 1], d[k + 2]), y = Y(d[k + 1], d[k + 2]); if (!ok(x, y)) break; cur = { closed: false, ops: [['M', x, y]] }; subs.push(cur); sx = px = x; sy = py = y; k += 3; }
        else if (c === 1 && cur) { const x = X(d[k + 1], d[k + 2]), y = Y(d[k + 1], d[k + 2]); if (!ok(x, y)) break; cur.ops.push(['L', x, y]); px = x; py = y; k += 3; }
        else if (c === 2 && cur) {
          const c1x = X(d[k + 1], d[k + 2]), c1y = Y(d[k + 1], d[k + 2]), c2x = X(d[k + 3], d[k + 4]), c2y = Y(d[k + 3], d[k + 4]), x = X(d[k + 5], d[k + 6]), y = Y(d[k + 5], d[k + 6]);
          if (!ok(c1x, c1y, c2x, c2y, x, y)) break;
          cur.ops.push(['C', c1x, c1y, c2x, c2y, x, y]); px = x; py = y; k += 7;
        } else if (c === 3 && cur) {   // quadratic → cubic
          const qx = X(d[k + 1], d[k + 2]), qy = Y(d[k + 1], d[k + 2]), x = X(d[k + 3], d[k + 4]), y = Y(d[k + 3], d[k + 4]);
          if (!ok(qx, qy, x, y)) break;
          cur.ops.push(['C', px + 2 / 3 * (qx - px), py + 2 / 3 * (qy - py), x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y]); px = x; py = y; k += 5;
        } else if (c === 4 && cur) { cur.closed = true; px = sx; py = sy; k += 1; }
        else break;   // an operator this reader does not know: the rest of the path is dropped
      }
      if (!subs.length) continue;
      if (kind.z) for (const s of subs) s.closed = true;
      shapes.push({ stroke: kind.s ? sc : null, fill: kind.f ? fc : null, eo: !!kind.eo, lw: lw * scaleOf(ctm), subs });
    }
  }
  // text (pdf.js lays glyph runs out; positions are the baseline start in user space)
  const texts = [];
  try {
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      if (texts.length >= maxTexts) { truncated = true; break; }
      if (!it || typeof it.str !== 'string' || !it.str.trim() || !it.transform || it.transform.length < 6) continue;
      const t = it.transform, m = V;
      const x = m[0] * t[4] + m[2] * t[5] + m[4], y = m[1] * t[4] + m[3] * t[5] + m[5];
      const vx = m[0] * t[0] + m[2] * t[1], vy = m[1] * t[0] + m[3] * t[1];   // the text's x axis, displayed
      const hh = Math.hypot(m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3]);
      if (![x, y, vx, vy, hh].every(Number.isFinite) || !(hh > 0)) continue;
      texts.push({ s: it.str.slice(0, 1000), x, y, h: hh, rot: Math.atan2(vy, vx), w: Number.isFinite(it.width) ? Math.abs(it.width) * Math.hypot(m[0], m[1]) : 0 });
    }
  } catch { /* a page without readable text: shapes only */ }
  return { w, h, shapes, texts, images, truncated };
}

const CURVE_STEPS = 8;
/** The page's lines flattened for snapping: segments [x1,y1,x2,y2,…] and, per segment, 0 straight / 1 chord of a curve (2 first, 4 last). */
export function segmentsOf(pageVec, { maxSegs = 400000 } = {}) {
  let segs = new Float64Array(4096), curve = new Uint8Array(1024), n = 0;
  const push = (ax, ay, bx, by, fl) => {
    if (n >= maxSegs || (ax === bx && ay === by)) return;
    if (n * 4 >= segs.length) { const g = new Float64Array(segs.length * 2); g.set(segs); segs = g; const c2 = new Uint8Array(segs.length / 4); c2.set(curve); curve = c2; }
    segs[n * 4] = ax; segs[n * 4 + 1] = ay; segs[n * 4 + 2] = bx; segs[n * 4 + 3] = by; curve[n] = fl; n++;
  };
  for (const sh of pageVec.shapes) {
    for (const sub of sh.subs) {
      let px = 0, py = 0, sx = 0, sy = 0;
      for (const o of sub.ops) {
        if (o[0] === 'M') { px = sx = o[1]; py = sy = o[2]; }
        else if (o[0] === 'L') { push(px, py, o[1], o[2], 0); px = o[1]; py = o[2]; }
        else {
          let lx = px, ly = py;
          for (let s = 1; s <= CURVE_STEPS; s++) {
            const t = s / CURVE_STEPS, u = 1 - t;
            const x = s === CURVE_STEPS ? o[5] : u * u * u * px + 3 * u * u * t * o[1] + 3 * u * t * t * o[3] + t * t * t * o[5];
            const y = s === CURVE_STEPS ? o[6] : u * u * u * py + 3 * u * u * t * o[2] + 3 * u * t * t * o[4] + t * t * t * o[6];
            push(lx, ly, x, y, 1 | (s === 1 ? 2 : 0) | (s === CURVE_STEPS ? 4 : 0)); lx = x; ly = y;
          }
          px = o[5]; py = o[6];
        }
      }
      if (sub.closed) push(px, py, sx, sy, 0);
    }
  }
  return { segs: segs.subarray(0, n * 4), curve: curve.subarray(0, n), n };
}
