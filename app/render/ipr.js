/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ipr.js — the path tracer in the view, interactively (0.7 RN.11; RENDER-SPEC § 8). The WGSL tracer renders over the app's own
 * view, sample after sample; moving the camera starts the picture again from the next frame (only the header's camera words
 * change: the scene's buffers stay), an edit of the model or of a render setting packs the scene again. A region can be drawn so
 * only it renders; a click can pick the focus distance (depth of field). Needs WebGPU; without it says so and draws nothing.
 *
 *   const ipr = createIpr({ stage, scene(settings) → scene, camera(aspect) → {world, proj}, version() → number (the model's),
 *     cameraKey() → string, settings() → render settings, save?(settings), t, onStatus?(text) })
 *   ipr.start() → Promise<bool>   ipr.stop()   ipr.dispose()   ipr.scale = 0.25 … 1 (of the view's pixels)
 *   ipr.mode = 'view' | 'region' | 'focus'  (what a press on the view does)   ipr.clearRegion()
 *   ipr.state → {running, samples, w, h, region, error, restarts (camera / lens), rebuilds (packs)}
 *
 * The overlay is a canvas laid over `stage` (pointer events only in the region and focus modes). Samples stop at the quality's
 * count (looks.js QUALITY); the picture stays until something changes.
 */
import { QUALITY, cleanSettings } from './looks.js';
import { packScene, setCamera } from './pt-pack.js';
import { createGpuTracer, gpuAdapter } from './pt-gpu.js';
import { blueNoise } from './pt-sampler.js';
import { cameraStops, whiteBalance, cameraRay } from './pt-camera.js';
import { hdriFor, volumeFor } from './session.js';
import { sceneFromV2, sceneHit } from '../compute/bvh-scene.js';

const MAX_SIDE = 1280;
const frame = () => new Promise((res) => requestAnimationFrame(() => res()));

export function createIpr(o) {
  const canvas = document.createElement('canvas');
  canvas.className = 'cc-ipr';
  canvas.dataset.ipr = '';
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2';
  const ctx = canvas.getContext('2d');
  let active = false, loopP = null, tracer = null, pk = null, mask = null, restarts = 0, rebuilds = 0, denoised = 0;
  let lastVer = null, lastCam = null, lastSet = null, lastLens = null, lastLook = null, lastSize = '', region = null, mode = 'view', error = '';
  // what a settings change costs: the look only redraws, the lens restarts the picture, anything else packs the scene again
  const LOOK = ['exposure', 'exposureMode', 'shutter', 'iso', 'whiteBalance', 'post', 'mix', 'mixPresets', 'minutes', 'quality', 'size'];
  const LENS = ['dof', 'focus', 'fstop', 'blades', 'bladeRot', 'twoPoint'];
  const pick = (s, keys, keep) => JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => keys.includes(k) === keep)));
  const api = { scale: 0.5 };
  const status = (s) => o.onStatus?.(s);
  const settingsNow = () => {
    // the view's render: high quality, no extra layers (they would cost memory on every frame), sized by the view
    const s = cleanSettings({ ...o.settings(), mode: 'hq', elements: false, lightMix: false });
    return s;
  };
  const sizeNow = () => {
    const r = o.stage.getBoundingClientRect(), dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    let w = Math.max(16, Math.round(r.width * dpr * api.scale)), h = Math.max(16, Math.round(r.height * dpr * api.scale));
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    return { w: Math.max(16, Math.round(w * k)), h: Math.max(16, Math.round(h * k)) };
  };
  async function rebuild(settings, w, h) {
    tracer?.dispose(); tracer = null; pk = null;
    const scene = o.scene(settings);
    try {
      // imported textures decode through three.js (render-pt.js): loaded only when the scene has some
      const images = scene.items.some((it) => it.look && it.look.startsWith('img:')) ? await (await import('./render-pt.js')).imagePixels(scene) : null;
      pk = packScene(scene, { ...settings, caustics: false }, { w, h, images, hdri: hdriFor(settings), volumeData: volumeFor(settings) });   // (a camera move rewrites the header alone: caustics are for stills)
    } finally { scene.dispose?.(); }
    // a WebGPU adapter gives one device: a fresh one for every tracer
    tracer = await createGpuTracer(pk, { adapter: await gpuAdapter(), mask });
    canvas.width = w; canvas.height = h;
    if (region) tracer.region = region;
  }
  function draw(bytes) {
    if (region) {
      const [x0, y0, x1, y1] = region;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) if (x < x0 || y < y0 || x >= x1 || y >= y1) bytes[(y * canvas.width + x) * 4 + 3] = 0;
    }
    ctx.putImageData(new ImageData(bytes, canvas.width, canvas.height), 0, 0);
  }
  async function loop() {
    while (active) {
      try {
        const s = settingsNow(), { w, h } = sizeNow(), size = w + 'x' + h, ver = o.version(), ck = o.cameraKey();
        const sk = pick(s, [...LOOK, ...LENS], false), lk = pick(s, LENS, true), look = pick(s, LOOK, true);
        if (!tracer || ver !== lastVer || sk !== lastSet || size !== lastSize) {
          status(o.t('render.ipr.preparing'));
          await rebuild(s, w, h);
          rebuilds++;
          lastVer = ver; lastSet = sk; lastSize = size; lastCam = ck; lastLens = lk; lastLook = look;
          continue;
        }
        if (ck !== lastCam || lk !== lastLens) { tracer.restart(setCamera(pk, o.camera(w / h), s)); lastCam = ck; lastLens = lk; restarts++; }
        if (look !== lastLook && tracer.samples) { draw(await tracer.image(cameraStops(s), whiteBalance(s.whiteBalance), s.post)); lastLook = look; }
        const target = QUALITY[s.quality] || QUALITY.good;
        if (tracer.samples < target) {
          await tracer.run({ spp: 1 });
          if (!active) break;
          draw(await tracer.image(cameraStops(s), whiteBalance(s.whiteBalance), s.post));
          status(o.t(tracer.samples >= target ? 'render.ipr.done' : 'render.ipr.progress', { n: tracer.samples, of: target, w, h }));
          // RN.5: denoised at 8 samples and at the end (dropped if the view changed meanwhile)
          if (s.denoise && pk.auxStride >= 2 && (tracer.samples === Math.min(8, target) || tracer.samples === target)) {
            const mark = restarts + ':' + rebuilds;
            const L = { w, h, accum: await tracer.accum(), aux: await tracer.aux(), stride: pk.auxStride, nElements: pk.auxStride };
            const [{ denoiseLayers }, { post }] = await Promise.all([import('./denoise.js'), import('./pt-post.js')]);
            const d = await denoiseLayers(L).catch(() => null);
            if (d && active && mark === restarts + ':' + rebuilds && tracer) { draw(post(d.lin, w, h, s.post, { exposure: cameraStops(s), wb: whiteBalance(s.whiteBalance) })); denoised++; }
          }
        } else await frame();
      } catch (e) {
        error = String(e?.message || e);
        status(e?.code === 'aux_too_big' ? o.t('render.mix.too_big') : o.t('render.ipr.failed', { error }));
        active = false;
      }
    }
  }
  // region and focus: presses on the overlay (its own pixels → the tracer's)
  let drag = null;
  const pix = (ev) => { const r = canvas.getBoundingClientRect(); return [((ev.clientX - r.left) / r.width) * canvas.width, ((ev.clientY - r.top) / r.height) * canvas.height]; };
  canvas.addEventListener('pointerdown', (ev) => {
    if (mode === 'view' || !tracer) return;
    ev.preventDefault(); ev.stopPropagation();
    const [x, y] = pix(ev);
    if (mode === 'focus') { pickFocus(x, y); return; }
    drag = [x, y];
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointerup', (ev) => {
    if (!drag || mode !== 'region') return;
    const [x, y] = pix(ev), r = [Math.floor(Math.min(drag[0], x)), Math.floor(Math.min(drag[1], y)), Math.ceil(Math.max(drag[0], x)), Math.ceil(Math.max(drag[1], y))];
    drag = null;
    if (r[2] - r[0] < 4 || r[3] - r[1] < 4) return;
    region = r;
    if (tracer) { tracer.region = r; tracer.restart(); }
    api.mode = 'view';
  });
  function pickFocus(x, y) {
    // the ray through that pixel (the pack's own camera) → the distance it travels to the first surface
    const hu = new Uint32Array(pk.header), hf = new Float32Array(pk.header), ro = [0, 0, 0], rd = [0, 0, 0], hit = {};
    const lens = hf[87]; hf[87] = 0;   // a pinhole ray from the middle of the lens
    cameraRay(hf, hu, x, y, canvas.width, canvas.height, 0, 0, 0, 0, 0, ro, rd);
    hf[87] = lens;
    const sc = sceneFromV2({ records: new Uint32Array(pk.nodes.buffer, pk.nodes.byteOffset, pk.nodes.length), tris: pk.tris, header: { 3: hu[3], 62: hu[62], 63: hu[63] } });
    if (!sceneHit(sc, ro, rd, 1e30, hit) || !(hit.t > 0)) { status(o.t('render.ipr.focus.none')); return; }
    // the distance along the view direction (the focus plane is square to it)
    const fl = Math.hypot(hf[24], hf[25], hf[26]) || 1, along = -(rd[0] * hf[24] + rd[1] * hf[25] + rd[2] * hf[26]) / fl * hit.t;
    const s = { ...o.settings(), dof: true, focus: Math.round(along * 100) / 100 };
    o.save?.(cleanSettings(s));
    status(o.t('render.ipr.focus.set', { m: (Math.round(along * 100) / 100).toString() }));
    api.mode = 'view';
  }
  Object.defineProperty(api, 'mode', {
    get: () => mode,
    set: (m) => { mode = m === 'region' || m === 'focus' ? m : 'view'; canvas.style.pointerEvents = mode === 'view' ? 'none' : 'auto'; canvas.style.cursor = mode === 'view' ? '' : 'crosshair'; },
  });
  api.clearRegion = () => { region = null; if (tracer) { tracer.region = null; tracer.restart(); } };
  api.start = async () => {
    if (active) return true;
    if (!(await gpuAdapter())) { status(o.t('render.ipr.nogpu')); return false; }
    mask = mask || blueNoise();
    if (!canvas.parentNode) { if (getComputedStyle(o.stage).position === 'static') o.stage.style.position = 'relative'; o.stage.append(canvas); }
    active = true; error = '';
    loopP = loop();
    return true;
  };
  api.stop = async () => { active = false; await loopP; loopP = null; };
  api.dispose = async () => { await api.stop(); tracer?.dispose(); tracer = null; pk = null; canvas.remove(); };
  Object.defineProperty(api, 'state', { get: () => ({ running: active, samples: tracer ? tracer.samples : 0, w: canvas.width, h: canvas.height, region, error, restarts, rebuilds, denoised }) });
  return api;
}
