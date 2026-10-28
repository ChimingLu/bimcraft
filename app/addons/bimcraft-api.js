/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — every word a person reads comes from the add-on (api.t) or the app's language file. */
/**
 * bimcraft-api.js — BimCraft's add-on API 1.0 and its own add-on loader (0.5 AO.7; docs/ADDONS-SPEC.md §5.7).
 * Once BimCraft's manifest says "addons": "own", the shell's boot (app-addons.js) steps aside and bimcraft.js calls
 * startAddons({ … }) with the open model and the hooks listed below.
 *
 *   api = { ...sharedApi (ui.toolbarGroup, ui.panelSection, ui.settingsSection, files.importer / exporter),
 *           model: { current, properties, selection, select, onChange },
 *           edit: { setAttribute, setProperty },   (each one undo step through BimCraft's IfcEditor, then the panels refresh)
 *           commands: { add, run, has }, props: { section }, ui.panelTab, status,
 *           draw: { tools, run, made, remove } }   (1.1; only with "draw" in addon.json's permissions — see below)
 *
 * The model is BimCraft's IFC model (ifc-model.js: properties(id) → { id, cls, name, guid, tag, sets: [{ name, rows: [{ name,
 * value, edit }] }] }); ids are the open model's express ids. Importers return { ifc: Uint8Array, name } (opened like an .ifc
 * file); exporters get { save: () => IFC bytes with the edits, name }.
 *
 * The app reads what add-ons registered through the object startAddons returns (also window.ccAddons):
 *   runCommand(key) · propsSections(selection ids, model) → [{ key, label, fields: [{ label, value, edit? }] }] · panelTabs() ·
 *   importerFor(name) / openFromAddon(file) · exporters() / exportInput(name) · changed(why).
 * draw (1.1) — BimCraft's Draw edits, the same tools an assistant gets (agents.js modelTools): model_describe, walls_list,
 * walls_add, opening_add, floor_add, levels_add, grid_add. tools() → [{ name, group, title, description, inputSchema }];
 * run(name, args) → the tool's result, each edit one undo step "<add-on name>: <label>"; made() → the GlobalIds its edits
 * made (this session); remove(guids) → { removed } takes away walls, doors, windows and floors it made itself (one undo
 * step; anything else is refused). ctx.draw = { ed, apply(label, op, prefix) } (agents.js drawEnv); without it there is
 * no model to draw in and run() throws.
 * DOM-free except ui.panelTab: bin/test-addons-model-apps.mjs runs it in Node.
 */

import { AddonLoader, sharedApi } from '../addons.js';
import { EDITABLE_ATTRS } from '../ifc-edit.js';
import { installTrust, bundledOnly, NO_PACKAGES } from './trust.js';
import { modelTools } from '../agents.js';
import { removeDrawn } from '../model-floors.js';

export const BIMCRAFT_API_VERSION = '1.1';
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const clone = (v) => (v === undefined || v === null ? v ?? null : JSON.parse(JSON.stringify(v)));

/**
 * The API one add-on gets. ctx = { editor() → IfcEditor | null, model() → IfcModel | null, name() → file name, selection() →
 * [ids], select(ids), afterEdit() (the panels after an edit), status(text), registry, commands, props, tabs, changeListeners,
 * find(selector), showTab(key) }.
 */
