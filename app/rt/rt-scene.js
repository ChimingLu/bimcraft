/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-scene.js — the apps' plain render scene as a three.js scene for the real-time view (0.7 RT.2, session `realtime`).
 * Canonical in modelcraft/dev/rt/ (tools/rt/sync.mjs). Takes the same plain scene the renderer and the path tracer take
 * (render/render-core.js header; ModelCraft render-mc.js, BimCraft render-bim.js), so all three draw one model.
 *
 *   buildScene(THREE, plain, settings, preset, {backend, renderer, TSL, skyUp}) → {
 *     scene, camera, sun, lamps, bounds: {c, R, up}, items: n,
 *     setCamera(spec)          spec = plain.camera(aspect) → {world, proj} (column-major, OpenGL): the three camera follows it
 *     setSun(dir | null)       a new sun direction (time of day, season) without rebuilding anything
 *     setMatrices(list)        per plain item: a new world matrix (number[16]) or null = unchanged (animation, live edits)
 *     beforeRender()           the scatter's near set follows the camera (rt-instances.js)
 *     setScatter(list, library) → Promise   new scatter sets only (the rest of the scene stays)
 *   plain.scatter = [{result: rt-scatter.js scatter(), slugs}] + plain.scatterLibrary = entourage(): scattered items (RT.5)
 *     dispose() }
 *
 * Instancing (RT.5): items that share a geometry and a material key become one InstancedMesh, so a component placed 1,000
 * times is one draw. Sky: the same gradient as the tracer (render/looks.js SKIES, × environment intensity 1, 1.2 white;
 * RENDER-SPEC § 5.3), drawn as the background and filtered (PMREM) for image light and reflections; the physical sky and
 * sky pictures show as the clear sky here, as in the fast render. Sun: irradiance `sky.sun` × tint, the tracer's units,
 * with cascaded shadow maps (CSMShadowNode) on medium/high, one fitted map on low. Lamps as render-core.js makes them
 * (lampCandela, a wide soft spot for area panels).
 */
import { lampCandela, basis } from '../render/looks.js';
import { createMaterials } from './rt-mats.js';
import { skyFor } from './rt-look.js';

const v3 = (THREE, a) => new THREE.Vector3(a[0], a[1], a[2]);

/** A camera spec (world, proj) applied to a three camera of the right kind (made when the kind changes). */
export function cameraFromSpec(THREE, spec, cam = null) {
  const P = spec.proj, persp = P[11] === -1;
  if (!cam || (persp ? !cam.isPerspectiveCamera : !cam.isOrthographicCamera)) cam = persp ? new THREE.PerspectiveCamera() : new THREE.OrthographicCamera();
  const W = new THREE.Matrix4().fromArray(spec.world);
  W.decompose(cam.position, cam.quaternion, cam.scale);
  if (persp) {
    cam.fov = (2 * Math.atan(1 / P[5]) * 180) / Math.PI;
    cam.aspect = P[5] / P[0];
    cam.near = P[14] / (P[10] - 1);
    cam.far = P[14] / (P[10] + 1);
    if (!(cam.far > cam.near * 1.0001) || !Number.isFinite(cam.far)) cam.far = cam.near * 1e6;
  } else {
    const l = (-1 - P[12]) / P[0], r = (1 - P[12]) / P[0], b = (-1 - P[13]) / P[5], t = (1 - P[13]) / P[5];
    cam.left = l; cam.right = r; cam.bottom = b; cam.top = t;
    cam.near = (P[14] + 1) / P[10]; cam.far = (P[14] - 1) / P[10];
    if (cam.near > cam.far) [cam.near, cam.far] = [cam.far, cam.near];
  }
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}

function skyNode(THREE, TSL, sky, up, mul) {
  const { Fn, vec3, dot, normalize, positionWorldDirection, mix, pow, max, uniform } = TSL;
  const zen = uniform(new THREE.Color(sky.zenith)), hor = uniform(new THREE.Color(sky.horizon)), gnd = uniform(new THREE.Color(sky.ground));
  const u = uniform(v3(THREE, up)), k = uniform(mul);
  const node = Fn(() => {
    const z = dot(normalize(positionWorldDirection), u);
    const above = mix(hor, zen, pow(max(z, 0), 0.6));
    const below = mix(hor, gnd, pow(max(z.negate(), 0), 0.4));
    return z.greaterThanEqual(0).select(above, below).mul(k);
  })();
  return { node, set(s) { zen.value.set(s.zenith); hor.value.set(s.horizon); gnd.value.set(s.ground); } };
}

