/* SPDX-License-Identifier: Apache-2.0 */
/**
 * scan-export.js — the registered cloud as LAS and E57 (0.7 LC.3, session `scans`). No DOM: bin/test-register.mjs runs it in
 * Node and reads the files back with pointcloud.js (our readers) and, outside the repo, with laspy and pye57 (libE57Format).
 * Canonical here in bimcraft/dev; CadCraft carries a byte-identical copy (`node tools/pointcloud/sync.mjs`).
 *
 *   items = [{ name, cloud, M }]      cloud = pointcloud.js loadCloud's result, M = register.js's row-major 4 × 4 (file
 *                                     coordinates → registered). The points are read from the cloud and moved on the way out;
 *                                     the cloud itself is never changed.
 *   writeLas(items, { software }) → { blob, count, min, max, scale, format }
 *       LAS 1.2, point format 2 (with colours) when every scan has colours, else format 0; intensity and class kept; an
 *       EPSG projected system is carried (GeoKeys) when every scan names the same one; the scale is the finest of 0.0001…1
 *       that fits 32 bits. Point counts over 2³² − 1 are refused (code 'too_many').
 *   writeE57(items, { name, guid }) → { blob, count, scans, min, max }
 *       E57 1.0 (ASTM E2807): one `data3D` scan per input scan (empty ones left out), identity poses (the points are already in
 *       the registered frame), cartesian x y z as doubles, colours (8-bit) and intensity (16-bit) when the scan has them, one
 *       compressed vector of data packets per scan, the file in 1024-byte pages with a CRC-32C each. Written whole in memory.
 * Units are the files' own (nothing is converted); a mix of metre and foot scans is the caller's to refuse.
 */

const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const pt = (c, M, i, out) => {
  const x = c.pos[i * 3] + c.origin[0], y = c.pos[i * 3 + 1] + c.origin[1], z = c.pos[i * 3 + 2] + c.origin[2];
  out[0] = M[0] * x + M[1] * y + M[2] * z + M[3]; out[1] = M[4] * x + M[5] * y + M[6] * z + M[7]; out[2] = M[8] * x + M[9] * y + M[10] * z + M[11];
};
function bounds(items) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], p = [0, 0, 0];
  let n = 0;
  for (const { cloud: c, M } of items) for (let i = 0; i < c.n; i++) {
    pt(c, M, i, p); n++;
    for (let a = 0; a < 3; a++) { if (p[a] < lo[a]) lo[a] = p[a]; if (p[a] > hi[a]) hi[a] = p[a]; }
  }
  if (!n) { lo.fill(0); hi.fill(0); }
  return { lo, hi, n };
}
const asciiInto = (view, off, s, len) => { for (let i = 0; i < len; i++) view.setUint8(off + i, i < s.length ? s.charCodeAt(i) & 127 : 0); };

