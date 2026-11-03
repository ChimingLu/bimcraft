/* SPDX-License-Identifier: Apache-2.0 */
/* i18n-ignore-file — pdf.js option names and errors for developers. */
/**
 * pdfhost.js — CadCraft's door to pdf.js (0.7 D7.24). A PDF is untrusted input: it is opened with eval and scripting off
 * (`isEvalSupported: false, enableScripting: false`, no XFA, no annotation layer), as MarkupCraft does, and read only for its
 * drawing: pages, vector shapes, text, optional-content layers, a picture of the page.
 *
 * pdf.js is loaded the first time a PDF is used: `import('pdfjs-dist')` through the app's import map (manifest "pdfjs-dist"),
 * the worker and data folders from data-pdf-* on <main> (`configurePdf({ root })`). Node tests pass the legacy build:
 * `configurePdf({ pdfjs })`.
 *
 *   configurePdf({ root | pdfjs, worker, cmaps, fonts, wasm, icc })
 *   sniffPdf(bytes)            → true when the bytes start a PDF (the "%PDF-" header within the first KB)
 *   await pdfInfo(rec)         → { pages, sizes: [[w, h] per page, displayed, points], layers: [{ id, name, on }] }     (rec = { name, bytes })
 *   await pageVector(rec, n, layers) → pdf-vector.js extractPage result, cached         (n = 1-based page; layers = { id: bool })
 *   await snapIndexOf(rec, n, layers)  → SnapIndex over the page's lines, in page points, cached
 *   await renderRegion(rec, n, { scale, x0, y0, w, h, hidden }) → a canvas of the page region (page points: x0, y0 lower-left,
 *                                w × h) at `scale` device pixels per point, transparent paper; `layers` = { id: on } over the file's layer defaults
 */
import { extractPage, segmentsOf, displaySize } from './pdf-vector.js';
import { SnapIndex } from './pdf-snap.js';

let cfg = {};
let libP = null;
export function configurePdf(o) { cfg = { ...cfg, ...(o?.root ? { worker: o.root.dataset.pdfWorker, cmaps: o.root.dataset.pdfCmaps, fonts: o.root.dataset.pdfFonts, wasm: o.root.dataset.pdfWasm, icc: o.root.dataset.pdfIcc } : {}), ...o }; delete cfg.root; libP = o?.pdfjs ? Promise.resolve(o.pdfjs) : libP; }

export function sniffPdf(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const head = new TextDecoder('latin1').decode(b.subarray(0, 1024));
  return b.length > 8 && head.includes('%PDF-');
}

async function lib() {
  if (!libP) libP = import('pdfjs-dist').then((m) => { if (cfg.worker && m.GlobalWorkerOptions) m.GlobalWorkerOptions.workerSrc = cfg.worker; return m; });
  return libP;
}

const docs = new WeakMap();   // rec → Promise<pdf.js document>
export async function openPdf(rec) {
  let p = docs.get(rec);
  if (!p) {
    p = (async () => {
      const pdfjs = await lib();
      return pdfjs.getDocument({
        data: rec.bytes.slice(), isEvalSupported: false, enableScripting: false, enableXfa: false, verbosity: 0,
        ...(cfg.cmaps ? { cMapUrl: cfg.cmaps, cMapPacked: true } : {}), ...(cfg.fonts ? { standardFontDataUrl: cfg.fonts } : {}),
        ...(cfg.wasm ? { wasmUrl: cfg.wasm } : {}), ...(cfg.icc ? { iccUrl: cfg.icc } : {}),
      }).promise;
    })();
    docs.set(rec, p);
    p.catch(() => docs.delete(rec));
  }
  return p;
}