export async function buildScene(THREE, plain, settings, preset, { backend = 'webgl2', renderer = null, TSL = null, skyUp = null } = {}) {
  TSL = TSL || await import('three/tsl');
  const s = settings || {};
  const { sky, envK } = skyFor(plain, s);
  const up = basis(plain.up || [0, 0, 1]).up;
  const bb = plain.bounds;
  const c = bb ? [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2] : [0, 0, 0];
  const R = bb ? Math.max(Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) / 2, 0.5) : 5;
  const clipping = (plain.clip || []).map((p) => new THREE.Plane(new THREE.Vector3(-p.n[0], -p.n[1], -p.n[2]), p.d));
  const scene = new THREE.Scene();
  const disposables = [];
  const mats = await createMaterials(THREE, plain, s, { clipping });

  // ---- the model: one InstancedMesh per (geometry, material key) used more than once, else a Mesh ----
  const groups = new Map();
  const objOf = new Array(plain.items.length).fill(null);
  const M = new THREE.Matrix4();
  const placed = (o, m) => { o.matrixAutoUpdate = false; if (m) o.matrix.fromArray(m); scene.add(o); return o; };
  plain.items.forEach((it, i) => {
    if (it.lines) {
      // edges: one LineSegments per placement (few, and drawn only with the Edges setting)
      if (s.edges) objOf[i] = { o: placed(new THREE.LineSegments(it.geometry, mats.edges), it.matrix), j: -1 };
      return;
    }
    const k = it.look || 'default';
    let g = groups.get(it.geometry);
    if (!g) { g = new Map(); groups.set(it.geometry, g); }
    let list = g.get(k);
    if (!list) { list = []; g.set(k, list); }
    list.push({ i, it });
  });
  for (const [geometry, byKey] of groups) for (const [k, list] of byKey) {
    const mat = mats.get(k);
    let o;
    if (list.length > 1) {
      o = new THREE.InstancedMesh(geometry, mat, list.length);
      list.forEach(({ it }, j) => { if (it.matrix) M.fromArray(it.matrix); else M.identity(); o.setMatrixAt(j, M); });
      o.instanceMatrix.needsUpdate = true;
      o.computeBoundingSphere();
      scene.add(o);
    } else o = placed(new THREE.Mesh(geometry, mat), list[0].it.matrix);
    o.castShadow = list[0].it.shadow !== false && !mat.transparent;
    o.receiveShadow = true;
    for (const [j, { i }] of list.entries()) objOf[i] = { o, j };
  }

  // ---- sky: background + image light (the same dome filtered once) ----
  // the sky's up: the scene's, unless the scene is shown under another frame (a headset's world is Y up: rt-xr.js)
  const sUp = skyUp || up;
  const bg = skyNode(THREE, TSL, sky, sUp, envK);
  scene.backgroundNode = bg.node;
  let envTex = null;
  if (renderer) {
    const skyScene = new THREE.Scene();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false }));
    dome.material.colorNode = skyNode(THREE, TSL, sky, sUp, envK).node;
    skyScene.add(dome);
    const pm = new THREE.PMREMGenerator(renderer);
    const rt = await pm.fromSceneAsync(skyScene, 0, 0.1, 100);
    envTex = rt.texture;
    scene.environment = envTex;
    disposables.push(rt, pm, dome.geometry, dome.material);
  }

  // ---- ground: a matte plane square to up (as the tracer's: RENDER-SPEC § 3) ----
  if (s.ground !== false) {
    const ground = new THREE.Mesh(new THREE.CircleGeometry(R * 60, 96), mats.ground);
    ground.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), v3(THREE, up));
    const lift = (c[0] * up[0] + c[1] * up[1] + c[2] * up[2]) - (plain.groundAt ?? 0) + R * 1e-4;
    ground.position.set(c[0] - up[0] * lift, c[1] - up[1] * lift, c[2] - up[2] * lift);
    ground.receiveShadow = true;
    ground.userData.rtGround = true;
    scene.add(ground);
    disposables.push(ground.geometry);
  }

  // ---- sun ----
  const sunLight = new THREE.DirectionalLight(new THREE.Color(sky.tint || '#ffffff'), sky.sun || 0);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(preset.shadow.size, preset.shadow.size);
  sunLight.shadow.bias = -0.0002;
  sunLight.shadow.normalBias = R * 0.002;
  scene.add(sunLight, sunLight.target);
  let csm = null;
  if (preset.shadow.cascades > 1) {
    const { CSMShadowNode } = await import('three-webgpu/addons/csm/CSMShadowNode.js');
    // the cascades reach the ground's edge and fade out there: past the last one the ground is lit, not shadowed
    csm = new CSMShadowNode(sunLight, { cascades: preset.shadow.cascades, maxFar: R * 40, mode: 'practical', lightMargin: R * 2 });
    csm.fade = true;
    sunLight.shadow.shadowNode = csm;
  }
  const sc = sunLight.shadow.camera;
  const fit = () => { sc.left = -R * 1.6; sc.right = R * 1.6; sc.top = R * 1.6; sc.bottom = -R * 1.6; sc.near = R * 0.05; sc.far = R * 8; sc.updateProjectionMatrix(); };
  fit();
  const { e1 } = basis(up);
  function setSun(dir) {
    const on = !!dir && (dir[0] * up[0] + dir[1] * up[1] + dir[2] * up[2]) > 0.02 && (sky.sun || 0) > 0;
    sunLight.intensity = on ? sky.sun : 0;
    sunLight.visible = on;
    if (!on) return;
    sunLight.position.set(c[0] + dir[0] * R * 4, c[1] + dir[1] * R * 4, c[2] + dir[2] * R * 4);
    // the shadow camera's own up must not run along the light (the sun overhead)
    const a = Math.abs(dir[0] * up[0] + dir[1] * up[1] + dir[2] * up[2]);
    sunLight.up.set(...(a > 0.99 ? e1 : up));
    sunLight.target.position.set(c[0], c[1], c[2]);
    sunLight.target.updateMatrixWorld();
    sunLight.updateMatrixWorld();
  }
  setSun(plain.sun);

  // ---- lamps ----
  const lamps = (plain.lights || []).filter((L) => L && L.on !== false && L.lumens > 0).sort((a, b) => b.lumens - a.lumens).slice(0, preset.maxLamps);
  const lampObjs = lamps.map((L, k) => {
    const col = new THREE.Color(L.color || '#ffe7c4'), I = lampCandela(L);
    let o;
    if (L.kind === 'point') o = new THREE.PointLight(col, I, 0, 2);
    else {
      const half = L.kind === 'spot' ? (L.angle * Math.PI) / 360 : (85 * Math.PI) / 180;
      o = new THREE.SpotLight(col, I, 0, half, L.kind === 'spot' ? 0.35 : 1, 2);
      scene.add(o.target);
      o.target.position.set(L.p[0] + L.dir[0], L.p[1] + L.dir[1], L.p[2] + L.dir[2]);
    }
    // a finite reach: where the lamp's light falls to 0.002 (≈ 1/1600 of the sun's 3.2: never seen). Clustered lighting sorts
    // lamps into tiles by this radius (0 would put a lamp in none); three fades the last stretch smoothly
    o.distance = Math.max(1, Math.sqrt(I / 0.002));
    o.position.set(L.p[0], L.p[1], L.p[2]);
    o.castShadow = k < (preset.quality === 'low' ? 0 : 4);
    if (o.castShadow) { o.shadow.mapSize.set(512, 512); o.shadow.camera.near = 0.02; o.shadow.camera.far = R * 6 + 10; o.shadow.bias = -0.004 / (o.shadow.camera.far / 20); }
    scene.add(o);
    return o;
  });

  // ---- scattered plants, rocks and people (RT.5): instanced, two levels of detail ----
  let scat = null;
  const { buildScatter } = plain.scatter ? await import('./rt-instances.js') : { buildScatter: null };
  const setScatter = async (list, library) => {
    if (scat) { scene.remove(scat.group); scat.dispose(); scat = null; }
    if (!list || !list.length) return;
    const B = buildScatter || (await import('./rt-instances.js')).buildScatter;
    scat = B(THREE, TSL, list, { library: library || [], preset });
    scene.add(scat.group);
  };
  await setScatter(plain.scatter, plain.scatterLibrary);

  scene.updateMatrixWorld(true);
  let camera = null;
  return {
    scene, sun: sunLight, csm, lamps: lampObjs, bounds: { c, R, up }, items: plain.items.length, materials: mats, envTex, scatter: scat,
    /** New scatter sets without rebuilding the rest (painting, a slider): [{result, slugs}], the entourage list. */
    setScatter,
    /** Before each frame: the scatter's near set follows the camera. */
    beforeRender() { if (scat && camera) scat.update(camera); },
    get camera() { return camera; },
    setCamera(spec) {
      camera = cameraFromSpec(THREE, spec, camera);
      // the cascades take their camera from the first build (CSMShadowNode._init); after that they are told of every change
      if (csm && csm.mainFrustum) { csm.camera = camera; csm.updateFrustums(); }
      return camera;
    },
    setSun,
    setMatrices(list) {
      const touched = new Set();
      list.forEach((m, i) => {
        const w = m && objOf[i];
        if (!w) return;
        M.fromArray(m);
        if (w.o.isInstancedMesh) { w.o.setMatrixAt(w.j, M); touched.add(w.o); } else { w.o.matrix.copy(M); w.o.matrixWorldNeedsUpdate = true; }
      });
      for (const o of touched) { o.instanceMatrix.needsUpdate = true; o.computeBoundingSphere(); }
      scene.updateMatrixWorld(true);
    },
    dispose() {
      scat?.dispose();
      csm?.dispose?.();
      for (const o of lampObjs) o.dispose?.();
      sunLight.dispose?.();
      mats.dispose();
      for (const d of disposables) d?.dispose?.();
      scene.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    },
  };
}
