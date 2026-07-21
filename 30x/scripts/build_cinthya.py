# -*- coding: utf-8 -*-
"""Reconstruye las 7 láminas de Cinthya con layouts limpios + contenido fiel, y las empuja por la API."""
import json, re, html as H, urllib.request

BASE="http://localhost:3001"
CID="2d187c1f-99a7-4ca3-a580-7651fd803c21"

def api(method, path, body=None):
    data=json.dumps(body).encode('utf-8') if body is not None else None
    req=urllib.request.Request(f"{BASE}{path}", data=data, method=method,
        headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req) as r: return json.loads(r.read().decode('utf-8'))

car=api('GET', f"/api/carousels/{CID}")

def text_lines(h=""):
    t=re.sub(r'(?is)<style.*?</style>',' ',h=='' and '' or h=='' and '' or h=='' or '' if False else hstr(h))
    return t
def hstr(h):
    t=re.sub(r'(?is)<style.*?</style>',' ',h)
    t=re.sub(r'(?i)</(div|p|h[1-6]|li|br|span)>','\n',t)
    t=re.sub(r'<[^>]+>',' ',t)
    t=H.unescape(t)
    L=[re.sub(r'\s+',' ',x).strip() for x in t.split('\n')]
    return [x for x in L if x and x not in ('+','↑','vs','✗','→','✓','“','”','—')]

# ── parseo del contenido por lámina ───────────────────────────────────────────
raw={}
for s in car['slides']:
    raw[s['order']+1]=hstr(s['html'])

def after(lines, label):
    for i,l in enumerate(lines):
        if l.strip().rstrip('”“ ').lower()==label.lower():
            return lines[i+1] if i+1<len(lines) else ''
    return ''

def parse_cmp(lines):
    # theme = línea con comillas (idx 1-2)
    theme=''
    for l in lines[:4]:
        if ' á' in l or 'Instant' in l or True:
            pass
    # el theme es el 2º o 3º item; buscamos el que NO es idx ni label
    cand=[l for l in lines[:4] if l not in ('“','”') and not re.fullmatch(r'\d{2}',l)]
    theme=cand[0].strip('“” ') if cand else ''
    d={'theme':theme}
    d['malo']=after(lines,'Prompt Malo')
    d['bueno']=after(lines,'Prompt Bueno')
    d['contexto']=after(lines,'Contexto')
    d['rol']=after(lines,'Rol')
    d['instruccion']=after(lines,'Instrucción')
    d['fmt_intro']=after(lines,'Formato')
    # lista de formato = items después de fmt_intro
    fl=[]
    hit=False
    for l in lines:
        if hit and l not in ('Formato',) and l!=d['fmt_intro']:
            if l==d['fmt_intro']: continue
            fl.append(l)
        if l==d['fmt_intro']: hit=True
    d['fmt_list']=[x for x in fl if x and 'Cinthya' not in x and not x.startswith('/') and not re.fullmatch(r'\d{2}',x)]
    return d

FONT='<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">'

def esc(s): return H.escape(s)

