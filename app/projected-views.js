/* SPDX-License-Identifier: Apache-2.0 */
import { ids } from './ifc-util.js';
import { readRecordPset, parseRecord, recordError } from './record-contract.js';
import { PLAN_DETAILS } from './wall-plan-graphics.js';
import { op } from './model-ops.js';
import { readSectionLines } from './res-sheets.js';

export const PROJECTED_PSET='CadCraft_ProjectedViews';
export const PROJECTED_DEFAULTS=Object.freeze({version:1,detail:'coarse',scale:0,crop:null});
const validKey=k=>/^section:[0-3][0-9A-Za-z_$]{21}$|^elevation:(north|east|south|west)$/.test(k);
function validate(v) {
  if(!PLAN_DETAILS.includes(v.detail)||typeof v.scale!=='number'||!Number.isFinite(v.scale)||v.scale<0||v.scale>10000||!(v.crop===null||(Array.isArray(v.crop)&&v.crop.length===4&&v.crop.every(Number.isFinite)&&v.crop[2]>v.crop[0]&&v.crop[3]>v.crop[1])))throw recordError('projected','corrupt');
  return v;
}
function records(w) {return readRecordPset(w,ids(w.api,w.mid,'IFCPROJECT')[0],PROJECTED_PSET,'projected');}
export function readProjectedView(w,key) {
  try {
    if(!validKey(key))throw recordError('projected','corrupt');
    const ps=records(w);
    return ps&&Object.hasOwn(ps,key)?validate(parseRecord(ps[key],'projected',false)):{...PROJECTED_DEFAULTS};
  }catch(e){return {...PROJECTED_DEFAULTS,issue:e.message};}
}
export function setProjectedView(key,changes) {
  return op(w=>{
    if(!validKey(key))throw recordError('projected','corrupt');
    const ps=records(w);
    // Refuse to rewrite any unknown/corrupt record in this scoped container.
    for(const [k,raw]of Object.entries(ps||{})){if(!validKey(k))throw recordError('projected','corrupt');validate(parseRecord(raw,'projected',false));}
    if(key.startsWith('section:')&&!readSectionLines(w).some(s=>s.guid===key.slice(8)))throw recordError('projected','missing');
    const next=validate({...readProjectedView(w,key),...changes,version:1});
    if(Object.hasOwn(changes,'version')&&changes.version!==1)throw recordError('projected','unsupported');
    const id=ids(w.api,w.mid,'IFCPROJECT')[0];
    w.upsertPset(id,PROJECTED_PSET,[[key,'IFCTEXT',JSON.stringify({version:1,detail:next.detail,scale:next.scale,crop:next.crop})]]);
    return {id,ids:[]};
  });
}
export const projectedBox=v=>v.crop?{x0:v.crop[0],y0:v.crop[1],x1:v.crop[2],y1:v.crop[3]}:null;
