/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-present.js — the live view's Share menu: presentations out of the real-time view (0.7 RT.4, session `realtime`). Canonical
 * in modelcraft/dev/rt/ (tools/rt/sync.mjs). Mounted by rt-view.js; everything is made on this computer and saved with the
 * adapter's download().
 *
 *   createShareMenu({h, t, adapter, ctx}) → {el, spots, run(kind)}   ctx = {rt(), plain(), settings(), eye() → {p, forward},
 *     rebuild() (the live scene back after a video), busy(text | null), hold(on) (the view's loop pauses while a share runs)}
 *   Panorama      a 360° equirectangular PNG from where the view stands (the walker's eye when walking)
 *   Add this spot / Save tour   tour spots, then one HTML file: each spot's panorama and arrows to the spots it can see
 *                 (line of sight through the model: rt-walk.js's BVH), our own small viewer, nothing loaded from anywhere
 *   Save viewer   the standalone viewer (rt-export.js): the model, its views, Walk, in one HTML file that opens offline
 *   Video         the app's animation path (its timeline, else its scenes) in the real-time look: WebM / MP4 through the
 *                 browser's encoder (render/video.js), else numbered PNGs in a ZIP
 *   Sizes follow the tier: a panorama face 256 / 512 / 1024 px (low / medium / high).
 */
import { walkScene } from './rt-walk.js';
import { sceneOccluded } from '../compute/bvh-scene.js';

const FACE = { low: 256, medium: 512, high: 1024 };

export function createShareMenu({ h, t, adapter, ctx }) {
  const spots = [];
  const list = h('ol', { className: 'rt-share-spots' });
  const btn = (kind, label, title) => { const b = h('button', { type: 'button', text: label, title: title || '' }); b.dataset.share = kind; b.addEventListener('click', () => run(kind)); return b; };
  const menu = h('div', { className: 'rt-share-list', role: 'menu' },
    btn('pano', t('rt.share.pano'), t('rt.share.pano.title')),
    btn('spot', t('rt.share.spot'), t('rt.share.spot.title')), list, btn('tour', t('rt.share.tour'), t('rt.share.tour.title')),
    btn('viewer', t('rt.share.viewer'), t('rt.share.viewer.title')),
    adapter.animation ? btn('video', t('rt.share.video'), t('rt.share.video.title')) : null);
  const el = h('details', { className: 'rt-share' }, h('summary', { text: t('rt.share') }), menu);
  const base = () => (adapter.fileBase ? adapter.fileBase() : 'model');
  const face = () => FACE[ctx.rt().info.preset.quality] || 512;
  // i18n-ignore-next-line: × is a symbol (its words are the title and the label)
  const listSpots = () => list.replaceChildren(...spots.map((s, i) => h('li', {}, h('span', { text: s.name }), h('button', { type: 'button', text: '×', title: t('rt.share.spot.remove', { name: s.name }), 'aria-label': t('rt.share.spot.remove', { name: s.name }), onclick: () => { spots.splice(i, 1); listSpots(); } }))));

  async function run(kind) {
    const rt = ctx.rt();
    if (!rt) return;
    el.open = false;
    // The live view's own loop stays out of the renderer while a share draws with it (a scene rebuild in the middle of a video
    // swapped the passes under readPixels: "Unsupported WebGL type: undefined"); it redraws, and rebuilds if the app changed, after.
    ctx.hold?.(true);
    try { await runKind(kind, rt); } finally { ctx.hold?.(false); }
  }
  async function runKind(kind, rt) {
    try {
      if (kind === 'pano') {
        ctx.busy(t('rt.share.busy.pano'));
        const e = ctx.eye();
        const p = await rt.panorama({ position: e.p, forward: e.forward, faceSize: face() });
        adapter.download(p.blob, base() + '-360.png');
      } else if (kind === 'spot') {
        const e = ctx.eye();
        spots.push({ name: t('rt.share.spot.name', { n: spots.length + 1 }), p: e.p, forward: e.forward });
        listSpots();
        el.open = true;
      } else if (kind === 'tour') {
        if (spots.length < 1) { ctx.busy(t('rt.share.tour.none')); setTimeout(() => ctx.busy(null), 2500); return; }
        const { tourHtml, hotspots, panoFrame } = await import('./rt-pano.js');
        const bvh = walkScene(ctx.plain(), { ground: false });
        const done = [];
        for (const [i, s] of spots.entries()) {
          ctx.busy(t('rt.share.busy.tour', { n: i + 1, of: spots.length }));
          const p = await rt.panorama({ position: s.p, forward: s.forward, faceSize: face() });
          done.push({ ...s, frame: p.frame || panoFrame(s.forward, ctx.plain().up), png: await dataUrl(p.blob) });
        }
        const sees = (a, b) => { const d = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]], L = Math.hypot(...d); return L > 0 && !sceneOccluded(bvh, a.p, d.map((x) => x / L), L - 0.05); };
        const hs = hotspots(done, sees);
        const html = tourHtml({ title: t('rt.share.tour.file', { name: base() }), spots: done.map((s, i) => ({ name: s.name, png: s.png, hotspots: hs[i] })), words: { canvas: t('rt.share.tour.canvas'), hint: t('rt.share.tour.hint'), go: t('rt.share.tour.go'), lang: document.documentElement.lang || 'en' } });
        adapter.download(new Blob([html], { type: 'text/html' }), base() + '-tour.html');
      } else if (kind === 'viewer') {
        ctx.busy(t('rt.share.busy.viewer'));
        const [{ exportScene, bundle, viewerHtml }] = await Promise.all([import('./rt-export.js')]);
        const plain = ctx.plain(), settings = ctx.settings();
        const views = adapter.views ? adapter.views(rt.camera.aspect || 1.5) : [];
        const words = { walk: t('rt.walk'), walkTitle: t('rt.walk.title'), walkKeys: t('rt.walk.keys'), hint: t('rt.viewer.hint'), canvas: t('rt.canvas'), noGpu: t('rt.none'), failed: t('rt.viewer.failed') };
        const scene = await exportScene({ rt, plain, settings, views, title: base(), words });
        const map = JSON.parse(document.querySelector('script[type="importmap"]')?.textContent || '{"imports":{}}');
        const entry = new URL('./rt-standalone.js', import.meta.url);
        const modules = await bundle({ entries: [entry.href], importMap: map });
        const html = viewerHtml({ title: base(), modules, scene, entry: '@cc' + entry.pathname, lang: document.documentElement.lang || 'en', notice: t('rt.viewer.notice') });
        adapter.download(new Blob([html], { type: 'text/html' }), base() + '-viewer.html');
      } else if (kind === 'video') {
        const anim = adapter.animation();
        if (!anim) { ctx.busy(t('rt.share.video.none')); setTimeout(() => ctx.busy(null), 3000); return; }
        const { liveVideo } = await import('./rt-video.js');
        const out = await liveVideo({ rt, anim, settings: ctx.settings(), onProgress: (i, n) => ctx.busy(t('rt.share.busy.video', { n: i, of: n })) });
        adapter.download(out.blob, base() + '.' + out.ext);
        await ctx.rebuild();
      }
    } catch (e) {
      ctx.busy(t('rt.share.failed', { error: String((e && e.message) || e) }));
      setTimeout(() => ctx.busy(null), 5000);
      return;
    }
    ctx.busy(null);
  }
  return { el, spots, run };
}

function dataUrl(blob) { return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); }); }