# ── PORTADA ───────────────────────────────────────────────────────────────────
def portada():
    rows=[('Malos','#e0d3ce','#6f605a'),('Buenos','#e5acbf','#5c3a47'),('Excelentes','#2A2320','#F6F5F0')]
    blocks=''
    for word,bg,fg in rows:
        blocks+=f'<div class="row"><span class="chip" style="background:{bg};color:{fg}">{word}</span><span class="pr">Prompts</span></div>'
    return f'''<!DOCTYPE html><html><head><meta charset="utf-8">{FONT}<style>
*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:1080px;height:1350px;overflow:hidden}}
.s{{width:1080px;height:1350px;position:relative;overflow:hidden;background:#F6F5F0;color:#2A2320;font-family:'Inter',sans-serif;padding:80px 74px;display:flex;flex-direction:column}}
.glow{{position:absolute;top:-160px;right:-160px;width:700px;height:700px;border-radius:50%;background:radial-gradient(circle at 50% 50%,rgba(229,172,191,.5),rgba(229,172,191,0) 66%)}}
.top{{position:relative;z-index:2;display:flex;justify-content:space-between;align-items:center}}
.logo{{height:44px}} .idx{{font-family:'Instrument Serif',serif;font-size:38px;color:#C77E97}}
.kick{{position:relative;z-index:2;margin-top:70px;font-size:23px;font-weight:800;letter-spacing:4px;text-transform:uppercase;color:#C77E97}}
.mid{{position:relative;z-index:2;flex:1;display:flex;flex-direction:column;justify-content:center;gap:14px}}
.row{{display:flex;align-items:center;gap:26px}}
.chip{{font-family:'Instrument Serif',serif;font-size:60px;line-height:1;padding:8px 32px;border-radius:16px}}
.pr{{font-family:'Instrument Serif',serif;font-size:120px;line-height:.95;color:#2A2320}}
.sub{{position:relative;z-index:2;font-size:30px;font-weight:500;line-height:1.35;color:#4a3f3a;max-width:780px}}
.sub b{{color:#2A2320;font-weight:700}}
.foot{{position:relative;z-index:2;margin-top:38px;display:flex;justify-content:space-between;align-items:center}}
.sign{{font-family:'Instrument Serif',serif;font-style:italic;font-size:38px}} .sw{{font-size:22px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:#C77E97}}
</style></head><body><div class="s"><div class="glow"></div>
<div class="top"><img class="logo" src="/uploads/brand/30x-negro.png"><span class="idx">01</span></div>
<div class="kick">CIO · Ex-Microsoft · Sensei de IA</div>
<div class="mid">{blocks}</div>
<div class="sub">La escalera de prompting que separa a quien <b>le pregunta</b> a la IA de quien <b>la dirige</b>.</div>
<div class="foot"><span class="sign">/ Cinthya Sánchez.</span><span class="sw">Desliza →</span></div>
</div></body></html>'''

# ── COMPARACIÓN (malo/bueno/excelente) ────────────────────────────────────────
def comparacion(idx, d):
    fl=d['fmt_list']
    cols=''.join(f'<span class="fi">{esc(x)}</span>' for x in fl)
    return f'''<!DOCTYPE html><html><head><meta charset="utf-8">{FONT}<style>
*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:1080px;height:1350px;overflow:hidden}}
.s{{width:1080px;height:1350px;position:relative;overflow:hidden;background:#F6F5F0;color:#2A2320;font-family:'Inter',sans-serif;padding:64px 62px 56px;display:flex;flex-direction:column}}
.glow{{position:absolute;top:-170px;right:-170px;width:600px;height:600px;border-radius:50%;background:radial-gradient(circle at 50% 50%,rgba(229,172,191,.45),rgba(229,172,191,0) 66%)}}
.top{{position:relative;z-index:2;display:flex;justify-content:space-between;align-items:flex-start}}
.logo{{height:34px}} .idx{{font-family:'Instrument Serif',serif;font-size:34px;color:#C77E97}}
.kick{{position:relative;z-index:2;margin-top:16px;font-size:19px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:#C77E97}}
.title{{position:relative;z-index:2;font-family:'Instrument Serif',serif;font-size:74px;line-height:1;margin-top:2px}}
.lad{{position:relative;z-index:2;margin-top:26px;display:flex;flex-direction:column;gap:16px}}
.card{{border-radius:20px;padding:22px 28px}}
.lab{{display:flex;align-items:center;gap:11px;font-size:21px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:9px}}
.mk{{width:30px;height:30px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:17px;font-weight:800}}
.card p{{font-size:30px;line-height:1.3;font-weight:500}}
.malo{{background:#efe7e4;border:1.5px solid #e0d3ce}}.malo .lab{{color:#a98d84}}.malo .mk{{background:#d8c3bc;color:#7a5f57}}.malo p{{color:#6f605a}}
.bueno{{background:#f3e4ea;border:1.5px solid #e9cdd8}}.bueno .lab{{color:#b06d88}}.bueno .mk{{background:#e5acbf;color:#5c3a47}}.bueno p{{color:#4a3f3a}}
.exc{{background:#2A2320;color:#F6F5F0;padding:26px 30px}}
.exc .lab{{color:#E5ACBF;margin-bottom:14px}}.exc .mk{{background:#E5ACBF;color:#2A2320}}
.grid{{display:grid;grid-template-columns:auto 1fr;gap:11px 20px;font-size:26px;line-height:1.3}}
.k{{font-weight:800;color:#E5ACBF;white-space:nowrap}}.v{{color:#eae2df;font-weight:500}}
.fmtl{{grid-column:1/3;margin-top:8px;display:flex;flex-wrap:wrap;gap:9px 12px}}
.fi{{font-size:22px;background:rgba(229,172,191,.16);color:#f3dde5;padding:6px 16px;border-radius:22px;font-weight:600}}
.foot{{position:relative;z-index:2;margin-top:auto;padding-top:20px;font-family:'Instrument Serif',serif;font-style:italic;font-size:30px}}
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
</div></div>
</div>
<div class="foot">/ Cinthya Sánchez.</div>
</div></body></html>'''

