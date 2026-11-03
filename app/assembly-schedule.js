/* SPDX-License-Identifier: Apache-2.0 */
// Read-only project documentation. No meshes, rounded labels, or material defaults enter totals.
import { ids, val } from './ifc-util.js';
import { readAssemblyRecords } from './wall-assemblies.js';
import { readMaterials } from './project-materials.js';
import { wallType, typeName } from './model-walls.js';
import { fmtLen } from './model-units.js';
import { t as tr } from './i18n.js';
const order=(a,b)=>String(a).localeCompare(String(b),'en');
const text=v=>typeof v==='string'?v:JSON.stringify(v)??'';
const display=n=>fmtLen(n,'mm');
export const ASSEMBLY_NOTE = () => tr('asched.note.assembly');
export const MATERIAL_NOTE = () => tr('asched.note.materials');
export function assemblySchedules(w) {
 const records=readAssemblyRecords(w), types=[...records], used=new Set();
 // The existing IFC type key identifies authored starters. Tool presets alone are not authored records.
 for(const id of ids(w.api,w.mid,'IFCWALL')) {const key=w.readPset(id,'CadCraft_Wall')?.TypeKey;if(key)used.add(key);}
 for(const id of ids(w.api,w.mid,'IFCWALLTYPE')) {
  if(records.some(r=>r.id===id))continue;
  const line=w.api.GetLine(w.mid,id,false),sets=(line.HasPropertySets||[]).map(h=>w.api.GetLine(w.mid,h.value,false)).filter(p=>val(p?.Name)==='CadCraft_WallType');
  if(!sets.length)continue;
  const key=sets[0].HasProperties.map(h=>w.api.GetLine(w.mid,h.value,false)).find(p=>val(p.Name)==='Key')?.NominalValue?.value;
  const t=wallType(key);
  types.push(t?{...t,id,guid:val(line.GlobalId),name:val(line.Name)||typeName(t)}:{id,guid:val(line.GlobalId),key,issue:'unavailable',message:tr('asched.err.nodef')});
 }
 for(const key of used)if(!types.some(r=>r.key===key))types.push({key,issue:'missing-type',message:tr('asched.err.missingtype')});
 for(const r of types)if(!r.issue&&types.some(x=>x!==r&&(x.key===r.key||(r.guid&&x.guid===r.guid))))Object.assign(r,{issue:'ambiguous-type',message:tr('asched.err.duplicate')});
 types.sort((a,b)=>order(a.key,b.key)||order(a.guid,b.guid)||a.id-b.id);
 let materials=[],libraryIssue='';try{materials=readMaterials(w);}catch(e){libraryIssue=e.message;}
 const byId=new Map(materials.map(m=>[m.id,m])), refs=new Map(), cavities=new Set();
 const assembly={title:tr('asched.title.assembly'),head:['#',tr('asched.h.material'),tr('asched.h.materialid'),tr('asched.h.function'),tr('asched.h.core'),tr('asched.h.nominal'),tr('asched.h.designation')],rows:[],rowInfo:[],note:ASSEMBLY_NOTE(),total:null,
  csvHead:['record_kind','type_key','type_guid','assembly_name','usage','layer_exterior_to_interior','material_id','material_name','function','core','nominal_thickness_mm','cavity_ventilation','membrane','total_thickness_mm','core_thickness_mm','status','raw_record'],csvRows:[]};
 const add=(cells,info={})=>{assembly.rows.push(cells);assembly.rowInfo.push(info);};
 for(const r of types) {
  const usage=used.has(r.key)?tr('asched.used'):tr('asched.unused'), identity=[r.key,r.guid].filter(Boolean).join(' / ');
  if(r.issue){
   add([`${r.key || tr('asched.missing.key')} / ${r.guid || tr('asched.missing.guid')}: ${r.issue}. ${r.message}`],{group:true,issue:r.issue});
   let raw;try{raw=JSON.parse(r.raw);}catch{/* Unparseable record is still represented in full in CSV. */}
   const rawLayers=Array.isArray(raw?.layers)?raw.layers:[];
   for(const [i,l]of rawLayers.entries()){
    add([String(i+1),text(l?.mat),text(l?.materialId),text(l?.function),tr('asched.unverified'),tr('asched.unavailable'),tr('asched.unverified.record')],{issue:r.issue});
    assembly.csvRows.push(['diagnostic-layer',r.key,r.guid,raw?.name,usage,i+1,text(l?.materialId),text(l?.mat),text(l?.function),'','','','','','',r.issue,JSON.stringify(l)]);
   }
   assembly.csvRows.push(['diagnostic',r.key,r.guid,raw?.name,usage,'','','','','','','','','','',r.issue,r.raw||'']);continue;
  }
  const total=r.layers.reduce((s,l)=>s+l.t,0),core=r.layers.filter(l=>l.core).reduce((s,l)=>s+l.t,0);
  add([tr('asched.group',{name:r.name,id:identity,usage,total:display(total),core:display(core)})],{group:true});
  for(const [i,l]of r.layers.entries()) {
   const cavity=l.kind==='cavity',m=cavity?null:byId.get(l.materialId),membrane=l.function==='membrane',status=cavity?'ok':m?'ok':libraryIssue?'unavailable-library':'missing-material';
   const name=cavity?tr('asched.cavity'):m?.name||tr('asched.missing.material',{id:l.materialId});
   const designation=cavity?tr('asched.cavity.vent',{vent:l.ventilation}):membrane?(l.t===0?tr('asched.membrane.zero'):tr('asched.membrane.nominal')):tr('asched.material');
   const swatch=cavity?{kind:'cavity'}:m?{kind:membrane?'membrane':'material',...m}:{kind:'missing'};
   add([String(i+1),name,cavity?tr('asched.nosolid'):l.materialId,l.function,l.core?tr('asched.h.core'):tr('asched.noncore'),display(l.t),designation+(status==='ok'?'':'; '+status)],{swatch,status});
   assembly.csvRows.push(['layer',r.key,r.guid,r.name,usage,i+1,cavity?'':l.materialId,name,l.function,l.core,l.t,cavity?l.ventilation:'',membrane,'','',status,'']);
   if(cavity)cavities.add(l.ventilation);else {if(!refs.has(l.materialId))refs.set(l.materialId,new Set());refs.get(l.materialId).add(membrane?'membrane':'material');}
  }
  assembly.csvRows.push(['assembly-summary',r.key,r.guid,r.name,usage,'','','','','','','','',total,core,'ok','']);
 }
 if(!types.length)add([tr('asched.none')],{group:true});
 const legend={title:tr('asched.title.legend'),head:[tr('asched.h.symbol'),tr('asched.h.material'),tr('asched.h.stableid'),tr('asched.h.use'),tr('asched.h.colour')],rows:[],rowInfo:[],note:MATERIAL_NOTE(),total:null,
  csvHead:['material_id','material_name','symbol_kind','usage','color','pattern','pattern_color','status'],csvRows:[]};
 const entry=(m,kind,usage,status='ok')=>{
  legend.rows.push(['',m.name,m.id,usage+(status==='ok'?'':'; '+status),kind==='material'?`${m.color} / ${m.fill} / ${m.fillColor}`:kind==='membrane'?tr('asched.membraneline',{color:m.color}):tr('asched.unavailable')]);
  legend.rowInfo.push({swatch:{...m,kind},status});legend.csvRows.push([m.id,m.name,kind,usage,m.color||'',m.fill||'',m.fillColor||'',status]);
 };
 for(const m of materials.sort((a,b)=>order(a.id,b.id)))for(const kind of refs.get(m.id)||['material'])entry(m,kind,refs.has(m.id)?tr('asched.referenced'):tr('asched.unused'));
 for(const [id,kinds]of [...refs].sort((a,b)=>order(a[0],b[0])))if(!byId.has(id))for(const kind of kinds)entry({id,name:tr('asched.missing.material',{id})},'missing',tr('asched.referenced.as',{kind}),'missing-material');
 for(const ventilation of [...cavities].sort(order)){legend.rows.push(['',tr('asched.cavity'),tr('asched.nosolid'),ventilation,tr('asched.cavity.symbol')]);legend.rowInfo.push({swatch:{kind:'cavity'}});legend.csvRows.push(['',tr('asched.cavity'),'cavity',ventilation,'','none','','ok']);}
 if(libraryIssue){legend.rows.push(['',tr('asched.library.unavailable'),'','',libraryIssue]);legend.rowInfo.push({issue:'unavailable-library'});legend.csvRows.push(['','','diagnostic','','','','',libraryIssue]);}
 return {assemblies:assembly,materialLegend:legend};
}
