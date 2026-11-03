/* SPDX-License-Identifier: Apache-2.0 */
/**
 * shading/doc.js — the open file's own materials (0.7 MT.1): node graphs by id, saved beside the model (like its imported
 * pictures, outside the model's undo; the editor keeps its own undo). No DOM. Faces wear one as paint 'mat:<id>', exactly as a
 * library material, because `publish()` registers every material with render/materials.js — the 3D views, exports, the fast
 * render and the path tracer then find it by `material(id)`.
 *
 *   new MaterialTable({resolveImage(key) → Promise<{w, h, data}> | null})   resolveImage: pictures that are not library textures
 *   create(name, graph?, source?) → id   duplicate(id) → id   remove(id)   rename(id, name)   setGraph(id, graph)
 *     source (MT.3): where a material came from — {library: 'librarycraft', uuid, version, license, attribution, url} — kept with
 *     it in the file (its credit) and shown in the Shading panel; findSource(uuid, version) → id | null
 *   get(id) → {id, graph, rev} | null      list() → [that]      has(id)      size
 *   prepare(id?) → Promise<n>     loads the pictures a graph (or every graph) reads; bake() is synchronous and uses them (a picture
 *                                  not loaded yet reads grey; when it arrives the graphs that read it get a new revision)
 *   bake(id, size = 512) → bake (shading/bake.js), kept until the graph changes; adopt(id, size, bake) stores one made on the GPU
 *   entry(id) → the materials.js entry           publish() → registers every entry (render/materials.js setDocumentMaterials)
 *   toJSON() → {format: 'cc-materials', version: 1, materials: [{id, graph, source?}]} | null (no materials)
 *   load(json) → {count, dropped}   untrusted: every graph goes through cleanGraph; at most LIMIT materials
 *   onChange(fn) → unsubscribe      (id | null) after every change
 *   touchImage(key)                  a picture changed in place (painting): what reads it bakes again
 *   pictureIds() → [id]              the model pictures ('img:<id>') any graph reads (the file keeps them)
 *   ID_RE  material ids: 'm' + 8 base-36 characters (the 'mat:<id>' paint form ModelCraft's kernel accepts)
 *   decals (MT.6, shading/decal.js): addDecal(decal) → id   updateDecal(id, decal)   removeDecal(id)   decal(id)   decalList()
 *     saved in toJSON as `decals`; a decal whose material is gone is left out on load; removing a material removes its decals.
 *     publish() also registers them (render/materials.js setDocumentDecals)
 */
import { newGraph, cleanGraph } from './graph.js';
import { bakeMaterial } from './bake.js';
import { imageKeys, libraryImage } from './images.js';
import { setDocumentMaterials, setDocumentDecals, material as libMaterial } from '../render/materials.js';
import { cleanDecal, newDecalId, LIMIT as DECAL_LIMIT } from './decal.js';

