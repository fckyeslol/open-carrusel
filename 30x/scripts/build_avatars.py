# -*- coding: utf-8 -*-
"""Genera el carrusel de PROMPTS (mismo layout+contenido que Cinthya) para cada avenger,
cambiando SOLO su identidad: fuente, paleta, logo, rol, firma. Uso:
    python build_avatars.py guillermo        # uno solo (test)
    python build_avatars.py ALL              # los 7 restantes
"""
import json, re, html as H, urllib.request, sys

BASE="http://localhost:3001"

# ── identidad por avatar (de su ADN) ──────────────────────────────────────────
AV={
 "guillermo":     dict(name="Guillermo Jaramillo", font="Open Sans",         dark="#242424", accent="#FFD400",
                       role="Transformador digital · Former CEO KPMG Colombia", firma="30X / Guillermo Jaramillo"),
 "daniel-bilbao": dict(name="Daniel Bilbao",       font="Arimo",             dark="#0C1030", accent="#3A34E0",
                       role="CEO @Truora · Ecosistema Tech LatAm",            firma="Daniel Bilbao."),
 "andres":        dict(name="Andrés Bilbao",       font="Inter",             dark="#15142B", accent="#EBFF6F",
                       role="Co-founder Rappi · Co-founder 30X · Inversionista", firma="Andrés Bilbao."),
 "dylan-rosemberg":dict(name="Dylan Rosemberg",    font="Bricolage Grotesque",dark="#1E010B", accent="#F92424",
                       role="Founder @Growthrockstar · Co-founder Crece30X",   firma="Dylan Rosemberg."),
 "maria-jose":    dict(name="María José Echeverri", font="Poppins",           dark="#5A4633", accent="#F0EF9F",
                       role="Founder ColombiaTech Week",                       firma="María José Echeverri."),
 "alejandra-deik":dict(name="Alejandra Deik",      font="Playfair Display",  dark="#1B1233", accent="#15868E",
                       role="Ex Manager B2B Frubana",                         firma="Alejandra Deik."),
 "liz":           dict(name="Liz Hernández",       font="Nunito Sans",       dark="#000000", accent="#8177FE",
                       role="Founder @Morelatam · AI Summit LatAm",           firma="Liz Hernández."),
}
BG="#F6F5F0"

# ── helpers de color ──────────────────────────────────────────────────────────
def rgb(h):
    h=h.lstrip('#'); return tuple(int(h[i:i+2],16) for i in (0,2,4))
def hexof(t): return '#%02x%02x%02x'%tuple(max(0,min(255,int(round(x)))) for x in t)
def lum(h):
    r,g,b=rgb(h); return (0.2126*r+0.7152*g+0.0722*b)/255
def mix(h, amt):   # amt>0 → hacia blanco; amt<0 → hacia negro
    r,g,b=rgb(h); t=255 if amt>=0 else 0; a=abs(amt)
    return hexof((r+(t-r)*a, g+(t-g)*a, b+(t-b)*a))
def darken_to(h, target):
    c=h
    for _ in range(24):
        if lum(c)<=target: break
        c=mix(c,-0.06)
    return c
def lighten_to(h, target):
    c=h
    for _ in range(24):
        if lum(c)>=target: break
        c=mix(c,0.06)
    return c
def on(c):  # color de texto legible SOBRE c
    return "#1c1712" if lum(c)>0.55 else "#FFFFFF"
def rgba(h,a):
    r,g,b=rgb(h); return f"rgba({r},{g},{b},{a})"

def palette(cfg):
    dark=cfg['dark']; acc=cfg['accent']
    p=dict(bg=BG, dark=dark, accent=acc, cream="#EDE7E2")
    p['acc_txt']  = acc if lum(acc)<=0.5 else darken_to(acc,0.42)   # acento como texto sobre claro
    p['acc_ondark']= acc if lum(acc)>=lum(dark)+0.34 else lighten_to(acc,0.66)  # acento sobre la tarjeta oscura
    p['acc_fi']   = lighten_to(p['acc_ondark'],0.80)
    # malo (neutro claro)
    p['malo_bg']=mix(dark,0.90); p['malo_bd']=mix(dark,0.82); p['malo_lab']=mix(dark,0.46)
    p['malo_mkb']=mix(dark,0.74); p['malo_mkf']=mix(dark,0.34); p['malo_p']=mix(dark,0.42)
    # bueno (tinte de acento)
    p['bueno_bg']=mix(acc,0.84); p['bueno_bd']=mix(acc,0.60); p['bueno_p']=mix(dark,0.18)
    return p

