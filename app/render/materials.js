/* SPDX-License-Identifier: Apache-2.0 */
/**
 * materials.js — the material library (0.5 RC.11 (b) / RC.7): wood, brick, siding, roofing, stone, tile, concrete, finishes,
 * ground, glass and metal. No DOM, no imports. Every texture is drawn by textures.js from the numbers below, so the library is
 * our own work, CC0 (CadCraft). Shared by ModelCraft and BimCraft (render/ is synced, tools/render/sync.mjs).
 *
 *   MATERIALS   [{id, cat, color, rough, metal, glass, tex?: {kind, color, size: [w, h] metres, seed, …}, bump}]
 *               color = what the material looks like from afar: the 3D views, exports and files that cannot carry a texture
 *               tex.size = the real size one copy of the texture covers (a brick tile is 4 bricks × 8 courses = 0.9 × 0.6 m)
 *   CATEGORIES  the order the library lists them in
 *   material(id) → the entry | null        isMaterialId(id) → bool      (the library's, then the open file's own — below)
 *   setDocumentMaterials(entries)          0.7 MT.1: the open file's node materials (shading/doc.js makes the entries:
 *                                          {id, cat: 'mine', name, color, rough, metal, glass, tex: null, bump: 0, pbr, layers(size),
 *                                          mapping, size}); they answer material(id) like the library's, never replacing one
 *   documentMaterials() → [entry]          materialLayers(id, size) → the baked layers of § 6.6 (RENDER-SPEC) | null
 *   onMaterialsChanged(fn) → unsubscribe   called after setDocumentMaterials (the views drop their cached textures)
 *   planarUV(p, n, up) → [u, v] metres    where a point of a surface falls on its texture: u runs level along the surface,
 *                                          v runs up it (up a wall, up a roof's slope); a level surface takes u along X, v along Y
 *   planarUVs(positions, normals, up, scale = [1, 1]) → Float32Array    the same for every vertex of a mesh, divided by `scale`
 * Names are words in the language files: `render.mat.<id>`, categories `render.matcat.<cat>`.
 */

const M = (id, cat, color, look, tex = null, bump = 0.6) => ({ id, cat, color, rough: look[0], metal: look[1], glass: look[2] || 0, tex, bump });

export const CATEGORIES = ['brick', 'siding', 'roofing', 'wood', 'stone', 'tile', 'concrete', 'finish', 'ground', 'glass', 'metal'];

