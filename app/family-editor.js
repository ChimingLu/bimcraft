/* SPDX-License-Identifier: Apache-2.0 */
/**
 * family-editor.js — the family editor (0.6 DC.114, session bim-families_PART_2; spike docs/spikes/bim-families_PART_2.md F6a,
 * F6b). A dialog [data-fam-editor] opened from the family dialog (family-ui.js):
 *   Parameters [data-fe-tab="params"]: name, kind (length / angle / number / Yes / No), default value, formula (expr.js, PartCraft's
 *              language: a parameter with a formula is driven and shows its value); renaming one rewrites every expression.
 *   Solids     [data-fe-tab="solids"]: box, extrusion, revolve, sweep; each solid's numbers are typed numbers or expressions of the
 *              parameters; colour; "Shown when" (a visibility parameter: a Yes / No parameter or a comparison); its profile or
 *              path as a table and drawn on its work plane in the sketch [data-fe-sketch] (click to add a point, drag a point,
 *              click a segment's middle to add one there, Shift+click it to make it an arc, double-click a point to remove it).
 *   Booleans   [data-fe-tab="booleans"]: cut (difference) or join (union) two solids or Booleans.
 *   Connectors [data-fe-tab="connectors"] (families placed on a floor): where a pipe or duct joins the element — kind, system,
 *              x / y / z (numbers or expressions), the way out, size and flow; drawn on the preview as a ring and an arrow;
 *              and which plumbing fixture the family is [data-fe-fixture] (mep/fixtures.js), for its fixture units.
 *   Preview    the family written as IFC by the same code as the model (family-ifc.js) and drawn by cc-ifc [data-fe-view], with
 *              handles [data-fe-handles]: the size's (Width, Depth, Height) or the picked solid's faces; dragging a handle bound
 *              to a parameter changes the size previewed, a handle on a typed number changes the number.
 *   Undo / Redo inside the editor (Ctrl+Z / Ctrl+Y); Save [data-fe-save] = one undo step in the model (family-ops.js saveFamily).
 * Editing logic is family-edit.js (no DOM, Node-tested). window.bimcraftFamilyEditor = { state, api } while open (tests).
 */
import * as FE from './family-edit.js';
import { readFamily, evaluateFamily, inputParams, fullValues, arcPoints, STYLES, CONTEXT_NAMES, PARAM_KINDS, isWordKind, CONNECTOR_DOMAINS, CONNECTOR_DIRS } from './family-model.js';
import { valueControl, readControl } from './family-values-ui.js';
import { symbolPanel, partsPanel, hotspotsPanel, solidExtras } from './family-editor-more.js';
import { PIPE_SYSTEMS, DUCT_SYSTEMS, systemLabel } from './mep-model.js';
import { FIXTURE_KINDS } from './mep/fixtures.js';
import { literal, formatNumber } from './expr.js';
import { Viewer3D } from './viewer3d.js';
import { toViewer } from './ifc-place.js';
import { fmtLen, parseLen } from './model-units.js';
import { el } from './ui-util.js';

const STYLE = `
.bc-fam-ed { width: min(76rem, calc(100vw - 2rem)); max-width: none; max-height: calc(100vh - 2rem); overflow: auto; }
.bc-fam-ed .bc-fe-top { display: flex; flex-wrap: wrap; gap: .5rem; align-items: end; margin-bottom: .4rem; }
.bc-fam-ed .bc-fe-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: .9rem; }
@media (max-width: 760px) { .bc-fam-ed .bc-fe-grid { grid-template-columns: minmax(0, 1fr); } }
.bc-fam-ed .bc-fe-grid > div { min-width: 0; }
.bc-fam-ed .bc-fe-tabs { display: flex; gap: .25rem; margin-bottom: .4rem; }
.bc-fam-ed .bc-fe-tabs [aria-selected="true"] { border-color: var(--ink); font-weight: 600; }
.bc-fam-ed table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm, .875rem); }
.bc-fam-ed th, .bc-fam-ed td { text-align: left; padding: .15rem .25rem; border-bottom: var(--pen-1, 1px) solid var(--line); vertical-align: middle; }
.bc-fam-ed td input.bc-input { width: 100%; min-width: 3.5rem; }
.bc-fam-ed .bc-fe-solids { list-style: none; margin: 0 0 .4rem; padding: 0; display: grid; gap: .15rem; max-height: 11rem; overflow: auto; }
.bc-fam-ed .bc-fe-solids button { width: 100%; text-align: left; }
.bc-fam-ed .bc-fe-solids button[aria-pressed="true"] { border-color: var(--ink); font-weight: 600; }
.bc-fam-ed .bc-fe-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr)); gap: .25rem .6rem; margin: .3rem 0; }
.bc-fam-ed .bc-fe-fields label { display: grid; gap: .1rem; font-size: var(--fs-sm, .875rem); }
.bc-fam-ed .bc-fe-view { position: relative; height: 20rem; border: var(--pen-1, 1px) solid var(--line); background: var(--sheet); }
.bc-fam-ed .bc-fe-view canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.bc-fam-ed .bc-fe-view canvas[data-fe-handles] { pointer-events: none; }
.bc-fam-ed .bc-fe-sketch { position: relative; height: 15rem; border: var(--pen-1, 1px) solid var(--line); margin-top: .5rem; touch-action: none; }
.bc-fam-ed .bc-fe-sketch canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: crosshair; }
.bc-fam-ed .bc-fe-row { display: flex; flex-wrap: wrap; gap: .3rem; align-items: center; margin: .3rem 0; }
.bc-fam-ed .bc-fe-badd { align-items: end; margin-top: .6rem; }
.bc-fam-ed .bc-fe-baddgo { display: flex; align-items: end; }
.bc-fam-ed .bc-fe-driven { color: var(--ink-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.bc-fam-ed h3 { font-size: var(--fs-base, 1rem); margin: .6rem 0 .2rem; }
.bc-fam-ed [data-fe-panel] { max-width: 100%; overflow-x: auto; }   /* the table of parameters has a column more: it scrolls inside the panel on a phone, never the dialog */
.bc-fam-ed .bc-fe-tabs { flex-wrap: wrap; }
.bc-fam-ed textarea.bc-input { width: 100%; }
.bc-fam-ed > form > .bc-lib-actions { position: sticky; bottom: -1.1rem; z-index: 2; margin: .75rem -1.25rem -1.1rem; padding: .6rem 1.25rem; background: var(--sheet); border-top: var(--pen-1, 1px) solid var(--line); }
@media (max-width: 760px) { .bc-fam-ed input, .bc-fam-ed select, .bc-fam-ed textarea { font-size: 16px; } }
`;

const PLANE_AXES = { xy: ['x', 'y'], xz: ['x', 'z'], yz: ['y', 'z'] };

