/* SPDX-License-Identifier: Apache-2.0 */
/**
 * ifc-out.js — process equipment as an IFC4 file (0.7 LC.5 step 2, session plant-design). DOM-free (tested in Node).
 *
 * Writes the equipment of equip.js (a pump, a tank, an exchanger…) as a standalone IFC4 file: a project, site, building and one
 * storey, and for each item the right class (IfcPump, IfcTank, IfcHeatExchanger, IfcCompressor, IfcFan) with its place, its solids
 * as an IfcTriangulatedFaceSet, and one IfcDistributionPort per nozzle (nested in the item, flow direction, a placement at the
 * nozzle facing out) so the pipe runs of any program can connect to it. The tag, description and capacity are in the property
 * set CadCraft_Plant, each nozzle's size in CadCraft_Nozzle. The file is plain STEP text; no library is needed to write it.
 *
 *   writeIfc({ name?, project?, items: [{ equip (from makeEquipment, NOT placed), tag?, desc?, x?, y?, z?, rot? (degrees) }], seed? })
 *     → { text, bytes (UTF-8), counts: { equipment, ports, triangles } }
 *   guid(seed, n) → a 22-character IFC GlobalId (the same seed and n always give the same one)
 *
 * Lengths are millimetres (the project's length unit). `seed` makes GlobalIds repeatable (tests); by default they are random.
 */

const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
function compress(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 22; i++) { out = CH[Number(n & 63n)] + out; n >>= 6n; }
  return out;
}
function rng(seed) {   // xorshift128 from a string seed
  let h = 2166136261;
  for (const c of String(seed)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const s = [h || 1, h ^ 0x9e3779b9, h ^ 0x85ebca6b, h ^ 0xc2b2ae35].map((x) => x >>> 0 || 1);
  return () => { let t = s[3]; t ^= t << 11; t ^= t >>> 8; s[3] = s[2]; s[2] = s[1]; s[1] = s[0]; t ^= s[0]; t ^= s[0] >>> 19; s[0] = t >>> 0; return s[0]; };
}
export function guid(seed, n = 0) {
  const r = seed === undefined ? () => (globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0] : Math.floor(Math.random() * 2 ** 32)) : rng(seed + ':' + n);
  const bytes = [];
  for (let i = 0; i < 4; i++) { const v = r() >>> 0; bytes.push(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }
  return compress(bytes);
}

/** STEP string content: quote and backslash doubled, anything above ASCII as \X2\…\X0\. */
export function esc(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0);
    if (ch === "'") out += "''"; else if (ch === '\\') out += '\\\\';
    else if (c >= 32 && c < 127) out += ch;
    else if (c < 32) out += ' ';
    else if (c <= 0xffff) out += '\\X2\\' + c.toString(16).toUpperCase().padStart(4, '0') + '\\X0\\';
    else { const h = c - 0x10000; out += '\\X2\\' + (0xd800 + (h >> 10)).toString(16).toUpperCase() + (0xdc00 + (h & 0x3ff)).toString(16).toUpperCase() + '\\X0\\'; }
  }
  return out;
}
const num = (v) => { const s = (Math.round(v * 1e4) / 1e4).toString(); return /[.eE]/.test(s) ? s : s + '.'; };
const vec = (v) => '(' + v.map(num).join(',') + ')';
const str = (s) => (s === undefined || s === null || s === '' ? '$' : "'" + esc(s) + "'");

const perp = (d) => { const a = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; const c = [d[1] * a[2] - d[2] * a[1], d[2] * a[0] - d[0] * a[2], d[0] * a[1] - d[1] * a[0]]; const l = Math.hypot(...c) || 1; return c.map((x) => x / l); };

