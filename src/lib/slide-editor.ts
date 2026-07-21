import type { AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";
import { extractFontFamilies } from "./slide-html";

/**
 * Runtime de edición inyectado en el iframe. Convierte la lámina en una superficie
 * tipo Canva:
 *  - click → seleccionar; Shift+click → multi-selección
 *  - agrupar/desagrupar (por atributo data-oc-g, SIN reestructurar el DOM)
 *  - arrastrar con transform:translate (no rompe el layout) + guías con snap
 *  - handles en las esquinas para redimensionar (font-size en textos, width en cajas)
 *  - doble click → editar texto inline
 *  - panel aplica estilos; serializa el body y lo devuelve al padre para guardar
 * La UI del editor (outlines/handles/guías) vive en un overlay [data-oc-ui] que
 * NUNCA se serializa.
 */
export const EDITOR_RUNTIME = String.raw`
(function(){
  var sels=[], drag=null, rz=null;
  var W=document.body.clientWidth||1080, H=document.body.clientHeight||1350;
  var baseTf=new WeakMap(), delta=new WeakMap();

  var st=document.createElement('style'); st.setAttribute('data-oc-ui','1');
  st.textContent='*{cursor:default}'
    +'svg{pointer-events:none !important}'
    +'[class*="glow"],[class*="wash"],[class*="paper"]{pointer-events:none !important}'
    +'[data-oc-ui]{pointer-events:none}'
    +'.oc-h{position:absolute;width:14px;height:14px;background:#fff;border:2px solid #4f7cff;border-radius:50%;pointer-events:auto;cursor:nwse-resize;z-index:3}'
    +'.oc-box{position:absolute;outline:2px solid #4f7cff;outline-offset:1px}'
    +'.oc-g{position:absolute;background:#ff3b7f}';
  document.head.appendChild(st);

  var ui=document.createElement('div');
  ui.setAttribute('data-oc-ui','1');
  ui.style.cssText='position:absolute;left:0;top:0;width:'+W+'px;height:'+H+'px;pointer-events:none;z-index:2147483000';
  document.body.appendChild(ui);

  function post(m){ parent.postMessage(m,'*'); }
  function toHex(c){
    if(!c) return '#000000';
    if(c[0]==='#') return c;
    var m=c.match(/\d+/g); if(!m) return '#000000';
    return '#'+m.slice(0,3).map(function(n){return ('0'+parseInt(n).toString(16)).slice(-2);}).join('');
  }
  function rootEl(){ return document.body.firstElementChild; }
  function tooBig(el){
    var r=el.getBoundingClientRect();
    return (r.width*r.height) > (W*H*0.80);   // contenedores que cubren casi toda la lámina
  }
  function members(el){
    var g=el.getAttribute && el.getAttribute('data-oc-g');
    if(!g) return [el];
    return [].slice.call(document.querySelectorAll('[data-oc-g="'+g+'"]'));
  }

  // ── pintar overlay (outlines + handles) ──────────────────────────────────────
  function paint(){
    ui.innerHTML='';
    sels.forEach(function(el){
      var r=el.getBoundingClientRect();
      var b=document.createElement('div'); b.className='oc-box';
      b.style.left=r.left+'px'; b.style.top=r.top+'px';
      b.style.width=r.width+'px'; b.style.height=r.height+'px';
      ui.appendChild(b);
    });
    if(sels.length===1){
      var r=sels[0].getBoundingClientRect();
      [['nw',r.left,r.top],['ne',r.right,r.top],['sw',r.left,r.bottom],['se',r.right,r.bottom]]
      .forEach(function(c){
        var h=document.createElement('div'); h.className='oc-h';
        h.style.left=(c[1]-7)+'px'; h.style.top=(c[2]-7)+'px';
        h.addEventListener('mousedown', function(ev){ startResize(ev, c[0]); });
        ui.appendChild(h);
      });
    }
  }
  function guides(gx,gy){
    [].slice.call(ui.querySelectorAll('.oc-g')).forEach(function(n){n.remove();});
    if(gx!==null&&gx!==undefined){ var v=document.createElement('div'); v.className='oc-g';
      v.style.cssText+=';left:'+gx+'px;top:0;width:1px;height:'+H+'px'; ui.appendChild(v); }
    if(gy!==null&&gy!==undefined){ var h2=document.createElement('div'); h2.className='oc-g';
      h2.style.cssText+=';top:'+gy+'px;left:0;height:1px;width:'+W+'px'; ui.appendChild(h2); }
  }

  function report(){
    if(!sels.length){ post({oc:'sel',none:true}); return; }
    var el=sels[0], cs=getComputedStyle(el);
    var isText = el.children.length===0 && (el.textContent||'').trim().length>0;
    post({oc:'sel', count:sels.length,
      grouped: !!(el.getAttribute && el.getAttribute('data-oc-g')),
      tag:el.tagName.toLowerCase(), isText:isText,
      text: isText ? el.textContent : '',
      fontFamily:(cs.fontFamily||'').split(',')[0].replace(/['"]/g,'').trim(),
      fontSize:Math.round(parseFloat(cs.fontSize)||0),
      color:toHex(cs.color), fontWeight:cs.fontWeight,
      italic:cs.fontStyle==='italic', align:cs.textAlign});
  }
  function clearSel(){ sels=[]; paint(); guides(); report(); }
  function pick(el, additive){
    if(!el||el===document.body||el===document.documentElement||el===rootEl()||tooBig(el)){
      if(!additive) clearSel();
      return;
    }
    var ms=members(el);
    if(additive){ ms.forEach(function(m){ if(sels.indexOf(m)<0) sels.push(m); }); }
    else sels=ms.slice();
    paint(); report();
  }

  document.addEventListener('click', function(e){
    e.preventDefault(); e.stopPropagation();
    pick(e.target, e.shiftKey);
  }, true);

  // ── arrastrar (transform) con snap a centros/bordes ──────────────────────────
  document.addEventListener('mousedown', function(e){
    if(rz) return;
    if(!sels.length) return;
    var hit=sels.some(function(el){ return el===e.target||el.contains(e.target); });
    if(!hit) return;
    if(sels[0].getAttribute('contenteditable')==='true') return;
    sels.forEach(function(el){
      if(!baseTf.has(el)) baseTf.set(el, el.style.transform||'');
    });
    drag={sx:e.clientX, sy:e.clientY,
      start:sels.map(function(el){ return (delta.get(el)||[0,0]).slice(); })};
    e.preventDefault();
  }, true);

  function applyT(el,i,nx,ny){
    delta.set(el,[nx,ny]);
    var b=baseTf.get(el)||'';
    el.style.transform=(b?b+' ':'')+'translate('+nx+'px,'+ny+'px)';
  }
  window.addEventListener('mousemove', function(e){
    if(rz){ doResize(e); return; }
    if(!drag||!sels.length) return;
    var dx=e.clientX-drag.sx, dy=e.clientY-drag.sy;
    sels.forEach(function(el,i){ applyT(el,i,drag.start[i][0]+dx, drag.start[i][1]+dy); });
    // snap del primer elemento a centro/bordes de la lámina
    var el=sels[0], r=el.getBoundingClientRect();
    var cx=r.left+r.width/2, cy=r.top+r.height/2, gx=null, gy=null, ax=0, ay=0;
    if(Math.abs(cx-W/2)<9){ ax=W/2-cx; gx=W/2; }
    else if(Math.abs(r.left-60)<9){ ax=60-r.left; gx=60; }
    else if(Math.abs(r.right-(W-60))<9){ ax=(W-60)-r.right; gx=W-60; }
    if(Math.abs(cy-H/2)<9){ ay=H/2-cy; gy=H/2; }
    if(ax||ay){ sels.forEach(function(el2,i){ var d=delta.get(el2)||[0,0]; applyT(el2,i,d[0]+ax,d[1]+ay); }); }
    guides(gx,gy);
    paint();
  });
  window.addEventListener('mouseup', function(){
    if(rz){ rz=null; paint(); report(); serialize(); return; }
    if(drag){ drag=null; guides(); paint(); report(); serialize(); }
  });

  // ── resize por handles ───────────────────────────────────────────────────────
  function startResize(e, corner){
    if(sels.length!==1) return;
    var el=sels[0], r=el.getBoundingClientRect(), cs=getComputedStyle(el);
    rz={el:el, sx:e.clientX, w:r.width, corner:corner,
        fs:parseFloat(cs.fontSize)||0,
        isText: el.children.length===0 && (el.textContent||'').trim().length>0};
    e.preventDefault(); e.stopPropagation();
  }
  function doResize(e){
    var dx=e.clientX-rz.sx;
    if(rz.corner==='nw'||rz.corner==='sw') dx=-dx;
    var ratio=Math.max(0.15,(rz.w+dx)/Math.max(1,rz.w));
    if(rz.isText) rz.el.style.fontSize=Math.max(8,Math.round(rz.fs*ratio))+'px';
    else { rz.el.style.width=Math.max(20,Math.round(rz.w*ratio))+'px';
           if(rz.el.tagName==='IMG') rz.el.style.height='auto'; }
    paint();
  }

  // ── texto inline ─────────────────────────────────────────────────────────────
  document.addEventListener('dblclick', function(e){
    var t=e.target;
    if(t.children.length===0){
      t.setAttribute('contenteditable','true'); t.focus();
      var end=function(){ t.setAttribute('contenteditable','false'); t.removeEventListener('blur',end); paint(); report(); serialize(); };
      t.addEventListener('blur', end);
    }
  }, true);

  function ensureFont(fam){
    if(!fam) return;
    var id='ocf-'+fam.replace(/[^a-z0-9]/gi,'');
    if(document.getElementById(id)) return;
    var l=document.createElement('link'); l.id=id; l.rel='stylesheet'; l.setAttribute('data-oc-ui','1');
    l.href='https://fonts.googleapis.com/css2?family='+fam.replace(/ /g,'+')+':ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400&display=swap';
    document.head.appendChild(l);
  }
  function apply(m){
    if(!sels.length) return;
    var p=m.prop, v=m.value;
    sels.forEach(function(el){
      if(p==='text'){ el.textContent=v; }
      else if(p==='fontFamily'){ el.style.fontFamily="'"+v+"'"; ensureFont(v); }
      else if(p==='fontSize'){ el.style.fontSize=v+'px'; }
      else if(p==='color'){ el.style.color=v; }
      else if(p==='bold'){ el.style.fontWeight=v?'800':'400'; }
      else if(p==='italic'){ el.style.fontStyle=v?'italic':'normal'; }
      else if(p==='align'){ el.style.textAlign=v; }
      else if(p==='remove'){ el.remove(); }
    });
    if(p==='remove'){ sels=[]; }
    paint(); report(); serialize();
  }
  // Subir al contenedor: clave cuando un texto va junto a un decorativo (p.ej. la
  // palabra sobre su pincelada). El wrapper ya los agrupa visualmente.
  function parentSel(){
    if(sels.length!==1) return;
    var p=sels[0].parentElement;
    if(!p||p===document.body||p===document.documentElement||p===rootEl()||tooBig(p)) return;
    sels=[p]; paint(); report();
  }
  function group(){
    if(sels.length<2) return;
    var id='g'+Date.now().toString(36);
    sels.forEach(function(el){ el.setAttribute('data-oc-g', id); });
    report(); serialize();
  }
  function ungroup(){
    sels.forEach(function(el){ el.removeAttribute('data-oc-g'); });
    sels=sels.slice(0,1); paint(); report(); serialize();
  }
  function addText(){
    var d=document.createElement('div');
    d.textContent='Texto nuevo';
    d.style.cssText='position:absolute;left:120px;top:120px;font-size:60px;font-family:Inter,sans-serif;color:#111;font-weight:700';
    rootEl().appendChild(d); sels=[d]; paint(); report(); serialize();
  }
  function addImage(url){
    var img=document.createElement('img'); img.src=url;
    img.style.cssText='position:absolute;left:120px;top:120px;width:360px;height:auto';
    rootEl().appendChild(img); sels=[img]; paint(); report(); serialize();
  }
  function setBg(val){ (rootEl()||document.body).style.background=val; serialize(); }

  function serialize(){
    // sacar TODA la UI del editor y cualquier script antes de capturar
    ui.remove(); st.remove();
    document.querySelectorAll('[contenteditable]').forEach(function(n){ n.removeAttribute('contenteditable'); });
    var html=document.body.innerHTML
      .replace(/<script[\s\S]*?<\/script>/gi,'')
      .replace(/<[^>]*data-oc-ui="1"[^>]*>[\s\S]*?<\/[a-z]+>/gi,'');
    post({oc:'html', html:html});
    document.head.appendChild(st); document.body.appendChild(ui);
    paint();
  }

  window.addEventListener('message', function(e){
    var m=e.data; if(!m||!m.oc) return;
    if(m.oc==='apply') apply(m);
    else if(m.oc==='parent') parentSel();
    else if(m.oc==='group') group();
    else if(m.oc==='ungroup') ungroup();
    else if(m.oc==='addText') addText();
    else if(m.oc==='addImage') addImage(m.url);
    else if(m.oc==='setBg') setBg(m.value);
    else if(m.oc==='deselect') clearSel();
    else if(m.oc==='serialize') serialize();
  });
  post({oc:'ready'});
})();
`;

/** Envuelve la lámina para edición: doc completo + fuentes CDN + runtime del editor. */
export function wrapEditableSlide(slideHtml: string, aspectRatio: AspectRatio): string {
  const { width, height } = DIMENSIONS[aspectRatio];
  // Defensivo: si una lámina quedó con un runtime/overlay previo, lo quitamos.
  slideHtml = slideHtml.replace(/<script[\s\S]*?<\/script>/gi, "");
  const fams = extractFontFamilies(slideHtml);
  const fontLink = fams.length
    ? `<link href="https://fonts.googleapis.com/css2?${fams
        .map((f) => `family=${encodeURIComponent(f)}:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,400`)
        .join("&")}&display=swap" rel="stylesheet">`
    : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${fontLink}
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${width}px;height:${height}px;overflow:hidden;position:relative}</style>
</head><body>${slideHtml}<script>${EDITOR_RUNTIME}</script></body></html>`;
}
