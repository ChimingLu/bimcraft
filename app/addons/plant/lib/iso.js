/* SPDX-License-Identifier: Apache-2.0 */
/**
 * iso.js — piping isometrics (0.7 LC.5 step 2, session plant-design). DOM-free (tested in Node).
 *
 * Draws pipe runs as an isometric drawing: the usual 30° projection, pipe on its centre line, elbows and welds marked, valves
 * as symbols turned along the pipe, a flow arrow, the length of every leg, elevations at the ends, spool balloons where the
 * runs carry spool ranges, a bill of materials and a title block, fitted to a sheet. An isometric is Not To Scale: the drawing
 * says so. The result is a list of plain 2D entities in paper millimetres (the same shapes CadCraft draws: line, circle, arc,
 * poly, hatch, text), so it goes to a sheet, to SVG or to DXF the same way. A drafting aid.
 *
 *   iso({ runs, sheet?, units?, title?, north?, welds? }) → { entities, paper: { w, h }, scale, bom, notes }
 *     runs: [{ id, tag?, size, mat, cls, spec?, od (mm), points: [[x, y, z] mm], valves: [{ s (mm along), kind }], spools?: [{ id, s0, s1 }] }]
 *     sheet: { w, h } paper mm (default A3 420 × 297); units 'mm' | 'in' (feet and inches); north: degrees the plant's +Y is turned from
 *     "up-left" (0); title: { project, drawing, rev, drawn, date }
 *   project([x, y, z]) → [u, v]          the isometric position of a point (before fitting)
 *   bom(runs, units) → { columns, rows }          fmtLen(mm, units) → '1250' | "4'-1 1/4\""
 *   toSvg(result) → string        toDxf(result) → string (ASCII DXF, R12: LINE, CIRCLE, ARC, TEXT, SOLID)
 */

import { t } from './core.js';   // the add-on's words (main.js setT(api.t)); the drawing's text is the person's language

const C30 = Math.cos(Math.PI / 6), S30 = 0.5;
export const project = ([x, y, z]) => [(x - y) * C30, z + (x + y) * S30];
const rotated = (p, deg) => { const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]; };

export function fmtLen(mm, units = 'mm') {
  if (units !== 'in') return String(Math.round(mm));
  let eighths = Math.round((mm / 25.4) * 8);   // to 1/8 in
  const ft = Math.floor(eighths / 96); eighths -= ft * 96;
  const inch = Math.floor(eighths / 8), fr = eighths - inch * 8;
  const frac = fr ? ' ' + (fr % 4 === 0 ? fr / 4 + '/2' : fr % 2 === 0 ? fr / 2 + '/4' : fr + '/8') : '';
  return (ft ? ft + "'-" : '') + inch + frac + '"';
}

function pointAt(pts, s) {
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (s <= run + l + 1e-9) { const t = l ? (s - run) / l : 0; return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], dir: [(b[0] - a[0]) / (l || 1), (b[1] - a[1]) / (l || 1), (b[2] - a[2]) / (l || 1)] }; }
    run += l;
  }
  const a = pts[pts.length - 2], b = pts[pts.length - 1], l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
  return { p: b.slice(), dir: [(b[0] - a[0]) / l, (b[1] - a[1]) / l, (b[2] - a[2]) / l] };
}
const legLen = (pts) => { let n = 0; for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]); return n; };

