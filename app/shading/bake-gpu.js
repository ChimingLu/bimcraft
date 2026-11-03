/* SPDX-License-Identifier: Apache-2.0 */
/**
 * shading/bake-gpu.js — a material graph baked on the graphics card (0.7 MT.1): the WGSL of compile-wgsl.js over every texel,
 * read back and finished by bake.js `finishBake`, so the result has the reference's shape and (within ± 1 level) its bytes.
 * Page only (WebGPU). Falls back to nothing: callers use bake.js where there is no device.
 *
 *   bakeGPU(device, graph, {size = 512, images: Map key → {w, h, data}}) → Promise<bake>   throws {code: 'wgsl'} with the
 *                                                     compiler's messages if the shader does not compile (a bug: report it)
 *   gpuBaker(device) → {bake(graph, opts), destroy()}  keeps the pipeline per shader source (a graph edited back and forth
 *                                                     compiles once)
 */
import { compileWGSL } from './compile-wgsl.js';
import { finishBake } from './bake.js';
import { imageKeys as keysOf, IMG_SIZE } from './images.js';

export function gpuBaker(device) {
  const pipes = new Map();
  async function pipeline(code) {
    if (pipes.has(code)) return pipes.get(code);
    const module = device.createShaderModule({ code });
    const info = await module.getCompilationInfo();
    const errs = info.messages.filter((m) => m.type === 'error');
    if (errs.length) throw Object.assign(new Error(errs.map((m) => m.lineNum + ':' + m.linePos + ' ' + m.message).join('\n')), { code: 'wgsl' });
    const p = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    if (pipes.size > 32) pipes.clear();
    pipes.set(code, p);
    return p;
  }
  async function bake(graph, { size = 512, images = new Map() } = {}) {
    const keys = keysOf(graph).filter((k) => images.get(k));
    const { code, plan, bindings } = compileWGSL(graph, { size, imageKeys: keys });
    const n = size * size, px = { base: null, data: null, emit: null, height: null };
    if (!plan.need.base && !plan.need.data && !plan.need.emit && !plan.need.height) return finishBake(graph, plan, px, { size, images });
    const p = await pipeline(code);
    const entries = [], bufs = {}, own = [];
    let tex = null;
    if (bindings.images !== undefined) {
      tex = device.createTexture({ size: [IMG_SIZE, IMG_SIZE, keys.length], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, dimension: '2d' });
      keys.forEach((k, i) => device.queue.writeTexture({ texture: tex, origin: [0, 0, i] }, images.get(k).data, { bytesPerRow: IMG_SIZE * 4, rowsPerImage: IMG_SIZE }, [IMG_SIZE, IMG_SIZE, 1]));
      entries.push({ binding: bindings.images, resource: tex.createView({ dimension: '2d-array' }) });
    }
    for (const L of ['base', 'data', 'emit', 'height']) {
      if (bindings[L] === undefined) continue;
      const b = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const r = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      bufs[L] = { b, r }; own.push(b, r);
      entries.push({ binding: bindings[L], resource: { buffer: b } });
    }
    const enc = device.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setPipeline(p);
    pass.setBindGroup(0, device.createBindGroup({ layout: p.getBindGroupLayout(0), entries }));
    pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
    pass.end();
    for (const L in bufs) enc.copyBufferToBuffer(bufs[L].b, 0, bufs[L].r, 0, n * 4);
    device.queue.submit([enc.finish()]);
    try {
      for (const L in bufs) {
        await bufs[L].r.mapAsync(GPUMapMode.READ);
        const copy = bufs[L].r.getMappedRange().slice(0);
        bufs[L].r.unmap();
        px[L] = L === 'height' ? new Float32Array(copy) : new Uint8Array(copy);
      }
    } finally {
      for (const b of own) b.destroy();
      tex?.destroy();
    }
    return finishBake(graph, plan, px, { size, images });
  }
  return { bake, destroy() { pipes.clear(); } };
}

export const bakeGPU = (device, graph, opts) => gpuBaker(device).bake(graph, opts);
