/* SPDX-License-Identifier: Apache-2.0 */
/**
 * family-csv.js — a family's sizes from a table, and back (0.7 BIM-FAM-MORE step 7, session bim-07). No DOM, no writer: bin/test-bimcraft.mjs
 * --fammore runs it in Node; family-ops.js importSizes makes the sizes, family-ui.js asks for the file.
 *
 * A table (CSV; comma, semicolon or tab; quotes round fields with the delimiter, a doubled quote inside; BOM and CRLF fine): the first row names
 * the columns. A column is a parameter's key or its label (case does not matter), or "Name" / "Size" for the size's name. Lengths are millimetres
 * unless a unit is written (1067 mm, 42 in, 3.5 ft, 1.2 m; 3'-6" does not parse); angles degrees (a unit works too); Yes / No: yes, no, true, false,
 * 1, 0, ja, sí; text, material and fill are taken as written. A parameter with no column keeps its default; a column that is no parameter is
 * listed in `notes` and ignored. At most 200 rows and 1 MB. Untrusted input: nothing here throws on bad data, it reports.
 *
 *   parseCsv(text, delimiter?) → { rows: [[cell…]…], delimiter }
 *   sizesFromCsv(fam, text, { check }) → { sizes: [{ name, values, line }], errors: [{ line, key, fill }], notes: [{ key, fill }] }
 *        check(values) → null | { key, fill }   the family's own test of one size (evaluating it); a row it refuses is an error
 *   sizesToCsv(fam, sizes, { delimiter }) → text    Name + every input parameter; formula-looking cells quoted with a leading apostrophe; BOM + CRLF
 */
import { literal } from './expr.js';
import { inputParams, sizeValues, sizeKey, isWordKind, cleanValue, LIMITS } from './family-model.js';

export const CSV_LIMITS = { rows: LIMITS.sizes, bytes: 1048576, cell: 200 };
const YES = new Set(['yes', 'y', 'true', 't', '1', 'ja', 'si', 'sí', 'oui', 'on']);
const NO = new Set(['no', 'n', 'false', 'f', '0', 'nein', 'non', 'off', '']);

/** Split text into rows of cells; `delimiter` guessed from the first line when not given. */
export function parseCsv(text, delimiter = null) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (!delimiter) {
    const first = s.split(/\r?\n/, 1)[0] || '';
    const count = (d) => { let n = 0, q = false; for (const ch of first) { if (ch === '"') q = !q; else if (ch === d && !q) n++; } return n; };
    delimiter = [',', ';', '\t'].map((d) => [d, count(d)]).sort((a, b) => b[1] - a[1])[0][0];
  }
  const rows = [];
  let row = [], cell = '', q = false, i = 0, any = false;
  const endCell = () => { row.push(cell.length > CSV_LIMITS.cell ? cell.slice(0, CSV_LIMITS.cell) : cell); cell = ''; };
  const endRow = () => { endCell(); if (row.some((c) => c.trim() !== '') || any) rows.push(row); row = []; any = false; };
  for (; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"' && cell === '') { q = true; any = true; }
    else if (ch === delimiter) { endCell(); any = true; }
    else if (ch === '\r') { if (s[i + 1] === '\n') i++; endRow(); }
    else if (ch === '\n') endRow();
    else cell += ch;
  }
  if (cell !== '' || row.length) endRow();
  return { rows: rows.filter((r) => r.some((c) => c.trim() !== '')), delimiter };
}

const norm = (x) => String(x ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** One cell as a parameter's value, or { bad: key }. */
function cellValue(p, raw) {
  const t = String(raw ?? '').trim();
  if (isWordKind(p.kind)) return { value: cleanValue(p.kind, t === '' ? p.value : t) };
  if (p.kind === 'yesno') { const k = norm(t); if (YES.has(k)) return { value: 1 }; if (NO.has(k)) return { value: 0 }; return { bad: 'fam.err.csvvalue' }; }
  if (t === '') return { value: p.value };
  const plain = Number(t.replace(',', '.'));
  const n = /^[-+]?\d*[.,]?\d+(e[-+]?\d+)?$/i.test(t) ? plain : literal(t.replace(',', '.').replace(/^([-+]?[\d.]+)\s+([A-Za-z°"']+)$/, '$1$2'));   // a space between the number and its unit is fine
  if (n === null || !Number.isFinite(n) || Math.abs(n) > LIMITS.value) return { bad: 'fam.err.csvvalue' };
  return { value: cleanValue(p.kind, n) };
}

export function sizesFromCsv(fam, text, { check = null } = {}) {
  const out = { sizes: [], errors: [], notes: [] };
  const src = String(text ?? '');
  if (src.length > CSV_LIMITS.bytes) { out.errors.push({ line: 0, key: 'fam.err.csvbig', fill: { n: Math.round(CSV_LIMITS.bytes / 1024) } }); return out; }
  const { rows } = parseCsv(src);
  if (rows.length < 2) { out.errors.push({ line: 0, key: 'fam.err.csvempty', fill: {} }); return out; }
  const params = inputParams(fam), header = rows[0].map(norm);
  const col = new Map();   // column index → parameter
  let nameCol = -1;
  header.forEach((h, i) => {
    if (h === '') return;
    const p = params.find((x) => norm(x.key) === h || (x.label && norm(x.label) === h));
    if (p && ![...col.values()].includes(p)) col.set(i, p);
    else if ((h === 'name' || h === 'size') && nameCol < 0) nameCol = i;
    else out.notes.push({ key: 'fam.csv.ignored', fill: { column: rows[0][i].slice(0, 40) } });
  });
  if (!col.size) { out.errors.push({ line: 1, key: 'fam.err.csvcols', fill: {} }); return out; }
  const seen = new Set();
  const body = rows.slice(1);
  if (body.length > CSV_LIMITS.rows) { out.errors.push({ line: 0, key: 'fam.err.csvrows', fill: { n: CSV_LIMITS.rows } }); }
  body.slice(0, CSV_LIMITS.rows).forEach((r, k) => {
    const line = k + 2, values = {};
    let failed = false;
    for (const [i, p] of col) {
      const c = cellValue(p, r[i]);
      if (c.bad) { out.errors.push({ line, key: c.bad, fill: { line, column: p.label || p.key, value: String(r[i] ?? '').slice(0, 40) } }); failed = true; } else values[p.key] = c.value;
    }
    if (failed) return;
    const sv = sizeValues(fam, values), key = sizeKey(fam, sv);
    if (seen.has(key)) { out.notes.push({ key: 'fam.csv.duplicate', fill: { line } }); return; }
    const bad = check ? check(sv) : null;
    if (bad) { out.errors.push({ line, key: 'fam.err.csvrow', fill: { line, why: bad.key, ...bad.fill } }); return; }
    seen.add(key);
    const name = nameCol >= 0 ? String(r[nameCol] ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name) : '';
    out.sizes.push({ name, values: sv, line });
  });
  return out;
}

/** The sizes as a table: Name and every input parameter (lengths and the rest in millimetres, degrees, 1 / 0). */
export function sizesToCsv(fam, sizes, { delimiter = ',' } = {}) {
  const params = inputParams(fam);
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;   // a cell a spreadsheet would run as a formula is kept as text
    return /[",;\t\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [['Name', ...params.map((p) => p.label || p.key)].map(cell).join(delimiter)];
  for (const z of sizes) {
    const v = sizeValues(fam, z.values);
    lines.push([z.name || '', ...params.map((p) => (p.kind === 'yesno' ? (v[p.key] ? 'Yes' : 'No') : v[p.key]))].map(cell).join(delimiter));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}
