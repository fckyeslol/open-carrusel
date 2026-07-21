# -*- coding: utf-8 -*-
"""CALCO del referente de prompts para cada avatar. Reproduce el layout del referente
(papel, pinceladas rugosas, UI de chat, bloques sólidos, flecha a mano, serif gigante),
cambiando SOLO la fuente y los colores del avatar. Uso: python build_calco.py <slug|ALL>"""
import json, html as H, urllib.request, sys
BASE="http://localhost:3001"

# 3 pinceladas (malo,bueno,excelente) + dark + fuente, por avatar
AV={
 "cinthya":        dict(name="Cinthya Sánchez", font="Instrument Serif", dark="#2A2320", C=["#F68F6E","#E5ACBF","#C77E97"]),
 "guillermo":      dict(name="Guillermo Jaramillo", font="Open Sans",    dark="#242424", C=["#FFD84D","#F5C518","#C79A00"]),
 "daniel-bilbao":  dict(name="Daniel Bilbao", font="Arimo",              dark="#0C1030", C=["#7B79E8","#3A34E0","#221E9E"]),
 "andres":         dict(name="Andrés Bilbao", font="Inter",              dark="#15142B", C=["#F0412A","#FF791A","#EBFF6F"]),
 "dylan-rosemberg":dict(name="Dylan Rosemberg", font="Bricolage Grotesque", dark="#1E010B", C=["#FF6B4A","#F92424","#B3121C"]),
 "maria-jose":     dict(name="María José Echeverri", font="Poppins",     dark="#5A4633", C=["#E9E39A","#DFCB6E","#B79246"]),
 "alejandra-deik": dict(name="Alejandra Deik", font="Playfair Display",  dark="#1B1233", C=["#3FB0B8","#15868E","#0B2D72"]),
 "liz":            dict(name="Liz Hernández", font="Nunito Sans",        dark="#000000", C=["#A79FFF","#8177FE","#5B50D6"]),
}
PAPER="#F4F3EE"

def rgb(h):
    h=h.lstrip('#'); return tuple(int(h[i:i+2],16) for i in (0,2,4))
def hx(t): return '#%02x%02x%02x'%tuple(max(0,min(255,int(round(x)))) for x in t)
def lum(h):
    r,g,b=rgb(h); return (0.2126*r+0.7152*g+0.0722*b)/255
def mix(h,a):
    r,g,b=rgb(h); t=255 if a>=0 else 0; a=abs(a); return hx((r+(t-r)*a,g+(t-g)*a,b+(t-b)*a))
def on(h): return "#241E1B" if lum(h)>0.55 else "#F6F5F0"
def readable(h):  # versión legible sobre papel claro
    c=h
    while lum(c)>0.52: c=mix(c,-0.06)
    return c
def esc(s): return H.escape(s)
def fontlink(fam):
    return f'<link href="https://fonts.googleapis.com/css2?family={fam.replace(" ","+")}:ital,wght@0,400;0,600;0,700;0,800;1,400&family=Inter:wght@400;500;600;700&family=Instrument+Serif&display=swap" rel="stylesheet">'

PAP='<svg class="paper" width="1080" height="1350"><filter id="pap"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.09"/></feComponentTransfer></filter><rect width="1080" height="1350" filter="url(#pap)"/></svg>'
BRUSH='<svg width="0" height="0"><defs><filter id="brush"><feTurbulence type="fractalNoise" baseFrequency="0.015 0.13" numOctaves="2" seed="6" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="34" xChannelSelector="R" yChannelSelector="G"/></filter></defs></svg>'
MIC='<svg width="26" height="34" viewBox="0 0 24 32" fill="none" stroke="#6f635c" stroke-width="2"><rect x="8" y="2" width="8" height="16" rx="4"/><path d="M4 14a8 8 0 0 0 16 0M12 22v6M8 30h8"/></svg>'
def SEND(dk): return f'<div class="send" style="background:{dk}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#F6F5F0" stroke-width="2.5"><path d="M12 20V5M6 11l6-6 6 6"/></svg></div>'

def head(cfg): return f'<!DOCTYPE html><html><head><meta charset="utf-8">{fontlink(cfg["font"])}'

