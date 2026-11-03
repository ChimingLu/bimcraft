/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file: HTML and CSS of the exported file (its words come in through `words`) */
/**
 * rt-export.js — the standalone viewer as one HTML file (0.7 RT.4, session `realtime`). Canonical in modelcraft/dev/rt/
 * (tools/rt/sync.mjs). The file opens offline from anywhere (a folder, a USB stick, an email) in a browser with WebGPU or
 * WebGL 2; it holds the scene, the viewer's own modules (ours and three.js's, MIT, with its notice) and nothing else: a
 * Content-Security-Policy forbids every request, so it can't reach the internet, has no account and no tracking.
 *
 *   await exportScene({rt, plain, settings, views, title, words, maxScatter}) → scene   (format 'cadcraft-live-scene', version 1)
 *     geometry (each geometry once), placements, every material worked out (rt-mats.js resolveMaterial: textures as PNG), lamps,
 *     the scatter (≤ maxScatter instances, 250 000 by default: a file stays a file), the baked bounce light, the views, the start camera
 *   await bundle({entries, importMap, base, skip}) → [{key, source}]   every module the entries reach (static and dynamic imports
 *     with a literal name), fetched from this site, each import renamed to the bundle's own '@cc/<path>' names; `skip` = path
 *     endings never needed by the viewer (the path tracer: resolved materials and baked light need none of it)
 *   viewerHtml({title, modules, scene, entry, lang}) → string   the file
 */
import { resolveMaterial } from './rt-mats.js';

const VERSION = 1;
export const VIEWER_SKIP = ['/render/pt-pack.js', '/render/pt-ref-job.js', '/render/pt-sampler.js', '/render/materials.js', '/render/three-mats.js',
  '/rt/rt-scatter-ui.js', '/rt/rt-view.js', '/rt/rt-export.js', '/compute/runtime.js', '/rt/rt-probe-job.js'];

/** A typed array's bytes as base64 (in pieces: big arrays never go through one huge string call). */
export function toB64(a) {
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function exportScene({ rt, plain, settings = {}, views = [], title = '', words = {}, maxScatter = 250000 }) {
  const geos = new Map(), geometries = [];
  const items = [];
  for (const it of plain.items) {
    if (!it.geometry) continue;
    let gi = geos.get(it.geometry);
    if (gi === undefined) {
      const g = it.geometry, P = g.getAttribute('position'), N = g.getAttribute('normal'), U = g.getAttribute('uv');
      geometries.push({ position: toB64(Float32Array.from(P.array)), normal: N ? toB64(Float32Array.from(N.array)) : null, uv: U ? toB64(Float32Array.from(U.array)) : null, index: g.index ? toB64(Uint32Array.from(g.index.array)) : null });
      gi = geometries.length - 1;
      geos.set(it.geometry, gi);
    }
    items.push({ g: gi, m: it.matrix ? Array.from(it.matrix) : null, look: it.look || 'default', lines: !!it.lines });
  }
  const resolved = {};
  for (const k of new Set(['__ground', 'default', ...items.filter((x) => !x.lines).map((x) => x.look)])) resolved[k] = await resolveMaterial(k, settings, plain);
  let left = maxScatter;
  const scatter = [], used = new Set();
  for (const s of plain.scatter || []) {
    const n = Math.min(s.result.count, Math.max(0, left));
    if (!n) continue;
    left -= n;
    for (let i = 0; i < n; i++) used.add(s.slugs[s.result.item[i]]);
    scatter.push({ count: n, matrices: toB64(s.result.matrices.subarray(0, n * 16)), item: toB64(s.result.item.subarray(0, n)), slugs: s.slugs });
  }
  const scatterLibrary = (plain.scatterLibrary || []).filter((e) => used.has(e.slug)).map((e) => ({ slug: e.slug, parts: e.parts.map((p) => ({ color: p.color, alpha: p.alpha ?? 1, P: toB64(Float32Array.from(p.P)), I: toB64(Uint32Array.from(p.I)) })) }));
  const g = rt.giProbes && rt.giProbes.data;
  const cam = rt.camera;
  return {
    format: 'cadcraft-live-scene', version: VERSION, title, words,
    up: plain.up, bounds: plain.bounds, groundAt: plain.groundAt ?? 0, sun: plain.sun || null, clip: plain.clip || [], defaultColor: plain.defaultColor,
    settings: { sky: settings.sky, ground: settings.ground, edges: settings.edges, exposure: settings.exposure, exposureMode: settings.exposureMode, fstop: settings.fstop, shutter: settings.shutter, iso: settings.iso, whiteBalance: settings.whiteBalance, post: settings.post },
    geometries, items, resolved, lights: plain.lights || [], scatter, scatterLibrary,
    gi: g ? { min: g.min, max: g.max, res: g.res, sh: toB64(g.sh) } : null,
    views: views.map((v) => ({ name: v.name, world: Array.from(v.world), proj: Array.from(v.proj) })),
    start: { world: cam.matrixWorld.elements.slice(), proj: cam.projectionMatrix.elements.slice() },
  };
}

const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g;
const commentLine = /^\s*(\*|\/\/|\/\*)/;

export async function bundle({ entries, importMap, base = location.href, skip = VIEWER_SKIP }) {
  const map = (importMap && importMap.imports) || {};
  const keyOf = (url) => { const u = new URL(url, base); return u.pathname; };
  const resolve = (spec, from) => {
    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) return new URL(spec, from).href;
    if (map[spec]) return new URL(map[spec], base).href;
    for (const [k, v] of Object.entries(map)) if (k.endsWith('/') && spec.startsWith(k)) return new URL(v + spec.slice(k.length), base).href;
    return null;
  };
  // the page's import map versions the app's own files (?v=): fetch through it when it names the file
  const busted = (url) => { const p = keyOf(url); return map[p] ? new URL(map[p], base).href : url; };
  const out = new Map(), queue = entries.map((e) => new URL(e, base).href);
  while (queue.length) {
    const url = queue.shift(), key = keyOf(url);
    if (out.has(key)) continue;
    const r = await fetch(busted(url));
    if (!r.ok) throw new Error('bundle: ' + key + ' ' + r.status);
    const src = await r.text();
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (commentLine.test(lines[i])) continue;
      lines[i] = lines[i].replace(IMPORT_RE, (m, head, q, spec) => {
        const to = resolve(spec, url);
        if (!to) return m;
        const k = keyOf(to);
        if (skip.some((s) => k.endsWith(s))) return head + q + '@cc-absent' + k + q;   // never run in the viewer
        if (!out.has(k)) queue.push(to);
        return head + q + '@cc' + k + q;
      });
    }
    out.set(key, lines.join('\n'));
  }
  return [...out].map(([key, source]) => ({ key: '@cc' + key, source }));
}

