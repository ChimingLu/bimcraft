/* SPDX-License-Identifier: Apache-2.0 */
/**
 * rt-pano.js — 360° panoramas and panorama tours from the real-time view (0.7 RT.4, session `realtime`). DOM-free apart from
 * tourHtml's output (a string). Canonical in modelcraft/dev/rt/ (tools/rt/sync.mjs).
 *
 *   panoFrame(forward, up) → {f, r, u}            the panorama's frame: f = forward made level, r = right, u = up
 *   faceCameras(p, frame) → [{name, world, proj}] × 6   90° square cameras at p (+f, −f, +r, −r, +u, −u)
 *   cubeToEquirect(faces, frame, W, H) → Uint8ClampedArray RGBA   faces = [{n, data (RGBA, rows from the top)}] in faceCameras'
 *     order; an equirectangular picture 2:1, the forward view in the middle column, straight up on the top row, east (right) to
 *     the right of the middle; bilinear within a face
 *   dirOf(x, y, W, H, frame) / pixelOf(dir, W, H, frame)   one pixel's direction and back (the hotspots, the tests)
 *   hotspots(spots, sees(a, b)) → per spot [{to, yaw, pitch}] (radians, in that spot's frame): the other spots it can see
 *   tourHtml({title, spots: [{name, png, frame, hotspots}], words}) → a whole HTML file: a tour that opens offline in any browser
 *     (our own WebGL picture viewer, drag to look, wheel or pinch to zoom, a spot's arrows go to the next), nothing loaded from
 *     anywhere (a Content-Security-Policy that allows only what is in the file)
 */

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const neg = (a) => [-a[0], -a[1], -a[2]];

export function panoFrame(forward, up) {
  const u = norm(up);
  let f = [forward[0] - u[0] * dot(forward, u), forward[1] - u[1] * dot(forward, u), forward[2] - u[2] * dot(forward, u)];
  if (Math.hypot(...f) < 1e-6) {   // looking straight up or down: any level direction will do
    const a = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    f = [a[0] - u[0] * dot(a, u), a[1] - u[1] * dot(a, u), a[2] - u[2] * dot(a, u)];
  }
  f = norm(f);
  return { f, r: norm(cross(f, u)), u };
}

/** The six faces: look direction a, the picture's right b and up c (b × c = −a: a camera's own right-handed frame). */
function faces(fr) {
  const { f, r, u } = fr;
  return [
    { name: 'front', a: f, b: r, c: u }, { name: 'back', a: neg(f), b: neg(r), c: u },
    { name: 'right', a: r, b: neg(f), c: u }, { name: 'left', a: neg(r), b: f, c: u },
    { name: 'up', a: u, b: r, c: neg(f) }, { name: 'down', a: neg(u), b: r, c: f },
  ];
}

export function faceCameras(p, fr, near = 0.05, far = 5000) {
  const P = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];   // 90°, square
  return faces(fr).map((F) => ({ name: F.name, world: [...F.b, 0, ...F.c, 0, ...neg(F.a), 0, p[0], p[1], p[2], 1], proj: P }));
}

export function dirOf(x, y, W, H, fr) {
  const lon = ((x + 0.5) / W) * 2 * Math.PI - Math.PI, lat = Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
  const c = Math.cos(lat), s = Math.sin(lat), cl = Math.cos(lon), sl = Math.sin(lon);
  return [0, 1, 2].map((k) => c * (cl * fr.f[k] + sl * fr.r[k]) + s * fr.u[k]);
}
export function pixelOf(d, W, H, fr) {
  const lon = Math.atan2(dot(d, fr.r), dot(d, fr.f)), lat = Math.asin(Math.max(-1, Math.min(1, dot(norm(d), fr.u))));
  return [((lon + Math.PI) / (2 * Math.PI)) * W - 0.5, ((Math.PI / 2 - lat) / Math.PI) * H - 0.5];
}

export function cubeToEquirect(faceImgs, fr, W, H) {
  const F = faces(fr), out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = dirOf(x, y, W, H, fr);
    // the face this direction leaves through: the largest component along a face's look direction
    let best = 0, bi = 0;
    for (let i = 0; i < 6; i++) { const v = dot(d, F[i].a); if (v > best) { best = v; bi = i; } }
    const Fi = F[bi], img = faceImgs[bi], n = img.n;
    const u = dot(d, Fi.b) / best, v = dot(d, Fi.c) / best;
    const px = Math.min(n - 1, Math.max(0, ((u + 1) / 2) * n - 0.5)), py = Math.min(n - 1, Math.max(0, ((1 - v) / 2) * n - 0.5));
    const x0 = Math.floor(px), y0 = Math.floor(py), x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1), tx = px - x0, ty = py - y0;
    const o = (y * W + x) * 4;
    for (let k = 0; k < 4; k++) {
      const a = img.data[(y0 * n + x0) * 4 + k], b = img.data[(y0 * n + x1) * 4 + k], c = img.data[(y1 * n + x0) * 4 + k], e = img.data[(y1 * n + x1) * 4 + k];
      out[o + k] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
    }
  }
  return out;
}

