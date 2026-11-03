/* SPDX-License-Identifier: Apache-2.0 */
/**
 * three-mats.js — library materials as three.js textures and materials (0.5 RC.11 (b)). Shared by the renderer and the apps'
 * live 3D views (render/ is synced into BimCraft, tools/render/sync.mjs).
 *
 *   libTextures(id, size = 256) → {map, bump, w, h, size: [w, h] metres} | null   cached per (id, size); map is sRGB, bump
 *                                  carries the height in red and the roughness in green (three reads .r for bump, .g for
 *                                  roughness), both repeat. Callers never dispose them (they are shared): disposeLibTextures().
 *   libMaterial(id, {size, clipping, front, lambert, fog}) → THREE.Material   a new material using the cached textures; UVs
 *                                  in metres (materials.js planarUVs), so the textures repeat every `size` metres
 *   uvTransform(tex, sizeM)        set a texture's repeat so UVs in metres land on one copy per `sizeM`
 *   swatchPixels(id, px) → {w, h, data: Uint8ClampedArray}   a small square for a library button (the texture's corner)
 *   imageTexture({mime, data}, onLoad) → THREE.Texture           an imported image (base64) as a repeating texture; the
 *                                  pixels arrive when the browser has decoded it (onLoad then); UVs as SketchUp's (v up)
 *   imageTextureReady(im) → Promise<THREE.Texture>                the same, once decoded (the renderer waits for it)
 *   imageMaterial(texture, {lambert, front, clipping}) → THREE.Material
 *
 * 0.7 MT.1 (session `materials`): the open file's node materials (shading/, registered in materials.js) come through the same
 * libTextures / libMaterial / swatchPixels. Their textures are the bake's layers (RENDER-SPEC § 6.6): the colour map, roughness in
 * green and metalness in blue of one map, a normal map, a cut-out (alphaMap) and a glow (emissiveMap). A material made here
 * for a node material is **kept up to date in place**: after the graph changes (materials.js onMaterialsChanged) its textures
 * and numbers are replaced, so a view that holds it only needs to redraw. The live view's box and triplanar mapping use the
 * view's own UVs (along each face); the path tracer projects them exactly.
 */
import * as THREE from 'three';
import { material, onMaterialsChanged } from './materials.js';
import { makeTexture } from './textures.js';

const cache = new Map();

function dataTexture(data, w, h, srgb) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** A node material's layers as three.js textures (cached per material revision and size). */
function nodeTextures(m, size) {
  const key = m.id + '@' + size + '@' + m.rev;
  let c = cache.get(key);
  if (c) return c;
  const L = m.layers(size);
  if (!L) return null;
  const n = size * size, rgb = (src, a = null) => {
    const d = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) { d[i * 4] = src[i * 4]; d[i * 4 + 1] = src[i * 4 + 1]; d[i * 4 + 2] = src[i * 4 + 2]; d[i * 4 + 3] = a === null ? 255 : a(i); }
    return d;
  };
  c = { w: size, h: size, size: L.size, node: true };
  if (L.base) c.map = dataTexture(rgb(L.base), size, size, true);
  if ((L.base && L.rough) || (L.data && L.metal)) {
    const d = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) { d[i * 4 + 1] = L.base && L.rough ? L.base[i * 4 + 3] : 255; d[i * 4 + 2] = L.data && L.metal ? L.data[i * 4 + 2] : 255; d[i * 4 + 3] = 255; }
    c.rm = dataTexture(d, size, size, false);
  }
  if (L.data && L.normal) {
    const d = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      // RENDER-SPEC § 6.6 bytes (127·x + 128) → three's tangent-space map (x·½ + ½)
      const x = Math.max(-1, Math.min(1, (L.data[i * 4] - 128) / 127)), y = Math.max(-1, Math.min(1, (L.data[i * 4 + 1] - 128) / 127)), z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
      d[i * 4] = (x * 0.5 + 0.5) * 255; d[i * 4 + 1] = (y * 0.5 + 0.5) * 255; d[i * 4 + 2] = (z * 0.5 + 0.5) * 255; d[i * 4 + 3] = 255;
    }
    c.normal = dataTexture(d, size, size, false);
  }
  if (L.data && L.opacity) { const d = new Uint8ClampedArray(n * 4); for (let i = 0; i < n; i++) { d[i * 4 + 1] = L.data[i * 4 + 3]; d[i * 4 + 3] = 255; } c.alpha = dataTexture(d, size, size, false); }
  if (L.emit) c.emissive = dataTexture(rgb(L.emit), size, size, true);
  for (const k of ['map', 'rm', 'normal', 'alpha', 'emissive']) if (c[k]) uvTransform(c[k], c.size);
  cache.set(key, c);
  return c;
}