export const MATERIALS = [
  M('brick-red', 'brick', '#94503c', [0.85, 0], { kind: 'brick', color: '#9c4a35', mortar: '#bdb5a8', size: [0.9, 0.6], seed: 11 }),
  M('brick-brown', 'brick', '#6f4a38', [0.85, 0], { kind: 'brick', color: '#6e4632', mortar: '#a9a095', size: [0.9, 0.6], seed: 12 }),
  M('brick-buff', 'brick', '#c1a47c', [0.85, 0], { kind: 'brick', color: '#c9a777', mortar: '#d8d0c2', size: [0.9, 0.6], seed: 13 }),
  M('brick-painted', 'brick', '#e3dfd6', [0.75, 0], { kind: 'brick', color: '#e8e4dc', mortar: '#d6d0c5', size: [0.9, 0.6], seed: 14 }, 0.4),
  M('block-gray', 'brick', '#a4a19b', [0.9, 0], { kind: 'block', color: '#a7a49e', size: [0.8, 0.8], seed: 15 }),
  M('siding-white', 'siding', '#e8e4dc', [0.55, 0], { kind: 'siding', color: '#eeeae2', boards: 8, size: [1.2, 1.2], seed: 21 }, 0.8),
  M('siding-gray', 'siding', '#949ca0', [0.55, 0], { kind: 'siding', color: '#9aa3a6', boards: 8, size: [1.2, 1.2], seed: 22 }, 0.8),
  M('siding-blue', 'siding', '#6f8597', [0.55, 0], { kind: 'siding', color: '#748b9e', boards: 8, size: [1.2, 1.2], seed: 23 }, 0.8),
  M('siding-cedar', 'siding', '#9a6542', [0.7, 0], { kind: 'siding', color: '#a0673f', boards: 8, grain: true, size: [1.2, 1.2], seed: 24 }, 0.8),
  M('shingles-gray', 'roofing', '#5c5e61', [0.92, 0], { kind: 'shingles', color: '#5f6164', rows: 8, tabs: 6, size: [2.0, 1.14], seed: 31 }),
  M('shingles-brown', 'roofing', '#584536', [0.92, 0], { kind: 'shingles', color: '#5a4535', rows: 8, tabs: 6, size: [2.0, 1.14], seed: 32 }),
  M('shingles-cedar', 'roofing', '#86593c', [0.85, 0], { kind: 'shingles', color: '#8a5a3b', rows: 8, tabs: 12, size: [1.8, 1.0], seed: 33 }),
  M('roof-metal', 'roofing', '#4b5a63', [0.4, 0.6], { kind: 'seam', color: '#4b5a63', panels: 4, size: [1.6, 1.6], seed: 34 }, 0.5),
  M('tile-roof', 'roofing', '#a3583a', [0.7, 0], { kind: 'shingles', color: '#b0603e', rows: 6, tabs: 5, size: [1.5, 1.5], seed: 35 }),
  M('wood-oak', 'wood', '#a97c4f', [0.55, 0], { kind: 'planks', color: '#b58552', boards: 6, size: [2.4, 0.84], seed: 41 }, 0.3),
  M('wood-walnut', 'wood', '#644633', [0.5, 0], { kind: 'planks', color: '#6b4a32', boards: 6, size: [2.4, 0.84], seed: 42 }, 0.3),
  M('wood-pine', 'wood', '#c9a675', [0.6, 0], { kind: 'planks', color: '#d4b07a', boards: 6, size: [2.4, 0.84], figure: 0.8, seed: 43 }, 0.3),
  M('wood-deck', 'wood', '#938776', [0.8, 0], { kind: 'planks', color: '#9b8f7f', boards: 4, size: [2.4, 0.56], rough: 0.8, seed: 44 }, 0.6),
  M('stone-field', 'stone', '#8b867c', [0.85, 0], { kind: 'stone', color: '#8f8a80', cells: 7, size: [1.2, 1.2], seed: 51 }, 0.9),
  M('stone-limestone', 'stone', '#c8bb9f', [0.8, 0], { kind: 'stone', ashlar: true, color: '#cdbfa3', rows: 5, size: [1.5, 1.5], seed: 52 }, 0.6),
  M('stone-slate', 'stone', '#53585d', [0.6, 0], { kind: 'stone', ashlar: true, color: '#555a60', mortar: '#3f4246', rows: 6, size: [1.2, 1.2], seed: 53 }, 0.5),
  M('tile-white', 'tile', '#e6e3dc', [0.2, 0], { kind: 'tile', color: '#eceae4', tiles: 4, size: [1.2, 1.2], rough: 0.2, seed: 61 }, 0.3),
  M('tile-terracotta', 'tile', '#b2633f', [0.6, 0], { kind: 'tile', color: '#b8653f', grout: '#c9bfae', tiles: 4, size: [1.2, 1.2], rough: 0.6, seed: 62 }, 0.4),
  M('tile-gray', 'tile', '#7e8185', [0.35, 0], { kind: 'tile', color: '#83868a', grout: '#a5a39e', tiles: 2, size: [1.2, 1.2], rough: 0.35, seed: 63 }, 0.3),
  M('concrete', 'concrete', '#aeaaa3', [0.85, 0], { kind: 'concrete', color: '#b3afa8', size: [2.0, 2.0], seed: 71 }, 0.4),
  M('concrete-ties', 'concrete', '#a5a29c', [0.85, 0], { kind: 'concrete', color: '#aaa7a1', ties: true, size: [1.2, 1.2], seed: 72 }, 0.5),
  M('stucco-white', 'finish', '#e3ddd1', [0.9, 0], { kind: 'stucco', color: '#e7e1d5', size: [1.0, 1.0], seed: 81 }, 0.5),
  M('stucco-sand', 'finish', '#d0bd9b', [0.9, 0], { kind: 'stucco', color: '#d6c3a0', size: [1.0, 1.0], seed: 82 }, 0.5),
  M('grass', 'ground', '#5a7a39', [0.95, 0], { kind: 'grass', color: '#5d7f3a', size: [2.0, 2.0], seed: 91 }, 0.4),
  M('gravel', 'ground', '#968f84', [0.95, 0], { kind: 'gravel', color: '#9a948a', size: [1.0, 1.0], seed: 92 }, 1.0),
  M('glass-clear', 'glass', '#c9dbe6', [0.04, 0, 0.85]),
  M('glass-tinted', 'glass', '#6f8796', [0.04, 0, 0.7]),
  M('metal-steel', 'metal', '#9aa0a6', [0.35, 1]),
  M('metal-dark', 'metal', '#3d4247', [0.45, 1]),
];

