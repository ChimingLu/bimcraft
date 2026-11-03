/* SPDX-License-Identifier: Apache-2.0 */
/**
 * shading/library.js — LibraryCraft's materials in the apps (0.7 MT.3, session `materials`): list them, fetch one (its item and
 * its pictures, every picture checked against the sha256 the item lists), and turn it into a node material of the file. No DOM
 * (fetch + crypto.subtle: the page and Node 18+). Everything fetched is untrusted: the item's graph goes through cleanGraph, its
 * pictures are only bytes until the page decodes them.
 *
 *   API                                     '/api/v1/library' (same origin, as BimCraft's and CadCraft's library panels)
 *   listMaterials({fetch, base}) → [{uuid, slug, name, category, version, license, preview_url, item_url, page_url}]
 *   loadMaterial(entry, {fetch}) → {item, pictures: {role: {media, bytes: Uint8Array, file}}}   throws {code: 'not_material' |
 *                                    'bad_graph' | 'sha256' | 'too_big' | 'fetch'}
 *   graphFor(item, keyOf(role) → picture key) → graph   the item's graph with its 'map:<role>' pictures renamed to the file's
 *   sourceOf(item, entry) → source           {library: 'librarycraft', uuid, version, license, attribution, url} (doc.js)
 *   MAX_PICTURE_BYTES                        32 MB (LibraryCatalog::MAX_MAP_BYTES)
 */
import { cleanGraph } from './graph.js';

export const API = '/api/v1/library';
export const MAX_PICTURE_BYTES = 32 * 1024 * 1024;
const ROLES = new Set(['color', 'roughness', 'gloss', 'metalness', 'normal', 'height', 'ao', 'opacity', 'emission']);
const MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp']);
const fail = (code, message = code) => Object.assign(new Error(message), { code });

export async function listMaterials({ fetch: f = globalThis.fetch, base = '' } = {}) {
  const r = await f(base + API + '/items?kind=material&per=100', { headers: { Accept: 'application/json' } });
  if (!r.ok) throw fail('fetch', 'HTTP ' + r.status);
  const j = await r.json();
  const items = Array.isArray(j?.data?.items) ? j.data.items : [];
  return items.filter((x) => x && x.kind === 'material' && typeof x.uuid === 'string' && typeof x.item_url === 'string').map((x) => ({
    uuid: x.uuid, slug: String(x.slug || ''), name: String(x.name || '').slice(0, 200), category: String(x.category || ''), version: x.version | 0,
    license: String(x.license || ''), preview_url: typeof x.preview_url === 'string' ? x.preview_url : null, item_url: x.item_url,
    page_url: x.slug ? '/library/item/' + String(x.slug).replace(/[^a-z0-9-]/g, '') : '',
  }));
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function loadMaterial(entry, { fetch: f = globalThis.fetch } = {}) {
  const r = await f(entry.item_url);
  if (!r.ok) throw fail('fetch', 'HTTP ' + r.status);
  const item = await r.json();
  const m = item && item.kind === 'material' ? item.material : null;
  if (!m || typeof m.graph !== 'string' || !m.maps || typeof m.maps !== 'object') throw fail('not_material');
  let g;
  try { g = JSON.parse(m.graph); } catch (e) { throw fail('bad_graph'); }
  if (!g || g.format !== 'cc-material') throw fail('bad_graph');
  // the pictures sit beside the item: /library/file/<version id>/map/<role> (the server serves only what this version lists)
  const where = new URL(r.url || entry.item_url, globalThis.location?.href || 'https://getcadcraft.com/');
  const vid = /\/library\/file\/(\d+)\/item\.json$/.exec(where.pathname)?.[1];
  if (!vid) throw fail('fetch', 'no version');   // i18n-ignore: the code is what the caller shows; the text is for the log
  const pictures = {};
  for (const [role, p] of Object.entries(m.maps)) {
    if (!ROLES.has(role) || !p || !MEDIA.has(p.media) || !/^[0-9a-f]{64}$/.test(p.sha256 || '')) continue;
    if (!(p.bytes > 0 && p.bytes <= MAX_PICTURE_BYTES)) throw fail('too_big');
    const pr = await f(new URL('/library/file/' + vid + '/map/' + role, where).href);
    if (!pr.ok) throw fail('fetch', 'HTTP ' + pr.status);
    const bytes = new Uint8Array(await pr.arrayBuffer());
    if (bytes.length > MAX_PICTURE_BYTES) throw fail('too_big');
    if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== p.sha256) throw fail('sha256', role);
    pictures[role] = { media: p.media, bytes, file: String(p.file || role).slice(0, 120) };
  }
  return { item, pictures };
}

export function graphFor(item, keyOf) {
  const g = cleanGraph(JSON.parse(item.material.graph)).graph;
  for (const n of g.nodes) {
    if (n.type === 'image' && typeof n.params.image === 'string' && n.params.image.startsWith('map:')) n.params.image = keyOf(n.params.image.slice(4)) || '';
    if (n.type === 'wear') for (const k of ['curvature', 'occlusion']) if (typeof n.params[k] === 'string' && n.params[k].startsWith('map:')) n.params[k] = keyOf(n.params[k].slice(4)) || '';
  }
  const out = g.nodes.find((n) => n.type === 'output');
  const sz = item.material.size;
  if (out && Array.isArray(sz) && sz.length === 2 && sz.every((x) => x > 0 && x <= 1000)) { out.params.width = sz[0]; out.params.height = sz[1]; }
  g.name = String(item.name || '').slice(0, 80);
  return cleanGraph(g).graph;
}

export function sourceOf(item, entry) {
  const page = entry.page_url ? new URL(entry.page_url, globalThis.location?.href || 'https://getcadcraft.com/').href : '';
  return { library: 'librarycraft', uuid: String(item.uuid || entry.uuid), version: item.version | 0 || entry.version, license: String(item.license?.id || entry.license || ''),
    attribution: String(item.license?.attribution || ''), url: /^https:\/\//.test(page) ? page : '' };
}