// --------------------------------------------------------------------- LAS 1.2
export function writeLas(items, { software = 'CadCraft' } = {}) {
  const { lo, hi, n } = bounds(items);
  if (n >= 4294967295) throw fail('too_many', { n });
  const colour = items.length > 0 && items.every((s) => s.cloud.rgb);
  const fmt = colour ? 2 : 0, rec = colour ? 26 : 20;
  const ext = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const scale = [0.0001, 0.001, 0.01, 0.1, 1].find((s) => ext / s < 2e9) ?? 1;
  const offset = lo.map((v) => Math.floor(v / 100) * 100);   // whole hundreds: a round offset keeps the stored integers small
  const codes = items.map((s) => s.cloud.info?.code ?? null);
  const epsg = codes.length && codes.every((c) => Number.isInteger(c) && c === codes[0]) ? codes[0] : null;
  const vlr = epsg ? (() => {
    const keys = [[1024, 1], [3072, epsg]], body = new DataView(new ArrayBuffer(8 + keys.length * 8));
    [1, 1, 0, keys.length].forEach((v, k) => body.setUint16(k * 2, v, true));
    keys.forEach(([id, v], k) => { body.setUint16(8 + k * 8, id, true); body.setUint16(10 + k * 8, 0, true); body.setUint16(12 + k * 8, 1, true); body.setUint16(14 + k * 8, v, true); });
    const head = new DataView(new ArrayBuffer(54));
    asciiInto(head, 2, 'LASF_Projection', 16); head.setUint16(18, 34735, true); head.setUint16(20, body.byteLength, true); asciiInto(head, 22, 'GeoTIFF GeoKeyDirectoryTag', 32);
    return [new Uint8Array(head.buffer), new Uint8Array(body.buffer)];
  })() : [];
  const vlrBytes = vlr.reduce((s, b) => s + b.length, 0);
  const H = new DataView(new ArrayBuffer(227));
  asciiInto(H, 0, 'LASF', 4);
  H.setUint8(24, 1); H.setUint8(25, 2);
  asciiInto(H, 26, 'CadCraft registration', 32); asciiInto(H, 58, software, 32);
  const now = new Date();
  H.setUint16(90, Math.floor((now - Date.UTC(now.getUTCFullYear(), 0, 0)) / 864e5), true); H.setUint16(92, now.getUTCFullYear(), true);
  H.setUint16(94, 227, true); H.setUint32(96, 227 + vlrBytes, true); H.setUint32(100, vlr.length ? 1 : 0, true);
  H.setUint8(104, fmt); H.setUint16(105, rec, true); H.setUint32(107, n, true); H.setUint32(111, n, true);
  [scale, scale, scale, ...offset].forEach((v, k) => H.setFloat64(131 + k * 8, v, true));
  [hi[0], lo[0], hi[1], lo[1], hi[2], lo[2]].forEach((v, k) => H.setFloat64(179 + k * 8, v, true));
  const parts = [new Uint8Array(H.buffer), ...vlr];
  const CHUNK = 1 << 16, buf = new ArrayBuffer(CHUNK * rec), dv = new DataView(buf);
  let used = 0;
  const flush = () => { if (used) { parts.push(new Uint8Array(buf.slice(0, used * rec))); used = 0; } };
  const p = [0, 0, 0];
  for (const { cloud: c, M } of items) for (let i = 0; i < c.n; i++) {
    pt(c, M, i, p);
    const o = used * rec;
    for (let a = 0; a < 3; a++) dv.setInt32(o + a * 4, Math.round((p[a] - offset[a]) / scale), true);
    dv.setUint16(o + 12, c.inten ? c.inten[i] : 0, true);
    dv.setUint8(o + 14, 9);   // return 1 of 1
    dv.setUint8(o + 15, c.cls ? c.cls[i] : 0);
    dv.setInt8(o + 16, 0); dv.setUint8(o + 17, 0); dv.setUint16(o + 18, 0, true);
    if (colour) for (let a = 0; a < 3; a++) dv.setUint16(o + 20 + a * 2, c.rgb[i * 3 + a] * 257, true);   // 8-bit → the full 16-bit range
    if (++used === CHUNK) flush();
  }
  flush();
  return { blob: new Blob(parts, { type: 'application/octet-stream' }), count: n, min: lo, max: hi, scale, format: fmt };
}

