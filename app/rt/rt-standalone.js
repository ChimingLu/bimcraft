/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-standalone.js — the standalone viewer: what an exported viewer file runs (0.7 RT.4, session `realtime`). Canonical in
 * modelcraft/dev/rt/ (tools/rt/sync.mjs); rt-export.js packs it, with the modules it needs and the scene, into one HTML file.
 * Nothing here talks to a server: no account, no tracking, no fonts or libraries from elsewhere (the file's Content-Security-Policy
 * forbids any request), so it opens from a folder, a USB stick or an email in any browser with WebGPU or WebGL 2.
 *
 *   start(scene, {root}) → viewer   scene = rt-export.js exportScene() output (format 'cadcraft-live-scene' 1)
 *     the real-time renderer (rt-renderer.js) with the scene's materials worked out already and its bounce light baked already;
 *     orbit (drag), pan (right drag or Shift), zoom (wheel, pinch); the saved views; Walk (W A S D, Shift runs, drag looks, Esc)
 *   plainFromScene(THREE, scene) → the apps' plain scene again (geometry, matrices, materials, lamps, scatter)
 */
import { createRealtime } from './rt-renderer.js';
import { walkScene, createWalker } from './rt-walk.js';

const b64 = (s, T) => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new T(u.buffer); };

export function plainFromScene(THREE, sc) {
  const geos = sc.geometries.map((g) => {
    const G = new THREE.BufferGeometry();
    G.setAttribute('position', new THREE.BufferAttribute(b64(g.position, Float32Array), 3));
    if (g.normal) G.setAttribute('normal', new THREE.BufferAttribute(b64(g.normal, Float32Array), 3));
    if (g.uv) G.setAttribute('uv', new THREE.BufferAttribute(b64(g.uv, Float32Array), 2));
    if (g.index) G.setIndex(new THREE.BufferAttribute(b64(g.index, Uint32Array), 1));
    return G;
  });
  const start = sc.start;
  return {
    items: sc.items.map((it) => ({ geometry: geos[it.g], matrix: it.m, look: it.look, lines: !!it.lines })),
    defaultColor: sc.defaultColor || '#e6e3dc', up: sc.up, bounds: sc.bounds, groundAt: sc.groundAt, sun: sc.sun, clip: sc.clip || [],
    lights: sc.lights || [], images: {}, resolved: sc.resolved,
    scatter: (sc.scatter || []).map((x) => ({ result: { count: x.count, matrices: b64(x.matrices, Float32Array), item: b64(x.item, Uint16Array), wanted: x.count }, slugs: x.slugs })),
    scatterLibrary: (sc.scatterLibrary || []).map((e) => ({ slug: e.slug, parts: e.parts.map((p) => ({ color: p.color, alpha: p.alpha, P: Array.from(b64(p.P, Float32Array)), I: Array.from(b64(p.I, Uint32Array)) })) })),
    camera: () => start,
    dispose() { for (const g of geos) g.dispose(); },
  };
}

