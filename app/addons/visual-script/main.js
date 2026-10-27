/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — every word a person reads comes from this add-on's lang/<locale>.json through api.t. */
/**
 * main.js — the visual script add-on (BimCraft add-on API 1.1): a tab on the right with a node editor. Nodes (nodes.js)
 * are wired output → input; Run runs the graph (graph.js) and its Draw nodes change the open model through api.draw, each
 * step under the add-on's name in Changes. "Replace" takes away what the previous run made first, so changing a slider and
 * running again changes the building instead of adding a second one; "Auto" runs after every change.
 *
 * The graph is kept in api.storage ("graph") after every change; Export / Import write and read it as a .json file.
 * Editor: drag a node by its title; drag from an output dot to an input dot to wire them (an input's dot clicked unwires
 * it); drag the background to pan, the wheel to zoom; "Expand" lifts the editor over the view.
 */
import { NODE_TYPES, CATEGORIES, exampleGraph } from './nodes.js';
import * as G from './graph.js';

const STYLE = `
.vs-root { display: flex; flex-direction: column; height: min(70vh, 40rem); min-height: 20rem; font-size: var(--fs-sm, .85rem); color: var(--ink, #222); }
.vs-root.vs-big { position: fixed; inset: 4.5rem 1.5rem 1.5rem 1.5rem; height: auto; z-index: 1000; background: var(--sheet, #fff); border: var(--pen-2, 2px) solid var(--ink, #222); box-shadow: 0 .5rem 2rem rgba(0,0,0,.25); }
.vs-bar { display: flex; flex-wrap: wrap; gap: .3rem; align-items: center; padding: .35rem; border-bottom: var(--pen-1, 1px) solid var(--line, #ccc); background: var(--sheet-2, #f6f6f6); }
.vs-bar button, .vs-bar select { font: inherit; padding: .15rem .45rem; border: var(--pen-1, 1px) solid var(--line, #bbb); border-radius: var(--radius, 3px); background: var(--sheet, #fff); color: inherit; cursor: pointer; }
.vs-bar .vs-run { background: var(--action, #1a6); color: var(--on-action, #fff); border-color: transparent; }
.vs-bar .vs-run[disabled] { opacity: .6; }
.vs-bar label { display: inline-flex; gap: .2rem; align-items: center; cursor: pointer; }
.vs-canvas { position: relative; flex: 1; overflow: hidden; cursor: grab; touch-action: none;
  background-color: var(--sheet, #fff); background-image: radial-gradient(var(--line, #ddd) 1px, transparent 1px); background-size: 20px 20px; }
.vs-canvas.vs-panning { cursor: grabbing; }
.vs-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.vs-links { position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible; pointer-events: none; }
.vs-links path { fill: none; stroke: var(--ink-2, #666); stroke-width: 2; }
.vs-links path.vs-temp { stroke-dasharray: 5 4; }
.vs-node { position: absolute; min-width: 11rem; max-width: 15rem; background: var(--sheet, #fff); border: var(--pen-1, 1px) solid var(--ink-2, #666); border-radius: var(--radius, 4px); box-shadow: 0 1px 4px rgba(0,0,0,.15); cursor: default; }
.vs-node.vs-err { border-color: var(--layer-red, #c33); }
.vs-head { display: flex; align-items: center; gap: .3rem; padding: .2rem .4rem; border-bottom: var(--pen-1, 1px) solid var(--line, #ddd); cursor: move; font-weight: 600; border-radius: var(--radius, 4px) var(--radius, 4px) 0 0; }
.vs-head span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vs-head button { border: 0; background: none; color: inherit; cursor: pointer; padding: 0 .2rem; font: inherit; }
.vs-cat-input .vs-head { background: color-mix(in srgb, #3a7bd5 18%, transparent); }
.vs-cat-math .vs-head { background: color-mix(in srgb, #8e44ad 18%, transparent); }
.vs-cat-geometry .vs-head { background: color-mix(in srgb, #16a085 18%, transparent); }
.vs-cat-model .vs-head { background: color-mix(in srgb, #d68910 22%, transparent); }
.vs-cat-output .vs-head { background: color-mix(in srgb, #7f8c8d 22%, transparent); }
.vs-row { position: relative; display: flex; align-items: center; gap: .3rem; padding: .12rem .55rem; min-height: 1.5rem; }
.vs-row.vs-out { justify-content: flex-end; }
.vs-row label { white-space: nowrap; color: var(--ink-2, #555); }
.vs-row input[type=number], .vs-row input[type=text], .vs-row select { width: 6.5rem; font: inherit; padding: 0 .2rem; margin-left: auto; border: var(--pen-1, 1px) solid var(--line, #ccc); background: var(--sheet, #fff); color: inherit; }
.vs-row input[type=range] { flex: 1; min-width: 5rem; }
.vs-row input[type=checkbox] { margin-left: auto; }
.vs-row .vs-hint { margin-left: auto; color: var(--placeholder, #999); }
.vs-port { position: absolute; width: .7rem; height: .7rem; border-radius: 50%; border: 2px solid var(--ink-2, #666); background: var(--sheet, #fff); cursor: crosshair; top: 50%; transform: translateY(-50%); }
.vs-in .vs-port { left: -.42rem; }
.vs-out .vs-port { right: -.42rem; }
.vs-port.vs-wired { background: var(--ink-2, #666); }
.vs-val { padding: .15rem .5rem .25rem; color: var(--ink-2, #666); font-family: ui-monospace, monospace; font-size: .75rem; white-space: pre-wrap; word-break: break-all; border-top: var(--pen-1, 1px) dashed var(--line, #ddd); }
.vs-val:empty { display: none; }
.vs-err .vs-val { color: var(--layer-red, #c33); }
.vs-status { padding: .25rem .45rem; border-top: var(--pen-1, 1px) solid var(--line, #ccc); color: var(--ink-2, #555); min-height: 1.6rem; }
`;