const VALVES = ['gate', 'globe', 'ball', 'check'];
export function bom(runs, units = 'mm') {
  const rows = new Map();
  const add = (key, desc, size, spec, qty, unit, rank = 5) => { const r = rows.get(key) || { desc, size, spec, qty: 0, unit, rank }; r.qty += qty; rows.set(key, r); };
  for (const r of runs) {
    const spec = r.spec || [r.mat, r.cls].filter(Boolean).join(' ');
    add('pipe|' + r.size + '|' + spec, t('iso.bom.pipe'), r.size, spec, legLen(r.points), 'len', 0);
    const turns = r.points.length - 2;
    for (let i = 1; i <= turns; i++) {
      const a = r.points[i - 1], b = r.points[i], c = r.points[i + 1];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
      const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v));
      const ang = Math.round((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
      add('elbow|' + ang + '|' + r.size + '|' + spec, t('iso.bom.elbow', { deg: ang }), r.size, spec, 1, 'ea');
    }
    for (const v of r.valves || []) add('valve|' + v.kind + '|' + r.size + '|' + spec, t(VALVES.includes(v.kind) ? 'iso.bom.valve.' + v.kind : 'iso.bom.valve'), r.size, spec, 1, 'ea');
    add('weld|' + r.size, t('iso.bom.weld'), r.size, '', Math.max(0, turns * 2 + (r.valves || []).length * 2), 'ea', 9);
  }
  const list = [...rows.values()].sort((a, b) => a.rank - b.rank || a.desc.localeCompare(b.desc) || String(a.size).localeCompare(String(b.size), 'en', { numeric: true }));
  return {
    columns: ['item', 'qty', 'description', 'size', 'spec'].map((c) => t('iso.bom.col.' + c)),
    rows: list.map((r, i) => [String(i + 1), r.unit === 'len' ? fmtLen(r.qty, units) + (units === 'in' ? '' : ' mm') : String(r.qty), r.desc, r.size, r.spec]),
  };
}

const L = (a, b, role) => ({ type: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1], role });
const T = (x, y, h, s, extra = {}) => ({ type: 'text', x, y, h, rot: 0, s: String(s), ha: 'center', va: 'middle', role: 'text', ...extra });
const dot = (c, r) => ({ type: 'hatch', solid: true, loops: [Array.from({ length: 10 }, (_, i) => [c[0] + r * Math.cos((2 * Math.PI * i) / 10), c[1] + r * Math.sin((2 * Math.PI * i) / 10)]).flat()], role: 'weld' });
const tri = (a, b, c) => ({ type: 'hatch', solid: true, loops: [[...a, ...b, ...c]], role: 'symbol' });
const readable = (a) => { let r = a % (2 * Math.PI); if (r > Math.PI) r -= 2 * Math.PI; if (r <= -Math.PI) r += 2 * Math.PI; return r > Math.PI / 2 + 1e-9 || r < -Math.PI / 2 + 1e-9 ? r + Math.PI : r; };