export const ID_RE = /^m[a-z0-9]{8}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A material's source from untrusted data (a file): only these fields, as plain text, or null. */
export function cleanSource(s) {
  if (!s || typeof s !== 'object' || s.library !== 'librarycraft' || typeof s.uuid !== 'string' || !UUID_RE.test(s.uuid) || !Number.isInteger(s.version) || s.version < 1) return null;
  const txt = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const url = txt(s.url, 500);
  return { library: 'librarycraft', uuid: s.uuid.toLowerCase(), version: s.version, license: txt(s.license, 20), attribution: txt(s.attribution, 500), url: /^https:\/\//.test(url) ? url : '' };
}
export const LIMIT = 512;
const PREVIEW = 64;   // the bake the colour from afar comes from (fast; the renderer's is full size)

export class MaterialTable {
  constructor({ resolveImage = null } = {}) {
    this.mats = new Map();
    this.images = new Map();
    this.bakes = new Map();
    this.resolveImage = resolveImage;
    this.listeners = new Set();
    this.decals = new Map();
  }
  get size() { return this.mats.size; }
  has(id) { return this.mats.has(id); }
  get(id) { return this.mats.get(id) || null; }
  list() { return [...this.mats.values()]; }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _changed(id) { for (const fn of this.listeners) { try { fn(id); } catch (e) { /* the listener's own problem */ } } }

  newId() {
    for (;;) {
      let s = 'm';
      for (let i = 0; i < 8; i++) s += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)];
      if (!this.mats.has(s) && !libMaterial(s)) return s;
    }
  }
  create(name, graph = null, source = null) {
    const id = this.newId(), g = graph ? cleanGraph(graph).graph : newGraph(name);
    if (name) g.name = String(name).slice(0, 80);
    this.mats.set(id, { id, graph: g, rev: 1, ...(cleanSource(source) ? { source: cleanSource(source) } : {}) });
    this.publish(); this._changed(id);
    return id;
  }
  duplicate(id) {
    const m = this.get(id);
    return m ? this.create(m.graph.name, JSON.parse(JSON.stringify(m.graph)), m.source || null) : null;
  }
  findSource(uuid, version) { for (const m of this.mats.values()) if (m.source && m.source.uuid === uuid && m.source.version === version) return m.id; return null; }
  remove(id) {
    if (!this.mats.delete(id)) return;
    for (const d of [...this.decals.values()]) if (d.material === id) this.decals.delete(d.id);
    this._drop(id); this.publish(); this._changed(id);
  }
  // ---- decals (MT.6) ----
  addDecal(d) {
    if (this.decals.size >= DECAL_LIMIT) return null;
    const c = cleanDecal({ ...d, id: d.id && !this.decals.has(d.id) ? d.id : newDecalId((x) => this.decals.has(x)) });
    if (!c || !this.mats.has(c.material)) return null;
    this.decals.set(c.id, c); this.publish(); this._changed(null);
    return c.id;
  }
  updateDecal(id, d) {
    if (!this.decals.has(id)) return false;
    const c = cleanDecal({ ...this.decals.get(id), ...d, id });
    if (!c || !this.mats.has(c.material)) return false;
    this.decals.set(id, c); this.publish(); this._changed(null);
    return true;
  }
  removeDecal(id) { if (this.decals.delete(id)) { this.publish(); this._changed(null); } }
  decal(id) { return this.decals.get(id) || null; }
  decalList() { return [...this.decals.values()]; }
  rename(id, name) { const m = this.get(id); if (m) { m.graph.name = String(name).slice(0, 80); m.rev++; this.publish(); this._changed(id); } }
  setGraph(id, graph) {
    const m = this.get(id);
    if (!m) return;
    m.graph = cleanGraph(graph).graph; m.rev++;
    this._drop(id); this.publish(); this._changed(id);
  }
  _drop(id) { for (const k of [...this.bakes.keys()]) if (k.startsWith(id + '@')) this.bakes.delete(k); }

  async prepare(id = null) {
    const keys = new Set();
    for (const m of id ? [this.get(id)].filter(Boolean) : this.list()) for (const k of imageKeys(m.graph)) keys.add(k);
    const fresh = new Set();
    for (const k of keys) {
      if (this.images.get(k)) continue;
      if (k.startsWith('lib:')) { const [, mid, which] = k.split(':'); this.images.set(k, libraryImage(mid, which)); continue; }
      let im = null;
      try { im = this.resolveImage ? await this.resolveImage(k) : null; } catch (e) { im = null; }
      this.images.set(k, im);
      if (im) fresh.add(k);
    }
    // a graph whose pictures just arrived bakes again (its earlier bake read them as grey): a new revision, so the views refresh
    let any = false;
    for (const m of this.list()) if (imageKeys(m.graph).some((k) => fresh.has(k))) { m.rev++; this._drop(m.id); any = true; }
    if (any) { this.publish(); this._changed(null); }
    return fresh.size;
  }
  /** Forget a picture (its image changed or went): the graphs that read it bake again. */
  forgetImage(key) { if (this.images.delete(key)) for (const m of this.list()) if (imageKeys(m.graph).includes(key)) { m.rev++; this._drop(m.id); } }
  /** A picture was changed in place (MT.6 painting): the graphs that read it bake again, keeping the picture. */
  touchImage(key) {
    let any = false;
    for (const m of this.list()) if (imageKeys(m.graph).includes(key)) { m.rev++; this._drop(m.id); any = true; }
    if (any) { this.publish(); this._changed(null); }
    return any;
  }
  /** The pictures for a bake: prepared ones, library textures made on the spot (they need no decoding). */
  imageMap(graph) {
    const map = new Map();
    for (const k of imageKeys(graph)) {
      let im = this.images.get(k);
      if (im === undefined && k.startsWith('lib:')) { const [, mid, which] = k.split(':'); im = libraryImage(mid, which); this.images.set(k, im); }
      if (im) map.set(k, im);
    }
    return map;
  }
  bake(id, size = 512) {
    const m = this.get(id);
    if (!m) return null;
    const key = id + '@' + size, have = this.bakes.get(key);
    if (have && have.rev === m.rev) return have.bake;
    const bake = bakeMaterial(m.graph, { size, images: this.imageMap(m.graph) });
    this.bakes.set(key, { rev: m.rev, bake });
    return bake;
  }
  adopt(id, size, bake) { const m = this.get(id); if (m) this.bakes.set(id + '@' + size, { rev: m.rev, bake }); }

  entry(id) {
    const T = this, m = this.get(id);
    if (!m) return null;
    const rev = m.rev, small = () => T.bake(id, PREVIEW);
    return {
      id, cat: 'mine', node: true, tex: null, bump: 0, rev,
      get name() { return T.get(id)?.graph.name || ''; },
      get color() { return small().color; },
      get rough() { return small().rough; },
      get metal() { return small().metal; },
      get glass() { return small().glass; },
      get pbr() { return T.bake(id, 512).pbr; },
      get size() { return small().size; },
      get mapping() { return small().mapping; },
      bake: (size = 512) => T.bake(id, size),
      layers: (size = 512) => {
        const b = T.bake(id, size), L = b.layers;
        if (!L.base && !L.data && !L.emit) return null;
        return { base: L.base, data: L.data, emit: L.emit, size: b.size, rough: b.flags.rough, normal: b.flags.normal, metal: b.flags.metal,
          opacity: b.flags.opacity, mapping: b.mapping, sharpness: b.sharpness, normalStrength: b.normalStrength };
      },
    };
  }
  publish() { setDocumentMaterials(this.list().map((m) => this.entry(m.id))); setDocumentDecals(this.decalList()); }
  pictureIds() { const s = new Set(); for (const m of this.list()) for (const k of imageKeys(m.graph)) if (k.startsWith('img:')) s.add(k.slice(4)); return [...s]; }

  toJSON() {
    if (!this.mats.size) return null;
    return { format: 'cc-materials', version: 1, materials: this.list().map((m) => ({ id: m.id, graph: m.graph, ...(m.source ? { source: m.source } : {}) })),
      ...(this.decals.size ? { decals: this.decalList() } : {}) };
  }
  load(j) {
    this.mats.clear(); this.bakes.clear(); this.decals.clear();
    let dropped = 0;
    if (j && j.format === 'cc-materials' && Array.isArray(j.materials)) {
      for (const x of j.materials) {
        if (this.mats.size >= LIMIT || !x || typeof x.id !== 'string' || !ID_RE.test(x.id) || this.mats.has(x.id)) { dropped++; continue; }
        const r = cleanGraph(x.graph);
        dropped += r.dropped ? 1 : 0;
        const src = cleanSource(x.source);
        this.mats.set(x.id, { id: x.id, graph: r.graph, rev: 1, ...(src ? { source: src } : {}) });
      }
      for (const x of Array.isArray(j.decals) ? j.decals : []) {
        const c = this.decals.size < DECAL_LIMIT ? cleanDecal(x) : null;
        if (!c || this.decals.has(c.id) || !this.mats.has(c.material)) { dropped++; continue; }
        this.decals.set(c.id, c);
      }
    } else if (j) dropped++;
    this.publish(); this._changed(null);
    return { count: this.mats.size, dropped };
  }
}
