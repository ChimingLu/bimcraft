/* SPDX-License-Identifier: Apache-2.0 */
import { t as tr } from './i18n.js';
// Fixed paper-mm continuation pages, shared by screen SVG, placed sheets and vector PDF.
export const DOCUMENT_WIDTH=240, DOCUMENT_HEIGHT=138, DOCUMENT_FONT=8;
const PT=72/25.4, lineH=3.8;
const columns=s=>s.head.length===7?[9,57,57,24,19,25,49]:[16,66,65,48,45];
// Conservative Helvetica advance; hard-wrap even a single long stable ID. Preserve all characters.
const advance=c=>(/[MW@%]/.test(c)?.95:/[ilI.,' :;!|]/.test(c)?.28:.62)*DOCUMENT_FONT/PT;
export function wrapDocument(value,width) {
 const out=[];
 for(const part of String(value??'').replace(/\r\n?/g,'\n').split('\n')){
  let line='',w=0;
  for(const token of part.match(/\S+\s*|\s+/g)||['']){
   const size=[...token].reduce((s,c)=>s+advance(c),0);
   if(line && w+size>width && size<=width){out.push(line);line='';w=0;}
   for(const ch of token){const n=advance(ch);if(line && w+n>width){out.push(line);line='';w=0;}line+=ch;w+=n;}
  }out.push(line);
 }return out;
}
export function documentPages(sc,key) {
 const widths=columns(sc), header=sc.head.map((c,i)=>wrapDocument(c,widths[i]-3));
 const headerH=Math.max(...header.map(c=>c.length))*lineH+3, pages=[];
 let page;
 const next=()=>{page={...sc,ref:`f06-${key}:${pages.length+1}`,title:tr('asched.page.n',{title:sc.title,n:pages.length+1}),rows:[],rowInfo:[],document:{width:DOCUMENT_WIDTH,height:headerH+13,widths,header,headerH,rows:[]}};pages.push(page);};next();
 let group=null;
 const append=(lines,info)=>{const h=Math.max(...lines.map(l=>l.length))*lineH+3;page.rows.push(lines.map(l=>l.join('\n')));page.rowInfo.push(info);page.document.rows.push({lines,info,h});page.document.height+=h;};
 for(let i=0;i<sc.rows.length;i++){
  const info=sc.rowInfo[i]||{},lines=info.group?[wrapDocument(sc.rows[i][0],DOCUMENT_WIDTH-3)]:sc.rows[i].map((c,j)=>wrapDocument(c,widths[j]-3));
  if(info.group)group=lines;
  const limit=Math.max(1,Math.floor((DOCUMENT_HEIGHT-headerH-26)/lineH));
  const length=Math.max(...lines.map(l=>l.length));
  for(let off=0;off<length;off+=limit){
   const part=lines.map(l=>l.slice(off,off+limit)),h=Math.max(...part.map(l=>l.length))*lineH+3;
   if(page.document.rows.length && page.document.height+h>DOCUMENT_HEIGHT){next();if(group&&!info.group)append(group,{group:true,continued:true});}
   // Extremely long diagnostic/identity rows continue without truncation.
   if(page.document.height+h>DOCUMENT_HEIGHT && page.document.rows.length){next();}
   append(part,{...info,continued:off>0||info.continued});
  }
 }
 for(const [i,p]of pages.entries())p.title=tr('asched.page.nof',{title:sc.title,n:i+1,of:pages.length});
 return pages;
}
function symbol(s,x,y,w=10,h=4) {
 const p=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]],out=[];
 if(s.kind==='membrane')return[{t:'line',pts:[[x,y+h/2],[x+w,y+h/2]],w:.35,color:s.color,dash:[1,.8]}];
 if(s.kind==='material'&&s.fill!=='none')out.push({t:'fill',polys:[p],color:s.color});
 if(s.kind==='material'&&['diagonal','crosshatch'].includes(s.fill))for(let d=-h;d<w;d+=2){const a=[x+Math.max(0,d),y+Math.max(0,-d)],b=[x+Math.min(w,d+h),y+Math.min(h,w-d)];out.push({t:'line',pts:[a,b],w:.15,color:s.fillColor});if(s.fill==='crosshatch')out.push({t:'line',pts:[a,b].map(([xx,yy])=>[xx,2*y+h-yy]),w:.15,color:s.fillColor});}
 out.push({t:'line',pts:[...p,p[0]],w:.15,g:0,...(s.kind==='missing'?{dash:[.5,.5]}:{})});
 if(s.kind==='missing')out.push({t:'line',pts:[p[0],p[2]],w:.2,g:0});return out;
}
export function documentItems(sc,x,yTop) {
 const d=sc.document,out=[],text=(s,x,y,bold=false)=>out.push({t:'text',s,x,y,size:DOCUMENT_FONT,align:'left',bold});
 let y=yTop;
 // Fixed short notes repeat on each page, so standalone placed pages state scope and units.
 text(sc.head.length===7?tr('asched.page.assembly'):tr('asched.page.legend'),x,y-3);
 y-=7;
 const draw=(lines,h,group=false,swatch=null,bold=false)=>{
  if(group)out.push({t:'fill',polys:[[[x,y],[x+DOCUMENT_WIDTH,y],[x+DOCUMENT_WIDTH,y-h],[x,y-h]]],g:.94});
  let dx=0;for(const [j,cell]of lines.entries()){for(const [k,s]of cell.entries())text(s,x+dx+1.5,y-3.5-k*lineH,bold||group);dx+=d.widths[j]||0;}
  if(swatch)out.push(...symbol(swatch,x+1.5,y-h+1.5,Math.min(10,d.widths[0]-3),3));
  y-=h;out.push({t:'line',pts:[[x,y],[x+DOCUMENT_WIDTH,y]],w:.13,g:.5});
 };
 draw(d.header,d.headerH,false,null,true);
 for(const r of d.rows)draw(r.lines,r.h,r.info.group,sc.head.length===7?null:r.info.swatch);
 return out;
}
