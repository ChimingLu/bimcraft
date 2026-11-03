/* SPDX-License-Identifier: Apache-2.0 */
/**
 * family-symbol.js — a family's own 2D symbol (0.7 BIM-FAM-MORE step 2, session bim-07). No DOM, no writer: bin/test-bimcraft.mjs --fammore
 * runs it in Node; family-model.js reads and evaluates it with the rest of the recipe, family-ui.js draws it in the plan.
 *
 * The symbol is part of the recipe: { mode: 'symbol' | 'cut', parts: [...] }.
 *   mode 'symbol'  the plan draws these parts for the element instead of the cut of its solids (the default once a symbol has parts)
 *   mode 'cut'     the plan keeps cutting the solids; the parts are kept in the family (and in the file's FootPrint) but not drawn
 * A part: { id, kind: line | rect | circle | arc | poly | text, visible?, pen?, fill?, zmin?, zmax?, …fields }
 *   line { x0, y0, x1, y1 } · rect { x0, y0, x1, y1 } · circle { cx, cy, r } · arc { cx, cy, r, a0, a1 } (degrees, anticlockwise from +x)
 *   poly { pts: [[x, y]…], closed } · text { x, y, h, rot?, text } (text may name parameters as {Name})
 *   Any part may carry detail: 'medium' | 'fine' (shown at that level and finer) and array { count, dx, dy }: count copies, each (dx, dy) further on (1–200).
 *   Fields are numbers or expressions over the family's number parameters (the family's own axes, mm, +y away from its back; the plan turns them
 *   with the element). pen: 1–16 (an expression or a Pen parameter); fill: a fill key or the name of a Fill parameter; visible: an expression, 0 hides.
 *   Cut-plane rule: with zmin / zmax (mm above the element's base) the part is drawn as cut (full weight) when the plan's cut is between them, as
 *   below (thin) when the cut is above zmax, as overhead (dashed) when it is below zmin. No zmin / zmax: always cut.
 *
 *   readSymbol(obj, { bad, names }) → { mode, parts } | null           untrusted: limits, ids, expressions checked against `names`
 *   symbolExprs(sym) → [[label, text]]                                 every expression, for the name check and renames
 *   evalSymbol(sym, env, texts) → [{ id, kind, …numbers, pen, fill, zmin, zmax, text }]   visible parts, numbers worked out
 *   symbolGeometry(parts, cutZ) → [{ rule, pen, kind: 'line' | 'ring' | 'text', pts | at, fill, … }]   plain 2D, family axes
 *   symbolCurves(parts) → [{ pts, closed }]                            what the file's FootPrint keeps (text is left out)
 */
import { parse, evaluate, ExprError } from './expr.js';

export const SYMBOL_KINDS = ['line', 'rect', 'circle', 'arc', 'poly', 'text'];
export const SYMBOL_FIELDS = { line: ['x0', 'y0', 'x1', 'y1'], rect: ['x0', 'y0', 'x1', 'y1'], circle: ['cx', 'cy', 'r'], arc: ['cx', 'cy', 'r', 'a0', 'a1'], text: ['x', 'y', 'h'] };
export const FILL_KEYS = ['none', 'solid', 'diagonal', 'cross', 'concrete', 'insulation', 'earth'];   // drafting.js's patterns, and none
/** 0.7 BIM-FAM-MORE (5): detail levels. A solid or part with `detail: 'medium'` shows at medium and fine, 'fine' at fine only; none = at every level. */
export const DETAIL_LEVELS = ['coarse', 'medium', 'fine'];
export const detailRank = (d) => { const i = DETAIL_LEVELS.indexOf(d); return i < 0 ? 0 : i; };
export const SYMBOL_LIMITS = { parts: 200, points: 400, expr: 300, text: 120, value: 1e7 };
const ID_RE = /^[a-z][a-z0-9_-]{0,23}$/;
const NAME_PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]{0,39})\}/g;
const CTRL = /[\u0000-\u001f\u007f]/g;

function exprField(v) {
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= SYMBOL_LIMITS.value ? String(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > SYMBOL_LIMITS.expr) return null;
  return parse(s).ok ? s : null;
}
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

