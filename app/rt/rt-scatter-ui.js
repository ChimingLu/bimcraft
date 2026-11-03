/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-scatter-ui.js — the live view's Scatter panel (0.7 RT.5, session `realtime`): scatter sets made from the faces selected in
 * the app (fill) or painted with a brush in the live view, their items and controls, kept in the app's file through the adapter.
 * Canonical in modelcraft/dev/rt/ (tools/rt/sync.mjs). Mounted by rt-view.js when the adapter has `scatter` (ModelCraft).
 *
 *   createScatterPanel({h, t, adapter, preset, view, onScatter}) → panel
 *     panel.el                    the panel (rt-view puts it beside the canvas, shown by the bar's Scatter button)
 *     panel.lists(plain) → [{result, slugs}]   every set's instances for this scene (cached per set and target; the tier's
 *                                 budget shared in order: the first set gets what it asks for, the next what is left)
 *     panel.pointer(kind, e, ray) → bool    the canvas's pointer events while painting (ray = {o, d} in world); true = used
 *     panel.painting               a brush or the eraser is on (rt-view stops following / walking input then)
 *     panel.status()               "n placed of m" for the bar
 *   onScatter() — called after a set changed (rt-view hands the new lists to rt.setScatter)
 */
import { scatter, cleanScatter, SCATTER_DEFAULTS } from './rt-scatter.js';
import { buildScene, sceneHit } from '../compute/bvh-scene.js';
import { basis } from '../render/looks.js';

const tris12 = (t9) => {   // world triangles (9 floats) → RENDER-SPEC § 6.2 records (12 floats: v0, e1, e2)
  const n = t9.length / 9, out = new Float32Array(n * 12);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    out[i * 12 + k] = t9[i * 9 + k]; out[i * 12 + 4 + k] = t9[i * 9 + 3 + k] - t9[i * 9 + k]; out[i * 12 + 8 + k] = t9[i * 9 + 6 + k] - t9[i * 9 + k];
  }
  return out;
};