const BY_ID = new Map(MATERIALS.map((m) => [m.id, m]));
const MINE = new Map();   // 0.7 MT.1: the open file's own materials (node graphs), id → entry
const LISTENERS = new Set();
export const material = (id) => (typeof id === 'string' && (BY_ID.get(id) || MINE.get(id))) || null;
export const isMaterialId = (id) => typeof id === 'string' && (BY_ID.has(id) || MINE.has(id));

/** The open file's node materials (MT.1). Ids the library already uses are left out. */
export function setDocumentMaterials(entries) {
  MINE.clear();
  for (const e of Array.isArray(entries) ? entries : []) if (e && typeof e.id === 'string' && !BY_ID.has(e.id)) MINE.set(e.id, e);
  for (const fn of LISTENERS) { try { fn(); } catch (err) { /* a listener's problem is its own */ } }
}
export const documentMaterials = () => [...MINE.values()];
export function onMaterialsChanged(fn) { LISTENERS.add(fn); return () => LISTENERS.delete(fn); }
/** The open file's decals (0.7 MT.6, shading/decal.js): every renderer draws each one on its placement with its own material. */
let DECALS = [];
export function setDocumentDecals(list) { DECALS = Array.isArray(list) ? list.slice() : []; for (const fn of LISTENERS) { try { fn(); } catch (err) { /* the listener's own */ } } }
export const documentDecals = () => DECALS;
/** A node material's baked layers ({base, data, emit: Uint8Array size² × 4 | null, size [w, h] metres, flags…}) | null. */
export function materialLayers(id, size = 512) {
  const m = MINE.get(id);
  return m && typeof m.layers === 'function' ? m.layers(size) : null;
}

/** u level along the surface, v up it (metres). n need not be unit length. */
export function planarUV(p, n, up = [0, 0, 1]) {
  const nl = Math.hypot(n[0], n[1], n[2]) || 1, nx = n[0] / nl, ny = n[1] / nl, nz = n[2] / nl;
  const ud = nx * up[0] + ny * up[1] + nz * up[2];
  let ux, uy, uz;
  if (Math.abs(ud) > 0.999) {
    // a level surface: u along the first axis square to up (X for Z up and for Y up), v along the other
    if (Math.abs(up[0]) < 0.9) { ux = 1; uy = 0; uz = 0; } else { ux = 0; uy = 1; uz = 0; }
    const vx = up[1] * uz - up[2] * uy, vy = up[2] * ux - up[0] * uz, vz = up[0] * uy - up[1] * ux;   // up × u
    return [p[0] * ux + p[1] * uy + p[2] * uz, p[0] * vx + p[1] * vy + p[2] * vz];
  }
  // u = up × n (level, along the surface), v = n × u (up the surface)
  ux = up[1] * nz - up[2] * ny; uy = up[2] * nx - up[0] * nz; uz = up[0] * ny - up[1] * nx;
  const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  return [p[0] * ux + p[1] * uy + p[2] * uz, p[0] * vx + p[1] * vy + p[2] * vz];
}

export function planarUVs(positions, normals, up = [0, 0, 1], scale = [1, 1]) {
  const n = positions.length / 3, out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const [u, v] = planarUV([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]], [normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]], up);
    out[i * 2] = u / scale[0]; out[i * 2 + 1] = v / scale[1];
  }
  return out;
}
