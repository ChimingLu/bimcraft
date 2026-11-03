/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-renderer.js — the real-time renderer: one canvas, the apps' plain scene, the real-time look (0.7 RT.2, session
 * `realtime`). Canonical in modelcraft/dev/rt/ (tools/rt/sync.mjs). The live view (RT.3), panoramas and the standalone viewer
 * (RT.4) and VR (RT.6) all draw through this.
 *
 *   const rt = await createRealtime({canvas, facts?, tier?, quality?, backend?, pool?})
 *     facts = compute/probe.js facts (probed here when missing); tier = TIER_DEFAULTS key (from the probe, `?tier=` wins);
 *     quality = 'low' | 'medium' | 'high' (Settings; default the tier's); backend = 'webgpu' | 'webgl2' (`?rt=`; default
 *     chooseBackend); effects = {ao, ssr, bloom, aa} switches over the preset. pool = compute's page pool for the probe bake (none = no indirect light, the sky only).
 *   rt.info → {backend, tier, preset, clustered}   clustered: lamps sorted into screen tiles (WebGPU, > CLUSTER_FROM lamps)
 *   await rt.setScene(plain, settings)     build (or rebuild) from the plain scene; starts a probe bake in the background
 *   rt.setCamera(spec)                     spec = plain.camera(aspect) or any {world, proj}
 *   rt.setSun(dir) · rt.setMatrices(list) · rt.setDisplay(settings) · await rt.setScatter(list, library)   live changes (no rebuild)
 *   rt.resize(w, h, dpr?)                  CSS pixels; the preset caps the pixel ratio
 *   await rt.render()                      one frame (TAA converges over frames: call it while the view moves, then a few more)
 *   rt.gi → {state: 'none' | 'baking' | 'ready' | 'failed', progress, ms}   rt.onGi = (gi) => …
 *   await rt.readPixels() → {w, h, data: Uint8Array RGBA}   one more frame, read back (tests, thumbnails)
 *   await rt.panorama({position, forward, faceSize, frames}) → {blob, w, h, frame}   a 360° equirectangular PNG (RT.4)
 *   rt.dispose()
 */
import { chooseBackend, backendFromQuery, createRenderer } from './rt-backend.js';
import { presetFor, displayParams } from './rt-look.js';
import { buildScene } from './rt-scene.js';
import { createPipeline } from './rt-post.js';
import { createGI, bakeProbes } from './rt-gi.js';
import { probeCached, tierOf, tierFromQuery } from '../compute/probe.js';

export const CLUSTER_FROM = 16;   // lamps above which the WebGPU view clusters them

