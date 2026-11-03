/* SPDX-License-Identifier: Apache-2.0 */
/**
 * assets-bim-xlsx.js — a small Office Open XML workbook writer and reader for the COBie spreadsheet (0.7 LC.12 item 2,
 * session bim-ops). No library. DOM-free (node bin/test-bimcraft.mjs --ops --only cobie; read back and written by openpyxl
 * as the oracle). The writer follows takeoffcraft/dev/xlsx.js (zip + workbook parts); BimCraft cannot import another app's
 * folder, so the parts it needs are here, with the zip and XML reader taken from bcf.js.
 *
 *   writeXlsx([{ name, rows: [[cell…]…], cols?: [widths], freeze?: rows }], { title }) → Promise<Uint8Array>
 *       cell = null | 'text' | number | { v, s: 'head' }. Every text is an inline string (never a formula). Text that a
 *       spreadsheet would take for a formula if it were typed (= + - @ first) is stored with quotePrefix, so it shows as
 *       the text it is, and stays text when the cell is edited.
 *   readXlsx(bytes) → Promise<{ sheets: [{ name, rows: [[string…]…] }], formulas: n }>   untrusted input:
 *       zip and XML limits from bcf.js; ≤ MAX_SHEETS sheets, ≤ MAX_ROWS rows, ≤ MAX_COLS columns, each value ≤ MAX_TEXT
 *       characters; a formula cell gives its last computed value as text and is counted (the formula is never kept or run);
 *       numbers as written ('12.5'), booleans 'TRUE' / 'FALSE', errors as their text.
 *   serialDay(n) → 'YYYY-MM-DD' | ''   a spreadsheet date number (1900 system) as a day
 */
import { unzip, parseXml } from './bcf.js';

export const MAX_SHEETS = 64, MAX_ROWS = 20000, MAX_COLS = 200, MAX_TEXT = 1000;
const enc = new TextEncoder();

// ---------------------------------------------------------------- zip (deflated when the runtime can)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()); } catch { return null; }
}
async function zip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, name = enc.encode(f.name), crc = crc32(data);
    let body = data, method = 0;
    const d = await deflateRaw(data);
    if (d && d.length < data.length) { body = d; method = 8; }
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
    lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, body.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(lh.buffer), name, body);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true);
    ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, body.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

