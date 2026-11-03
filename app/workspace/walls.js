/* SPDX-License-Identifier: Apache-2.0 */
import { node, button } from './dom.js';
import { isTextEntry } from './commands.js';
import { ModelWriter } from '../model-write.js';
import { wallType, typeName, typeThickness } from '../model-walls.js';
import { assertAssembliesEditable } from '../wall-assemblies.js';
import { readMaterials } from '../project-materials.js';
import { fmtLen } from '../model-units.js';
import { placementReference } from '../wall-placement.js';

export const INSTANCE_WALL_FIELDS = '[data-mp-type], [data-mp-assembly], [data-mp-just], [data-mp-top], [data-mp-height], [data-mp-base], [data-mp-flipside]';
const locationChoices = ['center', 'coreCenter', 'outside', 'inside', 'coreExterior', 'coreInterior'];   // text ws.loc.<value>
export function wallSelection(data, keys, base, tool) {
  const walls = (data?.walls || []).filter(w => keys.includes(base + w.id));
  const supported = walls.length > 0 && walls.length === keys.length && walls.every(w => !w.referenceIssue && w.assembly);
  return { placing: tool === 'wall', supported, count: walls.length, sameType: supported && walls.every(w => w.typeKey === walls[0].typeKey), walls };
}

/** Move the established bound controls, not their values or event handlers. Type dialogs call the existing extension. */
export function mountWallWorkflow({ root, A, commands, defaults, unitsHost, options, status }) {
  const ui = A.workspaceWallControls(), homes = new Map(), T = (k, v) => A.t(k, v);
  let mounted = false, typeContext = null, validationData = null, validationEditor = null, placementError = '', placementType = null, placementKey = null;
  const writer = () => new ModelWriter(A.ed().W, A.ed().api, A.ed().mid);
  const typeField = ui.type.closest('label');
  const originalShape = { disabled: ui.shape.disabled, title: ui.shape.title, arcDisabled: ui.shape.querySelector('[value="arc"]').disabled };
  const originalTop = { disabled: ui.top.querySelector('[value="level"]').disabled, title: ui.top.querySelector('[value="level"]').title };
  const slot = node('div', { className: 'ws-wall-options', 'data-ws-wall-options': '', hidden: true });
  const note = node('p', { className: 'ws-note' }, T('ws.wall.defaults'));
  const topNote = node('p', { className: 'ws-note', 'data-ws-top-reason': '' });
  defaults.append(node('div', { className: 'ws-prop-identity' }, node('strong', {}, T('ws.wall.newplacement'))), note);
  const edit = button(T('ws.tool.assembly'), { 'data-ws-command': 'assembly' });
  const unitsLabel = node('label', { className: 'ws-native-field' }, node('span', {}, T('ws.wall.units') + ' '));
  unitsHost.append(unitsLabel);
  defaults.append(edit, topNote, node('p', { className: 'ws-note' }, T('ws.wall.howto')));
  const cancel = button(T('ws.wall.cancel'), { 'data-ws-command': 'cancel' });
  options.append(slot);
  function move(element, parent, before = null) {
    if (!element) return;
    if (!homes.has(element)) { const home = document.createComment('F28-B bound control home'); element.before(home); homes.set(element, home); }   // i18n-ignore: a comment node
    parent.insertBefore(element, before);
  }
  function metadata() {
    const selected = wallSelection(A.S.data, A.selectedKeys(), A.kb(), A.S.tool);
    if (validationEditor !== A.ed() || validationData !== A.S.data) {
      validationEditor = A.ed(); validationData = A.S.data; placementError = '';
      if (A.ed()) try { assertAssembliesEditable(writer()); readMaterials(writer()); } catch (e) { placementError = e.message; }
      placementKey = null;
    }
    let reason = placementError;
    if (!reason && A.ed()) try {
      if (placementKey !== A.S.wall.typeKey) { placementKey = A.S.wall.typeKey; placementType = wallType(placementKey, writer()); }
      placementReference(A.S.wall.reference, placementType, A.S.wall.side);
    } catch (e) { reason = e.message; }
    return { ...selected, placementError: reason };
  }
  function setActive(on) {
    if (on === mounted) return;
    mounted = on;
    if (on) {
      move(ui.row, slot); move(typeField, defaults, edit); move(ui.typedRow, slot); move(ui.units, unitsLabel);
      ui.reference.replaceChildren(...locationChoices.map((value) => node('option', { value }, T('ws.loc.' + value.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())))));
      ui.reference.value = A.S.wall.reference;
      ui.shape.querySelector('[value="arc"]').disabled = true;
      ui.shape.disabled = true; ui.shape.title = T('ws.wall.straight');
    } else {
      for (const [element, home] of [...homes].reverse()) if (home.parentNode) { home.after(element); home.remove(); }
      homes.clear(); ui.shape.querySelector('[value="arc"]').disabled = originalShape.arcDisabled; ui.shape.disabled = originalShape.disabled; ui.shape.title = originalShape.title;
      Object.assign(ui.top.querySelector('[value="level"]'), originalTop);
    }
  }
  function refresh() {
    if (!mounted) return;
    const placing = A.S.tool === 'wall'; slot.hidden = !placing; defaults.hidden = !placing;
    ui.shape.disabled = true; ui.shape.querySelector('[value="arc"]').disabled = true;
    for (const label of ui.row.querySelectorAll('label')) label.classList.add('ws-native-field');
    typeField.classList.add('ws-native-field');
    if (!slot.contains(cancel)) slot.append(cancel);
    const above = ui.top.querySelector('[value="level"]');
    above.disabled = !A.levelAbove();
    above.title = above.disabled ? T('ws.wall.noabove') : '';
    topNote.textContent = above.title; topNote.hidden = !above.disabled;
  }
  function start() {
    if (!A.levelAbove() && A.S.wall.top === 'level') { A.S.wall.top = 'fixed'; ui.top.value = 'fixed'; }
    A.S.wall.shape = 'straight'; ui.shape.value = 'straight';
    A.host.select([]); A.setTool('wall');
    ui.height.hidden = A.S.wall.top !== 'fixed'; refresh();
  }
  function context() {
    const m = metadata();
    const selected = !m.placing && m.supported ? m.walls : [];
    const key = selected.length ? selected[0].typeKey : A.S.wall.typeKey;
    return { editor: A.ed(), key, assign: selected.map(w => w.guid), placement: !selected.length };
  }
  function editType() {
    typeContext = context();
    let type;
    try { assertAssembliesEditable(writer()); type = wallType(typeContext.key, writer()); if (!type) throw new Error(T('wall.err.type_missing')); }
    catch (e) { status(e.message, true); return; }
    const count = (A.S.data?.walls || []).filter(w => w.typeKey === type.key).length;
    const dlg = node('dialog', { className: 'ws-dialog ws-type-dialog', 'data-ws-type-dialog': '', 'aria-label': T('ws.type.title') });
    const structure = button(T('ws.type.edit'), { 'data-ws-command': 'structure', 'data-ws-structure': '' });
    dlg.append(node('h2', {}, T('ws.type.title')), node('dl', { className: 'ws-view-dl' },
      node('dt', {}, T('ws.type.family')), node('dd', {}, T('ws.type.basic')), node('dt', {}, T('ws.type.type')), node('dd', {}, typeName(type)),
      node('dt', {}, T('ws.type.structure')), node('dd', {}, structure), node('dt', {}, T('ws.type.width')), node('dd', {}, fmtLen(typeThickness(type), A.units()))),
      node('p', { 'data-ws-type-effects': '' }, type.custom ? T('ws.type.custom', { n: count }) : T('ws.type.starter')),
      node('p', { className: 'ws-note' }, typeContext.placement ? T('ws.type.future') : T('ws.type.assign', { n: typeContext.assign.length })),
      button(T('ws.close'), { 'data-ws-dismiss': '' }));
    root.append(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal();
  }
  function editStructure() {
    const ctx = typeContext || context();
    if (ctx.editor !== A.ed()) { status(T('ws.type.changed'), true); return; }
    root.querySelector('[data-ws-type-dialog]')?.close();
    A.ask('openAssembly', ctx.key, ctx.assign);
  }
  function key(event) {
    if (!mounted || A.S.tool !== 'wall' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isTextEntry(event.target) || document.querySelector('dialog[open]')) return;
    if (/^[0-9@'"<.,\-\/]$/.test(event.key)) { event.preventDefault(); A.workspaceTyped(event.key); }
  }
  root.addEventListener('click', e => {
    if (!mounted) return;
    const b = e.target.closest('[data-mp-assembly]');
    if (b && !b.hasAttribute('data-ws-readonly')) { e.preventDefault(); e.stopImmediatePropagation(); commands.execute('assembly'); }
  }, true);
  document.addEventListener('keydown', key);
  return { setActive, refresh, metadata, start, editType, editStructure };
}
