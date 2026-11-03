/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-gi.js — the real-time view's indirect light on the GPU and its bake in the background (0.7 RT.2, session `realtime`).
 * Canonical in modelcraft/dev/rt/ (tools/rt/sync.mjs). The maths is rt-probes.js; the path tracing runs in compute's pool
 * (rt-probe-job.js), so the view stays live while it bakes.
 *
 *   createGI(THREE, TSL, renderer, res) → gi = {light, set({min, max, sh}), clear(), dispose()}
 *     light = a three Light the scene carries; its node (registered once per renderer) samples three RGBA half-float 3D
 *     textures (rt-probes.js packTextures) at the shaded point, half a cell along its normal, and adds the probes' irradiance
 *     minus the sky's to the lighting (so materials need nothing of their own). The textures exist from the start (zeros = no
 *     change), so a finished bake only uploads data: no shader is rebuilt. Two things three 0.186 needs here, both found by the
 *     browser test: the node's uniforms live in renderGroup (as three's own light nodes), and set() uploads the texels itself.
 *   bakeProbes(plain, settings, preset, {pool, signal, onProgress}) → Promise<{min, max, res, sh (n·12, sky taken out), ms}>
 *     packs the scene for the tracer (render/pt-pack.js, at the probe panorama's size), one header per probe, shares the scene once
 *     with the pool and bakes runs of probes as `batch` jobs (live view work goes first). Imported textures are their average
 *     colour here (the tracer gets no decoded images in the background).
 */
import { probeGrid, probeCamera, panoramaDirs, skyL1, packTextures } from './rt-probes.js';
import { skyFor } from './rt-look.js';

const registered = new WeakSet();
let classes = null;

function makeClasses(THREE, TSL) {
  const { texture3D, uniform, positionWorld, normalWorld, vec3, vec4, renderGroup } = TSL;
  class GiProbes extends THREE.Light {
    constructor() {
      super(0xffffff, 1);
      this.isGiProbes = true;
      this.type = 'GiProbes';
      this.textures = null;
      this.min = new THREE.Vector3(-1, -1, -1);
      this.max = new THREE.Vector3(1, 1, 1);
      this.res = new THREE.Vector3(2, 2, 2);
    }
  }
  class GiProbesNode extends THREE.AnalyticLightNode {
    static get type() { return 'GiProbesNode'; }
    constructor(light = null) {
      super(light);
      // renderGroup, as three's own light nodes: values set in update() reach the shader every render
      const u = (v) => uniform(v).setGroup(renderGroup);
      this._min = u(new THREE.Vector3()); this._max = u(new THREE.Vector3()); this._res = u(new THREE.Vector3()); this._k = u(1);
      this._inv = u(new THREE.Matrix4());   // world → the light's own space (the probes' space: the model's, under any rig)
    }
    update(frame) {
      super.update(frame);
      const L = this.light;
      this._min.value.copy(L.min); this._max.value.copy(L.max); this._res.value.copy(L.res); this._k.value = L.intensity;
      L.updateWorldMatrix(true, false);
      this._inv.value.copy(L.matrixWorld).invert();
    }
    setup(builder) {
      const L = this.light;
      if (!L.textures) return;
      const min = this._min, max = this._max, res = this._res;
      const range = max.sub(min), rm1 = res.sub(1);
      // the shaded point and its normal in the light's own space (identity when the light sits at the scene's root)
      const pl = this._inv.mul(vec4(positionWorld, 1)).xyz, n = this._inv.mul(vec4(normalWorld, 0)).xyz.normalize();
      const p = pl.add(n.mul(range.div(rm1)).mul(0.5));
      const uvw = p.sub(min).div(range).clamp(0, 1).mul(rm1).div(res).add(vec3(0.5).div(res));
      const tx = (i) => texture3D(L.textures[i], uvw);
      const a = tx(0), b = tx(1), c = tx(2);
      const c0 = a.xyz, c1 = vec3(a.w, b.x, b.y), c2 = vec3(b.z, b.w, c.x), c3 = c.yzw;
      const E = c0.mul(0.886227).add(c1.mul(n.y).add(c2.mul(n.z)).add(c3.mul(n.x)).mul(1.023328));
      builder.context.irradiance.addAssign(E.mul(this._k));
    }
  }
  return { GiProbes, GiProbesNode };
}

export function createGI(THREE, TSL, renderer, res) {
  classes = classes || makeClasses(THREE, TSL);
  if (!registered.has(renderer)) { renderer.library.addLight(classes.GiProbesNode, classes.GiProbes); registered.add(renderer); }
  const light = new classes.GiProbes();
  const n = res[0] * res[1] * res[2];
  const half = (f32) => { const u = new Uint16Array(f32.length); for (let i = 0; i < f32.length; i++) u[i] = THREE.DataUtils.toHalfFloat(f32[i]); return u; };
  const make = (data) => {
    const t = new THREE.Data3DTexture(data, res[0], res[1], res[2]);
    t.format = THREE.RGBAFormat; t.type = THREE.HalfFloatType;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    return t;
  };
  light.textures = [0, 1, 2].map(() => make(new Uint16Array(n * 4)));
  // new texels, uploaded now: a texture read inside a light node is bound but never re-uploaded by its binding in three 0.186
  // (the upload would wait for some other use of the texture), so set() pushes it to the GPU itself
  const upload = (datas) => light.textures.forEach((t, i) => { t.image.data = datas[i]; t.needsUpdate = true; renderer.initTexture(t); });
  light.res.set(res[0], res[1], res[2]);
  const gi = {
    light,
    data: null,   // the last probes set ({min, max, res, sh}): the standalone viewer's file carries them (RT.4)
    set({ min, max, sh }) {
      gi.data = { min: [...min], max: [...max], res: [...res], sh: Float32Array.from(sh) };
      upload(packTextures(sh, res).map(half));
      light.min.set(min[0], min[1], min[2]); light.max.set(max[0], max[1], max[2]);
    },
    // the light stays in the scene (a light that appears later would rebuild every material): off = zeros
    clear() { gi.data = null; upload([0, 1, 2].map(() => new Uint16Array(n * 4))); },
    dispose() { for (const t of light.textures) t.dispose(); },
  };
  return gi;
}

export async function bakeProbes(plain, settings, preset, { pool, signal = null, onProgress = null } = {}) {
  const t0 = performance.now();
  // the path tracer's modules, loaded only when a bake runs (the standalone viewer carries baked probes and never loads them)
  const [{ packScene, setCamera }, { shareable }, { blueNoise }] = await Promise.all([import('../render/pt-pack.js'), import('../render/pt-ref-job.js'), import('../render/pt-sampler.js')]);
  const s = { ...(settings || {}), quality: 'draft', denoise: false, elements: false, lightMix: false, adaptive: { on: false }, projection: 'equirect' };
  const [w, h] = preset.probePx;
  const pk = packScene(plain, s, { w, h });
  const up = plain.up || [0, 0, 1];
  const grid = probeGrid(plain.bounds, up, plain.groundAt || 0, preset.probes);
  const headers = new Uint32Array(grid.n * 128);
  for (let i = 0; i < grid.n; i++) {
    const p = [grid.positions[i * 3], grid.positions[i * 3 + 1], grid.positions[i * 3 + 2]];
    headers.set(new Uint32Array(setCamera(pk, probeCamera(p), s)), i * 128);
  }
  const dirs = panoramaDirs(headers.subarray(0, 128), w, h);
  for (const [name, data] of Object.entries(shareable(pk, blueNoise()))) await pool.share(name, data);
  const job = new URL('./rt-probe-job.js', import.meta.url).href;
  const workers = (pool.stats && pool.stats().size) || 4;
  const per = Math.max(1, Math.ceil(grid.n / (workers * 2)));   // two runs per worker: the last ones finish together
  const sh = new Float32Array(grid.n * 12);
  let done = 0;
  const runs = [];
  for (let a = 0; a < grid.n; a += per) {
    const k = Math.min(per, grid.n - a);
    runs.push(pool.run(job, 'bakeProbes', { headers: headers.slice(a * 128, (a + k) * 128), w, h, spp: preset.probeSpp, dirs }, { priority: 0, signal, units: k * w * h * preset.probeSpp })
      .then((out) => { sh.set(out, a * 12); done += k; onProgress?.(done / grid.n); }));
  }
  await Promise.all(runs);
  const { sky, envK } = skyFor(plain, settings);
  const sk = skyL1(sky, up, envK);
  for (let i = 0; i < grid.n; i++) for (let k = 0; k < 12; k++) sh[i * 12 + k] -= sk[k];
  return { min: grid.min, max: grid.max, res: grid.res, sh, ms: Math.round(performance.now() - t0) };
}