const infos = new WeakMap();
export async function pdfInfo(rec) {
  let p = infos.get(rec);
  if (!p) {
    p = (async () => {
      const doc = await openPdf(rec);
      const sizes = [];
      for (let i = 1; i <= Math.min(doc.numPages, 500); i++) { const pg = await doc.getPage(i); sizes.push(displaySize(pg.view, pg.rotate || 0)); }
      let layers = [];
      try {
        const cfgOc = await doc.getOptionalContentConfig();
        for (const [id, g] of cfgOc) layers.push({ id, name: String(g.name || id).slice(0, 120), on: g.visible !== false });
      } catch { layers = []; }
      return { pages: doc.numPages, sizes, layers };
    })();
    infos.set(rec, p);
    p.catch(() => infos.delete(rec));
  }
  return p;
}

const vecs = new WeakMap();   // rec → Map("page|layers" → Promise)
const done = new WeakMap();   // rec → Map("page|layers" → the result, once read)
const lkey = (l) => Object.keys(l || {}).sort().map((k) => k + (l[k] ? '+' : '-')).join(',');
/** The file's optional-content config with a placement's own layer settings ({ id: true|false }) applied. */
async function ocConfig(doc, layers) {
  const oc = await doc.getOptionalContentConfig();
  for (const [id, on] of Object.entries(layers || {})) { try { oc.setVisibility(id, !!on); } catch { /* an id this file lacks */ } }
  return oc;
}
/** A page's vectors, with the PDF's layers as the file sets them and `layers` ({ id: bool }) over them. Cached. */
export async function pageVector(rec, n, layers = {}) {
  const k = n + '|' + lkey(layers);
  let m = vecs.get(rec);
  if (!m) vecs.set(rec, (m = new Map()));
  if (!m.has(k)) {
    m.set(k, (async () => {
      const pdfjs = await lib(), doc = await openPdf(rec);
      const oc = await ocConfig(doc, layers).catch(() => null);
      const v = await extractPage(pdfjs, await doc.getPage(n), { isVisible: oc ? (g) => { try { return oc.isVisible(g); } catch { return true; } } : null });
      let d = done.get(rec);
      if (!d) done.set(rec, (d = new Map()));
      d.set(k, v);
      return v;
    })());
    m.get(k).catch(() => m.delete(k));
  }
  return m.get(k);
}
/** The page's vectors if they have been read (pageVector), else null: for code that cannot wait (plot.js displayList). */
export function peekVector(rec, n, layers = {}) { return done.get(rec)?.get(n + '|' + lkey(layers)) || null; }
/** Read the vectors of every PDF page a drawing's underlays use, so a plot can print them. → how many pages could not be read */
export async function preparePdfs(doc, refs) {
  let failed = 0;
  for (const { rec, page, layers } of refs) { try { await pageVector(rec, page, layers); } catch { failed++; } }
  return failed;
}

const snaps = new WeakMap();
export async function snapIndexOf(rec, n, layers = {}) {
  const k = n + '|' + lkey(layers);
  let m = snaps.get(rec);
  if (!m) snaps.set(rec, (m = new Map()));
  if (!m.has(k)) m.set(k, pageVector(rec, n, layers).then((v) => new SnapIndex(segmentsOf(v))));
  return m.get(k);
}

/** A region of a page drawn on a canvas, paper transparent. Region and scale in page points / device pixels per point. */
export async function renderRegion(rec, n, { scale, x0 = 0, y0 = 0, w, h, layers = {} }) {
  const doc = await openPdf(rec), page = await doc.getPage(n);
  const vp = page.getViewport({ scale });
  const W = Math.max(1, Math.ceil(w * scale)), H = Math.max(1, Math.ceil(h * scale));
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = canvas.getContext('2d');
  // viewport pixels: x right, y down from the displayed page's top-left; the region's top-left in them
  const top = vp.height - (y0 + h) * scale, left = x0 * scale;
  const params = { canvas, canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -left, -top], background: 'rgba(255,255,255,0)', annotationMode: 0 };
  if (Object.keys(layers).length) params.optionalContentConfigPromise = ocConfig(doc, layers);
  await page.render(params).promise;
  return canvas;
}
