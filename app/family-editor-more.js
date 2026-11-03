/* SPDX-License-Identifier: Apache-2.0 */
/**
 * family-editor-more.js — the editor's newer panels (0.7 BIM-FAM-MORE, session bim-07), built for family-editor.js with the editor's own
 * helpers handed in as `c` ({ E, t, FE, el, input, select, btn, change, L, units, families (the other families: [[key, name]]), materials ([[id, name]]) }):
 *   symbolPanel(c)    Plan symbol [data-fe-tab="symbol"]: the symbol's parts (line, rectangle, circle, arc, polygon, text) with pen, fill, shown by,
 *                     cut-plane range, detail, repeat; what the plan shows (the symbol or the cut of the solids)
 *   partsPanel(c)     Families inside [data-fe-tab="parts"]: other families put inside this one, where, turned, with which values
 *   hotspotsPanel(c)  Hotspots [data-fe-tab="hotspots"]: points and edges that drag a parameter (handles in the preview, grips in the plan)
 *   solidExtras(c, s) → [elements]  a solid's material, the detail it shows from, and its repeat (array), under the solid's own fields
 * Logic is family-edit.js; strings fam.ed.sym.*, fam.ed.part.*, fam.ed.hot.*, fam.ed.s*.
 */
import { SYMBOL_KINDS, SYMBOL_FIELDS } from './family-symbol.js';
import { DETAIL_LEVELS, isWordKind } from './family-model.js';

const FILLS = ['none', 'solid', 'diagonal', 'cross', 'concrete', 'insulation', 'earth'];

/** The detail list: every level, medium and fine, fine only. */
function detailSelect(c, attrs, value, onChange) {
  return c.select(attrs, [['coarse', c.t('fam.ed.detail.coarse')], ['medium', c.t('fam.ed.detail.medium')], ['fine', c.t('fam.ed.detail.fine')]], value || 'coarse', onChange);
}

export function solidExtras(c, s) {
  const { E, t, el, input, select, change, FE } = c;
  const set = (patch) => change(FE.setSolid(E.fam, s.id, patch));
  const matParams = E.fam.params.filter((p) => p.kind === 'material' || p.kind === 'text').map((p) => [p.key, '⟨' + (p.label || p.key) + '⟩']);   // i18n-ignore: angle brackets mark a parameter in a list
  const matOpts = [['', t('fam.ed.smaterial.none')], ...matParams, ...c.materials];
  if (s.material && !matOpts.some(([k]) => k === s.material)) matOpts.push([s.material, s.material]);
  const out = [el('div', { className: 'bc-fe-fields', 'data-fe-extras': '' },
    el('label', {}, el('span', {}, t('fam.ed.smaterial')), select({ 'data-fe-smaterial': '' }, matOpts, s.material || '', (v) => set({ material: v }))),
    el('label', {}, el('span', {}, t('fam.ed.sdetail')), detailSelect(c, { 'data-fe-sdetail': '' }, s.detail, (v) => set({ detail: v }))))];
  const a = s.array;
  const arr = el('div', { className: 'bc-fe-fields', 'data-fe-array': '' },
    el('label', { className: 'bc-fam-yn' }, (() => { const cb = el('input', { type: 'checkbox', 'data-fe-arrayon': '' }); cb.checked = !!a; cb.addEventListener('change', () => change(FE.setSolidArray(E.fam, s.id, cb.checked ? { count: '3', dx: s.op === 'box' ? '100' : '0', dy: '0', dz: '0' } : null))); return cb; })(), t('fam.ed.sarray')));
  if (a) {
    for (const [k, label] of [['count', t('fam.ed.sarray.count')], ['dx', t('fam.ed.sarray.dx')], ['dy', t('fam.ed.sarray.dy')], ['dz', t('fam.ed.sarray.dz')]]) {
      arr.append(el('label', {}, el('span', {}, label), input({ 'data-fe-arrayf': k }, a[k], (v, i) => { if (!change(FE.setSolidArray(E.fam, s.id, { ...a, [k]: v.trim() }))) i.value = a[k]; }, 8)));
    }
  }
  out.push(arr);
  return out;
}

