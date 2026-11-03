/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-video.js — a video of the app's animation path in the real-time look (0.7 RT.4, session `realtime`). Canonical in
 * modelcraft/dev/rt/ (tools/rt/sync.mjs). The encoder is the shared one (render/video.js: WebM / MP4 through the browser's
 * WebCodecs, else numbered PNGs in a ZIP); the frames are rt-renderer.js's.
 *
 *   await liveVideo({rt, anim, settings, w, h, kind, settle, onProgress, signal}) → {blob, ext, mime, frames}
 *     anim = the adapter's animation(): {scene(settings) → a plain scene with frameAt(t) → {camera(aspect), matrices?}, length (s),
 *     fps}; w × h = the live view's size by default (made even); kind 'webm' (else 'mp4', else 'png' when the browser has no encoder);
 *     settle = frames drawn per video frame (TAA and AO settle: 4). The live view's scene is replaced while it runs: the caller
 *     rebuilds it after.
 */
export async function liveVideo({ rt, anim, settings = {}, w = null, h = null, kind = null, settle = 4, onProgress = null, signal = null }) {
  const { createVideoSink, videoSupport, even } = await import('../render/video.js');
  const canvas = rt.renderer.domElement;
  const W = even(w || canvas.width || 640), H = even(h || canvas.height || 360), fps = anim.fps || 30;
  const sup = await videoSupport(W, H, fps);
  const k = kind || (sup.webm ? 'webm' : sup.mp4 ? 'mp4' : 'png');
  const plain = anim.scene(settings);
  await rt.setScene(plain, settings);
  rt.resize(W, H, 1);
  const sink = await createVideoSink({ kind: k, w: W, h: H, fps });
  const n = Math.max(1, Math.round(anim.length * fps));
  const frame = new OffscreenCanvas(W, H), g = frame.getContext('2d');
  try {
    for (let i = 0; i < n; i++) {
      if (signal && signal.aborted) { sink.abort(); throw Object.assign(new Error('stopped'), { code: 'stopped' }); }
      const f = plain.frameAt(i / fps) || {};
      rt.setCamera((f.camera || plain.camera)(W / H));
      if (f.matrices) rt.setMatrices(f.matrices);
      let px = null;
      for (let s = 0; s < Math.max(1, settle); s++) px = await rt.readPixels();
      g.putImageData(new ImageData(new Uint8ClampedArray(px.data.buffer, px.data.byteOffset, W * H * 4), W, H), 0, 0);
      await sink.add(frame, i);
      onProgress?.(i + 1, n);
    }
    const out = await sink.finish();
    return { ...out, frames: n };
  } finally { plain.dispose?.(); }
}