FONT_TMPL="https://fonts.googleapis.com/css2?family={fam}:ital,wght@0,400;0,600;0,700;0,800;1,400;1,600&family=Inter:wght@400;500;600;700;800&display=swap"
def fontlink(fam):
    return f'<link href="{FONT_TMPL.format(fam=fam.replace(" ","+"))}" rel="stylesheet">'
def esc(s): return H.escape(s)

# ── plantillas (idénticas a las de Cinthya, con variables de identidad) ────────
def portada(cfg,p):
    F=cfg['font']; rows=[("Malos",p['malo_bd'],p['malo_p']),("Buenos",p['accent'],on(p['accent'])),("Excelentes",p['dark'],p['bg'])]
    blocks=''.join(f'<div class="row"><span class="chip" style="background:{bg};color:{fg}">{w}</span><span class="pr">Prompts</span></div>' for w,bg,fg in rows)
    return f'''<!DOCTYPE html><html><head><meta charset="utf-8">{fontlink(F)}<style>
*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:1080px;height:1350px;overflow:hidden}}
.s{{width:1080px;height:1350px;position:relative;overflow:hidden;background:{p['bg']};color:{p['dark']};font-family:'Inter',sans-serif;padding:80px 74px;display:flex;flex-direction:column}}
.glow{{position:absolute;top:-160px;right:-160px;width:700px;height:700px;border-radius:50%;background:radial-gradient(circle at 50% 50%,{rgba(p['accent'],.45)},{rgba(p['accent'],0)} 66%)}}
.top{{position:relative;z-index:2;display:flex;justify-content:space-between;align-items:center}}
.logo{{height:44px}} .idx{{font-family:'{F}',serif;font-size:38px;color:{p['acc_txt']}}}
.kick{{position:relative;z-index:2;margin-top:70px;font-size:22px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:{p['acc_txt']}}}
.mid{{position:relative;z-index:2;flex:1;display:flex;flex-direction:column;justify-content:center;gap:16px}}
.row{{display:flex;align-items:center;gap:26px}}
.chip{{font-family:'{F}',serif;font-size:58px;line-height:1;padding:8px 30px;border-radius:16px}}
.pr{{font-family:'{F}',serif;font-size:118px;line-height:.95;color:{p['dark']}}}
.sub{{position:relative;z-index:2;font-size:30px;font-weight:500;line-height:1.35;color:{mix(p['dark'],.25)};max-width:800px}}
.sub b{{color:{p['dark']};font-weight:700}}
.foot{{position:relative;z-index:2;margin-top:38px;display:flex;justify-content:space-between;align-items:center}}
.sign{{font-family:'{F}',serif;font-style:italic;font-size:38px}} .sw{{font-size:22px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:{p['acc_txt']}}}
</style></head><body><div class="s"><div class="glow"></div>
<div class="top"><img class="logo" src="/uploads/brand/30x-negro.png"><span class="idx">01</span></div>
<div class="kick">{esc(cfg['role'])}</div>
<div class="mid">{blocks}</div>
<div class="sub">La escalera de prompting que separa a quien <b>le pregunta</b> a la IA de quien <b>la dirige</b>.</div>
<div class="foot"><span class="sign">/ {esc(cfg['name'])}.</span><span class="sw">Desliza →</span></div>
</div></body></html>'''