export function makeBimcraftApi(base, addon, ctx) {
  const shared = sharedApi(base, addon, ctx.registry);
  const id = addon.id;
  const track = (fn) => base.onDeactivate(fn);
  const listen = new Set();
  ctx.changeListeners.add((why) => { for (const fn of listen) { try { fn(why); } catch (e) { base.log('onChange threw', e); } } });
  const needEditor = () => { const ed = ctx.editor(); if (!ed) throw new Error('no IFC model is open'); return ed; };

  const model = {
    /** { name } of the open IFC model, or null. */
    current: () => (ctx.model() ? { name: ctx.name() } : null),
    /** An element's attributes and property sets (a copy; rows with `edit` can be changed with edit.setProperty). */
    properties: async (eid) => { const m = ctx.model(); return m ? clone(await m.properties(Number(eid))) : null; },
    selection: () => [...ctx.selection()],
    select: (ids) => ctx.select([...ids].map(Number)),
    onChange(fn) { listen.add(fn); const off = () => listen.delete(fn); track(off); return off; },
  };

  const edit = {
    /** Name, Description, ObjectType or Tag of an element: one undo step. */
    setAttribute(eid, attr, value) {
      if (!EDITABLE_ATTRS.includes(attr)) throw new Error('edit.setAttribute: one of ' + EDITABLE_ATTRS.join(', '));
      const r = needEditor().setAttribute(Number(eid), attr, String(value ?? ''));
      ctx.afterEdit(addon.name);
      return r;
    },
    /** One property value (by property set and property name), as Properties edits it: one undo step. → false when it has none. */
    async setProperty(eid, setName, propName, value) {
      const ed = needEditor();
      const p = await ctx.model().properties(Number(eid));
      const row = p?.sets?.find((s) => s.name === setName)?.rows?.find((r) => r.name === propName && r.edit);
      if (!row) return false;
      ed.setProperty(Number(eid), row.edit, value);
      ctx.afterEdit(addon.name);
      return true;
    },
  };

  const commands = {
    add(name, fn, { label = name } = {}) {
      if (!SAFE_ID.test(String(name)) || typeof fn !== 'function') throw new Error('commands.add: name and fn');
      const key = id + ':' + name;
      if (ctx.commands.has(key)) throw new Error('commands.add: "' + name + '" is already added');
      ctx.commands.set(key, { addon: id, name, label: String(label), run: () => fn(api) });
      const off = () => ctx.commands.delete(key);
      track(off);
      return off;
    },
    run: (name) => { const c = ctx.commands.get(id + ':' + name); return c ? c.run() : undefined; },
    has: (name) => ctx.commands.has(id + ':' + name),
  };

  const props = {
    /** A section in the Properties panel: fields(selection ids, model) → [{ label, value, edit?(value) }] or []. */
    section({ key = id, label, fields } = {}) {
      if (key !== id && !String(key).startsWith(id + '.')) throw new Error('props.section: the key must be "' + id + '" or start with "' + id + '."');
      if (typeof fields !== 'function') throw new Error('props.section: fields(selection, model)');
      ctx.props.set(key, { key, addon: id, label: String(label || addon.name), fields });
      const off = () => ctx.props.delete(key);
      track(off);
      return off;
    },
  };

  const draw = drawApi(ctx, addon);

  const ui = { ...shared.ui, panelTab: panelTabMaker(ctx, id, base, track, '.bc-rtabs[role="tablist"]', 'bc-rtab', 'bc-rpane-') };
  const api = { ...shared, ui, model, edit, commands, props, draw, status: (text) => ctx.status(String(text)) };
  return api;
}

/** api.draw (1.1): the Draw edits for an add-on with the "draw" permission. */
function drawApi(ctx, addon) {
  const allowed = (addon.manifest?.permissions || []).includes('draw');
  const need = () => {
    if (!allowed) throw new Error('draw: add "draw" to the permissions in addon.json');
    if (!ctx.draw) throw new Error('draw: BimCraft has no Draw tools here');
    return ctx.draw;
  };
  const prefix = (addon.manifest?.name || addon.id) + ': ';
  const made = new Set();
  let defs = null;
  const tools = () => {
    const env = need();
    if (!defs) {
      const apply = async (label, op) => {
        const r = await env.apply(label, op, prefix);
        for (const g of r?.made?.keys?.() || []) made.add(g);
        return r;
      };
      defs = new Map(modelTools({ ed: env.ed, apply }).map((d) => [d.name, d]));
    }
    return defs;
  };
  return {
    tools: () => [...tools().values()].map((d) => clone({ name: d.name, group: d.group, title: d.title, description: d.description, inputSchema: d.inputSchema || { type: 'object', properties: {} } })),
    async run(name, args = {}) {
      const d = tools().get(String(name));
      if (!d) throw new Error('draw.run: no tool "' + name + '"');
      return clone(await d.run(clone(args) || {}));
    },
    made: () => [...made],
    async remove(guids) {
      const env = need();
      const list = [...new Set([...guids].map(String))];
      const foreign = list.filter((g) => !made.has(g));
      if (foreign.length) throw new Error('draw.remove: only what this add-on made (' + foreign.slice(0, 3).join(', ') + ')');
      if (!list.length) return { removed: 0 };
      if (!env.ed()) throw new Error('no IFC model is open');
      await env.apply('remove ' + list.length + (list.length > 1 ? ' elements' : ' element'), removeDrawn(list), prefix);
      for (const g of list) made.delete(g);
      return { removed: list.length };
    },
  };
}