export function readSymbol(obj, { bad = () => null, hosted = false } = {}) {
  if (!isObj(obj) || hosted) return null;   // a hosted family (a door, a window) keeps its starter's plan symbol
  const raw = Array.isArray(obj.parts) ? obj.parts : [];
  if (raw.length > SYMBOL_LIMITS.parts) bad('fam.err.toomany', { what: 'symbols', n: SYMBOL_LIMITS.parts });
  const parts = [], seen = new Set();
  for (const p of raw.slice(0, SYMBOL_LIMITS.parts)) {
    if (!isObj(p) || typeof p.id !== 'string' || !ID_RE.test(p.id) || seen.has(p.id) || !SYMBOL_KINDS.includes(p.kind)) { bad('fam.err.sympart', { id: String(p?.id ?? '').slice(0, 24) }); continue; }
    seen.add(p.id);
    const q = { id: p.id, kind: p.kind };
    const need = (k) => { const v = exprField(p[k]); if (v === null) bad('fam.err.symfield', { id: p.id, field: k }); return v; };
    const opt = (k) => { if (p[k] === undefined || p[k] === null || p[k] === '') return; const v = exprField(p[k]); if (v === null) bad('fam.err.symfield', { id: p.id, field: k }); else q[k] = v; };
    for (const k of SYMBOL_FIELDS[p.kind] || []) q[k] = need(k);
    if (p.kind === 'poly') {
      const pts = Array.isArray(p.pts) ? p.pts.slice(0, SYMBOL_LIMITS.points + 1) : [];
      if (pts.length < 2 || pts.length > SYMBOL_LIMITS.points) bad('fam.err.symfield', { id: p.id, field: 'pts' });
      q.pts = pts.slice(0, SYMBOL_LIMITS.points).map((pt) => (Array.isArray(pt) && pt.length >= 2 ? [exprField(pt[0]), exprField(pt[1])] : [null, null]));
      if (q.pts.some((pt) => pt[0] === null || pt[1] === null)) { bad('fam.err.symfield', { id: p.id, field: 'pts' }); q.pts = q.pts.filter((pt) => pt[0] !== null && pt[1] !== null); }
      q.closed = p.closed !== false;
    }
    if (p.kind === 'text') {
      q.text = String(p.text ?? '').replace(CTRL, ' ').slice(0, SYMBOL_LIMITS.text);
      if (!q.text.trim()) bad('fam.err.symfield', { id: p.id, field: 'text' });
      opt('rot');
    }
    opt('visible'); opt('pen'); opt('zmin'); opt('zmax');
    if (DETAIL_LEVELS.includes(p.detail) && p.detail !== 'coarse') q.detail = p.detail;
    if (p.array !== undefined && p.array !== null) {   // count and the step between copies (2D), as expressions
      const a = isObj(p.array) ? p.array : null, cnt = a ? exprField(a.count) : null;
      if (cnt === null) bad('fam.err.symfield', { id: p.id, field: 'array-count' });
      else {
        const q2 = { count: cnt };
        for (const k of ['dx', 'dy']) { const v = a[k] === undefined || a[k] === null || a[k] === '' ? '0' : exprField(a[k]); if (v === null) bad('fam.err.symfield', { id: p.id, field: 'array ' + k }); else q2[k] = v; }
        q.array = q2;
      }
    }
    if (p.fill !== undefined && p.fill !== null && p.fill !== '') {
      if (typeof p.fill === 'string' && (FILL_KEYS.includes(p.fill) || /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(p.fill))) q.fill = p.fill; else bad('fam.err.symfield', { id: p.id, field: 'fill' });
    }
    parts.push(q);
  }
  return { mode: obj.mode === 'cut' ? 'cut' : 'symbol', parts };
}