export function hotspots(spots, sees) {
  return spots.map((A, i) => spots.flatMap((B, j) => {
    if (i === j || !sees(A, B)) return [];
    const d = norm([B.p[0] - A.p[0], B.p[1] - A.p[1], B.p[2] - A.p[2]]);
    return [{ to: j, yaw: Math.atan2(dot(d, A.frame.r), dot(d, A.frame.f)), pitch: Math.asin(Math.max(-1, Math.min(1, dot(d, A.frame.u)))) }];
  }));
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The tour's own viewer: plain WebGL (no library), an equirectangular picture on the inside of a sphere drawn per pixel. */
const VIEWER = `
const T = JSON.parse(document.getElementById('tour').textContent);
const cv = document.getElementById('v'), gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
const bar = document.getElementById('bar'), spots = document.getElementById('spots'), marks = document.getElementById('marks');
let cur = 0, yaw = 0, pitch = 0, fov = 75, tex = null;
const vs = 'attribute vec2 p; varying vec2 q; void main(){ q = p; gl_Position = vec4(p, 0.0, 1.0); }';
const fs = 'precision highp float; varying vec2 q; uniform sampler2D t; uniform float yaw, pitch, k, asp;' +
  'void main(){ vec3 d = normalize(vec3(q.x * k * asp, q.y * k, 1.0)); float cp = cos(pitch), sp = sin(pitch);' +
  'd = vec3(d.x, d.y * cp + d.z * sp, -d.y * sp + d.z * cp); float cy = cos(yaw), sy = sin(yaw); d = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);' +
  'float lon = atan(d.x, d.z), lat = asin(clamp(d.y, -1.0, 1.0)); gl_FragColor = texture2D(t, vec2(lon / 6.2831853 + 0.5, 0.5 - lat / 3.1415927)); }';
const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(pr); gl.useProgram(pr);
const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
const U = (n) => gl.getUniformLocation(pr, n);
function draw() {
  const w = cv.clientWidth, h = cv.clientHeight; if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  gl.viewport(0, 0, w, h);
  gl.uniform1f(U('yaw'), yaw); gl.uniform1f(U('pitch'), pitch); gl.uniform1f(U('k'), Math.tan(fov * Math.PI / 360)); gl.uniform1f(U('asp'), w / h);
  if (tex) gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  // the arrows to the spots seen from here
  const k = Math.tan(fov * Math.PI / 360);
  for (const m of marks.children) {
    const a = Number(m.dataset.yaw) - yaw, e = Number(m.dataset.pitch);
    let x = Math.sin(a) * Math.cos(e), y = Math.sin(e), z = Math.cos(a) * Math.cos(e);
    const cp = Math.cos(-pitch), sp = Math.sin(-pitch); const y2 = y * cp + z * sp, z2 = -y * sp + z * cp;
    if (z2 <= 0.05) { m.hidden = true; continue; }
    m.hidden = false; m.style.left = ((x / z2) / (k * w / h) * 0.5 + 0.5) * 100 + '%'; m.style.top = (0.5 - (y2 / z2) / k * 0.5) * 100 + '%';
  }
}
function go(i) {
  cur = i; const s = T.spots[i];
  const img = new Image();
  img.onload = () => { tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); draw(); document.body.dataset.ready = String(i); };
  img.src = s.png;
  marks.replaceChildren(...s.hotspots.map((h) => { const a = document.createElement('button'); a.type = 'button'; a.className = 'mark'; a.textContent = T.spots[h.to].name; a.title = T.words.go.replace('{name}', T.spots[h.to].name);
    a.dataset.yaw = h.yaw; a.dataset.pitch = h.pitch; a.onclick = () => go(h.to); return a; }));
  for (const [j, btn] of [...spots.children].entries()) btn.setAttribute('aria-pressed', String(j === i));
  draw();
}
spots.replaceChildren(...T.spots.map((s, i) => { const a = document.createElement('button'); a.type = 'button'; a.textContent = s.name; a.onclick = () => go(i); return a; }));
let drag = null;
cv.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY]; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', (e) => { if (!drag) return; const s = fov / cv.clientHeight * Math.PI / 180; yaw -= (e.clientX - drag[0]) * s; pitch = Math.max(-1.5, Math.min(1.5, pitch + (e.clientY - drag[1]) * s)); drag = [e.clientX, e.clientY]; draw(); });
cv.addEventListener('pointerup', () => { drag = null; });
cv.addEventListener('wheel', (e) => { e.preventDefault(); fov = Math.max(30, Math.min(110, fov * Math.exp(e.deltaY * 0.001))); draw(); }, { passive: false });
addEventListener('resize', draw);
go(0);
`;

export function tourHtml({ title, spots, words }) {
  const data = JSON.stringify({ spots: spots.map((s) => ({ name: s.name, png: s.png, hotspots: s.hotspots || [] })), words }).replace(/</g, '\\u003c');
  return '<!doctype html>\n<html lang="' + esc(words.lang || 'en') + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'">\n'
    + '<title>' + esc(title) + '</title>\n<style>html,body{margin:0;height:100%;background:#111;color:#eee;font:14px/1.3 system-ui,sans-serif;overflow:hidden}'
    + '#v{position:fixed;inset:0;width:100%;height:100%;touch-action:none;cursor:grab}#bar{position:fixed;left:0;right:0;top:0;display:flex;flex-wrap:wrap;gap:6px;padding:8px;background:rgba(0,0,0,.45)}'
    + '#bar h1{font-size:14px;margin:0 8px 0 0;align-self:center}#bar button{font:inherit;padding:3px 8px}#bar button[aria-pressed=true]{background:#1d4f91;color:#fff}'
    + '#marks .mark{position:fixed;transform:translate(-50%,-50%);font:inherit;padding:4px 10px;border-radius:14px;border:1px solid #fff;background:rgba(29,79,145,.85);color:#fff;cursor:pointer}'
    + '#note{position:fixed;left:8px;bottom:8px;opacity:.75}</style></head>\n<body><canvas id="v" aria-label="' + esc(words.canvas) + '"></canvas>'
    + '<div id="bar"><h1>' + esc(title) + '</h1><span id="spots"></span></div><div id="marks"></div><p id="note">' + esc(words.hint) + '</p>\n'
    + '<script type="application/json" id="tour">' + data + '</script>\n<script>' + VIEWER + '</script></body></html>\n';
}