export function iso({ runs, sheet = { w: 420, h: 297 }, units = 'mm', title = {}, north = 0, welds = true } = {}) {
  const good = (runs || []).filter((r) => r && Array.isArray(r.points) && r.points.length >= 2);
  const proj = (p) => rotated(project(p), north);
  const all = good.flatMap((r) => r.points.map(proj));
  if (!all.length) return { entities: [], paper: { ...sheet }, scale: 1, bom: bom([], units), notes: [] };
  const lo = [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1]))], hi = [Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))];
  const bw = Math.max(hi[0] - lo[0], 1), bh = Math.max(hi[1] - lo[1], 1);
  const B = bom(good, units);
  const margin = 12, bomW = 110, titleH = 26, textH = 3;
  const availW = sheet.w - bomW - 3 * margin - 20, availH = sheet.h - titleH - 3 * margin - 20;
  const scale = Math.min(availW / bw, availH / bh);
  const ox = margin + 10 + (availW - bw * scale) / 2 - lo[0] * scale, oy = margin + titleH + margin + 10 + (availH - bh * scale) / 2 - lo[1] * scale;
  const P = (p) => { const q = proj(p); return [ox + q[0] * scale, oy + q[1] * scale]; };
  const unit = Math.max(4, Math.min(bw, bh) * scale / 12);   // the size of a valve symbol, a weld dot, the dimension offset
  const out = [];
  out.push({ type: 'poly', closed: true, pts: [[5, 5], [sheet.w - 5, 5], [sheet.w - 5, sheet.h - 5], [5, sheet.h - 5]].map(([x, y]) => ({ x, y, b: 0 })), role: 'frame' });
  for (const r of good) {
    const pts = r.points.map(P);
    out.push({ type: 'poly', closed: false, pts: pts.map(([x, y]) => ({ x, y, b: 0 })), role: 'pipe', id: r.id });
    if (welds) for (let i = 1; i < pts.length - 1; i++) out.push(dot(pts[i], unit * 0.14));
    // the flow arrow, on the middle of the first leg
    {
      const a = pts[0], b = pts[1], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, u = [(b[0] - a[0]) / l, (b[1] - a[1]) / l], n = [-u[1], u[0]];
      if (l > unit * 3) out.push(tri([m[0] + u[0] * unit * 0.5, m[1] + u[1] * unit * 0.5], [m[0] - u[0] * unit * 0.5 + n[0] * unit * 0.25, m[1] - u[1] * unit * 0.5 + n[1] * unit * 0.25], [m[0] - u[0] * unit * 0.5 - n[0] * unit * 0.25, m[1] - u[1] * unit * 0.5 - n[1] * unit * 0.25]));
    }
    // valves: a bow tie turned along the pipe
    for (const v of r.valves || []) {
      const at = pointAt(r.points, v.s), c = P(at.p), d = P([at.p[0] + at.dir[0], at.p[1] + at.dir[1], at.p[2] + at.dir[2]]);
      const u = [d[0] - c[0], d[1] - c[1]], ul = Math.hypot(...u) || 1, ux = u[0] / ul, uy = u[1] / ul, nx = -uy, ny = ux, h = unit * 0.6, hl = unit * 0.9;
      out.push({ type: 'poly', closed: true, pts: [[c[0] - ux * hl + nx * h / 2, c[1] - uy * hl + ny * h / 2], [c[0] + nx * 0, c[1]], [c[0] - ux * hl - nx * h / 2, c[1] - uy * hl - ny * h / 2]].map(([x, y]) => ({ x, y, b: 0 })), role: 'symbol' });
      out.push({ type: 'poly', closed: true, pts: [[c[0] + ux * hl + nx * h / 2, c[1] + uy * hl + ny * h / 2], [c[0], c[1]], [c[0] + ux * hl - nx * h / 2, c[1] + uy * hl - ny * h / 2]].map(([x, y]) => ({ x, y, b: 0 })), role: 'symbol' });
      if (v.kind === 'check') out.push(tri([c[0] + ux * hl + nx * h / 2, c[1] + uy * hl + ny * h / 2], c, [c[0] + ux * hl - nx * h / 2, c[1] + uy * hl - ny * h / 2]));
    }
    // dimensions: the length of every leg, a line offset from it with ticks, the number along it
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l < unit * 2.5) continue;
      const u = [(b[0] - a[0]) / l, (b[1] - a[1]) / l], n = [-u[1], u[0]], off = unit * 1.1;
      const a2 = [a[0] + n[0] * off, a[1] + n[1] * off], b2 = [b[0] + n[0] * off, b[1] + n[1] * off];
      out.push(L(a, a2, 'dim'), L(b, b2, 'dim'), L(a2, b2, 'dim'));
      const real = Math.hypot(r.points[i][0] - r.points[i - 1][0], r.points[i][1] - r.points[i - 1][1], r.points[i][2] - r.points[i - 1][2]);
      const rot = readable(Math.atan2(u[1], u[0]));
      out.push(T((a2[0] + b2[0]) / 2 + Math.sin(rot) * -textH * 0.7, (a2[1] + b2[1]) / 2 + Math.cos(rot) * textH * 0.7, textH, fmtLen(real, units), { rot, role: 'dim' }));
    }
    // elevations at the ends and where the run changes level
    const z = (i) => t('iso.el', { el: fmtLen(r.points[i][2], units) });
    const elev = (i) => { const c = pts[i]; out.push(T(c[0] + unit * 0.5, c[1] - unit * 1.2, textH * 0.9, z(i), { role: 'dim', ha: 'left' })); };
    elev(0); elev(pts.length - 1);
    for (let i = 1; i < pts.length - 1; i++) if (Math.abs(r.points[i][2] - r.points[i - 1][2]) > 1e-6 && Math.abs(r.points[i][2] - r.points[i + 1][2]) < 1e-6) elev(i);
    if (r.tag) out.push(T(pts[0][0], pts[0][1] + unit * 1.1, textH, r.tag, { ha: 'center', role: 'text' }));
    // spool balloons
    for (const sp of r.spools || []) {
      const mid = pointAt(r.points, (sp.s0 + sp.s1) / 2), c = P(mid.p);
      out.push({ type: 'circle', cx: c[0], cy: c[1] + unit * 1.8, r: unit * 0.8, role: 'symbol' }, T(c[0], c[1] + unit * 1.8, textH * 0.8, sp.id, { role: 'symbol' }), L([c[0], c[1] + unit], [c[0], c[1]], 'dim'));
    }
  }
  // north arrow
  const na = rotated([0, 1], north), nc = [sheet.w - bomW - margin * 2, sheet.h - titleH - 4];
  out.push(L([nc[0], nc[1]], [nc[0] + na[0] * 10, nc[1] + na[1] * 10], 'symbol'), T(nc[0] + na[0] * 14, nc[1] + na[1] * 14, textH, 'N', { role: 'text' }),
    tri([nc[0] + na[0] * 10, nc[1] + na[1] * 10], [nc[0] + na[0] * 6 - na[1] * 1.6, nc[1] + na[1] * 6 + na[0] * 1.6], [nc[0] + na[0] * 6 + na[1] * 1.6, nc[1] + na[1] * 6 - na[0] * 1.6]));
  // the bill of materials, top right, growing down
  const bx = sheet.w - bomW - margin, by = sheet.h - margin - 6;
  const cw = [10, 22, 40, 14, 24];
  out.push(T(bx, by, textH * 1.2, t('iso.bom.title'), { ha: 'left', role: 'bom' }));
  let y = by - 5;
  for (const [ri, row] of [B.columns, ...B.rows].entries()) {
    let x = bx;
    row.forEach((cell, j) => { out.push(T(x + 1, y - 2.5, textH * 0.8, String(cell).slice(0, 22), { ha: 'left', role: 'bom' })); x += cw[j]; });
    out.push(L([bx, y - 5], [bx + bomW, y - 5], 'bom'));
    if (ri === 0) out.push(L([bx, y], [bx + bomW, y], 'bom'));
    y -= 5;
  }
  // the title block
  const tx = margin, ty = margin + titleH;
  out.push({ type: 'poly', closed: true, pts: [[tx, margin], [sheet.w - margin, margin], [sheet.w - margin, ty], [tx, ty]].map(([x, yy]) => ({ x, y: yy, b: 0 })), role: 'frame' });
  const cells = [['project', title.project], ['drawing', title.drawing], ['rev', title.rev], ['drawn', title.drawn], ['date', title.date], ['scale', t('iso.nts')]].map(([k, v]) => [t('iso.title.' + k), v]);
  const cwid = (sheet.w - 2 * margin) / cells.length;
  cells.forEach(([k, v], i) => {
    const x0 = tx + i * cwid;
    if (i) out.push(L([x0, margin], [x0, ty], 'frame'));
    out.push(T(x0 + 2, ty - 4, textH * 0.7, k, { ha: 'left', role: 'text' }), T(x0 + 2, margin + 8, textH * 1.1, v ?? '', { ha: 'left', role: 'text' }));
  });
  return { entities: out, paper: { ...sheet }, scale, bom: B, notes: [t('iso.note.nts'), t(units === 'in' ? 'iso.note.dims.ftin' : 'iso.note.dims.mm')] };
}

