/* SPDX-License-Identifier: Apache-2.0 */
/**
 * model-write.js — the writer the building tools share (0.5 part 3, track BM: model-levels.js, model-walls.js,
 * model-openings.js, model-slabs.js). No DOM: bin/test-bimcraft.mjs --model runs it in Node.
 *
 * ModelWriter is an IfcPlacer (ifc-place.js) — its journal is what makes each tool action ONE undo step: every line made
 * and the first state of every line changed or deleted is kept, and undoJournal puts them back. On top of it:
 *
 *   const w = new ModelWriter(WebIFC, api, mid);
 *   w.run((w) => { … }) → { journal, …what the function returned }   a journaled change; a throw undoes what it wrote
 *   w.byGuid(guid) → id | null           products, storeys and types the tools make or edit are found by GlobalId
 *   w.guidOf(id)
 *   w.storeyWorld(storey)                the storey's world matrix in MILLIMETRES (Z up); local plan = its X/Y
 *   w.placeAt(relTo, x, y, z, angDeg)    a new IfcLocalPlacement relative to a placement (mm, degrees about Z)
 *   w.movePlacement(lp, x, y, z, ang)    the same placement line, a new IfcAxis2Placement3D (children follow)
 *   w.setShape(pid, reps)                the product's representation replaced (the old shape's lines deleted; a painted
 *                                        material's style moves to the new body items: paintStyleOf, bodyItemsOf)
 *   w.profile(points) / w.extrude(profile, z0, depth) / w.box(x0, y0, z0, x1, y1, z1) / w.polyline2(points)
 *   w.rep(ctxKey, ident, type, items)    an IfcShapeRepresentation in the Body / Axis / FootPrint sub-context
 *   w.readPset(id, name) → { prop: value } · w.upsertPset(id, name, rows) · w.upsertQto(id, name, rows)
 *   w.contain(id, storey) (IfcPlacer)    w.relateType(id, type) (IfcPlacer)
 *   w.dropProduct(id)                     deletes an element the tools made: relations, placement, shape, own sets
 *
 * Everything the tools write is the element's OWN lines (no sharing of points, directions or profiles between
 * products), so replacing a shape can delete the old one without asking who else points at it. Lengths in mm in, file
 * units out (IfcPlacer.u). Undo/redo: IfcEditor.modelChange (ifc-edit.js) records { journal, again: { run } }; a redo
 * runs the same function again, and the functions name elements by GlobalId, never by expressID.
 */
import { IfcPlacer, undoJournal } from './ifc-place.js';
import { ids, val, inv4, mul4, deleteLine } from './ifc-util.js';

const D2R = Math.PI / 180;
const isH = (v) => v && typeof v === 'object' && v.type === 5 && typeof v.value === 'number';
/** Lines dropTree never deletes: shared by every product (contexts, owner history) or not geometry (placements). */
const KEEP = /^IFC(GEOMETRICREPRESENTATION(SUB)?CONTEXT|OWNERHISTORY|LOCALPLACEMENT|REPRESENTATIONMAP|MATERIAL.*|PRESENTATIONLAYERASSIGNMENT|PRESENTATIONSTYLEASSIGNMENT|SURFACESTYLE.*|COLOURRGB)$/;
/** Classes the tools look up by GlobalId. */
const GUID_CLASSES = ['IFCANNOTATION', 'IFCBUILDINGSTOREY', 'IFCBUILDING', 'IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCDOOR', 'IFCWINDOW', 'IFCOPENINGELEMENT', 'IFCSLAB', 'IFCCOVERING', 'IFCROOF', 'IFCSPACE',
  'IFCWALLTYPE', 'IFCDOORTYPE', 'IFCWINDOWTYPE', 'IFCSLABTYPE', 'IFCCOVERINGTYPE', 'IFCROOFTYPE',
  'IFCCOLUMN', 'IFCGRID', 'IFCRAMP', 'IFCRAMPFLIGHT', 'IFCSITE',   // 0.6 (bim-draw): columns, grids, ramps, the site
  'IFCELEMENTASSEMBLY'];   // 0.6 DF.29: pipe and duct runs (mep-model.js)
export const round = (v, d = 6) => { const r = Math.round(v * 10 ** d) / 10 ** d; return Object.is(r, -0) ? 0 : r; };

