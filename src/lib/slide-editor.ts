import type { AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";
import { extractFontFamilies, FONT_WEIGHTS } from "./slide-html";

/**
 * Fragmento `ital,wght@…` con TODOS los grosores (romanas + itálicas) para el
 * editor. La lista explícita es tolerante: Google sirve solo lo que cada fuente
 * tiene, así que el selector de grosor manual (100–900) rinde sin importar la
 * familia. Compartido entre el runtime del iframe y `wrapEditableSlide`.
 */
export const GF_ITAL_WGHT = `ital,wght@${FONT_WEIGHTS.map((w) => `0,${w}`).join(
  ";"
)};${FONT_WEIGHTS.map((w) => `1,${w}`).join(";")}`;

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
  var sels=[], drag=null, rz=null, rot=null, squelch=false, clip=[], hist=[], HMAX=60;
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
    +'.oc-box{position:absolute;outline:2px solid #4f7cff;outline-offset:1px}'
    +'.oc-gl{position:absolute;background:#ff3b7f}';
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
      if(!c[i].hasAttribute('data-oc-ui') && t!=='SCRIPT' && t!=='STYLE' && t!=='LINK') return c[i];
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
  function members(el){
    var g=el.getAttribute && el.getAttribute('data-oc-g');
    if(!g) return [el];
    return [].slice.call(document.querySelectorAll('[data-oc-g="'+g+'"]'));
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
  var boxes=[], handles=[], rotLine=null;
  function paint(){
    ui.innerHTML=''; boxes=[]; handles=[]; rotLine=null;
    sels.forEach(function(el){
      var r=el.getBoundingClientRect();
      var b=document.createElement('div'); b.className='oc-box';
      b.style.cssText='position:absolute;left:0;top:0;width:'+r.width+'px;height:'+r.height+'px;transform:translate('+r.left+'px,'+r.top+'px)';
      ui.appendChild(b); boxes.push(b);
    });
    if(sels.length===1){
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
  }
  function showHandles(v){ handles.forEach(function(h){ h.el.style.display=v?'block':'none'; }); }
  // capa de guías: se crea UNA vez y solo se muestra/oculta (sin churn de DOM)
  var gl=document.createElement('div'); gl.setAttribute('data-oc-ui','1');
  gl.style.cssText='position:absolute;left:0;top:0;width:'+W+'px;height:'+H+'px;pointer-events:none;z-index:2147483001';
  var gV=document.createElement('div'), gH=document.createElement('div');
  gV.style.cssText='position:absolute;top:0;left:0;width:1px;height:'+H+'px;background:#ff3b7f;display:none';
  gH.style.cssText='position:absolute;left:0;top:0;height:1px;width:'+W+'px;background:#ff3b7f;display:none';
  gl.appendChild(gV); gl.appendChild(gH); document.body.appendChild(gl);
  // Badge con los grados en vivo mientras se rota. Vive en la capa de guías (que
  // nunca se reconstruye), así persiste durante todo el arrastre.
  var degBadge=document.createElement('div'); degBadge.className='oc-deg'; degBadge.setAttribute('data-oc-ui','1');
  gl.appendChild(degBadge);
  function guides(gx,gy){
    if(gx!=null){ gV.style.display='block'; gV.style.transform='translateX('+gx+'px)'; } else gV.style.display='none';
    if(gy!=null){ gH.style.display='block'; gH.style.transform='translateY('+gy+'px)'; } else gH.style.display='none';
  }
  function report(){
    if(!sels.length){ post({oc:'sel',none:true}); return; }
    var el=sels[0], cs=getComputedStyle(el), er=el.getBoundingClientRect();
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
      text: isText ? readText(el) : '',
      range: !!rh,
      fontFamily:(ct.fontFamily||'').split(',')[0].replace(/['"]/g,'').trim(),
      fontSize:Math.round(parseFloat(ct.fontSize)||0),
      color:toHex(ct.color), fontWeight:ct.fontWeight,
      // En un svg raíz el "fondo" es el fill (viaja por color → fill:currentColor)
      bg: isSvg ? toHex(cs.color)
        : (ct.backgroundColor&&ct.backgroundColor!=='rgba(0, 0, 0, 0)'&&ct.backgroundColor!=='transparent')?toHex(ct.backgroundColor):'',
      italic:ct.fontStyle==='italic', align:cs.textAlign,
      opacity: Math.round((parseFloat(cs.opacity)||1)*100),
      rotation: Math.round(((parseFloat(el.style.rotate)||0)%360+360)%360),
      radius: Math.round(parseFloat(cs.borderTopLeftRadius)||0),
      isShape: !!(el.getAttribute&&el.getAttribute('data-oc-shape')),
      isSvgShape: isSvg,
      // Borde (divs/imágenes/texto) o trazo (formas svg), unificados para el panel
      borderW: isSvg ? Math.round(parseFloat(cs.strokeWidth)||0) : Math.round(parseFloat(cs.borderTopWidth)||0),
      borderStyle: isSvg ? (cs.stroke==='none' ? 'none' : ((cs.strokeDasharray&&cs.strokeDasharray!=='none')?'dashed':'solid')) : cs.borderTopStyle,
      borderColor: isSvg ? (cs.stroke==='none' ? '#111827' : toHex(cs.stroke)) : toHex(cs.borderTopColor),
      letterSpacing: ct.letterSpacing==='normal'?0:Math.round((parseFloat(ct.letterSpacing)||0)*10)/10,
      lineHeight: cs.lineHeight==='normal'?0:Math.round(((parseFloat(cs.lineHeight)||0)/(parseFloat(cs.fontSize)||1))*100)/100,
      x:Math.round(er.left), y:Math.round(er.top), w:Math.round(er.width), h:Math.round(er.height),
      canUndo: hist.length>0});
  }
  function clearSel(){ sels=[]; savedRange=null; paint(); guides(); report(); }
  function select(el, additive, solo){
    if(!el){ if(!additive) clearSel(); return; }
    var ms = solo ? [el] : members(el);
    if(additive){ ms.forEach(function(m){ if(sels.indexOf(m)<0) sels.push(m); }); }
    else sels=ms.slice();
    paint(); report();
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
    select(candidateAt(e.clientX,e.clientY,e.altKey), e.shiftKey, e.altKey);
  }, true);

  // ── arrastre con transform + snap ────────────────────────────────────────────
  document.addEventListener('mousedown', function(e){
    if(rz||rot||!sels.length) return;
    var x=e.clientX,y=e.clientY;
    // Zona de agarre con mínimo 28px por eje: un elemento flaco (flecha de 6px de
    // alto) era imposible de "pescar" con el rect exacto.
    var hit=sels.some(function(el){ var r=el.getBoundingClientRect();
      var px=Math.max(0,(28-r.width)/2), py=Math.max(0,(28-r.height)/2);
      return x>=r.left-px&&x<=r.right+px&&y>=r.top-py&&y<=r.bottom+py; });
    if(!hit) return;
    if(sels[0].getAttribute('contenteditable')==='true') return;
    savedRange=null;   // agarrar el elemento entero = adiós al tramo marcado
    snap();
    sels.forEach(makeMovable);
    // rects cacheados: durante el arrastre NO se vuelve a medir (cero reflows)
    drag={sx:x, sy:y,
      start:sels.map(function(el){ return (delta.get(el)||[0,0]).slice(); }),
      rects:sels.map(function(el){ var r=el.getBoundingClientRect();
        return {left:r.left, top:r.top, width:r.width, height:r.height}; })};
    showHandles(false);
    e.preventDefault();
  }, true);
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
      if(!baseTf.has(el)) baseTf.set(el, el.style.transform||'');
    } else if(cs.display==='inline'){
      mode.set(el,'offset');
      if(cs.position==='static') el.style.position='relative';
      baseOff.set(el,[parseFloat(el.style.left)||0, parseFloat(el.style.top)||0]);
    } else {
      mode.set(el,'transform');
      if(!baseTf.has(el)) baseTf.set(el, el.style.transform||'');
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
    var x=pend.x, y=pend.y; pend=null;
    if(rot){ doRotate(x,y); return; }
    if(rz){ doResize(x,y); return; }
    if(!drag||!sels.length) return;
    var dx=x-drag.sx, dy=y-drag.sy;
    // snap calculado desde los rects cacheados (sin medir el DOM)
    var r0=drag.rects[0], gx=null, gy=null;
    var cx=r0.left+dx+r0.width/2, cy=r0.top+dy+r0.height/2;
    if(Math.abs(cx-W/2)<9){ dx+=W/2-cx; gx=W/2; }
    else if(Math.abs(r0.left+dx-60)<9){ dx+=60-(r0.left+dx); gx=60; }
    else if(Math.abs((r0.left+dx+r0.width)-(W-60))<9){ dx+=(W-60)-(r0.left+dx+r0.width); gx=W-60; }
    if(Math.abs(cy-H/2)<9){ dy+=H/2-cy; gy=H/2; }
    for(var i=0;i<sels.length;i++) applyT(sels[i], drag.start[i][0]+dx, drag.start[i][1]+dy);
    offsetBoxes(drag.rects, dx, dy);
    guides(gx,gy);
  }
  window.addEventListener('mousemove', function(e){
    if(!drag&&!rz&&!rot) return;
    pend={x:e.clientX,y:e.clientY};
    if(!raf) raf=requestAnimationFrame(flush);
  });
  window.addEventListener('mouseup', function(){
    if(raf){ cancelAnimationFrame(raf); raf=0; pend=null; }
    // squelch: el click que dispara este mouseup re-seleccionaría lo que quede
    // bajo el puntero (tras rotar suele ser "nada" → deseleccionaba). Lo tragamos.
    // Se auto-apaga en el próximo tick: si el navegador NO emite ese click
    // (targets distintos), el flag no puede comerse el siguiente clic real.
    if(rot){ rot=null; squelchNext(); document.body.classList.remove('oc-rotating'); degBadge.style.display='none'; paint(); report(); serialize(); return; }
    if(rz){ rz=null; squelchNext(); paint(); report(); serialize(); return; }
    if(drag){ drag=null; squelchNext(); guides(); showHandles(true); paint(); report(); serialize(); }
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
    var el=sels[0], r=el.getBoundingClientRect(), cs=getComputedStyle(el);
    snap();
    rz={el:el, sx:e.clientX, sy:e.clientY, w:r.width, h:r.height, corner:corner,
        fs:parseFloat(cs.fontSize)||0,
        isText: isTextEl(el)};
    e.preventDefault(); e.stopPropagation();
  }
  function doResize(x,y){
    var dx=x-rz.sx, dy=y-rz.sy, c=rz.corner;
    var leftSide=(c==='nw'||c==='sw'||c==='w'), topSide=(c==='nw'||c==='ne'||c==='n');
    var wDelta=leftSide?-dx:dx, hDelta=topSide?-dy:dy;
    var isCorner=(c.length===2);
    if(rz.isText){
      if(isCorner){ // esquina → escalar la tipografía (proporcional, por el eje horizontal)
        var ratio=Math.max(0.15,(rz.w+wDelta)/Math.max(1,rz.w));
        rz.el.style.fontSize=Math.max(8,Math.round(rz.fs*ratio))+'px';
      } else { // lateral w/e → SOLO ancho: el texto refluye, fontSize intacto
        rz.el.style.width=Math.max(20,Math.round(rz.w+wDelta))+'px';
      }
    } else {
      if(isCorner){ // esquina → escala proporcional
        var ratio2=Math.max(0.15,(rz.w+wDelta)/Math.max(1,rz.w));
        rz.el.style.width=Math.max(20,Math.round(rz.w*ratio2))+'px';
        if(rz.el.tagName==='IMG') rz.el.style.height='auto';
        // formas: el alto acompaña (un círculo sigue círculo); las líneas no tienen alto
        else if(rz.el.getAttribute&&rz.el.getAttribute('data-oc-shape')&&!rz.el.getAttribute('data-oc-line'))
          rz.el.style.height=Math.max(20,Math.round(rz.h*ratio2))+'px';
      } else if(c==='e'||c==='w'){ // lateral → ancho libre
        rz.el.style.width=Math.max(20,Math.round(rz.w+wDelta))+'px';
        if(rz.el.tagName==='IMG') rz.el.style.height='auto';
      } else { // n/s → alto libre
        rz.el.style.height=Math.max(20,Math.round(rz.h+hDelta))+'px';
      }
    }
    syncOne();   // re-mide solo el elemento activo, sin reconstruir el overlay
  }

  document.addEventListener('dblclick', function(e){
    var t=candidateAt(e.clientX,e.clientY);
    if(t && isTextEl(t)){
      snap();
      t.setAttribute('contenteditable','true'); t.focus();
      var end=function(){ t.setAttribute('contenteditable','false'); t.removeEventListener('blur',end); paint(); report(); serialize(); };
      t.addEventListener('blur', end);
    }
  }, true);

  // ── teclado: undo, copy/paste, duplicar, borrar, nudge ───────────────────────
  document.addEventListener('keydown', function(e){
    var ed=document.querySelector('[contenteditable="true"]');
    var mod=e.ctrlKey||e.metaKey;
    if(mod && e.key.toLowerCase()==='z'){ e.preventDefault(); undo(); return; }
    if(ed) return;
    if(mod && e.key.toLowerCase()==='c'){ e.preventDefault(); copy(); return; }
    // Ctrl+V NO se intercepta acá: dejamos que dispare el evento 'paste' nativo,
    // que sabe mirar el portapapeles del SISTEMA (imágenes) además del interno.
    if(mod && e.key.toLowerCase()==='d'){ e.preventDefault(); duplicate(); return; }
    if((e.key==='Delete'||e.key==='Backspace') && sels.length){ e.preventDefault(); apply({prop:'remove'}); return; }
    if(e.key.indexOf('Arrow')===0 && sels.length){
      e.preventDefault();
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
    clip=sels.map(function(el){ return el.outerHTML; });
    // Pisamos el portapapeles del sistema (mejor esfuerzo): sin esto, un
    // screenshot viejo le ganaría al elemento recién copiado en el Ctrl+V.
    try{ if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(' ').catch(function(){}); }catch(err){}
    post({oc:'toast',msg:sels.length+' copiado(s)'});
  }
  function paste(){
    if(!clip.length) return;
    snap();
    var added=[];
    clip.forEach(function(h){
      var t=document.createElement('div'); t.innerHTML=h;
      var el=t.firstElementChild; if(!el) return;
      el.removeAttribute('data-oc-g');
      rootEl().appendChild(el);
      var d=[20,20]; delta.set(el,d); baseTf.set(el, el.style.transform||'');
      el.style.transform=(el.style.transform?el.style.transform+' ':'')+'translate(20px,20px)';
      added.push(el);
    });
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
    var er=el.getBoundingClientRect();
    el.style.position='absolute';
    var op=el.offsetParent||document.body, opr=op.getBoundingClientRect();
    el.style.left=Math.round(er.left-opr.left)+'px';
    el.style.top=Math.round(er.top-opr.top)+'px';
    el.style.width=Math.round(er.width)+'px';
    el.style.margin='0'; el.style.transform=''; delta.set(el,[0,0]);
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
  function restack(el,toFront){
    var par=el.parentElement; if(!par) return;
    if(el.ownerSVGElement){
      // Dentro de un svg no hay z-index: manda el orden del DOM.
      if(toFront) par.appendChild(el);
      else par.insertBefore(el, par.firstElementChild);
      return;
    }
    var items=[], kids=par.children;
    for(var i=0;i<kids.length;i++){
      var k=kids[i];
      if(k.hasAttribute && k.hasAttribute('data-oc-ui')) continue;
      if(k.tagName==='SCRIPT'||k.tagName==='STYLE'||k.tagName==='LINK') continue;
      var cs=getComputedStyle(k), z;
      if(cs.position==='static') z=-0.5;   // estático: pinta bajo lo posicionado
      else z=(cs.zIndex==='auto') ? 0 : (parseInt(cs.zIndex)||0);
      items.push({el:k, z:z, i:i});
    }
    items.sort(function(a,b){ return (a.z-b.z) || (a.i-b.i); });  // orden visual hoy
    var rest=[];
    items.forEach(function(it){ if(it.el!==el) rest.push(it.el); });
    var order = toFront ? rest.concat([el]) : [el].concat(rest);
    order.forEach(function(k,idx){
      if(getComputedStyle(k).position==='static') k.style.position='relative';
      k.style.zIndex=String(idx+1);
    });
  }
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
    else if(p==='letterSpacing'){ el.style.letterSpacing=v+'px'; }
    else if(p==='lineHeight'){ el.style.lineHeight=v; }
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
      el.style.boxShadow=''; el.style.filter='';
      if(v==='dots'){
        var dr=el.getBoundingClientRect();
        var dd=document.createElement('div');
        dd.setAttribute('data-oc-shape','1'); dd.setAttribute('data-oc-dots','1');
        dd.style.cssText='position:absolute;left:0;top:0;width:'+Math.round(dr.width)+'px;height:'+Math.round(dr.height)+'px'
          +';background-image:radial-gradient(circle, #111827 2.6px, transparent 3px);background-size:16px 16px';
        dd.style.borderRadius=getComputedStyle(el).borderRadius;
        el.parentElement.insertBefore(dd, el);
        if(getComputedStyle(el).position==='static') el.style.position='relative';
        // corregir contra el ancestro posicionado real, con offset diagonal (18,18)
        var ddr=dd.getBoundingClientRect();
        dd.style.left=Math.round(dr.left-ddr.left+18)+'px';
        dd.style.top=Math.round(dr.top-ddr.top+18)+'px';
      } else {
        var box={soft:'0 6px 18px rgba(0,0,0,.20)', medium:'0 12px 30px rgba(0,0,0,.28)', strong:'0 22px 48px rgba(0,0,0,.40)', float:'0 30px 46px -18px rgba(0,0,0,.45)'};
        var drop={soft:'0 6px 10px rgba(0,0,0,.28)', medium:'0 12px 18px rgba(0,0,0,.32)', strong:'0 20px 28px rgba(0,0,0,.42)', float:'0 26px 22px rgba(0,0,0,.38)'};
        if(box[v]){
          if(el.tagName==='IMG'||isSvgRoot(el)) el.style.filter='drop-shadow('+drop[v]+')';
          else el.style.boxShadow=box[v];
        } // 'none' deja todo reseteado
      }
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
      if(p==='text'){ el.innerHTML=String(v).split('\n').map(esc).join('<br>'); }
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
      else if(p==='front'){ restack(el,true); }
      else if(p==='back'){ restack(el,false); }
      else if(p==='remove'){ el.remove(); }
      else styleEl(el,p,v);
    });
    if(p==='remove') sels=[];
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
    d.style.cssText='position:absolute;left:120px;top:120px;font-size:60px;font-family:Inter,sans-serif;color:#111;font-weight:700;z-index:5';
    rootEl().appendChild(d); sels=[d]; paint(); report(); serialize();
  }
  function addImage(url){
    snap();
    var img=document.createElement('img');
    // Placeholder visible: sin esto, mientras la imagen carga su alto es 'auto'=0px
    // y "no aparece". El recuadro punteado con min-alto la hace visible y seleccionable
    // al instante; al cargar (onload) se limpia el placeholder. onerror la deja marcada
    // en rojo en vez de desaparecer en silencio.
    img.style.cssText='position:absolute;left:'+Math.round((W-360)/2)+'px;top:'+Math.round((H-360)/2)+'px;width:360px;height:auto;min-height:180px;z-index:5;background:#eceaf0;outline:2px dashed #ff3b7f;outline-offset:-2px';
    img.onload=function(){ img.style.minHeight=''; img.style.background=''; img.style.outline=''; img.style.outlineOffset=''; paint(); syncOne(); serialize(); };
    img.onerror=function(){ img.style.outline='3px solid #e11d48'; };
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
  // Reemplaza la fuente de la imagen seleccionada (para regenerar con IA).
  function setImgSrc(url){
    if(!sels.length) return; var el=sels[0];
    if(el.tagName!=='IMG') return;
    snap();
    el.onload=function(){ paint(); syncOne(); serialize(); };
    el.src=url; report(); serialize();
  }
  function setBg(val){ snap(); (rootEl()||document.body).style.background=val; serialize(); }

  function serializeNoSnap(){
    ui.remove(); gl.remove(); st.remove();
    document.querySelectorAll('[contenteditable]').forEach(function(n){ n.removeAttribute('contenteditable'); });
    var html=document.body.innerHTML.replace(/<script[\s\S]*?<\/script>/gi,'');
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
    else if(m.oc==='duplicate') duplicate();
    else if(m.oc==='addText') addText();
    else if(m.oc==='addShape') addShape(m.kind);
    else if(m.oc==='addImage') addImage(m.url);
    else if(m.oc==='setImgSrc') setImgSrc(m.url);
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
