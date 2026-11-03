/* SPDX-License-Identifier: Apache-2.0 */
/**
 * family-values-ui.js — one control for a family parameter's value, whatever its kind (0.7 BIM-FAM-MORE step 1, session bim-07): the editor's
 * parameter table, its "size shown" box and the place / new-size boxes of family-ui.js use it. DOM; the model side is family-model.js.
 *
 *   valueControl({ p, value, L, units, parseLen, t, materials, attrs, onChange }) → element
 *        length: a text box in the file's units · angle, number, integer, pen: a text box (a pen is 1–16) · yesno: a check box ·
 *        material: a list of the project's materials (and none) · fill: a list of the plan fills · text: a text box
 *        onChange(value, el) gets the value in the kind's own form (a number, or the word); a box that does not read puts the old text back and says so
 *   readControl(p, el, { parseLen, units }) → the value of such a control, or null when it does not read
 *   kindLabel(t, kind) → 'Length', 'Whole number', …
 */
import { el } from './ui-util.js';
import { FILL_KEYS, isWordKind } from './family-model.js';
import { formatNumber } from './expr.js';

export const kindLabel = (t, kind) => t('fam.ed.kind.' + kind);

export function valueControl({ p, value, L, units, parseLen, t, materials = [], attrs = {}, onChange }) {
  const k = p.kind;
  if (k === 'yesno') {
    const c = el('input', { type: 'checkbox', ...attrs });
    c.checked = !!value;
    c.addEventListener('change', () => onChange(c.checked ? 1 : 0, c));
    return c;
  }
  if (k === 'material') {
    const opts = [['', t('fam.val.nomaterial')], ...materials];
    if (value && !opts.some(([id]) => id === value)) opts.push([value, value]);   // an id the project library no longer holds stays visible
    const s = el('select', { className: 'select-cc', ...attrs }, ...opts.map(([id, name]) => el('option', { value: id, selected: id === (value || '') }, name)));
    s.addEventListener('change', () => onChange(s.value, s));
    return s;
  }
  if (k === 'fill') {
    const s = el('select', { className: 'select-cc', ...attrs }, ...FILL_KEYS.map((f) => el('option', { value: f, selected: f === (value || 'none') }, t('fam.fill.' + f))));
    s.addEventListener('change', () => onChange(s.value, s));
    return s;
  }
  const show = (v) => (!isWordKind(k) && !Number.isFinite(Number(v)) ? '' : k === 'length' ? L(v) : isWordKind(k) ? String(v ?? '') : formatNumber(Number(v)));   // a value that is not the same for every picked element shows empty
  const i = el('input', { type: 'text', className: 'bc-input', size: isWordKind(k) ? 14 : 8, ...attrs, value: show(value) });
  i.addEventListener('change', () => {
    const v = readControl(p, i, { parseLen, units });
    if (v === null) { i.value = show(value); onChange(null, i); return; }
    onChange(v, i);
  });
  return i;
}

export function readControl(p, node, { parseLen, units }) {
  if (p.kind === 'yesno') return node.checked ? 1 : 0;
  const s = String(node.value ?? '');
  if (isWordKind(p.kind)) return s;
  const n = p.kind === 'length' ? parseLen(s, units()) : Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