/** Every expression of the symbol as [label, text]. */
export function symbolExprs(sym) {
  const out = [];
  for (const p of sym?.parts || []) {
    const w = 'symbol ' + p.id;
    for (const k of ['visible', 'pen', 'zmin', 'zmax', 'rot', ...(SYMBOL_FIELDS[p.kind] || [])]) if (p[k] !== undefined) out.push([w + ' ' + k, p[k]]);
    if (p.array) for (const k of ['count', 'dx', 'dy']) out.push([w + ' array ' + k, p.array[k]]);
    if (p.kind === 'poly') p.pts.forEach((pt, i) => { out.push([w + ' point ' + (i + 1) + ' x', pt[0]], [w + ' point ' + (i + 1) + ' y', pt[1]]); });
  }
  return out;
}

const clampPen = (v) => Math.min(16, Math.max(1, Math.round(Number.isFinite(v) ? v : 3)));
/** The visible parts with their numbers worked out. `env` = the numbers, `texts` = the words (text, material and fill parameters). Throws ExprError with `where`. */
export function evalSymbol(sym, env, texts = {}, { rank = 2 } = {}) {
  const out = [];
  const num = (src, where) => {
    const p = parse(src);
    if (!p.ok) throw Object.assign(new ExprError(p.error), { where });
    try { return evaluate(p.ast, env); } catch (e) { if (e instanceof ExprError) e.where = where; throw e; }
  };
  const fillOf = (f) => (f === undefined ? 'none' : FILL_KEYS.includes(f) ? f : (FILL_KEYS.includes(texts[f]) ? texts[f] : 'none'));
  for (const p of sym?.parts || []) {
    const where = 'symbol ' + p.id;
    if (p.detail && detailRank(p.detail) > rank) continue;   // finer than asked for
    if (p.visible !== undefined && num(p.visible, where + ' visible') === 0) continue;
    const e = { id: p.id, kind: p.kind, pen: p.pen !== undefined ? clampPen(num(p.pen, where + ' pen')) : 3, fill: fillOf(p.fill) };
    if (p.zmin !== undefined) e.zmin = num(p.zmin, where + ' zmin');
    if (p.zmax !== undefined) e.zmax = num(p.zmax, where + ' zmax');
    for (const k of SYMBOL_FIELDS[p.kind] || []) e[k] = num(p[k], where + ' ' + k);
    if (p.kind === 'poly') { e.pts = p.pts.map((pt, i) => [num(pt[0], where + ' point ' + (i + 1)), num(pt[1], where + ' point ' + (i + 1))]); e.closed = p.closed; }
    if (p.kind === 'text') {
      e.rot = p.rot !== undefined ? num(p.rot, where + ' rot') : 0;
      e.text = p.text.replace(NAME_PLACEHOLDER, (m, name) => (name in texts ? texts[name] : name in env ? String(Math.round(env[name] * 1000) / 1000) : m));
    }
    if (p.array) {
      const n = Math.round(num(p.array.count, where + ' array-count'));
      if (!(n >= 1 && n <= SYMBOL_LIMITS.parts)) throw Object.assign(new ExprError('array-count'), { where: where + ' array-count' });
      const dx = num(p.array.dx, where + ' array-dx'), dy = num(p.array.dy, where + ' array-dy');
      for (let i = 0; i < n; i++) out.push(i === 0 ? e : moved(e, dx * i, dy * i));
      continue;
    }
    out.push(e);
  }
  return out;
}
/** An evaluated part moved by (dx, dy). */
function moved(e, dx, dy) {
  const c = { ...e };
  for (const [a, b] of [['x0', 'y0'], ['x1', 'y1'], ['cx', 'cy'], ['x', 'y']]) if (a in c) { c[a] = e[a] + dx; c[b] = e[b] + dy; }
  if (e.pts) c.pts = e.pts.map((p) => [p[0] + dx, p[1] + dy]);
  return c;
}