export function writeIfc({ name = 'Plant equipment', project = 'Plant', items = [], seed } = {}) {
  const lines = [];
  let n = 0, gn = 0;
  const add = (s) => { lines.push('#' + ++n + '=' + s + ';'); return '#' + n; };
  const G = () => "'" + guid(seed, gn++) + "'";
  const pt = (v) => add('IFCCARTESIANPOINT(' + vec(v) + ')');
  const dir = (v) => add('IFCDIRECTION(' + vec(v) + ')');
  const axis = (p, z, x) => add('IFCAXIS2PLACEMENT3D(' + pt(p) + ',' + (z ? dir(z) : '$') + ',' + (x ? dir(x) : '$') + ')');
  const place = (rel, p, z, x) => add('IFCLOCALPLACEMENT(' + (rel || '$') + ',' + axis(p, z, x) + ')');

  const units = add('IFCUNITASSIGNMENT((' + [
    add('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)'), add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)'), add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)'),
    add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)'), add('IFCSIUNIT(*,.MASSUNIT.,.KILO.,.GRAM.)')].join(',') + '))');
  const ctxAxis = axis([0, 0, 0]);
  const ctx = add('IFCGEOMETRICREPRESENTATIONCONTEXT($,\'Model\',3,1.E-05,' + ctxAxis + ',$)');
  const body = add('IFCGEOMETRICREPRESENTATIONSUBCONTEXT(\'Body\',\'Model\',*,*,*,*,' + ctx + ',$,.MODEL_VIEW.,$)');
  const proj = add('IFCPROJECT(' + G() + ',$,' + str(project) + ',$,$,$,$,(' + ctx + '),' + units + ')');
  const pSite = place(null, [0, 0, 0]), pBld = place(pSite, [0, 0, 0]), pSto = place(pBld, [0, 0, 0]);
  const site = add('IFCSITE(' + G() + ',$,\'Site\',$,$,' + pSite + ',$,$,.ELEMENT.,$,$,$,$,$)');
  const bld = add('IFCBUILDING(' + G() + ',$,' + str(name) + ',$,$,' + pBld + ',$,$,.ELEMENT.,$,$,$)');
  const sto = add('IFCBUILDINGSTOREY(' + G() + ',$,\'Ground\',$,$,' + pSto + ',$,$,.ELEMENT.,0.)');
  add('IFCRELAGGREGATES(' + G() + ',$,$,$,' + proj + ',(' + site + '))');
  add('IFCRELAGGREGATES(' + G() + ',$,$,$,' + site + ',(' + bld + '))');
  add('IFCRELAGGREGATES(' + G() + ',$,$,$,' + bld + ',(' + sto + '))');

  const made = [];
  let ports = 0, tris = 0;
  const props = (owner, setName, list) => {
    const ids = list.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => add('IFCPROPERTYSINGLEVALUE(' + str(k) + ',$,' + (typeof v === 'number' ? 'IFCREAL(' + num(v) + ')' : 'IFCLABEL(\'' + esc(v) + '\')') + ',$)'));
    if (!ids.length) return;
    const set = add('IFCPROPERTYSET(' + G() + ',$,' + str(setName) + ',$,(' + ids.join(',') + '))');
    add('IFCRELDEFINESBYPROPERTIES(' + G() + ',$,$,$,(' + owner + '),' + set + ')');
  };
  for (const it of items) {
    const eq = it.equip;
    if (!eq || !eq.mesh || !eq.ifc) continue;
    const rot = ((it.rot || 0) * Math.PI) / 180;
    const pl = place(pSto, [it.x || 0, it.y || 0, it.z || 0], [0, 0, 1], [Math.cos(rot), Math.sin(rot), 0]);
    const list = add('IFCCARTESIANPOINTLIST3D((' + eq.mesh.verts.map(vec).join(',') + '))');
    const fs = add('IFCTRIANGULATEDFACESET(' + list + ',$,.T.,(' + eq.mesh.tris.map(([a, b, c]) => '(' + (a + 1) + ',' + (b + 1) + ',' + (c + 1) + ')').join(',') + '),$)');
    const rep = add('IFCSHAPEREPRESENTATION(' + body + ',\'Body\',\'Tessellation\',(' + fs + '))');
    const shape = add('IFCPRODUCTDEFINITIONSHAPE($,$,(' + rep + '))');
    const el = add(eq.ifc.cls + '(' + G() + ',$,' + str(it.tag || eq.type) + ',' + str(it.desc) + ',' + str(eq.type) + ',' + pl + ',' + shape + ',' + str(it.tag) + ',.' + eq.ifc.predefined + '.)');
    made.push(el);
    tris += eq.mesh.tris.length;
    const portIds = eq.nozzles.map((nz) => {
      const z = nz.out, x = perp(z);
      const id = add('IFCDISTRIBUTIONPORT(' + G() + ',$,' + str(nz.name) + ',$,$,' + place(pl, nz.p, z, x) + ',$,.' + nz.flow + '.,.PIPE.,$)');
      props(id, 'CadCraft_Nozzle', [['Size', nz.size], ['Flow', nz.flow === 'SINK' ? 'in' : nz.flow === 'SOURCE' ? 'out' : 'both']]);
      ports++;
      return id;
    });
    if (portIds.length) add('IFCRELNESTS(' + G() + ',$,$,$,' + el + ',(' + portIds.join(',') + '))');
    props(el, 'CadCraft_Plant', [['Tag', it.tag], ['Type', eq.type], ['Description', it.desc], ['CapacityM3', eq.capacityM3 ? Math.round(eq.capacityM3 * 1000) / 1000 : undefined]]);
  }
  if (made.length) add('IFCRELCONTAINEDINSPATIALSTRUCTURE(' + G() + ',$,$,$,(' + made.join(',') + '),' + sto + ')');

  const stamp = new Date(0).toISOString().replace(/\.\d+Z$/, '');
  const text = 'ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((\'ViewDefinition [CoordinationView]\'),\'2;1\');\nFILE_NAME(\'' + esc(name) + '.ifc\',\'' + (seed === undefined ? new Date().toISOString().replace(/\.\d+Z$/, '') : stamp) + '\',(\'CadCraft\'),(\'CadCraft\'),\'CadCraft Plant\',\'CadCraft\',\'\');\nFILE_SCHEMA((\'IFC4\'));\nENDSEC;\nDATA;\n' + lines.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n';
  return { text, bytes: new TextEncoder().encode(text), counts: { equipment: made.length, ports, triangles: tris } };
}
