/* SPDX-License-Identifier: Apache-2.0 */
/**
 * model-site-mass-ui.js — a building mass from CivilCraft in Properties (0.7 LC.1 B2, session `massing`), through model-ui.js
 * `extend()`: a picked mass proxy shows its study numbers (use, floors, floor height, footprint, gross floor area, how it sits on
 * the slope, parcel) and a "Develop this mass" button, which makes levels' walls and floors in one undo step (model-site-mass.js).
 * Mounted next to mountSite in bimcraft.js. Test hook: window.bimcraftMass = { state, api, read }.
 */
import { readMasses, developMass } from './model-site-mass.js';
import { ModelWriter } from './model-write.js';
import { fmtLen, fmtArea } from './model-units.js';
import { el } from './ui-util.js';

export function mountSiteMass(modelUi) {
  const R = { masses: [] };
  let A = null;
  const t = (...a) => A.t(...a);
  const W = () => new ModelWriter(A.ed().W, A.ed().api, A.ed().mid);
  function read() {
    try { R.masses = A.ed() ? readMasses(W()) : []; } catch (e) { R.masses = []; }
  }
  const sqm = (v) => fmtArea(v * 1e6, A.units());   // a pset area is in square metres; fmtArea takes square millimetres
  A = modelUi.extend({
    classes: /^IfcBuildingElementProxy$/,
    pick(key) {
      // the plan (Draw) is not always on: a pick the list does not know is looked up in the model itself
      const k = A.kb();
      let m = R.masses.find((x) => k + x.id === key);
      if (!m) { read(); m = R.masses.find((x) => k + x.id === key); }
      return m ? { kind: 'sitemass', guid: m.guid, label: t('mass.label', { name: m.name }) } : null;
    },
    props(items, kit) {
      const m = items.length === 1 ? R.masses.find((x) => x.guid === items[0].guid) : null;
      if (!m) return null;
      const row = (label, value, attr) => kit.rows.push(el('dt', {}, label), el('dd', attr ? { [attr]: '' } : {}, value));
      if (m.use) row(t('mass.use'), m.use);
      row(t('mass.floors'), t('mass.floors.v', { n: m.floors, h: fmtLen(m.floorHeight, A.units()) }), 'data-mass-floors');
      row(t('mass.footprint'), sqm(m.footprint));
      row(t('mass.gfa'), sqm(m.gfa), 'data-mass-gfa');
      if (m.base) row(t('mass.base'), t('mass.base.' + m.base));
      if (m.parcel) row(t('mass.parcel'), m.parcel);
      const go = kit.button(t('mass.develop'), 'data-mass-develop', () => A.commit(developMass({ guid: m.guid }), { label: t('mass.develop.label', { name: m.name }), verb: t('mass.verb') }));
      kit.rows.push(el('dt', { className: 'bc-mp-wide' }, ''), el('dd', { className: 'bc-mp-wide' }, go, ' ', el('span', { className: 'bc-sub' }, t('mass.develop.note'))));
      return { title: t('mass.title') };
    },
    refresh() { read(); },
  });
  if (typeof window !== 'undefined') window.bimcraftMass = { state: R, get api() { return A; }, read };   // for tests
  return { state: R };
}