export function libTextures(id, size = 256) {
  const m = material(id);
  if (m && m.node) return nodeTextures(m, size);
  if (!m || !m.tex) return null;
  const key = id + '@' + size;
  let c = cache.get(key);
  if (c) return c;
  const t = makeTexture(m.tex, size);
  const br = new Uint8ClampedArray(t.w * t.h * 4);
  for (let i = 0; i < t.w * t.h; i++) { br[i * 4] = t.height[i] * 255; br[i * 4 + 1] = t.rough[i] * 255; br[i * 4 + 2] = 0; br[i * 4 + 3] = 255; }
  c = { map: dataTexture(t.albedo, t.w, t.h, true), bump: dataTexture(br, t.w, t.h, false), w: t.w, h: t.h, size: m.tex.size || [1, 1] };
  uvTransform(c.map, c.size); uvTransform(c.bump, c.size);
  cache.set(key, c);
  return c;
}

export function uvTransform(tex, sizeM) { tex.repeat.set(1 / sizeM[0], 1 / sizeM[1]); tex.needsUpdate = true; }

const disposeSet = (c) => { for (const k of ['map', 'bump', 'rm', 'normal', 'alpha', 'emissive']) c[k]?.dispose(); };
export function disposeLibTextures() { for (const c of cache.values()) disposeSet(c); cache.clear(); }

