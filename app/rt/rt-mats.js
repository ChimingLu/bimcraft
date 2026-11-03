/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-mats.js — the real-time view's materials (0.7 RT.2, session `realtime`): one MeshPhysicalNodeMaterial per material key,
 * from the same OpenPBR record the path tracer packs (render/pt-pack.js materialRecord, RENDER-SPEC § 5.1), so a look, a
 * library material (`mat:<id>`) or an imported texture (`img:<id>`) means the same in both renderers (approximated:
 * rt-look.js physicalParams says what is left out). Canonical in modelcraft/dev/rt/ (tools/rt/sync.mjs).
 *
 *   await createMaterials(THREE, scene, settings, {clipping}) → {get(key) → Material, edges, ground, dispose()}
 *     scene = the apps' plain render scene (render/render-core.js header: items, images, defaultColor, looks, up …).
 *     Library textures come from render/three-mats.js libTextures (shared and cached, never disposed here); imported images
 *     are decoded before it returns.
 *     scene.resolved = {key: resolveMaterial() output} — materials worked out already (the standalone viewer, RT.4): then the
 *     path tracer's modules are not loaded at all (only for a key that is missing).
 *   await resolveMaterial(key, settings, scene) → {params (physicalParams), map?: {png (data URL), repeat}, rough?: {png, repeat},
 *     bumpScale}   one key as plain data with its textures as PNG (for the standalone viewer's file)
 */
import { physicalParams } from './rt-look.js';

let helpers = null;
/** The path tracer's material record and the library's textures, loaded the first time a key has to be worked out. */
const load = () => helpers || (helpers = Promise.all([import('../render/pt-pack.js'), import('../render/materials.js'), import('../render/three-mats.js')])
  .then(([P, M, T]) => ({ materialRecord: P.materialRecord, libDef: M.material, libTextures: T.libTextures, imageTexture: T.imageTexture })));

/** A DataTexture's or an image's pixels → a PNG data URL (canvas; the page or a worker with OffscreenCanvas). */
async function png(source) {
  const img = source.image || source;
  const w = img.width, h = img.height;
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
  if (img.data) g.putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, w * h * 4), w, h), 0, 0);
  else g.drawImage(img, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });   // i18n-ignore: a media type
  return await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
}

export async function resolveMaterial(key, settings, scene) {
  const H = await load();
  let tex = null, maps = null, image = null;
  if (key.startsWith('mat:') && H.libDef(key.slice(4))) { maps = H.libTextures(key.slice(4), 512); if (maps) tex = { layer: 0, scale: [1, 1], rough: true }; }
  else if (key.startsWith('img:') && scene.images && scene.images[key.slice(4)]) image = scene.images[key.slice(4)];
  const p = physicalParams(H.materialRecord(key, settings, scene, image ? { layer: 0, scale: [1, 1], rough: false } : tex));
  const out = { params: p };
  if (maps) {
    out.map = { png: await png(maps.map), repeat: [maps.map.repeat.x, maps.map.repeat.y], srgb: true };
    out.rough = { png: await png(maps.bump), repeat: [maps.bump.repeat.x, maps.bump.repeat.y], srgb: false };
    out.bumpScale = (H.libDef(key.slice(4)).bump || 0) * 1.5;
  }
  if (image) out.map = { png: 'data:' + image.mime + ';base64,' + image.data, repeat: [1, 1], srgb: true };
  return out;
}