// --------------------------------------------------------------------- E57
const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1; t[i] = c >>> 0; } return t; })();
/** CRC-32C (Castagnoli) of bytes[from, to). */
export function crc32c(bytes, from = 0, to = bytes.length) {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const PAGE = 1024, PAYLOAD = 1020;
const phys = (logical) => logical + 4 * Math.floor(logical / PAYLOAD);
const xmlText = (s) => '<![CDATA[' + String(s).replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
const uuid = () => '{' + [8, 4, 4, 4, 12].map((n) => [...crypto.getRandomValues(new Uint8Array(n / 2))].map((b) => b.toString(16).padStart(2, '0')).join('')).join('-').toUpperCase() + '}';
const f = (v) => (Object.is(v, -0) ? '0' : String(v));

export function writeE57(items, { name = 'Registered scans', guid = uuid() } = {}) {
  const scans = items.filter((s) => s.cloud.n > 0);
  if (!scans.length) throw fail('empty');
  const chunks = [new Uint8Array(48)];   // the file header, filled in last
  let at = 48;
  const push = (u8) => { chunks.push(u8); at += u8.length; };
  const align = () => { const pad = (4 - (at % 4)) % 4; if (pad) push(new Uint8Array(pad)); };
  const all = bounds(scans), meta = [];
  for (const s of scans) {
    const c = s.cloud, M = s.M, n = c.n;
    const hasRgb = !!c.rgb, hasInt = !!c.inten, p = [0, 0, 0];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const widths = [8, 8, 8, ...(hasRgb ? [1, 1, 1] : []), ...(hasInt ? [2] : [])];
    const recBytes = widths.reduce((a, b) => a + b, 0), perPacket = Math.max(1, Math.min(n, Math.floor((65536 - 6 - 2 * widths.length - 4) / recBytes), 2000));
    const secStart = at;
    const hdr = new Uint8Array(32);
    push(hdr);   // section header, filled in once the length is known
    const dataStart = at;
    const packets = [];
    for (let i0 = 0; i0 < n; i0 += perPacket) {
      const m = Math.min(perPacket, n - i0), dataLen = recBytes * m, len = Math.ceil((6 + 2 * widths.length + dataLen) / 4) * 4;
      const pk = new Uint8Array(len), dv = new DataView(pk.buffer);
      dv.setUint8(0, 1); dv.setUint8(1, 0); dv.setUint16(2, len - 1, true); dv.setUint16(4, widths.length, true);
      widths.forEach((w, k) => dv.setUint16(6 + k * 2, w * m, true));
      let off = 6 + 2 * widths.length;
      const starts = []; widths.forEach((w) => { starts.push(off); off += w * m; });
      for (let k = 0; k < m; k++) {
        const i = i0 + k;
        pt(c, M, i, p);
        for (let a = 0; a < 3; a++) { dv.setFloat64(starts[a] + k * 8, p[a], true); if (p[a] < lo[a]) lo[a] = p[a]; if (p[a] > hi[a]) hi[a] = p[a]; }
        let w = 3;
        if (hasRgb) { for (let a = 0; a < 3; a++) dv.setUint8(starts[w + a] + k, c.rgb[i * 3 + a]); w += 3; }
        if (hasInt) dv.setUint16(starts[w] + k * 2, c.inten[i], true);
      }
      push(pk); packets.push(len);
    }
    const sec = new DataView(hdr.buffer);
    const secLen = at - secStart;
    sec.setUint8(0, 1); sec.setBigUint64(8, BigInt(secLen), true); sec.setBigUint64(16, BigInt(phys(dataStart)), true); sec.setBigUint64(24, 0n, true);
    meta.push({ s, n, lo, hi, hasRgb, hasInt, offset: phys(secStart) });
    align();
  }
  // ---- the XML section
  const tag = (nm, type, v) => `<${nm} type="${type}">${v}</${nm}>`;
  // i18n-ignore-start: text written into the E57 file (its format name is fixed by the standard)
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<e57Root type="Structure" xmlns="http://www.astm.org/COMMIT/E57/2010-e57-v1.0">\n'
    + tag('formatName', 'String', xmlText('ASTM E57 3D Imaging Data File')) + tag('guid', 'String', xmlText(guid))
    + tag('versionMajor', 'Integer', 1) + tag('versionMinor', 'Integer', 0) + tag('e57LibraryVersion', 'String', xmlText('CadCraft scan registration'))
    + `<creationDateTime type="Structure">${tag('dateTimeValue', 'Float', f(Date.now() / 1000 - 1230768000))}${tag('isAtomicClockReferenced', 'Integer', 0)}</creationDateTime>\n`
    + '<data3D type="Vector" allowHeterogeneousChildren="1">\n';
  for (const m of meta) {
    const fl = (nm) => `<${nm} type="Float" precision="double"/>`;
    xml += '<vectorChild type="Structure">'
      + tag('guid', 'String', xmlText(uuid())) + tag('name', 'String', xmlText(m.s.name || 'scan'))
      + `<cartesianBounds type="Structure">${['x', 'y', 'z'].map((a, k) => tag(a + 'Minimum', 'Float', f(m.lo[k])) + tag(a + 'Maximum', 'Float', f(m.hi[k]))).join('')}</cartesianBounds>`
      + (m.hasRgb ? `<colorLimits type="Structure">${['Red', 'Green', 'Blue'].map((a) => tag('color' + a + 'Minimum', 'Integer', 0) + tag('color' + a + 'Maximum', 'Integer', 255)).join('')}</colorLimits>` : '')
      + (m.hasInt ? `<intensityLimits type="Structure">${tag('intensityMinimum', 'Integer', 0)}${tag('intensityMaximum', 'Integer', 65535)}</intensityLimits>` : '')
      + `<points type="CompressedVector" fileOffset="${m.offset}" recordCount="${m.n}"><prototype type="Structure">`
      + fl('cartesianX') + fl('cartesianY') + fl('cartesianZ')
      + (m.hasRgb ? ['Red', 'Green', 'Blue'].map((a) => `<color${a} type="Integer" minimum="0" maximum="255"/>`).join('') : '')
      + (m.hasInt ? '<intensity type="Integer" minimum="0" maximum="65535"/>' : '')
      + '</prototype><codecs type="Vector" allowHeterogeneousChildren="1"/></points></vectorChild>\n';
  }
  // i18n-ignore-end
  xml += '</data3D>\n<images2D type="Vector" allowHeterogeneousChildren="1"/>\n</e57Root>\n';
  const xmlBytes = new TextEncoder().encode(xml);
  align();
  const xmlAt = at;
  push(xmlBytes);
  const pad = (PAYLOAD - (at % PAYLOAD)) % PAYLOAD;
  if (pad) push(new Uint8Array(pad));
  const fileLength = phys(at);
  const H = new DataView(chunks[0].buffer);
  asciiInto(H, 0, 'ASTM-E57', 8); H.setUint32(8, 1, true); H.setUint32(12, 0, true);
  H.setBigUint64(16, BigInt(fileLength), true); H.setBigUint64(24, BigInt(phys(xmlAt)), true); H.setBigUint64(32, BigInt(xmlBytes.length), true); H.setBigUint64(40, BigInt(PAGE), true);
  // ---- pages: 1020 bytes of the logical file, then their CRC-32C (big-endian)
  const parts = [];
  const OUT = 4096 * PAGE;
  let out = new Uint8Array(OUT), o = 0, filled = 0;
  const page = new Uint8Array(PAGE);
  const closePage = () => {
    const crc = crc32c(page, 0, PAYLOAD);
    page[PAYLOAD] = crc >>> 24; page[PAYLOAD + 1] = (crc >>> 16) & 255; page[PAYLOAD + 2] = (crc >>> 8) & 255; page[PAYLOAD + 3] = crc & 255;
    out.set(page, o); o += PAGE; filled = 0;
    if (o === OUT) { parts.push(out); out = new Uint8Array(OUT); o = 0; }
  };
  for (const ch of chunks) {
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(PAYLOAD - filled, ch.length - i);
      page.set(ch.subarray(i, i + take), filled); filled += take; i += take;
      if (filled === PAYLOAD) closePage();
    }
  }
  if (filled) throw fail('internal');   // padded to a whole page above
  if (o) parts.push(out.subarray(0, o));
  return { blob: new Blob(parts, { type: 'model/e57' }), count: all.n, scans: meta.length, min: all.lo, max: all.hi, bytes: fileLength };
}