export function openFamilyEditor({ root, t, units, recipe, values, starter = false, scratch, onSave, onClose, materials = [], families = () => [], getFamily = () => null, detail = 'auto' }) {
  if (!document.getElementById('bc-fe-css')) { const st = document.createElement('style'); st.id = 'bc-fe-css'; st.textContent = STYLE; document.head.append(st); }
  const read = readFamily(recipe);
  const E = {
    fam: read.ok ? read.family : recipe, values: fullValues(read.ok ? read.family : recipe, values || {}), tab: 'params', sel: (recipe.solids?.[0]?.id) || null,
    handles: 'size', wall: 140, undo: [], redo: [], err: '', seq: 0, pv: null, C: null, sill: 0, drag: null, sk: null, dirty: false,
    symSel: recipe.symbol?.parts?.[0]?.id || null, partSel: recipe.parts?.[0]?.id || null, hotSel: recipe.hotspots?.[0]?.id || null, detail,
  };
  delete E.fam.starter;
  if (E.fam.kind === 'window') E.sill = 900;   // family-ifc.js previews a window at a 900 mm sill
  const L = (mm) => fmtLen(mm, units());
  const icon = (c) => el('i', { className: 'bi ' + c, 'aria-hidden': 'true' });
  const msg = (e) => {
    if (!e) return '';
    const fill = { ...(e.fill || {}) };
    if (typeof fill.why === 'string' && /^fam\.err\./.test(fill.why)) fill.why = t(fill.why, e.fill || {});
    return t(e.key, fill);
  };
  const btn = (attrs, label, onClick, ic, primary = false) => {
    const b = el('button', { type: 'button', className: (primary ? 'btn-plot' : 'btn-line') + ' btn-sm-cc', ...attrs }, ic ? icon(ic) : null, ic && label ? ' ' + label : label);
    b.addEventListener('click', onClick);
    return b;
  };
  const input = (attrs, value, onChange, size = 8) => {
    const i = el('input', { type: 'text', className: 'bc-input', size, ...attrs, value: String(value ?? '') });
    i.addEventListener('change', () => onChange(i.value, i));
    return i;
  };
  const select = (attrs, opts, value, onChange) => {
    const s = el('select', { className: 'select-cc', ...attrs }, ...opts.map(([v, label]) => el('option', { value: v, selected: v === value }, label)));
    s.addEventListener('change', () => onChange(s.value));
    return s;
  };

  // ---------------------------------------------------------------------------------------------- the dialog
  const errEl = el('p', { className: 'bc-input-err', role: 'alert', 'data-fe-err': '' });
  const nameIn = el('input', { type: 'text', className: 'bc-input', 'data-fe-name': '', maxLength: 80, value: E.fam.name });
  nameIn.addEventListener('change', () => { const n = nameIn.value.replace(/\s+/g, ' ').trim(); if (!n) { nameIn.value = E.fam.name; say(t('fam.err.name')); return; } change({ ok: true, fam: { ...JSON.parse(JSON.stringify(E.fam)), name: n.slice(0, 80) } }); });
  const undoB = btn({ 'data-fe-undo': '', title: t('fam.ed.undo') }, '', () => undo(), 'bi-arrow-counterclockwise');
  const redoB = btn({ 'data-fe-redo': '', title: t('fam.ed.redo') }, '', () => redo(), 'bi-arrow-clockwise');
  undoB.setAttribute('aria-label', t('fam.ed.undo')); redoB.setAttribute('aria-label', t('fam.ed.redo'));
  const tabKeys = ['params', 'solids', 'booleans', ...(E.fam.host === 'wall' ? [] : ['symbol', 'connectors']), 'parts', 'hotspots'];
  const tabs = el('div', { className: 'bc-fe-tabs', role: 'tablist' }, ...tabKeys.map((k) => {
    const b = el('button', { type: 'button', className: 'btn-line btn-sm-cc', role: 'tab', 'data-fe-tab': k, 'aria-selected': k === E.tab ? 'true' : 'false' }, t('fam.ed.tab.' + k));
    b.addEventListener('click', () => { E.tab = k; render(); drawHandles(); });
    return b;
  }));
  const panel = el('div', { 'data-fe-panel': '' });
  const view = el('div', { className: 'bc-fe-view', 'data-fe-view': '' });
  const c3 = el('canvas', { 'data-fe-3d': '' }), ch = el('canvas', { 'data-fe-handles': '' });
  view.append(c3, ch);
  const handleSel = select({ 'data-fe-handlemode': '', 'aria-label': t('fam.ed.handles') }, [['size', t('fam.ed.handles.size')], ['solid', t('fam.ed.handles.solid')], ['hotspots', t('fam.ed.handles.hotspots')], ['off', t('fam.ed.handles.off')]], E.handles, (v) => { E.handles = v; drawHandles(); });
  const pvBox = el('div', { 'data-fe-preview': '' });
  const sketchBox = el('div', { 'data-fe-sketchbox': '', hidden: true });
  const sketch = el('div', { className: 'bc-fe-sketch', 'data-fe-sketch': '' });
  const cs = el('canvas', { 'data-fe-sketchc': '' });
  sketch.append(cs);
  sketchBox.append(el('h3', {}, t('fam.ed.sketch')), el('p', { className: 'bc-muted', 'data-fe-sketchhint': '' }, t('fam.ed.sketch.hint')), sketch);
  const saveB = btn({ 'data-fe-save': '' }, t('fam.ed.save'), () => save(), null, true);
  const cancelB = btn({ 'data-fe-cancel': '' }, t('model.gp.cancel'), () => dlg.close());
  const dlg = el('dialog', { className: 'bc-dialog bc-fam-ed', 'data-fam-editor': E.fam.key, 'aria-labelledby': 'bc-fe-h' },
    el('form', { method: 'dialog' },
      el('h2', { className: 'bc-h', id: 'bc-fe-h' }, t('fam.ed.title', { name: E.fam.name })),
      starter ? el('p', { className: 'bc-muted', 'data-fe-starter': '' }, t('fam.ed.starter')) : null,
      el('div', { className: 'bc-fe-top' }, el('label', { className: 'bc-dlg-field' }, el('span', {}, t('fam.name')), nameIn), undoB, redoB,
        el('span', { className: 'bc-muted' }, t('fam.kind.' + E.fam.kind) + (E.fam.host === 'wall' ? ' · ' + t('fam.ed.hosted') : ''))),   // i18n-ignore: a separator
      el('div', { className: 'bc-fe-grid' },
        el('div', {}, tabs, panel),
        el('div', {}, view, el('div', { className: 'bc-fe-row' }, el('label', {}, el('span', {}, t('fam.ed.handles') + ' '), handleSel), el('span', { className: 'bc-muted', 'data-fe-pvstate': '' })), pvBox, sketchBox)),
      errEl, el('p', { className: 'bc-lib-actions' }, saveB, cancelB)));
  root.append(dlg);
  dlg.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
      e.stopPropagation();   // never the model's own undo while the editor is open
      if (e.target.closest('input, textarea, select')) return;
      e.preventDefault();
      if (k === 'z' && !e.shiftKey) undo(); else redo();
    }
    if ((k === 'delete' || k === 'backspace') && E.sk?.pick >= 0 && !e.target.closest('input, textarea, select')) { e.preventDefault(); e.stopPropagation(); removePt(E.sk.pick); }
  });
  dlg.addEventListener('close', () => {
    try { v?.resizeObserver?.disconnect(); v?.renderer?.dispose(); v?.renderer?.forceContextLoss?.(); } catch (e) { /* gone */ }
    dlg.remove();
    if (typeof window !== 'undefined' && window.bimcraftFamilyEditor?.state === E) window.bimcraftFamilyEditor = null;
    onClose?.();
  });
  dlg.showModal();
  const say = (text) => { E.err = text || ''; errEl.textContent = E.err; if (E.err) errEl.scrollIntoView?.({ block: 'nearest' }); };   // the message is always where you can read it

  // ---------------------------------------------------------------------------------------------- changes and undo
  /** Take an editing result: the new recipe (one editor undo step), or its refusal shown and nothing changed. */
  function change(r, { values = null, keepPanel = false } = {}) {
    if (!r.ok) { say(msg(r.error)); if (!keepPanel) render(); return false; }
    E.undo.push({ fam: E.fam, values: E.values });
    if (E.undo.length > 200) E.undo.shift();
    E.redo = [];
    E.fam = r.fam;
    if (values) E.values = values;
    E.values = fullValues(E.fam, E.values);
    E.dirty = true;
    say('');
    if (!keepPanel) render();
    schedule();
    return true;
  }
  function undo() { const s = E.undo.pop(); if (!s) return; E.redo.push({ fam: E.fam, values: E.values }); E.fam = s.fam; E.values = s.values; if (!E.fam.solids.some((x) => x.id === E.sel)) E.sel = E.fam.solids[0]?.id || null; say(''); render(); schedule(); }
  function redo() { const s = E.redo.pop(); if (!s) return; E.undo.push({ fam: E.fam, values: E.values }); E.fam = s.fam; E.values = s.values; say(''); render(); schedule(); }
  function save() {
    const r = readFamily(E.fam);
    if (!r.ok) { say(msg(r.errors[0])); return; }
    const why = onSave(E.fam);
    if (why) { say(why); return; }
    E.dirty = false;
    dlg.close();
  }

  // ---------------------------------------------------------------------------------------------- the left panel
  /** Re-render, keeping focus on the same control (found again by its data-fe-* attributes). */
  let rendering = false, renderAgain = false;
  function render() {
    // moving the focus inside a render fires the blur / change of another box, which asks for a render: it waits for this one
    if (rendering) { renderAgain = true; return; }
    rendering = true;
    try { renderNow(); } finally { rendering = false; }
    if (renderAgain) { renderAgain = false; render(); }
  }
  function renderNow() {
    const a = document.activeElement, key = a && dlg.contains(a) ? [...a.attributes].filter((x) => x.name.startsWith('data-fe-')).map((x) => `[${x.name}="${CSS.escape(x.value)}"]`).join('') : '';
    nameIn.value = E.fam.name;
    undoB.disabled = !E.undo.length; redoB.disabled = !E.redo.length;
    for (const b of tabs.children) b.setAttribute('aria-selected', b.dataset.feTab === E.tab ? 'true' : 'false');
    panel.replaceChildren(...(E.tab === 'params' ? paramsPanel() : E.tab === 'solids' ? solidsPanel() : E.tab === 'symbol' ? symbolPanel(more()) : E.tab === 'parts' ? partsPanel(more()) : E.tab === 'hotspots' ? hotspotsPanel(more()) : E.tab === 'connectors' ? connPanel() : boolPanel()));
    pvBox.replaceChildren(...previewInputs());
    drawSketchBox();
    if (key) { const n = dlg.querySelector(key); if (n && n !== a) n.focus(); }
  }
  /** What the newer panels (family-editor-more.js) take from this editor. */
  const more = () => ({ E, t, FE, el, input, select, btn, change, L, units, render, families: families(), materials });
  /** What evaluating needs: the wall, the project's detail level and the other families this one may hold. */
  const evalCtx2 = () => ({ wallThickness: E.wall, detail: E.detail, resolve: (k) => getFamily(k) });
  const ev = () => evaluateFamily(E.fam, E.values, evalCtx2());

  function paramsPanel() {
    const r = ev(), driven = r.ok ? r.values : {};
    const kinds = PARAM_KINDS.map((k) => [k, t('fam.ed.kind.' + k)]);
    const rows = E.fam.params.map((p, i) => {
      const valIn = valueControl({ p, value: p.value, L, units, parseLen, t, materials, attrs: { 'data-fe-pval': p.key, 'aria-label': t('fam.ed.default') }, onChange: (v) => {
        if (v === null) { say(t('model.err.length')); return; }
        change(FE.setParam(E.fam, p.key, { value: v }));
      } });
      if (p.formula) valIn.disabled = true;
      const shown = p.formula && Number.isFinite(driven[p.key]) ? (p.kind === 'length' ? L(driven[p.key]) : p.kind === 'yesno' ? t(driven[p.key] ? 'fam.yes' : 'fam.no') : formatNumber(driven[p.key])) : '';
      return el('tr', { 'data-fe-param': p.key },
        el('td', {}, input({ 'data-fe-pkey': String(i), 'aria-label': t('fam.ed.pname') }, p.key, (v, i2) => { const ok = change(FE.renameParam(E.fam, p.key, v.trim())); if (!ok) i2.value = p.key; }, 9)),
        el('td', {}, select({ 'data-fe-pkind': p.key, 'aria-label': t('fam.ed.pkind') }, kinds, p.kind, (v) => change(FE.setParam(E.fam, p.key, { kind: v })))),
        el('td', {}, valIn),
        el('td', {}, isWordKind(p.kind) ? el('span', { className: 'bc-muted' }, '') : input({ 'data-fe-pformula': p.key, 'aria-label': t('fam.ed.formula'), placeholder: t('fam.ed.formula.none') }, p.formula || '', (v) => change(FE.setParam(E.fam, p.key, { formula: v })), 12), shown ? el('span', { className: 'bc-fe-driven', 'data-fe-pdriven': p.key }, ' = ' + shown) : null),   // i18n-ignore: an equals sign
        el('td', {}, (() => { const cb = el('input', { type: 'checkbox', 'data-fe-pinst': p.key, title: t('fam.ed.instance.title'), 'aria-label': t('fam.ed.instance') }); cb.checked = !!p.instance; cb.disabled = !!p.formula; cb.addEventListener('change', () => change(FE.setParam(E.fam, p.key, { instance: cb.checked }))); return cb; })()),
        el('td', {}, btn({ 'data-fe-prm': p.key, title: t('fam.ed.premove'), 'aria-label': t('fam.ed.premove') }, '', () => change(FE.removeParam(E.fam, p.key)), 'bi-x-lg')));
    });
    const newKind = select({ 'data-fe-paddkind': '', 'aria-label': t('fam.ed.pkind') }, kinds, 'length', () => {});
    return [
      el('table', { 'data-fe-params': '' }, el('thead', {}, el('tr', {}, el('th', {}, t('fam.ed.pname')), el('th', {}, t('fam.ed.pkind')), el('th', {}, t('fam.ed.default')), el('th', {}, t('fam.ed.formula')), el('th', {}, t('fam.ed.instance')), el('th', {}, ''))), el('tbody', {}, ...rows)),
      el('p', { className: 'bc-fe-row' }, newKind, btn({ 'data-fe-padd': '' }, t('fam.ed.padd'), () => {
        const k = newKind.value, key = FE.freeParamKey(E.fam, k === 'yesno' ? 'Show' : k === 'text' ? 'Text' : k === 'material' ? 'Material' : k === 'fill' ? 'Fill' : k === 'integer' ? 'Count' : k === 'pen' ? 'Pen' : 'P');
        change(FE.addParam(E.fam, { key, kind: k, value: k === 'length' ? 100 : k === 'yesno' ? 1 : k === 'pen' ? 3 : k === 'integer' ? 2 : isWordKind(k) ? (k === 'fill' ? 'none' : '') : 0 }));
      }, 'bi-plus-lg')),
      el('p', { className: 'bc-muted' }, t(E.fam.host === 'wall' ? 'fam.ed.pnote.hosted' : 'fam.ed.pnote', { names: CONTEXT_NAMES.join(', ') })),
    ];
  }

  function solidsPanel() {
    const list = el('ul', { className: 'bc-fe-solids', 'data-fe-solids': '' }, ...E.fam.solids.map((s) => {
      const b = el('button', { type: 'button', className: 'btn-line btn-sm-cc', 'data-fe-solid': s.id, 'aria-pressed': s.id === E.sel ? 'true' : 'false' },
        (s.name || s.id) + ' — ' + t('fam.ed.op.' + s.op) + (s.visible ? ' (' + t('fam.ed.ifshown', { when: s.visible }) + ')' : ''));   // i18n-ignore: a dash between name and kind
      b.addEventListener('click', () => { E.sel = s.id; E.handles = E.handles === 'size' ? 'solid' : E.handles; handleSel.value = E.handles; render(); drawHandles(); });
      return el('li', {}, b);
    }));
    const add = el('p', { className: 'bc-fe-row' }, el('span', {}, t('fam.ed.sadd') + ' '), ...['box', 'extrude', 'revolve', 'sweep'].map((op) => btn({ 'data-fe-sadd': op }, t('fam.ed.op.' + op), () => {
      const r = FE.addSolid(E.fam, op);
      if (r.ok) E.sel = r.id;
      change(r);
    }, 'bi-plus-lg')));
    const out = [list, add];
    const s = E.fam.solids.find((x) => x.id === E.sel);
    if (s) out.push(...solidForm(s));
    return out;
  }
  function solidForm(s) {
    const set = (patch) => change(FE.setSolid(E.fam, s.id, patch));
    const yesno = E.fam.params.filter((p) => p.kind === 'yesno').map((p) => p.key);
    const visIn = input({ 'data-fe-svis': '', list: 'bc-fe-yn', placeholder: t('fam.ed.always') }, s.visible || '', (v) => set({ visible: v }), 10);
    const out = [el('h3', {}, t('fam.ed.solid', { name: s.name || s.id })),
      el('datalist', { id: 'bc-fe-yn' }, ...yesno.map((k) => el('option', { value: k }))),
      el('div', { className: 'bc-fe-fields' },
        el('label', {}, el('span', {}, t('fam.name')), input({ 'data-fe-sname': '' }, s.name || '', (v) => set({ name: v }), 10)),
        el('label', {}, el('span', {}, t('fam.ed.colour')), select({ 'data-fe-sstyle': '' }, Object.keys(STYLES).map((k) => [k, t(STYLES[k].name)]), s.style, (v) => set({ style: v }))),
        el('label', {}, el('span', {}, t('fam.ed.shown')), visIn))];
    out.push(...solidExtras(more(), s));
    const field = (k, label = k) => el('label', {}, el('span', {}, label), input({ 'data-fe-f': k }, s[k], (v, i) => { if (!set({ [k]: v })) i.value = s[k]; }, 9));
    const f = el('div', { className: 'bc-fe-fields', 'data-fe-fields': '' });
    if (s.op === 'box') for (const k of ['x0', 'x1', 'y0', 'y1', 'z0', 'z1']) f.append(field(k));
    else if (s.op === 'extrude' || s.op === 'revolve') {
      f.append(el('label', {}, el('span', {}, t('fam.ed.plane')), select({ 'data-fe-splane': '' }, [['xy', t('fam.ed.plane.xy')], ['xz', t('fam.ed.plane.xz')], ['yz', t('fam.ed.plane.yz')]], s.plane, (v) => set({ plane: v }))));
      f.append(field('at', t('fam.ed.at')));
      if (s.op === 'extrude') f.append(field('depth', t('fam.ed.depth')));
      else {
        f.append(field('angle', t('fam.ed.angle')));
        s.axis.forEach((a, i) => f.append(el('label', {}, el('span', {}, t('fam.ed.axis', { n: i + 1 })), input({ 'data-fe-axis': String(i) }, a, (v) => { const ax = s.axis.slice(); ax[i] = v.trim(); set({ axis: ax }); }, 7))));
      }
    } else f.append(field('radius', t('fam.ed.radius')));
    out.push(f);
    // the points: a profile (u, v, the segment after each point straight or an arc) or a path (x, y, z)
    const sweep = s.op === 'sweep', pts = s.op === 'box' ? [] : FE.pointsOf(s), ax = sweep ? ['x', 'y', 'z'] : PLANE_AXES[s.plane] || [];
    const arcOpts = [['0', t('fam.ed.arc.none')], [String(FE.cycleArc(0)), t('fam.ed.arc.left')], [String(FE.cycleArc(FE.cycleArc(0))), t('fam.ed.arc.right')]];
    const rows = pts.map((p, i) => el('tr', { 'data-fe-pt': String(i) }, el('td', { className: 'bc-muted' }, String(i + 1)),
      ...ax.map((nm, j) => el('td', {}, input({ 'data-fe-ptv': i + ':' + j, 'aria-label': t('fam.ed.coord', { n: i + 1, axis: nm }) }, p[j], (v) => {
        const all = JSON.parse(JSON.stringify(pts)); all[i][j] = v.trim(); set({ [sweep ? 'path' : 'profile']: all });
      }, 7))),
      sweep ? null : el('td', {}, (() => { const b = String(p[2] || 0), opts = arcOpts.some(([x]) => x === b) ? arcOpts : [...arcOpts, [b, t('fam.ed.arc.other')]]; return select({ 'data-fe-ptarc': String(i), 'aria-label': t('fam.ed.arc') }, opts, b, (v) => change(FE.setBulge(E.fam, s.id, i, Number(v)))); })()),
      el('td', {}, btn({ 'data-fe-ptrm': String(i), title: t('fam.ed.ptremove'), 'aria-label': t('fam.ed.ptremove') }, '', () => removePt(i), 'bi-x-lg'))));
    if (s.op !== 'box') out.push(el('table', { 'data-fe-points': '' }, el('thead', {}, el('tr', {}, el('th', {}, '#'), ...ax.map((nm) => el('th', {}, nm)), sweep ? null : el('th', {}, t('fam.ed.arc')), el('th', {}, ''))), el('tbody', {}, ...rows)));   // i18n-ignore: a number column
    out.push(el('p', { className: 'bc-fe-row' },
      btn({ 'data-fe-sdup': '' }, t('fam.ed.sdup'), () => { const r = FE.duplicateSolid(E.fam, s.id); if (r.ok) E.sel = r.id; change(r); }, 'bi-copy'),
      btn({ 'data-fe-srm': '' }, t('fam.ed.sremove'), () => { const r = FE.removeSolid(E.fam, s.id); if (r.ok) E.sel = r.fam.solids[0]?.id || null; change(r); }, 'bi-trash')));
    return out;
  }
  function removePt(i) { const s = E.fam.solids.find((x) => x.id === E.sel); if (!s) return; const r = FE.removePoint(E.fam, s.id, i); if (r.ok && E.sk) E.sk.pick = -1; change(r); }

  function boolPanel() {
    const ids = [...E.fam.solids.map((s) => [s.id, s.name ? s.name + ' (' + s.id + ')' : s.id]), ...(E.fam.booleans || []).map((b) => [b.id, b.id])];
    const label = new Map(ids);
    const rows = (E.fam.booleans || []).map((b) => {
      const free = new Set(FE.operands(E.fam, b.id));
      const opts = (cur) => ids.filter(([id]) => id === cur || (free.has(id) && id !== b.id)).map(([id]) => [id, label.get(id)]);
      return el('tr', { 'data-fe-bool': b.id }, el('td', {}, b.id),
        el('td', {}, select({ 'data-fe-bop': b.id, 'aria-label': t('fam.ed.bop') }, [['difference', t('fam.ed.bop.difference')], ['union', t('fam.ed.bop.union')]], b.op, (v) => change(FE.setBoolean(E.fam, b.id, { op: v })))),
        el('td', {}, select({ 'data-fe-ba': b.id, 'aria-label': t('fam.ed.ba') }, opts(b.a), b.a, (v) => change(FE.setBoolean(E.fam, b.id, { a: v })))),
        el('td', {}, select({ 'data-fe-bb': b.id, 'aria-label': t('fam.ed.bb') }, opts(b.b), b.b, (v) => change(FE.setBoolean(E.fam, b.id, { b: v })))),
        el('td', {}, btn({ 'data-fe-brm': b.id, title: t('fam.ed.bremove'), 'aria-label': t('fam.ed.bremove') }, '', () => change(FE.removeBoolean(E.fam, b.id)), 'bi-x-lg')));
    });
    const free = FE.operands(E.fam);
    const a = select({ 'data-fe-badda': '', 'aria-label': t('fam.ed.ba') }, free.map((id) => [id, label.get(id)]), free[0], () => {});
    const b = select({ 'data-fe-baddb': '', 'aria-label': t('fam.ed.bb') }, free.map((id) => [id, label.get(id)]), free[1], () => {});
    const op = select({ 'data-fe-baddop': '', 'aria-label': t('fam.ed.bop') }, [['difference', t('fam.ed.bop.difference')], ['union', t('fam.ed.bop.union')]], 'difference', () => {});
    return [
      el('p', { className: 'bc-muted' }, t('fam.ed.bnote')),
      rows.length ? el('table', { 'data-fe-bools': '' }, el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, t('fam.ed.bop')), el('th', {}, t('fam.ed.ba')), el('th', {}, t('fam.ed.bb')), el('th', {}, ''))), el('tbody', {}, ...rows)) : el('p', { className: 'bc-muted' }, t('fam.ed.bnone')),
      // the new Boolean: labelled fields in the solids' grid (full-width selects would stack one under another)
      free.length >= 2 ? el('div', { className: 'bc-fe-fields bc-fe-badd' },
        el('label', {}, el('span', {}, t('fam.ed.ba')), a), el('label', {}, el('span', {}, t('fam.ed.bop')), op), el('label', {}, el('span', {}, t('fam.ed.bb')), b),
        el('span', { className: 'bc-fe-baddgo' }, btn({ 'data-fe-badd': '' }, t('fam.ed.badd'), () => change(FE.addBoolean(E.fam, { op: op.value, a: a.value, b: b.value })), 'bi-plus-lg'))) : null,
    ];
  }

  // ---------------------------------------------------------------------------------------------- connectors
  const DIR_KEYS = { '+x': 'px', '-x': 'nx', '+y': 'py', '-y': 'ny', '+z': 'pz', '-z': 'nz' };
  const sysOpts = (domain) => Object.keys(domain === 'duct' ? DUCT_SYSTEMS : PIPE_SYSTEMS).map((k) => [k, systemLabel(domain, k)]);
  function connPanel() {
    const list = (E.fam.connectors || []).map((c) => {
      const set = (patch) => change(FE.setConnector(E.fam, c.id, patch));
      const field = (k, label) => el('label', {}, el('span', {}, label), input({ 'data-fe-cf': c.id + ':' + k }, c[k], (v, i) => { if (!set({ [k]: v })) i.value = c[k]; }, 7));
      return el('div', { 'data-fe-conn': c.id },
        el('h3', {}, t('fam.ed.conn', { name: c.name || c.id })),
        el('div', { className: 'bc-fe-fields' },
          el('label', {}, el('span', {}, t('fam.name')), input({ 'data-fe-cname': c.id }, c.name || '', (v) => set({ name: v }), 10)),
          el('label', {}, el('span', {}, t('fam.ed.cdomain')), select({ 'data-fe-cdomain': c.id }, CONNECTOR_DOMAINS.map((d) => [d, t('mep.part.' + d)]), c.domain,
            (v) => set({ domain: v, system: Object.keys(v === 'duct' ? DUCT_SYSTEMS : PIPE_SYSTEMS)[0] }))),
          el('label', {}, el('span', {}, t('fam.ed.csystem')), select({ 'data-fe-csystem': c.id }, sysOpts(c.domain), c.system, (v) => set({ system: v }))),
          field('x', 'x'), field('y', 'y'), field('z', 'z'),   // i18n-ignore: axis names
          el('label', {}, el('span', {}, t('fam.ed.cdir')), select({ 'data-fe-cdir': c.id }, Object.keys(CONNECTOR_DIRS).map((d) => [d, t('fam.ed.cdir.' + DIR_KEYS[d])]), c.dir, (v) => set({ dir: v }))),
          field('size', t('fam.ed.csize')),
          el('label', {}, el('span', {}, t('fam.ed.cflow')), select({ 'data-fe-cflow': c.id }, [['in', t('fam.ed.cflow.in')], ['out', t('fam.ed.cflow.out')]], c.flow, (v) => set({ flow: v })))),
        el('p', { className: 'bc-fe-row' }, btn({ 'data-fe-crm': c.id }, t('fam.ed.cremove'), () => change(FE.removeConnector(E.fam, c.id)), 'bi-trash')));
    });
    const kind = select({ 'data-fe-caddkind': '', 'aria-label': t('fam.ed.cdomain') }, CONNECTOR_DOMAINS.map((d) => [d, t('mep.part.' + d)]), 'pipe', () => {});
    const fixture = select({ 'data-fe-fixture': '' }, [['', t('fam.fixture.none')], ...FIXTURE_KINDS.map((k) => [k, t('fam.fixture.' + k)])], E.fam.fixture || '', (v) => change(FE.setFixture(E.fam, v)));
    return [
      el('p', { className: 'bc-muted' }, t('fam.ed.cnote')),
      el('div', { className: 'bc-fe-fields' }, el('label', {}, el('span', {}, t('fam.ed.fixture')), fixture)),
      el('p', { className: 'bc-muted' }, t('fam.ed.fixture.note')),
      ...(list.length ? list : [el('p', { className: 'bc-muted' }, t('fam.ed.cnone'))]),
      el('div', { className: 'bc-fe-fields bc-fe-badd' }, el('label', {}, el('span', {}, t('fam.ed.cdomain')), kind),
        el('span', { className: 'bc-fe-baddgo' }, btn({ 'data-fe-cadd': '' }, t('fam.ed.cadd'), () => change(FE.addConnector(E.fam, { domain: kind.value })), 'bi-plus-lg'))),
    ];
  }

  // ---------------------------------------------------------------------------------------------- the size previewed
  function previewInputs() {
    const box = el('div', { className: 'bc-fe-fields' });
    for (const p of inputParams(E.fam)) {
      const v = E.values[p.key];
      const ctl = valueControl({ p, value: v, L, units, parseLen, t, materials, attrs: { 'data-fe-pv': p.key }, onChange: (n) => {
        if (n === null) { say(t('model.err.length')); return; }
        E.values = { ...E.values, [p.key]: n }; say(''); schedule(); render();
      } });
      box.append(el('label', {}, el('span', {}, (p.label || p.key) + (p.kind === 'angle' ? ' (°)' : '') + (p.instance ? ' ·' : '')), ctl));   // i18n-ignore: a degree sign; a dot marks a per-element parameter
    }
    if (E.fam.host === 'wall') box.append(el('label', {}, el('span', {}, t('fam.ed.wall')), input({ 'data-fe-pvwall': '' }, L(E.wall), (s, i) => {
      const n = parseLen(s, units());
      if (!(n >= 50 && n <= 1000)) { i.value = L(E.wall); say(t('model.err.length')); return; }
      E.wall = n; schedule(); render();
    }, 7)));
    return [el('h3', {}, t('fam.ed.previewsize')), box];
  }

  /** The families this one holds (and those they hold), as recipes: the preview's scratch file needs them. */
  function depsOf(fam) {
    const out = [], seen = new Set([fam.key]);
    const walk = (f) => { for (const p of f.parts || []) { if (seen.has(p.family)) continue; seen.add(p.family); const c = getFamily(p.family); if (c) { walk(c); out.push(c); } } };
    walk(fam);
    return out;
  }
  // ---------------------------------------------------------------------------------------------- the preview (cc-ifc)
  let v = null;
  try { v = new Viewer3D(c3, {}); v.onRender = () => drawHandles(); } catch (e) { console.error(e); view.replaceChildren(el('p', { className: 'bc-muted' }, t('fam.ed.nopreview'))); }
  let timer = 0;
  function schedule(ms = 250) { clearTimeout(timer); timer = setTimeout(() => { preview().catch((e) => { console.error(e); say(String(e.message || e)); }); }, ms); }
  const stateEl = () => dlg.querySelector('[data-fe-pvstate]');
  async function preview() {
    if (!v) return;
    const seq = ++E.seq;
    const r0 = readFamily(E.fam);
    if (!r0.ok) { say(msg(r0.errors[0])); return; }
    const e0 = ev();
    if (!e0.ok) { say(msg(e0.error)); return; }
    if (stateEl()) stateEl().textContent = t('fam.ed.drawing');
    const s = await scratch();
    const r = await s.preview(E.fam, E.values, { wallThickness: E.wall, deps: depsOf(E.fam), detail: E.detail });
    if (seq !== E.seq) return;
    if (r.error) { say(msg(r.error)); if (stateEl()) stateEl().textContent = ''; return; }
    const first = !E.pv;
    E.pv = r;
    E.C = [...r.api.GetCoordinationMatrix(r.model.modelID)];
    v.setModel(r.model, { keepCamera: !first });
    if (first) {
      v.view('iso');
      // room round the model for the handles at its faces and their labels: the camera a third farther back
      v.camera.position.sub(v.controls.target).multiplyScalar(1.35).add(v.controls.target);
      v.camera.far = Math.max(v.camera.far, v.camera.position.distanceTo(v.controls.target) * 20);
      v.camera.updateProjectionMatrix(); v.controls.update(); v.render();
    }
    if (stateEl()) stateEl().textContent = t('fam.ed.drawn', { kb: Math.max(1, Math.round(r.bytes.length / 1024)) });
    if (E.err && !E.drag) say('');
    drawHandles();
    window.dispatchEvent(new CustomEvent('bimcraft-family-preview', { detail: { seq } }));   // for tests
  }

  // ---------------------------------------------------------------------------------------------- handles in the 3D view
  const ctxOf = () => evalCtx2();
  function handleList() {
    if (!E.C || E.handles === 'off') return [];
    if (E.handles === 'hotspots') return FE.hotspotHandles(E.fam, E.values, ctxOf());
    return E.handles === 'size' ? FE.sizeHandles(E.fam, E.values, ctxOf()) : E.sel ? FE.solidHandles(E.fam, E.values, E.sel, ctxOf()) : [];
  }
  /** A family point (mm, z up) → the preview's viewer space (the family stands at the origin; a window at its sill). */
  const toV = (p) => toViewer(E.C, [p[0], p[1], p[2] + E.sill]);
  function drawHandles() {
    if (!v) return;
    const r = view.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (ch.width !== Math.round(r.width * dpr) || ch.height !== Math.round(r.height * dpr)) { ch.width = Math.round(r.width * dpr); ch.height = Math.round(r.height * dpr); }
    const g = ch.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    const cs2 = getComputedStyle(document.documentElement), action = cs2.getPropertyValue('--action').trim() || '#1d4ed8', ink = cs2.getPropertyValue('--ink').trim() || '#111', sheet = cs2.getPropertyValue('--sheet').trim() || '#fff';
    E.hs = [];
    for (const h of (E.drag ? E.drag.list : handleList())) {
      const s = v.project(toV(h.p));
      if (!s) continue;
      const x = s.x - r.left, y = s.y - r.top;
      E.hs.push({ h, x, y });
      g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fillStyle = action; g.fill(); g.lineWidth = 1.5; g.strokeStyle = sheet; g.stroke();
      g.font = '12px system-ui, sans-serif'; g.fillStyle = ink; g.fillText(h.label, x + 9, y - 7);
    }
    // the connectors: a ring at each, an arrow the way out (on the Connectors tab)
    if (E.tab !== 'connectors') return;
    const e0 = ev();
    for (const c of e0.ok ? e0.connectors : []) {
      const a = v.project(toV(c.p)), b = v.project(toV(c.p.map((q, i) => q + c.dir[i] * Math.max(120, c.size * 2))));
      if (!a || !b) continue;
      const ax = a.x - r.left, ay = a.y - r.top, bx = b.x - r.left, by = b.y - r.top;
      g.strokeStyle = action; g.lineWidth = 2;
      g.beginPath(); g.arc(ax, ay, 7, 0, Math.PI * 2); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      const ang = Math.atan2(by - ay, bx - ax);
      g.beginPath(); g.moveTo(bx, by); g.lineTo(bx - 8 * Math.cos(ang - 0.4), by - 8 * Math.sin(ang - 0.4)); g.moveTo(bx, by); g.lineTo(bx - 8 * Math.cos(ang + 0.4), by - 8 * Math.sin(ang + 0.4)); g.stroke();
      g.font = '12px system-ui, sans-serif'; g.fillStyle = ink; g.fillText(c.name || c.id, ax + 10, ay + 14);
    }
  }
  // a press on a handle drags it (OrbitControls never sees it); anything else orbits the preview as usual
  view.addEventListener('pointerdown', (e) => {
    if (!E.hs?.length || e.button !== 0) return;
    const r = view.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const hit = E.hs.find((q) => Math.hypot(q.x - x, q.y - y) <= 9);
    if (!hit) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const h = hit.h, a = h.axis.findIndex((q) => q !== 0), sgn = h.axis[a];
    const p1 = h.p.slice(); p1[a] += 100 * sgn;
    const s0 = v.project(toV(h.p)), s1 = v.project(toV(p1));
    if (!s0 || !s1) return;
    const d = [s1.x - s0.x, s1.y - s0.y], L2 = d[0] * d[0] + d[1] * d[1];
    if (L2 < 1) return;
    E.drag = { h, a, sgn, start: [e.clientX, e.clientY], d, L2, from: { fam: E.fam, values: E.values }, list: handleList() };
    view.setPointerCapture?.(e.pointerId);
  }, true);
  view.addEventListener('pointermove', (e) => {
    const D = E.drag;
    if (!D) return;
    e.stopImmediatePropagation();
    const along = ((e.clientX - D.start[0]) * D.d[0] + (e.clientY - D.start[1]) * D.d[1]) / D.L2 * 100;
    const step = e.shiftKey ? 1 : 10;
    const to = FE.snap(D.h.p[D.a] + along * D.sgn, step);
    const r = FE.dragHandle(D.from.fam, D.from.values, D.h, to, ctxOf());
    if (!r.ok) { say(msg(r.error)); return; }
    E.fam = r.fam; E.values = r.values; say('');
    D.list = handleList();
    pvBox.replaceChildren(...previewInputs());
    drawHandles();
    schedule(120);
  }, true);
  const endDrag = (e) => {
    const D = E.drag;
    if (!D) return;
    e.stopImmediatePropagation();
    E.drag = null;
    if (D.from.fam !== E.fam || D.from.values !== E.values) { E.undo.push(D.from); E.redo = []; E.dirty = true; }
    render(); schedule(0);
  };
  view.addEventListener('pointerup', endDrag, true);
  view.addEventListener('pointercancel', endDrag, true);

  // ---------------------------------------------------------------------------------------------- the sketch (work plane)
  function drawSketchBox() {
    const s = E.fam.solids.find((x) => x.id === E.sel);
    const on = E.tab === 'solids' && s && s.op !== 'box';
    sketchBox.hidden = !on;
    if (on) requestAnimationFrame(drawSketch);
  }
  /** The selected solid's points as numbers (its evaluated profile / path), with which ones are typed numbers. */
  function sketchData() {
    const raw = E.fam.solids.find((x) => x.id === E.sel);
    if (!raw || raw.op === 'box') return null;
    const e = ev(), s = e.ok ? e.solids.get(raw.id) : null;
    if (!s) return null;
    const sweep = raw.op === 'sweep';
    const pts = (sweep ? s.path : s.profile).map((p, i) => ({ u: p[0], v: p[1], b: sweep ? 0 : p[2] || 0, locked: literal(FE.pointsOf(raw)[i][0]) === null || literal(FE.pointsOf(raw)[i][1]) === null }));
    return { raw, s, sweep, pts, closed: !sweep, axis: raw.op === 'revolve' ? s.axis : null, names: sweep ? ['x', 'y'] : PLANE_AXES[raw.plane] };
  }
  function sketchView(d) {
    const r = sketch.getBoundingClientRect();
    const us = d.pts.map((p) => p.u), vs = d.pts.map((p) => p.v);
    if (d.axis) us.push(d.axis[0], d.axis[2]), vs.push(d.axis[1], d.axis[3]);
    let x0 = Math.min(0, ...us), x1 = Math.max(0, ...us), y0 = Math.min(0, ...vs), y1 = Math.max(0, ...vs);
    const span = Math.max(x1 - x0, y1 - y0, 100), m = span * 0.15;
    x0 -= m; x1 += m; y0 -= m; y1 += m;
    const k = Math.min(r.width / (x1 - x0), r.height / (y1 - y0));
    const ox = (r.width - (x1 - x0) * k) / 2 - x0 * k, oy = (r.height + (y1 - y0) * k) / 2 + y0 * k;
    return { r, k, S: (u, v2) => [ox + u * k, oy - v2 * k], W: (x, y) => [(x - ox) / k, (oy - y) / k] };
  }
  function gridStep(k) { for (const s of [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500]) if (s * k >= 14) return s; return 5000; }
  function drawSketch() {
    const d = sketchData();
    if (!d) return;
    const V = sketchView(d), dpr = window.devicePixelRatio || 1, { r } = V;
    if (!r.width) return;
    cs.width = Math.round(r.width * dpr); cs.height = Math.round(r.height * dpr);
    const g = cs.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs2 = getComputedStyle(document.documentElement), tok = (n, f) => cs2.getPropertyValue(n).trim() || f;
    const ink = tok('--ink', '#111'), line = tok('--line', '#ccc'), action = tok('--action', '#1d4ed8'), sheet = tok('--sheet', '#fff'), red = tok('--layer-red', '#c33');
    g.fillStyle = sheet; g.fillRect(0, 0, r.width, r.height);
    // grid and the plane's axes
    const step = gridStep(V.k);
    E.sk = { ...(E.sk || { pick: -1 }), step, V, d };
    const [wx0, wy1] = V.W(0, 0), [wx1, wy0] = V.W(r.width, r.height);
    g.strokeStyle = line; g.lineWidth = 0.5; g.beginPath();
    for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) { const [sx] = V.S(x, 0); g.moveTo(sx, 0); g.lineTo(sx, r.height); }
    for (let y = Math.ceil(wy0 / step) * step; y <= wy1; y += step) { const [, sy] = V.S(0, y); g.moveTo(0, sy); g.lineTo(r.width, sy); }
    g.stroke();
    const [ox, oy] = V.S(0, 0);
    g.strokeStyle = ink; g.lineWidth = 1; g.beginPath(); g.moveTo(0, oy); g.lineTo(r.width, oy); g.moveTo(ox, 0); g.lineTo(ox, r.height); g.stroke();
    g.fillStyle = ink; g.font = '12px system-ui, sans-serif';
    g.fillText(d.names[0], r.width - 14, oy - 5); g.fillText(d.names[1], ox + 5, 13);
    g.fillText(t('fam.ed.grid', { step: L(step) }), 6, r.height - 6);
    // the revolve axis
    if (d.axis) { const a = V.S(d.axis[0], d.axis[1]), b = V.S(d.axis[2], d.axis[3]); g.setLineDash([6, 4]); g.strokeStyle = red; g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke(); g.setLineDash([]); }
    // the outline (arcs as their points)
    const P = d.pts, n = P.length, segs = d.closed ? n : n - 1;
    g.strokeStyle = action; g.lineWidth = 2; g.beginPath();
    g.moveTo(...V.S(P[0].u, P[0].v));
    for (let i = 0; i < segs; i++) {
      const a = P[i], b = P[(i + 1) % n];
      if (a.b) for (const q of arcPoints([a.u, a.v], [b.u, b.v], a.b)) g.lineTo(...V.S(q[0], q[1]));
      g.lineTo(...V.S(b.u, b.v));
    }
    g.stroke();
    // segment middles (add a point / Shift: arc) and the points (hollow = bound to a parameter)
    E.sk.mids = [];
    for (let i = 0; i < segs; i++) {
      const a = P[i], b = P[(i + 1) % n], m = a.b ? arcMidOf(a, b) : [(a.u + b.u) / 2, (a.v + b.v) / 2], s = V.S(m[0], m[1]);
      E.sk.mids.push({ i, x: s[0], y: s[1], at: m });
      g.fillStyle = sheet; g.strokeStyle = action; g.lineWidth = 1; g.fillRect(s[0] - 3, s[1] - 3, 6, 6); g.strokeRect(s[0] - 3, s[1] - 3, 6, 6);
    }
    E.sk.pts = P.map((p, i) => { const s = V.S(p.u, p.v); return { i, x: s[0], y: s[1], locked: p.locked }; });
    for (const q of E.sk.pts) {
      g.beginPath(); g.rect(q.x - 4.5, q.y - 4.5, 9, 9);
      if (q.locked) { g.fillStyle = sheet; g.fill(); g.strokeStyle = ink; g.lineWidth = 1.5; g.stroke(); }
      else { g.fillStyle = q.i === E.sk.pick ? red : ink; g.fill(); }
    }
  }
  const arcMidOf = (a, b) => { const q = arcPoints([a.u, a.v], [b.u, b.v], a.b); return q.length ? q[Math.floor(q.length / 2)] : [(a.u + b.u) / 2, (a.v + b.v) / 2]; };
  const sk = () => E.sk;
  function skAt(e) {
    const r = sketch.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const pt = sk()?.pts?.find((q) => Math.hypot(q.x - x, q.y - y) <= 7);
    const mid = pt ? null : sk()?.mids?.find((q) => Math.hypot(q.x - x, q.y - y) <= 7);
    return { x, y, pt, mid };
  }
  const skWorld = (x, y, free) => { const [u, w] = sk().V.W(x, y), st = free ? 1 : Math.max(1, sk().step / 2); return [FE.snap(u, st), FE.snap(w, st)]; };
  sketch.addEventListener('pointerdown', (e) => {
    if (!sk() || e.button !== 0) return;
    const d = sk().d, { x, y, pt, mid } = skAt(e);
    if (pt) {
      sk().pick = pt.i;
      if (pt.locked) { say(t('fam.err.bound')); drawSketch(); return; }
      sk().drag = { i: pt.i, from: { fam: E.fam, values: E.values } };
      sketch.setPointerCapture?.(e.pointerId);
      drawSketch();
      return;
    }
    if (mid) {
      if (e.shiftKey || e.altKey) { change(FE.setBulge(E.fam, d.raw.id, mid.i, FE.cycleArc(d.pts[mid.i].b))); return; }
      const r = FE.insertPoint(E.fam, d.raw.id, mid.i, mid.at.map((q) => FE.snap(q, 1)));
      if (change(r)) { sk().pick = mid.i + 1; sk().drag = { i: mid.i + 1, from: null }; sketch.setPointerCapture?.(e.pointerId); }
      return;
    }
    // empty paper: a point after the picked one (else at the end)
    const at = sk().pick >= 0 ? sk().pick : d.pts.length - 1;
    if (change(FE.insertPoint(E.fam, d.raw.id, at, skWorld(x, y, e.shiftKey)))) sk().pick = at + 1;
  });
  sketch.addEventListener('pointermove', (e) => {
    const D = sk()?.drag;
    if (!D) return;
    const { x, y } = skAt(e), d = sk().d;
    const r = FE.movePoint(E.fam, d.raw.id, D.i, skWorld(x, y, e.shiftKey));
    if (!r.ok) return;
    if (!D.from) D.from = { fam: E.fam, values: E.values };
    E.fam = r.fam;
    drawSketch();
    schedule(150);
  });
  const skEnd = () => {
    const D = sk()?.drag;
    if (!D) return;
    sk().drag = null;
    if (D.from && D.from.fam !== E.fam) { E.undo.push(D.from); E.redo = []; E.dirty = true; }
    render(); schedule(0);
  };
  sketch.addEventListener('pointerup', skEnd);
  sketch.addEventListener('pointercancel', skEnd);
  sketch.addEventListener('dblclick', (e) => { const { pt } = skAt(e); if (pt && !pt.locked) removePt(pt.i); });
  new ResizeObserver(() => { if (!sketchBox.hidden) drawSketch(); drawHandles(); }).observe(sketch);

  render();
  schedule(0);
  const api = { state: E, change, undo, redo, save, render, preview, handles: () => E.hs || [], sketch: () => E.sk, close: () => dlg.close() };
  if (typeof window !== 'undefined') window.bimcraftFamilyEditor = api;   // for tests
  return api;
}
