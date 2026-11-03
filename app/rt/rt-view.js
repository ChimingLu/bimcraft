/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-view.js — the live view: the model in the real-time look beside the app's own view, following it as you edit
 * (0.7 RT.3, session `realtime`). Canonical in modelcraft/dev/rt/ (tools/rt/sync.mjs). Each app hands it an adapter
 * (rt-mc.js, rt-bim.js) and its own `t()`; strings are `rt.*` keys (copied into BimCraft's language files by the sync).
 *
 *   openLiveView(adapter, {t, parent, pool, window: bool}) → view   a floating panel over the app (drag its title bar, pull its
 *     corner), or with window: true a separate browser window (a second screen); a blocked pop-up falls back to the panel
 *   view.close() · view.rt (rt-renderer.js, once started) · view.walking · view.walker · view.builds (scene rebuilds so far) · view.el
 *   · view.scatter (rt-scatter-ui.js panel, when the adapter has `scatter`: ModelCraft)
 *   (the element carries the view as el.rtView)
 *
 *   adapter = { app, up: [x, y, z],
 *     scene(settings) → plain scene (render/render-core.js),  camera(aspect) → {world, proj} (the app's view now),
 *     key() → string (changes when what the view shows changes: edits, visibility),  camKey() → string (the view's camera),
 *     settings() → the app's render settings,  sunBase() → {month, day, hour},  sun({month, day, hour}) → [x, y, z] | null }
 *
 * The view draws only when something changed (an edit, the camera, the sun) and then a few frames more while TAA settles, or
 * every frame while walking. Edits rebuild the scene after a quarter second of quiet and bake the bounce light again in the
 * background. Walk: W A S D or arrows, Shift runs, a drag looks round, Q / E up and down with gravity off; Esc stops.
 */
import { createRealtime } from './rt-renderer.js';
import { walkScene, createWalker } from './rt-walk.js';
import { QUALITY } from './rt-look.js';
import { createScatterPanel } from './rt-scatter-ui.js';
import { createShareMenu } from './rt-present.js';

const CSS = `
.rt-live { position: fixed; right: 1rem; bottom: 3rem; width: 30rem; height: 20rem; min-width: 16rem; min-height: 11rem; z-index: 60;
  display: flex; flex-direction: column; background: var(--sheet, #fbfaf7); color: var(--ink, #1d232b); border: 1px solid var(--line, #8a8f96);
  resize: both; overflow: hidden; font: 0.8125rem/1.3 system-ui, sans-serif; }
.rt-live.rt-win { position: static; width: 100vw; height: 100vh; border: 0; resize: none; }
.rt-live-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.5rem; padding: 0.25rem 0.5rem; border-bottom: 1px solid var(--line, #8a8f96); cursor: move; user-select: none; }
.rt-win .rt-live-bar { cursor: default; }
.rt-live-bar h2 { font-size: inherit; font-weight: 700; margin: 0 auto 0 0; }
.rt-live-bar label { display: inline-flex; align-items: center; gap: 0.25rem; cursor: default; }
.rt-live-bar input[type=range] { width: 6rem; }
.rt-live-bar button, .rt-live-bar select { font: inherit; padding: 0.125rem 0.375rem; }
.rt-live-bar button[aria-pressed=true] { background: var(--action, #1d4f91); color: var(--on-action, #fff); }
.rt-live-stage { position: relative; flex: 1; min-height: 0; background: #000; }
.rt-live-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; outline: none; }
.rt-live-status { padding: 0.125rem 0.5rem; border-top: 1px solid var(--line, #8a8f96); color: var(--ink-2, #4a525c); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rt-live-msg { position: absolute; inset: 0; display: grid; place-items: center; color: #fff; padding: 1rem; text-align: center; }
.rt-live-body { display: flex; flex: 1; min-height: 0; }
.rt-live-body > .rt-live-stage { flex: 1; }
.rt-scatter { width: 16rem; flex: none; overflow: auto; padding: 0.375rem 0.5rem; border-right: 1px solid var(--line, #8a8f96); }
.rt-scatter[hidden] { display: none; }
.rt-scatter label, .rt-scatter-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.375rem; margin: 0.25rem 0; }
.rt-scatter-field > span:first-child { flex: 0 0 6.5rem; }
.rt-scatter input[type=number] { width: 4.5rem; font: inherit; }
.rt-scatter input[type=text], .rt-scatter select { font: inherit; max-width: 100%; }
.rt-scatter button { font: inherit; padding: 0.125rem 0.375rem; }
.rt-scatter button[aria-pressed=true] { background: var(--action, #1d4f91); color: var(--on-action, #fff); }
.rt-scatter-items { max-height: 9rem; overflow: auto; border: 1px solid var(--line, #8a8f96); padding: 0 0.25rem; }
.rt-scatter-item { margin: 0.125rem 0; }
.rt-scatter-item span { flex: 1; }
.rt-scatter-item input[type=number] { width: 3rem; }
.rt-scatter-sub, .rt-scatter-msg { margin: 0.25rem 0; color: var(--ink-2, #4a525c); }
.rt-share { position: relative; }
.rt-share > summary { cursor: pointer; padding: 0.125rem 0.375rem; border: 1px solid var(--line, #8a8f96); list-style: none; }
.rt-share-list { position: absolute; right: 0; top: 100%; z-index: 2; display: flex; flex-direction: column; gap: 0.25rem; min-width: 13rem; padding: 0.375rem;
  background: var(--sheet, #fbfaf7); border: 1px solid var(--line, #8a8f96); }
.rt-share-list button { font: inherit; text-align: left; padding: 0.125rem 0.375rem; }
.rt-share-spots { margin: 0 0 0 1.25rem; padding: 0; }
.rt-share-spots li { display: flex; justify-content: space-between; gap: 0.25rem; }
`;

const KEYMAP = { w: 'forward', arrowup: 'forward', s: 'back', arrowdown: 'back', a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right', e: 'up', pageup: 'up', q: 'down', pagedown: 'down', shift: 'run' };
const SETTLE_FRAMES = 8;   // TAA frames after a change

function addCss(doc) {
  if (doc.getElementById('rt-live-css')) return;
  const s = doc.createElement('style');
  s.id = 'rt-live-css';
  s.textContent = CSS;
  doc.head.append(s);
}

export async function openLiveView(adapter, { t, parent = document.body, pool = null, window: own = false } = {}) {
  let win = null;
  if (own) {
    win = globalThis.open('', 'cadcraft-live-' + adapter.app, 'popup,width=1100,height=680');
    if (win) {
      win.document.open();
      win.document.write('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title></title></head><body style="margin:0"></body></html>');
      win.document.close();
      win.document.title = t('rt.window.title');
      for (const a of ['data-space', 'lang']) { const v = document.documentElement.getAttribute(a); if (v) win.document.documentElement.setAttribute(a, v); }
    }
  }
  const doc = win ? win.document : document;
  const W = win || globalThis;
  addCss(doc);
  const h = (tag, props = {}, ...kids) => { const e = doc.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'text') e.textContent = v; else if (k in e && k !== 'list') e[k] = v; else e.setAttribute(k, v); } e.append(...kids.filter(Boolean)); return e; };

  // ---- the panel ----
  const base = adapter.sunBase();
  const follow = h('input', { type: 'checkbox', checked: true });
  const walkBtn = h('button', { type: 'button', text: t('rt.walk'), title: t('rt.walk.title') });
  walkBtn.setAttribute('aria-pressed', 'false');
  const gravity = h('input', { type: 'checkbox', checked: true });
  const hour = h('input', { type: 'range', min: '5', max: '21', step: '0.25', value: String(base.hour ?? 15) });
  const month = h('input', { type: 'range', min: '1', max: '12', step: '1', value: String(base.month || 6) });
  const quality = h('select', {}, h('option', { value: '', text: t('rt.quality.auto') }), ...QUALITY.map((q) => h('option', { value: q, text: t('rt.quality.' + q) })));
  const popBtn = win ? null : h('button', { type: 'button', text: t('rt.window'), title: t('rt.window.tip') });
  const scatterBtn = adapter.scatter ? h('button', { type: 'button', text: t('rt.scatter'), title: t('rt.scatter.title') }) : null;
  scatterBtn?.setAttribute('aria-pressed', 'false');
  const closeBtn = h('button', { type: 'button', text: t('rt.close') });
  const stage = h('div', { className: 'rt-live-stage' });
  const canvas = h('canvas', { tabIndex: 0 });
  canvas.setAttribute('aria-label', t('rt.canvas'));
  stage.append(canvas);
  const status = h('div', { className: 'rt-live-status' });
  status.setAttribute('role', 'status');
  const hourOut = h('output', { text: '' }), monthOut = h('output', { text: '' });
  const bar = h('div', { className: 'rt-live-bar' },
    h('h2', { text: t('rt.title') }),
    h('label', {}, follow, h('span', { text: t('rt.follow') })),
    walkBtn,
    h('label', { title: t('rt.gravity.title') }, gravity, h('span', { text: t('rt.gravity') })),
    h('label', {}, h('span', { text: t('rt.hour') }), hour, hourOut),
    h('label', {}, h('span', { text: t('rt.month') }), month, monthOut),
    h('label', {}, h('span', { text: t('rt.quality') }), quality),
    scatterBtn, null, popBtn, closeBtn);
  const body = h('div', { className: 'rt-live-body' }, stage);
  // RT.4: Share (panorama, tour, standalone viewer, video), when the app can save files
  const share = adapter.download ? createShareMenu({ h, t, adapter, ctx: {
    rt: () => rt, plain: () => plain, settings: () => ({ ...(adapter.settings() || {}), sun: sunNow() }),
    eye: () => (walker ? { p: walker.eye, forward: walker.forward() } : { p: rt.camera.position.toArray(), forward: rt.camera.getWorldDirection(new rt.THREE.Vector3()).toArray() }),
    rebuild: () => rebuild(), busy: (text) => message(text),
    hold: (on) => { held = Math.max(0, held + (on ? 1 : -1)); if (!held) { dirty = true; loop(); } },
  } }) : null;
  if (share) bar.insertBefore(share.el, popBtn || closeBtn);
  const el = h('section', { className: 'rt-live' + (win ? ' rt-win' : '') }, bar, body, status);
  el.setAttribute('aria-label', t('rt.title'));
  (win ? doc.body : parent).append(el);

  const view = { el, rt: null, walking: false, closed: false, window: win, builds: 0, close, get walker() { return walker; }, get scatter() { return panel; }, share };
  el.rtView = view;   // tests and tools reach the view through its element
  let held = 0;   // > 0 while a Share runs (ctx.hold)
  let rt = null, plain = null, frames = 0, dirty = true, keyNow = null, camNow = null, rebuildAt = 0, walker = null, raf = 0, lastT = 0, msg = null, panel = null;
  const keysDown = new Set();
  const sunNow = () => ({ month: Number(month.value), day: 21, hour: Number(hour.value) });
  const fmtHour = (x) => { const hh = Math.floor(x), mm = Math.round((x - hh) * 60); return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0'); };
  const monthName = new Intl.DateTimeFormat(document.documentElement.lang || undefined, { month: 'short' });
  const showSun = () => { hourOut.textContent = fmtHour(Number(hour.value)); monthOut.textContent = monthName.format(new Date(2026, Number(month.value) - 1, 15)); };
  showSun();
  const say = (text) => { status.textContent = text; };
  const message = (text) => { msg?.remove(); msg = text ? h('div', { className: 'rt-live-msg', text }) : null; if (msg) stage.append(msg); };
  const describe = () => {
    if (!rt) return;
    const g = rt.gi, i = rt.info;
    const gi = g.state === 'baking' ? t('rt.gi.baking', { pct: Math.round(g.progress * 100) }) : g.state === 'ready' ? t('rt.gi.ready', { s: (g.ms / 1000).toFixed(1) }) : g.state === 'failed' ? t('rt.gi.failed') : t('rt.gi.none');
    say(t('rt.status', { backend: t('rt.backend.' + i.backend), quality: t('rt.quality.' + i.preset.quality) }) + ' · ' + gi + (view.walking ? ' · ' + t('rt.walk.keys') : ''));   // i18n-ignore: a separator
  };

  // ---- start (and restart for another quality) ----
  async function start() {
    rt?.dispose();
    rt = null;
    message(t('rt.starting'));
    const opts = { canvas, quality: quality.value || null, pool };
    try {
      try { rt = await createRealtime(opts); } catch (e) {
        if (!win || (e && e.code === 'no_gpu')) throw e;
        rt = await createRealtime({ ...opts, backend: 'webgl2' });   // a window of its own may refuse WebGPU: WebGL 2 there
      }
    } catch (e) {
      message(e && e.code === 'no_gpu' ? t('rt.none') : t('rt.failed', { error: String((e && e.message) || e) }));
      return;
    }
    if (view.closed) { rt.dispose(); return; }
    view.rt = rt;
    rt.onGi = () => { describe(); dirty = true; };
    if (adapter.scatter && !panel) {
      // RT.5: the Scatter panel beside the canvas (the tier's instance budget comes with the renderer's preset)
      let busy = null, again = false;
      const onScatter = async () => {
        if (busy) { again = true; return; }
        busy = (async () => { do { again = false; if (rt && plain) { await rt.setScatter(panel.lists(plain), adapter.scatter.library()); dirty = true; } } while (again); })();
        await busy; busy = null;
      };
      panel = createScatterPanel({ h, t, adapter, preset: rt.info.preset, view, onScatter });
      panel.el.hidden = true;
      body.prepend(panel.el);
      scatterBtn.addEventListener('click', () => { panel.el.hidden = !panel.el.hidden; scatterBtn.setAttribute('aria-pressed', String(!panel.el.hidden)); resize(); if (!panel.el.hidden) panel.fill(); });
    }
    resize();
    try { await rebuild(); } catch (e) { message(t('rt.failed', { error: String((e && e.message) || e) })); return; }
    message(null);
    describe();
    loop();
  }
  async function rebuild() {
    if (!rt) return;
    plain?.dispose?.();
    plain = adapter.scene({ ...(adapter.settings() || {}), sun: sunNow() });
    plain.sun = adapter.sun(sunNow());
    if (panel) { plain.scatter = panel.lists(plain); plain.scatterLibrary = adapter.scatter.library(); }
    keyNow = adapter.key();
    await rt.setScene(plain, { ...(adapter.settings() || {}), sun: sunNow() });
    view.builds++;
    if (walker) startWalk(walker.eye, walker.forward());   // the model changed under the walker: new collisions, same place
    else rt.setCamera(adapter.camera(aspect()));
    dirty = true;
  }
  const aspect = () => Math.max(1e-3, canvas.clientWidth / Math.max(1, canvas.clientHeight));
  function resize() {
    if (!rt) return;
    rt.resize(canvas.clientWidth || 1, canvas.clientHeight || 1, W.devicePixelRatio || 1);
    if (walker) rt.setCamera(walker.camera(aspect())); else rt.setCamera(adapter.camera(aspect()));
    dirty = true;
  }
  const ro = new W.ResizeObserver(() => resize());
  ro.observe(stage);

  // ---- walking ----
  function startWalk(eye = null, forward = null) {
    const cam = adapter.camera(aspect());
    const from = eye || [cam.world[12], cam.world[13], cam.world[14]];
    const fwd = forward || [-cam.world[8], -cam.world[9], -cam.world[10]];
    walker = createWalker(walkScene(plain), { up: plain.up || adapter.up, eye: from, forward: fwd, opts: { gravity: gravity.checked } });
    view.walking = true;
    walkBtn.setAttribute('aria-pressed', 'true');
    follow.checked = false;
    rt.setCamera(walker.camera(aspect()));
    canvas.focus({ preventScroll: true });
    dirty = true;
    describe();
  }
  function stopWalk() {
    walker = null; view.walking = false; keysDown.clear();
    walkBtn.setAttribute('aria-pressed', 'false');
    describe();
  }
  walkBtn.addEventListener('click', () => { if (view.walking) stopWalk(); else if (rt && plain) startWalk(); });
  gravity.addEventListener('change', () => { if (walker) startWalk(walker.eye, walker.forward()); });
  canvas.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && view.walking) { stopWalk(); e.preventDefault(); return; }
    const k = KEYMAP[e.key.toLowerCase()];
    if (!k || !view.walking) return;
    keysDown.add(k);
    if (k !== 'run') e.preventDefault();
    dirty = true;
  });
  canvas.addEventListener('keyup', (e) => { const k = KEYMAP[e.key.toLowerCase()]; if (k) keysDown.delete(k); });
  W.addEventListener('blur', () => keysDown.clear());
  let drag = null;
  /** The world ray under a pointer event (painting scatter). */
  const rayAt = (e) => {
    const r = canvas.getBoundingClientRect(), T = rt.THREE, cam = rt.camera;
    const x = ((e.clientX - r.left) / r.width) * 2 - 1, y = 1 - ((e.clientY - r.top) / r.height) * 2;
    const o = new T.Vector3(x, y, -1).unproject(cam), f = new T.Vector3(x, y, 1).unproject(cam), d = f.sub(o).normalize();
    return { o: o.toArray(), d: d.toArray() };
  };
  const paint = (kind, e) => {
    if (!panel || !panel.painting || !rt || !plain) return false;
    panel.pointer(kind, e, rayAt(e), plain);
    dirty = true;
    return true;
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus({ preventScroll: true });
    if (paint('down', e)) { canvas.setPointerCapture(e.pointerId); return; }
    if (!view.walking) return;
    drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (paint('move', e)) return;
    if (!drag || !walker) return;
    walker.look(e.clientX - drag.x, e.clientY - drag.y);
    drag = { x: e.clientX, y: e.clientY };
    rt.setCamera(walker.camera(aspect()));
    dirty = true;
  });
  canvas.addEventListener('pointerup', (e) => { paint('up', e); drag = null; });

  // ---- sun, quality, follow ----
  const sunInput = () => { showSun(); if (rt) { rt.setSun(adapter.sun(sunNow())); dirty = true; } };
  hour.addEventListener('input', sunInput);
  month.addEventListener('input', sunInput);
  quality.addEventListener('change', () => start());
  follow.addEventListener('change', () => { if (follow.checked) { stopWalk(); camNow = null; dirty = true; } });

  // ---- moving the panel by its title bar ----
  if (!win) {
    let mv = null;
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, select, label')) return;   // i18n-ignore: a CSS selector
      const r = el.getBoundingClientRect();
      mv = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!mv) return;
      el.style.left = Math.max(0, e.clientX - mv.dx) + 'px'; el.style.top = Math.max(0, e.clientY - mv.dy) + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
    });
    bar.addEventListener('pointerup', () => { mv = null; });
    popBtn.addEventListener('click', async () => { close(); await openLiveView(adapter, { t, parent, pool, window: true }); });
  }
  closeBtn.addEventListener('click', () => close());
  if (win) win.addEventListener('pagehide', () => close());

  // ---- the loop: draw when something changed ----
  function loop() {
    if (view.closed || raf) return;
    raf = W.requestAnimationFrame(async (time) => {
      raf = 0;
      if (view.closed || !rt) return;
      if (held) { lastT = time; loop(); return; }   // a share is drawing with the renderer (rt-present.js run): no rebuild, camera or frame now
      const dt = Math.min(0.05, lastT ? (time - lastT) / 1000 : 0.016);
      lastT = time;
      // what the app shows changed: rebuild after a quarter second of quiet
      const k = adapter.key();
      if (k !== keyNow) { keyNow = k; rebuildAt = time + 250; }
      if (rebuildAt && time >= rebuildAt) {
        rebuildAt = 0;
        try { await rebuild(); message(null); } catch (e) { message(t('rt.failed', { error: String((e && e.message) || e) })); }
      }
      if (walker) {
        if (walker.step(dt, keysDown)) { rt.setCamera(walker.camera(aspect())); dirty = true; }
      } else if (follow.checked) {
        const ck = adapter.camKey();
        if (ck !== camNow) { camNow = ck; rt.setCamera(adapter.camera(aspect())); dirty = true; }
      }
      if (dirty) { frames = SETTLE_FRAMES; dirty = false; }
      if (frames > 0) { frames--; await rt.render(); }
      loop();
    });
  }
  function close() {
    if (view.closed) return;
    view.closed = true;
    if (raf) W.cancelAnimationFrame(raf);
    ro.disconnect();
    rt?.dispose();
    plain?.dispose?.();
    el.remove();
    if (win && !win.closed) win.close();
  }
  start();
  return view;
}