def portada(cfg):
    F=cfg['font']; D=cfg['dark']; C=cfg['C']
    def grp(word,color,idx):
        wc=on(color)
        return f'<div class="group"><div class="sw"><svg class="bl" width="820" height="150"><rect x="90" y="35" width="640" height="80" rx="10" fill="{color}" filter="url(#brush)"/></svg><span class="word" style="color:{wc}">{word}</span></div><div class="big">Prompts</div></div>'
    div='<div class="divider"><span class="dl"></span><span class="vs">vs</span><span class="dl"></span></div>'
    return f'''{head(cfg)}<style>
*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:1080px;height:1350px;overflow:hidden}}
.s{{width:1080px;height:1350px;position:relative;overflow:hidden;background:{PAPER};font-family:'{F}',serif;color:{D}}}
.paper{{position:absolute;inset:0;opacity:.5;mix-blend-mode:multiply}}
.stack{{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:36px}}
.group{{text-align:center;width:100%}}
.sw{{position:relative;display:inline-block;margin-bottom:-20px}}
.bl{{position:absolute;left:50%;top:52%;transform:translate(-50%,-50%);z-index:0}}
.word{{position:relative;z-index:1;font-size:78px;line-height:1;padding:0 30px}}
.big{{font-size:170px;line-height:.92;color:{mix(D,-0.02)};letter-spacing:-2px}}
.divider{{display:flex;align-items:center;justify-content:center;width:100%;margin:4px 0}}
.dl{{flex:1;border-top:3px dotted {D};opacity:.55}}
.vs{{border:2px solid {D};font-size:30px;font-style:italic;padding:3px 15px;margin:0 14px;font-family:'Instrument Serif',serif}}
</style></head><body><div class="s">{PAP}{BRUSH}<div class="stack">
{grp("Malos",C[0],0)}{div}{grp("Buenos",C[1],1)}{div}{grp("Excelentes",C[2],2)}
</div></div></body></html>'''

def contenido(cfg, idx, d):
    F=cfg['font']; D=cfg['dark']; C=cfg['C']
    def lbl(text,color):
        return f'<div class="lbl"><svg width="560" height="90"><rect x="60" y="24" width="440" height="46" rx="8" fill="{color}" filter="url(#brush)"/></svg><span style="color:{on(color)}">{text}</span></div>'
    def card(color,inner,exc=False):
        return f'<div class="card{" exc" if exc else ""}" style="background:{mix(color,.86)};border:1.5px solid {mix(color,.6)}">{inner}</div>'
    tools=f'<div class="tools">{MIC}{SEND(D)}</div>'
    malo=card(C[0], f'<div class="txt">{esc(d["malo"])}</div><div class="plus">+</div>{tools}')
    bueno=card(C[1], f'<div class="txt">{esc(d["bueno"])}</div><div class="plus">+</div>{tools}')
    items=''.join(f'<li>{esc(x)}</li>' for x in d['fmt_list'])
    exc_inner=(f'<div class="sec"><b>Contexto</b><p>{esc(d["contexto"])}</p></div>'
               f'<div class="sec"><b>Rol</b><p>{esc(d["rol"])}</p></div>'
               f'<div class="sec"><b>Instrucción</b><p>{esc(d["instruccion"])}</p></div>'
               f'<div class="sec"><b>Formato</b><p>{esc(d["fmt_intro"])}</p><ol>{items}</ol></div>')
    exc=card(C[2], exc_inner, True)
    return f'''{head(cfg)}<style>
*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:1080px;height:1350px;overflow:hidden}}
.s{{width:1080px;height:1350px;position:relative;overflow:hidden;background:{PAPER};color:{D};font-family:'Inter',sans-serif;padding:40px 58px 30px}}
.paper{{position:absolute;inset:0;opacity:.5;mix-blend-mode:multiply}}
.wrap{{position:relative;z-index:2}}
.title{{text-align:center;font-family:'{F}',serif;font-size:84px;line-height:.98;letter-spacing:-1px;margin-bottom:4px}}
.lbl{{position:relative;display:block;width:max-content;margin:0 auto 5px;font-family:'{F}',serif;font-size:42px;padding:2px 40px}}
.lbl svg{{position:absolute;left:50%;top:54%;transform:translate(-50%,-50%);z-index:0}}.lbl span{{position:relative;z-index:1}}
.card{{border-radius:26px;padding:22px 30px 52px;position:relative;margin-bottom:10px}}
.card .txt{{font-size:28px;line-height:1.3;font-weight:500;color:{D}}}
.plus{{position:absolute;left:28px;bottom:12px;font-size:38px;color:#9a8f88;font-weight:300;line-height:1}}
.tools{{position:absolute;right:26px;bottom:14px;display:flex;align-items:center;gap:18px}}
.send{{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center}}
.exc{{padding:22px 30px 24px}}
.sec{{margin-bottom:9px}}.sec b{{display:block;font-size:24px;font-weight:800;margin-bottom:1px;color:{D}}}.sec p{{font-size:24px;line-height:1.26;font-weight:500;color:{D}}}
.sec ol{{margin:1px 0 0 6px;padding-left:26px;font-size:23px;line-height:1.3;font-weight:500;color:{D}}}
.swipe{{position:absolute;right:44px;bottom:26px;z-index:3}}
</style></head><body><div class="s">{PAP}{BRUSH}<div class="wrap">
<div class="title">&ldquo;{esc(d["theme"])}&rdquo;</div>
{lbl("Prompt Malo",C[0])}{malo}<div class="dot" style="height:2px;border-top:2px dotted #b8aca4;margin:9px 0"></div>
{lbl("Prompt Bueno",C[1])}{bueno}<div class="dot" style="height:2px;border-top:2px dotted #b8aca4;margin:9px 0"></div>
{lbl("Prompt Excelente",C[2])}{exc}
</div>
<svg class="swipe" width="90" height="70" viewBox="0 0 90 70" fill="none" stroke="{D}" stroke-width="4" stroke-linecap="round"><path d="M8 20c30-6 55 2 66 20"/><path d="M60 24l16 16-22 6"/></svg>
</div></body></html>'''