export function createScatterPanel({ h, t, adapter, preset, view, onScatter }) {
  const S = adapter.scatter;
  const lib = S.library();
  let ext = S.sets() || [];   // the app's list as last seen: another file opened brings another list
  let sets = ext.map((x, i) => cleanScatter(x, i));
  let cur = sets.length ? 0 : -1;
  const cache = new Map();   // set id → {key, result, slugs}
  let modelKey = '', brush = null, lastDab = null, radius = 1.5, placed = 0, asked = 0;

  const sel = h('select', {});
  const btnNew = h('button', { type: 'button', text: t('rt.scatter.new'), title: t('rt.scatter.new.title') });
  const btnPaint = h('button', { type: 'button', text: t('rt.scatter.newpaint'), title: t('rt.scatter.newpaint.title') });
  const btnRemove = h('button', { type: 'button', text: t('rt.scatter.remove') });
  const msg = h('p', { className: 'rt-scatter-msg' });
  msg.setAttribute('role', 'status');
  const body = h('div', { className: 'rt-scatter-body' });
  const el = h('div', { className: 'rt-scatter', hidden: true },
    h('div', { className: 'rt-scatter-head' }, h('label', {}, h('span', { text: t('rt.scatter.set') }), sel)),
    h('div', { className: 'rt-scatter-row' }, btnNew, btnPaint, btnRemove), msg, body);

  const save = () => { ext = sets.map((x) => ({ ...x })); S.save(ext); };
  // a new, painted or removed set rebuilds the form; a field's change only saves and redraws (its own input stays where it is)
  const changed = () => { save(); onScatter(); fill(); };
  const listSets = () => {
    sel.replaceChildren(...sets.map((x, i) => h('option', { value: String(i), text: x.name || t('rt.scatter.unnamed', { n: i + 1 }) })));
    sel.value = String(cur);
    btnRemove.disabled = cur < 0;
  };
  sel.addEventListener('change', () => { cur = Number(sel.value); brush = null; fill(); });
  btnNew.addEventListener('click', () => {
    const target = S.selection();
    if (!target) { msg.textContent = t('rt.scatter.noselection'); return; }
    sets.push(cleanScatter({ ...SCATTER_DEFAULTS, id: 's' + Date.now().toString(36), name: t('rt.scatter.unnamed', { n: sets.length + 1 }), target, mode: 'fill', seed: (sets.length * 7919 + 1) % 100000 }, sets.length));
    cur = sets.length - 1;
    listSets(); changed();
  });
  btnPaint.addEventListener('click', () => {
    const target = S.selection();   // painting over selected faces only, else over anything
    sets.push(cleanScatter({ ...SCATTER_DEFAULTS, id: 's' + Date.now().toString(36), name: t('rt.scatter.unnamed', { n: sets.length + 1 }), target, mode: 'paint', strokes: [], seed: (sets.length * 7919 + 1) % 100000 }, sets.length));
    cur = sets.length - 1;
    brush = 'paint';
    listSets(); changed();
  });
  btnRemove.addEventListener('click', () => {
    if (cur < 0) return;
    cache.delete(sets[cur].id);
    sets.splice(cur, 1);
    cur = Math.min(cur, sets.length - 1);
    brush = null;
    listSets(); changed();
  });

  // ---- the current set's controls ----
  const field = (label, input) => h('label', { className: 'rt-scatter-field' }, h('span', { text: label }), input);
  const numIn = (v, step, min, max) => h('input', { type: 'number', value: v === null ? '' : String(v), step: String(step), min: String(min), max: String(max) });
  function fill() {
    listSets();
    const s = sets[cur];
    if (!s) { body.replaceChildren(h('p', { text: t('rt.scatter.none') })); return; }
    const set = (patch) => { sets[cur] = cleanScatter({ ...sets[cur], ...patch }, cur); save(); onScatter(); if ('name' in patch) listSets(); };
    const name = h('input', { type: 'text', value: s.name, maxLength: 80 });
    name.addEventListener('change', () => set({ name: name.value }));
    // items: every library item, ticked with a weight
    const items = h('div', { className: 'rt-scatter-items' });
    for (const e of lib) {
      const on = s.items.find((x) => x.slug === e.slug);
      const cb = h('input', { type: 'checkbox', checked: !!on });
      const w = numIn(on ? on.weight : 1, 1, 0, 100);
      w.disabled = !on;
      const upd = () => {
        const next = s.items.filter((x) => x.slug !== e.slug);
        if (cb.checked) next.push({ slug: e.slug, weight: Number(w.value) || 1 });
        if (!next.length) { cb.checked = true; return; }   // a set keeps at least one item
        set({ items: next });
      };
      cb.addEventListener('change', upd); w.addEventListener('change', upd);
      items.append(h('label', { className: 'rt-scatter-item' }, cb, h('span', { text: S.itemName(e.slug, t) }), w));
    }
    const nums = [
      ['density', t('rt.scatter.density'), 0.1, 0.001, 400], ['clearance', t('rt.scatter.clearance'), 0.1, 0, 100],
      ['rotate', t('rt.scatter.rotate'), 15, 0, 360], ['slope', t('rt.scatter.slope'), 5, 0, 90],
    ].map(([k, label, step, min, max]) => { const i = numIn(s[k], step, min, max); i.addEventListener('change', () => set({ [k]: Number(i.value) })); return field(label, i); });
    const s0 = numIn(s.scale[0], 0.1, 0.05, 20), s1 = numIn(s.scale[1], 0.1, 0.05, 20);
    const scaleUpd = () => set({ scale: [Number(s0.value), Number(s1.value)] });
    s0.addEventListener('change', scaleUpd); s1.addEventListener('change', scaleUpd);
    const h0 = numIn(s.height[0], 0.5, -1e6, 1e6), h1 = numIn(s.height[1], 0.5, -1e6, 1e6);
    const hUpd = () => set({ height: [h0.value === '' ? null : Number(h0.value), h1.value === '' ? null : Number(h1.value)] });
    h0.addEventListener('change', hUpd); h1.addEventListener('change', hUpd);
    const tilt = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(s.tilt) });
    tilt.addEventListener('change', () => set({ tilt: Number(tilt.value) }));
    const seed = numIn(s.seed, 1, 0, 2 ** 31);
    seed.addEventListener('change', () => set({ seed: Number(seed.value) }));
    const reseed = h('button', { type: 'button', text: t('rt.scatter.reseed') });
    reseed.addEventListener('click', () => set({ seed: Math.floor(Math.random() * 1e6) }));
    const rows = [field(t('rt.scatter.name'), name), h('p', { className: 'rt-scatter-sub', text: t('rt.scatter.items') }), items, ...nums,
      field(t('rt.scatter.scale'), h('span', {}, s0, s1)), field(t('rt.scatter.height'), h('span', {}, h0, h1)), field(t('rt.scatter.tilt'), tilt),
      field(t('rt.scatter.seed'), h('span', {}, seed, reseed))];
    if (s.mode === 'paint') {
      const bBrush = h('button', { type: 'button', text: t('rt.scatter.brush') }), bErase = h('button', { type: 'button', text: t('rt.scatter.erase') });
      bBrush.setAttribute('aria-pressed', String(brush === 'paint')); bErase.setAttribute('aria-pressed', String(brush === 'erase'));
      bBrush.addEventListener('click', () => { brush = brush === 'paint' ? null : 'paint'; fill(); });
      bErase.addEventListener('click', () => { brush = brush === 'erase' ? null : 'erase'; fill(); });
      const rad = h('input', { type: 'range', min: '0.25', max: '10', step: '0.25', value: String(radius) });
      rad.addEventListener('input', () => { radius = Number(rad.value); });
      rows.push(h('div', { className: 'rt-scatter-row' }, bBrush, bErase), field(t('rt.scatter.radius'), rad), h('p', { className: 'rt-scatter-sub', text: t('rt.scatter.painthelp') }));
    } else rows.push(h('button', { type: 'button', text: t('rt.scatter.retarget'), onclick: () => { const tg = S.selection(); if (tg) set({ target: tg }); else msg.textContent = t('rt.scatter.noselection'); } }));
    body.replaceChildren(...rows);
    msg.textContent = t('rt.scatter.count', { placed, asked });
  }

  // ---- making the instances ----
  function lists(plain) {
    if ((S.sets() || []) !== ext) { ext = S.sets() || []; sets = ext.map((x, i) => cleanScatter(x, i)); cur = sets.length ? 0 : -1; brush = null; cache.clear(); fill(); }
    modelKey = adapter.key();
    let left = preset.instances;
    placed = 0; asked = 0;
    const slugs = lib.map((e) => e.slug);
    const out = [];
    let obstacles = null;
    for (const s of sets) {
      const k = JSON.stringify(s) + '|' + modelKey + '|' + left;
      let c = cache.get(s.id);
      if (!c || c.key !== k) {
        const tris = s.target ? S.tris(s.target) : null;
        if (s.mode === 'fill' && !tris) { cache.set(s.id, { key: k, result: null }); continue; }
        let bvh = null, boxes = null;
        if (s.clearance > 0 || (s.mode === 'paint' && !tris)) {
          obstacles = obstacles || S.obstacles(s.target);
          if (obstacles.tris.length) { bvh = buildScene({ meshes: [{ tris: tris12(obstacles.tris) }], instances: null }); boxes = obstacles.boxes; }
        }
        c = { key: k, result: scatter(s, { tris, up: plain.up || adapter.up, bvh, boxes, budget: left, slugs }), slugs };
        cache.set(s.id, c);
      }
      if (!c.result) continue;
      left -= c.result.count;
      placed += c.result.count; asked += c.result.wanted;
      out.push({ result: c.result, slugs: c.slugs });
    }
    if (!el.hidden) msg.textContent = t('rt.scatter.count', { placed, asked });
    return out;
  }

  // ---- painting in the live view ----
  let paintBvh = null, paintKey = '';
  function pointer(kind, e, ray, plain) {
    const s = sets[cur];
    if (!brush || !s || s.mode !== 'paint') return false;
    if (kind === 'up') { lastDab = null; return true; }
    if (kind === 'move' && !(e.buttons & 1)) return true;
    if (paintKey !== modelKey || !paintBvh) {
      const tg = s.target ? S.tris(s.target) : null;
      const ob = tg ? null : S.obstacles(null);
      const t9 = tg || (ob && ob.tris);
      // painting over nothing selected: onto any surface, the ground included (a square of 20 km at groundAt, square to up)
      const up = basis(plain.up || adapter.up).up, { e1, e2 } = basis(up), g = plain.groundAt || 0, R = 1e4;
      const q = (a, b) => [e1[0] * a + e2[0] * b + up[0] * g, e1[1] * a + e2[1] * b + up[1] * g, e1[2] * a + e2[2] * b + up[2] * g];
      const ground = new Float64Array([q(-R, -R), q(R, -R), q(R, R), q(-R, -R), q(R, R), q(-R, R)].flat());
      const all = s.target && t9 ? t9 : new Float64Array([...(t9 || []), ...ground]);
      paintBvh = buildScene({ meshes: [{ tris: tris12(all) }], instances: null });
      paintKey = modelKey;
    }
    const hit = sceneHit(paintBvh, ray.o, ray.d, 1e6);
    if (!hit) return true;
    const p = [ray.o[0] + ray.d[0] * hit.t, ray.o[1] + ray.d[1] * hit.t, ray.o[2] + ray.d[2] * hit.t];
    if (brush === 'paint') {
      if (lastDab && Math.hypot(p[0] - lastDab[0], p[1] - lastDab[1], p[2] - lastDab[2]) < radius * 0.5) return true;
      lastDab = p;
      sets[cur] = cleanScatter({ ...s, strokes: [...s.strokes, [p[0], p[1], p[2], radius]] }, cur);
    } else {
      const keep = s.strokes.filter((d) => Math.hypot(d[0] - p[0], d[1] - p[1], d[2] - p[2]) > radius);
      if (keep.length === s.strokes.length) return true;
      sets[cur] = cleanScatter({ ...s, strokes: keep }, cur);
    }
    save(); onScatter();
    msg.textContent = t('rt.scatter.count', { placed, asked });
    return true;
  }

  fill();
  return {
    el, lists, pointer, fill,
    get painting() { return !!brush && !!sets[cur] && sets[cur].mode === 'paint'; },
    get sets() { return sets; },
    status: () => t('rt.scatter.count', { placed, asked }),
    view,
  };
}
