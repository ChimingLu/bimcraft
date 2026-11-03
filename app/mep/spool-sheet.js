/* SPDX-License-Identifier: Apache-2.0 */
/**
 * mep/spool-sheet.js — spool sheets as PDF and CSV (0.7 LC.9 item 5, session `mep-07`). No DOM, no library: bin/test-bimcraft.mjs
 * --mep07 writes them and reads them back (and with poppler's pdftotext when it is installed).
 *
 *   spoolPdf(sheets, { L, words, paper, project, date }) → { bytes, missing }   one page per spool (mep/spools.js spoolSheet):
 *       left, the spool in a 30° isometric view (its centre line, parts, cut numbers on the straight lengths, shop welds as dots,
 *       field welds as FW marks, the north arrow); right, the title block (spool id, run, system, size, schedule, length) and the
 *       tables: cut lengths, fittings, welds, bill of materials; the honesty notes under them.
 *   spoolCsvRows(sheets, { L, words }) → rows   one section per spool (cuts, fittings, welds, BOM), for csvOf
 *   words(key, fill) → the words in the person's language (the app's t); L(mm) → a length in the drawing's units.
 * Text is Helvetica in WinAnsiEncoding (characters outside it print as "?" and are counted in `missing`).
 */
const PAPER = { letter: [279.4, 215.9], a4: [297, 210], tabloid: [431.8, 279.4], a3: [420, 297] };
const PT = 72 / 25.4;
const HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const textW = (s, size) => { let w = 0; for (const ch of String(s)) { const c = ch.charCodeAt(0); w += c >= 32 && c <= 126 ? HW[c - 32] : 556; } return w / 1000 * size; };
const WIN = { '²': 0xb2, '³': 0xb3, '°': 0xb0, '×': 0xd7, '—': 0x97, '–': 0x96, '’': 0x92, '“': 0x93, '”': 0x94, '…': 0x85, 'Ø': 0xd8, 'ø': 0xf8 };
const num = (v) => { const s = (Math.abs(v) < 5e-5 ? 0 : v).toFixed(3); return s.replace(/\.?0+$/, '') || '0'; };

class Page {
  constructor(W, H) { this.W = W; this.H = H; this.ops = []; this.missing = 0; }
  // mm on the sheet, y up from the bottom
  width(mm) { this.ops.push(num(mm * PT) + ' w'); }
  line(a, b) { this.ops.push(num(a[0] * PT) + ' ' + num(a[1] * PT) + ' m ' + num(b[0] * PT) + ' ' + num(b[1] * PT) + ' l S'); }
  poly(pts) { if (pts.length < 2) return; this.ops.push(pts.map((p, i) => num(p[0] * PT) + ' ' + num(p[1] * PT) + (i ? ' l' : ' m')).join(' ') + ' S'); }
  rect(x, y, w, h) { this.ops.push(num(x * PT) + ' ' + num(y * PT) + ' ' + num(w * PT) + ' ' + num(h * PT) + ' re S'); }
  dot(c, r, fill = true) {
    const k = 0.5523 * r, [x, y] = c, P = (a, b) => num(a * PT) + ' ' + num(b * PT);
    this.ops.push(P(x + r, y) + ' m ' + P(x + r, y + k) + ' ' + P(x + k, y + r) + ' ' + P(x, y + r) + ' c ' + P(x - k, y + r) + ' ' + P(x - r, y + k) + ' ' + P(x - r, y) + ' c ' + P(x - r, y - k) + ' ' + P(x - k, y - r) + ' ' + P(x, y - r) + ' c ' + P(x + k, y - r) + ' ' + P(x + r, y - k) + ' ' + P(x + r, y) + ' c ' + (fill ? 'f' : 'S'));
  }
  text(x, y, s, size = 2.6, { bold = false, align = 'left' } = {}) {
    let out = '';
    for (const ch of String(s)) {
      let c = WIN[ch] ?? ch.codePointAt(0);
      if (c > 0xff || c < 0x20 || (c >= 0x7f && c < 0xa0 && WIN[ch] === undefined)) { c = 0x3f; this.missing++; }
      out += c === 0x28 || c === 0x29 || c === 0x5c ? '\\' + String.fromCharCode(c) : c < 0x7f ? String.fromCharCode(c) : '\\' + c.toString(8).padStart(3, '0');
    }
    const w = textW(s, size * PT) / PT;
    const x0 = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.ops.push('BT /' + (bold ? 'F2' : 'F1') + ' ' + num(size * PT) + ' Tf ' + num(x0 * PT) + ' ' + num(y * PT) + ' Td (' + out + ') Tj ET');   // i18n-ignore: PDF operators
  }
}

/** The isometric projection of plan mm (x east, y north, z up). */
const iso = (p) => [(p[0] - p[1]) * Math.cos(Math.PI / 6), (p[0] + p[1]) * Math.sin(Math.PI / 6) + p[2]];

