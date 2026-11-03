/* SPDX-License-Identifier: Apache-2.0 */
/**
 * family-ifc.js — families in small IFC files of their own (0.6 DC.114, session bim-families_PART_2). No DOM: the editor's
 * preview and the family files use it in the page; bin/test-bimcraft.mjs --families runs it in Node.
 *
 *   const s = await familyScratch(WebIFC, IfcModel)        a blank one-level building on its own engine (reused)
 *   await s.preview(recipe, values, { wallThickness })      → { bytes, model }   the family written by the same ops as the
 *                                                           model (a door / window in a 3 m wall, anything else on the floor),
 *                                                           read back by cc-ifc: what the preview draws is what is saved
 *   await s.library(file)                                  → bytes   the family as an IFC library: IfcProjectLibrary declaring
 *                                                           (IfcRelDeclares) its sizes' types and its IfcGroup (IFC4)
 *   await s.familiesIn(bytes)                              → [family files]   every family stored in an IFC file (ours)
 *   s.close()
 */
import { newBuilding, stackLevels } from './new-model.js';
import { IfcEditor } from './ifc-edit.js';
import { ModelWriter } from './model-write.js';
import { snapshotModel, drawWalls, placeOpening, op } from './model-ops.js';
import { importFamily, placeFamily, familyFile, familyWriter, setFamilyDetail } from './family-ops.js';
import { readFamily, familyIndex, sizeValues, instanceValues } from './family-model.js';
import { ids } from './ifc-util.js';

const blank = () => new TextEncoder().encode(newBuilding({ name: 'Family', levels: stackLevels(1, 3000, () => 'Level 1'), fileName: 'family.ifc', now: new Date() }));   // i18n-ignore: names inside a scratch file nobody sees

export async function familyScratch(WebIFC, IfcModel) {
  const eng = await IfcModel.create(WebIFC, null);
  const view = IfcModel.sharing(eng);
  async function fresh(bytes = blank()) {
    await eng.load(bytes);
    const ed = new IfcEditor(WebIFC, eng);
    return { ed, levels: snapshotModel(ed).levels };
  }
  return {
    async preview(recipe, values = {}, { wallThickness = 140, deps = [], detail = 'auto' } = {}) {
      const r = readFamily(recipe);
      if (!r.ok) return { error: r.errors[0] };
      const fam = { ...r.family, key: 'fam-preview0' };
      const { ed, levels } = await fresh();
      const L1 = levels[0].guid;
      try {
        for (const d of deps) ed.modelChange(importFamily({ ...d, sizes: [], revision: undefined }, { key: d.key }));   // the families it holds, under their own keys
        if (detail !== 'auto') ed.modelChange(setFamilyDetail(detail));
        ed.modelChange(importFamily({ ...fam, sizes: [] }, { key: fam.key }));
        if (fam.host === 'wall') {
          const v = sizeValues(fam, values);
          const len = Math.max(3000, v.Width + 1200);
          ed.modelChange(drawWalls({ storey: L1, segs: [{ a: [-(len - v.Width) / 2, 0], b: [(len + v.Width) / 2, 0] }], typeKey: wallThickness <= 100 ? 'int-2x4' : 'ext-2x6', height: Math.max(2700, (v.Height || 0) + 900) }));
          const wall = snapshotModel(ed).walls[0].guid;
          ed.modelChange(placeOpening({ wall, family: fam.key, values: v, instance: instanceValues(fam, values), offset: (len - v.Width) / 2, width: v.Width, height: v.Height, sill: fam.kind === 'window' ? 900 : 0 }));
        } else ed.modelChange(placeFamily({ storey: L1, family: fam.key, values, instance: instanceValues(fam, values), x: 0, y: 0 }));
      } catch (e) {
        return { error: { key: e.key || 'fam.err.expr', fill: e.fill || { where: '', why: e.message } } };
      }
      const bytes = ed.save();
      const model = await view.load(bytes);
      return { bytes, model, api: view.api };
    },
    async library(file) {
      const { ed } = await fresh();
      ed.modelChange(importFamily(file, { key: file.key }));   // (its `uses` come along: the library holds the families it holds)
      ed.modelChange(op((w) => {
        familyWriter(w);
        const proj = w.api.GetLine(w.mid, ids(w.api, w.mid, 'IFCPROJECT')[0], false);
        const idx = familyIndex(w), g = idx.groups.get(file.key);
        const lib = w.make('IFCPROJECTLIBRARY', w.guid(), w.ownerHistory(), w.L(file.name), null, null, null, null, proj.RepresentationContexts, proj.UnitsInContext);
        // the family and its sizes, and every family it holds with theirs (in the scratch file there are no others)
        const defs = [...[...idx.groups.values()].map((x) => w.H(x.id)), ...[...idx.sizes.keys()].map((tid) => w.H(tid))];
        w.make('IFCRELDECLARES', w.guid(), w.ownerHistory(), null, null, w.H(lib), defs);
        w.make('IFCRELDECLARES', w.guid(), w.ownerHistory(), null, null, w.H(proj.expressID), [w.H(lib)]);
        return { id: null, ids: [] };
      }));
      return ed.save();
    },
    async familiesIn(bytes) {
      const { ed } = await fresh(bytes);
      const w = new ModelWriter(WebIFC, ed.api, ed.mid);
      familyWriter(w);
      return [...familyIndex(w).groups].filter(([, g]) => g.fam).map(([key]) => familyFile(w, key));
    },
    close() { view.close(); eng.close(); },
  };
}
