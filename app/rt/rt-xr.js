/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-xr.js — the real-time look in the headset (0.7 RT.6, session `realtime`): what the design review (xr/xr-session.js, 0.6
 * LC.19) draws with. Canonical in modelcraft/dev/rt/ (tools/rt/sync.mjs); xr-session.js imports it from both apps' copies, so
 * ModelCraft and BimCraft get it the same way.
 *
 * Drawn by three's WebGL renderer, the headset's proven path: with three 0.186's WebGPURenderer (WebGL 2 back end) in WebXR the
 * controllers stopped reporting new poses in the emulator after a few presses (log § RT.6), so the headset keeps the renderer
 * its controllers work with, and gets the live view's look from the same numbers:
 *   materials   MeshPhysicalMaterial from the same OpenPBR record (rt-look.js physicalParams; library textures and imported
 *               images as in the live view)
 *   sky         the same gradient as background and as image light (PMREM), up = Y (the headset's world)
 *   sun         the stills' sun (colour, strength: the tracer's units) with a shadow map fitted round the model
 *   lamps       as the live view makes them (lampCandela, a finite reach)
 *   scatter     instanced; the item itself near the head, a stand-in (an icosahedron per part) beyond, re-chosen on the CPU
 *   bounce      the probes the live view bakes (rt-gi.js bakeProbes, on compute's pool), as a light probe taken from the grid
 *               where the head is (moving through the model, the bounce light follows)
 *   look        tone mapped like the stills (ACES or AgX; filmic shows as ACES, standard as plain), at their exposure; MSAA
 * Screen effects (ambient occlusion, reflections, TAA, bloom) stay on the desktop: three does not draw them in a headset.
 *
 *   await xrLook({settings, pool, facts, tier}) → look
 *     look.renderer (three's WebGLRenderer), look.tier, look.preset
 *     await look.build(plain) → {objs, hits, mats, ground, sun: {color, intensity}, scene(scene), dispose()}   for xr-session.js
 *     look.frame(xrCamera)   before each frame: the scatter's near set and the bounce light follow the head
 */
import * as THREE from 'three';
import { presetFor, displayParams, physicalParams, skyFor } from './rt-look.js';
import { lampCandela } from '../render/looks.js';
import { itemGeometries } from './rt-instances.js';
import { bakeProbes } from './rt-gi.js';
import { sampleGrid, rotateL1 } from './rt-probes.js';
import { probeCached, tierOf } from '../compute/probe.js';

let helpers = null;
const load = () => helpers || (helpers = Promise.all([import('../render/pt-pack.js'), import('../render/materials.js'), import('../render/three-mats.js')])
  .then(([P, M, T]) => ({ materialRecord: P.materialRecord, libDef: M.material, libTextures: T.libTextures, imageTextureReady: T.imageTextureReady })));

/** The gradient sky (render/looks.js colours × k) on a dome, for the background and the image light: z = d·up. */
function skyDome(sky, up, k) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { zen: { value: new THREE.Color(sky.zenith).multiplyScalar(k) }, hor: { value: new THREE.Color(sky.horizon).multiplyScalar(k) }, gnd: { value: new THREE.Color(sky.ground).multiplyScalar(k) }, up: { value: new THREE.Vector3(...up) } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 zen; uniform vec3 hor; uniform vec3 gnd; uniform vec3 up; varying vec3 vDir;\n'
      + 'void main() { float z = dot(normalize(vDir), up); vec3 c = z >= 0.0 ? mix(hor, zen, pow(z, 0.6)) : mix(hor, gnd, pow(-z, 0.4)); gl_FragColor = vec4(c, 1.0); }',
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
  m.frustumCulled = false;
  return m;
}

/** Scatter for the classic renderer: per kind a far mesh of the instances beyond reach and a near mesh of those within, re-split on the CPU. */
function classicScatter(sets, library, preset) {
  const bySlug = new Map(library.map((e) => [e.slug, e]));
  const group = new THREE.Group();
  const kinds = [], per = new Map();
  for (const { result, slugs } of sets) for (let i = 0; i < result.count; i++) {
    const slug = slugs[result.item[i]];
    if (!bySlug.has(slug)) continue;
    if (!per.has(slug)) per.set(slug, []);
    per.get(slug).push(result.matrices.subarray(i * 16, i * 16 + 16));
  }
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
  for (const [slug, mats] of per) {
    const G = itemGeometries(THREE, bySlug.get(slug)), n = mats.length;
    const all = new Float32Array(n * 16);
    mats.forEach((m, i) => all.set(m, i * 16));
    const mk = (geo, cap, cast) => { const m = new THREE.InstancedMesh(geo, mat, Math.max(1, cap)); m.count = 0; m.frustumCulled = false; m.castShadow = cast; m.receiveShadow = true; group.add(m); return m; };
    kinds.push({ n, all, far: mk(G.far, n, false), near: G.near ? mk(G.near, Math.min(n, preset.lod.maxNear), true) : null, last: null, G });
  }
  const reach = preset.lod.near, inv = new THREE.Matrix4(), cp = new THREE.Vector3();
  return {
    group,
    update(head) {
      group.updateWorldMatrix(true, false);
      cp.copy(head).applyMatrix4(inv.copy(group.matrixWorld).invert());
      for (const k of kinds) {
        if (k.last && k.last.distanceTo(cp) < reach / 8) continue;
        k.last = cp.clone();
        let f = 0, nn = 0;
        const fa = k.far.instanceMatrix.array, na = k.near ? k.near.instanceMatrix.array : null, cap = k.near ? k.near.instanceMatrix.count : 0;
        for (let i = 0; i < k.n; i++) {
          const o = i * 16, dx = k.all[o + 12] - cp.x, dy = k.all[o + 13] - cp.y, dz = k.all[o + 14] - cp.z;
          if (na && nn < cap && dx * dx + dy * dy + dz * dz < reach * reach) { na.set(k.all.subarray(o, o + 16), nn * 16); nn++; }
          else { fa.set(k.all.subarray(o, o + 16), f * 16); f++; }
        }
        k.far.count = f; k.far.instanceMatrix.needsUpdate = true;
        if (k.near) { k.near.count = nn; k.near.instanceMatrix.needsUpdate = true; }
      }
    },
    counts: () => kinds.map((k) => ({ far: k.far.count, near: k.near ? k.near.count : 0 })),
    dispose() { for (const k of kinds) { k.far.dispose(); k.near?.dispose(); k.G.far.dispose(); k.G.near?.dispose(); k.G.glass?.dispose(); } mat.dispose(); },
  };
}

export async function xrLook({ settings = {}, pool = null, facts = null, tier = null } = {}) {
  facts = facts || await probeCached(globalThis);
  const t = tier || tierOf(facts).tier;
  const base = presetFor(t);
  const preset = Object.freeze({ ...base, shadow: Object.freeze({ cascades: 1, size: Math.min(2048, base.shadow.size) }), aa: 'msaa', ao: false, ssr: false, bloom: false, clustered: false });
  // the bounce light bakes on the page's pool (every core but one), as in the live view
  if (!pool) { try { pool = await (await import('../compute/runtime.js')).pagePool({}); } catch { pool = null; } }
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  const d = displayParams(settings);
  renderer.toneMapping = d.view === 'agx' ? THREE.AgXToneMapping : d.view === 'standard' ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = d.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const probe = new THREE.LightProbe();   // the bounce light where the head is (bands 0–1 of the grid, filled per frame)
  probe.intensity = 0;
  let gi = null, bake = null, scat = null, env = null, bg = null;
  const tmpV = new THREE.Vector3(), tmpM = new THREE.Matrix4(), tmpR = new THREE.Matrix3();

  async function build(plain) {
    const s = { ...settings };
    const H = await load();
    const mats = new Map();
    const col = (c) => new THREE.Color(c[0], c[1], c[2]);   // linear Rec.709 already
    const matFor = async (key) => {
      if (mats.has(key)) return mats.get(key);
      let tex = null, maps = null, image = null;
      if (key.startsWith('mat:') && H.libDef(key.slice(4))) { maps = H.libTextures(key.slice(4), 512); if (maps) tex = { layer: 0, scale: [1, 1], rough: true }; }
      else if (key.startsWith('img:') && plain.images && plain.images[key.slice(4)]) image = await H.imageTextureReady(plain.images[key.slice(4)]);
      const p = physicalParams(H.materialRecord(key, s, plain, image ? { layer: 0, scale: [1, 1], rough: false } : tex));
      const m = new THREE.MeshPhysicalMaterial({ color: col(p.color), metalness: p.metalness, roughness: p.roughness, ior: p.ior, specularIntensity: p.specularIntensity, specularColor: col(p.specularColor),
        clearcoat: p.clearcoat, clearcoatRoughness: p.clearcoatRoughness, sheen: p.sheen, sheenColor: col(p.sheenColor), sheenRoughness: p.sheenRoughness,
        iridescence: p.iridescence, iridescenceIOR: p.iridescenceIOR, iridescenceThicknessRange: [p.iridescenceThickness, p.iridescenceThickness], emissive: col(p.emissive), side: THREE.DoubleSide });
      if (p.transmission > 0 || p.opacity < 1) { m.transparent = true; m.opacity = Math.max(0.08, Math.min(p.opacity, 1 - p.transmission * 0.92)); m.depthWrite = false; }
      if (maps) { m.map = maps.map; m.roughnessMap = maps.bump; m.bumpMap = maps.bump; m.bumpScale = (H.libDef(key.slice(4)).bump || 0) * 1.5; }
      if (image) m.map = image;
      m.shadowSide = THREE.BackSide;
      mats.set(key, m);
      return m;
    };
    // the model: one InstancedMesh per (geometry, key) used more than once, else a Mesh (as the live view)
    const objs = [], hits = [], groups = new Map();
    for (const it of plain.items) {
      if (it.lines) continue;
      const k = it.look || 'default';
      let g = groups.get(it.geometry);
      if (!g) { g = new Map(); groups.set(it.geometry, g); }
      let l = g.get(k);
      if (!l) { l = []; g.set(k, l); }
      l.push(it);
    }
    const M = new THREE.Matrix4();
    for (const [geometry, byKey] of groups) for (const [k, list] of byKey) {
      const mat = await matFor(k);
      let o;
      if (list.length > 1) {
        o = new THREE.InstancedMesh(geometry, mat, list.length);
        list.forEach((it, j) => { if (it.matrix) M.fromArray(it.matrix); else M.identity(); o.setMatrixAt(j, M); });
        o.instanceMatrix.needsUpdate = true;
        o.computeBoundingSphere();
      } else { o = new THREE.Mesh(geometry, mat); o.matrixAutoUpdate = false; if (list[0].matrix) o.matrix.fromArray(list[0].matrix); hits.push(o); }
      o.castShadow = list[0].shadow !== false && !mat.transparent; o.receiveShadow = true;
      objs.push(o);
    }
    // lamps (as the live view)
    for (const L of (plain.lights || []).filter((x) => x && x.on !== false && x.lumens > 0).sort((a, b) => b.lumens - a.lumens).slice(0, preset.maxLamps)) {
      const c = new THREE.Color(L.color || '#ffe7c4'), I = lampCandela(L);
      const o = L.kind === 'point' ? new THREE.PointLight(c, I, 0, 2) : new THREE.SpotLight(c, I, 0, L.kind === 'spot' ? (L.angle * Math.PI) / 360 : (85 * Math.PI) / 180, L.kind === 'spot' ? 0.35 : 1, 2);
      o.distance = Math.max(1, Math.sqrt(I / 0.002));
      o.position.set(...L.p);
      if (o.target) { o.target.position.set(L.p[0] + L.dir[0], L.p[1] + L.dir[1], L.p[2] + L.dir[2]); objs.push(o.target); }
      objs.push(o);
    }
    // scatter: far stand-ins for the instances away from the head, the items themselves near it (frame() re-chooses)
    scat?.dispose();
    scat = plain.scatter && plain.scatter.length ? classicScatter(plain.scatter, plain.scatterLibrary || [], preset) : null;
    if (scat) objs.push(scat.group);
    // the probe light sits with the model (app space), so the grid's points and axes are the model's
    objs.push(probe);
    probe.intensity = 0;
    gi = null;
    bake?.abort();
    if (pool && plain.items.length) {
      const ac = new AbortController();
      bake = ac;
      bakeProbes(plain, settings, preset, { pool, signal: ac.signal }).then((r) => { if (!ac.signal.aborted) { gi = r; probe.intensity = 1; } }).catch(() => {});
    }
    // the sky: a background dome round the head and the image light, made once per look (Y up: the headset's world)
    const { sky, envK } = skyFor(plain, s);
    if (!env) {
      const pm = new THREE.PMREMGenerator(renderer), skyScene = new THREE.Scene();
      skyScene.add(skyDome(sky, [0, 1, 0], envK));
      env = pm.fromScene(skyScene, 0, 0.1, 100);
      pm.dispose();
      bg = skyDome(sky, [0, 1, 0], envK);
      bg.scale.setScalar(4000);
      bg.renderOrder = -1;
    }
    return {
      objs, hits, mats: [...mats.values()],
      ground: await matFor('__ground'),
      sun: { color: new THREE.Color(sky.tint || '#ffffff'), intensity: plain.sun ? (sky.sun || 0) : 0 },
      scene(scene) { scene.background = null; if (!bg.parent) scene.add(bg); scene.environment = env.texture; },
      dispose() { /* the previous model's materials go with xr-session.js's disposeTree of its objects */ },
    };
  }

  function frame(xrCamera) {
    xrCamera.getWorldPosition(tmpV);
    if (bg) bg.position.copy(tmpV);
    if (scat) scat.update(tmpV);
    if (gi && probe.parent) {
      // the grid at the head, in the probe's own space (app space: its parents turn and place it in the room)
      probe.parent.updateWorldMatrix(true, false);
      const c = sampleGrid(gi, tmpV.clone().applyMatrix4(tmpM.copy(probe.parent.matrixWorld).invert()).toArray());
      // three applies a light probe in world axes (its parents' turn is not used): band 1 is turned into the room's axes here
      const r = rotateL1(c, tmpR.setFromMatrix4(probe.parent.matrixWorld).elements);
      const sh = probe.sh.coefficients;   // three's order: Y00, Y1−1 (y), Y10 (z), Y11 (x), then band 2 (left 0)
      sh[0].set(r[0], r[1], r[2]); sh[1].set(r[3], r[4], r[5]); sh[2].set(r[6], r[7], r[8]); sh[3].set(r[9], r[10], r[11]);
      for (let k = 4; k < 9; k++) sh[k].set(0, 0, 0);
    }
  }
  return {
    renderer, THREE, tier: t, preset, build, frame,
    get scatterCounts() { return scat ? scat.counts() : []; },
    get bounce() { return !!gi; },
    dispose() { bake?.abort(); scat?.dispose(); env?.dispose(); },
  };
}
