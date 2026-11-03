/* SPDX-License-Identifier: Apache-2.0 */
// Shared numeric layout for a proportionate slice and architectural dimension ticks.
// Zero-width layers retain their exact boundary; labels occupy separate lanes when crowded.
export function assemblyDimensionLayout(layers,format) {
  const total=layers.reduce((s,l)=>s+(Number.isFinite(l.t)&&l.t>=0?l.t:0),0);
  if(!total || layers.some(l=>!Number.isFinite(l.t)||l.t<0)) return null;
  let offset=0;
  const lanes=[];
  const segments=layers.map((l,i)=>{
    const start=offset/total*1000;offset+=l.t;const end=offset/total*1000;
    const label=`${i+1}: ${format(l.t)}${l.t===0?' *':''}`,half=Math.min(450,label.length*4+8);
    const center=(start+end)/2,labelX=Math.max(half,Math.min(1000-half,center));
    const interval=[labelX-half,labelX+half];
    let lane=lanes.findIndex(boxes=>boxes.every(b=>interval[0]>b[1]+12 || interval[1]<b[0]-12));
    if(lane<0) {lane=lanes.length;lanes.push([]);}lanes[lane].push(interval);
    return {start,end,center,label,labelX,lane,thickness:l.t};
  });
  const core=layers.reduce((s,l)=>s+(l.core?l.t:0),0),indices=layers.flatMap((l,i)=>l.core?[i]:[]);
  return {total,core,segments,lanes:lanes.length,coreStart:indices.length?segments[indices[0]].start:0,coreEnd:indices.length?segments[indices.at(-1)].end:0};
}
export function drawAssemblyDimensions(container,layout,format,labels) {
  container.replaceChildren();if(!layout) return;
  const svg=(tag,attrs={},text)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text!=null)n.textContent=text;return n;};
  const coreY=layout.lanes*34+24,totalY=coreY+36,height=totalY+15;
  const root=svg('svg',{viewBox:`0 0 1000 ${height}`,role:'img','aria-label':labels.dimensions,style:'display:block;width:100%;overflow:visible;font:14px sans-serif;color:inherit'});
  const line=(x1,y1,x2,y2,extra={})=>root.append(svg('line',{x1,y1,x2,y2,stroke:'currentColor','stroke-width':1,...extra}));
  function dimension(a,b,y,text,labelX=(a+b)/2) {
    line(a,0,a,y+7,{opacity:.35});if(a!==b)line(b,0,b,y+7,{opacity:.35});line(a,y,b,y);
    for(const x of a===b?[a]:[a,b])line(x-4,y+4,x+4,y-4,{'stroke-width':2});
    if(Math.abs(labelX-(a+b)/2)>1)line((a+b)/2,y,labelX,y-15,{opacity:.6});
    root.append(svg('text',{x:labelX,y:y-8,fill:'currentColor','text-anchor':'middle'},text));
  }
  for(const s of layout.segments) dimension(s.start,s.end,30+s.lane*34,s.label,s.labelX);
  if(layout.core>0)dimension(layout.coreStart,layout.coreEnd,coreY,labels.core+' '+format(layout.core));
  dimension(0,1000,totalY,labels.total+' '+format(layout.total));container.append(root);
}