def cierre(cfg):
    F=cfg['font']; D=cfg['dark']; C=cfg['C']
    em=readable(C[2]); b1=C[1]
    return f'''{head(cfg)}<style>
*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:1080px;height:1350px;overflow:hidden}}
.s{{width:1080px;height:1350px;position:relative;overflow:hidden;background:{PAPER};color:{D};font-family:'{F}',serif;padding:78px 70px 60px}}
.paper{{position:absolute;inset:0;opacity:.5;mix-blend-mode:multiply}}
.wrap{{position:relative;z-index:2;height:100%;display:flex;flex-direction:column;align-items:center}}
.blocks{{display:flex;align-self:flex-start;margin-left:8px}}
.blk{{font-size:146px;line-height:1;letter-spacing:1px;padding:6px 30px 18px}}
.b1{{background:{b1};color:{on(b1)}}}.b2{{background:{D};color:{PAPER}}}
.arrow{{position:absolute;right:34px;top:262px;z-index:3}}
.lead{{text-align:center;font-size:56px;line-height:1.16;margin-top:50px;max-width:640px}}
.card{{margin-top:52px;width:680px;background:{mix(C[2],.88)};border:1.5px solid {mix(C[2],.6)};border-radius:26px;padding:38px 50px;text-align:center}}
.bubble{{display:flex;justify-content:center;margin-bottom:6px}}
.cdiv{{width:120px;height:2px;background:{mix(C[2],.3)};margin:6px auto 18px}}
.card p{{font-size:48px;line-height:1.2}}
.close{{margin-top:70px;margin-bottom:auto;text-align:center;font-size:70px;line-height:1.08}}
.em{{font-style:italic;color:{em}}}
</style></head><body><div class="s">{PAP}<div class="wrap">
<div class="blocks"><span class="blk b1">COMENTA</span><span class="blk b2">IA</span></div>
<svg class="arrow" width="120" height="250" viewBox="0 0 120 250" fill="none" stroke="{D}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M92 244C116 168 104 74 54 26"/><path d="M26 40l26-16 14 30"/></svg>
<div class="lead">Si quieres convertir tu contenido en conversaciones y tus conversaciones en clientes, comenta IA.</div>
<div class="card"><div class="bubble"><svg width="66" height="60" viewBox="0 0 66 60" fill="none" stroke="{em}" stroke-width="3.5"><path d="M8 8h50a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4H30l-14 12v-12H8a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4Z"/><circle cx="24" cy="26" r="2.5" fill="{em}" stroke="none"/><circle cx="33" cy="26" r="2.5" fill="{em}" stroke="none"/><circle cx="42" cy="26" r="2.5" fill="{em}" stroke="none"/></svg></div><div class="cdiv"></div>
<p>Te enseño a usar <b>IA</b> para crear contenido con <b>intención</b>, mejorar tu oferta y vender sin improvisar.</p></div>
<div class="close">No necesitas publicar más.<br><span class="em">Necesitas convertir mejor.</span></div>
</div></div></body></html>'''

def api(method,path,body=None):
    data=json.dumps(body).encode('utf-8') if body is not None else None
    req=urllib.request.Request(f"{BASE}{path}",data=data,method=method,headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req) as r: return json.loads(r.read().decode('utf-8'))

def build(slug):
    cfg=AV[slug]; content=json.load(open('content.json',encoding='utf-8'))
    htmls=[portada(cfg)]+[contenido(cfg,i,content[str(i)]) for i in range(2,7)]+[cierre(cfg)]
    car=api('POST','/api/carousels',{'name':f"CALCO — {cfg['name']} — Prompts",'aspectRatio':'4:5'})
    cid=car.get('id') or car.get('carousel',{}).get('id')
    for i,h in enumerate(htmls): api('POST',f"/api/carousels/{cid}/slides",{'html':h,'notes':f'l{i+1}'})
    print(f"{slug}: {cid}"); return cid

if __name__=='__main__':
    which=sys.argv[1] if len(sys.argv)>1 else 'ALL'
    slugs=list(AV.keys()) if which=='ALL' else [which]
    ids={s:build(s) for s in slugs}
    open('calco_carousels.json','w').write(json.dumps(ids))
