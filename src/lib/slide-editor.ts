import type { AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";
import { extractFontFamilies } from "./slide-html";

/**
 * Runtime de edición que se inyecta en el iframe de la lámina. Convierte la lámina
 * (HTML estático) en una superficie editable tipo Canva:
 *  - click → seleccionar un elemento (outline)
 *  - arrastrar → mover (position:absolute + left/top)
 *  - doble click → editar texto inline (contentEditable)
 *  - recibe cambios de estilo del panel (fontFamily, fontSize, color, weight, …)
 *  - agrega texto/imagen, edita el fondo
 *  - serializa el body y lo devuelve al padre (postMessage) para guardar
 * Comunicación con el padre por window.postMessage. Todos los mensajes llevan {oc:...}.
 */
export const EDITOR_RUNTIME = String.raw`
(function(){
  var sel=null, drag=null;
  var st=document.createElement('style');
  st.setAttribute('data-oc-editor','1');
  st.textContent='.oc-sel{outline:2px solid #4f7cff !important;outline-offset:2px}[data-oc-editor]{}*{cursor:default}';
  document.head.appendChild(st);
  document.body.style.cursor='default';

  function post(m){ m.oc=m.oc; parent.postMessage(m,'*'); }
  function toHex(c){
    if(!c) return '#000000';
    if(c[0]==='#') return c;
    var m=c.match(/\d+/g); if(!m) return '#000000';
    return '#'+m.slice(0,3).map(function(n){return ('0'+parseInt(n).toString(16)).slice(-2);}).join('');
  }
  function clearSel(){ if(sel){ sel.classList.remove('oc-sel'); sel=null; } }
  function report(){
    if(!sel){ post({oc:'sel',none:true}); return; }
    var cs=getComputedStyle(sel);
    var isText = sel.children.length===0 && (sel.textContent||'').trim().length>0;
    post({oc:'sel', tag:sel.tagName.toLowerCase(), isText:isText,
      text: isText ? sel.textContent : '',
      fontFamily: (cs.fontFamily||'').split(',')[0].replace(/['"]/g,'').trim(),
      fontSize: Math.round(parseFloat(cs.fontSize)||0),
      lineHeight: cs.lineHeight,
      color: toHex(cs.color),
      fontWeight: cs.fontWeight,
      italic: cs.fontStyle==='italic',
      align: cs.textAlign,
      letterSpacing: cs.letterSpacing
    });
  }
  function pick(el){ clearSel(); sel=el; el.classList.add('oc-sel'); report(); }

  document.addEventListener('click', function(e){
    e.preventDefault(); e.stopPropagation();
    var t=e.target;
    if(t===document.body||t===document.documentElement){ clearSel(); report(); return; }
    pick(t);
  }, true);

  // arrastrar el seleccionado
  document.addEventListener('mousedown', function(e){
    if(!sel) return;
    if(e.target!==sel && !sel.contains(e.target)) return;
    if(sel.getAttribute('contenteditable')==='true') return;
    var r=sel.getBoundingClientRect();
    drag={sx:e.clientX, sy:e.clientY, ox:r.left+window.scrollX, oy:r.top+window.scrollY};
    e.preventDefault();
  }, true);
  window.addEventListener('mousemove', function(e){
    if(!drag||!sel) return;
    sel.style.position='absolute';
    sel.style.margin='0';
    sel.style.left=(drag.ox+(e.clientX-drag.sx))+'px';
    sel.style.top =(drag.oy+(e.clientY-drag.sy))+'px';
  });
  window.addEventListener('mouseup', function(){ if(drag){ drag=null; report(); serialize(); } });

  // editar texto
  document.addEventListener('dblclick', function(e){
    var t=e.target;
    if(t.children.length===0){
      t.setAttribute('contenteditable','true'); t.focus();
      var end=function(){ t.setAttribute('contenteditable','false'); t.removeEventListener('blur',end); report(); serialize(); };
      t.addEventListener('blur', end);
    }
  }, true);

  function ensureFont(fam){
    if(!fam) return;
    var id='ocf-'+fam.replace(/[^a-z0-9]/gi,'');
    if(document.getElementById(id)) return;
    var l=document.createElement('link'); l.id=id; l.rel='stylesheet';
    l.href='https://fonts.googleapis.com/css2?family='+fam.replace(/ /g,'+')+':ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400&display=swap';
    document.head.appendChild(l);
  }
  function apply(m){
    if(!sel) return;
    var p=m.prop, v=m.value;
    if(p==='text'){ sel.textContent=v; }
    else if(p==='fontFamily'){ sel.style.fontFamily="'"+v+"'"; ensureFont(v); }
    else if(p==='fontSize'){ sel.style.fontSize=v+'px'; }
    else if(p==='color'){ sel.style.color=v; }
    else if(p==='bold'){ sel.style.fontWeight=v?'800':'400'; }
    else if(p==='italic'){ sel.style.fontStyle=v?'italic':'normal'; }
    else if(p==='align'){ sel.style.textAlign=v; }
    else if(p==='letterSpacing'){ sel.style.letterSpacing=v+'px'; }
    else if(p==='lineHeight'){ sel.style.lineHeight=v; }
    else if(p==='left'){ sel.style.position='absolute'; sel.style.left=v+'px'; }
    else if(p==='top'){ sel.style.position='absolute'; sel.style.top=v+'px'; }
    else if(p==='remove'){ sel.remove(); clearSel(); report(); serialize(); return; }
    report(); serialize();
  }
  function addText(){
    var d=document.createElement('div');
    d.textContent='Texto nuevo';
    d.style.cssText='position:absolute;left:120px;top:120px;font-size:60px;font-family:Inter,sans-serif;color:#111;font-weight:700';
    document.body.appendChild(d); pick(d); serialize();
  }
  function addImage(url){
    var img=document.createElement('img');
    img.src=url;
    img.style.cssText='position:absolute;left:120px;top:120px;width:360px;height:auto';
    document.body.appendChild(img); pick(img); serialize();
  }
  function setBg(val){
    // fondo del contenedor raíz (primer hijo grande) o del body
    var root=document.body.querySelector('div')||document.body;
    root.style.background=val;
    serialize();
  }

  function serialize(){
    var s=sel; if(s) s.classList.remove('oc-sel');
    st.remove();
    document.querySelectorAll('[contenteditable]').forEach(function(n){ n.removeAttribute('contenteditable'); });
    post({oc:'html', html: document.body.innerHTML});
    document.head.appendChild(st);
    if(s) s.classList.add('oc-sel');
  }

  window.addEventListener('message', function(e){
    var m=e.data; if(!m||!m.oc) return;
    if(m.oc==='apply') apply(m);
    else if(m.oc==='addText') addText();
    else if(m.oc==='addImage') addImage(m.url);
    else if(m.oc==='setBg') setBg(m.value);
    else if(m.oc==='deselect'){ clearSel(); report(); }
    else if(m.oc==='serialize') serialize();
  });
  post({oc:'ready'});
})();
`;

/** Envuelve la lámina para edición: doc completo + fuentes CDN + runtime del editor. */
export function wrapEditableSlide(slideHtml: string, aspectRatio: AspectRatio): string {
  const { width, height } = DIMENSIONS[aspectRatio];
  const fams = extractFontFamilies(slideHtml);
  const fontLink = fams.length
    ? `<link href="https://fonts.googleapis.com/css2?${fams
        .map((f) => `family=${encodeURIComponent(f)}:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,400`)
        .join("&")}&display=swap" rel="stylesheet">`
    : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${fontLink}
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${width}px;height:${height}px;overflow:hidden}</style>
</head><body>${slideHtml}<script>${EDITOR_RUNTIME}</script></body></html>`;
}