/** Orbit / pan / zoom about a target, as a camera spec (world, proj). */
function orbiter(start, up, fovDeg) {
  const W = start.world, eye = [W[12], W[13], W[14]], back = [W[8], W[9], W[10]];
  const U = up;
  let dist = 10, target = [eye[0] - back[0] * dist, eye[1] - back[1] * dist, eye[2] - back[2] * dist];
  // yaw / pitch of the view direction about up
  const ax = Math.abs(U[2]) > 0.5 ? [1, 0, 0] : [0, 0, 1];
  const e1 = norm(cross(U, cross(ax, U))), e2 = cross(U, e1);
  const fwd = back.map((x) => -x);
  let yaw = Math.atan2(dot(fwd, e2), dot(fwd, e1)), pitch = Math.asin(Math.max(-1, Math.min(1, dot(fwd, U))));
  return {
    set(spec, d = null) { const w = spec.world; const f = [-w[8], -w[9], -w[10]]; if (d) dist = d; target = [w[12] + f[0] * dist, w[13] + f[1] * dist, w[14] + f[2] * dist]; yaw = Math.atan2(dot(f, e2), dot(f, e1)); pitch = Math.asin(Math.max(-1, Math.min(1, dot(f, U)))); },
    turn(dx, dy) { yaw -= dx * 0.006; pitch = Math.max(-1.5, Math.min(1.5, pitch - dy * 0.006)); },
    pan(dx, dy) { const f = this.fwd(), r = norm(cross(f, U)), u = cross(r, f), k = dist * 0.0015; for (let i = 0; i < 3; i++) target[i] += -r[i] * dx * k + u[i] * dy * k; },
    zoom(f) { dist = Math.max(0.2, Math.min(1e5, dist * f)); },
    fwd() { return [0, 1, 2].map((i) => Math.cos(pitch) * (Math.cos(yaw) * e1[i] + Math.sin(yaw) * e2[i]) + Math.sin(pitch) * U[i]); },
    spec(aspect) {
      const f = this.fwd(), r = norm(cross(f, U)), u = cross(r, f), e = [target[0] - f[0] * dist, target[1] - f[1] * dist, target[2] - f[2] * dist];
      const t = 1 / Math.tan((fovDeg * Math.PI) / 360), n = Math.max(0.02, dist / 2000), fr = Math.max(1000, dist * 200);
      return { world: [...r, 0, ...u, 0, -f[0], -f[1], -f[2], 0, ...e, 1], proj: [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (fr + n) / (n - fr), -1, 0, 0, (2 * fr * n) / (n - fr), 0] };
    },
  };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

export async function start(sc, { root = document.body } = {}) {
  const words = sc.words || {};
  const w = (k) => words[k] || k;
  const h = (tag, props = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'text') e.textContent = v; else e[k] = v; } e.append(...kids.filter(Boolean)); return e; };
  const canvas = h('canvas', { tabIndex: 0 });
  canvas.setAttribute('aria-label', w('canvas'));
  const status = h('p', { className: 'st' });
  const walkBtn = h('button', { type: 'button', text: w('walk'), title: w('walkTitle') });
  walkBtn.setAttribute('aria-pressed', 'false');
  const views = h('span', { className: 'views' });
  root.append(canvas, h('div', { className: 'bar' }, h('h1', { text: sc.title || '' }), views, walkBtn), status);
  let rt;
  try { rt = await createRealtime({ canvas }); } catch (e) { status.textContent = w(e && e.code === 'no_gpu' ? 'noGpu' : 'failed'); throw e; }
  const THREE = rt.THREE;
  const plain = plainFromScene(THREE, sc);
  const aspect = () => Math.max(1e-3, canvas.clientWidth / Math.max(1, canvas.clientHeight));
  rt.resize(canvas.clientWidth || 1, canvas.clientHeight || 1);
  await rt.setScene(plain, sc.settings || {});
  if (sc.gi) rt.giProbes.set({ min: sc.gi.min, max: sc.gi.max, sh: b64(sc.gi.sh, Float32Array) });
  const orb = orbiter(sc.start, sc.up, 50);
  const R = sc.bounds ? Math.hypot(sc.bounds.max[0] - sc.bounds.min[0], sc.bounds.max[1] - sc.bounds.min[1], sc.bounds.max[2] - sc.bounds.min[2]) / 2 : 10;
  orb.set(sc.start, Math.max(1, R * 1.6));
  let walker = null, dirty = 8, last = 0;
  const keys = new Set();
  const cam = () => (walker ? walker.camera(aspect()) : orb.spec(aspect()));
  const show = () => { rt.setCamera(cam()); dirty = 8; };
  for (const v of sc.views || []) views.append(h('button', { type: 'button', text: v.name, onclick: () => { stopWalk(); orb.set(v, Math.max(1, R)); rt.setCamera(v); dirty = 8; } }));
  const stopWalk = () => { walker = null; walkBtn.setAttribute('aria-pressed', 'false'); status.textContent = w('hint'); };
  walkBtn.onclick = () => {
    if (walker) { stopWalk(); return; }
    const c = cam();
    walker = createWalker(walkScene(plain), { up: sc.up, eye: [c.world[12], c.world[13], c.world[14]], forward: [-c.world[8], -c.world[9], -c.world[10]] });
    walkBtn.setAttribute('aria-pressed', 'true'); status.textContent = w('walkKeys'); canvas.focus(); show();
  };
  const MAP = { w: 'forward', arrowup: 'forward', s: 'back', arrowdown: 'back', a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right', e: 'up', q: 'down', shift: 'run' };
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && walker) { stopWalk(); return; } const k = MAP[e.key.toLowerCase()]; if (k && walker) { keys.add(k); e.preventDefault(); } });
  addEventListener('keyup', (e) => { const k = MAP[e.key.toLowerCase()]; if (k) keys.delete(k); });
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (walker) walker.look(dx, dy); else if (drag.pan) orb.pan(dx, dy); else orb.turn(dx, dy);
    show();
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); if (!walker) { orb.zoom(Math.exp(e.deltaY * 0.001)); show(); } }, { passive: false });
  new ResizeObserver(() => { rt.resize(canvas.clientWidth || 1, canvas.clientHeight || 1); show(); }).observe(canvas);
  status.textContent = w('hint');
  show();
  const loop = async (t) => {
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0.016);
    last = t;
    if (walker && walker.step(dt, keys)) show();
    if (dirty > 0) { dirty--; await rt.render(); document.body.dataset.frames = String(Number(document.body.dataset.frames || 0) + 1); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  const viewer = { rt, plain, get walker() { return walker; } };
  globalThis.ccViewer = viewer;   // for tests
  return viewer;
}