const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k.includes('-') || k === 'title' || k === 'style') e.setAttribute(k, v);
    else e[k] = v;
  }
  for (const c of kids) if (c !== null && c !== undefined) e.append(c);
  return e;
};

export function activate(api) {
  const types = new Map(NODE_TYPES.map((t) => [t.type, t]));
  const T = (k, v) => api.t(k, v);
  const tOr = (k, fallback) => { const s = api.t(k); return s === k ? fallback : s; };
  const nodeName = (type) => tOr('node.' + type, type);
  const portName = (key) => tOr('port.' + key, key);
  const errText = (msg) => tOr('err.' + msg, msg);

  let graph = G.cleanGraph(api.storage.get('graph'), types);
  if (!graph.nodes.length && !api.storage.get('graph')) graph = G.cleanGraph(exampleGraph(), types);
  const S = { out: new Map(), errors: new Map(), last: [], running: false, again: false, auto: !!api.storage.get('auto'), replace: api.storage.get('replace') !== false, big: false, view: { x: 10, y: 10, s: 1 }, timer: 0 };
  let E = null;   // the editor on screen: { root, canvas, world, svg, status, nodes: Map(id → element), run }
  const save = () => api.storage.set('graph', graph);

  if (!document.getElementById('vs-style')) document.head.append(el('style', { id: 'vs-style', text: STYLE }));
  api.onDeactivate(() => { document.getElementById('vs-style')?.remove(); clearTimeout(S.timer); });

  /** A choice input's options: the enum of the Draw tool's property it names. */
  let schemas = null;
  const choicesOf = (inp) => {
    if (!inp.choices) return [];
    try { schemas = schemas || new Map(api.draw.tools().map((d) => [d.name, d.inputSchema])); } catch (e) { return [inp.default]; }
    const [tool, prop] = inp.choices;
    return schemas.get(tool)?.properties?.[prop]?.enum || [inp.default];
  };

  // ------------------------------------------------------------------ running
  const say = (text) => { if (E) E.status.textContent = text; };
  async function run() {
    if (S.running) { S.again = true; return; }
    if (!api.model.current()) { say(T('status.nomodel')); return; }
    S.running = true;
    if (E) E.run.disabled = true;
    say(T('status.running'));
    try {
      if (S.replace && S.last.length) {
        try { await api.draw.remove(S.last); } catch (e) { api.log('remove failed', e); }
        S.last = [];
      }
      const before = new Set(api.draw.made());
      S.out = new Map(); S.errors = new Map();
      const r = await G.runGraph(graph, types, { draw: (name, args) => api.draw.run(name, args) }, { onNode: (id, out, err) => { if (err) S.errors.set(id, err); else S.out.set(id, out); paintNode(id); } });
      S.last = api.draw.made().filter((g) => !before.has(g));
      say(r.errors.size ? T('status.errors', { n: r.errors.size }) : T('status.done', { n: r.order.length, made: S.last.length }));
    } catch (e) {
      say(errText(String(e?.message || e)));
    } finally {
      S.running = false;
      if (E) E.run.disabled = false;
      if (S.again) { S.again = false; run(); }
    }
  }
  const changed = () => {
    save();
    if (!S.auto) return;
    clearTimeout(S.timer);
    S.timer = setTimeout(run, 500);
  };

  // ------------------------------------------------------------------ results on the nodes
  const short = (v, depth = 0) => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
    if (typeof v === 'string') return v.length > 24 ? v.slice(0, 22) + '…' : v;
    if (typeof v === 'boolean') return v ? '✓' : '✗';
    if (Array.isArray(v)) {
      if (depth > 1) return '[' + v.length + ']';
      const parts = v.slice(0, 6).map((x) => short(x, depth + 1));
      return '[' + parts.join(', ') + (v.length > 6 ? ', … (' + v.length + ')' : '') + ']';
    }
    return '{…}';
  };
  function paintNode(id) {
    const box = E?.nodes.get(id);
    if (!box) return;
    const err = S.errors.get(id), out = S.out.get(id), def = types.get(graph.nodes.find((n) => n.id === id)?.type);
    box.classList.toggle('vs-err', !!err);
    const val = box.querySelector('.vs-val');
    if (err) val.textContent = errText(err);
    else if (out && def) val.textContent = def.outputs.map((o) => (def.outputs.length > 1 ? portName(o.key) + ': ' : '') + short(out[o.key])).join('\n');
    else val.textContent = '';
  }

  // ------------------------------------------------------------------ the editor
  function render(pane) {
    const runBtn = el('button', { type: 'button', class: 'vs-run', text: '▶ ' + T('run'), onclick: () => run() });
    const add = el('select', { 'aria-label': T('add'), onchange: () => { if (add.value) addNode(add.value); add.value = ''; } }, el('option', { value: '', text: '+ ' + T('add') }));
    for (const c of CATEGORIES) {
      const g = el('optgroup', { label: T('cat.' + c) });
      for (const t of NODE_TYPES.filter((x) => x.cat === c)) g.append(el('option', { value: t.type, text: nodeName(t.type) }));
      add.append(g);
    }
    const auto = el('input', { type: 'checkbox', checked: S.auto, onchange: () => { S.auto = auto.checked; api.storage.set('auto', S.auto); if (S.auto) run(); } });
    const replace = el('input', { type: 'checkbox', checked: S.replace, onchange: () => { S.replace = replace.checked; api.storage.set('replace', S.replace); } });
    const file = el('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      try { setGraph(G.cleanGraph(JSON.parse(await f.text()), types)); } catch (e) { say(T('status.badfile')); }
    } });
    const big = el('button', { type: 'button', text: S.big ? T('collapse') : T('expand'), onclick: () => { S.big = !S.big; E.root.classList.toggle('vs-big', S.big); big.textContent = S.big ? T('collapse') : T('expand'); drawLinks(); } });
    const bar = el('div', { class: 'vs-bar' }, runBtn,
      el('label', { title: T('auto.title') }, auto, T('auto')),
      el('label', { title: T('replace.title') }, replace, T('replace')),
      add,
      el('button', { type: 'button', text: T('example'), onclick: () => setGraph(G.cleanGraph(exampleGraph(), types)) }),
      el('button', { type: 'button', text: T('clear'), onclick: () => setGraph(G.newGraph()) }),
      el('button', { type: 'button', text: T('export'), onclick: exportGraph }),
      el('button', { type: 'button', text: T('import'), onclick: () => file.click() }), file, big);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'vs-links');
    const world = el('div', { class: 'vs-world' }, svg);
    const canvas = el('div', { class: 'vs-canvas' }, world);
    const status = el('div', { class: 'vs-status', 'aria-live': 'polite', text: T('status.hint') });
    const root = el('div', { class: 'vs-root' + (S.big ? ' vs-big' : '') }, bar, canvas, status);
    pane.append(root);
    E = { root, canvas, world, svg, status, run: runBtn, nodes: new Map() };
    api.onDeactivate(() => root.remove());
    panZoom(canvas);
    drawAll();
  }

  function setGraph(g) { graph = g; S.out = new Map(); S.errors = new Map(); save(); drawAll(); }
  function exportGraph() {
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'visual-script.json' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function addNode(type) {
    const def = types.get(type);
    if (!def) return;
    const r = E.canvas.getBoundingClientRect(), s = S.view.s;
    const id = G.nextId(graph);
    graph.nodes.push({ id, type, x: Math.round((r.width / 2 - S.view.x) / s - 90), y: Math.round((r.height / 3 - S.view.y) / s), v: {} });
    save();
    drawAll();
  }

  const view = () => { E.world.style.transform = `translate(${S.view.x}px, ${S.view.y}px) scale(${S.view.s})`; };
  function drawAll() {
    if (!E) return;
    for (const b of E.nodes.values()) b.remove();
    E.nodes.clear();
    for (const n of graph.nodes) { const b = nodeBox(n); E.world.append(b); E.nodes.set(n.id, b); paintNode(n.id); }
    view();
    drawLinks();
  }

  function nodeBox(n) {
    const def = types.get(n.type);
    const box = el('div', { class: 'vs-node vs-cat-' + def.cat, 'data-id': n.id });
    box.style.left = n.x + 'px'; box.style.top = n.y + 'px';
    const head = el('div', { class: 'vs-head' }, el('span', { text: nodeName(n.type), title: n.type }),
      el('button', { type: 'button', text: '×', title: T('delete'), 'aria-label': T('delete'), onclick: () => { G.removeNode(graph, n.id); changed(); drawAll(); } }));
    dragNode(head, n, box);
    box.append(head);
    for (const inp of def.inputs) {
      const wired = graph.links.some((l) => l.to === n.id && l.in === inp.key);
      const row = el('div', { class: 'vs-row vs-in' });
      if (inp.wire !== false) {
        const port = el('span', { class: 'vs-port' + (wired ? ' vs-wired' : ''), 'data-in': inp.key, title: T('port.in') });
        port.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (wired) { G.disconnect(graph, n.id, inp.key); changed(); drawAll(); } });
        row.append(port);
      }
      row.append(el('label', { text: portName(inp.key) }));
      if (!wired) row.append(editor(n, inp));
      box.append(row);
    }
    for (const o of def.outputs) {
      const port = el('span', { class: 'vs-port', 'data-out': o.key, title: T('port.out') });
      port.addEventListener('pointerdown', (e) => { e.stopPropagation(); startWire(e, n, o.key, port); });
      box.append(el('div', { class: 'vs-row vs-out' }, el('label', { text: portName(o.key) }), port));
    }
    box.append(el('div', { class: 'vs-val' }));
    return box;
  }

  /** The control for an unwired input: what it holds is kept in node.v. */
  function editor(n, inp) {
    const cur = Object.prototype.hasOwnProperty.call(n.v, inp.key) ? n.v[inp.key] : inp.default;
    const set = (v) => { n.v[inp.key] = v; changed(); };
    const stop = (e) => e.stopPropagation();
    if (inp.kind === 'number' && inp.slider) {
      const num = el('input', { type: 'number', value: cur, step: n.v.step ?? 'any' });
      const range = el('input', { type: 'range', min: n.v.min ?? 0, max: n.v.max ?? 10000, step: n.v.step ?? 1, value: cur });
      range.addEventListener('input', () => { num.value = range.value; set(Number(range.value)); });
      num.addEventListener('change', () => { if (Number.isFinite(Number(num.value))) { range.value = num.value; set(Number(num.value)); } });
      for (const x of [num, range]) x.addEventListener('pointerdown', stop);
      return el('span', { style: 'display:flex;flex-direction:column;gap:.1rem;margin-left:auto;min-width:7rem' }, range, num);
    }
    if (inp.kind === 'number') {
      const x = el('input', { type: 'number', value: cur, step: 'any' });
      x.addEventListener('change', () => { if (x.value !== '' && Number.isFinite(Number(x.value))) { set(Number(x.value)); if (['min', 'max', 'step'].includes(inp.key)) drawAll(); } });
      x.addEventListener('pointerdown', stop);
      return x;
    }
    if (inp.kind === 'text') {
      const x = el('input', { type: 'text', value: cur ?? '', placeholder: inp.key === 'level' ? T('level.default') : '' });
      x.addEventListener('change', () => set(x.value));
      x.addEventListener('pointerdown', stop);
      return x;
    }
    if (inp.kind === 'bool') {
      const x = el('input', { type: 'checkbox', checked: !!cur });
      x.addEventListener('change', () => set(x.checked));
      return x;
    }
    if (inp.kind === 'choice') {
      const x = el('select', {});
      for (const c of choicesOf(inp)) x.append(el('option', { value: c, text: tOr('choice.' + c, c), selected: c === cur }));
      x.addEventListener('change', () => set(x.value));
      x.addEventListener('pointerdown', stop);
      return x;
    }
    return el('span', { class: 'vs-hint', text: Array.isArray(cur) && cur.length ? short(cur) : T('wire.me') });
  }

  // ------------------------------------------------------------------ pointer work
  const toWorld = (cx, cy) => { const r = E.canvas.getBoundingClientRect(); return [(cx - r.left - S.view.x) / S.view.s, (cy - r.top - S.view.y) / S.view.s]; };
  const portAt = (p) => { const r = p.getBoundingClientRect(); return toWorld(r.left + r.width / 2, r.top + r.height / 2); };
  const curve = (a, b) => { const dx = Math.max(40, Math.abs(b[0] - a[0]) / 2); return `M${a[0]},${a[1]} C${a[0] + dx},${a[1]} ${b[0] - dx},${b[1]} ${b[0]},${b[1]}`; };

  function drawLinks() {
    if (!E) return;
    const paths = [];
    for (const l of graph.links) {
      const a = E.nodes.get(l.from)?.querySelector(`[data-out="${l.out}"]`), b = E.nodes.get(l.to)?.querySelector(`[data-in="${l.in}"]`);
      if (!a || !b) continue;
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', curve(portAt(a), portAt(b)));
      paths.push(p);
    }
    E.svg.replaceChildren(...paths);
  }

  function dragNode(head, n, box) {
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.stopPropagation();
      const x0 = e.clientX, y0 = e.clientY, nx = n.x, ny = n.y;
      const move = (m) => { n.x = Math.round(nx + (m.clientX - x0) / S.view.s); n.y = Math.round(ny + (m.clientY - y0) / S.view.s); box.style.left = n.x + 'px'; box.style.top = n.y + 'px'; drawLinks(); };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); save(); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  function startWire(e, n, outKey, port) {
    const from = portAt(port);
    const temp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    temp.setAttribute('class', 'vs-temp');
    E.svg.append(temp);
    const move = (m) => temp.setAttribute('d', curve(from, toWorld(m.clientX, m.clientY)));
    const up = (u) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      temp.remove();
      const hit = document.elementFromPoint(u.clientX, u.clientY)?.closest?.('[data-in]');
      const to = hit?.closest('.vs-node')?.dataset.id;
      if (!hit || !to) return;
      if (!G.connect(graph, n.id, outKey, to, hit.dataset.in)) { say(T('status.loop')); return; }
      changed();
      drawAll();
    };
    move(e);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function panZoom(canvas) {
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.vs-node')) return;
      const x0 = e.clientX, y0 = e.clientY, vx = S.view.x, vy = S.view.y;
      canvas.classList.add('vs-panning');
      const move = (m) => { S.view.x = vx + m.clientX - x0; S.view.y = vy + m.clientY - y0; view(); };
      const up = () => { canvas.classList.remove('vs-panning'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      const s = Math.min(2, Math.max(0.3, S.view.s * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      S.view.x = px - ((px - S.view.x) * s) / S.view.s; S.view.y = py - ((py - S.view.y) * s) / S.view.s; S.view.s = s;
      view();
      drawLinks();
    }, { passive: false });
  }

  api.ui.panelTab({ id: 'graph', title: T('tab'), render: (pane) => { E = null; render(pane); } });
  api.commands.add('run', () => run(), { label: T('run') });
  return () => { E = null; };
}