// ---- node materials (MT.1): made once per (id, options), refreshed in place when the graph changes ----
const live = [];
function setNodeMaterial(mat, m, size, lambert) {
  const tx = nodeTextures(m, size) || {};
  const b = m.bake ? m.bake(64) : null, pbr = m.pbr;
  mat.map = tx.map || null;
  mat.color.set(tx.map ? 0xffffff : m.color);
  mat.normalMap = tx.normal || null;
  if (mat.normalScale) mat.normalScale.set(b ? b.normalStrength : 1, b ? b.normalStrength : 1);
  mat.alphaMap = tx.alpha || null;
  mat.alphaTest = tx.alpha ? 0.5 : 0;
  const glow = pbr.emission_luminance > 0;
  mat.emissiveMap = glow && tx.emissive ? tx.emissive : null;
  mat.emissive.set(glow ? (tx.emissive ? 0xffffff : '#' + new THREE.Color().setRGB(...pbr.emission_color.map((x) => Math.max(0, x)), THREE.LinearSRGBColorSpace).getHexString()) : 0x000000);
  mat.emissiveIntensity = glow ? Math.min(lambert ? 1 : 20, pbr.emission_luminance * 0.02) : 0;
  const op = m.glass > 0 ? Math.max(0.08, 1 - m.glass) : !tx.alpha && b ? b.opacity : 1;
  mat.transparent = op < 1; mat.opacity = op; mat.depthWrite = op >= 1;
  if (!lambert) {
    mat.roughnessMap = tx.rm && b && b.flags.rough ? tx.rm : null;
    mat.metalnessMap = tx.rm && b && b.flags.metal ? tx.rm : null;
    mat.roughness = mat.roughnessMap ? 1 : m.rough;
    mat.metalness = mat.metalnessMap ? 1 : m.metal;
  }
  mat.userData.ccRev = m.rev;
  mat.needsUpdate = true;
}
function nodeMaterial(m, { size, clipping, front, lambert, fog }) {
  const common = { side: front ? THREE.FrontSide : THREE.DoubleSide, fog, clippingPlanes: clipping, clipShadows: true };
  const mat = lambert ? new THREE.MeshLambertMaterial({ ...common, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
    : new THREE.MeshStandardMaterial({ ...common, shadowSide: THREE.BackSide });
  setNodeMaterial(mat, m, size, lambert);
  live.push({ ref: new WeakRef(mat), id: m.id, size, lambert });
  return mat;
}
onMaterialsChanged(() => {
  // drop textures of revisions no longer current, then bring every live node material up to date
  for (const [k, c] of [...cache]) if (c.node) { const [id, , rev] = k.split('@'), m = material(id); if (!m || String(m.rev) !== rev) { disposeSet(c); cache.delete(k); } }
  for (let i = live.length - 1; i >= 0; i--) {
    const L = live[i], mat = L.ref.deref(), m = mat && material(L.id);
    if (!mat) { live.splice(i, 1); continue; }
    if (m && m.node && mat.userData.ccRev !== m.rev) setNodeMaterial(mat, m, L.size, L.lambert);
  }
});

export function libMaterial(id, { size = 256, clipping = [], front = false, lambert = false, fog = false } = {}) {
  const m = material(id);
  if (!m) return null;
  if (m.node) return nodeMaterial(m, { size, clipping, front, lambert, fog });
  const tx = libTextures(id, size);
  const common = { side: front ? THREE.FrontSide : THREE.DoubleSide, fog, clippingPlanes: clipping, clipShadows: true };
  if (lambert) {
    // the live 3D views: Lambert like the rest of the view, the texture on a white base
    return new THREE.MeshLambertMaterial({ ...common, color: tx ? 0xffffff : m.color, map: tx ? tx.map : null, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  }
  if (m.glass > 0) {
    return new THREE.MeshPhysicalMaterial({ ...common, color: m.color, roughness: m.rough, metalness: m.metal, transparent: true, opacity: Math.max(0.08, 1 - m.glass), depthWrite: false, ior: 1.5, specularIntensity: 1, envMapIntensity: 1.4 });
  }
  return new THREE.MeshStandardMaterial({
    ...common, shadowSide: THREE.BackSide, metalness: m.metal,
    color: tx ? 0xffffff : m.color, map: tx ? tx.map : null,
    roughness: tx ? 1 : m.rough, roughnessMap: tx ? tx.bump : null,
    bumpMap: tx ? tx.bump : null, bumpScale: tx ? m.bump * 1.5 : 1,
  });
}

/** A swatch for the library's buttons: the texture's lower-left `px` × `px` (or the flat colour). */
export function swatchPixels(id, px = 48) {
  const m = material(id);
  if (!m) return null;
  const data = new Uint8ClampedArray(px * px * 4);
  if (m.node) {
    // a node material: its base layer at the swatch's size (or its flat colour)
    const L = m.layers(64);
    if (L && L.base) {
      const k = 64 / px;
      for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
        const i = (Math.min(63, Math.floor((px - 1 - y) * k)) * 64 + Math.min(63, Math.floor(x * k))) * 4;
        data.set([L.base[i], L.base[i + 1], L.base[i + 2], 255], (y * px + x) * 4);
      }
      return { w: px, h: px, data };
    }
  }
  if (!m.tex) {
    const hex = m.color;
    const c = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    for (let i = 0; i < px * px; i++) data.set([c[0], c[1], c[2], 255], i * 4);
    return { w: px, h: px, data };
  }
  const t = makeTexture(m.tex, 128);
  const k = Math.min(t.w, t.h) / px;
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    const sx = Math.min(t.w - 1, Math.floor(x * k)), sy = Math.min(t.h - 1, Math.floor((px - 1 - y) * k));   // rows from the top
    const i = (sy * t.w + sx) * 4;
    data.set([t.albedo[i], t.albedo[i + 1], t.albedo[i + 2], 255], (y * px + x) * 4);
  }
  return { w: px, h: px, data };
}

// ---- imported images (0.5 RC.11 (b): textures that came with SketchUp and glTF files) ----
export function imageTexture(im, onLoad) {
  const tex = new THREE.Texture();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const img = new Image();
  img.onload = () => { tex.image = img; tex.needsUpdate = true; onLoad?.(tex); };
  img.onerror = () => onLoad?.(null);
  img.src = 'data:' + im.mime + ';base64,' + im.data;
  return tex;
}
export function imageTextureReady(im) { return new Promise((res) => { const t = imageTexture(im, (ok) => res(ok ? t : null)); }); }
export function imageMaterial(tex, { lambert = false, front = false, clipping = [] } = {}) {
  const common = { side: front ? THREE.FrontSide : THREE.DoubleSide, fog: false, clippingPlanes: clipping, clipShadows: true, map: tex, color: 0xffffff };
  return lambert ? new THREE.MeshLambertMaterial({ ...common, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
    : new THREE.MeshStandardMaterial({ ...common, roughness: 0.7, metalness: 0, shadowSide: THREE.BackSide });
}