export function symbolPanel(c) {
  const { E, t, el, input, select, btn, change, FE } = c;
  const sym = E.fam.symbol, parts = sym?.parts || [];
  const out = [el('p', { className: 'bc-muted' }, t('fam.ed.sym.note'))];
  if (sym) out.push(el('div', { className: 'bc-fe-fields' }, el('label', {}, el('span', {}, t('fam.ed.sym.mode')), select({ 'data-fe-symmode': '' }, [['symbol', t('fam.ed.sym.mode.symbol')], ['cut', t('fam.ed.sym.mode.cut')]], sym.mode, (v) => change(FE.setSymbolMode(E.fam, v))))));
  const list = el('ul', { className: 'bc-fe-solids', 'data-fe-symparts': '' }, ...parts.map((p) => {
    const b = el('button', { type: 'button', className: 'btn-line btn-sm-cc', 'data-fe-sympart': p.id, 'aria-pressed': p.id === E.symSel ? 'true' : 'false' }, p.id + ' — ' + t('fam.ed.sym.kind.' + p.kind) + (p.visible ? ' (' + t('fam.ed.ifshown', { when: p.visible }) + ')' : ''));   // i18n-ignore: a dash between id and kind
    b.addEventListener('click', () => { E.symSel = p.id; c.render(); });
    return el('li', {}, b);
  }));
  out.push(list);
  out.push(el('p', { className: 'bc-fe-row' }, el('span', {}, t('fam.ed.sym.add') + ' '), ...SYMBOL_KINDS.map((k) => btn({ 'data-fe-symadd': k }, t('fam.ed.sym.kind.' + k), () => { const r = FE.addSymbolPart(E.fam, k); if (r.ok) E.symSel = r.id; change(r); }, 'bi-plus-lg'))));
  const p = parts.find((x) => x.id === E.symSel) || null;
  if (!parts.length) out.push(el('p', { className: 'bc-muted', 'data-fe-symnone': '' }, t('fam.ed.sym.none')));
  if (!p) return out;
  const set = (patch) => change(FE.setSymbolPart(E.fam, p.id, patch));
  out.push(el('h3', {}, t('fam.ed.sym.part', { id: p.id })));
  const fieldBox = el('div', { className: 'bc-fe-fields', 'data-fe-symfields': '' });
  const f = (k, label = k) => el('label', {}, el('span', {}, label), input({ 'data-fe-symf': k }, p[k] ?? '', (v, i) => { if (!set({ [k]: v })) i.value = p[k] ?? ''; }, 9));
  for (const k of SYMBOL_FIELDS[p.kind] || []) fieldBox.append(f(k));
  if (p.kind === 'text') {
    fieldBox.append(el('label', {}, el('span', {}, t('fam.ed.sym.text')), input({ 'data-fe-symtext': '' }, p.text, (v, i) => { if (!set({ text: v })) i.value = p.text; }, 14)));
    fieldBox.append(f('rot', t('fam.ed.sym.rot')));
  }
  out.push(fieldBox);
  if (p.kind === 'poly') {
    const rows = p.pts.map((pt, i) => el('tr', {}, el('td', { className: 'bc-muted' }, String(i + 1)),
      ...[0, 1].map((j) => el('td', {}, input({ 'data-fe-sympt': i + ':' + j, 'aria-label': t('fam.ed.coord', { n: i + 1, axis: 'xy'[j] }) }, pt[j], (v) => { const all = JSON.parse(JSON.stringify(p.pts)); all[i][j] = v.trim(); set({ pts: all }); }, 8)))));
    out.push(el('table', { 'data-fe-sympts': '' }, el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'x'), el('th', {}, 'y'))), el('tbody', {}, ...rows)),   // i18n-ignore: a number column and axis names
      el('label', { className: 'bc-fam-yn' }, (() => { const cb = el('input', { type: 'checkbox', 'data-fe-symclosed': '' }); cb.checked = p.closed !== false; cb.addEventListener('change', () => set({ closed: cb.checked })); return cb; })(), t('fam.ed.sym.closed')));
  }
  const fillParams = E.fam.params.filter((q) => q.kind === 'fill').map((q) => [q.key, '⟨' + (q.label || q.key) + '⟩']);   // i18n-ignore: angle brackets mark a parameter in a list
  const style = el('div', { className: 'bc-fe-fields' });
  style.append(el('label', {}, el('span', {}, t('fam.ed.sym.pen')), input({ 'data-fe-sympen': '', placeholder: '3' }, p.pen ?? '', (v, i) => { if (!set({ pen: v })) i.value = p.pen ?? ''; }, 6)));
  if (p.kind !== 'line' && p.kind !== 'arc' && p.kind !== 'text') style.append(el('label', {}, el('span', {}, t('fam.ed.sym.fill')), select({ 'data-fe-symfill': '' }, [...FILLS.map((k) => [k, t('fam.fill.' + k)]), ...fillParams], p.fill || 'none', (v) => set({ fill: v }))));
  style.append(el('label', {}, el('span', {}, t('fam.ed.shown')), input({ 'data-fe-symvis': '', placeholder: t('fam.ed.always') }, p.visible ?? '', (v, i) => { if (!set({ visible: v })) i.value = p.visible ?? ''; }, 10)));
  style.append(el('label', {}, el('span', {}, t('fam.ed.sym.zmin')), input({ 'data-fe-symzmin': '', placeholder: t('fam.ed.sym.zany') }, p.zmin ?? '', (v, i) => { if (!set({ zmin: v })) i.value = p.zmin ?? ''; }, 8)));
  style.append(el('label', {}, el('span', {}, t('fam.ed.sym.zmax')), input({ 'data-fe-symzmax': '', placeholder: t('fam.ed.sym.zany') }, p.zmax ?? '', (v, i) => { if (!set({ zmax: v })) i.value = p.zmax ?? ''; }, 8)));
  style.append(el('label', {}, el('span', {}, t('fam.ed.sdetail')), detailSelect(c, { 'data-fe-symdetail': '' }, p.detail, (v) => set({ detail: v }))));
  out.push(style);
  const a = p.array;
  const arr = el('div', { className: 'bc-fe-fields', 'data-fe-symarray': '' }, el('label', { className: 'bc-fam-yn' }, (() => { const cb = el('input', { type: 'checkbox', 'data-fe-symarrayon': '' }); cb.checked = !!a; cb.addEventListener('change', () => change(FE.setSymbolArray(E.fam, p.id, cb.checked ? { count: '3', dx: '100', dy: '0' } : null))); return cb; })(), t('fam.ed.sarray')));
  if (a) for (const [k, label] of [['count', t('fam.ed.sarray.count')], ['dx', t('fam.ed.sarray.dx')], ['dy', t('fam.ed.sarray.dy')]]) arr.append(el('label', {}, el('span', {}, label), input({ 'data-fe-symarrayf': k }, a[k], (v, i) => { if (!change(FE.setSymbolArray(E.fam, p.id, { ...a, [k]: v.trim() }))) i.value = a[k]; }, 8)));
  out.push(arr);
  out.push(el('p', { className: 'bc-fe-row' },
    btn({ 'data-fe-symdup': '' }, t('fam.ed.sdup'), () => { const r = FE.duplicateSymbolPart(E.fam, p.id); if (r.ok) E.symSel = r.id; change(r); }, 'bi-copy'),
    btn({ 'data-fe-symrm': '' }, t('fam.ed.sremove'), () => { const r = FE.removeSymbolPart(E.fam, p.id); if (r.ok) E.symSel = r.fam.symbol?.parts[0]?.id || null; change(r); }, 'bi-trash')));
  return out;
}

