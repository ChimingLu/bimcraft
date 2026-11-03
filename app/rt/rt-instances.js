/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-instances.js — scattered items on the GPU: instancing with two levels of detail (0.7 RT.5, session `realtime`).
 * Canonical in modelcraft/dev/rt/ (tools/rt/sync.mjs). Takes rt-scatter.js results; the items are entourage items
 * (lib/entourage, the app's copy, handed in: this folder imports nothing app-specific).
 *
 *   buildScatter(THREE, TSL, sets, {library, preset}) → {group, update(camera), counts(), dispose()}
 *     sets = [{result: rt-scatter.js scatter() output, slugs}]; library = entourage() (items by slug)
 *     Per item kind: a FAR InstancedMesh holding every instance with a light stand-in (one coloured icosahedron per part, fitted to
 *     its box: 20 triangles a part) and a NEAR InstancedMesh with the item itself for the instances near the camera (chosen on the CPU from a grid, ≤
 *     preset.lod.maxNear, re-chosen when the camera has moved an eighth of the switch distance). Both test the distance to the
 *     instance's own point on the GPU — far draws only beyond preset.lod.near metres, near only within — so they never overlap
 *     and a million far instances cost a million tiny stand-ins. Only near instances cast shadows. See-through parts (car glass)
 *     draw in a third, transparent mesh with the near set.
 */

// an icosahedron (20 triangles): the far stand-in of one part, fitted to its box — round enough for a crown or a rock far off
const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_V = [[-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0], [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI], [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1]].map((p) => { const l = Math.hypot(...p); return p.map((x) => x / l); });
const ICO_F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];

