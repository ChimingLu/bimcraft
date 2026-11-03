/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-backend.js — which GPU interface the real-time view draws with (0.7 RT.1, session `realtime`). Canonical in
 * modelcraft/dev/rt/; BimCraft carries a byte-identical copy (node tools/rt/sync.mjs). Never edit a copy.
 *
 *   chooseBackend(facts, {override}) → {backend: 'webgpu' | 'webgl2' | null, reason}   DOM-free (Node tests)
 *     facts = compute/probe.js facts (gpu, webgl2). WebGPU when a hardware adapter answered; a software adapter (SwiftShader,
 *     llvmpipe: probe's gpu.fallback) draws with WebGL 2 instead, which is faster there; no WebGPU → WebGL 2; neither → null.
 *     override 'webgpu' | 'webgl2' (`?rt=` in tests) wins when that interface exists at all.
 *   backendFromQuery(search) → 'webgpu' | 'webgl2' | null
 *   createRenderer({canvas, backend, antialias}) → Promise<{renderer, backend, THREE}>   three's WebGPURenderer (three/webgpu,
 *     vendored 0.186.1 in assets/vendor/three-webgpu/), with `forceWebGL` for the WebGL 2 back end, initialised (await init()).
 *     The back end it really got is read back from the renderer (three may fall back on its own when the adapter is lost).
 *
 * One renderer class for both interfaces: the node materials, shadows and post effects of RT.2 are written once (TSL) and
 * three compiles them to WGSL or GLSL. Everything here works without WebGPU (KICKOFF: Linux, older Apple systems).
 */

export const BACKENDS = ['webgpu', 'webgl2'];

export function backendFromQuery(search) {
  const m = /[?&]rt=(webgpu|webgl2)\b/.exec(String(search || ''));
  return m ? m[1] : null;
}

export function chooseBackend(facts, { override = null } = {}) {
  const f = facts || {};
  const gpu = f.gpu || null, gl = f.webgl2 || null;
  if (override === 'webgpu' && gpu) return { backend: 'webgpu', reason: 'override' };
  if (override === 'webgl2' && gl) return { backend: 'webgl2', reason: 'override' };
  if (gpu && !gpu.fallback) return { backend: 'webgpu', reason: 'webgpu' };
  if (gl) return { backend: 'webgl2', reason: gpu ? 'software-webgpu' : 'no-webgpu' };
  if (gpu) return { backend: 'webgpu', reason: 'software-only' };   // a software WebGPU and no WebGL 2: still a picture
  return { backend: null, reason: 'none' };
}

export async function createRenderer({ canvas, backend = 'webgl2', antialias = false } = {}) {
  const THREE = await import('three/webgpu');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias, forceWebGL: backend !== 'webgpu', powerPreference: 'high-performance' });
  await renderer.init();
  const got = renderer.backend && renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
  return { renderer, backend: got, THREE };
}