export async function createRealtime({ canvas, facts = null, tier = null, quality = null, effects = null, backend = null, pool = null, search = (globalThis.location && location.search) || '' } = {}) {
  facts = facts || await probeCached(globalThis);
  const t = tier || tierOf(facts, tierFromQuery(search)).tier;
  const preset = Object.freeze({ ...presetFor(t, quality), ...(effects || {}) });   // effects: Settings' own switches (ao, ssr, bloom, aa)
  const chosen = backend || chooseBackend(facts, { override: backendFromQuery(search) }).backend;
  if (!chosen) throw Object.assign(new Error('no WebGPU or WebGL 2'), { code: 'no_gpu' });
  const { renderer, backend: got, THREE } = await createRenderer({ canvas, backend: chosen });
  const TSL = await import('three/tsl');
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  let built = null, post = null, gi = null, settings = {}, size = { w: canvas.width || 1, h: canvas.height || 1, dpr: 1 };
  let bakeAbort = null, giState = { state: 'none', progress: 0, ms: 0 }, plainNow = null, clustered = false;
  const self = {
    info: { backend: got, tier: t, preset },
    THREE, renderer,
    get gi() { return giState; },
    get giProbes() { return gi; },   // the probe light's controller (rt-gi.js createGI): tests and tools set it directly
    onGi: null,
    get scene() { return built && built.scene; },
    get camera() { return built && built.camera; },
    async setScene(plain, s = {}) {
      settings = s;
      plainNow = plain;
      const cam = built && built.camera ? built.camera : null;
      post?.dispose(); post = null;
      built?.dispose();
      // many lamps: three's clustered (Forward+) lighting on WebGPU (a compute pass sorts point lamps into screen tiles);
      // a few lamps, or WebGL 2, light every pixel with every lamp as usual
      const lamps = (plain.lights || []).filter((L) => L && L.on !== false && L.lumens > 0).length;
      const wantClustered = !!preset.clustered && got === 'webgpu' && lamps > CLUSTER_FROM;
      if (wantClustered !== clustered) {
        if (wantClustered) { const { ClusteredLighting } = await import('three-webgpu/addons/lighting/ClusteredLighting.js'); renderer.lighting = new ClusteredLighting(preset.maxLamps); }
        else renderer.lighting = new THREE.Lighting();
        clustered = wantClustered;
      }
      self.info.clustered = clustered;
      built = await buildScene(THREE, plain, s, preset, { backend: got, renderer, TSL });
      gi = gi || createGI(THREE, TSL, renderer, preset.probes);
      built.scene.add(gi.light);
      gi.clear();
      renderer.localClippingEnabled = !!(plain.clip && plain.clip.length);
      if (cam) built.setCamera({ world: cam.matrixWorld.elements.slice(), proj: cam.projectionMatrix.elements.slice() });
      else built.setCamera(plain.camera(size.w / size.h));
      await rebuildPost();
      startBake();
    },
    setCamera(spec) {
      if (!built) return;
      const before = built.camera;
      built.setCamera(spec);
      if (built.camera !== before) rebuildPost();   // perspective ↔ parallel: the passes hold the camera
    },
    setSun(dir) { built?.setSun(dir); },
    async setScatter(list, library) { if (built) await built.setScatter(list, library); },
    setMatrices(list) { built?.setMatrices(list); },
    setDisplay(s) { settings = { ...settings, ...s }; post?.setDisplay(displayParams(settings)); },
    resize(w, h, dpr = globalThis.devicePixelRatio || 1) {
      size = { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), dpr: Math.min(dpr, preset.pixelRatio) };
      renderer.setPixelRatio(size.dpr);
      renderer.setSize(size.w, size.h, false);
      const c = built && built.camera;
      if (c && c.isPerspectiveCamera) { c.aspect = size.w / size.h; c.updateProjectionMatrix(); }
    },
    async render() { if (!post) return; built.beforeRender(); await post.render(); },
    async readPixels() {
      // one more frame into a target of the canvas's size (a WebGPU canvas keeps nothing once presented), rows from the top
      const w = canvas.width, h = canvas.height;
      const target = new THREE.RenderTarget(w, h);
      renderer.setRenderTarget(target);
      if (post) { built.beforeRender(); post.render(); }
      const raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, w, h);
      renderer.setRenderTarget(null);
      target.dispose();
      const data = new Uint8Array(w * h * 4), row = w * 4;
      const flip = got !== 'webgpu';   // WebGL reads rows from the bottom
      for (let y = 0; y < h; y++) data.set(raw.subarray((flip ? h - 1 - y : y) * row, (flip ? h - 1 - y : y) * row + row), y * row);
      return { w, h, data };
    },
    /**
     * RT.4: a 360° panorama from `position` (rt-pano.js): six square views of faceSize pixels (each drawn `frames` times so TAA
     * and AO settle), one equirectangular picture 4 × 2 faces wide → {blob (PNG), w, h, frame}. The view's camera and size come back.
     */
    async panorama({ position, forward, faceSize = 512, frames = 4 }) {
      if (!built) throw new Error('no scene');   // i18n-ignore: a developer error (the Share menu shows its own words)
      const { panoFrame, faceCameras, cubeToEquirect } = await import('./rt-pano.js');
      const fr = panoFrame(forward, built.bounds.up);
      const cam = built.camera, keep = { world: cam.matrixWorld.elements.slice(), proj: cam.projectionMatrix.elements.slice() }, was = { ...size };
      const n = Math.max(16, Math.round(faceSize));
      self.resize(n, n, 1);
      const faces = [];
      try {
        for (const c of faceCameras(position, fr)) {
          self.setCamera(c);
          let px = null;
          for (let i = 0; i < Math.max(1, frames); i++) px = await self.readPixels();
          faces.push({ n, data: px.data });
        }
      } finally {
        self.resize(was.w, was.h, was.dpr);
        self.setCamera(keep);
      }
      const W = 4 * n, H = 2 * n, img = cubeToEquirect(faces, fr, W, H);
      const oc = new OffscreenCanvas(W, H);
      oc.getContext('2d').putImageData(new ImageData(img, W, H), 0, 0);
      return { blob: await oc.convertToBlob({ type: 'image/png' }), w: W, h: H, frame: fr };   // i18n-ignore: a media type
    },
    dispose() { bakeAbort?.abort(); post?.dispose(); built?.dispose(); gi?.dispose(); renderer.dispose(); },
  };
  async function rebuildPost() {
    post?.dispose();
    post = await createPipeline(THREE, TSL, renderer, built.scene, built.camera, preset, displayParams(settings));
  }
  function startBake() {
    bakeAbort?.abort();
    if (!pool || !plainNow || !(plainNow.items && plainNow.items.length)) return;
    const ac = new AbortController();
    bakeAbort = ac;
    giState = { state: 'baking', progress: 0, ms: 0 };
    self.onGi?.(giState);
    bakeProbes(plainNow, settings, preset, { pool, signal: ac.signal, onProgress: (f) => { giState = { ...giState, progress: f }; self.onGi?.(giState); } })
      .then((r) => { if (ac.signal.aborted) return; gi.set(r); giState = { state: 'ready', progress: 1, ms: r.ms }; self.onGi?.(giState); })
      .catch((e) => { if (ac.signal.aborted) return; giState = { state: 'failed', progress: 0, ms: 0, error: String(e && e.message || e) }; self.onGi?.(giState); });
  }
  return self;
}