# ── CIERRE ────────────────────────────────────────────────────────────────────
def cierre():
    return f'''<!DOCTYPE html><html><head><meta charset="utf-8">{FONT}<style>
*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:1080px;height:1350px;overflow:hidden}}
.s{{width:1080px;height:1350px;position:relative;overflow:hidden;background:#F6F5F0;color:#2A2320;font-family:'Inter',sans-serif;padding:80px 74px;display:flex;flex-direction:column;align-items:center;text-align:center}}
.glow{{position:absolute;bottom:-240px;left:50%;transform:translateX(-50%);width:1000px;height:700px;background:radial-gradient(circle at 50% 100%,rgba(229,172,191,.55),rgba(229,172,191,0) 68%)}}
.top{{position:relative;z-index:2;width:100%;display:flex;justify-content:space-between;align-items:center}}
.logo{{height:42px}} .idx{{font-family:'Instrument Serif',serif;font-size:38px;color:#C77E97}}
.mid{{position:relative;z-index:2;flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:30px}}
.comenta{{display:flex;gap:14px}}
.cb{{font-family:'Instrument Serif',serif;font-size:78px;line-height:1;padding:6px 28px;border-radius:14px}}
.cb1{{background:#e5acbf;color:#5c3a47}}.cb2{{background:#2A2320;color:#F6F5F0}}
.big{{font-family:'Instrument Serif',serif;font-size:74px;line-height:1.06;color:#2A2320}}
.big .em{{font-style:italic;color:#C77E97}}
.body{{font-size:30px;line-height:1.4;font-weight:500;color:#4a3f3a;max-width:760px}}.body b{{color:#2A2320;font-weight:700}}
.foot{{position:relative;z-index:2}}
.sign{{font-family:'Instrument Serif',serif;font-style:italic;font-size:46px}}
.hd{{margin-top:8px;font-size:22px;font-weight:700;letter-spacing:1px;color:#8a7d76}}
</style></head><body><div class="s"><div class="glow"></div>
<div class="top"><img class="logo" src="/uploads/brand/30x-negro.png"><span class="idx">07</span></div>
<div class="mid">
<div class="comenta"><span class="cb cb1">Comenta</span><span class="cb cb2">IA</span></div>
<div class="big">No necesitas publicar más.<br><span class="em">Necesitas convertir mejor.</span></div>
<div class="body">Si quieres convertir tu contenido en conversaciones y tus conversaciones en clientes, <b>comenta IA</b>. Te enseño a usar IA para crear contenido con intención, mejorar tu oferta y vender sin improvisar.</div>
</div>
<div class="foot"><div class="sign">/ Cinthya Sánchez.</div><div class="hd">30X · Executive Education</div></div>
</div></body></html>'''

# ── construir + empujar (contenido desde JSON estable) ────────────────────────
content=json.load(open('content.json',encoding='utf-8'))
htmls=[portada()]
for i in range(2,7):
    htmls.append(comparacion(i, content[str(i)]))
htmls.append(cierre())

# borrar actuales
for s in car['slides']:
    api('DELETE', f"/api/carousels/{CID}/slides/{s['id']}")
# crear nuevas
for i,h in enumerate(htmls):
    api('POST', f"/api/carousels/{CID}/slides", {'html':h,'notes':f'lamina {i+1}'})
print("OK: 7 laminas reconstruidas")