// ---------------------------------------------------------------------------------------------------- files
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function toSvg({ entities, paper }) {
  const f = (n) => n.toFixed(2), Y = (y) => f(paper.h - y);
  const W = { pipe: 0.7, frame: 0.5, dim: 0.18, bom: 0.18, symbol: 0.35, text: 0.18, weld: 0.1 };
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${paper.w}mm" height="${paper.h}mm" viewBox="0 0 ${paper.w} ${paper.h}"><rect width="100%" height="100%" fill="white"/>`;
  for (const e of entities) {
    const sw = W[e.role] || 0.25;
    if (e.type === 'line') s += `<line x1="${f(e.x1)}" y1="${Y(e.y1)}" x2="${f(e.x2)}" y2="${Y(e.y2)}" stroke="black" stroke-width="${sw}"/>`;
    else if (e.type === 'circle') s += `<circle cx="${f(e.cx)}" cy="${Y(e.cy)}" r="${f(e.r)}" fill="none" stroke="black" stroke-width="${sw}"/>`;
    else if (e.type === 'poly') s += `<path d="M${e.pts.map((p) => f(p.x) + ' ' + Y(p.y)).join(' L')}${e.closed ? ' Z' : ''}" fill="none" stroke="black" stroke-width="${sw}" stroke-linejoin="round"/>`;
    else if (e.type === 'hatch') for (const l of e.loops) { const p = []; for (let i = 0; i < l.length; i += 2) p.push(f(l[i]) + ' ' + Y(l[i + 1])); s += `<path d="M${p.join(' L')} Z" fill="black"/>`; }
    else if (e.type === 'text') s += `<text x="${f(e.x)}" y="${Y(e.y)}" font-size="${f(e.h)}" font-family="Helvetica,Arial,sans-serif" text-anchor="${e.ha === 'left' ? 'start' : e.ha === 'right' ? 'end' : 'middle'}" dominant-baseline="middle" transform="rotate(${f(-(e.rot || 0) * 180 / Math.PI)} ${f(e.x)} ${Y(e.y)})">${esc(e.s)}</text>`;
  }
  return s + '</svg>';
}