export async function createMaterials(THREE, scene, settings, { clipping = [] } = {}) {
  const mats = new Map(), owned = [];
  const resolved = scene.resolved || null;
  const keys = new Set(['__ground', 'default', ...(scene.items || []).filter((it) => !it.lines).map((it) => it.look || 'default')]);
  const H = !resolved || [...keys].some((k) => !resolved[k]) ? await load() : null;
  const col = (c) => new THREE.Color(c[0], c[1], c[2]);   // linear Rec.709 already (no sRGB decode)
  // imported images and resolved PNGs: decoded before the first frame
  const decoded = new Map();
  const decode = (url, srgb, repeat) => new Promise((res) => {
    const img = new Image();
    img.onload = () => { const t = new THREE.Texture(img); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8; t.repeat.set(repeat[0], repeat[1]); t.needsUpdate = true; owned.push(t); res(t); };
    img.onerror = () => res(null);
    img.src = url;
  });
  for (const k of keys) {
    const r = resolved && resolved[k];
    if (r) {
      if (r.map) decoded.set(k + '|map', await decode(r.map.png, r.map.srgb, r.map.repeat));
      if (r.rough) decoded.set(k + '|rough', await decode(r.rough.png, false, r.rough.repeat));
    } else if (k.startsWith('img:') && scene.images && scene.images[k.slice(4)]) {
      decoded.set(k + '|img', await new Promise((res) => { const t = H.imageTexture(scene.images[k.slice(4)], (ok) => res(ok ? t : null)); }));
      if (decoded.get(k + '|img')) owned.push(decoded.get(k + '|img'));
    }
  }
  const physical = (p) => {
    const m = new THREE.MeshPhysicalNodeMaterial({
      color: col(p.color), metalness: p.metalness, roughness: p.roughness, ior: p.ior,
      specularIntensity: p.specularIntensity, specularColor: col(p.specularColor),
      clearcoat: p.clearcoat, clearcoatRoughness: p.clearcoatRoughness,
      sheen: p.sheen, sheenColor: col(p.sheenColor), sheenRoughness: p.sheenRoughness,
      iridescence: p.iridescence, iridescenceIOR: p.iridescenceIOR, iridescenceThicknessRange: [p.iridescenceThickness, p.iridescenceThickness],
      emissive: col(p.emissive), side: THREE.DoubleSide, clippingPlanes: clipping, clipShadows: true,
    });
    if (p.transmission > 0) {
      // window glass (thin) is a see-through sheet that reflects the sky; a solid gets three's screen-space refraction
      if (p.thin) { m.transparent = true; m.opacity = Math.max(0.08, 1 - p.transmission * 0.92); m.depthWrite = false; }
      else { m.transmission = p.transmission; m.thickness = p.thickness || 0.05; m.attenuationColor = col(p.attenuationColor); m.attenuationDistance = p.attenuationDistance; }
    }
    if (p.opacity < 1) { m.transparent = true; m.opacity = Math.min(m.opacity, p.opacity); m.depthWrite = false; }
    m.shadowSide = THREE.BackSide;
    owned.push(m);
    return m;
  };
  const make = (key) => {
    const r = resolved && resolved[key];
    if (r) {
      const m = physical(r.params);
      if (decoded.get(key + '|map')) m.map = decoded.get(key + '|map');
      if (decoded.get(key + '|rough')) { m.roughnessMap = decoded.get(key + '|rough'); m.bumpMap = m.roughnessMap; m.bumpScale = r.bumpScale || 0; }
      return m;
    }
    let tex = null, maps = null;
    const image = decoded.get(key + '|img') || null;
    if (key.startsWith('mat:') && H.libDef(key.slice(4))) { maps = H.libTextures(key.slice(4), 512); if (maps) tex = { layer: 0, scale: [1, 1], rough: true }; }
    const m = physical(physicalParams(H.materialRecord(key, settings, scene, image ? { layer: 0, scale: [1, 1], rough: false } : tex)));
    if (maps) { m.map = maps.map; m.roughnessMap = maps.bump; m.bumpMap = maps.bump; m.bumpScale = (H.libDef(key.slice(4)).bump || 0) * 1.5; }
    if (image) m.map = image;
    return m;
  };
  const edges = new THREE.LineBasicNodeMaterial({ color: new THREE.Color('#2a2f36'), transparent: true, opacity: 0.55, clippingPlanes: clipping });
  owned.push(edges);
  return {
    get(key) { const k = key || 'default'; let m = mats.get(k); if (!m) { m = make(k); mats.set(k, m); } return m; },
    edges,
    get ground() { return this.get('__ground'); },
    dispose() { for (const o of owned) o.dispose?.(); mats.clear(); },
  };
}