// ---------------------------------------------------------------- writing
/** cellXfs: 0 plain, 1 heading (bold, rule under), 2 text kept as typed (quotePrefix), 3 a heading kept as typed. */
const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" quotePrefix="1"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" quotePrefix="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/** XML text: escape, and drop what XML 1.0 forbids (a name from a file could hold it). */
export function xmlText(s) {
  return String(s).replace(/[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function colName(i) { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
export const looksLikeFormula = (s) => /^[=+\-@\t\r]/.test(String(s));

function cellXml(v, r, c) {
  if (v === null || v === undefined || v === '') return '';
  const cell = typeof v === 'object' ? v : { v };
  const at = ' r="' + colName(c) + (r + 1) + '"';
  if (typeof cell.v === 'number') return Number.isFinite(cell.v) ? '<c' + at + (cell.s === 'head' ? ' s="1"' : '') + '><v>' + (Object.is(cell.v, -0) ? '0' : String(cell.v)) + '</v></c>' : '';
  const text = String(cell.v);
  const s = (cell.s === 'head' ? 1 : 0) + (looksLikeFormula(text) ? 2 : 0);
  return '<c' + at + (s ? ' s="' + s + '"' : '') + ' t="inlineStr"><is><t xml:space="preserve">' + xmlText(text) + '</t></is></c>';
}
function sheetXml(sh) {
  const cols = (sh.cols || []).map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('');
  const rows = sh.rows.map((row, r) => '<row r="' + (r + 1) + '">' + (row || []).map((v, c) => cellXml(v, r, c)).join('') + '</row>').join('');
  const freeze = sh.freeze ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="' + sh.freeze + '" topLeftCell="A' + (sh.freeze + 1) + '" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + freeze + (cols ? '<cols>' + cols + '</cols>' : '') + '<sheetData>' + rows + '</sheetData></worksheet>';
}
const sheetName = (name, used) => {
  const base = String(name).replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Sheet';
  let n = base, k = 2;
  while (used.has(n.toLowerCase())) n = base.slice(0, 31 - String(k).length - 1) + ' ' + k++;
  used.add(n.toLowerCase());
  return n;
};

export async function writeXlsx(sheets, { title = '', created = new Date() } = {}) {
  const used = new Set(), named = sheets.map((s) => ({ ...s, name: sheetName(s.name, used) }));
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const files = [
    { name: '[Content_Types].xml', data: X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + named.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('')
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>' },
    { name: '_rels/.rels', data: X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>' },
    { name: 'docProps/core.xml', data: X + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
      + '<dc:title>' + xmlText(title) + '</dc:title><dc:creator>BimCraft</dc:creator>'
      + '<dcterms:created xsi:type="dcterms:W3CDTF">' + created.toISOString().replace(/\.\d+Z$/, 'Z') + '</dcterms:created></cp:coreProperties>' },
    { name: 'xl/workbook.xml', data: X + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<bookViews><workbookView/></bookViews><sheets>' + named.map((s, i) => '<sheet name="' + xmlText(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + named.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('')
      + '<Relationship Id="rId' + (named.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...named.map((s, i) => ({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(s) })),
  ];
  return zip(files);
}

// ---------------------------------------------------------------- reading (untrusted)
const dec = new TextDecoder();
const kids = (n, name) => (n ? n.children.filter((c) => c.name === name) : []);
const kid = (n, name) => n?.children.find((c) => c.name === name) || null;
/** A string item (<si> or <is>): its <t>, or its rich-text runs' <t>s joined; phonetic runs (<rPh>) left out. */
const itemText = (n) => (kid(n, 't') ? kid(n, 't').text : kids(n, 'r').map((r) => kid(r, 't')?.text || '').join(''));
const clipText = (s) => String(s ?? '').slice(0, MAX_TEXT);
/** "AB12" → column 27 (0-based); null when not a cell reference. */
function colOf(ref) {
  const m = /^([A-Z]{1,3})\d+$/.exec(String(ref || ''));
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
}
const resolve = (base, target) => {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (base + target).split('/'), out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
};

export async function readXlsx(bytes) {
  const files = await unzip(bytes);
  const get = (name) => { const b = files.get(name); return b ? parseXml(dec.decode(b)) : null; };
  const wb = get('xl/workbook.xml');
  if (!wb) throw Object.assign(new Error('not a workbook'), { key: 'assets.cobie.err.not-xlsx' });   // i18n-ignore: internal: the error carries a key
  const rels = new Map(kids(kid(get('xl/_rels/workbook.xml.rels'), 'Relationships'), 'Relationship').map((r) => [r.attrs.Id, r.attrs.Target]));
  const shared = kids(kid(get('xl/sharedStrings.xml'), 'sst'), 'si').map((si) => clipText(itemText(si)));
  const list = kids(kid(kid(wb, 'workbook'), 'sheets'), 'sheet');
  if (list.length > MAX_SHEETS) throw Object.assign(new Error('too many sheets'), { key: 'assets.cobie.err.too-big' });   // i18n-ignore: internal: the error carries a key
  let formulas = 0;
  const sheets = [];
  for (const s of list) {
    const target = rels.get(s.attrs.id);
    const doc = target ? get(resolve('xl/', target)) : null;
    const rowsEl = kids(kid(kid(doc, 'worksheet'), 'sheetData'), 'row');
    if (rowsEl.length > MAX_ROWS) throw Object.assign(new Error('too many rows'), { key: 'assets.cobie.err.too-big' });   // i18n-ignore: internal: the error carries a key
    const rows = [];
    let rAt = 0;
    for (const row of rowsEl) {
      const r = Number(row.attrs.r) > 0 ? Number(row.attrs.r) - 1 : rAt;
      if (r >= MAX_ROWS) throw Object.assign(new Error('too many rows'), { key: 'assets.cobie.err.too-big' });   // i18n-ignore: internal: the error carries a key
      rAt = r + 1;
      const cells = [];
      let cAt = 0;
      for (const c of kids(row, 'c')) {
        const col = colOf(c.attrs.r) ?? cAt;
        cAt = col + 1;
        if (col >= MAX_COLS) continue;
        const t = c.attrs.t || 'n', v = kid(c, 'v')?.text ?? '';
        if (kid(c, 'f')) formulas++;
        let text;
        if (t === 's') text = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') text = itemText(kid(c, 'is'));
        else if (t === 'b') text = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : v;
        else text = v;   // n, str (a formula's text), e (an error), d (an ISO date)
        cells[col] = clipText(text);
      }
      rows[r] = Array.from({ length: cells.length }, (_, i) => cells[i] ?? '');
    }
    sheets.push({ name: clipText(s.attrs.name), rows: Array.from({ length: rows.length }, (_, i) => rows[i] || []) });
  }
  return { sheets, formulas };
}

export function serialDay(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 1 || x > 2958465) return '';
  // the 1900 system counts a 29 February 1900 that never was: day 60; days after it are one off
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(x) * 86400000 + (x < 61 ? 86400000 : 0));
  return d.toISOString().slice(0, 10);
}