function panelTabMaker(ctx, id, base, track, listSel, tabClass, paneIdPrefix) {
  return function panelTab({ id: tid, title, render } = {}) {
    if (!SAFE_ID.test(String(tid))) throw new Error('ui.panelTab: id');
    const key = 'addon-' + (id + '-' + tid).replace(/[^a-z0-9-]/g, '-');
    ctx.tabs.set(key, { addon: id, title: String(title || tid), render });
    track(() => ctx.tabs.delete(key));
    if (!ctx.find || typeof document === 'undefined') return null;
    const list = ctx.find(listSel);
    if (!list) return null;
    const btn = document.createElement('button');
    Object.assign(btn, { type: 'button', className: tabClass, id: tabClass + '-' + key, textContent: String(title || tid), tabIndex: -1 });
    btn.setAttribute('role', 'tab'); btn.setAttribute('aria-selected', 'false'); btn.setAttribute('aria-controls', paneIdPrefix + key);
    btn.dataset.rtab = key; btn.dataset.addon = id;
    const pane = document.createElement('section');
    Object.assign(pane, { id: paneIdPrefix + key, hidden: true });
    pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', btn.id);
    pane.dataset.rpane = key; pane.dataset.addon = id;
    pane.addEventListener('cc-tab-shown', () => { try { pane.replaceChildren(); render?.(pane); } catch (e) { base.log('panelTab render threw', e); } });
    btn.addEventListener('click', () => ctx.showTab?.(key));
    list.append(btn);
    list.parentElement.append(pane);
    track(() => { if (btn.getAttribute('aria-selected') === 'true') ctx.showTab?.(null); btn.remove(); pane.remove(); });
    return pane;
  };
}

/**
 * Start BimCraft's add-ons. ctx: see makeBimcraftApi, plus openIfc(bytes, name) for importers, and loader options for tests
 * (packages, storage, importer, fetchJson, base, verify, bundledOnly).
 */
export async function startAddons(ctx) {
  const registry = { importers: new Map(), exporters: new Map(), listeners: new Set(), changed() { for (const fn of this.listeners) { try { fn(); } catch { /* app */ } } } };
  const full = { ...ctx, registry, commands: new Map(), props: new Map(), tabs: new Map(), changeListeners: new Set() };
  const opts = { app: 'bimcraft', appName: ctx.appName || 'BimCraft', apiVersion: BIMCRAFT_API_VERSION, makeApi: (b, a) => makeBimcraftApi(b, a, full) };
  for (const k of ['packages', 'storage', 'importer', 'fetchJson', 'base', 'locale', 'timeout']) if (ctx[k] !== undefined) opts[k] = ctx[k];
  if (ctx.bundledOnly ?? bundledOnly()) opts.packages = NO_PACKAGES;
  if (!ctx.verify) installTrust(AddonLoader); else AddonLoader.verify = ctx.verify;
  const loader = new AddonLoader(opts);
  const importerFor = (name) => { const n = String(name || '').toLowerCase(); return [...registry.importers.values()].find((e) => e.extensions.some((x) => n.endsWith(x))) || null; };
  const api = {
    loader,
    list: () => loader.list(), installPackage: (p) => loader.installPackage(p), uninstall: (id) => loader.uninstall(id),
    onChange: (fn) => { registry.listeners.add(fn); const off = loader.on(fn); return () => { registry.listeners.delete(fn); off(); }; },
    runCommand(key) { const c = full.commands.get(String(key)); if (!c) return false; try { c.run(); } catch (e) { console.warn('add-on command failed:', e); } return true; },   // i18n-ignore
    commandList: () => [...full.commands.entries()].map(([key, c]) => ({ key, addon: c.addon, name: c.name, label: c.label })),
    async propsSections(selection, model) {
      const out = [];
      for (const s of full.props.values()) {
        let fields;
        try { fields = await s.fields([...selection], model); } catch (e) { console.warn('add-on Properties section failed:', e); continue; }   // i18n-ignore
        if (!Array.isArray(fields) || !fields.length) continue;
        out.push({ key: s.key, label: s.label, fields: fields.filter((f) => f && typeof f.label === 'string').map((f) => ({ label: f.label, value: f.value === null || f.value === undefined ? '' : String(f.value), ...(typeof f.edit === 'function' ? { edit: f.edit } : {}) })) });
      }
      return out;
    },
    panelTabs: () => [...full.tabs.entries()].map(([key, x]) => ({ key, addon: x.addon, title: x.title })),
    importers: () => [...registry.importers.values()],
    exporters: () => [...registry.exporters.values()],
    importerFor,
    /** An add-on importer for this file → true when it opened it as IFC. */
    async openFromAddon(file) {
      const imp = importerFor(file?.name);
      if (!imp) return false;
      const data = await imp.read(file);
      if (!data || !(data.ifc instanceof Uint8Array)) throw new Error('the add-on\'s importer returned no IFC bytes');   // i18n-ignore
      await ctx.openIfc(data.ifc, String(data.name || file.name.replace(/\.[^.]+$/, '') + '.ifc'));
      return true;
    },
    /** What an exporter's write() gets. */
    exportInput: (name) => ({ save: () => ctx.editor()?.save() ?? null, name: name || ctx.name() }),
    changed: (why) => { for (const fn of full.changeListeners) fn(why); },
  };
  if (typeof window !== 'undefined' && !ctx.noGlobal) window.ccAddons = api;
  await loader.start();
  return api;
}
