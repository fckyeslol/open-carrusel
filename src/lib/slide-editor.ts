import type { AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";
import { extractFontFamilies } from "./slide-html";

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
 * Selección inteligente (prefiere texto/imagen sobre decorativos), multi-selección,
 * grupos (agregar/sacar miembros), arrastre con transform + guías y snap, resize por
 * handles, edición de texto inline, copiar/pegar/duplicar, deshacer, orden de capas,
 * nudge con flechas. La UI vive en un overlay [data-oc-ui] que nunca se serializa.
 */
export const EDITOR_RUNTIME = String.raw`
(function(){
  var sels=[], drag=null, rz=null, clip=[], hist=[], HMAX=60;
  var W=document.body.clientWidth||1080, H=document.body.clientHeight||1350;
  var baseTf=new WeakMap(), delta=new WeakMap();

  var st=document.createElement('style'); st.setAttribute('data-oc-ui','1');
  st.textContent='*{cursor:default}'
    +'[data-oc-ui]{pointer-events:none}'
    +'.oc-h{position:absolute;width:14px;height:14px;background:#fff;border:2px solid #4f7cff;border-radius:50%;pointer-events:auto;cursor:nwse-resize;z-index:3}'
    +'.oc-box{position:absolute;outline:2px solid #4f7cff;outline-offset:1px}'
    +'.oc-gl{position:absolute;background:#ff3b7f}';
  document.head.appendChild(st);

  var ui=document.createElement('div'); ui.setAttribute('data-oc-ui','1');
  ui.style.cssText='position:absolute;left:0;top:0;width:'+W+'px;height:'+H+'px;pointer-events:none;z-index:2147483000';
  document.body.appendChild(ui);

  function post(m){ parent.postMessage(m,'*'); }
  function rootEl(){
    var c=document.body.children;
    for(var i=0;i<c.length;i++){ if(!c[i].hasAttribute('data-oc-ui') && c[i].tagName!=='SCRIPT') return c[i]; }
    return document.body;
  }
  function toHex(c){
    if(!c) return '#000000';
    if(c[0]==='#') return c;
    var m=c.match(/\d+/g); if(!m) return '#000000';
    return '#'+m.slice(0,3).map(function(n){return ('0'+parseInt(n).toString(16)).slice(-2);}).join('');
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
  function candidateAt(x,y){
    var list=document.elementsFromPoint(x,y)||[], first=null;
    for(var i=0;i<list.length;i++){
      var el=list[i];
      if(el===document.body||el===document.documentElement||el===rootEl()) continue;
      if(el.closest && el.closest('[data-oc-ui]')) continue;
      if(tooBig(el)) continue;
      var leafText = el.children.length===0 && (el.textContent||'').trim().length>0;
      if(leafText || el.tagName==='IMG') return el;
      if(!first) first=el;
    }
    return first;
  }

  // ── overlay persistente: se crea al cambiar la selección y se REPOSICIONA
  //    (nunca se reconstruye) durante el arrastre → sin jank. ──────────────────
  var boxes=[], handles=[];
  function paint(){
    ui.innerHTML=''; boxes=[]; handles=[];
    sels.forEach(function(el){
      var r=el.getBoundingClientRect();
      var b=document.createElement('div'); b.className='oc-box';
      b.style.cssText='position:absolute;left:0;top:0;width:'+r.width+'px;height:'+r.height+'px;transform:translate('+r.left+'px,'+r.top+'px)';
      ui.appendChild(b); boxes.push(b);
    });
    if(sels.length===1){
      var el0=sels[0];
      var isTxt = el0.children.length===0 && (el0.textContent||'').trim().length>0;
      var r=el0.getBoundingClientRect();
      var mx=(r.left+r.right)/2, my=(r.top+r.bottom)/2;
      // 4 esquinas + laterales. En texto los laterales (w/e) refluyen el ancho sin
      // tocar la fuente; las esquinas escalan la tipografía. En no-texto los laterales
      // dan ancho/alto libres. Por eso el texto NO muestra n/s (su alto es automático).
      var hs=[['nw',r.left,r.top,'nwse'],['ne',r.right,r.top,'nesw'],
              ['sw',r.left,r.bottom,'nesw'],['se',r.right,r.bottom,'nwse'],
              ['w',r.left,my,'ew'],['e',r.right,my,'ew']];
      if(!isTxt){ hs.push(['n',mx,r.top,'ns']); hs.push(['s',mx,r.bottom,'ns']); }
      hs.forEach(function(c){
        var h=document.createElement('div'); h.className='oc-h';
        h.style.cssText+=';left:0;top:0;cursor:'+c[3]+'-resize;transform:translate('+(c[1]-7)+'px,'+(c[2]-7)+'px)';
        h.addEventListener('mousedown', function(ev){ startResize(ev,c[0]); });
        ui.appendChild(h); handles.push({el:h,c:c[0]});
      });
    }
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
             n:[mx,r.top],s:[mx,r.bottom],w:[r.left,my],e:[r.right,my]};
    handles.forEach(function(h){ var p=pos[h.c]; if(!p) return;
      h.el.style.transform='translate('+(p[0]-7)+'px,'+(p[1]-7)+'px)'; });
  }
  function showHandles(v){ handles.forEach(function(h){ h.el.style.display=v?'block':'none'; }); }
  // capa de guías: se crea UNA vez y solo se muestra/oculta (sin churn de DOM)
  var gl=document.createElement('div'); gl.setAttribute('data-oc-ui','1');
  gl.style.cssText='position:absolute;left:0;top:0;width:'+W+'px;height:'+H+'px;pointer-events:none;z-index:2147483001';
  var gV=document.createElement('div'), gH=document.createElement('div');
  gV.style.cssText='position:absolute;top:0;left:0;width:1px;height:'+H+'px;background:#ff3b7f;display:none';
  gH.style.cssText='position:absolute;left:0;top:0;height:1px;width:'+W+'px;background:#ff3b7f;display:none';
  gl.appendChild(gV); gl.appendChild(gH); document.body.appendChild(gl);
  function guides(gx,gy){
    if(gx!=null){ gV.style.display='block'; gV.style.transform='translateX('+gx+'px)'; } else gV.style.display='none';
    if(gy!=null){ gH.style.display='block'; gH.style.transform='translateY('+gy+'px)'; } else gH.style.display='none';
  }
  function report(){
    if(!sels.length){ post({oc:'sel',none:true}); return; }
    var el=sels[0], cs=getComputedStyle(el), er=el.getBoundingClientRect();
    var isText = el.children.length===0 && (el.textContent||'').trim().length>0;
    post({oc:'sel', count:sels.length,
      grouped: !!(el.getAttribute && el.getAttribute('data-oc-g')),
      tag:el.tagName.toLowerCase(), isText:isText,
      text: isText ? el.textContent : '',
      fontFamily:(cs.fontFamily||'').split(',')[0].replace(/['"]/g,'').trim(),
      fontSize:Math.round(parseFloat(cs.fontSize)||0),
      color:toHex(cs.color), fontWeight:cs.fontWeight,
      italic:cs.fontStyle==='italic', align:cs.textAlign,
      opacity: Math.round((parseFloat(cs.opacity)||1)*100),
      radius: Math.round(parseFloat(cs.borderTopLeftRadius)||0),
      letterSpacing: cs.letterSpacing==='normal'?0:Math.round((parseFloat(cs.letterSpacing)||0)*10)/10,
      lineHeight: cs.lineHeight==='normal'?0:Math.round(((parseFloat(cs.lineHeight)||0)/(parseFloat(cs.fontSize)||1))*100)/100,
      x:Math.round(er.left), y:Math.round(er.top), w:Math.round(er.width), h:Math.round(er.height),
      canUndo: hist.length>0});
  }
  function clearSel(){ sels=[]; paint(); guides(); report(); }
  function select(el, additive, solo){
    if(!el){ if(!additive) clearSel(); return; }
    var ms = solo ? [el] : members(el);
    if(additive){ ms.forEach(function(m){ if(sels.indexOf(m)<0) sels.push(m); }); }
    else sels=ms.slice();
    paint(); report();
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
    select(candidateAt(e.clientX,e.clientY), e.shiftKey, e.altKey);
  }, true);

  // ── arrastre con transform + snap ────────────────────────────────────────────
  document.addEventListener('mousedown', function(e){
    if(rz||!sels.length) return;
    var x=e.clientX,y=e.clientY;
    var hit=sels.some(function(el){ var r=el.getBoundingClientRect();
      return x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom; });
    if(!hit) return;
    if(sels[0].getAttribute('contenteditable')==='true') return;
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
    if(cs.display==='inline'){
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
    if(!drag&&!rz) return;
    pend={x:e.clientX,y:e.clientY};
    if(!raf) raf=requestAnimationFrame(flush);
  });
  window.addEventListener('mouseup', function(){
    if(raf){ cancelAnimationFrame(raf); raf=0; pend=null; }
    if(rz){ rz=null; paint(); report(); serialize(); return; }
    if(drag){ drag=null; guides(); showHandles(true); paint(); report(); serialize(); }
  });

  function startResize(e,corner){
    if(sels.length!==1) return;
    drag=null;  // un resize nunca coexiste con un arrastre (el mousedown del doc pudo armarlo)
    var el=sels[0], r=el.getBoundingClientRect(), cs=getComputedStyle(el);
    snap();
    rz={el:el, sx:e.clientX, sy:e.clientY, w:r.width, h:r.height, corner:corner,
        fs:parseFloat(cs.fontSize)||0,
        isText: el.children.length===0 && (el.textContent||'').trim().length>0};
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
    if(t && t.children.length===0){
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
    if(mod && e.key.toLowerCase()==='v'){ e.preventDefault(); paste(); return; }
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

  function copy(){ clip=sels.map(function(el){ return el.outerHTML; }); post({oc:'toast',msg:sels.length+' copiado(s)'}); }
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
    l.href='https://fonts.googleapis.com/css2?family='+fam.replace(/ /g,'+')+':ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,400&display=swap';
    document.head.appendChild(l);
  }
  // ── posicionamiento absoluto: al manipular con precisión (panel numérico o
  //    alinear/distribuir) fijamos left/top/width reales relativos al ancestro
  //    posicionado, preservando la posición visual. Así hay coordenadas de verdad.
  //    No tocamos el arrastre (sigue con transform); esto solo corre bajo demanda. ─
  function promoteAbsolute(el){
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
  function apply(m){
    if(!sels.length) return;
    var p=m.prop, v=m.value;
    if(p!=='text') snap();
    sels.forEach(function(el){
      if(p==='text'){ el.textContent=v; }
      else if(p==='fontFamily'){ el.style.fontFamily="'"+v+"'"; ensureFont(v); }
      else if(p==='fontSize'){ el.style.fontSize=v+'px'; }
      else if(p==='color'){ el.style.color=v; }
      else if(p==='bg'){ el.style.background=v; }
      else if(p==='bold'){ el.style.fontWeight=v?'800':'400'; }
      else if(p==='italic'){ el.style.fontStyle=v?'italic':'normal'; }
      else if(p==='align'){ el.style.textAlign=v; }
      else if(p==='opacity'){ el.style.opacity=(v/100); }
      else if(p==='radius'){ el.style.borderRadius=v+'px'; }
      else if(p==='letterSpacing'){ el.style.letterSpacing=v+'px'; }
      else if(p==='lineHeight'){ el.style.lineHeight=v; }
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
      else if(p==='x'){ moveTo(el, v, null); }
      else if(p==='y'){ moveTo(el, null, v); }
      else if(p==='w'){ promoteAbsolute(el); el.style.width=Math.max(1,v)+'px'; if(el.tagName==='IMG') el.style.height='auto'; }
      else if(p==='h'){ promoteAbsolute(el); el.style.height=Math.max(1,v)+'px'; }
      else if(p==='front'){ el.parentElement && el.parentElement.appendChild(el); }
      else if(p==='back'){ el.parentElement && el.parentElement.insertBefore(el, el.parentElement.firstChild); }
      else if(p==='remove'){ el.remove(); }
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
    var img=document.createElement('img'); img.src=url;
    img.style.cssText='position:absolute;left:120px;top:120px;width:360px;height:auto;z-index:5';
    rootEl().appendChild(img);
    img.onload=function(){ paint(); serialize(); };
    sels=[img]; paint(); report(); serialize();
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
