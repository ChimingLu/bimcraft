/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-bim.js — BimCraft's adapter for the live view (0.7 RT.3, session `realtime`; rt-view.js header). Only BimCraft loads it
 * (from its copy of rt/). BimCraft's hook hands over what its Render dialog already builds (render-bim.js), so the live view
 * shows the same elements, paints and lamps as a rendered picture.
 *
 *   bimLive({viewer, scene(settings), sun(settings), sunBase(), settings(), key?}) → adapter
 *     viewer = viewer3d.js Viewer3D (its three camera: Y up, metres); scene(st) = render-bim.js bimScene + bimLamps as the Render
 *     dialog makes them; sun(st) = bimSun(site, st, place); key() = something that changes when the shown model changes (the
 *     hook's own change counter); without one the adapter looks at the viewer's meshes, their visibility and draw ranges
 */
export function bimLive({ viewer, scene, sun, sunBase, settings = () => ({}), key = null }) {
  const own = () => {
    let k = '';
    for (const m of viewer.meshes || []) k += m.id + (m.visible ? '+' : '-') + (m.geometry && m.geometry.drawRange ? m.geometry.drawRange.count : '') + ',';
    return k;
  };
  return {
    app: 'bimcraft',
    up: [0, 1, 0],
    scene,
    camera(aspect) {
      const c = viewer.camera;
      c.updateMatrixWorld();
      const world = c.matrixWorld.elements.slice();
      if (c.isOrthographicCamera) return { world, proj: c.projectionMatrix.elements.slice() };
      const t = 1 / Math.tan((c.fov * Math.PI) / 360), n = c.near, f = c.far;
      return { world, proj: [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, (2 * f * n) / (n - f), 0] };
    },
    key: key || own,
    camKey: () => viewer.camera.matrixWorld.elements.join(',') + '|' + (viewer.camera.fov || viewer.camera.zoom),
    settings,
    sunBase,
    sun: (when) => sun({ ...(settings() || {}), sun: when }),
  };
}
