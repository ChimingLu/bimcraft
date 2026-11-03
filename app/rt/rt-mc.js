/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-mc.js — ModelCraft's adapter for the live view (0.7 RT.3, session `realtime`; rt-view.js header). Only ModelCraft loads it
 * (BimCraft's copy of rt/ carries it unused). The plain scene is render-mc.js's, so the live view, the fast render and the
 * path tracer see the same model.
 *
 *   mcLive({model, cam, view, host, settings, scatter}) → adapter     model = the kernel, cam = view3d's Camera, view = the 3D
 *     view (its style: the sun's place and date), host = the app's selection ({path, sel}), settings() → the Render dialog's
 *     settings (sky, looks, exposure, post), scatter = {get() → the file's scatter sets, set(list)} (RT.5; saved in the
 *     .modelcraft file beside the render settings), download(blob, name), fileBase() (RT.4: Share), animation() → the timeline's
 *     animation (render/anim.js) or null (RT.4: Video; ModelCraft's timeline, made from the scenes when there is none)
 *
 * adapter.scatter (RT.5, rt-scatter-ui.js): library() (lib/entourage's items), itemName(slug, t), sets(), save(list),
 *   selection() → a target naming the selected faces or placements ({path, faces} | {path, all: true}) | null,
 *   tris(target) → Float64Array of their world triangles (9 per triangle) | null when they are gone,
 *   obstacles(target) → {tris, boxes} of everything else shown (for keeping away from objects)
 */
import { mcScene, mcSun } from '../render-mc.js';
import { Camera } from '../camera.js';
import { invert, mmul, IDENT } from '../vec.js';
import { faceTris } from '../model.js';
import { entourage } from '../entourage.js';

let ENT = null;

export function mcLive({ model, cam, view, host = null, settings = () => ({}), scatter = null, download = null, fileBase = null, animation = null }) {
  const xf = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  /** The placement at a path of instance ids: {def, m} (world matrix) or null. */
  const at = (path) => {
    let def = model.root, m = IDENT;
    for (const iid of path || []) {
      const inst = def.insts.get(iid);
      if (!inst) return null;
      m = mmul(m, inst.m);
      def = model.defs.get(inst.def);
      if (!def) return null;
    }
    return { def, m };
  };
  const pushFaces = (out, def, m, ids = null) => {
    for (const [fid, f] of def.faces) {
      if (f.hidden || (ids && !ids.has(fid))) continue;
      for (const tri of faceTris(def, f)) for (const v of tri) out.push(...xf(m, def.verts.get(v)));
    }
  };
  const under = (def, m, cb, depth = 0) => {
    if (depth > 32) return;
    cb(def, m);
    for (const inst of def.insts.values()) { const d = model.defs.get(inst.def); if (d && !inst.hidden) under(d, mmul(m, inst.m), cb, depth + 1); }
  };
  const key = (p) => (p || []).join('/');
  return {
    app: 'modelcraft',
    up: [0, 0, 1],
    scene: (s) => mcScene(model, cam, view.style, s),
    camera(aspect) {
      const c = new Camera();
      c.set(cam.toJSON());
      c.setSize(1000 * aspect, 1000);
      c.clip(cam.sceneRadius);
      return { world: invert(c.view()), proj: c.proj() };
    },
    // the kernel's version moves with every edit (and undo); the style holds the sun, hidden tags change the version too
    key: () => model.version + '|' + JSON.stringify(view.style && view.style.sun || null),
    camKey: () => JSON.stringify(cam.toJSON()),
    settings,
    sunBase() { const s = (view.style && view.style.sun) || {}; return { month: s.month || 6, day: s.day || 21, hour: s.hour ?? 15 }; },
    sun: (when) => mcSun(view.style, { sun: when }),
    // RT.4: Share — saving files, the file's name, the saved scenes as views, the animation path (timeline, else the scenes)
    download, fileBase,
    views(aspect) {
      return (model.scenes || []).map((s) => {
        const c = new Camera();
        c.set(s.cam); c.setSize(1000 * aspect, 1000); c.clip(cam.sceneRadius);
        return { name: s.name, world: invert(c.view()), proj: c.proj() };
      });
    },
    animation: animation ? () => { const a = animation(); return a ? { scene: (s) => mcScene(model, cam, view.style, s, { anim: a }), length: a.length, fps: a.fps } : null; } : null,
    scatter: scatter && {
      library: () => (ENT = ENT || entourage()),
      itemName: (slug, t) => t('app.starter.ent-' + slug),
      sets: () => scatter.get() || [],
      save: (list) => scatter.set(list),
      selection() {
        if (!host) return null;
        const path = (host.path || []).slice();
        const faces = (host.sel || []).filter((s) => s.t === 'f').map((s) => s.id);
        if (faces.length) return { path, faces };
        const inst = (host.sel || []).find((s) => s.t === 'i');
        return inst ? { path: [...path, inst.id], all: true } : null;
      },
      tris(target) {
        const p = target && at(target.path);
        if (!p) return null;
        const out = [];
        if (target.all) under(p.def, p.m, (d, m) => pushFaces(out, d, m));
        else pushFaces(out, p.def, p.m, new Set(target.faces || []));
        return out.length ? new Float64Array(out) : null;
      },
      obstacles(target) {
        // everything shown except the target: its own placement (all) or the target faces' own definition at that path
        const skip = target ? key(target.path) : null;
        const tris = [], boxes = [];
        model.walkShown((def, m, path) => {
          const k = key(path);
          if (skip !== null && (target.all ? k === skip || k.startsWith(skip + '/') : k === skip)) return target.all && k === skip ? false : undefined;
          if (!def.faces.size) return undefined;
          const from = tris.length;
          pushFaces(tris, def, m);
          if (tris.length === from) return undefined;
          const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
          for (let i = from; i < tris.length; i += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], tris[i + c]); hi[c] = Math.max(hi[c], tris[i + c]); }
          boxes.push({ min: lo, max: hi });
          return undefined;
        });
        return { tris: new Float64Array(tris), boxes };
      },
    },
  };
}