export function toDxf({ entities }) {
  const g = (code, v) => code + '\n' + v + '\n';
  const num = (v) => (Number.isFinite(v) ? +v.toFixed(4) : 0);
  const layerOf = (e) => ({ pipe: 'ISO-PIPE', dim: 'ISO-DIM', bom: 'ISO-BOM', symbol: 'ISO-SYMBOL', text: 'ISO-TEXT', frame: 'ISO-FRAME', weld: 'ISO-SYMBOL' }[e.role] || '0');
  let s = g(0, 'SECTION') + g(2, 'HEADER') + g(9, '$ACADVER') + g(1, 'AC1009') + g(0, 'ENDSEC') + g(0, 'SECTION') + g(2, 'ENTITIES');
  const line = (e, x1, y1, x2, y2) => g(0, 'LINE') + g(8, layerOf(e)) + g(10, num(x1)) + g(20, num(y1)) + g(30, 0) + g(11, num(x2)) + g(21, num(y2)) + g(31, 0);
  for (const e of entities) {
    if (e.type === 'line') s += line(e, e.x1, e.y1, e.x2, e.y2);
    else if (e.type === 'circle') s += g(0, 'CIRCLE') + g(8, layerOf(e)) + g(10, num(e.cx)) + g(20, num(e.cy)) + g(30, 0) + g(40, num(e.r));
    else if (e.type === 'poly') { for (let i = 1; i < e.pts.length; i++) s += line(e, e.pts[i - 1].x, e.pts[i - 1].y, e.pts[i].x, e.pts[i].y); if (e.closed && e.pts.length > 2) s += line(e, e.pts[e.pts.length - 1].x, e.pts[e.pts.length - 1].y, e.pts[0].x, e.pts[0].y); }
    else if (e.type === 'hatch') for (const l of e.loops) {
      const p = []; for (let i = 0; i < l.length; i += 2) p.push([l[i], l[i + 1]]);
      // a SOLID takes three or four corners (its 3rd and 4th are in "bow tie" order); a bigger fill is cut into triangles from its first corner
      for (let i = 1; i + 1 < p.length; i++) { const a = p[0], b = p[i], c = p[i + 1]; s += g(0, 'SOLID') + g(8, layerOf(e)) + g(10, num(a[0])) + g(20, num(a[1])) + g(30, 0) + g(11, num(b[0])) + g(21, num(b[1])) + g(31, 0) + g(12, num(c[0])) + g(22, num(c[1])) + g(32, 0) + g(13, num(c[0])) + g(23, num(c[1])) + g(33, 0); }
    } else if (e.type === 'text') {
      const h = e.ha === 'left' ? 0 : e.ha === 'right' ? 2 : 1;
      s += g(0, 'TEXT') + g(8, layerOf(e)) + g(10, num(e.x)) + g(20, num(e.y)) + g(30, 0) + g(40, num(e.h)) + g(1, String(e.s).replace(/[\r\n]/g, ' ')) + g(50, num(((e.rot || 0) * 180) / Math.PI)) + g(72, h) + g(11, num(e.x)) + g(21, num(e.y)) + g(31, 0) + g(73, 2);
    }
  }
  return s + g(0, 'ENDSEC') + g(0, 'EOF');
}