def comparacion(cfg,p,idx,d):
    F=cfg['font']
    cols=''.join(f'<span class="fi">{esc(x)}</span>' for x in d['fmt_list'])
    return f'''<!DOCTYPE html><html><head><meta charset="utf-8">{fontlink(F)}<style>
*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:1080px;height:1350px;overflow:hidden}}
.s{{width:1080px;height:1350px;position:relative;overflow:hidden;background:{p['bg']};color:{p['dark']};font-family:'Inter',sans-serif;padding:64px 62px 56px;display:flex;flex-direction:column}}
.glow{{position:absolute;top:-170px;right:-170px;width:600px;height:600px;border-radius:50%;background:radial-gradient(circle at 50% 50%,{rgba(p['accent'],.4)},{rgba(p['accent'],0)} 66%)}}
.top{{position:relative;z-index:2;display:flex;justify-content:space-between;align-items:flex-start}}
.logo{{height:34px}} .idx{{font-family:'{F}',serif;font-size:34px;color:{p['acc_txt']}}}
.kick{{position:relative;z-index:2;margin-top:16px;font-size:19px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:{p['acc_txt']}}}
.title{{position:relative;z-index:2;font-family:'{F}',serif;font-size:74px;line-height:1;margin-top:2px}}
.lad{{position:relative;z-index:2;margin-top:26px;display:flex;flex-direction:column;gap:16px}}
.card{{border-radius:20px;padding:22px 28px}}
.lab{{display:flex;align-items:center;gap:11px;font-size:21px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:9px}}
.mk{{width:30px;height:30px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:17px;font-weight:800}}
.card p{{font-size:30px;line-height:1.3;font-weight:500}}
.malo{{background:{p['malo_bg']};border:1.5px solid {p['malo_bd']}}}.malo .lab{{color:{p['malo_lab']}}}.malo .mk{{background:{p['malo_mkb']};color:{p['malo_mkf']}}}.malo p{{color:{p['malo_p']}}}
.bueno{{background:{p['bueno_bg']};border:1.5px solid {p['bueno_bd']}}}.bueno .lab{{color:{p['acc_txt']}}}.bueno .mk{{background:{p['accent']};color:{on(p['accent'])}}}.bueno p{{color:{p['bueno_p']}}}
.exc{{background:{p['dark']};color:{p['cream']};padding:26px 30px}}
.exc .lab{{color:{p['acc_ondark']};margin-bottom:14px}}.exc .mk{{background:{p['acc_ondark']};color:{on(p['acc_ondark'])}}}
.grid{{display:grid;grid-template-columns:auto 1fr;gap:11px 20px;font-size:26px;line-height:1.3}}
.k{{font-weight:800;color:{p['acc_ondark']};white-space:nowrap}}.v{{color:{p['cream']};font-weight:500}}
.fmtl{{grid-column:1/3;margin-top:8px;display:flex;flex-wrap:wrap;gap:9px 12px}}
.fi{{font-size:22px;background:{rgba(p['accent'],.18)};color:{p['acc_fi']};padding:6px 16px;border-radius:22px;font-weight:600}}
.foot{{position:relative;z-index:2;margin-top:auto;padding-top:20px;font-family:'{F}',serif;font-style:italic;font-size:30px}}
</style></head><body><div class="s"><div class="glow"></div>
<div class="top"><img class="logo" src="/uploads/brand/30x-negro.png"><span class="idx">{idx:02d}</span></div>
<div class="kick">Prompt: malo → bueno → excelente</div>
<div class="title">{esc(d['theme'])}</div>
<div class="lad">
<div class="card malo"><div class="lab"><span class="mk">✗</span>Prompt malo</div><p>{esc(d['malo'])}</p></div>
<div class="card bueno"><div class="lab"><span class="mk">→</span>Prompt bueno</div><p>{esc(d['bueno'])}</p></div>
<div class="card exc"><div class="lab"><span class="mk">✓</span>Prompt excelente</div>
<div class="grid">
<span class="k">Contexto</span><span class="v">{esc(d['contexto'])}</span>
<span class="k">Rol</span><span class="v">{esc(d['rol'])}</span>
<span class="k">Instrucción</span><span class="v">{esc(d['instruccion'])}</span>
<span class="k">Formato</span><span class="v">{esc(d['fmt_intro'])}</span>
<div class="fmtl">{cols}</div>
</div></div></div>
<div class="foot">/ {esc(cfg['name'])}.</div>
</div></body></html>'''

