/* SPDX-License-Identifier: Apache-2.0 */
/** A deliberately small adapter. Every caller gets the same live enablement and action. No DOM-button forwarding. */
export function createCommands({ state, actions, explain = () => {}, t = (k) => k }) {
  const open = () => t('ws.why.open'), wait = (s) => t(s?.placing ? 'ws.why.placing' : 'ws.why.busy');
  const wallReason = s => !s.document ? open() : s.busy ? wait(s) : s.view?.kind !== 'plan' ? t('ws.why.wallplan') : !s.levels.length ? t('ws.why.nolevels') : s.wall?.placementError || '';
  const typeReason = s => !s.document ? open() : s.busy ? wait(s) : s.wall?.placing ? s.wall.placementError || '' : !s.wall?.supported ? t('ws.why.typewalls') : !s.wall.sameType ? t('ws.why.onetype') : '';
  const definitions = {
    wall: { categories: ['floor-plan'], reason: wallReason },
    assembly: { categories: ['authored-wall-type'], reason: typeReason },
    structure: { categories: ['authored-wall-type'], reason: typeReason },
    cancel: { categories: ['wall-placement'], reason: s => s.wall?.placing ? '' : t('ws.why.noplacing') },
    finish: { categories: ['wall-placement'], reason: s => s.wall?.placing ? '' : t('ws.why.noplacing') },
    open: { categories: ['document'], reason: s => s.busy ? wait(s) : '' },
    save: { categories: ['document'], reason: s => !s.document ? open() : s.busy ? wait(s) : !s.dirty ? t('ws.why.nochanges') : '' },
    undo: { categories: ['document'], reason: s => !s.document ? open() : s.busy ? wait(s) : !s.canUndo ? t('ws.why.noundo') : '' },
    redo: { categories: ['document'], reason: s => !s.document ? open() : s.busy ? wait(s) : !s.canRedo ? t('ws.why.noredo') : '' },
    select: { categories: ['element'], reason: s => !s.document ? open() : s.busy ? wait(s) : !s.view ? t('ws.why.nodrawing') : '' },
    clear: { categories: ['element'], reason: s => !s.document ? open() : s.busy ? wait(s) : !s.selection.length ? t('ws.why.noselection') : '' },
    three: { categories: ['view'], reason: s => !s.document ? open() : s.busy ? wait(s) : '' },
    plan: { categories: ['view'], reason: s => !s.document ? open() : s.busy ? wait(s) : !s.levels.length ? t('ws.why.nolevels') : '' },
    range: { categories: ['floor-plan'], reason: s => !s.document ? open() : s.busy ? wait(s) : s.view?.kind !== 'plan' ? t('ws.why.range3d') : '' },
    detail: { categories: ['floor-plan'], reason: s => !s.document ? open() : s.busy ? wait(s) : s.view?.kind !== 'plan' ? t('ws.why.plan') : s.settings?.template ? t('ws.why.template', { name: s.settings.template }) : '' },
    scale: { categories: ['floor-plan'], reason: s => !s.document ? open() : s.busy ? wait(s) : s.view?.kind !== 'plan' ? t('ws.why.plan') : s.settings?.template ? t('ws.why.template', { name: s.settings.template }) : '' },
    fit: { categories: ['view'], reason: s => !s.document ? open() : s.busy ? wait(s) : !s.view ? t('ws.why.nodrawing') : '' },
  };
  function describe(id) {
    const d = definitions[id];
    if (!d || typeof actions[id] !== 'function') return { id, categories: [], enabled: false, reason: t('ws.why.notbuilt') };
    const reason = d.reason(state());
    return { id, categories: d.categories, enabled: !reason, reason };
  }
  function execute(id, value) {
    const d = describe(id);
    if (!d.enabled) { explain(d.reason); return false; }
    return actions[id](value);
  }
  return { describe, execute, ids: Object.keys(definitions) };
}

export function isTextEntry(target) {
  return !!target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog, [data-help-panel], [data-app-settings]');
}
export function shortcutCommand(event, state = {}) {
  if (event.defaultPrevented || event.altKey || isTextEntry(event.target)) return null;
  const key = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey;
  if (mod) {
    if (key === 'o' && !event.shiftKey) return 'open';
    if (key === 's' && !event.shiftKey) return 'save';
    if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
    if (key === 'y') return 'redo';
  } else if (key === 'escape') return state.live && state.wall?.placing ? 'cancel' : 'clear';
  else if (state.live && key === 'enter' && state.wall?.placing) return 'finish';
  else if (state.live && key === 'w' && !event.shiftKey) return 'wall';
  else if (state.live && key === 'v' && !event.shiftKey) return 'select';
  else if (key === 'f' && !event.shiftKey) return 'fit';
  return null;
}

/** Tabs belong to one editor session. Closing a drawing never closes its document. */
export function createDrawingTabs() {
  let document = null, active = null;
  const tabs = new Map();
  return {
    reset(owner) { if (owner === document) return false; document = owner; tabs.clear(); active = null; return true; },
    open(view) { tabs.set(view.id, { ...tabs.get(view.id), ...view }); active = view.id; },
    close(id) { tabs.delete(id); if (active === id) active = [...tabs.keys()].at(-1) || null; return tabs.get(active) || null; },
    get active() { return tabs.get(active) || null; },
    get all() { return [...tabs.values()]; },
  };
}