export class ModelWriter extends IfcPlacer {
  constructor(W, api, mid) {
    super(W, api, mid);
    this._guids = null;   // guid → id
    this._defs = null;    // object id → [{ def, rel }]
  }

  /** A journaled change. `fn(this)` writes; its result is returned with the journal. A throw undoes what it wrote. */
  run(fn) {
    this.begin();
    try {
      const r = fn(this) || {};
      const journal = this.journal; this.journal = null;
      return { ...r, journal };
    } catch (e) {
      if (this.journal) { const j = this.journal; this.journal = null; undoJournal(this.api, this.mid, j); }
      this._guids = null; this._defs = null;
      throw e;
    }
  }

  // ---- finding things ----
  byGuid(guid) {
    if (!guid) return null;
    if (!this._guids) {
      this._guids = new Map();
      for (const c of GUID_CLASSES) {
        let list = [];
        try { list = ids(this.api, this.mid, c); } catch (e) { continue; }
        for (const id of list) { const g = this.guidOf(id); if (g) this._guids.set(g, id); }
      }
    }
    return this._guids.get(guid) ?? null;
  }
  guidOf(id) { const l = this.api.GetLine(this.mid, id, false); return l ? val(l.GlobalId) : null; }
  /** Remember a line made here (make() of an IfcRoot with a known GlobalId). */
  noteGuid(guid, id) { if (this._guids) this._guids.set(guid, id); }
  /** A GlobalId for a new element: the one the caller fixed (a redo makes the same element again), else a fresh one. */
  gid(fixed) { return fixed || val(this.guid()); }

  /** The storey's world matrix in mm (column-major 4×4, Z up, the file's own coordinates — no coordination matrix). */
  storeyWorld(storey) {
    const st = this.api.GetLine(this.mid, storey, false);
    const M = st?.ObjectPlacement ? this.api.GetWorldTransformMatrix(this.mid, st.ObjectPlacement.value) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    return scaleT(M, this.unitMm);
  }
  /** World Z (mm) of a placement's origin. */
  relWorldZ(lp) { return this.api.GetWorldTransformMatrix(this.mid, lp)[14] * this.unitMm; }
  /** A placement's matrix relative to another one's (mm): where `child` sits in `parent`'s axes. */
  relMatrix(parentLp, childLp) {
    const P = scaleT(this.api.GetWorldTransformMatrix(this.mid, parentLp), this.unitMm), C = scaleT(this.api.GetWorldTransformMatrix(this.mid, childLp), this.unitMm);
    return mul4(inv4(P), C);
  }

  // ---- placements ----
  axis3(x, y, z, angDeg) {
    const a = (angDeg || 0) * D2R;
    const loc = this.point3(round(this.u(x)), round(this.u(y)), round(this.u(z)));
    return this.make('IFCAXIS2PLACEMENT3D', this.H(loc), this.H(this.dir(0, 0, 1)), this.H(this.dir(round(Math.cos(a), 12), round(Math.sin(a), 12), 0)));
  }
  placeAt(relTo, x, y, z, angDeg) { return this.make('IFCLOCALPLACEMENT', relTo ? this.H(relTo) : null, this.H(this.axis3(x, y, z, angDeg))); }
  movePlacement(lp, x, y, z, angDeg) {
    const line = this.touch(lp);
    const old = line.RelativePlacement?.value;
    line.RelativePlacement = this.H(this.axis3(x, y, z, angDeg));
    this.write(line);
    if (old) this.dropTree(old);
  }

