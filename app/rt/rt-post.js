/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-post.js — the real-time view's picture after the scene pass (0.7 RT.2, session `realtime`): ambient occlusion (GTAO),
 * screen-space reflections, temporal anti-aliasing (TRAA) or FXAA, bloom, and RN.8's colour chain with the same view transforms
 * as the path tracer's stills (render/pt-post.js; rt-look.js displayParams). Written once in TSL: three compiles it to WGSL on
 * WebGPU and to GLSL on the WebGL 2 back end. Canonical in modelcraft/dev/rt/ (tools/rt/sync.mjs).
 *
 *   createPipeline(THREE, TSL, renderer, scene, camera, preset, display) → {pipeline, render(), setDisplay(display), dispose()}
 *     preset = rt-look.js presetFor(); display = displayParams(settings). Exposure, white balance, contrast, highlights, bloom
 *     amount and vignette are uniforms (live); a new view transform or preset needs a new pipeline (the caller rebuilds).
 *
 * Order: scene (HDR, linear Rec.709; AO in the lighting through builtinAOContext) → + SSR → TRAA (HDR, before tone mapping, so
 * edges resolve on real values) → × white balance → × 2^stops → bloom (blended: pt-post.js keeps energy the same way) →
 * vignette → highlight knee → contrast → view transform → sRGB (the pipeline's output transform) → FXAA on the low preset.
 */

// Hable's curve (John Hable, GDC 2010) with pt-post.js's constants: A 0.15, B 0.50, C 0.10, D 0.20, E 0.02, F 0.30, white 11.2
const hableJs = (x) => ((x * (0.15 * x + 0.1 * 0.5) + 0.2 * 0.02) / (x * (0.15 * x + 0.5) + 0.2 * 0.3)) - 0.02 / 0.3;
const HABLE_W = hableJs(11.2);

export function viewTransformNode(TSL, kind, c) {
  const { float, vec3, clamp, acesFilmicToneMapping, agxToneMapping } = TSL;
  if (kind === 'agx') return clamp(agxToneMapping(c, float(1)), 0, 1);
  if (kind === 'standard') return clamp(c, 0, 1);
  if (kind === 'filmic') {
    const x = c.max(0).mul(2);
    const h = x.mul(x.mul(0.15).add(0.05)).add(0.004).div(x.mul(x.mul(0.15).add(0.5)).add(0.06)).sub(0.02 / 0.3);
    return clamp(h.div(HABLE_W), 0, 1);
  }
  return clamp(acesFilmicToneMapping(c, float(1)), 0, 1);   // three's ACES fit, its own 1/0.6 inside (pt-spec.js acesFilmic)
}

export async function createPipeline(THREE, TSL, renderer, scene, camera, preset, display) {
  const { pass, mrt, output, normalView, velocity, metalness, roughness, vec2, vec3, vec4, uniform, mat3, screenUV, screenSize,
    builtinAOContext, length, smoothstep, dot, pow, max, mix, select } = TSL;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = true;   // linear → sRGB at the end; no tone mapping of three's own (ours is below)
  const nodes = [];

  const u = {
    wb: uniform(new THREE.Matrix3()), exposure: uniform(1), contrast: uniform(0), highlights: uniform(0), bloom: uniform(0), vignette: uniform(0),
  };
  const setDisplay = (d) => {
    const m = d.wb;
    u.wb.value.set(m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]);
    u.exposure.value = d.exposure; u.contrast.value = d.contrast; u.highlights.value = d.highlights * 2;
    u.bloom.value = preset.bloom ? d.bloom : 0; u.vignette.value = d.vignette;
  };
  setDisplay(display);

  const scenePass = pass(scene, camera);
  nodes.push(scenePass);
  let beauty;
  if (preset.ao || preset.ssr) {
    // a pre-pass for depth and normals (and the surface's metal + roughness for the reflections)
    const pre = pass(scene, camera);
    nodes.push(pre);
    pre.setMRT(mrt(preset.ssr ? { output: normalView, metalrough: vec2(metalness, roughness) } : { output: normalView }));
    const preNormal = pre.getTextureNode(), preDepth = pre.getTextureNode('depth');
    if (preset.ao) {
      const { ao } = await import('three-webgpu/addons/tsl/display/GTAONode.js');
      const aoPass = ao(preDepth, preNormal, camera);
      aoPass.resolutionScale = preset.quality === 'high' ? 1 : 0.5;
      aoPass.useTemporalFiltering = preset.aa === 'taa';   // its per-pixel noise is resolved by TAA over frames, not left as grain
      aoPass.radius.value = 0.5;                           // metres: contact shadows of furniture and wall corners
      nodes.push(aoPass);
      scenePass.contextNode = builtinAOContext(aoPass.getTextureNode().sample(screenUV).r);
    }
    scenePass.setMRT(mrt({ output, velocity }));
    beauty = scenePass.getTextureNode('output');
    if (preset.ssr) {
      const { ssr } = await import('three-webgpu/addons/tsl/display/SSRNode.js');
      const mr = pre.getTextureNode('metalrough');
      const s = ssr(beauty, preDepth, preNormal, { metalnessNode: mr.r, roughnessNode: mr.g, camera });
      s.resolutionScale = 0.5;
      nodes.push(s);
      beauty = vec4(beauty.rgb.add(s.rgb.mul(s.a)), beauty.a);
    }
  } else {
    if (preset.aa === 'taa') scenePass.setMRT(mrt({ output, velocity }));
    beauty = scenePass.getTextureNode('output');
  }
  if (preset.aa === 'taa') {
    const { traa } = await import('three-webgpu/addons/tsl/display/TRAANode.js');
    const t = traa(beauty, scenePass.getTextureNode('depth'), scenePass.getTextureNode('velocity'), camera);
    nodes.push(t);
    beauty = t;
  }
  // ---- RN.8's chain (pt-post.js post), per pixel ----
  let c = u.wb.mul(beauty.rgb).max(0).mul(u.exposure);
  if (preset.bloom) {
    const { bloom } = await import('three-webgpu/addons/tsl/display/BloomNode.js');
    const b = bloom(vec4(c, 1), 1, 0.6, 0);
    nodes.push(b);
    c = mix(c, b.rgb, u.bloom);
  }
  const half = screenSize.mul(0.5);
  const r = length(screenUV.sub(0.5).mul(screenSize)).div(length(half));
  c = c.mul(smoothstep(0.2, 1, r).mul(u.vignette).oneMinus());
  const L = dot(c, vec3(0.2126, 0.7152, 0.0722));
  const knee = L.sub(1).max(0);
  const scaled = knee.div(knee.mul(u.highlights).add(1)).add(1).div(L.max(1e-6));
  c = select(u.highlights.greaterThan(0).and(L.greaterThan(1)), c.mul(scaled), c);
  c = select(u.contrast.notEqual(0), pow(c.div(0.18).max(0), u.contrast.add(1)).mul(0.18), c);
  let out = vec4(viewTransformNode(TSL, display.view, c), 1);
  if (preset.aa === 'fxaa') {
    // FXAA works on display values: the pipeline's sRGB transform runs first, so this one pass does both
    const { fxaa } = await import('three-webgpu/addons/tsl/display/FXAANode.js');
    const { renderOutput } = TSL;
    pipeline.outputColorTransform = false;
    out = fxaa(renderOutput(out, THREE.NoToneMapping, THREE.SRGBColorSpace));
  }
  pipeline.outputNode = out;
  return {
    pipeline,
    render() { return pipeline.render(); },
    setDisplay,
    dispose() { for (const n of nodes) n.dispose?.(); pipeline.dispose(); },
  };
}
