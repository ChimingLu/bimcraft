/* SPDX-License-Identifier: Apache-2.0 */
import { t } from './i18n.js';
import { val } from './ifc-util.js';
// Only absence means legacy. Explicit null/string/unknown versions are never coerced.
export function recordError(kind, reason) {
  return Object.assign(new Error(t('contract.' + kind) + ': ' + t('contract.' + reason) + ' ' + t('contract.recovery')), { recordIssue: reason });
}
export function checkRecordVersion(value, kind, legacy = true) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw recordError(kind, 'corrupt');
  if (value.version === 1 || (legacy && !Object.hasOwn(value, 'version'))) return;
  throw recordError(kind, 'unsupported');
}
export function parseRecord(raw, kind, legacy = true) {
  let value;
  try { value = JSON.parse(raw); } catch { throw recordError(kind, 'corrupt'); }
  checkRecordVersion(value, kind, legacy);
  return value;
}
// Scoped records must not use the generic first-set/last-property wins lookup:
// a duplicate can hide an unsupported payload behind an apparently valid one.
export function recordProperties(w, pset, kind) {
  const props=Object.create(null);
  for(const h of pset.HasProperties || []) {
    const p=w.api.GetLine(w.mid,h.value,false), name=val(p?.Name);
    if(typeof name!=='string' || Object.hasOwn(props,name)) throw recordError(kind,'corrupt');
    props[name]=val(p.NominalValue);
  }
  return props;
}
export function readRecordPset(w, id, name, kind) {
  const sets=w.defs(id).map(d=>w.api.GetLine(w.mid,d.def,false)).filter(p=>val(p?.Name)===name);
  if(sets.length>1) throw recordError(kind,'corrupt');
  return sets.length?recordProperties(w,sets[0],kind):null;
}