/** An entourage item → {near: geometry with vertex colours (opaque parts), glass: geometry | null, far: one icosahedron per part}. */
export function itemGeometries(THREE, e) {
  const make = (parts) => {
    if (!parts.length) return null;
    const P = [], C = [], I = [];
    for (const p of parts) {
      const base = P.length / 3, c = new THREE.Color(p.color);
      for (let i = 0; i < p.P.length; i += 3) { P.push(p.P[i], p.P[i + 1], p.P[i + 2]); C.push(c.r, c.g, c.b); }
      for (const k of p.I) I.push(base + k);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    g.setIndex(I);
    g.computeVertexNormals();
    return g;
  };
  const far = (() => {
    const P = [], C = [], I = [];
    for (const p of e.parts) {
      if ((p.alpha ?? 1) < 1) continue;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.P.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.P[i + k]); hi[k] = Math.max(hi[k], p.P[i + k]); }
      if (!(hi[0] >= lo[0])) continue;
      const base = P.length / 3, c = new THREE.Color(p.color);
      for (const v of ICO_V) { for (let k = 0; k < 3; k++) P.push((lo[k] + hi[k]) / 2 + v[k] * (hi[k] - lo[k]) / 2); C.push(c.r, c.g, c.b); }
      for (const t of ICO_F) I.push(base + t[0], base + t[1], base + t[2]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    g.setIndex(I);
    g.computeVertexNormals();
    return g;
  })();
  return { near: make(e.parts.filter((p) => (p.alpha ?? 1) >= 1)), glass: make(e.parts.filter((p) => (p.alpha ?? 1) < 1)), far, glassAlpha: Math.min(...e.parts.map((p) => p.alpha ?? 1)) };
}

export function buildScatter(THREE, TSL, sets, { library = [], preset }) {
  const { positionLocal, cameraPosition, instancedBufferAttribute, uniform, select, distance, modelWorldMatrix, vec4 } = TSL;
  const near = uniform(preset.lod.near);
  const group = new THREE.Group();
  group.name = 'scatter';
  const bySlug = new Map(library.map((e) => [e.slug, e]));
  const kinds = [], owned = [];
  const M = new THREE.Matrix4();
  // gather every set's instances per item kind
  const per = new Map();
  for (const { result, slugs } of sets) {
    for (let i = 0; i < result.count; i++) {
      const slug = slugs[result.item[i]];
      if (!bySlug.has(slug)) continue;
      let k = per.get(slug);
      if (!k) { k = []; per.set(slug, k); }
      k.push(result.matrices.subarray(i * 16, i * 16 + 16));
    }
  }
  const material = (geo, side, farLod, extra = {}) => {
    const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side, ...extra });
    // the instance's point in the world (the group may sit under other transforms: a headset's rig, a table-top model)
    const c = modelWorldMatrix.mul(vec4(instancedBufferAttribute(geo.userData.centers), 1)).xyz;
    const d = distance(c, cameraPosition);
    // far draws beyond the switch distance, near within it: the other one folds to a point (no fragments, nearly no cost)
    m.positionNode = positionLocal.mul(select(farLod ? d.lessThan(near) : d.greaterThanEqual(near), 0, 1));
    owned.push(m);
    return m;
  };
  for (const [slug, mats] of per) {
    const e = bySlug.get(slug), G = itemGeometries(THREE, e);
    const n = mats.length, all = new Float32Array(n * 16), centers = new Float32Array(n * 3);
    mats.forEach((m, i) => { all.set(m, i * 16); centers[i * 3] = m[12]; centers[i * 3 + 1] = m[13]; centers[i * 3 + 2] = m[14]; });
    // FAR: every instance, the stand-in
    const farGeo = G.far.clone();
    farGeo.userData.centers = new THREE.InstancedBufferAttribute(centers, 3);
    // made for one, then handed the arrays (a million instances: no second 64 MB matrix array); never culled as a whole
    const farMesh = new THREE.InstancedMesh(farGeo, material(farGeo, THREE.FrontSide, true), 1);
    farMesh.instanceMatrix = new THREE.InstancedBufferAttribute(all, 16);
    farMesh.count = n;
    farMesh.frustumCulled = false;
    farMesh.castShadow = false; farMesh.receiveShadow = true;
    group.add(farMesh);
    // NEAR: room for the closest ones; filled by update()
    const cap = Math.min(n, preset.lod.maxNear);
    const nm = new Float32Array(cap * 16), nc = new Float32Array(cap * 3);
    const mk = (geo, glass) => {
      if (!geo) return null;
      geo.userData.centers = new THREE.InstancedBufferAttribute(nc, 3);
      geo.userData.centers.setUsage(THREE.DynamicDrawUsage);
      const mesh = new THREE.InstancedMesh(geo, material(geo, THREE.DoubleSide, false, glass ? { transparent: true, opacity: Math.max(0.15, G.glassAlpha), depthWrite: false } : {}), 1);
      mesh.instanceMatrix = new THREE.InstancedBufferAttribute(nm, 16);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = !glass; mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };
    const nearMesh = mk(G.near, false), glassMesh = mk(G.glass, true);
    // a grid over the instances' points: cell = half the switch distance (every axis; any up)
    const cell = Math.max(1, preset.lod.near / 2), grid = new Map();
    for (let i = 0; i < n; i++) {
      const key = Math.floor(centers[i * 3] / cell) + ',' + Math.floor(centers[i * 3 + 1] / cell) + ',' + Math.floor(centers[i * 3 + 2] / cell);
      let l = grid.get(key);
      if (!l) { l = []; grid.set(key, l); }
      l.push(i);
    }
    kinds.push({ slug, n, all, centers, cap, nm, nc, nearMesh, glassMesh, farMesh, grid, cell, last: null });
    owned.push(farGeo, G.near, G.glass, G.far);
  }
  const reach = preset.lod.near;
  function update(camera) {
    // the camera in the group's own space (where the instances' points are)
    group.updateWorldMatrix(true, false);
    const cp = camera.getWorldPosition(new THREE.Vector3()).applyMatrix4(new THREE.Matrix4().copy(group.matrixWorld).invert());
    for (const k of kinds) {
      if (k.last && k.last.distanceTo(cp) < reach / 8) continue;
      k.last = cp.clone();
      // cells within reach of the camera, nearest cells first, until the near set is full
      const r = Math.ceil(reach / k.cell) + 1, cx = Math.floor(cp.x / k.cell), cy = Math.floor(cp.y / k.cell), cz = Math.floor(cp.z / k.cell);
      const cells = [];
      for (let x = -r; x <= r; x++) for (let y = -r; y <= r; y++) for (let z = -r; z <= r; z++) {
        const l = k.grid.get((cx + x) + ',' + (cy + y) + ',' + (cz + z));
        if (l) cells.push([x * x + y * y + z * z, l]);
      }
      cells.sort((a, b) => a[0] - b[0]);
      let c = 0;
      for (const [, l] of cells) for (const i of l) {
        if (c >= k.cap) break;
        k.nm.set(k.all.subarray(i * 16, i * 16 + 16), c * 16);
        k.nc[c * 3] = k.centers[i * 3]; k.nc[c * 3 + 1] = k.centers[i * 3 + 1]; k.nc[c * 3 + 2] = k.centers[i * 3 + 2];
        c++;
      }
      for (const m of [k.nearMesh, k.glassMesh]) {
        if (!m) continue;
        m.count = c;
        m.instanceMatrix.needsUpdate = true;
        m.geometry.userData.centers.needsUpdate = true;
      }
    }
  }
  return {
    group, update,
    counts: () => Object.fromEntries(kinds.map((k) => [k.slug, { all: k.n, near: k.nearMesh ? k.nearMesh.count : 0 }])),
    setNear(d) { near.value = d; },
    dispose() { for (const o of owned) o?.dispose?.(); for (const k of kinds) { k.farMesh.dispose(); k.nearMesh?.dispose(); k.glassMesh?.dispose(); } },
  };
}