export function partsPanel(c) {
  const { E, t, el, input, select, btn, change, FE } = c;
  const parts = E.fam.parts || [];
  const out = [el('p', { className: 'bc-muted' }, t('fam.ed.part.note'))];
  const others = c.families.filter(([k]) => k !== E.fam.key);
  const add = select({ 'data-fe-partfam': '', 'aria-label': t('fam.ed.part.family') }, others, others[0]?.[0], () => {});
  out.push(others.length ? el('p', { className: 'bc-fe-row' }, add, btn({ 'data-fe-partadd': '' }, t('fam.ed.part.add'), () => { const r = FE.addPart(E.fam, add.value); if (r.ok) E.partSel = r.id; change(r); }, 'bi-plus-lg')) : el('p', { className: 'bc-muted' }, t('fam.ed.part.nofam')));
  const nameOf = new Map(c.families);
  out.push(el('ul', { className: 'bc-fe-solids', 'data-fe-parts': '' }, ...parts.map((p) => {
    const b = el('button', { type: 'button', className: 'btn-line btn-sm-cc', 'data-fe-part': p.id, 'aria-pressed': p.id === E.partSel ? 'true' : 'false' }, p.id + ' — ' + (nameOf.get(p.family) || p.family));   // i18n-ignore: a dash between id and name
    b.addEventListener('click', () => { E.partSel = p.id; c.render(); });
    return el('li', {}, b);
  })));
  const p = parts.find((x) => x.id === E.partSel);
  if (!p) return out;
  const set = (patch) => change(FE.setPart(E.fam, p.id, patch));
  out.push(el('h3', {}, t('fam.ed.part.title', { name: nameOf.get(p.family) || p.family })));
  out.push(el('div', { className: 'bc-fe-fields', 'data-fe-partfields': '' },
    ...['x', 'y', 'z'].map((ax, i) => el('label', {}, el('span', {}, t('fam.ed.part.at') + ' ' + ax), input({ 'data-fe-partat': String(i) }, p.at[i], (v, inp) => { const at = p.at.slice(); at[i] = v.trim(); if (!set({ at })) inp.value = p.at[i]; }, 9))),
    el('label', {}, el('span', {}, t('fam.ed.part.rot')), input({ 'data-fe-partrot': '', placeholder: '0' }, p.rot ?? '', (v, inp) => { if (!set({ rot: v })) inp.value = p.rot ?? ''; }, 7)),
    el('label', {}, el('span', {}, t('fam.ed.shown')), input({ 'data-fe-partvis': '', placeholder: t('fam.ed.always') }, p.visible ?? '', (v, inp) => { if (!set({ visible: v })) inp.value = p.visible ?? ''; }, 9)),
    el('label', {}, el('span', {}, t('fam.ed.part.family')), select({ 'data-fe-partchange': '' }, c.families.filter(([k]) => k !== E.fam.key), p.family, (v) => set({ family: v })))));
  const lines = Object.entries(p.values || {}).map(([k, v]) => k + ' = ' + v).join('\n');
  const ta = el('textarea', { className: 'bc-input', rows: 4, 'data-fe-partvalues': '', 'aria-label': t('fam.ed.part.values'), value: lines });
  ta.value = lines;
  ta.addEventListener('change', () => {
    const values = {};
    for (const row of ta.value.split(/\n/)) { const m = row.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/); if (m) values[m[1]] = m[2]; }
    const drop = Object.fromEntries(Object.keys(p.values || {}).filter((k) => !(k in values)).map((k) => [k, '']));
    if (!set({ values: { ...drop, ...values } })) ta.value = lines;
  });
  out.push(el('label', { className: 'bc-dlg-field' }, el('span', {}, t('fam.ed.part.values')), ta));
  out.push(el('p', { className: 'bc-fe-row' }, btn({ 'data-fe-partrm': '' }, t('fam.ed.sremove'), () => { const r = FE.removePart(E.fam, p.id); if (r.ok) E.partSel = r.fam.parts?.[0]?.id || null; change(r); }, 'bi-trash')));
  return out;
}