def cierre(cfg,p):
    F=cfg['font']
    return f'''<!DOCTYPE html><html><head><meta charset="utf-8">{fontlink(F)}<style>
*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:1080px;height:1350px;overflow:hidden}}
.s{{width:1080px;height:1350px;position:relative;overflow:hidden;background:{p['bg']};color:{p['dark']};font-family:'Inter',sans-serif;padding:80px 74px;display:flex;flex-direction:column;align-items:center;text-align:center}}
.glow{{position:absolute;bottom:-240px;left:50%;transform:translateX(-50%);width:1000px;height:700px;background:radial-gradient(circle at 50% 100%,{rgba(p['accent'],.5)},{rgba(p['accent'],0)} 68%)}}
.top{{position:relative;z-index:2;width:100%;display:flex;justify-content:space-between;align-items:center}}
.logo{{height:42px}} .idx{{font-family:'{F}',serif;font-size:38px;color:{p['acc_txt']}}}
.mid{{position:relative;z-index:2;flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:30px}}
.comenta{{display:flex;gap:14px}}
.cb{{font-family:'{F}',serif;font-size:76px;line-height:1;padding:6px 26px;border-radius:14px}}
.cb1{{background:{p['accent']};color:{on(p['accent'])}}}.cb2{{background:{p['dark']};color:{p['bg']}}}
.big{{font-family:'{F}',serif;font-size:72px;line-height:1.07;color:{p['dark']}}}.big .em{{font-style:italic;color:{p['acc_txt']}}}
.body{{font-size:30px;line-height:1.4;font-weight:500;color:{mix(p['dark'],.25)};max-width:770px}}.body b{{color:{p['dark']};font-weight:700}}
.foot{{position:relative;z-index:2}} .sign{{font-family:'{F}',serif;font-style:italic;font-size:46px}}
.hd{{margin-top:8px;font-size:22px;font-weight:700;letter-spacing:1px;color:{mix(p['dark'],.45)}}}
</style></head><body><div class="s"><div class="glow"></div>
<div class="top"><img class="logo" src="/uploads/brand/30x-negro.png"><span class="idx">07</span></div>
<div class="mid">
<div class="comenta"><span class="cb cb1">Comenta</span><span class="cb cb2">IA</span></div>
<div class="big">No necesitas publicar más.<br><span class="em">Necesitas convertir mejor.</span></div>
<div class="body">Si quieres convertir tu contenido en conversaciones y tus conversaciones en clientes, <b>comenta IA</b>. Te enseño a usar la IA con intención para crear mejor, ofrecer mejor y vender sin improvisar.</div>
</div>
<div class="foot"><div class="sign">/ {esc(cfg['name'])}.</div><div class="hd">30X · Executive Education</div></div>
</div></body></html>'''

# ── API ───────────────────────────────────────────────────────────────────────
def api(method,path,body=None):
    data=json.dumps(body).encode('utf-8') if body is not None else None
    req=urllib.request.Request(f"{BASE}{path}",data=data,method=method,headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req) as r: return json.loads(r.read().decode('utf-8'))

def build_for(slug):
    cfg=AV[slug]; p=palette(cfg)
    content=json.load(open('content.json',encoding='utf-8'))
    htmls=[portada(cfg,p)]+[comparacion(cfg,p,i,content[str(i)]) for i in range(2,7)]+[cierre(cfg,p)]
    # crear carrusel
    car=api('POST','/api/carousels',{'name':f"30X — {cfg['name']} — Prompts",'aspectRatio':'4:5'})
    cid=car['id'] if 'id' in car else car.get('carousel',{}).get('id')
    for i,h in enumerate(htmls):
        api('POST',f"/api/carousels/{cid}/slides",{'html':h,'notes':f'lamina {i+1}'})
    print(f"{slug}: carrusel {cid}")
    return cid

if __name__=='__main__':
    which=sys.argv[1] if len(sys.argv)>1 else 'ALL'
    slugs=list(AV.keys()) if which=='ALL' else [which]
    ids={}
    for s in slugs: ids[s]=build_for(s)
    open('avatar_carousels.json','w').write(json.dumps(ids))
