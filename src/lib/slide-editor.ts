import type { AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";
import { extractFontFamilies, googleFontAxes } from "./slide-html";

/**
 * Fragmento `ital,wght@…` con TODOS los grosores (romanas + itálicas) para el
 * editor. La lista explícita es tolerante: Google sirve solo lo que cada fuente
 * tiene, así que el selector de grosor manual (100–900) rinde sin importar la
 * familia. Compartido entre el runtime del iframe y `wrapEditableSlide`.
 *
 * Acá `italic` es SIEMPRE true, a diferencia del preview y del export, que lo deciden por
 * lámina: en el editor el usuario puede poner en itálica cualquier elemento en cualquier
 * momento, así que la cara tiene que estar cargada antes de que la pida. El costo de traer
 * de más no importa: es un `<link>` al CDN, no base64 dentro del HTML.
 *
 * Se construye con la misma `googleFontAxes` que usan preview y export para que exista UNA
 * sola definición de los ejes. Cuando estaban duplicadas, agregar `ital` acá y olvidarlo
 * allá fue justamente el bug: el editor mostraba la itálica real y el PNG la falseaba.
 */
export const GF_ITAL_WGHT = googleFontAxes(true);

/** Fuentes disponibles en el editor: las 8 de los avengers + extras usuales. */
export const EDITOR_FONTS = [
  // avengers 30x
  "Instrument Serif",
  "Open Sans",
  "Arimo",
  "Inter",
  "Bricolage Grotesque",
  "Poppins",
  "Playfair Display",
  "Nunito Sans",
  // extras
  "Montserrat",
  "Lora",
  "Oswald",
  "Bebas Neue",
  "Raleway",
  "Merriweather",
  "Archivo",
  "DM Sans",
  "Space Grotesk",
  "Libre Baskerville",
  "Anton",
  "Cormorant Garamond",
];

/**
 * Runtime de edición inyectado en el iframe: superficie tipo Canva.
 * Selección inteligente (prefiere texto/imagen/formas sobre decorativos), multi-
 * selección, grupos (agregar/sacar miembros), arrastre con transform + guías y snap,
 * resize por handles, edición de texto inline, copiar/pegar/duplicar, deshacer, orden
 * de capas, nudge con flechas, librería de formas (SHAPES) con borde/trazo, sombras
 * y degradados. La UI vive en un overlay [data-oc-ui] que nunca se serializa.
 */
export const EDITOR_RUNTIME = String.raw`
(function(){
  var sels=[], drag=null, rz=null, rot=null, grz=null, band=null, pan=null;
  var squelch=false, clip=[], hist=[], HMAX=60;
  var W=document.body.clientWidth||1080, H=document.body.clientHeight||1350;
  var baseTf=new WeakMap(), delta=new WeakMap();

  var st=document.createElement('style'); st.setAttribute('data-oc-ui','1');
  st.textContent='*{cursor:default}'
    +'[data-oc-ui]{pointer-events:none}'
    +'.oc-h{position:absolute;width:14px;height:14px;background:#fff;border:2px solid #4f7cff;border-radius:50%;pointer-events:auto;cursor:nwse-resize;z-index:3}'
    +'.oc-rot{width:32px;height:32px;background:#ff3b7f;border-color:#fff;color:#fff;cursor:grab;display:flex;align-items:center;justify-content:center;font-size:20px;line-height:1;box-shadow:0 2px 8px rgba(0,0,0,.35);z-index:4}'
    +'.oc-rot:active{cursor:grabbing}'
    +'.oc-rotline{position:absolute;left:0;top:0;width:2px;background:#ff3b7f;opacity:.85;z-index:2}'
    +'.oc-deg{position:absolute;left:0;top:0;background:#ff3b7f;color:#fff;font:600 13px/1.35 -apple-system,system-ui,sans-serif;padding:2px 9px;border-radius:6px;white-space:nowrap;pointer-events:none;z-index:2147483002;display:none;box-shadow:0 2px 8px rgba(0,0,0,.35)}'
    +'.oc-rotating,.oc-rotating *{cursor:grabbing !important}'
    // Reencuadrar dentro de un marco: el cursor de "agarrar" avisa que lo que se
    // mueve es la foto adentro del recorte, no el elemento.
    +'.oc-panning,.oc-panning *{cursor:grabbing !important}'
    +'.oc-box{position:absolute;outline:2px solid #4f7cff;outline-offset:1px}'
    // Caja envolvente de una multi-selección (punteada, para distinguirla de la
    // caja sólida de cada miembro) y banda de selección por arrastre.
    +'.oc-gbox{position:absolute;left:0;top:0;outline:2px dashed #4f7cff;outline-offset:3px}'
    +'.oc-band{position:absolute;left:0;top:0;border:1px solid #4f7cff;background:rgba(79,124,255,.14);display:none;z-index:5}'
    +'.oc-gl{position:absolute;left:0;top:0;background:#ff3b7f;z-index:2}'
    // Placeholder de imagen cargando/rota: vive ACÁ (hoja data-oc-ui, que nunca se
    // serializa) y no en el style inline del <img>, para que el recuadro gris no
    // quede horneado en el HTML guardado si se serializa antes del onload.
    +'img[data-oc-ph]{min-height:180px;background:#eceaf0;outline:2px dashed #ff3b7f;outline-offset:-2px}'
    +'img[data-oc-err]{outline:3px solid #e11d48;outline-offset:-3px}';
  document.head.appendChild(st);

  var ui=document.createElement('div'); ui.setAttribute('data-oc-ui','1');
  ui.style.cssText='position:absolute;left:0;top:0;width:'+W+'px;height:'+H+'px;pointer-events:none;z-index:2147483000';
  document.body.appendChild(ui);

  function post(m){ parent.postMessage(m,'*'); }
  function rootEl(){
    // Primer hijo RENDERIZABLE del body: muchas láminas arrancan con <style> (o
    // <link>) y colgar elementos ahí adentro los hace invisibles para siempre.
    var c=document.body.children;
    for(var i=0;i<c.length;i++){
      var t=c[i].tagName;
      if(!c[i].hasAttribute('data-oc-ui') && !c[i].hasAttribute('data-oc-tex') && t!=='SCRIPT' && t!=='STYLE' && t!=='LINK') return c[i];
    }
    return document.body;
  }
  function toHex(c){
    if(!c) return '#000000';
    if(c[0]==='#') return c;
    var m=c.match(/\d+/g); if(!m) return '#000000';
    return '#'+m.slice(0,3).map(function(n){return ('0'+parseInt(n).toString(16)).slice(-2);}).join('');
  }
  /** ¿Es un <svg> raíz (una forma/flecha standalone)? Sus trazos van por stroke, no border. */
  function isSvgRoot(el){ return !!el.tagName && el.tagName.toLowerCase()==='svg'; }
  // ── ¿es un elemento de texto editable? ───────────────────────────────────────
  // NO basta con children.length===0: un título multilínea lleva <br>, y el texto
  // con énfasis lleva <span>/<strong>/<em>. Contamos como texto a cualquier elemento
  // (que no sea imagen) con contenido y cuyos hijos sean SOLO inline de formato.
  var INLINE_TAGS={BR:1,SPAN:1,STRONG:1,EM:1,B:1,I:1,A:1,U:1,S:1,SMALL:1,SUB:1,
                   SUP:1,MARK:1,FONT:1,WBR:1,ABBR:1,CODE:1,DEL:1,INS:1};
  function isTextEl(el){
    if(!el||el.tagName==='IMG') return false;
    if((el.textContent||'').trim().length===0) return false;
    var kids=el.children;
    for(var i=0;i<kids.length;i++){ if(!INLINE_TAGS[kids[i].tagName]) return false; }
    return true;
  }
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  var FMT_SEL='span,strong,em,b,i,u,s,mark,font,a,code,small,sub,sup,del,ins,abbr';
  /** ¿El texto tiene tramos con formato propio (negrita de una palabra, etc.)? */
  function hasFormat(el){ return !!(el.querySelector && el.querySelector(FMT_SEL)); }
  // Lee el texto conservando los saltos de línea (<br> → \n) para el textarea.
  function readText(el){
    var clone=el.cloneNode(true);
    [].slice.call(clone.querySelectorAll('br')).forEach(function(br){
      br.parentNode.replaceChild(document.createTextNode('\n'), br); });
    return clone.textContent;
  }
  function tooBig(el){
    var r=el.getBoundingClientRect();
    return (r.width*r.height) > (W*H*0.80);
  }
  /**
   * Caja de LAYOUT del elemento, sin la rotación.
   *
   * getBoundingClientRect() de un elemento rotado devuelve la caja que envuelve la
   * silueta girada, que es más grande que la caja real y está corrida. Usar ese
   * rect para fijar left/top/width (posicionar con precisión, alinear, redimensionar)
   * hacía saltar y crecer cualquier elemento con giro. Se mide con la rotación
   * apagada un instante y se restaura.
   */
  function layoutRect(el){
    var inline=el.style.rotate||'', comp=getComputedStyle(el).rotate||'';
    var rotated=(inline&&inline!=='none')||(comp&&comp!=='none');
    if(!rotated) return el.getBoundingClientRect();
    el.style.rotate='none';
    var r=el.getBoundingClientRect();
    var out={left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height};
    if(inline) el.style.rotate=inline; else el.style.rotate='';
    return out;
  }
  /**
   * Valor base del transform para el arrastre.
   *
   * Antes se leía SOLO el transform inline. Una lámina que centra con
   * transform:translate(-50%,-50%) desde un <style> tiene el inline vacío, así que
   * el translate del arrastre PISABA la regla de la hoja y la imagen saltaba media
   * caja de golpe: el bug de "la imagen se va a otro lado del que la suelto".
   * Cayendo al transform computado (una matrix, válida como valor) la base se
   * conserva y el arrastre suma sobre la posición real.
   */
  function baseTransform(el){
    var inline=el.style.transform||'';
    if(inline) return inline;
    var c=getComputedStyle(el).transform;
    return (!c||c==='none') ? '' : c;
  }
  function members(el){
    var g=el.getAttribute && el.getAttribute('data-oc-g');
    if(!g) return [el];
    return [].slice.call(document.querySelectorAll('[data-oc-g="'+g+'"]'));
  }
  // Historial de fuentes de una <img>: cada regeneración/quitar-fondo guarda su src
  // en data-oc-imghist (JSON de URLs, la primera es la original). Vive en el atributo
  // → se serializa con la lámina y sobrevive al cambio de selección y de sesión.
  var IMGHISTMAX=12;
  function readImgHist(el){
    try{ var a=JSON.parse(el.getAttribute('data-oc-imghist')||'[]'); return Array.isArray(a)?a:[]; }
    catch(e){ return []; }
  }

  // ── selección inteligente: prefiere texto/imagen; si no hay, toma el decorativo ──
  // Los elementos "tooBig" (contenedores de fondo) se saltan… pero una IMG grande
  // (foto a lámina completa) debe poder seleccionarse como último recurso: si no,
  // queda pegada para siempre (ni mover, ni enviar atrás, ni borrar).
  function candidateAt(x,y,sub){
    var list=document.elementsFromPoint(x,y)||[], first=null, bigImg=null;
    for(var i=0;i<list.length;i++){
      var el=list[i], svgHit=false;
      // Un clic sobre una flecha/forma SVG devuelve el <path>/<line> interno.
      // Si el svg raíz es un elemento normal (una flecha = su propio svg) subimos
      // al raíz, que se mueve y apila como cualquier elemento. Pero si el raíz es
      // un OVERLAY a lámina completa con varias flechas adentro (o con Alt
      // apretado), seleccionamos la forma top-level clickeada — si no, todas las
      // flechas quedarían soldadas en un solo bloque.
      if(el.ownerSVGElement){
        var root=el; while(root.ownerSVGElement) root=root.ownerSVGElement;
        var top=el; while(top.parentNode && top.parentNode!==root) top=top.parentNode;
        el=(sub||tooBig(root)) ? top : root;
        svgHit=true;
      }
      if(el===document.body||el===document.documentElement||el===rootEl()) continue;
      if(el.closest && el.closest('[data-oc-ui]')) continue;
      // Capa bloqueada: transparente al clic (se toma desde el panel de capas).
      if(isLocked(el) || (el.closest && el.closest('[data-oc-lock]'))) continue;
      // Capa vinculada (sombra, material, efecto): es parte del elemento.
      if(el.hasAttribute && el.hasAttribute('data-oc-owner')) continue;
      // svgHit cuenta como "tinta real": el punto tocó una forma dentro del svg,
      // así que un svg-overlay a lámina completa sigue siendo seleccionable.
      if(tooBig(el)){ if((el.tagName==='IMG'||svgHit)&&!bigImg) bigImg=el; continue; }
      // Las formas de la librería son ciudadanas de primera: gana la de más arriba
      // (elementsFromPoint viene ordenado top→bottom), igual que texto e imagen.
      if(isTextEl(el) || el.tagName==='IMG' || (el.getAttribute&&el.getAttribute('data-oc-shape'))) return el;
      if(!first) first=el;
    }
    return first||bigImg;
  }

  // ── overlay persistente: se crea al cambiar la selección y se REPOSICIONA
  //    (nunca se reconstruye) durante el arrastre → sin jank. ──────────────────
  var boxes=[], handles=[], rotLine=null, gbox=null;
  function paint(){
    ui.innerHTML=''; boxes=[]; handles=[]; rotLine=null; gbox=null;
    sels.forEach(function(el){
      var r=el.getBoundingClientRect();
      var b=document.createElement('div'); b.className='oc-box';
      b.style.cssText='position:absolute;left:0;top:0;width:'+r.width+'px;height:'+r.height+'px;transform:translate('+r.left+'px,'+r.top+'px)';
      ui.appendChild(b); boxes.push(b);
    });
    // Una capa bloqueada muestra su caja (para saber cuál es) pero sin handles:
    // no se redimensiona ni se rota hasta desbloquearla.
    var anyLocked=sels.some(isLocked);
    if(sels.length===1 && !anyLocked){
      var el0=sels[0];
      var isTxt = isTextEl(el0);
      var r=el0.getBoundingClientRect();
      var mx=(r.left+r.right)/2, my=(r.top+r.bottom)/2;
      // 4 esquinas + laterales. En texto los laterales (w/e) refluyen el ancho sin
      // tocar la fuente; las esquinas escalan la tipografía. En no-texto los laterales
      // dan ancho/alto libres. Por eso el texto NO muestra n/s (su alto es automático).
      var hs=[['nw',r.left,r.top,'nwse'],['ne',r.right,r.top,'nesw'],
              ['sw',r.left,r.bottom,'nesw'],['se',r.right,r.bottom,'nwse'],
              ['w',r.left,my,'ew'],['e',r.right,my,'ew']];
      if(!isTxt){ hs.push(['n',mx,r.top,'ns']); hs.push(['s',mx,r.bottom,'ns']); }
      // Elementos "flacos" (una flecha SVG horizontal, una línea): los 6-8 handles
      // taparían TODO el cuerpo y cada mousedown caería en un resize en vez del
      // arrastre. Dejamos solo los del eje largo; el resto del cuerpo queda libre.
      if(r.height<28) hs=hs.filter(function(c){ return c[0]==='w'||c[0]==='e'; });
      else if(r.width<28) hs=hs.filter(function(c){ return c[0]==='n'||c[0]==='s'; });
      // Forma dentro de un svg: width/height CSS no la redimensionan → sin
      // handles de resize (mover, rotar y borrar sí funcionan).
      if(el0.ownerSVGElement) hs=[];
      hs.forEach(function(c){
        var h=document.createElement('div'); h.className='oc-h';
        h.style.cssText+=';left:0;top:0;cursor:'+c[3]+'-resize;transform:translate('+(c[1]-7)+'px,'+(c[2]-7)+'px)';
        h.addEventListener('mousedown', function(ev){ startResize(ev,c[0]); });
        ui.appendChild(h); handles.push({el:h,c:c[0]});
      });
      // conector + handle de rotación (rosa con ↻), separado del bbox para no tapar
      // el elemento. El círculo grande y el ícono lo hacen fácil de encontrar.
      var rp=rotPos(r);
      var rl=document.createElement('div'); rl.className='oc-rotline';
      ui.appendChild(rl); rotLine=rl; placeRotLine(r);
      var rh=document.createElement('div'); rh.className='oc-h oc-rot';
      rh.title='Arrastrá para rotar'; rh.textContent='↻';
      rh.style.cssText+=';left:0;top:0;transform:translate('+(rp[0]-16)+'px,'+(rp[1]-16)+'px)';
      rh.addEventListener('mousedown', startRotate);
      ui.appendChild(rh); handles.push({el:rh,c:'rot'});
    }
    // ── multi-selección: caja envolvente punteada + 4 esquinas para escalar el
    //    conjunto manteniendo las proporciones (posición, tamaño y tipografía de
    //    cada miembro se escalan con el mismo factor). ──────────────────────────
    else if(sels.length>1 && !anyLocked){
      var bb=selBBox();
      var gb=document.createElement('div'); gb.className='oc-gbox';
      gb.style.cssText+=';width:'+(bb.right-bb.left)+'px;height:'+(bb.bottom-bb.top)+'px'
        +';transform:translate('+bb.left+'px,'+bb.top+'px)';
      ui.appendChild(gb); gbox=gb;
      [['nw',bb.left,bb.top,'nwse'],['ne',bb.right,bb.top,'nesw'],
       ['sw',bb.left,bb.bottom,'nesw'],['se',bb.right,bb.bottom,'nwse']].forEach(function(c){
        var h=document.createElement('div'); h.className='oc-h';
        h.title='Arrastrá para escalar el conjunto';
        h.style.cssText+=';left:0;top:0;cursor:'+c[3]+'-resize;transform:translate('+(c[1]-7)+'px,'+(c[2]-7)+'px)';
        h.addEventListener('mousedown', function(ev){ startGroupResize(ev,c[0]); });
        ui.appendChild(h); handles.push({el:h,c:c[0]});
      });
    }
  }
  /** Caja envolvente de la selección actual, en coordenadas de lienzo. */
  function selBBox(){
    var bb={left:Infinity, top:Infinity, right:-Infinity, bottom:-Infinity};
    sels.forEach(function(el){
      var r=el.getBoundingClientRect();
      bb.left=Math.min(bb.left,r.left); bb.top=Math.min(bb.top,r.top);
      bb.right=Math.max(bb.right,r.right); bb.bottom=Math.max(bb.bottom,r.bottom); });
    return bb;
  }
  /** Dónde vive el handle de rotación: arriba del bbox, o abajo si no hay lugar. */
  function rotPos(r){
    var mx=(r.left+r.right)/2;
    return [mx, r.top>44 ? r.top-28 : r.bottom+28];
  }
  /** Traza el conector vertical entre el borde del elemento y el handle de rotación. */
  function placeRotLine(r){
    if(!rotLine) return;
    var mx=(r.left+r.right)/2, my=(r.top+r.bottom)/2, rp=rotPos(r);
    var edge = rp[1]<my ? r.top : r.bottom;   // el borde del que sale el conector
    var top=Math.min(rp[1],edge), h=Math.abs(edge-rp[1]);
    rotLine.style.height=h+'px';
    rotLine.style.transform='translate('+(mx-1)+'px,'+top+'px)';
  }
  /** Reposiciona el overlay sumando un delta a los rects cacheados (barato). */
  function offsetBoxes(rects,dx,dy){
    for(var i=0;i<boxes.length;i++){
      var r=rects[i]; if(!r) continue;
      boxes[i].style.transform='translate('+(r.left+dx)+'px,'+(r.top+dy)+'px)';
    }
  }
  /** Re-mide UN elemento y acomoda su box + handles (para el resize). */
  function syncOne(){
    if(!sels.length||!boxes.length) return;
    var r=sels[0].getBoundingClientRect();
    boxes[0].style.width=r.width+'px'; boxes[0].style.height=r.height+'px';
    boxes[0].style.transform='translate('+r.left+'px,'+r.top+'px)';
    var mx=(r.left+r.right)/2, my=(r.top+r.bottom)/2;
    var pos={nw:[r.left,r.top],ne:[r.right,r.top],sw:[r.left,r.bottom],se:[r.right,r.bottom],
             n:[mx,r.top],s:[mx,r.bottom],w:[r.left,my],e:[r.right,my],rot:rotPos(r)};
    handles.forEach(function(h){ var p=pos[h.c]; if(!p) return;
      var o=h.c==='rot'?16:7;   // el handle de rotación es más grande (32px)
      h.el.style.transform='translate('+(p[0]-o)+'px,'+(p[1]-o)+'px)'; });
    placeRotLine(r);
    syncLinked();
  }
  /** Re-mide TODA la multi-selección y acomoda cajas, envolvente y esquinas.
   *  El equivalente de syncOne para la escala de grupo: sin esto habría que
   *  llamar paint() en cada frame, que borra el overlay entero y lo reconstruye
   *  (nodos + listeners nuevos por frame), justo lo que este overlay evita. */
  function syncGroup(){
    if(!gbox) return;
    for(var i=0;i<sels.length;i++){
      var r=sels[i].getBoundingClientRect(), b=boxes[i]; if(!b) continue;
      b.style.width=r.width+'px'; b.style.height=r.height+'px';
      b.style.transform='translate('+r.left+'px,'+r.top+'px)';
    }
    var bb=selBBox();
    gbox.style.width=(bb.right-bb.left)+'px'; gbox.style.height=(bb.bottom-bb.top)+'px';
    gbox.style.transform='translate('+bb.left+'px,'+bb.top+'px)';
    var pos={nw:[bb.left,bb.top],ne:[bb.right,bb.top],sw:[bb.left,bb.bottom],se:[bb.right,bb.bottom]};
    handles.forEach(function(h){ var p=pos[h.c]; if(!p) return;
      h.el.style.transform='translate('+(p[0]-7)+'px,'+(p[1]-7)+'px)'; });
    syncLinked();   // igual que syncOne: las capas vinculadas siguen al dueño en vivo, no al soltar
  }
  function showHandles(v){ handles.forEach(function(h){ h.el.style.display=v?'block':'none'; }); }
  // capa de guías: se crea UNA vez y solo se muestra/oculta (sin churn de DOM)
  var gl=document.createElement('div'); gl.setAttribute('data-oc-ui','1');
  gl.style.cssText='position:absolute;left:0;top:0;width:'+W+'px;height:'+H+'px;pointer-events:none;z-index:2147483001';
  document.body.appendChild(gl);
  // Badge con los grados en vivo mientras se rota. Vive en la capa de guías (que
  // nunca se reconstruye), así persiste durante todo el arrastre.
  var degBadge=document.createElement('div'); degBadge.className='oc-deg'; degBadge.setAttribute('data-oc-ui','1');
  gl.appendChild(degBadge);

  // ── guías inteligentes ───────────────────────────────────────────────────────
  // Pool de líneas reutilizables: en un arrastre puede haber varias alineaciones
  // simultáneas (borde izquierdo con un texto + centro con el lienzo + base con
  // una imagen), así que no alcanza con una vertical y una horizontal fijas.
  var glPool=[];
  function guideEl(i){
    while(glPool.length<=i){
      var d=document.createElement('div'); d.className='oc-gl'; d.style.display='none';
      gl.appendChild(d); glPool.push(d);
    }
    return glPool[i];
  }
  /** Pinta la lista de guías (axis 'x'|'y', v = coordenada, a..b = tramo, canvas = del lienzo). */
  function drawGuides(list){
    for(var i=0;i<list.length;i++){
      var g=list[i], d=guideEl(i);
      d.style.display='block';
      // Rosa = referencia del lienzo (bordes, centro, márgenes); violeta = otro elemento.
      d.style.background=g.canvas?'#ff3b7f':'#7c3aed';
      if(g.axis==='x'){
        d.style.width='1px'; d.style.height=Math.max(1,g.b-g.a)+'px';
        d.style.transform='translate('+g.v+'px,'+g.a+'px)';
      } else {
        d.style.height='1px'; d.style.width=Math.max(1,g.b-g.a)+'px';
        d.style.transform='translate('+g.a+'px,'+g.v+'px)';
      }
    }
    for(var j=list.length;j<glPool.length;j++) glPool[j].style.display='none';
  }
  function clearGuides(){ for(var j=0;j<glPool.length;j++) glPool[j].style.display='none'; }

  // Zoom del lienzo en el padre (el iframe se pinta escalado). La tolerancia de
  // imán se mide en px de PANTALLA: sin esto, a 35% de zoom un margen de 9px de
  // lámina son 3px visuales y el imán se siente muerto.
  var viewScale=1;
  function tol(){ return Math.max(4, Math.round(7/Math.max(0.12,viewScale))); }
  var MARGIN=60;   // margen de seguridad de la lámina

  /** ¿El elemento comparte árbol con la selección? (a sí mismo, sus padres o hijos
   *  no se les hace snap: sus bordes son los del propio elemento que se mueve.) */
  function inSelTree(el){
    for(var i=0;i<sels.length;i++){
      if(sels[i]===el || sels[i].contains(el) || el.contains(sels[i])) return true;
    }
    return false;
  }
  /**
   * Snapshot de referencias de alineación: bordes y centro de cada elemento con
   * cuerpo real, más los bordes/centro/márgenes del lienzo. Se calcula UNA vez al
   * empezar el arrastre (medir el DOM en cada mousemove costaría el 60fps).
   */
  var SNAP_MAX=240;
  function collectSnap(){
    var xs=[], ys=[];
    function px(v,a,b,c){ xs.push({v:v,a:a,b:b,canvas:c}); }
    function py(v,a,b,c){ ys.push({v:v,a:a,b:b,canvas:c}); }
    px(0,0,H,1); px(MARGIN,0,H,1); px(W/2,0,H,1); px(W-MARGIN,0,H,1); px(W,0,H,1);
    py(0,0,W,1); py(MARGIN,0,W,1); py(H/2,0,W,1); py(H-MARGIN,0,W,1); py(H,0,W,1);
    var all=document.querySelectorAll('body *'), n=0;
    for(var i=0;i<all.length && n<SNAP_MAX;i++){
      var el=all[i], t=el.tagName;
      if(t==='SCRIPT'||t==='STYLE'||t==='LINK') continue;
      if(el.hasAttribute&&(el.hasAttribute('data-oc-ui')||el.hasAttribute('data-oc-tex'))) continue;
      if(el.closest&&el.closest('[data-oc-ui]')) continue;
      if(el.hasAttribute&&el.hasAttribute('data-oc-owner')) continue;   // decoración, no referencia
      if(el.ownerSVGElement) continue;   // formas internas de un svg: aporta el raíz
      if(inSelTree(el)) continue;
      var r=el.getBoundingClientRect();
      if(r.width<2||r.height<2) continue;
      // Contenedor a lámina completa: sus bordes ya están como bordes del lienzo.
      if(r.width>=W*0.98&&r.height>=H*0.98) continue;
      px(r.left,r.top,r.bottom,0); px((r.left+r.right)/2,r.top,r.bottom,0); px(r.right,r.top,r.bottom,0);
      py(r.top,r.left,r.right,0); py((r.top+r.bottom)/2,r.left,r.right,0); py(r.bottom,r.left,r.right,0);
      n++;
    }
    return {xs:xs, ys:ys};
  }
  /** Corrección mínima para que alguno de los candidatos caiga sobre una referencia. */
  function snapAxis(cands,targets,t){
    var best=null;
    for(var i=0;i<cands.length;i++){
      for(var j=0;j<targets.length;j++){
        var d=targets[j].v-cands[i];
        if(Math.abs(d)<=t && (!best||Math.abs(d)<Math.abs(best))) best=d;
      }
    }
    return best;
  }
  /** Todas las referencias que quedaron EXACTAS tras el snap, para pintarlas. */
  function hitGuides(cands,targets,axis,lo,hi){
    var out=[], seen={};
    for(var i=0;i<cands.length;i++){
      for(var j=0;j<targets.length;j++){
        var tg=targets[j];
        if(Math.abs(tg.v-cands[i])>0.6) continue;
        var k=axis+':'+Math.round(tg.v)+':'+(tg.canvas?1:0);
        if(seen[k]) continue;
        seen[k]=1;
        // La guía se extiende del elemento movido a su referencia (como Canva);
        // las del lienzo cruzan la lámina entera.
        out.push({axis:axis, v:tg.v, canvas:tg.canvas,
          a: tg.canvas?tg.a:Math.min(tg.a,lo), b: tg.canvas?tg.b:Math.max(tg.b,hi)});
      }
    }
    return out;
  }
  function report(){
    reportLayers();   // el panel de capas se mantiene al día con cada cambio/selección
    if(!sels.length){ post({oc:'sel',none:true}); return; }
    // er = caja de layout (sin rotación): es la que gobiernan los campos X/Y/W/H,
    // así que el panel muestra el mismo número que después se puede escribir.
    var el=sels[0], cs=getComputedStyle(el), er=layoutRect(el);
    var isText = isTextEl(el), isSvg = isSvgRoot(el);
    // Con un tramo de texto marcado, la tipografía reportada es la DEL TRAMO:
    // así el panel muestra el peso/color/tamaño real de lo que se va a cambiar.
    var rh=rangeHost();
    var ct=rh?getComputedStyle(rh):cs;
    hadRange=!!rh;   // el panel queda al día: la próxima transición sí reporta
    post({oc:'sel', count:sels.length,
      grouped: !!(el.getAttribute && el.getAttribute('data-oc-g')),
      tag:el.tagName.toLowerCase(), isText:isText,
      isImage: el.tagName==='IMG',
      src: el.tagName==='IMG' ? (el.getAttribute('src')||'') : '',
      imgHist: el.tagName==='IMG' ? readImgHist(el) : [],
      // Encaje actual: 'auto' = alto natural (sin object-fit y con height:auto).
      fit: el.tagName==='IMG'
        ? ((el.style.height==='auto'||!parseFloat(el.style.height)) && !el.style.objectFit
            ? 'auto' : (cs.objectFit||'fill'))
        : '',
      // Foto metida en un marco que la recorta: el panel ofrece "Sacar del marco".
      // 'panning' es más estrecho — solo cuando además LLENA el marco, que es
      // cuando el arrastre reencuadra en vez de mover. Una foto chica suelta
      // dentro de una tarjeta está enmarcada pero se sigue arrastrando normal.
      framed: el.tagName==='IMG' ? !!clipFrame(el) : false,
      panning: el.tagName==='IMG' ? fillsFrame(el, clipFrame(el)) : false,
      panX: el.tagName==='IMG' ? Math.round(panPos(el)[0]) : 50,
      panY: el.tagName==='IMG' ? Math.round(panPos(el)[1]) : 50,
      // ¿Sobra imagen para reencuadrar, eje por eje? Una foto con la misma
      // proporción que su marco calza justo y no tiene nada que correr: sin esto
      // el deslizador quedaba mudo y el arrastre parecía trabado.
      panFree: el.tagName==='IMG'
        ? (function(){ var rg=panRange(el); return [Math.abs(rg[0])>1, Math.abs(rg[1])>1]; })()
        : [false,false],
      text: isText ? readText(el) : '',
      range: !!rh,
      // El texto tiene tramos con formato propio: el panel lo avisa, porque editar
      // desde el campo conserva el formato pero conviene saber que está ahí.
      hasFormat: isText && hasFormat(el),
      // Fondo del contenedor que abraza al texto ('' = no hay caja pintada).
      boxBg: isText ? (function(){ var a=bgAncestor(el); return a?toHex(getComputedStyle(a).backgroundColor):''; })() : '',
      fontFamily:(ct.fontFamily||'').split(',')[0].replace(/['"]/g,'').trim(),
      fontSize:Math.round(parseFloat(ct.fontSize)||0),
      color:toHex(ct.color), fontWeight:ct.fontWeight,
      // En un svg raíz el "fondo" es el fill (viaja por color → fill:currentColor)
      bg: isSvg ? toHex(cs.color)
        : (ct.backgroundColor&&ct.backgroundColor!=='rgba(0, 0, 0, 0)'&&ct.backgroundColor!=='transparent')?toHex(ct.backgroundColor):'',
      italic:ct.fontStyle==='italic', align:cs.textAlign,
      opacity: Math.round((parseFloat(cs.opacity)||1)*100),
      blur: Math.round(filterBlur(el)),
      // Efectos activos: los filtros salen de data-oc-fx y las superficies de las
      // capas vinculadas, para que el panel muestre cuáles están prendidos.
      fx: fxConfig(el),
      fxLayers: (function(){
        var out={}, id=el.getAttribute&&el.getAttribute('data-oc-id');
        if(!id) return out;
        var ls=document.querySelectorAll('[data-oc-owner="'+id+'"][data-oc-fxkind]');
        for(var i=0;i<ls.length;i++) out[ls[i].getAttribute('data-oc-fxkind')]=1;
        return out;
      })(),
      rotation: Math.round(((parseFloat(el.style.rotate)||0)%360+360)%360),
      radius: Math.round(parseFloat(cs.borderTopLeftRadius)||0),
      isShape: !!(el.getAttribute&&el.getAttribute('data-oc-shape')),
      isSvgShape: isSvg,
      // Borde (divs/imágenes/texto) o trazo (formas svg), unificados para el panel
      borderW: isSvg ? Math.round(parseFloat(cs.strokeWidth)||0) : Math.round(parseFloat(cs.borderTopWidth)||0),
      borderStyle: isSvg ? (cs.stroke==='none' ? 'none' : ((cs.strokeDasharray&&cs.strokeDasharray!=='none')?'dashed':'solid')) : cs.borderTopStyle,
      borderColor: isSvg ? (cs.stroke==='none' ? '#111827' : toHex(cs.stroke)) : toHex(cs.borderTopColor),
      letterSpacing: ct.letterSpacing==='normal'?0:Math.round((parseFloat(ct.letterSpacing)||0)*10)/10,
      // 'normal' se reporta como 1.2 (aprox del default del navegador), no como 0:
      // mostrando 0 el campo parecía estar en el mínimo y "no dejaba" bajar el
      // interlineado, cuando el valor real era ~1.2.
      lineHeight: cs.lineHeight==='normal'?1.2:Math.round(((parseFloat(cs.lineHeight)||0)/(parseFloat(cs.fontSize)||1))*100)/100,
      // Márgenes de la caja. El interno (relleno) es el aire entre el contenido y
      // el borde propio; el externo, la separación con lo de al lado.
      padT:Math.round(parseFloat(cs.paddingTop)||0),
      padR:Math.round(parseFloat(cs.paddingRight)||0),
      padB:Math.round(parseFloat(cs.paddingBottom)||0),
      padL:Math.round(parseFloat(cs.paddingLeft)||0),
      marT:Math.round(parseFloat(cs.marginTop)||0),
      marR:Math.round(parseFloat(cs.marginRight)||0),
      marB:Math.round(parseFloat(cs.marginBottom)||0),
      marL:Math.round(parseFloat(cs.marginLeft)||0),
      // Posicionado libre: ahí el margen externo solo corre el elemento, que es lo
      // que ya hacen X/Y. El panel lo aclara en vez de dejar dos controles peleando.
      abs: cs.position==='absolute'||cs.position==='fixed',
      x:Math.round(er.left), y:Math.round(er.top), w:Math.round(er.width), h:Math.round(er.height),
      canUndo: hist.length>0});
  }
  function clearSel(){ sels=[]; savedRange=null; paint(); clearGuides(); report(); }
  function select(el, additive, solo){
    if(!el){ if(!additive) clearSel(); return; }
    var ms = solo ? [el] : members(el);
    if(additive){
      // Ya estaba seleccionado → lo saca (toggle, como Canva): Shift/Ctrl+clic
      // sirve tanto para sumar como para descartar sin rehacer la selección.
      var allIn=true;
      for(var i=0;i<ms.length;i++){ if(sels.indexOf(ms[i])<0){ allIn=false; break; } }
      if(allIn) sels=sels.filter(function(s){ return ms.indexOf(s)<0; });
      else ms.forEach(function(m){ if(sels.indexOf(m)<0) sels.push(m); });
    }
    else sels=ms.slice();
    paint(); report();
  }

  // ── selección por arrastre (marquee) ─────────────────────────────────────────
  // Arrastrar sobre una zona vacía dibuja una banda; al soltar entran todos los
  // elementos que toca. Es la forma natural de agarrar "todo el bloque de texto"
  // sin ir con Shift+clic uno por uno.
  var bandEl=null;
  function startBand(x,y,add){
    band={x0:x, y0:y, x1:x, y1:y, moved:false, add:add};
    if(!bandEl){
      bandEl=document.createElement('div'); bandEl.className='oc-band';
      bandEl.setAttribute('data-oc-ui','1'); gl.appendChild(bandEl);
    }
    bandEl.style.display='none';
  }
  function moveBand(x,y){
    band.x1=x; band.y1=y;
    if(Math.abs(x-band.x0)>4||Math.abs(y-band.y0)>4) band.moved=true;
    if(!band.moved) return;
    bandEl.style.display='block';
    bandEl.style.width=Math.abs(x-band.x0)+'px';
    bandEl.style.height=Math.abs(y-band.y0)+'px';
    bandEl.style.transform='translate('+Math.min(band.x0,x)+'px,'+Math.min(band.y0,y)+'px)';
  }
  /** Cierra la banda. Devuelve true si hubo arrastre real (y por lo tanto selección). */
  function endBand(){
    var b=band; band=null;
    if(bandEl) bandEl.style.display='none';
    if(!b||!b.moved) return false;
    var q={left:Math.min(b.x0,b.x1), top:Math.min(b.y0,b.y1),
           right:Math.max(b.x0,b.x1), bottom:Math.max(b.y0,b.y1)};
    var found=elementsInRect(q);
    if(!b.add) sels=[];
    found.forEach(function(el){
      members(el).forEach(function(m){ if(sels.indexOf(m)<0) sels.push(m); });
    });
    paint(); report();
    return true;
  }
  /**
   * ¿El elemento pinta algo propio? Una barra, un bloque de color o una tarjeta
   * son <div> pelados: no son texto, ni IMG, ni llevan data-oc-shape (ese atributo
   * lo pone SOLO la librería de formas del editor, no el HTML que genera el
   * agente). El clic sí los toma — candidateAt cae en ellos como último recurso —
   * así que la banda y Ctrl+A tienen que verlos igual, o escalar el conjunto deja
   * la barra del título en su tamaño viejo y rompe la composición.
   * Los contenedores de layout no pintan nada y quedan afuera solos.
   */
  function paintsSomething(el){
    var cs=getComputedStyle(el);
    if(cs.backgroundImage&&cs.backgroundImage!=='none') return true;
    var bg=cs.backgroundColor||'';
    if(bg&&bg!=='transparent'&&!/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(bg)) return true;
    if(cs.boxShadow&&cs.boxShadow!=='none') return true;
    return (parseFloat(cs.borderTopWidth)||0)>0 || (parseFloat(cs.borderRightWidth)||0)>0
        || (parseFloat(cs.borderBottomWidth)||0)>0 || (parseFloat(cs.borderLeftWidth)||0)>0;
  }
  /**
   * Elementos "de primera" (texto, imagen, forma, bloque decorativo) que tocan el
   * rectángulo dado. Se queda con el más interno cuando uno contiene a otro, para
   * no agarrar el contenedor y su contenido a la vez.
   */
  function elementsInRect(q){
    var out=[], all=document.querySelectorAll('body *'), root=rootEl();
    for(var i=0;i<all.length;i++){
      var el=all[i], t=el.tagName;
      if(t==='SCRIPT'||t==='STYLE'||t==='LINK') continue;
      if(el.hasAttribute&&(el.hasAttribute('data-oc-ui')||el.hasAttribute('data-oc-tex'))) continue;
      if(el.closest&&el.closest('[data-oc-ui]')) continue;
      if(el===root||el.ownerSVGElement) continue;
      if(isLocked(el)||isHidden(el)) continue;
      if(el.hasAttribute&&el.hasAttribute('data-oc-owner')) continue;   // capa vinculada: parte del elemento
      if(tooBig(el)) continue;
      var r=el.getBoundingClientRect();
      if(r.width<1||r.height<1) continue;
      if(r.right<q.left||r.left>q.right||r.bottom<q.top||r.top>q.bottom) continue;
      // paintsSomething mide estilo computado: va último, cuando ya se descartó
      // todo lo que se podía descartar con tag, atributo y geometría.
      if(!(isTextEl(el)||t==='IMG'||(el.getAttribute&&el.getAttribute('data-oc-shape'))||isSvgRoot(el))
         && !paintsSomething(el)) continue;
      out.push(el);
    }
    return out.filter(function(el){
      return !out.some(function(o){ return o!==el && el.contains(o); });
    });
  }
  function selectAll(){
    sels=elementsInRect({left:-1e6, top:-1e6, right:1e6, bottom:1e6});
    paint(); report();
  }

  // ── escala proporcional de una multi-selección ───────────────────────────────
  // Un único factor k (del eje horizontal) reescala posición, tamaño y tipografía
  // de cada miembro respecto de la esquina OPUESTA al handle, que queda fija.
  function startGroupResize(e,corner){
    if(sels.length<2) return;
    drag=null;
    snap();
    var bb=selBBox();
    sels.forEach(function(el){ if(!el.ownerSVGElement) promoteAbsolute(el); });
    grz={corner:corner, sx:e.clientX, bb:bb,
      items:sels.map(function(el){
        var r=el.getBoundingClientRect(), cs=getComputedStyle(el);
        // ¿Su left/top cuelgan de OTRO miembro de la selección? Entonces el padre
        // ya se lo lleva puesto al reposicionarse: sumarle además el desplazamiento
        // absoluto lo movería dos veces y saldría volando fuera de la tarjeta.
        // Solo le toca su parte propia del escalado (ver doGroupResize).
        var op=el.offsetParent, ar=(op&&sels.indexOf(op)>=0)?op.getBoundingClientRect():null;
        return {el:el,
          sl:parseFloat(el.style.left)||0, st:parseFloat(el.style.top)||0,
          rl:r.left, rt:r.top, w:r.width, h:r.height,
          ancRl:ar?ar.left:null, ancRt:ar?ar.top:null,
          fs:parseFloat(cs.fontSize)||0,
          ls:cs.letterSpacing==='normal'?0:(parseFloat(cs.letterSpacing)||0),
          isText:isTextEl(el), isImg:el.tagName==='IMG',
          isLine:!!(el.getAttribute&&el.getAttribute('data-oc-line')),
          // Formas DENTRO de un svg no tienen left/top ni width CSS: se dejan igual.
          skip:!!el.ownerSVGElement};
      })};
    e.preventDefault(); e.stopPropagation();
  }
  function doGroupResize(x){
    var c=grz.corner, bb=grz.bb;
    var leftSide=(c==='nw'||c==='sw'), topSide=(c==='nw'||c==='ne');
    var dx=x-grz.sx, bw=Math.max(1,bb.right-bb.left);
    var k=Math.max(0.08,(bw+(leftSide?-dx:dx))/bw);
    var ax=leftSide?bb.right:bb.left, ay=topSide?bb.bottom:bb.top;
    grz.items.forEach(function(it){
      if(it.skip) return;
      var el=it.el;
      // Posición: el punto se aleja/acerca del ancla con el mismo factor. Se
      // corrige sobre el left/top REAL sumando el desplazamiento visual.
      if(it.ancRl!=null){
        // Cuelga de otro miembro: el padre ya aporta su propio desplazamiento, así
        // que acá va SOLO la separación interna estirada por k.
        el.style.left=Math.round(it.sl+(it.rl-it.ancRl)*(k-1))+'px';
        el.style.top=Math.round(it.st+(it.rt-it.ancRt)*(k-1))+'px';
      } else {
        el.style.left=Math.round(it.sl+(ax+(it.rl-ax)*k-it.rl))+'px';
        el.style.top=Math.round(it.st+(ay+(it.rt-ay)*k-it.rt))+'px';
      }
      if(it.isText){
        el.style.fontSize=(Math.round(Math.max(6,it.fs*k)*100)/100)+'px';
        el.style.width=Math.max(8,Math.round(it.w*k))+'px';
        if(it.ls) el.style.letterSpacing=(Math.round(it.ls*k*100)/100)+'px';
      } else {
        el.style.width=Math.max(2,Math.round(it.w*k))+'px';
        if(it.isImg) el.style.height='auto';
        else if(!it.isLine) el.style.height=Math.max(2,Math.round(it.h*k))+'px';
      }
    });
    syncGroup();
  }

  // ── selección PARCIAL de texto: si el usuario marca un tramo dentro del texto
  //    (en edición inline con doble clic), los cambios de tipografía se aplican
  //    SOLO a ese tramo envolviéndolo en un <span>. Guardamos el rango porque al
  //    clicar el panel el iframe pierde el foco, pero el rango sigue vivo en este
  //    documento (cada documento mantiene su propia selección). ─────────────────
  var savedRange=null, hadRange=false;
  document.addEventListener('selectionchange', function(){
    var s=document.getSelection(); if(!s||!s.rangeCount) return;
    var r=s.getRangeAt(0), el=sels[0];
    var inEl = el && isTextEl(el) && el.contains(r.commonAncestorContainer);
    if(!r.collapsed && inEl) savedRange=r.cloneRange();
    // colapsar el caret DENTRO de la edición = el usuario des-marcó a propósito.
    // (Un colapso por mutación de DOM llega con contenteditable ya apagado y no borra.)
    else if(r.collapsed && inEl && el.getAttribute('contenteditable')==='true') savedRange=null;
    // avisar al panel solo en la transición (marcó / des-marcó), no en cada pixel
    var has=!!savedRange;
    if(has!==hadRange){ hadRange=has; report(); }
  });
  function activeRange(){
    if(!savedRange || savedRange.collapsed) return null;
    if(sels.length!==1 || !isTextEl(sels[0])) return null;
    if(!document.contains(savedRange.commonAncestorContainer)){ savedRange=null; return null; }
    if(!sels[0].contains(savedRange.commonAncestorContainer)) return null;
    return savedRange;
  }
  function rangeHost(){
    var r=activeRange(); if(!r) return null;
    var c=r.commonAncestorContainer;
    return c.nodeType===1 ? c : c.parentElement;
  }
  // Devuelve el <span> que envuelve el tramo marcado (creándolo si hace falta).
  // Si el rango ya cubre exacto un inline existente (nuestro span de un cambio
  // anterior, o un <strong>/<em> del HTML), lo reutilizamos: sin spans anidados.
  function rangeSpan(){
    var r=activeRange(); if(!r) return null;
    var host=rangeHost();
    if(host && host!==sels[0] && (host.getAttribute('data-oc-rs')||INLINE_TAGS[host.tagName])
       && r.toString()===host.textContent) return host;
    var span=document.createElement('span');
    span.setAttribute('data-oc-rs','1');
    try{ r.surroundContents(span); }
    catch(err){ // el rango cruza el borde de una etiqueta: extraer e insertar
      span.appendChild(r.extractContents()); r.insertNode(span); }
    // re-apuntar rango y selección visual al span → los cambios encadenados
    // (peso + color + tamaño…) caen todos en el mismo tramo
    savedRange=document.createRange(); savedRange.selectNodeContents(span);
    var ds=document.getSelection();
    if(ds){ try{ ds.removeAllRanges(); ds.addRange(savedRange.cloneRange()); }catch(e2){} }
    return span;
  }

  // ── historial ────────────────────────────────────────────────────────────────
  function snap(){
    ui.remove(); gl.remove();
    hist.push(document.body.innerHTML.replace(/<script[\s\S]*?<\/script>/gi,''));
    if(hist.length>HMAX) hist.shift();
    document.body.appendChild(gl); document.body.appendChild(ui);
  }
  function undo(){
    if(!hist.length) return;
    var html=hist.pop();
    document.body.innerHTML=html;
    document.body.appendChild(gl); document.body.appendChild(ui);
    sels=[]; boxes=[]; handles=[]; paint(); report(); serializeNoSnap();
  }

  document.addEventListener('click', function(e){
    e.preventDefault(); e.stopPropagation();
    if(squelch){ squelch=false; return; }   // click sintético al soltar un drag/resize/rotación
    // Shift o Ctrl/Cmd suman (o descartan) elementos; Alt toma un miembro suelto.
    select(candidateAt(e.clientX,e.clientY,e.altKey), e.shiftKey||e.ctrlKey||e.metaKey, e.altKey);
  }, true);

  // ── arrastre con transform + snap ────────────────────────────────────────────
  document.addEventListener('mousedown', function(e){
    if(rz||rot||grz) return;
    var x=e.clientX,y=e.clientY;
    // Los handles del overlay tienen su propio mousedown (resize/rotación): este
    // listener no debe armar un arrastre ni una banda encima de ellos.
    if(e.target&&e.target.closest&&e.target.closest('[data-oc-ui]')) return;
    // Dentro de una edición de texto el mouse es del caret, no del editor.
    if(e.target&&e.target.closest&&e.target.closest('[contenteditable="true"]')) return;
    // Zona de agarre con mínimo 28px por eje: un elemento flaco (flecha de 6px de
    // alto) era imposible de "pescar" con el rect exacto.
    var hit=sels.length>0&&sels.some(function(el){ var r=el.getBoundingClientRect();
      var px=Math.max(0,(28-r.width)/2), py=Math.max(0,(28-r.height)/2);
      return x>=r.left-px&&x<=r.right+px&&y>=r.top-py&&y<=r.bottom+py; });
    // Fuera de lo seleccionado: arrancar la banda de selección por arrastre.
    if(!hit){ startBand(x,y,e.shiftKey||e.ctrlKey||e.metaKey); e.preventDefault(); return; }
    // Con un modificador apretado el mousedown sobre algo YA seleccionado no
    // arrastra: si armara un arrastre, su mouseup se comería el clic siguiente
    // (squelch) y Shift/Ctrl+clic para descartar — o Alt+clic para tomar un
    // miembro suelto del grupo — no llegaban nunca a ejecutarse.
    if(e.shiftKey||e.ctrlKey||e.metaKey||e.altKey) return;
    if(sels.some(isLocked)) return;   // capa bloqueada: no se mueve
    if(sels[0].getAttribute('contenteditable')==='true') return;
    savedRange=null;   // agarrar el elemento entero = adiós al tramo marcado
    // Foto que llena un marco: arrastrarla corre el ENCUADRE dentro del marco. Si
    // moviera el elemento se iría del recorte y quedaría cortada, que es lo que
    // nadie quiere. Para sacarla de verdad está "Sacar del marco" en el panel.
    var fr0=sels.length===1 ? clipFrame(sels[0]) : null;
    if(fr0&&fillsFrame(sels[0],fr0)){
      snap();
      pan={el:sels[0], sx:x, sy:y, p0:panPos(sels[0]), rg:panRange(sels[0])};
      showHandles(false);
      document.body.classList.add('oc-panning');
      e.preventDefault();
      return;
    }
    snap();
    sels.forEach(makeMovable);
    // rects cacheados: durante el arrastre NO se vuelve a medir (cero reflows)
    var rects=sels.map(function(el){ var r=el.getBoundingClientRect();
      return {left:r.left, top:r.top, width:r.width, height:r.height}; });
    // Caja envolvente de TODA la selección: el snap trabaja sobre ella, así un
    // grupo se alinea como una unidad (y no por su primer miembro).
    var bb={left:Infinity, top:Infinity, right:-Infinity, bottom:-Infinity};
    rects.forEach(function(r){
      bb.left=Math.min(bb.left,r.left); bb.top=Math.min(bb.top,r.top);
      bb.right=Math.max(bb.right,r.left+r.width); bb.bottom=Math.max(bb.bottom,r.top+r.height); });
    drag={sx:x, sy:y, bbox:bb,
      start:sels.map(function(el){ return (delta.get(el)||[0,0]).slice(); }),
      // Un miembro que vive DENTRO de otro ya viaja con el transform del padre:
      // aplicarle además el suyo lo movería el doble. Se lo deja quieto y va de
      // arrastrado (su caja del overlay sí se corre, porque en pantalla se mueve).
      rides:sels.map(function(el){
        return sels.some(function(o){ return o!==el && o.contains(el); }); }),
      rects:rects, snap:collectSnap()};
    showHandles(false);
    e.preventDefault();
  }, true);
  // ── marcos: una foto metida en un contenedor que recorta ─────────────────────
  // Los formatos del ADN encuadran las fotos dentro de marcos (el medallón redondo
  // del cierre, la tarjeta de una cita): un contenedor con overflow oculto y la
  // imagen a width/height:100% + object-fit. Arrastrar esa imagen la sacaba del
  // marco y quedaba cortada. Adentro de un marco el arrastre mueve el ENCUADRE.

  /**
   * Marco que recorta a un elemento: el ancestro más cercano que corta lo que se
   * sale y que NO es el lienzo entero. La lámina también lleva overflow:hidden,
   * pero recortar contra el borde del lienzo es lo correcto, no un marco del que
   * haya que salir.
   */
  function clipFrame(el){
    var cw=document.documentElement.clientWidth, ch=document.documentElement.clientHeight;
    var p=el.parentElement;
    while(p&&p!==document.body&&p!==document.documentElement){
      var cs=getComputedStyle(p);
      if(cs.overflow!=='visible'||(cs.clipPath&&cs.clipPath!=='none')){
        var r=p.getBoundingClientRect();
        return (r.width<cw-2||r.height<ch-2) ? p : null;
      }
      p=p.parentElement;
    }
    return null;
  }
  /**
   * ¿La imagen LLENA su marco? Solo ahí "moverla" quiere decir reencuadrarla. Una
   * foto chica suelta dentro de una tarjeta se sigue moviendo como cualquier cosa.
   */
  function fillsFrame(el, fr){
    if(el.tagName!=='IMG'||!fr) return false;
    var fit=getComputedStyle(el).objectFit;
    if(fit!=='cover'&&fit!=='contain') return false;
    // Se compara contra la caja de CONTENIDO del marco, que es la que la foto
    // llena: clientWidth ya descuenta el borde y el relleno se saca aparte. Contra
    // el rect exterior, un borde de 6px alcanzaba para que no diera y la foto se
    // iba del recorte igual que antes.
    var fcs=getComputedStyle(fr);
    var iw=fr.clientWidth-(parseFloat(fcs.paddingLeft)||0)-(parseFloat(fcs.paddingRight)||0);
    var ih=fr.clientHeight-(parseFloat(fcs.paddingTop)||0)-(parseFloat(fcs.paddingBottom)||0);
    var ir=el.getBoundingClientRect();
    return ir.width>=iw-2 && ir.height>=ih-2;
  }
  /**
   * Recorrido del encuadre por eje, con signo: (caja - imagen escalada). Con
   * 'cover' sobra imagen y da negativo (subir el % la corre hacia la izquierda);
   * con 'contain' sobra caja y da positivo. Ese número es el que convierte los px
   * del mouse en el % de object-position, y si es 0 el eje no tiene juego.
   */
  function panRange(el){
    var r=el.getBoundingClientRect(), nw=el.naturalWidth, nh=el.naturalHeight;
    if(!nw||!nh||!r.width||!r.height) return [0,0];
    var fit=getComputedStyle(el).objectFit;
    var s=fit==='contain' ? Math.min(r.width/nw, r.height/nh) : Math.max(r.width/nw, r.height/nh);
    return [r.width-nw*s, r.height-nh*s];
  }
  /** Encuadre actual en % por eje. El computado llega en % o en px según cómo se declaró. */
  function panPos(el){
    var rg=panRange(el);
    var parts=(getComputedStyle(el).objectPosition||'50% 50%').trim().split(/\s+/);
    return [panPct(parts[0], rg[0]), panPct(parts[1]==null?parts[0]:parts[1], rg[1])];
  }
  function panPct(v, range){
    if(v==null||v==='') return 50;
    if(v==='left'||v==='top') return 0;
    if(v==='right'||v==='bottom') return 100;
    if(v==='center') return 50;
    if(v.indexOf('%')>=0) return parseFloat(v)||0;
    // px: es el desplazamiento del borde de la imagen dentro de la caja, y el
    // recorrido completo vale 100% — sin recorrido no hay % que valga, va al medio.
    var px=parseFloat(v); if(isNaN(px)) return 50;
    return range ? px/range*100 : 50;
  }
  function clampPct(v){ return Math.max(0, Math.min(100, Math.round(v*10)/10)); }
  function setPan(el, px, py){
    el.style.objectPosition=clampPct(px)+'% '+clampPct(py)+'%';
  }
  function doPan(x,y){
    var rg=pan.rg;
    setPan(pan.el,
      rg[0] ? pan.p0[0]+(x-pan.sx)*100/rg[0] : pan.p0[0],
      rg[1] ? pan.p0[1]+(y-pan.sy)*100/rg[1] : pan.p0[1]);
  }
  /**
   * Saca la imagen del marco conservando lo que se ve: queda en el mismo lugar y
   * tamaño, hereda el redondeo del marco (si no tenía uno propio) y pasa a
   * posición libre, así ya no la recorta nadie. Se inserta justo después del
   * marco para no saltar al frente de todo.
   */
  function unframe(el){
    var fr=clipFrame(el); if(!fr) return;
    var r=layoutRect(el), fcs=getComputedStyle(fr);
    if(!parseFloat(getComputedStyle(el).borderTopLeftRadius) && parseFloat(fcs.borderTopLeftRadius))
      el.style.borderRadius=fcs.borderRadius;
    if(fr.parentNode) fr.parentNode.insertBefore(el, fr.nextSibling);
    el.style.position='absolute';
    el.style.width=Math.round(r.width)+'px';
    el.style.height=Math.round(r.height)+'px';
    el.style.margin='0';
    // 'none', no '': vaciarlo deja volver un transform declarado en un <style>.
    el.style.transform='none';
    // left/top se miden contra el ancestro posicionado NUEVO, que ya no es el marco.
    var op=el.offsetParent||document.body, opr=op.getBoundingClientRect();
    el.style.left=Math.round(r.left-opr.left)+'px';
    el.style.top=Math.round(r.top-opr.top)+'px';
    mode.delete(el); baseTf.set(el,''); baseOff.delete(el); delta.set(el,[0,0]);
    el.setAttribute('data-oc-abs','1');
  }

  // Los elementos inline (p.ej. un <span> de texto) IGNORAN transform. Cambiarles
  // el display los hace saltar. Para esos usamos position:relative + left/top, que
  // sí funciona en inline y tampoco altera el flujo del documento.
  var mode=new WeakMap(), baseOff=new WeakMap();
  function makeMovable(el){
    if(mode.has(el)) return;
    var cs=getComputedStyle(el);
    if(el.ownerSVGElement){
      // Formas DENTRO de un svg: left/top no les aplican jamás, pero el transform
      // CSS sí (Chromium). Van siempre por transform, ignorando su display.
      mode.set(el,'transform');
      if(!baseTf.has(el)) baseTf.set(el, baseTransform(el));
    } else if(cs.display==='inline'){
      mode.set(el,'offset');
      if(cs.position==='static') el.style.position='relative';
      // El punto de partida sale del estilo COMPUTADO, no solo del inline: un
      // inline con position:relative y left/top declarados en un <style> tenía
      // base 0 y al primer arrastre saltaba al origen de su flujo. (En un
      // static el computado es 'auto' y cae a 0, que es el arranque correcto de un
      // position:relative recién puesto.)
      var bl=parseFloat(el.style.left); if(isNaN(bl)) bl=parseFloat(cs.left);
      var bt=parseFloat(el.style.top);  if(isNaN(bt)) bt=parseFloat(cs.top);
      baseOff.set(el,[isNaN(bl)?0:bl, isNaN(bt)?0:bt]);
    } else {
      mode.set(el,'transform');
      if(!baseTf.has(el)) baseTf.set(el, baseTransform(el));
    }
  }
  function applyT(el,nx,ny){
    delta.set(el,[nx,ny]);
    if(mode.get(el)==='offset'){
      var o=baseOff.get(el)||[0,0];
      el.style.left=(o[0]+nx)+'px'; el.style.top=(o[1]+ny)+'px';
    } else {
      var b=baseTf.get(el)||'';
      el.style.transform=(b?b+' ':'')+'translate('+nx+'px,'+ny+'px)';
    }
  }

  // mousemove throttleado con requestAnimationFrame → 60fps, sin trabas
  var pend=null, raf=0;
  function flush(){
    raf=0;
    if(!pend) return;
    var x=pend.x, y=pend.y, noSnap=pend.alt; pend=null;
    if(band){ moveBand(x,y); return; }
    if(pan){ doPan(x,y); return; }
    if(rot){ doRotate(x,y); return; }
    if(grz){ doGroupResize(x); return; }
    if(rz){ doResize(x,y,noSnap); return; }
    if(!drag||!sels.length) return;
    var dx=x-drag.sx, dy=y-drag.sy;
    // ── snap inteligente: bordes/centro de la selección contra bordes/centros de
    //    los demás elementos y del lienzo. Todo desde los rects cacheados al
    //    empezar el arrastre → cero reflows en el mousemove. Alt lo desactiva. ──
    var bb=drag.bbox, gs=[];
    if(!noSnap && drag.snap){
      var t=tol();
      var cxs=[bb.left+dx, (bb.left+bb.right)/2+dx, bb.right+dx];
      var sx2=snapAxis(cxs, drag.snap.xs, t);
      if(sx2!=null){ dx+=sx2; cxs=[bb.left+dx,(bb.left+bb.right)/2+dx,bb.right+dx]; }
      var cys=[bb.top+dy, (bb.top+bb.bottom)/2+dy, bb.bottom+dy];
      var sy2=snapAxis(cys, drag.snap.ys, t);
      if(sy2!=null){ dy+=sy2; cys=[bb.top+dy,(bb.top+bb.bottom)/2+dy,bb.bottom+dy]; }
      gs=hitGuides(cxs, drag.snap.xs, 'x', bb.top+dy, bb.bottom+dy)
        .concat(hitGuides(cys, drag.snap.ys, 'y', bb.left+dx, bb.right+dx));
    }
    for(var i=0;i<sels.length;i++){
      if(drag.rides[i]) continue;
      applyT(sels[i], drag.start[i][0]+dx, drag.start[i][1]+dy);
    }
    offsetBoxes(drag.rects, dx, dy);
    syncLinked();   // la sombra de puntos sigue al elemento en vivo
    drawGuides(gs);
  }
  window.addEventListener('mousemove', function(e){
    if(!drag&&!rz&&!rot&&!grz&&!band&&!pan) return;
    pend={x:e.clientX,y:e.clientY,alt:e.altKey};
    if(!raf) raf=requestAnimationFrame(flush);
  });
  window.addEventListener('mouseup', function(){
    if(raf){ cancelAnimationFrame(raf); raf=0; pend=null; }
    // squelch: el click que dispara este mouseup re-seleccionaría lo que quede
    // bajo el puntero (tras rotar suele ser "nada" → deseleccionaba). Lo tragamos.
    // Se auto-apaga en el próximo tick: si el navegador NO emite ese click
    // (targets distintos), el flag no puede comerse el siguiente clic real.
    // La banda no modifica la lámina: no serializa, solo cambia la selección.
    if(band){ if(endBand()) squelchNext(); return; }
    if(pan){ pan=null; squelchNext(); document.body.classList.remove('oc-panning'); showHandles(true); paint(); report(); serialize(); return; }
    if(rot){ rot=null; squelchNext(); document.body.classList.remove('oc-rotating'); degBadge.style.display='none'; paint(); report(); serialize(); return; }
    if(grz){ grz=null; squelchNext(); paint(); report(); serialize(); return; }
    if(rz){ rz=null; squelchNext(); clearGuides(); paint(); report(); serialize(); return; }
    if(drag){ drag=null; squelchNext(); clearGuides(); showHandles(true); paint(); report(); serialize(); }
  });
  function squelchNext(){ squelch=true; setTimeout(function(){ squelch=false; },0); }

  // ── rotación: handle rosa → CSS 'rotate' (propiedad independiente de transform,
  //    así el arrastre con translate y promoteAbsolute no la pisan) ─────────────
  function startRotate(e){
    if(sels.length!==1) return;
    drag=null;
    var el=sels[0], r=el.getBoundingClientRect();
    snap();
    prepSvgRotate(el);
    var cx=(r.left+r.right)/2, cy=(r.top+r.bottom)/2;
    rot={el:el, cx:cx, cy:cy,
         a0:Math.atan2(e.clientY-cy, e.clientX-cx),
         r0:parseFloat(el.style.rotate)||0};
    showHandles(false); if(rotLine) rotLine.style.display='none';
    document.body.classList.add('oc-rotating');
    e.preventDefault(); e.stopPropagation();
  }
  // En SVG el origen de rotación por defecto es el (0,0) del view-box, no el
  // centro de la forma: sin esto, rotar una flecha la haría orbitar la esquina.
  function prepSvgRotate(el){
    if(el.ownerSVGElement){ el.style.transformBox='fill-box'; el.style.transformOrigin='center'; }
  }
  function doRotate(x,y){
    var a=Math.atan2(y-rot.cy, x-rot.cx);
    var deg=rot.r0+(a-rot.a0)*180/Math.PI;
    var s=Math.round(deg/45)*45;          // imán en 0/45/90/…
    if(Math.abs(deg-s)<4) deg=s;
    deg=((Math.round(deg*10)/10)%360+360)%360;
    rot.el.style.rotate=deg+'deg';
    syncOne();
    // badge con los grados en vivo, centrado sobre el elemento
    var br=rot.el.getBoundingClientRect();
    degBadge.textContent=Math.round(deg)+'°';
    degBadge.style.display='block';
    degBadge.style.transform='translate('+(rot.cx-degBadge.offsetWidth/2)+'px,'+(br.top-36)+'px)';
  }

  function startResize(e,corner){
    if(sels.length!==1) return;
    drag=null;  // un resize nunca coexiste con un arrastre (el mousedown del doc pudo armarlo)
    var el=sels[0], cs=getComputedStyle(el), isTxt=isTextEl(el);
    snap();
    // Anclar el borde OPUESTO al handle: horneamos la posición visual actual a
    // left/top reales (baja el translate del arrastre a coordenadas) para poder
    // mover el ancla al redimensionar. Sin esto, un elemento ya arrastrado lee un
    // left/top que no incluye el translate y "salta". En texto no aplica: su tamaño
    // lo maneja fontSize/width sin ancla, y fijarle el ancho reflowearía de golpe.
    if(!isTxt && !el.ownerSVGElement){ el.removeAttribute('data-oc-abs'); promoteAbsolute(el); }
    var r=layoutRect(el);   // sin la rotación: si no, un elemento girado se agranda al tocarlo
    rz={el:el, sx:e.clientX, sy:e.clientY, w:r.width, h:r.height, corner:corner,
        left:parseFloat(el.style.left)||0, top:parseFloat(el.style.top)||0,
        fs:parseFloat(cs.fontSize)||0,
        isText: isTxt,
        rect:{left:r.left, top:r.top, right:r.right, bottom:r.bottom},
        snap:collectSnap()};
    e.preventDefault(); e.stopPropagation();
  }
  function doResize(x,y,noSnap){
    var dx=x-rz.sx, dy=y-rz.sy, c=rz.corner;
    var leftSide=(c==='nw'||c==='sw'||c==='w'), topSide=(c==='nw'||c==='ne'||c==='n');
    var isCorner=(c.length===2);
    // ── el borde que se arrastra también hace imán: redimensionar hasta tocar el
    //    borde de otro elemento o el margen es la mitad del trabajo de composición.
    //    En n/s manda el eje vertical; en el resto (esquinas y laterales), el
    //    horizontal — es el eje que gobierna la escala. ─────────────────────────
    var rr=rz.rect, gs=[];
    if(!noSnap && rz.snap){
      var tt=tol();
      if(c==='n'||c==='s'){
        var eY=(topSide?rr.top:rr.bottom)+dy;
        var sY=snapAxis([eY], rz.snap.ys, tt);
        if(sY!=null){ dy+=sY; eY+=sY; }
        gs=hitGuides([eY], rz.snap.ys, 'y', rr.left, rr.right);
      } else {
        var eX=(leftSide?rr.left:rr.right)+dx;
        var sX=snapAxis([eX], rz.snap.xs, tt);
        if(sX!=null){ dx+=sX; eX+=sX; }
        gs=hitGuides([eX], rz.snap.xs, 'x', rr.top, rr.bottom);
      }
    }
    drawGuides(gs);
    var wDelta=leftSide?-dx:dx, hDelta=topSide?-dy:dy;
    if(rz.isText){
      if(isCorner){ // esquina → escalar la tipografía (proporcional, por el eje horizontal)
        var ratio=Math.max(0.15,(rz.w+wDelta)/Math.max(1,rz.w));
        rz.el.style.fontSize=Math.max(8,Math.round(rz.fs*ratio))+'px';
      } else { // lateral w/e → SOLO ancho: el texto refluye, fontSize intacto
        rz.el.style.width=Math.max(20,Math.round(rz.w+wDelta))+'px';
      }
      syncOne(); return;
    }
    // no-texto: cambiamos el tamaño Y movemos el ancla, para que la esquina/borde
    // opuesto al handle quede fijo (si no, el elemento crece hacia el lado contrario
    // al que arrastrás y parece saltar).
    var newW=rz.w, newH=rz.h;
    if(isCorner){ // esquina → escala proporcional
      var ratio2=Math.max(0.15,(rz.w+wDelta)/Math.max(1,rz.w));
      newW=Math.max(20,Math.round(rz.w*ratio2));
      rz.el.style.width=newW+'px';
      if(rz.el.tagName==='IMG'){ rz.el.style.height='auto'; newH=rz.el.getBoundingClientRect().height; }
      // formas: el alto acompaña (un círculo sigue círculo); las líneas no tienen alto
      else if(rz.el.getAttribute&&rz.el.getAttribute('data-oc-shape')&&!rz.el.getAttribute('data-oc-line')){
        newH=Math.max(20,Math.round(rz.h*ratio2)); rz.el.style.height=newH+'px';
      }
    } else if(c==='e'||c==='w'){ // lateral → ancho libre
      newW=Math.max(20,Math.round(rz.w+wDelta));
      rz.el.style.width=newW+'px';
      if(rz.el.tagName==='IMG') rz.el.style.height='auto';
    } else { // n/s → alto libre
      newH=Math.max(20,Math.round(rz.h+hDelta));
      rz.el.style.height=newH+'px';
    }
    if(leftSide) rz.el.style.left=Math.round(rz.left+(rz.w-newW))+'px';
    if(topSide) rz.el.style.top=Math.round(rz.top+(rz.h-newH))+'px';
    syncOne();   // re-mide solo el elemento activo, sin reconstruir el overlay
  }

  /**
   * Entra en edición inline (lo que hace el doble clic). Es también el único modo
   * en que se puede MARCAR un tramo de texto para darle formato propio: fuera de
   * la edición, arrastrar sobre el texto mueve el elemento. Por eso el panel
   * expone un botón que llama acá, en vez de dejarlo escondido en el doble clic.
   */
  function editText(t){
    if(!t||!isTextEl(t)||isLocked(t)) return;
    snap();
    t.setAttribute('contenteditable','true'); t.focus();
    var end=function(){
      t.setAttribute('contenteditable','false'); t.removeEventListener('blur',end);
      paint(); report(); serialize();
    };
    t.addEventListener('blur', end);
    report();
  }
  document.addEventListener('dblclick', function(e){
    editText(candidateAt(e.clientX,e.clientY));
  }, true);

  // ── teclado: undo, copy/paste, duplicar, borrar, nudge ───────────────────────
  document.addEventListener('keydown', function(e){
    var ed=document.querySelector('[contenteditable="true"]');
    var mod=e.ctrlKey||e.metaKey;
    if(mod && e.key.toLowerCase()==='z'){ e.preventDefault(); undo(); return; }
    if(ed) return;   // editando texto: Ctrl+A / Ctrl+C son del caret
    // Enter sobre un texto seleccionado entra a editarlo (como en Canva).
    if(e.key==='Enter' && sels.length===1 && isTextEl(sels[0])){
      e.preventDefault(); editText(sels[0]); return;
    }
    if(mod && e.key.toLowerCase()==='a'){ e.preventDefault(); selectAll(); return; }
    if(mod && e.key.toLowerCase()==='c'){ e.preventDefault(); copy(); return; }
    // Ctrl+V NO se intercepta acá: dejamos que dispare el evento 'paste' nativo,
    // que sabe mirar el portapapeles del SISTEMA (imágenes) además del interno.
    if(mod && e.key.toLowerCase()==='d'){ e.preventDefault(); duplicate(); return; }
    if((e.key==='Delete'||e.key==='Backspace') && sels.length){ e.preventDefault(); apply({prop:'remove'}); return; }
    if(e.key.indexOf('Arrow')===0 && sels.length){
      e.preventDefault();
      if(sels.some(isLocked)) return;
      var s=e.shiftKey?10:1, dx=0, dy=0;
      if(e.key==='ArrowLeft')dx=-s; if(e.key==='ArrowRight')dx=s;
      if(e.key==='ArrowUp')dy=-s; if(e.key==='ArrowDown')dy=s;
      // snap solo en la primera pulsación: mantener una flecha apretada dispara
      // keydown en auto-repeat y llenaría el historial (60) en un segundo.
      if(!e.repeat) snap();
      sels.forEach(function(el){
        makeMovable(el);
        var d=delta.get(el)||[0,0]; applyT(el,d[0]+dx,d[1]+dy); });
      paint(); serialize();
    }
  }, true);

  // ── pegado: una imagen del portapapeles del sistema (captura de pantalla,
  //    "copiar imagen" en otra app) se manda al padre para subirla e insertarla.
  //    Sin imagen, cae al portapapeles interno (elementos copiados con Ctrl+C). ──
  document.addEventListener('paste', function(e){
    if(document.querySelector('[contenteditable="true"]')) return; // edición inline: pegado nativo de texto
    var files=(e.clipboardData&&e.clipboardData.files)?[].slice.call(e.clipboardData.files):[];
    var img=null;
    for(var i=0;i<files.length;i++){ if(files[i].type.indexOf('image/')===0){ img=files[i]; break; } }
    e.preventDefault();
    if(img){ post({oc:'pasteImage', file:img}); return; }
    paste();
  }, true);

  function copy(){
    if(!sels.length) return;
    clip=sels.map(function(el){
      var h=el.outerHTML;
      // Las capas vinculadas (sombra de puntos, superficies) son HERMANOS con
      // data-oc-owner, no hijos: si no viajan con el elemento, la copia sale
      // pelada — el mismo problema que tenían los grupos antes del remapeo.
      // Van pegadas en la misma entrada del clip: así el portapapeles sigue
      // siendo un array de strings y el paste de otra lámina no cambia.
      var id=el.getAttribute&&el.getAttribute('data-oc-id');
      if(id){
        var ls=document.querySelectorAll('[data-oc-owner="'+id+'"]');
        for(var i=0;i<ls.length;i++) h+=ls[i].outerHTML;
      }
      return h;
    });
    // Portapapeles COMPARTIDO entre láminas: cada lámina es un iframe propio, así
    // que subimos el HTML al padre. Al montar otra lámina, el padre nos re-inyecta
    // este clip (setClip) y el Ctrl+V / "Pegar" funciona de lámina a lámina.
    post({oc:'clip', html:clip});
    // Pisamos el portapapeles del sistema (mejor esfuerzo): sin esto, un
    // screenshot viejo le ganaría al elemento recién copiado en el Ctrl+V.
    try{ if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(' ').catch(function(){}); }catch(err){}
    post({oc:'toast',msg:sels.length+' copiado(s)'});
  }
  // Al pegar de OTRA lámina la fuente del elemento puede no estar cargada acá:
  // recorremos el árbol pegado y aseguramos cada font-family inline (Google Fonts).
  function ensureFontsIn(el){
    var all=[el].concat([].slice.call(el.querySelectorAll('*')));
    all.forEach(function(n){
      var ff=n.style&&n.style.fontFamily;
      if(ff) ensureFont(ff.split(',')[0].replace(/['"]/g,'').trim());
    });
  }
  function paste(){
    if(!clip.length) return;
    snap();
    // Duplicar un grupo tiene que dar OTRO grupo, no piezas sueltas: cada id de
    // grupo del original se remapea a uno nuevo, compartido por las copias.
    var added=[], gmap={}, gseq=0;
    clip.forEach(function(h){
      var t=document.createElement('div'); t.innerHTML=h;
      var el=t.firstElementChild; if(!el) return;
      // Lo que viene detrás del elemento en la entrada del clip son sus capas
      // vinculadas (ver copy()); se re-apuntan al id NUEVO más abajo.
      var layers=[].slice.call(t.children,1);
      var og=el.getAttribute('data-oc-g');
      if(og){
        if(!gmap[og]) gmap[og]='g'+Date.now().toString(36)+(gseq++);
        el.setAttribute('data-oc-g', gmap[og]);
      }
      // Los ids de capa son únicos por elemento: la copia tiene que pedir el suyo
      // (si no, el panel de capas ve dos filas con el mismo id).
      el.removeAttribute('data-oc-id');
      var kids=el.querySelectorAll('[data-oc-id]');
      for(var q=0;q<kids.length;q++) kids[q].removeAttribute('data-oc-id');
      rootEl().appendChild(el);
      // La copia ya tiene su id propio: las capas se cuelgan de ESE, no del
      // original (si no, las dos compartirían una sola capa).
      if(layers.length){
        var nid=ensureLayerId(el), ref=el.nextSibling;
        layers.forEach(function(L){
          L.setAttribute('data-oc-owner', nid);
          el.parentElement.insertBefore(L, ref);
        });
      }
      ensureFontsIn(el);
      var d=[20,20]; delta.set(el,d); baseTf.set(el, el.style.transform||'');
      el.style.transform=(el.style.transform?el.style.transform+' ':'')+'translate(20px,20px)';
      added.push(el);
    });
    syncLinked();   // las capas recién pegadas todavía están en la posición del original
    sels=added; paint(); report(); serialize();
  }
  function duplicate(){ copy(); paste(); }

  function ensureFont(fam){
    if(!fam) return;
    var id='ocf-'+fam.replace(/[^a-z0-9]/gi,'');
    if(document.getElementById(id)) return;
    var l=document.createElement('link'); l.id=id; l.rel='stylesheet'; l.setAttribute('data-oc-ui','1');
    l.href='https://fonts.googleapis.com/css2?family='+fam.replace(/ /g,'+')+':${GF_ITAL_WGHT}&display=swap';
    document.head.appendChild(l);
  }
  // ── posicionamiento absoluto: al manipular con precisión (panel numérico o
  //    alinear/distribuir) fijamos left/top/width reales relativos al ancestro
  //    posicionado, preservando la posición visual. Así hay coordenadas de verdad.
  //    No tocamos el arrastre (sigue con transform); esto solo corre bajo demanda. ─
  function promoteAbsolute(el){
    if(el.ownerSVGElement) return;   // formas svg: position/left/top no existen
    if(el.getAttribute('data-oc-abs')) return;
    // Sin la rotación: el rect de un elemento girado es su envolvente, no su caja.
    var er=layoutRect(el);
    el.style.position='absolute';
    var op=el.offsetParent||document.body, opr=op.getBoundingClientRect();
    el.style.left=Math.round(er.left-opr.left)+'px';
    el.style.top=Math.round(er.top-opr.top)+'px';
    el.style.width=Math.round(er.width)+'px';
    el.style.margin='0';
    // 'none', no '': vaciar el inline deja volver un transform declarado en un
    // <style> (típico translate(-50%,-50%)) y el elemento se corre media caja.
    el.style.transform='none';
    // La posición quedó horneada en left/top, así que la contabilidad del arrastre
    // (modo, base de transform/offset, delta) es vieja: si no se limpia, el próximo
    // arrastre vuelve a sumar el transform anterior y el elemento salta.
    mode.delete(el); baseTf.set(el,''); baseOff.delete(el); delta.set(el,[0,0]);
    el.setAttribute('data-oc-abs','1');
  }
  function moveTo(el,x,y){   // x,y en coordenadas de lienzo (origen 0,0)
    if(el.ownerSVGElement){  // forma svg: mover vía transform, no left/top
      makeMovable(el);
      var r=el.getBoundingClientRect(), d=delta.get(el)||[0,0];
      applyT(el, d[0]+(x!=null?x-r.left:0), d[1]+(y!=null?y-r.top:0));
      return;
    }
    promoteAbsolute(el);
    var op=el.offsetParent||document.body, opr=op.getBoundingClientRect();
    if(x!=null) el.style.left=Math.round(x-opr.left)+'px';
    if(y!=null) el.style.top=Math.round(y-opr.top)+'px';
  }
  function align(kind){
    if(!sels.length) return;
    if(sels.some(isLocked)) return;   // alinear mueve: una capa bloqueada no se mueve
    snap();
    var rects=sels.map(function(el){ return el.getBoundingClientRect(); });
    sels.forEach(promoteAbsolute);
    // 1 elemento → alinear contra el lienzo; 2+ → contra el bounding de la selección.
    var minL,minT,maxR,maxB;
    if(sels.length===1){ minL=0; minT=0; maxR=W; maxB=H; }
    else { rects.forEach(function(r){
      minL=(minL==null?r.left:Math.min(minL,r.left));
      minT=(minT==null?r.top:Math.min(minT,r.top));
      maxR=(maxR==null?r.right:Math.max(maxR,r.right));
      maxB=(maxB==null?r.bottom:Math.max(maxB,r.bottom)); }); }
    var cx=(minL+maxR)/2, cy=(minT+maxB)/2;
    sels.forEach(function(el,i){ var r=rects[i];
      if(kind==='left') moveTo(el,minL,null);
      else if(kind==='hcenter') moveTo(el,cx-r.width/2,null);
      else if(kind==='right') moveTo(el,maxR-r.width,null);
      else if(kind==='top') moveTo(el,null,minT);
      else if(kind==='vcenter') moveTo(el,null,cy-r.height/2);
      else if(kind==='bottom') moveTo(el,null,maxB-r.height); });
    paint(); report(); serialize();
  }
  function distribute(axis){
    if(sels.length<3) return;
    if(sels.some(isLocked)) return;
    snap();
    var items=sels.map(function(el){ return {el:el, r:el.getBoundingClientRect()}; });
    sels.forEach(promoteAbsolute);
    if(axis==='h'){
      items.sort(function(a,b){ return a.r.left-b.r.left; });
      var l0=items[0].r.left, r1=items[items.length-1].r.right, tw=0;
      items.forEach(function(it){ tw+=it.r.width; });
      var gap=(r1-l0-tw)/(items.length-1), x=l0;
      items.forEach(function(it){ moveTo(it.el,x,null); x+=it.r.width+gap; });
    } else {
      items.sort(function(a,b){ return a.r.top-b.r.top; });
      var t0=items[0].r.top, b1=items[items.length-1].r.bottom, th=0;
      items.forEach(function(it){ th+=it.r.height; });
      var gapv=(b1-t0-th)/(items.length-1), y=t0;
      items.forEach(function(it){ moveTo(it.el,null,y); y+=it.r.height+gapv; });
    }
    paint(); report(); serialize();
  }
  // ── capas: reordenar el DOM no alcanza — las láminas traen z-index explícitos
  //    (p.ej. textos con z-index:5) y un posicionado siempre pinta sobre un
  //    estático, así que "al frente/atrás" parecía no hacer nada. En cambio:
  //    capturamos el orden VISUAL actual de los hermanos, movemos el elemento a
  //    la punta que toca y reasignamos z-index secuencial (posicionando lo
  //    estático con relative, que no altera el layout). Sin tocar el DOM. ──────
  // Hermanos "apilables" (excluye UI, textura, script/style) en su ORDEN VISUAL
  //   actual (z-index, y a igualdad, orden del DOM). Base común de front/back y
  //   de los movimientos de una capa a la vez. index 0 = atrás, último = frente.
  function layerChildrenOf(par){
    if(!par) return [];
    var items=[], kids=par.children;
    for(var i=0;i<kids.length;i++){
      var k=kids[i];
      if(k.hasAttribute && k.hasAttribute('data-oc-ui')) continue;
      if(k.hasAttribute && k.hasAttribute('data-oc-tex')) continue;   // la textura vive siempre al fondo
      if(k.hasAttribute && k.hasAttribute('data-oc-owner')) continue;   // capa vinculada a un elemento
      if(k.tagName==='svg' && k.hasAttribute('data-oc-fxdefs')) continue;   // defs de efectos (0x0)
      if(k.tagName==='SCRIPT'||k.tagName==='STYLE'||k.tagName==='LINK') continue;
      var cs=getComputedStyle(k), z;
      if(cs.position==='static') z=-0.5;   // estático: pinta bajo lo posicionado
      else z=(cs.zIndex==='auto') ? 0 : (parseInt(cs.zIndex)||0);
      items.push({el:k, z:z, i:i});
    }
    items.sort(function(a,b){ return (a.z-b.z) || (a.i-b.i); });  // orden visual hoy
    return items.map(function(it){ return it.el; });
  }
  function layerSiblings(el){
    var par=el.parentElement; if(!par) return null;
    return layerChildrenOf(par);
  }
  // ── panel de capas: id estable por elemento (persiste en el HTML serializado),
  //    etiqueta legible, y reporte de la lista al padre para verla/reordenarla. ──
  var ocIdSeq=0;
  function ensureLayerId(el){
    var id=el.getAttribute('data-oc-id');
    if(!id){ id='L'+(++ocIdSeq)+Math.floor(Math.random()*1e6).toString(36); el.setAttribute('data-oc-id',id); }
    return id;
  }
  function isLocked(el){ return !!(el.getAttribute&&el.getAttribute('data-oc-lock')); }
  function isHidden(el){ return !!(el.getAttribute&&el.getAttribute('data-oc-hide')); }
  function layerInfo(el){
    // Nombre puesto a mano en el panel: gana siempre.
    var nm=el.getAttribute&&el.getAttribute('data-oc-name');
    if(el.tagName==='IMG') return {kind:'image', label:nm||'Imagen'};
    if(isSvgRoot(el) || (el.getAttribute && el.getAttribute('data-oc-shape'))) return {kind:'shape', label:nm||'Forma'};
    if(nm) return {kind: isTextEl(el)?'text':'box', label:nm};
    var t=(el.textContent||'').replace(/\s+/g,' ').trim();
    if(t && isTextEl(el)) return {kind:'text', label: t.length>26 ? t.slice(0,26)+'…' : t};
    if(t) return {kind:'box', label: t.length>22 ? t.slice(0,22)+'…' : t};
    return {kind:'box', label:'Elemento'};
  }
  /** ¿Vale abrir este elemento como carpeta de capas? Un texto (con sus <span>) o
   *  una imagen son hojas; un contenedor con elementos adentro sí se expande. */
  function isBranch(el){
    if(el.tagName==='IMG'||isSvgRoot(el)||isTextEl(el)) return false;
    return layerChildrenOf(el).length>0;
  }
  var LAYER_DEPTH=5;
  /**
   * Árbol de capas de un contenedor, FRONT primero. Los grupos (data-oc-g, que son
   * hermanos marcados y no un contenedor del DOM) se reportan como un nodo virtual
   * 'g:<id>' con sus miembros adentro, para poder expandirlos y moverlos como uno.
   */
  function layerTree(par, depth){
    var kids=layerChildrenOf(par), items=[], doneG={};
    for(var i=kids.length-1;i>=0;i--){   // FRONT primero (como un panel de capas)
      var el=kids[i];
      var g=el.getAttribute&&el.getAttribute('data-oc-g');
      if(g){
        if(doneG[g]) continue;
        doneG[g]=1;
        var ms=[];
        for(var j=kids.length-1;j>=0;j--){
          if(kids[j].getAttribute&&kids[j].getAttribute('data-oc-g')===g) ms.push(kids[j]);
        }
        items.push({id:'g:'+g, kind:'group', label:'Grupo · '+ms.length+' elementos',
          selected: ms.every(inSels), locked: ms.every(isLocked), hidden: ms.every(isHidden),
          children: ms.map(function(m){ return layerNode(m, depth+1); })});
        continue;
      }
      items.push(layerNode(el, depth));
    }
    return items;
  }
  function inSels(el){ return sels.indexOf(el)>=0; }
  function layerNode(el, depth){
    var id=ensureLayerId(el), info=layerInfo(el);
    return {id:id, kind:info.kind, label:info.label, selected:inSels(el),
      locked:isLocked(el), hidden:isHidden(el),
      children: (depth<LAYER_DEPTH && isBranch(el)) ? layerTree(el, depth+1) : []};
  }
  function reportLayers(){
    post({oc:'layers', items:layerTree(rootEl()||document.body, 0)});
  }
  /** Elementos de una fila del panel (un id suelto, o los miembros de un grupo
   *  en su orden visual actual: atrás→adelante). */
  function resolveLayer(id){
    if(String(id).indexOf('g:')===0){
      var gid=String(id).slice(2);
      var ms=[].slice.call(document.querySelectorAll('[data-oc-g="'+gid+'"]'));
      if(!ms.length) return [];
      var par=ms[0].parentElement;
      return layerChildrenOf(par).filter(function(k){ return ms.indexOf(k)>=0; });
    }
    var el=document.querySelector('[data-oc-id="'+id+'"]');
    return el?[el]:[];
  }
  function selectLayer(id){
    var els=resolveLayer(id);
    if(!els.length) return;
    // Desde el panel SÍ se puede tomar una capa bloqueada (para desbloquearla).
    if(els.length>1){ sels=els.slice(); paint(); report(); }
    else select(els[0], false, false);
  }
  /** Reordena una fila dentro de su propio nivel (ids FRONT→BACK, como el panel). */
  function reorderLayers(ids){
    if(!ids||ids.length<2) return;
    var order=[];   // front→back, elementos concretos
    ids.forEach(function(id){
      var els=resolveLayer(id);
      for(var i=els.length-1;i>=0;i--) order.push(els[i]);   // grupo: front→back
    });
    if(order.length<2) return;
    // Todos tienen que compartir padre: el arrastre solo reordena dentro del nivel.
    var par=order[0].parentElement;
    order=order.filter(function(el){ return el.parentElement===par; });
    if(order.length<2) return;
    snap();
    applyLayerOrder(order.slice().reverse());   // applyLayerOrder espera BACK→FRONT
    paint(); report(); serialize();
  }
  /** Sube/baja una fila un paso, o la manda del todo al frente/al fondo. */
  function layerMove(id,dir){
    var els=resolveLayer(id);   // back→front
    if(!els.length) return;
    snap();
    var i;
    // El orden de proceso conserva la jerarquía interna del grupo.
    if(dir==='front'){ for(i=0;i<els.length;i++) restack(els[i],true); }
    else if(dir==='back'){ for(i=els.length-1;i>=0;i--) restack(els[i],false); }
    else if(dir==='up'){ for(i=els.length-1;i>=0;i--) restackStep(els[i],1); }
    else if(dir==='down'){ for(i=0;i<els.length;i++) restackStep(els[i],-1); }
    paint(); report(); serialize();
  }
  /**
   * Bloquear u ocultar una capa. Se guardan como atributos, así viajan con la
   * lámina y sobreviven a recargar el editor. Ojo: "oculta" apaga el elemento de
   * verdad (display:none), así que tampoco sale en el export — es lo esperable
   * cuando el HTML de la lámina ES el diseño.
   */
  function layerFlag(id,flag,value){
    var els=resolveLayer(id);
    if(!els.length) return;
    snap();
    els.forEach(function(el){
      if(flag==='lock'){
        if(value) el.setAttribute('data-oc-lock','1'); else el.removeAttribute('data-oc-lock');
      } else {
        if(value){ el.setAttribute('data-oc-hide','1'); el.style.display='none'; }
        else {
          el.removeAttribute('data-oc-hide');
          if(el.style.display==='none') el.style.display='';
        }
      }
    });
    // Bloquear u ocultar lo seleccionado saca la selección: sus handles ya no aplican.
    if(value) sels=sels.filter(function(s){ return els.indexOf(s)<0; });
    paint(); report(); serialize();
  }
  function layerName(id,name){
    var els=resolveLayer(id);
    if(!els.length) return;
    snap();
    var n=String(name||'').trim().slice(0,60);
    els.forEach(function(el){
      if(n) el.setAttribute('data-oc-name',n); else el.removeAttribute('data-oc-name');
    });
    report(); serialize();
  }
  // Reasigna z-index secuencial según el orden dado (posicionando lo estático
  //   con relative, que no altera el layout). Sin tocar el DOM.
  function applyLayerOrder(order){
    order.forEach(function(k,idx){
      if(getComputedStyle(k).position==='static') k.style.position='relative';
      k.style.zIndex=String(idx+1);
    });
  }
  // ── filtro compuesto: sombra (drop-shadow) y desenfoque (blur) conviven en la
  //    misma propiedad CSS 'filter'. Se leen/reescriben juntos para no pisarse. ──
  /**
   * Argumento de una función de 'filter', con paréntesis balanceados.
   *
   * Un regex /drop-shadow\(([^)]*)\)/ corta en el primer ')' — que en
   * 'drop-shadow(rgb(0, 0, 0) 6px 10px 20px)' está DENTRO del rgb(). Chrome
   * serializa cualquier color a rgb()/rgba(), así que tocar el desenfoque después
   * de poner una sombra armaba un filter roto que el navegador descartaba entero:
   * la sombra o el blur "se perdían" sin motivo visible.
   */
  function filterPart(el,name){
    var s=el.style.filter||'', i=s.indexOf(name+'(');
    if(i<0) return '';
    var j=i+name.length+1, depth=1;
    while(j<s.length && depth>0){
      var c=s.charAt(j);
      if(c==='(') depth++;
      else if(c===')') depth--;
      if(depth>0) j++;
    }
    return s.slice(i+name.length+1, j);
  }
  function filterBlur(el){
    var a=filterPart(el,'blur');
    return a?(parseFloat(a)||0):0;
  }
  function fnum(x){ var n=parseFloat(x); return isNaN(n)?0:n; }

  // ── biblioteca de efectos: filtros SVG ───────────────────────────────────────
  // Los efectos viven como <filter> dentro de un <svg> de defs que se SERIALIZA con
  // la lámina: así el preview y el PNG exportado son el mismo render (los dos son
  // Chromium). La configuración activa de cada elemento va en data-oc-fx (JSON), y
  // 'filter' se recompone entero cada vez — sombra, desenfoque y efectos comparten
  // esa única propiedad CSS, y pisarse era exactamente el bug de la Fase 6.
  var SVGNS='http://www.w3.org/2000/svg';
  /** Contenedor de defs (0x0, invisible), como primer hijo de la raíz de la lámina. */
  function fxDefs(){
    var svg=document.querySelector('svg[data-oc-fxdefs]');
    if(!svg){
      var host=rootEl()||document.body;
      svg=document.createElementNS(SVGNS,'svg');
      svg.setAttribute('data-oc-fxdefs','1');
      svg.setAttribute('aria-hidden','true');
      svg.setAttribute('width','0'); svg.setAttribute('height','0');
      svg.style.cssText='position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none';
      host.insertBefore(svg, host.firstChild);
    }
    return svg;
  }
  function fxConfig(el){
    try{ var o=JSON.parse(el.getAttribute('data-oc-fx')||'{}'); return (o&&typeof o==='object')?o:{}; }
    catch(e){ return {}; }
  }
  function hex01(h){
    var m=String(h||'').replace('#','');
    if(m.length===3) m=m.charAt(0)+m.charAt(0)+m.charAt(1)+m.charAt(1)+m.charAt(2)+m.charAt(2);
    var n=parseInt(m,16); if(isNaN(n)) return [0,0,0];
    return [((n>>16)&255)/255, ((n>>8)&255)/255, (n&255)/255];
  }
  /** Intensidad 0..100 → 0..1 (los efectos guardan {i:…} o un número suelto). */
  function fxAmt(v){
    var n = (v!=null && typeof v==='object') ? v.i : v;
    return Math.max(0,Math.min(100,Number(n)||0))/100;
  }
  /**
   * Primitivas de cada efecto. La región agranda el área del filtro para los que
   * derraman fuera de la caja (desplazan o difuminan); sin eso, Chromium recorta.
   */
  function fxDef(kind,v){
    var t=fxAmt(v), s;
    if(kind==='grain'||kind==='noise'){
      var esGrano=(kind==='grain');
      var freq=esGrano?0.85:0.32, oct=esGrano?3:2, amt=(esGrano?0.10+t*0.5:0.15+t*0.75).toFixed(3);
      return {region:null, inner:
        '<feTurbulence type="'+(esGrano?'fractalNoise':'turbulence')+'" baseFrequency="'+freq+'" numOctaves="'+oct+'" seed="'+(esGrano?9:4)+'" result="n"/>'
        +'<feColorMatrix in="n" type="saturate" values="0" result="g"/>'
        +'<feComponentTransfer in="g" result="gg"><feFuncA type="table" tableValues="0 '+amt+'"/></feComponentTransfer>'
        +'<feBlend in="SourceGraphic" in2="gg" mode="'+(esGrano?'overlay':'soft-light')+'" result="b"/>'
        // Recortar a la silueta real: sin esto el ruido pinta toda la caja, también
        // donde el PNG es transparente.
        +'<feComposite in="b" in2="SourceGraphic" operator="in"/>'};
    }
    if(kind==='duotone'){
      var a=hex01((v&&v.a)||'#15142B'), b=hex01((v&&v.b)||'#EBFF6F');
      return {region:null, inner:
        '<feColorMatrix type="matrix" values="0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0 0 0 1 0" result="gr"/>'
        +'<feComponentTransfer in="gr" result="duo">'
        +'<feFuncR type="table" tableValues="'+a[0].toFixed(3)+' '+b[0].toFixed(3)+'"/>'
        +'<feFuncG type="table" tableValues="'+a[1].toFixed(3)+' '+b[1].toFixed(3)+'"/>'
        +'<feFuncB type="table" tableValues="'+a[2].toFixed(3)+' '+b[2].toFixed(3)+'"/>'
        +'</feComponentTransfer>'
        // Mezcla con el original según la intensidad (100% = duotono puro).
        +'<feComposite in="duo" in2="SourceGraphic" operator="arithmetic" k1="0" k2="'+t.toFixed(3)+'" k3="'+(1-t).toFixed(3)+'" k4="0"/>'};
    }
    if(kind==='chromatic'){
      var d=(t*16).toFixed(1);
      return {region:{x:'-10%',y:'-10%',w:'120%',h:'120%'}, inner:
        '<feOffset in="SourceGraphic" dx="-'+d+'" dy="0" result="lo"/>'
        +'<feColorMatrix in="lo" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="rc"/>'
        +'<feOffset in="SourceGraphic" dx="'+d+'" dy="0" result="ro"/>'
        +'<feColorMatrix in="ro" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="bc"/>'
        +'<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="gc"/>'
        +'<feBlend in="rc" in2="gc" mode="screen" result="m1"/>'
        +'<feBlend in="m1" in2="bc" mode="screen"/>'};
    }
    if(kind==='emboss'){
      s=0.4+t*3.2;
      var k=[-2*s,-s,0,-s,1,s,0,s,2*s].map(function(x){ return (Math.round(x*100)/100); }).join(' ');
      return {region:null, inner:
        '<feConvolveMatrix order="3" preserveAlpha="true" divisor="1" kernelMatrix="'+k+'"/>'};
    }
    if(kind==='bevel'){
      var sd=(0.4+t*4).toFixed(2), ss=(1+t*7).toFixed(2);
      return {region:null, inner:
        '<feGaussianBlur in="SourceAlpha" stdDeviation="'+sd+'" result="bl"/>'
        +'<feSpecularLighting in="bl" surfaceScale="'+ss+'" specularConstant="1" specularExponent="18" lighting-color="#ffffff" result="sp">'
        +'<feDistantLight azimuth="225" elevation="55"/></feSpecularLighting>'
        +'<feComposite in="sp" in2="SourceAlpha" operator="in" result="spc"/>'
        +'<feComposite in="SourceGraphic" in2="spc" operator="arithmetic" k1="0" k2="1" k3="1" k4="0"/>'};
    }
    if(kind==='motion'){
      return {region:{x:'-15%',y:'-15%',w:'130%',h:'130%'}, inner:
        // Difuminado en un solo eje = barrido. El giro del elemento se aplica DESPUÉS
        // del filtro, así que rotarlo also rota la dirección del barrido.
        '<feGaussianBlur stdDeviation="'+(t*32).toFixed(1)+' 0"/>'};
    }
    if(kind==='distort'){
      return {region:{x:'-10%',y:'-10%',w:'120%',h:'120%'}, inner:
        '<feTurbulence type="turbulence" baseFrequency="'+(0.006+t*0.045).toFixed(4)+'" numOctaves="2" seed="3" result="tb"/>'
        +'<feDisplacementMap in="SourceGraphic" in2="tb" scale="'+(t*70).toFixed(1)+'" xChannelSelector="R" yChannelSelector="G"/>'};
    }
    return null;
  }
  var FX_ORDER=['duotone','emboss','bevel','distort','chromatic','motion','grain','noise'];
  /** Crea o reemplaza el <filter> de un efecto y devuelve su id. */
  function fxFilter(el,ownerId,kind,v){
    var def=fxDef(kind,v); if(!def) return null;
    var fid='ocfx-'+ownerId+'-'+kind;
    var f=document.getElementById(fid);
    if(!f){
      f=document.createElementNS(SVGNS,'filter');
      f.setAttribute('id',fid);
      fxDefs().appendChild(f);
    }
    f.setAttribute('color-interpolation-filters','sRGB');
    if(def.region){
      f.setAttribute('x',def.region.x); f.setAttribute('y',def.region.y);
      f.setAttribute('width',def.region.w); f.setAttribute('height',def.region.h);
    } else {
      f.removeAttribute('x'); f.removeAttribute('y');
      f.removeAttribute('width'); f.removeAttribute('height');
    }
    f.innerHTML=def.inner;
    return fid;
  }
  /**
   * Recompone la propiedad 'filter' completa: sombra + desenfoque + cada efecto
   * activo, en un orden estable. Es el único lugar que escribe el.style.filter.
   */
  function rebuildFilter(el, dropStr, blurPx){
    var parts=[];
    if(dropStr) parts.push('drop-shadow('+dropStr+')');
    if(blurPx>0) parts.push('blur('+blurPx+'px)');
    var cfg=fxConfig(el), activos={}, tiene=Object.keys(cfg).length>0;
    var oid=tiene ? ensureLayerId(el) : (el.getAttribute&&el.getAttribute('data-oc-id'));
    if(tiene){
      FX_ORDER.forEach(function(k){
        if(cfg[k]==null) return;
        var fid=fxFilter(el,oid,k,cfg[k]);
        if(fid){ activos[k]=1; parts.push('url(#'+fid+')'); }
      });
    }
    // La poda corre SIEMPRE, también cuando se apagó el último efecto: si no, ese
    // <filter> queda colgado en las defs y se serializa con la lámina para siempre.
    if(oid){
      var mine=document.querySelectorAll('filter[id^="ocfx-'+oid+'-"]');
      for(var i=0;i<mine.length;i++){
        var kk=mine[i].id.slice(('ocfx-'+oid+'-').length);
        if(!activos[kk]) mine[i].remove();
      }
      // Sin defs adentro, el <svg> contenedor tampoco tiene por qué quedar.
      var dr=document.querySelector('svg[data-oc-fxdefs]');
      if(dr && !dr.children.length) dr.remove();
    }
    el.style.filter=parts.join(' ');
  }
  /** Compatibilidad: sombra y desenfoque siguen entrando por acá. */
  function composeFilter(el, dropStr, blurPx){ rebuildFilter(el, dropStr, blurPx); }
  /** Prende, ajusta o apaga (valor null) un efecto de filtro del elemento. */
  function setFx(el,kind,v){
    var cfg=fxConfig(el);
    if(v==null || fxAmt(v)===0) delete cfg[kind];
    else cfg[kind]=v;
    if(Object.keys(cfg).length) el.setAttribute('data-oc-fx', JSON.stringify(cfg));
    else el.removeAttribute('data-oc-fx');
    rebuildFilter(el, filterPart(el,'drop-shadow'), filterBlur(el));
  }

  // ── capas de superficie: material, vidrio, desenfoque radial, CRT ────────────
  // Van como capa vinculada ENCIMA del elemento (misma mecánica que la sombra de
  // puntos, así quedan pegadas a él en cualquier operación).
  function fxLayerOf(el,kind){
    var id=el.getAttribute&&el.getAttribute('data-oc-id');
    if(!id) return null;
    return document.querySelector('[data-oc-owner="'+id+'"][data-oc-fxkind="'+kind+'"]');
  }
  function setFxLayer(el,kind,css){
    var lay=fxLayerOf(el,kind);
    if(!css){ if(lay) lay.remove(); return; }
    if(!lay){
      var id=ensureLayerId(el);
      lay=document.createElement('div');
      lay.setAttribute('data-oc-owner',id);
      lay.setAttribute('data-oc-role','fx');
      lay.setAttribute('data-oc-fxkind',kind);
      makeRelative(el);
      // Después del elemento en el DOM y con su mismo z-index → pinta encima.
      el.parentElement.insertBefore(lay, el.nextSibling);
    }
    lay.style.cssText='position:absolute;left:0;top:0;pointer-events:none;'+css;
    syncLinked();
  }
  /** CSS de cada superficie. t = intensidad 0..1. */
  function fxSurface(kind,v){
    var t=fxAmt(v);
    if(kind==='material'){
      var slug=(v&&v.slug)||'granulado';
      return "background-image:url('"+(v&&v.base||'')+"/textures/"+slug+".png');background-size:cover;background-position:center"
        +';mix-blend-mode:overlay;opacity:'+(0.25+t*0.75).toFixed(2);
    }
    if(kind==='frost'){
      // Vidrio escarchado real: difumina lo que hay DETRÁS de la capa (o sea, el
      // propio elemento) en vez de superponer una textura.
      var fb=(2+t*22).toFixed(1);
      return 'backdrop-filter:blur('+fb+'px) saturate(1.15);-webkit-backdrop-filter:blur('+fb+'px) saturate(1.15)'
        +';background:rgba(255,255,255,'+(0.04+t*0.16).toFixed(3)+')';
    }
    if(kind==='radial'){
      // Desenfoque radial: el centro queda nítido y el borde se va difuminando.
      // Se logra con el mismo backdrop-filter, enmascarado con un degradado radial.
      var rb=(2+t*26).toFixed(1);
      var mask='radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 30%, rgba(0,0,0,1) 88%)';
      return 'backdrop-filter:blur('+rb+'px);-webkit-backdrop-filter:blur('+rb+'px)'
        +';mask-image:'+mask+';-webkit-mask-image:'+mask;
    }
    if(kind==='crt'){
      var op=(0.12+t*0.5).toFixed(3), paso=Math.max(3,Math.round(3+t*5));
      return 'background-image:repeating-linear-gradient(0deg, rgba(0,0,0,'+op+') 0px, rgba(0,0,0,'+op+') 1px, rgba(0,0,0,0) 1px, rgba(0,0,0,0) '+paso+'px)'
        +',linear-gradient(90deg, rgba(255,0,64,.10), rgba(0,255,255,.10))'
        +';mix-blend-mode:multiply';
    }
    return '';
  }

  // ── sombras vinculadas al objeto ─────────────────────────────────────────────
  // La sombra de puntos es un elemento real (una capa halftone detrás), así que
  // antes se quedaba donde estaba: mover, redimensionar, rotar o reemplazar la
  // imagen la dejaba huérfana. Ahora la capa declara a su dueño en
  // data-oc-owner y syncLinked() la vuelve a calzar después de CUALQUIER
  // operación — corre dentro de serialize(), que es el paso común a todas, y en
  // cada frame del arrastre para que se vea pegada en vivo.
  function dotsOf(el){
    var id=el.getAttribute&&el.getAttribute('data-oc-id');
    if(!id) return null;
    return document.querySelector('[data-oc-owner="'+id+'"][data-oc-role="dots"]');
  }
  function removeDots(el){
    var d=dotsOf(el);
    while(d){ d.remove(); d=dotsOf(el); }
  }
  function syncLinked(){
    var list=document.querySelectorAll('[data-oc-owner]');
    if(!list.length) return;
    for(var i=0;i<list.length;i++){
      var sh=list[i];
      var own=document.querySelector('[data-oc-id="'+sh.getAttribute('data-oc-owner')+'"]');
      if(!own){ sh.remove(); continue; }        // el dueño se borró: la sombra también
      var ocs=getComputedStyle(own);
      if(isHidden(own)||ocs.display==='none'){ sh.style.display='none'; continue; }
      sh.style.display='';
      var orr=layoutRect(own);
      sh.style.width=Math.round(orr.width)+'px';
      sh.style.height=Math.round(orr.height)+'px';
      sh.style.borderRadius=ocs.borderRadius;
      sh.style.rotate=own.style.rotate||'';
      sh.style.zIndex=own.style.zIndex||'';
      var ox=fnum(sh.getAttribute('data-oc-ox')), oy=fnum(sh.getAttribute('data-oc-oy'));
      // El left/top se corrige contra el ancestro posicionado REAL (medido después
      // de fijar el tamaño, que puede cambiar el rect).
      var sr=sh.getBoundingClientRect();
      sh.style.left=Math.round(fnum(sh.style.left)+(orr.left-sr.left)+ox)+'px';
      sh.style.top=Math.round(fnum(sh.style.top)+(orr.top-sr.top)+oy)+'px';
    }
  }
  /**
   * Pasa un elemento estático a relative sin moverlo.
   *
   * Un top/left declarado en una hoja no hace NADA mientras el elemento es
   * static, pero empieza a aplicarse al pasarlo a relative: poner una sombra le
   * movía el elemento solo. Se neutralizan los cuatro desplazamientos.
   */
  function makeRelative(el){
    if(getComputedStyle(el).position!=='static') return;
    el.style.position='relative';
    el.style.left='0px'; el.style.top='0px';
    el.style.right='auto'; el.style.bottom='auto';
  }
  /** Capa de puntos halftone detrás del elemento, vinculada a él. */
  function addDots(el,ox,oy,color){
    var id=ensureLayerId(el);
    removeDots(el);
    makeRelative(el);
    var dd=document.createElement('div');
    dd.setAttribute('data-oc-dots','1');
    dd.setAttribute('data-oc-owner', id);
    dd.setAttribute('data-oc-role','dots');
    dd.setAttribute('data-oc-ox', String(ox));
    dd.setAttribute('data-oc-oy', String(oy));
    dd.style.cssText='position:absolute;left:0;top:0;width:10px;height:10px;pointer-events:none'
      +';background-image:radial-gradient(circle, '+color+' 2.6px, transparent 3px);background-size:16px 16px';
    el.parentElement.insertBefore(dd, el);
    syncLinked();
  }
  // "Al frente / al fondo" DE VERDAD: reordenar entre los hermanos del padre
  //   inmediato no alcanza cuando el elemento vive dentro de un contenedor —
  //   quedaba adelante de sus hermanos pero seguía tapado por el contenedor de al
  //   lado, y parecía que el botón "no hacía nada" o movía una sola posición.
  //   Se recorre la cadena de ancestros hasta la raíz llevando cada eslabón a la
  //   punta que toca: así la rama entera queda arriba (o abajo) de todo.
  function restack(el,toFront){
    var par=el.parentElement; if(!par) return;
    if(el.ownerSVGElement){
      // Dentro de un svg no hay z-index: manda el orden del DOM.
      if(toFront) par.appendChild(el);
      else par.insertBefore(el, par.firstElementChild);
      return;
    }
    var root=rootEl(), node=el, guard=0;
    while(node && node.parentElement && guard++<24){
      var p=node.parentElement;
      var order=layerChildrenOf(p);
      if(order.length>1){
        var rest=order.filter(function(k){ return k!==node; });
        applyLayerOrder(toFront ? rest.concat([node]) : [node].concat(rest));
      }
      if(p===root||p===document.body) break;
      node=p;
    }
  }
  // Mueve el elemento UNA capa: dir>0 lo sube (hacia el frente), dir<0 lo baja.
  //   Intercambia con el vecino inmediato en el orden visual; si ya está en la
  //   punta, no hace nada.
  function restackStep(el,dir){
    var par=el.parentElement; if(!par) return;
    if(el.ownerSVGElement){
      // Dentro de un svg el orden del DOM es el orden de pintado.
      var sib = dir>0 ? el.nextElementSibling : el.previousElementSibling;
      if(!sib) return;
      if(dir>0) par.insertBefore(sib, el); else par.insertBefore(el, sib);
      return;
    }
    var order=layerSiblings(el); if(!order) return;
    var idx=order.indexOf(el); if(idx<0) return;
    var j=idx+(dir>0?1:-1);
    if(j<0||j>=order.length) return;   // ya en la punta
    order[idx]=order[j]; order[j]=el;  // swap con el vecino inmediato
    applyLayerOrder(order);
  }
  // ── editar el texto SIN perder el formato por tramos ─────────────────────────
  // El campo de texto del panel reescribía el innerHTML completo en cada tecla, así
  // que cualquier palabra en negrita o en otro color se borraba al tocar el texto:
  // el formato parcial "a veces no funcionaba" porque se lo comía la propia edición.
  // Ahora se calcula el tramo que cambió (prefijo y sufijo comunes) y se aplica solo
  // ese tramo sobre los nodos de texto, dejando los <span> en su lugar.
  function plainText(el){
    var out='', w=document.createTreeWalker(el, NodeFilter.SHOW_TEXT|NodeFilter.SHOW_ELEMENT, null), n;
    while((n=w.nextNode())){
      if(n.nodeType===3) out+=n.nodeValue;
      else if(n.tagName==='BR') out+='\n';
    }
    return out;
  }
  function setTextFlat(el,next){
    el.innerHTML=String(next).split('\n').map(esc).join('<br>');
  }
  function setText(el,next){
    next=String(next);
    var cur=plainText(el);
    if(cur===next) return;
    // Sin formato interno: el camino directo es exacto y más barato.
    if(!hasFormat(el)){ setTextFlat(el,next); return; }
    var p=0, la=cur.length, lb=next.length;
    while(p<la&&p<lb&&cur.charAt(p)===next.charAt(p)) p++;
    var ea=la, eb=lb;
    while(ea>p&&eb>p&&cur.charAt(ea-1)===next.charAt(eb-1)){ ea--; eb--; }
    var ins=next.slice(p,eb), del=cur.slice(p,ea);
    // Los saltos de línea son <br> (no texto): si el cambio los toca, se rehace plano.
    if(ins.indexOf('\n')>=0||del.indexOf('\n')>=0){ setTextFlat(el,next); return; }
    // Índices absolutos de cada nodo de texto, medidos ANTES de mutar.
    var nodes=[], idx=0;
    var w=document.createTreeWalker(el, NodeFilter.SHOW_TEXT|NodeFilter.SHOW_ELEMENT, null), n;
    while((n=w.nextNode())){
      if(n.nodeType===3){ nodes.push({n:n, start:idx, len:n.nodeValue.length}); idx+=n.nodeValue.length; }
      else if(n.tagName==='BR') idx+=1;
    }
    if(!nodes.length){ setTextFlat(el,next); return; }
    var placed=false;
    for(var i=0;i<nodes.length;i++){
      var nd=nodes[i], s=Math.max(p,nd.start), e=Math.min(ea,nd.start+nd.len);
      if(e<=s) continue;                       // este nodo no cae en el tramo borrado
      var v=nd.n.nodeValue, lo=s-nd.start;
      nd.n.nodeValue=v.slice(0,lo)+(placed?'':ins)+v.slice(lo+(e-s));
      placed=true;
    }
    if(!placed && ins){                        // inserción pura: no se borró nada
      for(var j=0;j<nodes.length;j++){
        var nj=nodes[j];
        if(p>=nj.start && p<=nj.start+nj.len){
          var vj=nj.n.nodeValue, lj=p-nj.start;
          nj.n.nodeValue=vj.slice(0,lj)+ins+vj.slice(lj);
          placed=true; break;
        }
      }
      if(!placed){                             // al final del último nodo
        var last=nodes[nodes.length-1];
        last.n.nodeValue=last.n.nodeValue+ins;
      }
    }
  }
  /**
   * Fondo de la CAJA de texto. Un texto suele venir dentro de un contenedor que
   * lleva el color; "sin fondo" sobre el texto no cambiaba nada visible y parecía
   * roto. Devuelve ese contenedor cuando abraza al texto (no un panel gigante).
   */
  function bgAncestor(el){
    var node=el.parentElement, root=rootEl(), guard=0;
    var er=el.getBoundingClientRect(), area=Math.max(1,er.width*er.height);
    while(node && node!==root && node!==document.body && guard++<4){
      var cs=getComputedStyle(node);
      var painted=(cs.backgroundColor&&cs.backgroundColor!=='rgba(0, 0, 0, 0)'&&cs.backgroundColor!=='transparent')
        || cs.backgroundImage!=='none';
      if(painted){
        var r=node.getBoundingClientRect();
        return (r.width*r.height<=area*2.6 && !tooBig(node)) ? node : null;
      }
      node=node.parentElement;
    }
    return null;
  }
  /** Saca el formato de un tramo marcado, o de todo el texto si no hay tramo. */
  function clearFormat(el){
    var host=rangeHost();
    if(host && host!==el && (host.getAttribute('data-oc-rs')||INLINE_TAGS[host.tagName])){
      unwrap(host); savedRange=null; return;
    }
    // Todos los inline de formato, no solo los <span> que pone el editor: el
    // formato parcial también llega como <strong>/<em> en el HTML de la lámina.
    [].slice.call(el.querySelectorAll(FMT_SEL)).forEach(unwrap);
    ['fontWeight','fontStyle','color','fontFamily','fontSize','letterSpacing',
     'textDecoration','textShadow','webkitTextStroke','webkitTextFillColor']
      .forEach(function(k){ el.style[k]=''; });
    savedRange=null;
  }
  function unwrap(node){
    var par=node.parentNode; if(!par) return;
    while(node.firstChild) par.insertBefore(node.firstChild, node);
    par.removeChild(node);
    par.normalize();
  }

  // Lados de una caja CSS: nombre que manda el panel → sufijo del longhand.
  var BOX_SIDES=[['top','Top'],['right','Right'],['bottom','Bottom'],['left','Left']];

  // Estilos "puros" que sirven igual sobre el elemento completo o sobre un <span>
  // de tramo (selección parcial). Los props estructurales (text, splitBg, x/y/w/h,
  // capas, remove) siguen viviendo en apply().
  function styleEl(el,p,v){
    if(p==='fontFamily'){ el.style.fontFamily="'"+v+"'"; ensureFont(v); }
    else if(p==='fontSize'){ el.style.fontSize=v+'px'; }
    else if(p==='color'){ el.style.color=v; }
    else if(p==='bg'){
      // svg raíz: el fill de las formas es fill:currentColor → recolorear = color.
      // Si tenía degradado, volver a sólido = restaurar currentColor y sacar defs.
      // Sombra de puntos: recolorear reconstruye el patrón (background lo pisaría).
      if(isSvgRoot(el)){
        if(el.getAttribute('data-oc-grad')){
          el.removeAttribute('data-oc-grad');
          var od=el.querySelector('defs[data-oc-defs]'); if(od) od.remove();
          [].slice.call(el.children).forEach(function(k){
            if(k.tagName.toLowerCase()!=='defs') k.setAttribute('fill','currentColor');
          });
        }
        el.style.color=v;
      }
      else if(el.getAttribute&&el.getAttribute('data-oc-dots')){
        el.style.backgroundImage='radial-gradient(circle, '+v+' 2.6px, transparent 3px)';
      }
      else el.style.background=v;
    }
    else if(p==='bold'){ el.style.fontWeight=v?'700':'400'; }
    else if(p==='fontWeight'){ el.style.fontWeight=String(v); }
    else if(p==='italic'){ el.style.fontStyle=v?'italic':'normal'; }
    else if(p==='align'){ el.style.textAlign=v; }
    else if(p==='opacity'){ el.style.opacity=(v/100); }
    else if(p==='rotate'){ prepSvgRotate(el); el.style.rotate=((parseFloat(v)||0)%360+360)%360+'deg'; }
    else if(p==='radius'){ el.style.borderRadius=v+'px'; }
    // ── márgenes de la caja: relleno interno y margen externo ────────────────────
    // v = {side:'top'|'right'|'bottom'|'left'|'all', px:number}. Se escriben los
    // longhand (paddingTop…) y no el shorthand, para poder tocar un lado sin
    // pisar los otros tres — y porque promoteAbsolute deja un 'margin:0' inline
    // que el shorthand volvería a barrer entero.
    else if(p==='padding'||p==='margin'){
      // Un <svg> raíz no tiene caja de relleno útil (el contenido lo gobierna el
      // viewBox), y moverlo por margen ya es trabajo de X/Y.
      if(isSvgRoot(el)) return;
      var bxs=BOX_SIDES, bsd=(v&&v.side)||'all', bpx=Math.round(parseFloat(v&&v.px)||0);
      if(p==='padding') bpx=Math.max(0,bpx);   // el relleno negativo no existe en CSS
      for(var bi=0;bi<bxs.length;bi++){
        if(bsd==='all'||bsd===bxs[bi][0]) el.style[p+bxs[bi][1]]=bpx+'px';
      }
    }
    // ── encaje de una imagen dentro de su caja ──────────────────────────────────
    // 'auto' vuelve al alto natural (la caja sigue a la proporción de la foto);
    // cover/contain/fill necesitan un alto explícito para tener sentido, así que se
    // hornea el actual — sin cambio visual, pero desde ahí el encaje manda.
    else if(p==='fit'){
      if(v==='auto'){ el.style.objectFit=''; el.style.height='auto'; }
      else {
        if(!parseFloat(el.style.height)) el.style.height=Math.round(layoutRect(el).height)+'px';
        el.style.objectFit=v;
      }
    }
    // Encuadre de la foto dentro de su caja: el mismo % que mueve el arrastre
    // dentro de un marco, acá desde los deslizadores del panel.
    else if(p==='pan'){
      if(el.tagName!=='IMG') return;
      var pp=panPos(el);
      setPan(el, v&&v.x!=null?v.x:pp[0], v&&v.y!=null?v.y:pp[1]);
    }
    else if(p==='letterSpacing'){ el.style.letterSpacing=v+'px'; }
    // line-height negativo es inválido en CSS y el navegador lo ignoraría en
    // silencio: se aplica con piso en 0 (= líneas totalmente colapsadas).
    else if(p==='lineHeight'){ el.style.lineHeight=Math.max(0,parseFloat(v)||0); }
    // ── borde/trazo unificado: divs e imágenes van por border, las líneas solo por
    //    border-top (si no, los otros 3 lados aparecen con 3px "medium"), y los svg
    //    raíz por stroke (que en SVG hereda del raíz a las formas hijas). ──────────
    else if(p==='borderW'){
      var bw=Math.max(0,parseFloat(v)||0);
      if(isSvgRoot(el)){ el.style.strokeWidth=String(bw); if(bw&&getComputedStyle(el).stroke==='none') el.style.stroke='#111827'; }
      else if(el.getAttribute&&el.getAttribute('data-oc-line')){ el.style.borderTopWidth=bw+'px'; }
      else { el.style.borderWidth=bw+'px'; if(bw&&getComputedStyle(el).borderTopStyle==='none') el.style.borderStyle='solid'; }
    }
    else if(p==='borderStyle'){ // solid | dashed | dotted | none
      if(isSvgRoot(el)){
        if(v==='none'){ el.style.stroke='none'; }
        else {
          el.style.strokeDasharray = v==='dashed' ? '14 10' : (v==='dotted' ? '2 8' : 'none');
          if(getComputedStyle(el).stroke==='none') el.style.stroke='#111827';
          if(!parseFloat(el.style.strokeWidth)) el.style.strokeWidth='6';
        }
      }
      else if(el.getAttribute&&el.getAttribute('data-oc-line')){ el.style.borderTopStyle=v; }
      else {
        el.style.borderStyle=v;
        if(v!=='none' && !(parseFloat(getComputedStyle(el).borderTopWidth)||0)) el.style.borderWidth='4px';
      }
    }
    else if(p==='borderColor'){
      if(isSvgRoot(el)) el.style.stroke=v;
      else if(el.getAttribute&&el.getAttribute('data-oc-line')) el.style.borderTopColor=v;
      else el.style.borderColor=v;
    }
    // ── sombras: presets 100% CSS. En IMG (con transparencia) y formas svg usamos
    //    drop-shadow (sigue la silueta real); en cajas/texto, box-shadow. 'float'
    //    despega el elemento — se ve "más arriba" del fondo. 'dots' inserta una capa
    //    de puntos halftone DETRÁS (elemento real: se mueve/recolorea/borra solo). ──
    else if(p==='shadow'){
      // Preservamos un blur existente: sombra y desenfoque comparten 'filter'.
      var keepBlur=filterBlur(el);
      el.style.boxShadow=''; composeFilter(el, '', keepBlur);
      // Cambiar de sombra nunca acumula capas: la de puntos anterior se va.
      if(v!=='dots') removeDots(el);
      if(v==='dots'){ addDots(el, 18, 18, '#111827'); }
      else {
        var box={soft:'0 6px 18px rgba(0,0,0,.20)', medium:'0 12px 30px rgba(0,0,0,.28)', strong:'0 22px 48px rgba(0,0,0,.40)', float:'0 30px 46px -18px rgba(0,0,0,.45)'};
        var drop={soft:'0 6px 10px rgba(0,0,0,.28)', medium:'0 12px 18px rgba(0,0,0,.32)', strong:'0 20px 28px rgba(0,0,0,.42)', float:'0 26px 22px rgba(0,0,0,.38)'};
        if(box[v]){
          if(el.tagName==='IMG'||isSvgRoot(el)) composeFilter(el, drop[v], keepBlur);
          else el.style.boxShadow=box[v];
        } // 'none' deja todo reseteado
      }
    }
    // ── sombra a medida: desplazamiento, difusión, expansión y color ────────────
    // El brillo (interior o exterior) es esta misma sombra con desplazamiento 0.
    // En imágenes y formas svg va por drop-shadow, que sigue la silueta real y
    // respeta la transparencia; en cajas y texto por box-shadow, que además admite
    // expansión (spread) y la variante interior.
    else if(p==='shadowCustom'){
      var sx=fnum(v.x), sy=fnum(v.y), sb=Math.max(0,fnum(v.blur)), ss=fnum(v.spread);
      var scol=v.color||'rgba(0,0,0,.35)';
      var dots=dotsOf(el);
      if(dots){
        // Con la sombra de puntos activa, los controles gobiernan esa capa.
        dots.setAttribute('data-oc-ox', String(sx));
        dots.setAttribute('data-oc-oy', String(sy));
        dots.style.backgroundImage='radial-gradient(circle, '+scol+' 2.6px, transparent 3px)';
        syncLinked();
      } else {
        var kb=filterBlur(el);
        if(v.inner){
          // 'inset' no existe en drop-shadow: la sombra/brillo interior es
          // siempre box-shadow (en una imagen se ve sobre la foto).
          el.style.boxShadow='inset '+sx+'px '+sy+'px '+sb+'px '+ss+'px '+scol;
          composeFilter(el, '', kb);
        } else if(el.tagName==='IMG'||isSvgRoot(el)){
          el.style.boxShadow='';
          composeFilter(el, sx+'px '+sy+'px '+sb+'px '+scol, kb);   // drop-shadow no tiene spread
        } else {
          el.style.boxShadow=sx+'px '+sy+'px '+sb+'px '+ss+'px '+scol;
          composeFilter(el, '', kb);
        }
      }
    }
    // ── desenfoque gaussiano del elemento: comparte 'filter' con el drop-shadow,
    //    así que preservamos la sombra al ajustar el blur y viceversa. 0 = nítido. ──
    else if(p==='blur'){
      composeFilter(el, filterPart(el,'drop-shadow'), Math.max(0,parseFloat(v)||0));
    }
    // ── degradado como relleno: en divs/texto va directo al background; en un svg
    //    raíz inyectamos <defs><linearGradient> y apuntamos el fill de las formas. ──
    else if(p==='gradient'){
      var ga=((parseFloat(v.angle)||0)%360+360)%360, gf=v.from||'#4f7cff', gt=v.to||'#ff3b7f';
      if(isSvgRoot(el)){
        var gid=el.getAttribute('data-oc-grad');
        if(!gid){ gid='ocg'+Math.floor(Math.random()*1e9).toString(36); el.setAttribute('data-oc-grad',gid); }
        var old=el.querySelector('defs[data-oc-defs]'); if(old) old.remove();
        var NS='http://www.w3.org/2000/svg';
        var defs=document.createElementNS(NS,'defs'); defs.setAttribute('data-oc-defs','1');
        var lg=document.createElementNS(NS,'linearGradient');
        lg.setAttribute('id',gid);
        lg.setAttribute('x1','0'); lg.setAttribute('y1','0'); lg.setAttribute('x2','1'); lg.setAttribute('y2','0');
        // CSS: 0deg apunta arriba y 90deg a la derecha; el vector base ya es 90deg
        lg.setAttribute('gradientTransform','rotate('+(ga-90)+', 0.5, 0.5)');
        var s1=document.createElementNS(NS,'stop'); s1.setAttribute('offset','0'); s1.setAttribute('stop-color',gf);
        var s2=document.createElementNS(NS,'stop'); s2.setAttribute('offset','1'); s2.setAttribute('stop-color',gt);
        lg.appendChild(s1); lg.appendChild(s2); defs.appendChild(lg);
        el.insertBefore(defs, el.firstChild);
        [].slice.call(el.children).forEach(function(k){
          if(k.tagName.toLowerCase()!=='defs') k.setAttribute('fill','url(#'+gid+')');
        });
      } else {
        el.style.background='linear-gradient('+ga+'deg, '+gf+', '+gt+')';
      }
    }
    else if(p==='textEffect'){
      // Efectos 100% CSS (render idéntico en preview y export, ambos Chromium).
      // Reseteamos siempre primero para que cambiar de efecto no acumule capas.
      var col=getComputedStyle(el).color;
      el.style.textShadow=''; el.style.webkitTextStroke=''; el.style.webkitTextFillColor='';
      if(v==='shadow'){ el.style.textShadow='3px 4px 8px rgba(0,0,0,.35)'; }
      else if(v==='neon'){ el.style.textShadow='0 0 5px '+col+',0 0 15px '+col+',0 0 32px '+col; }
      else if(v==='outline'){ el.style.webkitTextStroke='2px '+col; }
      else if(v==='hollow'){ el.style.webkitTextStroke='2px '+col; el.style.webkitTextFillColor='transparent'; }
      // 'none' deja todo reseteado
    }
    // ── mayúsculas/minúsculas: transformamos el CONTENIDO (no text-transform CSS)
    //    porque "sentence" (solo la inicial en mayúscula) no existe en CSS. El
    //    TreeWalker respeta los <span>/<strong> internos: solo toca nodos de texto.
    //    textTransform:'none' anula un uppercase que la lámina traiga por CSS. ────
    else if(p==='textCase'){ // upper | lower | sentence
      el.style.textTransform='none';
      var needCap=(v==='sentence');
      var tw=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null), tn;
      while((tn=tw.nextNode())){
        var s=tn.nodeValue;
        if(v==='upper'){ tn.nodeValue=s.toUpperCase(); continue; }
        s=s.toLowerCase();
        if(needCap){ // primera LETRA de todo el elemento (saltando espacios/signos)
          var mm=s.match(/[a-zà-öø-ÿñ]/);
          if(mm){ s=s.slice(0,mm.index)+s.charAt(mm.index).toUpperCase()+s.slice(mm.index+1); needCap=false; }
        }
        tn.nodeValue=s;
      }
    }
  }
  // Tipografía con sentido a nivel de TRAMO. align/lineHeight son de bloque y
  // opacity/radius/rotate son del elemento: esos siempre van al elemento entero.
  var RANGE_PROPS={fontFamily:1,fontSize:1,color:1,fontWeight:1,bold:1,italic:1,
                   letterSpacing:1,bg:1,textEffect:1,textCase:1};
  function apply(m){
    if(!sels.length) return;
    var p=m.prop, v=m.value;
    if(p!=='text') snap();
    // Con un tramo de texto marcado, la tipografía va SOLO a ese tramo.
    if(RANGE_PROPS[p] && activeRange()){
      var sp=rangeSpan();
      if(sp){ styleEl(sp,p,v); paint(); report(); serialize(); return; }
    }
    sels.forEach(function(el){
      if(isLocked(el)) return;   // capa bloqueada: no se edita ni se borra
      // ── efectos ───────────────────────────────────────────────────────────
      // 'fx' = filtro SVG (respeta la silueta); 'fxLayer' = capa de superficie
      // encima del elemento. value null (o intensidad 0) apaga el efecto.
      if(p==='fx'){ setFx(el, v.kind, v.value); }
      else if(p==='fxLayer'){
        setFxLayer(el, v.kind, (v.value==null||fxAmt(v.value)===0) ? '' : fxSurface(v.kind, v.value));
      }
      else if(p==='fxClear'){
        el.removeAttribute('data-oc-fx');
        rebuildFilter(el, filterPart(el,'drop-shadow'), filterBlur(el));
        ['material','frost','radial','crt'].forEach(function(k){ setFxLayer(el,k,''); });
      }
      else if(p==='text'){ setText(el, v); }
      else if(p==='clearFormat'){ clearFormat(el); }
      // Fondo del contenedor que abraza al texto (la "caja"), no del texto mismo.
      else if(p==='boxBg'){
        var host=bgAncestor(el);
        if(host) host.style.background = (v===''||v==='transparent') ? 'transparent' : v;
      }
      else if(p==='splitBg'){
        // "Sacar el texto de la caja": el resaltado es el background del MISMO
        // elemento. Lo copiamos a un div independiente insertado justo detrás
        // (mismo padre, antes en el DOM → pinta debajo) y el texto queda libre.
        var scs=getComputedStyle(el);
        if(scs.backgroundColor!=='rgba(0, 0, 0, 0)'||scs.backgroundImage!=='none'){
          var rr=el.getBoundingClientRect();
          var bx=document.createElement('div');
          bx.style.cssText='position:absolute;left:0;top:0;width:'+Math.round(rr.width)+'px;height:'+Math.round(rr.height)+'px';
          bx.style.backgroundColor=scs.backgroundColor;
          if(scs.backgroundImage!=='none') bx.style.backgroundImage=scs.backgroundImage;
          bx.style.borderRadius=scs.borderRadius;
          makeRelative(el);
          el.parentElement.insertBefore(bx, el);
          // El ancestro posicionado del div puede no estar en (0,0): medimos dónde
          // cayó y corregimos left/top con la diferencia contra el rect del texto.
          var brr=bx.getBoundingClientRect();
          bx.style.left=Math.round(rr.left-brr.left)+'px';
          bx.style.top=Math.round(rr.top-brr.top)+'px';
          el.style.background='transparent';
        }
      }
      else if(p==='x'){ moveTo(el, v, null); }
      else if(p==='y'){ moveTo(el, null, v); }
      else if(p==='w'){ promoteAbsolute(el); el.style.width=Math.max(1,v)+'px'; if(el.tagName==='IMG') el.style.height='auto'; }
      else if(p==='h'){ promoteAbsolute(el); el.style.height=Math.max(1,v)+'px'; }
      // Sacar la foto de su marco (reubica en el DOM: es estructural, no estilo).
      else if(p==='unframe'){ unframe(el); }
      else if(p==='front'){ restack(el,true); }
      else if(p==='back'){ restack(el,false); }
      else if(p==='forward'){ restackStep(el,1); }
      else if(p==='backward'){ restackStep(el,-1); }
      else if(p==='remove'){ el.remove(); }
      else styleEl(el,p,v);
    });
    if(p==='remove') sels=sels.filter(isLocked);   // lo bloqueado sigue ahí, y seleccionado
    paint(); report(); serialize();
  }
  function group(){
    if(sels.length<2) return;
    snap();
    var id=null;
    sels.forEach(function(el){ var g=el.getAttribute('data-oc-g'); if(g&&!id) id=g; });
    if(!id) id='g'+Date.now().toString(36);
    sels.forEach(function(el){ el.setAttribute('data-oc-g', id); });
    report(); serialize();
  }
  function ungroup(){
    snap();
    var ids={};
    sels.forEach(function(el){ var g=el.getAttribute('data-oc-g'); if(g) ids[g]=1; });
    Object.keys(ids).forEach(function(g){
      [].slice.call(document.querySelectorAll('[data-oc-g="'+g+'"]')).forEach(function(el){ el.removeAttribute('data-oc-g'); });
    });
    sels=sels.slice(0,1); paint(); report(); serialize();
  }
  function unlink(){   // sacar los seleccionados de su grupo, sin disolverlo
    snap();
    sels.forEach(function(el){ el.removeAttribute('data-oc-g'); });
    paint(); report(); serialize();
  }
  function addText(){
    snap();
    var d=document.createElement('div');
    d.textContent='Texto nuevo';
    // background:transparent explícito: una caja de texto nueva no tiene que
    // pintar nada que se distinga del lienzo.
    d.style.cssText='position:absolute;left:120px;top:120px;font-size:60px;font-family:Inter,sans-serif;color:#111;font-weight:700;background:transparent;z-index:5';
    rootEl().appendChild(d); sels=[d]; paint(); report(); serialize();
  }
  function addImage(url){
    snap();
    var img=document.createElement('img');
    // Placeholder visible: sin esto, mientras la imagen carga su alto es 'auto'=0px
    // y "no aparece". Los estilos del placeholder viven en la hoja del editor
    // (img[data-oc-ph]), NO en el style inline: así, si la lámina se serializa antes
    // del onload (o la carga falla), no queda un cuadrado gris guardado en el HTML.
    img.setAttribute('data-oc-ph','1');
    img.style.cssText='position:absolute;left:'+Math.round((W-360)/2)+'px;top:'+Math.round((H-360)/2)+'px;width:360px;height:auto;z-index:5';
    img.onload=function(){ img.removeAttribute('data-oc-ph'); img.removeAttribute('data-oc-err'); paint(); syncOne(); serialize(); };
    img.onerror=function(){ img.setAttribute('data-oc-err','1'); };
    img.src=url;
    rootEl().appendChild(img);
    sels=[img]; paint(); report(); serialize();
  }
  // ── librería de formas: divs para cajas/marcos/líneas (el trazo es border CSS)
  //    y svg para siluetas (fill:currentColor → recolorear via style.color del raíz;
  //    stroke/stroke-width/dasharray HEREDAN del raíz a los hijos → los controles de
  //    trazo del panel funcionan sin tocar cada <polygon>). ──────────────────────
  function svgShape(inner){
    return '<svg data-oc-shape="1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none"'
      +' style="width:300px;height:300px;color:#4f7cff;stroke:none;overflow:visible;display:block">'+inner+'</svg>';
  }
  var SHAPES={
    square:'<div data-oc-shape="1" style="width:300px;height:300px;background:#4f7cff"></div>',
    rounded:'<div data-oc-shape="1" style="width:300px;height:300px;background:#4f7cff;border-radius:28px"></div>',
    circle:'<div data-oc-shape="1" style="width:300px;height:300px;background:#4f7cff;border-radius:50%"></div>',
    pill:'<div data-oc-shape="1" style="width:380px;height:150px;background:#4f7cff;border-radius:999px"></div>',
    frame:'<div data-oc-shape="1" style="width:300px;height:300px;border:6px solid #111827"></div>',
    frameRounded:'<div data-oc-shape="1" style="width:300px;height:300px;border:6px solid #111827;border-radius:28px"></div>',
    frameCircle:'<div data-oc-shape="1" style="width:300px;height:300px;border:6px solid #111827;border-radius:50%"></div>',
    line:'<div data-oc-shape="1" data-oc-line="1" style="width:420px;height:0;border-top:5px solid #111827"></div>',
    lineDashed:'<div data-oc-shape="1" data-oc-line="1" style="width:420px;height:0;border-top:5px dashed #111827"></div>',
    lineDotted:'<div data-oc-shape="1" data-oc-line="1" style="width:420px;height:0;border-top:6px dotted #111827"></div>',
    triangle:svgShape('<polygon points="50,4 96,92 4,92" fill="currentColor"/>'),
    diamond:svgShape('<polygon points="50,2 98,50 50,98 2,50" fill="currentColor"/>'),
    pentagon:svgShape('<polygon points="50,2 98,38 79,96 21,96 2,38" fill="currentColor"/>'),
    hexagon:svgShape('<polygon points="25,5 75,5 98,50 75,95 25,95 2,50" fill="currentColor"/>'),
    star:svgShape('<polygon points="50,2 61,35 98,35 68,57 79,92 50,70 21,92 32,57 2,35 39,35" fill="currentColor"/>'),
    heart:svgShape('<path d="M50 91 C20 68 2 50 2 30 C2 14 14 4 27 4 C37 4 46 10 50 19 C54 10 63 4 73 4 C86 4 98 14 98 30 C98 50 80 68 50 91 Z" fill="currentColor"/>'),
    arrow:svgShape('<polygon points="0,38 58,38 58,16 100,50 58,84 58,62 0,62" fill="currentColor"/>'),
    cross:svgShape('<polygon points="35,2 65,2 65,35 98,35 98,65 65,65 65,98 35,98 35,65 2,65 2,35 35,35" fill="currentColor"/>'),
    half:svgShape('<path d="M2 98 A48 48 0 0 1 98 98 Z" fill="currentColor"/>'),
    bubble:svgShape('<path d="M14 4 h72 q12 0 12 12 v44 q0 12 -12 12 H46 L24 94 30 72 H14 Q2 72 2 60 V16 Q2 4 14 4 Z" fill="currentColor"/>')
  };
  function addShape(kind){
    var h=SHAPES[kind]; if(!h) return;
    snap();
    var t=document.createElement('div'); t.innerHTML=h;
    var el=t.firstElementChild; if(!el) return;
    var sw=parseFloat(el.style.width)||300, sh=parseFloat(el.style.height)||0;
    el.style.position='absolute';
    el.style.left=Math.round((W-sw)/2)+'px';
    el.style.top=Math.round((H-sh)/2)+'px';
    el.style.zIndex='5';
    rootEl().appendChild(el);
    sels=[el]; paint(); report(); serialize();
  }
  // Reemplaza la fuente de la imagen seleccionada (para regenerar con IA, quitar
  // fondo o volver a una versión anterior). Va sumando cada src al historial para
  // poder comparar el fondo nuevo con el anterior y volver si no convence.
  /**
   * Cambia la fuente de la imagen seleccionada.
   *
   * Con keepBox (reemplazar una imagen por otra) se congela la caja actual —
   * left/top/ancho/alto reales — y se pasa a object-fit:cover, así la imagen nueva
   * ocupa EXACTAMENTE el lugar de la anterior sin deformarse. Sin eso, una foto con
   * height:auto y otra proporción cambiaba de alto y descolocaba la composición.
   */
  function setImgSrc(url, keepBox){
    if(!sels.length) return; var el=sels[0];
    if(el.tagName!=='IMG') return;
    snap();
    if(keepBox){
      var lr=layoutRect(el);
      promoteAbsolute(el);   // fija left/top/ancho reales
      el.style.width=Math.round(lr.width)+'px';
      el.style.height=Math.round(lr.height)+'px';
      if(!el.style.objectFit) el.style.objectFit='cover';
    }
    var hist=readImgHist(el);
    // Primera vez: sembrar con la fuente actual (el fondo original que había).
    if(!hist.length){ var cur=el.getAttribute('src'); if(cur) hist=[cur]; }
    // Volver a una versión ya guardada no la duplica; una nueva se agrega al final.
    if(hist.indexOf(url)<0) hist.push(url);
    if(hist.length>IMGHISTMAX) hist=hist.slice(hist.length-IMGHISTMAX);
    el.setAttribute('data-oc-imghist', JSON.stringify(hist));
    el.onload=function(){ paint(); syncOne(); serialize(); };
    el.src=url; report(); serialize();
  }
  function setBg(val){ snap(); (rootEl()||document.body).style.background=val; serialize(); }

  // ── textura de material: capa a lámina completa con mix-blend-mode:overlay, como
  //    primer hijo del host de fondo (el mismo que colorea setBg) → blende contra ese
  //    fondo y queda DETRÁS del contenido (z-index 0). Es un div real: se serializa y
  //    viaja al preview/export. url vacío la quita. Reusa la capa existente al cambiar
  //    de textura u opacidad, así nunca se apilan dos. ────────────────────────────
  function setTexture(url, opacity){
    snap();
    var host=rootEl()||document.body;
    var ex=document.querySelector('[data-oc-tex]');
    if(!url){ if(ex) ex.remove(); paint(); serialize(); return; }
    if(getComputedStyle(host).position==='static') host.style.position='relative';
    var t=ex||document.createElement('div');
    t.setAttribute('data-oc-tex','1');
    t.style.cssText='position:absolute;inset:0;pointer-events:none;background-position:center;background-size:cover;mix-blend-mode:overlay;z-index:0';
    t.style.backgroundImage="url('"+url+"')";
    t.style.opacity=String(opacity);
    if(!ex) host.insertBefore(t, host.firstChild);
    paint(); serialize();
  }

  function serializeNoSnap(){
    // Punto común de todas las operaciones: es acá donde la sombra de puntos vuelve
    // a calzar con su dueño (mover, escalar, rotar, alinear, reemplazar imagen...).
    syncLinked();
    ui.remove(); gl.remove(); st.remove();
    document.querySelectorAll('[contenteditable]').forEach(function(n){ n.removeAttribute('contenteditable'); });
    var html=document.body.innerHTML.replace(/<script[\s\S]*?<\/script>/gi,'')
      .replace(/\sdata-oc-(?:ph|err)="1"/g,'');
    post({oc:'html', html:html});
    document.head.appendChild(st); document.body.appendChild(gl); document.body.appendChild(ui);
    paint();
  }
  function serialize(){ serializeNoSnap(); }

  window.addEventListener('message', function(e){
    var m=e.data; if(!m||!m.oc) return;
    if(m.oc==='apply') apply(m);
    else if(m.oc==='align') align(m.kind);
    else if(m.oc==='distribute') distribute(m.axis);
    else if(m.oc==='group') group();
    else if(m.oc==='ungroup') ungroup();
    else if(m.oc==='unlink') unlink();
    else if(m.oc==='undo') undo();
    else if(m.oc==='copy') copy();
    else if(m.oc==='paste') paste();
    else if(m.oc==='setClip'){ if(m.html&&m.html.length) clip=m.html.slice(); }
    else if(m.oc==='duplicate') duplicate();
    else if(m.oc==='addText') addText();
    else if(m.oc==='editText'){ if(sels.length===1) editText(sels[0]); }
    else if(m.oc==='addShape') addShape(m.kind);
    else if(m.oc==='addImage') addImage(m.url);
    else if(m.oc==='setImgSrc') setImgSrc(m.url, m.keepBox);
    else if(m.oc==='setBg') setBg(m.value);
    else if(m.oc==='setTexture') setTexture(m.url, m.opacity);
    else if(m.oc==='scale'){ viewScale=Number(m.value)||1; }
    else if(m.oc==='deselect') clearSel();
    else if(m.oc==='selectLayer') selectLayer(m.id);
    else if(m.oc==='reorderLayers') reorderLayers(m.ids);
    else if(m.oc==='layerMove') layerMove(m.id, m.dir);
    else if(m.oc==='layerFlag') layerFlag(m.id, m.flag, !!m.value);
    else if(m.oc==='layerName') layerName(m.id, m.name);
    else if(m.oc==='serialize') serialize();
  });
  // Curar láminas guardadas con el placeholder viejo horneado en el style inline
  // (versiones anteriores de addImage serializaban background #eceaf0 + outline
  // punteado): se limpia y, si la imagen sigue sin cargar, pasa al placeholder
  // nuevo de la hoja del editor, que no se serializa.
  [].slice.call(document.querySelectorAll('img')).forEach(function(img){
    var s=img.style, hit=false;
    if(/rgb\(236,\s*234,\s*240\)|#eceaf0/i.test((s.background||'')+' '+(s.backgroundColor||''))){ s.background=''; hit=true; }
    if(/rgb\(255,\s*59,\s*127\)|#ff3b7f|rgb\(225,\s*29,\s*72\)|#e11d48/i.test((s.outline||'')+' '+(s.outlineColor||''))){ s.outline=''; s.outlineOffset=''; hit=true; }
    if(!hit) return;
    if(s.minHeight==='180px') s.minHeight='';
    if(!img.complete || !img.naturalWidth){
      img.setAttribute('data-oc-ph','1');
      img.onload=function(){ img.removeAttribute('data-oc-ph'); img.removeAttribute('data-oc-err'); paint(); };
      img.onerror=function(){ img.setAttribute('data-oc-err','1'); };
      if(img.complete) img.setAttribute('data-oc-err','1');
    }
  });
  post({oc:'ready'});
  reportLayers();   // lista inicial de capas para el panel
})();
`;

/** Envuelve la lámina para edición: doc completo + fuentes CDN + runtime del editor. */
export function wrapEditableSlide(slideHtml: string, aspectRatio: AspectRatio): string {
  const { width, height } = DIMENSIONS[aspectRatio];
  slideHtml = slideHtml.replace(/<script[\s\S]*?<\/script>/gi, "");
  const fams = extractFontFamilies(slideHtml);
  const fontLink = fams.length
    ? `<link href="https://fonts.googleapis.com/css2?${fams
        .map((f) => `family=${encodeURIComponent(f)}:${GF_ITAL_WGHT}`)
        .join("&")}&display=swap" rel="stylesheet">`
    : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${fontLink}
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${width}px;height:${height}px;overflow:hidden;position:relative}</style>
</head><body>${slideHtml}<script>${EDITOR_RUNTIME}</script></body></html>`;
}
