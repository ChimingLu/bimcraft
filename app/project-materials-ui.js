/* SPDX-License-Identifier: Apache-2.0 */
import { el } from './ui-util.js';
import { ModelWriter } from './model-write.js';
import { readMaterials, saveMaterial, FILLS, materialBackground } from './project-materials.js';
import { fmtLen, parseLen } from './model-units.js';
export function openMaterialLibrary(A,onClose=()=>{}, {createNew=false}={}) {
  const editor=A.ed(); if(!editor) return;
  const writer=()=>new ModelWriter(editor.W,editor.api,editor.mid);
  const t=k=>A.t('materials.'+k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()));   // field names are camelCase, language keys snake_case
  const button=(text,fn,props={})=>el('button',{type:'button',className:'btn-line btn-sm-cc',onClick:fn,...props},text);
  const error=el('p',{className:'bc-error',role:'alert'}), fields=el('div'), picker=el('select',{className:'bc-input','aria-label':t('select')});
  const dlg=el('dialog',{className:'bc-dialog bc-fam-dlg','aria-label':t('title'),'data-material-library':''});
  let selected, draft, controls, dirty=false, saved=null;
  function load(id) {
    const list=readMaterials(writer());selected=id || list[0]?.id;
    picker.replaceChildren(...list.map(m=>el('option',{value:m.id,selected:m.id===selected},m.name)));
    draft=structuredClone(list.find(m=>m.id===selected));dirty=false;draw();
  }
  function newMaterial() {
    if(dirty) {error.textContent=t('unsaved');return;}
    selected=null;picker.selectedIndex=-1;
    draft={id:'material-'+crypto.randomUUID(),name:t('newName'),category:'',defaultThickness:12.7,color:'#d8d3c4',fill:'solid',fillColor:'#555555',notes:''};
    draw();dirty=true;
  }
  function draw() {
    controls={};fields.replaceChildren();error.textContent='';
    for(const key of ['name','category','defaultThickness','color','fill','fillColor','notes']) {
      const value=key==='defaultThickness'?fmtLen(draft[key],A.units()):draft[key];
      const c=key==='fill'?el('select',{className:'bc-input'},...FILLS.map(f=>el('option',{value:f,selected:f===value},t('fill.'+f)))):el(key==='notes'?'textarea':'input',{className:'bc-input',type:key==='color'||key==='fillColor'?'color':'text',value,'aria-label':t(key),maxlength:key==='notes'?2000:100});
      c.value=value;
      c.setAttribute('aria-label',t(key));controls[key]=c;
      c.addEventListener('input',()=>{dirty=true;sample();});
      fields.append(el('label',{className:'bc-dlg-field'},t(key),c));
      if(key==='defaultThickness') fields.append(el('small',{className:'bc-muted'},t('zeroHint')));
    }
    fields.append(el('div',{'data-material-swatch':'',style:'height:50px;border:1px solid #888'}));sample();
  }
  function sample() { const swatch=fields.querySelector('[data-material-swatch]');if(swatch) swatch.style.background=materialBackground({color:controls.color.value,fill:controls.fill.value,fillColor:controls.fillColor.value}); }
  picker.addEventListener('change',()=>{
    if(dirty) {picker.value=selected || '';error.textContent=t('unsaved');return;}
    load(picker.value);
  });
  const save=button(t('save'),()=>{
    try {
      if(A.ed()!==editor) throw new Error(A.t('assembly.changed'));
      const input={...draft,...Object.fromEntries(Object.entries(controls).map(([k,c])=>[k,k==='defaultThickness'?(c.value===fmtLen(draft[k],A.units())?draft[k]:parseLen(c.value,A.units())):c.value]))};
      save.disabled=true;
      A.commit(ed=>{if(ed!==editor) throw new Error(A.t('assembly.changed'));const w=writer();let material;const result=w.run(w=>{material=saveMaterial(w,input);return [];});saved=material;dlg.close();return result;},{label:input.name,verb:A.t('model.verb.changed'),onError:e=>{save.disabled=false;error.textContent=e.message;}});
    }catch(e){save.disabled=false;error.textContent=e.message;}
  },{'data-material-save':''});
  dlg.append(el('h2',{className:'bc-h'},t('title')),el('p',{className:'bc-muted'},t('defaults')),picker,
    el('p',{},button(t('new'),newMaterial),button(t('duplicate'),()=>{if(dirty){error.textContent=t('unsaved');return;}draft={...draft,id:'material-'+crypto.randomUUID(),name:draft.name+' copy'};selected=null;picker.selectedIndex=-1;draw();dirty=true;})),fields,error,
    el('p',{className:'bc-lib-actions'},button(t('cancel'),()=>dlg.close()),save));
  dlg.addEventListener('keydown',e=>e.stopPropagation());dlg.addEventListener('close',()=>{dlg.remove();onClose(saved);});
  try {load();if(createNew) newMaterial();} catch(e) {error.textContent=e.message;save.disabled=true;picker.disabled=true;fields.replaceChildren();for(const b of dlg.querySelectorAll('button')) if(b.textContent!==t('cancel')) b.disabled=true;}
  A.root.append(dlg);dlg.showModal();
}