/** Text safe inside <script type="text/plain">: no "</script" and no "<!--" can end or bend the element (same meaning in JS). */
const safeScript = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function viewerHtml({ title, modules, scene, entry, lang = 'en', notice = '' }) {
  const parts = [];
  parts.push('<!doctype html>\n<html lang="' + esc(lang) + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' blob:; style-src \'unsafe-inline\'; img-src data: blob:; worker-src blob:">\n'
    + '<title>' + esc(title) + '</title>\n<style>html,body{margin:0;height:100%;background:#000;color:#eee;font:14px/1.3 system-ui,sans-serif;overflow:hidden}'
    + 'canvas{position:fixed;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none}'
    + '.bar{position:fixed;left:0;right:0;top:0;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px;background:rgba(0,0,0,.45)}'
    + '.bar h1{font-size:14px;margin:0 8px 0 0}.bar button{font:inherit;padding:3px 8px}.bar button[aria-pressed=true]{background:#1d4f91;color:#fff}'
    + '.views{display:flex;flex-wrap:wrap;gap:6px}.st{position:fixed;left:8px;bottom:8px;margin:0;opacity:.8}</style></head>\n<body>\n');
  if (notice) parts.push('<!-- ' + esc(notice).replace(/--/g, '- -') + ' -->\n');
  for (const m of modules) parts.push('<script type="text/plain" data-mod="' + esc(m.key) + '">' + safeScript(m.source) + '</script>\n');
  parts.push('<script type="application/json" id="cc-scene">' + JSON.stringify(scene).replace(/</g, '\\u003c') + '</script>\n');
  // a classic script (runs first, in order): each module's text becomes a blob: URL under its bundle name in an import map,
  // then the viewer's entry runs as a module; nothing is fetched from anywhere
  const boot = 'import { start } from ' + JSON.stringify(entry) + '; start(JSON.parse(document.getElementById("cc-scene").textContent));';
  parts.push('<script>\n(function () {\n  var imports = {};\n  document.querySelectorAll("script[data-mod]").forEach(function (s) { imports[s.dataset.mod] = URL.createObjectURL(new Blob([s.textContent], { type: "text/javascript" })); });\n'
    + '  var im = document.createElement("script"); im.type = "importmap"; im.textContent = JSON.stringify({ imports: imports }); document.head.appendChild(im);\n'
    + '  var m = document.createElement("script"); m.type = "module"; m.textContent = ' + safeScript(JSON.stringify(boot)) + ';\n'
    + '  document.body.appendChild(m);\n})();\n</script>\n</body></html>\n');
  return parts.join('');
}