const arcPts = (cx, cy, r, a0, a1, step = 7.5) => {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += 360;
  const n = Math.max(2, Math.ceil(sweep / step)), pts = [];
  for (let i = 0; i <= n; i++) { const a = (a0 + sweep * i / n) * Math.PI / 180; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return pts;
};
const ringPts = (e) => {
  if (e.kind === 'rect') { const x0 = Math.min(e.x0, e.x1), x1 = Math.max(e.x0, e.x1), y0 = Math.min(e.y0, e.y1), y1 = Math.max(e.y0, e.y1); return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
  if (e.kind === 'circle') return arcPts(e.cx, e.cy, Math.abs(e.r), 0, 360, 7.5).slice(0, -1);
  return e.pts;
};
/** How the cut-plane rule treats a part at plan cut height `cutZ` (mm above the element's base; null = always cut). */
export function ruleOf(e, cutZ) {
  if (cutZ === null || cutZ === undefined || (e.zmin === undefined && e.zmax === undefined)) return 'cut';
  if (e.zmax !== undefined && cutZ > e.zmax) return 'below';
  if (e.zmin !== undefined && cutZ < e.zmin) return 'above';
  return 'cut';
}
/** Plain 2D items in the family's axes: lines (open polylines), rings (closed, with a fill), texts; each with its pen and cut rule. */
export function symbolGeometry(parts, cutZ = null) {
  const items = [];
  for (const e of parts) {
    const rule = ruleOf(e, cutZ);
    if (e.kind === 'text') { items.push({ kind: 'text', rule, pen: e.pen, at: [e.x, e.y], h: e.h, rot: e.rot || 0, text: e.text }); continue; }
    if (e.kind === 'line') items.push({ kind: 'line', rule, pen: e.pen, pts: [[e.x0, e.y0], [e.x1, e.y1]] });
    else if (e.kind === 'arc') items.push({ kind: 'line', rule, pen: e.pen, pts: arcPts(e.cx, e.cy, Math.abs(e.r), e.a0, e.a1) });
    else if (e.kind === 'poly' && !e.closed) items.push({ kind: 'line', rule, pen: e.pen, pts: e.pts });
    else items.push({ kind: 'ring', rule, pen: e.pen, fill: e.fill, pts: ringPts(e) });
  }
  return items;
}
/** What the file's FootPrint keeps: every shape as a polyline (circles and arcs in 7.5° chords). */
export function symbolCurves(parts) {
  const out = [];
  for (const it of symbolGeometry(parts)) if (it.kind !== 'text' && it.pts.length >= 2) out.push({ pts: it.pts, closed: it.kind === 'ring' });
  return out;
}

/**
 * The plan's scene items for one placed element (model-planview.js scene.symbols): the symbol turned by `rot` degrees and put at (x, y), one
 * item per pen so each draws at its own weight; cut parts as lines, below as thin, overhead as dashed; a solid fill as `solid`, other fills as
 * hatch strokes (`hatch(ring, pattern)` → [x1, y1, x2, y2, …], from drafting.js); texts; the first item also carries `poly` (the symbol's
 * extent) so a click on the symbol picks the element under `key`. → [] when nothing shows.
 */
export function symbolScene(parts, { x = 0, y = 0, rot = 0 } = {}, cutZ, key, hatch = () => []) {
  const a = rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const T = ([u, v]) => [x + u * c - v * s, y + u * s + v * c];
  const byPen = new Map();
  const slot = (pen) => { if (!byPen.has(pen)) byPen.set(pen, { key, lines: [], thin: [], dashed: [], solid: [], texts: [], lw: Math.round((0.5 + pen * 0.2) * 100) / 100 }); return byPen.get(pen); };
  const all = [];
  for (const it of symbolGeometry(parts, cutZ)) {
    const S = slot(it.pen);
    if (it.kind === 'text') { const p = T(it.at); S.texts.push({ p, h: it.h, text: it.text, rot: rot + it.rot }); all.push(p); continue; }
    const pts = it.pts.map(T);
    all.push(...pts);
    const dest = it.rule === 'cut' ? S.lines : it.rule === 'below' ? S.thin : S.dashed;
    const n = it.kind === 'ring' ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; dest.push([p[0], p[1], q[0], q[1]]); }
    if (it.kind === 'ring' && it.fill !== 'none' && it.rule !== 'above') {
      if (it.fill === 'solid') S.solid.push(pts);
      else { const h = hatch(pts, it.fill); for (let i = 0; i + 3 < h.length; i += 4) S.thin.push([h[i], h[i + 1], h[i + 2], h[i + 3]]); }
    }
  }
  const out = [...byPen.values()];
  if (out.length && all.length) {
    const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    out[0].poly = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }
  return out;
}