  // ---- geometry (mm in) ----
  point2mm(x, y) { return this.point2(round(this.u(x)), round(this.u(y))); }
  polyline2(points, close = false) {
    const pts = points.map(([x, y]) => this.H(this.point2mm(x, y)));
    if (close && pts.length) pts.push(pts[0]);
    return this.make('IFCPOLYLINE', pts);
  }
  polyline3(points) { return this.make('IFCPOLYLINE', points.map(([x, y, z]) => this.H(this.point3(round(this.u(x)), round(this.u(y)), round(this.u(z)))))); }
  profile(points, name = null) { return this.make('IFCARBITRARYCLOSEDPROFILEDEF', 'AREA', this.L(name), this.H(this.polyline2(points, true))); }
  extrude(profile, z0, depth, dir = [0, 0, 1]) {
    const pos = this.make('IFCAXIS2PLACEMENT3D', this.H(this.point3(0, 0, round(this.u(z0)))), null, null);
    return this.make('IFCEXTRUDEDAREASOLID', this.H(profile), this.H(pos), this.H(this.dir(...dir)), round(this.u(depth)));
  }
  /** A profile with holes (rooms round a free-standing wall). */
  profileVoids(outer, holes = [], name = null) {
    if (!holes.length) return this.profile(outer, name);
    return this.make('IFCARBITRARYPROFILEDEFWITHVOIDS', 'AREA', this.L(name), this.H(this.polyline2(outer, true)), holes.map((h) => this.H(this.polyline2(h, true))));
  }
  /** An IfcAxis2Placement3D at o (mm) with its Z along zDir and X along xDir (unit vectors). */
  axisFrame(o, zDir, xDir) {
    const r = (v) => round(v, 12);
    return this.make('IFCAXIS2PLACEMENT3D', this.H(this.point3(round(this.u(o[0])), round(this.u(o[1])), round(this.u(o[2])))), this.H(this.dir(r(zDir[0]), r(zDir[1]), r(zDir[2]))), this.H(this.dir(r(xDir[0]), r(xDir[1]), r(xDir[2]))));
  }
  /** A profile (mm, in the frame's X/Y) extruded by depth along dir (in the frame's axes; default its Z). */
  extrudeAt(profile, frame, depth, dir = [0, 0, 1]) {
    return this.make('IFCEXTRUDEDAREASOLID', this.H(profile), this.H(frame), this.H(this.dir(round(dir[0], 12), round(dir[1], 12), round(dir[2], 12))), round(this.u(depth)));
  }
  box(x0, y0, z0, x1, y1, z1) {
    return this.extrude(this.profile([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]), z0, z1 - z0);
  }
  ctxOf(key) {
    const c = this.contexts();
    if (key === 'body') return c.body;
    if (key === 'foot') return c.foot;
    if (!c[key]) c[key] = c.sub(key === 'axis' ? 'Axis' : key, key === 'axis' ? 'GRAPH_VIEW' : 'MODEL_VIEW');
    return c[key];
  }
  rep(ctxKey, ident, type, items) { return this.make('IFCSHAPEREPRESENTATION', this.H(this.ctxOf(ctxKey)), this.L(ident), this.L(type), items.map((i) => this.H(i))); }
  setShape(pid, reps) {
    const paint = this.paintStyleOf(pid);   // 0.6 BIM-F6: a painted material (paint-bim.js) stays on the new shape
    const line = this.touch(pid);
    const old = line.Representation?.value;
    line.Representation = this.H(this.make('IFCPRODUCTDEFINITIONSHAPE', null, null, reps.map((r) => this.H(r))));
    this.write(line);
    if (old) this.dropTree(old);
    if (paint) for (const item of this.bodyItemsOf(pid)) if (!this.styledOf(item).some((st) => this.api.GetLine(this.mid, st, false))) this.styleItem(item, paint);
  }
  /** The items of a product's 'Body' representations (every representation when none is named so). */
  bodyItemsOf(pid) {
    const p = this.api.GetLine(this.mid, pid, false);
    const sh = p?.Representation?.value ? this.api.GetLine(this.mid, p.Representation.value, false) : null;
    const reps = (sh?.Representations || []).map((h) => this.api.GetLine(this.mid, h.value, false)).filter(Boolean);
    const body = reps.filter((r) => String(val(r.RepresentationIdentifier) || '').toLowerCase() === 'body');
    return (body.length ? body : reps).flatMap((r) => (r.Items || []).map((h) => h.value));
  }
  /** The surface style a painted material gave the product's body ("<material> (CadCraft)", paint-bim.js), or null. */
  paintStyleOf(pid) {
    for (const item of this.bodyItemsOf(pid)) for (const st of this.styledOf(item)) {
      const si = this.api.GetLine(this.mid, st, false);
      for (const h of si?.Styles || []) {
        let sid = h.value, s0 = this.api.GetLine(this.mid, sid, false);
        if (s0 && !this.v4 && s0.Styles) { sid = s0.Styles[0]?.value; s0 = sid ? this.api.GetLine(this.mid, sid, false) : null; }   // IFC2X3: IfcPresentationStyleAssignment
        if (s0 && / \(CadCraft\)$/.test(String(val(s0.Name) || ''))) return sid;
      }
    }
    return null;
  }
  /** Delete a line and every line under it that only geometry uses (see KEEP). Journaled, so undo writes them back. */
  dropTree(id, seen = new Set()) {
    if (seen.has(id)) return;
    seen.add(id);
    let line;
    try { line = this.api.GetLine(this.mid, id, false); } catch (e) { return; }
    if (!line) return;
    const cls = String(line.constructor?.name || '').toUpperCase();
    if (KEEP.test(cls)) return;
    const kids = [];
    const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (isH(v)) kids.push(v.value); };
    for (const k of Object.keys(line)) if (k !== 'expressID' && k !== 'type') walk(line[k]);
    this.touch(id);
    deleteLine(this.api, this.mid, id);
    // a colour given to this item (IfcStyledItem points at it, not the other way round) goes with it
    for (const st of this.styledOf(id)) { if (!seen.has(st)) { seen.add(st); this.touch(st); deleteLine(this.api, this.mid, st); } }
    for (const k of kids) this.dropTree(k, seen);
  }
  /** IfcStyledItems naming a representation item (an index read once per writer, kept up to date by styleItem). */
  styledOf(id) {
    if (!this._styled) {
      this._styled = new Map();
      for (const sid of ids(this.api, this.mid, 'IFCSTYLEDITEM')) {
        const it = this.api.GetLine(this.mid, sid, false)?.Item?.value;
        if (it) { if (!this._styled.has(it)) this._styled.set(it, []); this._styled.get(it).push(sid); }
      }
    }
    return this._styled.get(id) || [];
  }

  // ---- colours ----
  /** A surface style by name (found in the file, else made): rgb 0–1, transparency 0–1 (IFC4; IFC2X3 gets the colour only). */
  surfaceStyle(name, [r, g, b], transparency = 0) {
    if (!this._styles) {
      this._styles = new Map();
      for (const id of ids(this.api, this.mid, 'IFCSURFACESTYLE')) { const n = val(this.api.GetLine(this.mid, id, false).Name); if (n && !this._styles.has(n)) this._styles.set(n, id); }
    }
    let id = this._styles.get(name);
    if (id && !this.api.GetLine(this.mid, id, false)) id = null;
    if (id) return id;
    const col = this.make('IFCCOLOURRGB', null, r, g, b);
    const shade = this.v4 ? this.make('IFCSURFACESTYLESHADING', this.H(col), transparency || 0) : this.make('IFCSURFACESTYLESHADING', this.H(col));
    id = this.make('IFCSURFACESTYLE', this.L(name), 'BOTH', [this.H(shade)]);
    this._styles.set(name, id);
    return id;
  }
  styleItem(itemId, styleId) {
    const styles = this.v4 ? [this.H(styleId)] : [this.H(this.make('IFCPRESENTATIONSTYLEASSIGNMENT', [this.H(styleId)]))];
    const sid = this.make('IFCSTYLEDITEM', this.H(itemId), styles, null);
    if (this._styled) { if (!this._styled.has(itemId)) this._styled.set(itemId, []); this._styled.get(itemId).push(sid); }
    return sid;
  }

  // ---- property sets and quantities ----
  defs(id) {
    if (!this._defs) {
      this._defs = new Map();
      for (const rid of ids(this.api, this.mid, 'IFCRELDEFINESBYPROPERTIES')) {
        const r = this.api.GetLine(this.mid, rid, false);
        const d = r.RelatingPropertyDefinition?.value;
        if (!d) continue;
        for (const h of r.RelatedObjects || []) { if (!this._defs.has(h.value)) this._defs.set(h.value, []); this._defs.get(h.value).push({ def: d, rel: rid }); }
      }
    }
    return this._defs.get(id) || [];
  }
  defNamed(id, name) {
    for (const d of this.defs(id)) { const l = this.api.GetLine(this.mid, d.def, false); if (l && val(l.Name) === name) return { ...d, line: l }; }
    return null;
  }
  readPset(id, name) {
    const d = this.defNamed(id, name), out = {};
    if (!d) return null;
    for (const h of d.line.HasProperties || []) { const p = this.api.GetLine(this.mid, h.value, false); if (p?.Name) out[val(p.Name)] = val(p.NominalValue); }
    return out;
  }
  /** Set these values (rows [name, IFC type, value]) in the element's own set `name`, making the set or the property. */
  upsertPset(id, name, rows) {
    const d = this.defNamed(id, name);
    if (!d) { const ps = this.pset(name, rows); this.relateDef(id, ps); return ps; }
    const have = new Map();
    for (const h of d.line.HasProperties || []) { const p = this.api.GetLine(this.mid, h.value, false); if (p?.Name) have.set(val(p.Name), h.value); }
    const add = [];
    for (const [n, type, v] of rows) {
      if (v === null || v === undefined) continue;
      const pid = have.get(n);
      if (pid) {
        const p = this.api.GetLine(this.mid, pid, false);
        if (val(p.NominalValue) === v && String(p.NominalValue?.name || '').toUpperCase() === type) continue;
        const q = this.touch(pid); q.NominalValue = this.T(type, v); this.write(q);
      } else add.push([n, type, v]);
    }
    if (add.length) { const ps = this.touch(d.def); ps.HasProperties = [...(ps.HasProperties || []), ...this.propLines(add)]; this.write(ps); }
    return d.def;
  }
  /** Quantities (rows [name, 'length'|'area'|'volume'|'count', value in mm / mm² / mm³ / n]) in the element's own set. */
  upsertQto(id, name, rows) {
    const KIND = { length: ['IFCQUANTITYLENGTH', 'LengthValue'], area: ['IFCQUANTITYAREA', 'AreaValue'], volume: ['IFCQUANTITYVOLUME', 'VolumeValue'], count: ['IFCQUANTITYCOUNT', 'CountValue'] };
    const conv = (kind, v) => kind === 'length' ? round(this.u(v), 6) : kind === 'area' ? round(v / 1e6, 6) : kind === 'volume' ? round(v / 1e9, 6) : v;   // areas m², volumes m³ (the project's SI units)
    const make = ([n, kind, v]) => this.H(this.make(KIND[kind][0], this.T('IFCLABEL', n), null, null, conv(kind, v), ...(this.v4 ? [null] : [])));
    const d = this.defNamed(id, name);
    if (!d) {
      const q = this.make('IFCELEMENTQUANTITY', this.guid(), this.ownerHistory(), this.L(name), null, this.L('BaseQuantities'), rows.map(make));
      this.relateDef(id, q);
      return q;
    }
    const have = new Map();
    for (const h of d.line.Quantities || []) { const p = this.api.GetLine(this.mid, h.value, false); if (p?.Name) have.set(val(p.Name), h.value); }
    const add = [];
    for (const row of rows) {
      const qid = have.get(row[0]);
      if (!qid) { add.push(row); continue; }
      const q = this.touch(qid); q[KIND[row[1]][1]] = conv(row[1], row[2]); this.write(q);
    }
    if (add.length) { const s = this.touch(d.def); s.Quantities = [...(s.Quantities || []), ...add.map(make)]; this.write(s); }
    return d.def;
  }
  relateDef(id, def) {
    const rel = this.relate(id, def);
    if (this._defs) { if (!this._defs.has(id)) this._defs.set(id, []); this._defs.get(id).push({ def, rel }); }
    return rel;
  }

  /** Material: an IfcMaterial by name (made once per file). */
  material(name) {
    if (!this._mats) {
      this._mats = new Map();
      for (const id of ids(this.api, this.mid, 'IFCMATERIAL')) { const n = val(this.api.GetLine(this.mid, id, false).Name); if (n && !this._mats.has(n)) this._mats.set(n, id); }
    }
    let id = this._mats.get(name);
    if (id && !this.api.GetLine(this.mid, id, false)) id = null;   // undone since
    if (!id) { id = this.make('IFCMATERIAL', this.L(name), ...(this.v4 ? [null, null] : [])); this._mats.set(name, id); }
    return id;
  }
  /** IfcRelAssociatesMaterial for one object (a new relation; the tools give each element its own usage). */
  associateMaterial(id, matDef) {
    return this.make('IFCRELASSOCIATESMATERIAL', this.guid(), this.ownerHistory(), null, null, [this.H(id)], this.H(matDef));
  }
  /** The relation that gives `id` its material (IfcRelAssociatesMaterial id + the material definition), or null. */
  materialRel(id) {
    for (const rid of ids(this.api, this.mid, 'IFCRELASSOCIATESMATERIAL')) {
      const r = this.api.GetLine(this.mid, rid, false);
      if ((r.RelatedObjects || []).some((h) => h.value === id)) return { rel: rid, def: r.RelatingMaterial?.value };
    }
    return null;
  }

  /** Openings and what fills them: voids (element → [openings]), voidHost (opening → element), fills (opening → [door…]),
   *  filledBy (door → opening). Read now (cheap: two relationship classes). */
  hostIndex() {
    const R = { voids: new Map(), voidHost: new Map(), fills: new Map(), filledBy: new Map() };
    const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    for (const rid of ids(this.api, this.mid, 'IFCRELVOIDSELEMENT')) {
      const r = this.api.GetLine(this.mid, rid, false);
      const e = r.RelatingBuildingElement?.value, o = r.RelatedOpeningElement?.value;
      if (e && o) { push(R.voids, e, o); R.voidHost.set(o, e); }
    }
    for (const rid of ids(this.api, this.mid, 'IFCRELFILLSELEMENT')) {
      const r = this.api.GetLine(this.mid, rid, false);
      const o = r.RelatingOpeningElement?.value, f = r.RelatedBuildingElement?.value;
      if (o && f) { push(R.fills, o, f); R.filledBy.set(f, o); }
    }
    return R;
  }

  /** The storey an element is contained in (IfcRelContainedInSpatialStructure), or null. */
  storeyOfId(id) {
    for (const rid of ids(this.api, this.mid, 'IFCRELCONTAINEDINSPATIALSTRUCTURE')) {
      const r = this.api.GetLine(this.mid, rid, false);
      if ((r.RelatedElements || []).some((h) => h.value === id)) return r.RelatingStructure?.value ?? null;
    }
    return null;
  }

  /**
   * Delete an element the tools made: every relationship that names it loses it (a relation left empty goes), then its
   * own placement axes, its shape, its own property sets and quantities, and the line itself. `alsoIds` go the same way
   * in the same pass (a wall's openings, doors and windows).
   */
  dropProduct(list) {
    const api = this.api, mid = this.mid;
    const gone = new Set(Array.isArray(list) ? list : [list]);
    const own = [];
    for (const id of gone) for (const d of this.defs(id)) own.push(d.def);
    for (const rid of ids(api, mid, 'IFCRELATIONSHIP', true)) {
      const line = api.GetLine(mid, rid, false);
      let dead = false, changed = false;
      for (const k of Object.keys(line)) {
        if (k === 'expressID' || k === 'type') continue;
        const v = line[k];
        if (isH(v)) { if (gone.has(v.value)) { dead = true; break; } }
        else if (Array.isArray(v) && v.some((h) => isH(h) && gone.has(h.value))) {
          const keep = v.filter((h) => !(isH(h) && gone.has(h.value)));
          if (!keep.length) { dead = true; break; }
          line[k] = keep; changed = true;
        }
      }
      if (dead) {
        const l = this.touch(rid);
        // a material usage or a set of this element alone goes with its relation
        const m = l.RelatingMaterial?.value;
        deleteLine(api, mid, rid);
        if (m) { const ml = api.GetLine(mid, m, false); if (/USAGE$/i.test(ml?.constructor?.name || '')) { this.touch(m); deleteLine(api, mid, m); } }
      } else if (changed) { this.touch(rid); this.write(line); }
    }
    for (const def of own) this.dropTree(def);
    for (const id of gone) {
      const l = api.GetLine(mid, id, false);
      if (!l) continue;
      const shape = l.Representation?.value, lp = l.ObjectPlacement?.value;
      this.touch(id);
      deleteLine(api, mid, id);
      if (shape) this.dropTree(shape);
      if (lp) { const pl = api.GetLine(mid, lp, false); this.touch(lp); deleteLine(api, mid, lp); if (pl?.RelativePlacement?.value) this.dropTree(pl.RelativePlacement.value); }
    }
    this._defs = null; this._guids = null;
  }
}

/** A world matrix in file units → mm (translation scaled). */
export function scaleT(M, unitMm) {
  const o = M.slice();
  o[12] *= unitMm; o[13] *= unitMm; o[14] *= unitMm;
  return o;
}