function drawIso(pg, sh, box, words) {
  const all = sh.lines.flatMap((l) => l.pts.map(iso));
  if (!all.length) return;
  const x0 = Math.min(...all.map((q) => q[0])), x1 = Math.max(...all.map((q) => q[0])), y0 = Math.min(...all.map((q) => q[1])), y1 = Math.max(...all.map((q) => q[1]));
  const pad = 14, s = Math.min((box.w - 2 * pad) / Math.max(1, x1 - x0), (box.h - 2 * pad) / Math.max(1, y1 - y0));
  const cx = box.x + box.w / 2 - (x0 + x1) / 2 * s, cy = box.y + box.h / 2 - (y0 + y1) / 2 * s;
  const P = (p) => { const q = iso(p); return [cx + q[0] * s, cy + q[1] * s]; };
  for (const l of sh.lines) {
    pg.width(l.kind === 'pipe' ? 0.7 : 0.5);
    pg.poly(l.pts.map(P));
    if (l.kind === 'pipe' && l.n) { const a = P(l.pts[0]), b = P(l.pts[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; pg.dot([m[0], m[1] + 3.2], 2.4, false); pg.text(m[0], m[1] + 2.3, String(l.n), 2.4, { align: 'center' }); }
    if (l.kind === 'valve') { const a = P(l.pts[0]), b = P(l.pts[1]); pg.width(0.35); pg.line([a[0], a[1] - 1.5], [b[0], b[1] + 1.5]); pg.line([a[0], a[1] + 1.5], [b[0], b[1] - 1.5]); }
  }
  pg.width(0.3);
  for (const wd of sh.welds) { const q = P(wd.at); if (wd.kind === 'shop') pg.dot(q, 0.9); else { pg.dot(q, 1.5, false); pg.text(q[0] + 2, q[1] - 3.5, wd.n, 2.2, { bold: true }); } }
  // the plan's north: an arrow along +y in the iso view
  const o = [box.x + 10, box.y + 12], n = iso([0, 1, 0]), nl = Math.hypot(n[0], n[1]);
  pg.width(0.35); pg.line(o, [o[0] + n[0] / nl * 8, o[1] + n[1] / nl * 8]); pg.text(o[0] + n[0] / nl * 9.5, o[1] + n[1] / nl * 9.5, words('mep.sp.north'), 2.4);
  pg.rect(box.x, box.y, box.w, box.h);
}

/** A small table: rows of cells under a heading; → the y it ended at. */
function table(pg, x, y, w, title, head, rows, cols) {
  pg.text(x, y, title, 3, { bold: true });
  y -= 4.6;
  const step = 3.9;
  let cx = x;
  head.forEach((h, i) => { pg.text(cols[i] === 'r' ? cx + colW(w, cols, i) - 1 : cx, y, h, 2.4, { bold: true, align: cols[i] === 'r' ? 'right' : 'left' }); cx += colW(w, cols, i); });
  pg.width(0.2); pg.line([x, y - 1.2], [x + w, y - 1.2]);
  for (const r of rows) {
    y -= step; cx = x;
    r.forEach((c, i) => { pg.text(cols[i] === 'r' ? cx + colW(w, cols, i) - 1 : cx, y, c, 2.4, { align: cols[i] === 'r' ? 'right' : 'left' }); cx += colW(w, cols, i); });
  }
  return y - 6;
}
const colW = (w, cols, i) => { const weights = cols.map((c) => (c === 'w' ? 3 : 1)); return w * weights[i] / weights.reduce((a, b) => a + b, 0); };

const fitText = (f, words) => (f.kind === 'bend' ? words('mep.sp.fit.bend', { a: f.angle }) : f.kind === 'valve' ? words('mep.valve.' + f.valve) : words('mep.fit.' + f.kind)) + (f.generic ? ' ' + words('mep.sp.generic') : '');

export function spoolPdf(sheets, { L = (mm) => Math.round(mm) + ' mm', words = (k) => k, paper = 'letter', project = '', date = '' } = {}) {   // i18n-ignore: default unit for tests
  const [W, H] = PAPER[paper] || PAPER.letter;
  const pages = [];
  let missing = 0;
  for (const sh of sheets) {
    const pg = new Page(W, H);
    const m = 10, split = W * 0.58;
    pg.width(0.5); pg.rect(m, m, W - 2 * m, H - 2 * m);
    drawIso(pg, sh, { x: m + 3, y: m + 3, w: split - m - 6, h: H - 2 * m - 6 }, words);
    // the title block
    const x = split + 2, tw = W - m - 3 - x;
    let y = H - m - 8;
    pg.text(x, y, words('mep.sp.sheet.title', { id: sh.id }), 5, { bold: true });
    y -= 6.5;
    for (const line of [words('mep.sp.sheet.run', { size: sh.sizeLabel, sch: sh.sch, sys: words('mep.sys.' + sh.system) }), words('mep.sp.sheet.len', { len: L(sh.length) }), project, date].filter(Boolean)) { pg.text(x, y, line, 2.8); y -= 4.2; }
    y -= 2;
    y = table(pg, x, y, tw, words('mep.sp.cuts'), [words('mep.sp.c.n'), words('mep.sp.c.size'), words('mep.sp.c.len')], sh.cuts.map((c) => [String(c.n), sh.sizeLabel + ' ' + words('mep.sp.sch', { s: sh.sch }), L(c.length)]), ['l', 'w', 'r']);
    y = table(pg, x, y, tw, words('mep.sp.fittings'), [words('mep.sp.c.qty'), words('mep.sp.c.what'), words('mep.sp.c.size')], sh.fittings.map((f) => [String(f.qty), fitText(f, words), f.size]), ['l', 'w', 'r']);
    y = table(pg, x, y, tw, words('mep.sp.welds'), [words('mep.sp.c.n'), words('mep.sp.c.kind'), words('mep.sp.c.size')], sh.welds.map((wd) => [wd.n, words('mep.sp.weld.' + wd.kind), wd.size]), ['l', 'w', 'r']);
    y = table(pg, x, y, tw, words('mep.sp.bom'), [words('mep.sp.c.qty'), words('mep.sp.c.what'), words('mep.sp.c.kg')],
      sh.bom.map((b) => [b.item === 'pipe' ? L(b.qty) : String(b.qty), b.item === 'pipe' ? words('mep.sp.bom.pipe', { size: b.size, sch: b.sch }) : fitText({ kind: b.item, angle: b.angle, valve: b.valve, generic: b.generic }, words) + ' ' + b.size, b.kg === null ? '—' : (Math.round(b.kg * 10) / 10) + ' kg']), ['l', 'w', 'r']);   // i18n-ignore: unit
    for (const note of [words('mep.sp.note.cut'), words('mep.sp.note.generic'), words('mep.sp.note.aid')]) { if (y < m + 6) break; for (const part of wrap(note, tw, 2.3)) { pg.text(x, y, part, 2.3); y -= 3.3; } y -= 1; }
    missing += pg.missing;
    pages.push(pg);
  }
  return { bytes: assemble(pages, W, H, sheets.map((s) => s.id).join(', ')), missing };
}
function wrap(s, w, size) { const out = []; let cur = ''; for (const word of String(s).split(/\s+/)) { const t = cur ? cur + ' ' + word : word; if (textW(t, size * PT) / PT > w && cur) { out.push(cur); cur = word; } else cur = t; } if (cur) out.push(cur); return out; }

function assemble(pages, W, H, title) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const catalog = add(''), tree = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const pg of pages) {
    const body = pg.ops.join('\n');
    const content = add('<< /Length ' + body.length + ' >>\nstream\n' + body + '\nendstream');
    kids.push(add('<< /Type /Page /Parent ' + tree + ' 0 R /MediaBox [0 0 ' + num(W * PT) + ' ' + num(H * PT) + '] /Contents ' + content + ' 0 R /Resources << /Font << /F1 ' + f1 + ' 0 R /F2 ' + f2 + ' 0 R >> >> >>'));
  }
  objs[catalog - 1] = '<< /Type /Catalog /Pages ' + tree + ' 0 R >>';
  objs[tree - 1] = '<< /Type /Pages /Kids [' + kids.map((k) => k + ' 0 R').join(' ') + '] /Count ' + kids.length + ' >>';
  const info = add('<< /Producer (CadCraft BimCraft) /Title (' + String(title).replace(/[()\\]/g, '').replace(/[^\x20-\x7e]/g, '?').slice(0, 200) + ') >>');
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = out.length;
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalog + ' 0 R /Info ' + info + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

/** CSV rows for the spools: a block per spool (its id and size, then its cuts, fittings, welds and bill of materials). */
export function spoolCsvRows(sheets, { L = (mm) => String(Math.round(mm)), words = (k) => k } = {}) {
  const rows = [[words('mep.sp.c.spool'), words('mep.sp.c.section'), words('mep.sp.c.n'), words('mep.sp.c.what'), words('mep.sp.c.size'), words('mep.sp.c.qty'), words('mep.sp.c.len'), words('mep.sp.c.kg')]];
  for (const sh of sheets) {
    for (const c of sh.cuts) rows.push([sh.id, words('mep.sp.cuts'), c.n, words('mep.sp.bom.pipe', { size: sh.sizeLabel, sch: sh.sch }), sh.sizeLabel, 1, L(c.length), '']);
    for (const f of sh.fittings) rows.push([sh.id, words('mep.sp.fittings'), '', fitText(f, words), f.size, f.qty, '', '']);
    for (const wd of sh.welds) rows.push([sh.id, words('mep.sp.welds'), wd.n, words('mep.sp.weld.' + wd.kind), wd.size, 1, '', '']);
    for (const b of sh.bom) rows.push([sh.id, words('mep.sp.bom'), '', b.item === 'pipe' ? words('mep.sp.bom.pipe', { size: b.size, sch: b.sch }) : fitText({ kind: b.item, angle: b.angle, valve: b.valve, generic: b.generic }, words), b.size, b.item === 'pipe' ? '' : b.qty, b.item === 'pipe' ? L(b.qty) : '', b.kg === null ? '' : Math.round(b.kg * 100) / 100]);
  }
  return rows;
}