export function hotspotsPanel(c) {
  const { E, t, el, input, select, btn, change, FE } = c;
  const hs = E.fam.hotspots || [];
  const out = [el('p', { className: 'bc-muted' }, t('fam.ed.hot.note'))];
  out.push(el('p', { className: 'bc-fe-row' }, el('span', {}, t('fam.ed.hot.add') + ' '), ...['point', 'edge'].map((k) => btn({ 'data-fe-hotadd': k }, t('fam.ed.hot.kind.' + k), () => { const r = FE.addHotspot(E.fam, { kind: k, axis: 'x' }); if (r.ok) E.hotSel = r.id; change(r); }, 'bi-plus-lg'))));
  if (!hs.length) out.push(el('p', { className: 'bc-muted', 'data-fe-hotnone': '' }, t('fam.ed.hot.none')));
  out.push(el('ul', { className: 'bc-fe-solids', 'data-fe-hots': '' }, ...hs.map((h) => {
    const b = el('button', { type: 'button', className: 'btn-line btn-sm-cc', 'data-fe-hot': h.id, 'aria-pressed': h.id === E.hotSel ? 'true' : 'false' }, (h.name || h.id) + ' — ' + t('fam.ed.hot.kind.' + h.kind) + ' → ' + h.drives);   // i18n-ignore: separators
    b.addEventListener('click', () => { E.hotSel = h.id; c.render(); });
    return el('li', {}, b);
  })));
  const h = hs.find((x) => x.id === E.hotSel);
  if (!h) return out;
  const set = (patch) => change(FE.setHotspot(E.fam, h.id, patch));
  const drives = E.fam.params.filter((p) => !p.formula && !isWordKind(p.kind) && p.kind !== 'yesno' && !p.instance).map((p) => [p.key, p.label || p.key]);
  out.push(el('h3', {}, t('fam.ed.hot.title', { name: h.name || h.id })));
  out.push(el('div', { className: 'bc-fe-fields', 'data-fe-hotfields': '' },
    el('label', {}, el('span', {}, t('fam.ed.hot.name')), input({ 'data-fe-hotname': '' }, h.name || '', (v) => set({ name: v }), 10)),
    el('label', {}, el('span', {}, t('fam.ed.hot.axis')), select({ 'data-fe-hotaxis': '' }, [['x', 'x'], ['y', 'y'], ['z', 'z']], h.axis, (v) => set({ axis: v }))),   // i18n-ignore: axis names
    el('label', {}, el('span', {}, t('fam.ed.hot.drives')), select({ 'data-fe-hotdrives': '' }, drives, h.drives, (v) => set({ drives: v }))),
    el('label', {}, el('span', {}, t('fam.ed.hot.kind')), select({ 'data-fe-hotkind': '' }, [['point', t('fam.ed.hot.kind.point')], ['edge', t('fam.ed.hot.kind.edge')]], h.kind, (v) => set({ kind: v }))),
    ...['x', 'y', 'z'].map((ax, i) => el('label', {}, el('span', {}, t('fam.ed.hot.at') + ' ' + ax), input({ 'data-fe-hotat': String(i) }, h.at[i], (v, inp) => { const at = h.at.slice(); at[i] = v.trim(); if (!set({ at })) inp.value = h.at[i]; }, 9))),
    ...(h.to ? ['x', 'y', 'z'].map((ax, i) => el('label', {}, el('span', {}, t('fam.ed.hot.to') + ' ' + ax), input({ 'data-fe-hotto': String(i) }, h.to[i], (v, inp) => { const to = h.to.slice(); to[i] = v.trim(); if (!set({ to })) inp.value = h.to[i]; }, 9))) : [])));
  out.push(el('p', { className: 'bc-fe-row' }, btn({ 'data-fe-hotrm': '' }, t('fam.ed.sremove'), () => { const r = FE.removeHotspot(E.fam, h.id); if (r.ok) E.hotSel = r.fam.hotspots?.[0]?.id || null; change(r); }, 'bi-trash')));
  return out;
}

export { DETAIL_LEVELS };
