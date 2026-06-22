"""Recreate the 5 Claude tips slides — no emojis, CSS illustrations, proper spacing."""
import json, urllib.request, sys, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

BASE = "http://localhost:3001"
CAROUSEL_ID = "371978c4-557d-4954-bf7b-a43b9ad356c6"

SLIDES = [
    {
        "notes": "Slide 1 — Hook",
        "html": """<style>
  @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;900&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  .slide { width:1080px; height:1350px; background:#F5F0E8; font-family:'Nunito',sans-serif; position:relative; overflow:hidden; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:0; }
  .blob { position:absolute; border-radius:50%; }
  .b1 { width:420px; height:420px; background:radial-gradient(circle, rgba(232,101,26,0.13) 0%, transparent 70%); top:-100px; right:-100px; }
  .b2 { width:320px; height:320px; background:radial-gradient(circle, rgba(27,43,107,0.10) 0%, transparent 70%); bottom:-80px; left:-80px; }
  .b3 { width:200px; height:200px; background:radial-gradient(circle, rgba(232,101,26,0.08) 0%, transparent 70%); bottom:200px; right:60px; }
  .sp { position:absolute; color:#E8651A; font-weight:900; line-height:1; }
  .top-txt { font-size:36px; color:#1B2B6B; font-weight:700; text-align:center; margin-bottom:48px; letter-spacing:0.3px; }
  .keyword-box { background:linear-gradient(140deg, #E8651A 0%, #cf5812 100%); padding:52px 96px; border-radius:20px 6px 20px 6px; box-shadow:8px 10px 0 rgba(232,101,26,0.22); margin-bottom:48px; }
  .keyword { font-size:104px; color:#1B1B1B; font-weight:900; letter-spacing:8px; line-height:1; }
  .bottom-txt { font-size:32px; color:#1B2B6B; font-weight:600; text-align:center; font-style:italic; margin-bottom:56px; line-height:1.5; }
  .icons-row { display:flex; gap:48px; align-items:flex-end; margin-bottom:0; }
  .icon-item { display:flex; flex-direction:column; align-items:center; gap:12px; }
  .icon-shape { width:56px; height:56px; border-radius:12px; border:3px solid #E8651A; position:relative; }
  .icon-line { position:absolute; background:#E8651A; border-radius:2px; }
  .icon-lbl { font-size:18px; color:#1B2B6B; font-weight:700; }
  .arrow-down { font-size:52px; color:#E8651A; font-weight:900; margin-top:24px; line-height:1; }
  .handle { position:absolute; bottom:52px; font-size:22px; color:#E8651A; font-weight:700; text-decoration:underline; letter-spacing:0.5px; }
</style>
<div class="slide">
  <div class="blob b1"></div>
  <div class="blob b2"></div>
  <div class="blob b3"></div>
  <span class="sp" style="top:64px;left:88px;font-size:26px;opacity:0.7;">✦</span>
  <span class="sp" style="top:130px;right:180px;font-size:16px;opacity:0.5;">✦</span>
  <span class="sp" style="bottom:220px;left:130px;font-size:20px;opacity:0.6;">✦</span>
  <span class="sp" style="bottom:110px;right:220px;font-size:13px;opacity:0.5;">✦</span>

  <p class="top-txt">La mayoría lo usa mal.</p>

  <div class="keyword-box">
    <p class="keyword">CLAUDE</p>
  </div>

  <p class="bottom-txt">y te mando 5 tips para usarlo bien</p>

  <div class="icons-row">
    <div class="icon-item">
      <div class="icon-shape" style="border-radius:50%;">
        <div class="icon-line" style="width:24px;height:3px;top:24px;left:13px;"></div>
        <div class="icon-line" style="width:3px;height:24px;top:13px;left:24px;"></div>
      </div>
      <span class="icon-lbl">Piensa</span>
    </div>
    <div class="icon-item">
      <div class="icon-shape" style="border-radius:50% 50% 50% 0;">
        <div class="icon-line" style="width:28px;height:3px;top:16px;left:11px;"></div>
        <div class="icon-line" style="width:20px;height:3px;top:26px;left:11px;"></div>
      </div>
      <span class="icon-lbl">Dialoga</span>
    </div>
    <div class="icon-item">
      <div class="icon-shape">
        <div class="icon-line" style="width:28px;height:3px;top:14px;left:11px;"></div>
        <div class="icon-line" style="width:28px;height:3px;top:22px;left:11px;"></div>
        <div class="icon-line" style="width:20px;height:3px;top:30px;left:11px;"></div>
      </div>
      <span class="icon-lbl">Crea</span>
    </div>
    <div class="icon-item">
      <div class="icon-shape" style="border-radius:8px 8px 4px 4px;">
        <div class="icon-line" style="width:40px;height:2px;bottom:8px;left:5px;background:#1B2B6B;opacity:0.4;"></div>
      </div>
      <span class="icon-lbl">Produce</span>
    </div>
  </div>

  <div class="arrow-down">↓</div>
  <span class="handle">@tuusuario</span>
</div>""",
    },
    {
        "notes": "Slide 2 — Tip 1: Dale contexto",
        "html": """<style>
  @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;900&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  .slide { width:1080px; height:1350px; background:#F5F0E8; font-family:'Nunito',sans-serif; position:relative; overflow:hidden; display:flex; flex-direction:column; padding:80px; }
  .blob { position:absolute; border-radius:50%; }
  .b1 { width:380px; height:380px; background:radial-gradient(circle, rgba(232,101,26,0.12) 0%, transparent 70%); top:-100px; right:-100px; }
  .b2 { width:260px; height:260px; background:radial-gradient(circle, rgba(27,43,107,0.09) 0%, transparent 70%); bottom:-70px; left:-70px; }
  .sp { position:absolute; color:#E8651A; font-weight:900; }
  .logo { position:absolute; top:64px; right:80px; font-size:21px; color:#E8651A; font-weight:900; letter-spacing:2px; opacity:0.65; }
  .num { font-size:116px; color:#E8651A; font-weight:900; line-height:1; font-style:italic; margin-bottom:4px; }
  .title { font-size:64px; color:#E8651A; font-weight:900; line-height:1.05; margin-bottom:2px; }
  .subtitle { font-size:54px; color:#1B1B1B; font-weight:900; line-height:1.05; margin-bottom:48px; }
  .chat-area { flex:1; display:flex; flex-direction:column; gap:20px; margin-bottom:44px; }
  .bubble { border-radius:18px; padding:24px 28px; position:relative; }
  .bad { background:#EBEBEB; border-left:5px solid #CCCCCC; }
  .good { background:rgba(232,101,26,0.09); border-left:5px solid #E8651A; }
  .tag { font-size:14px; font-weight:800; text-transform:uppercase; letter-spacing:1.2px; margin-bottom:10px; }
  .tag-bad { color:#AAAAAA; }
  .tag-good { color:#E8651A; }
  .bubble-text { font-size:23px; line-height:1.5; color:#333; }
  .bubble-text.highlighted { color:#1B2B6B; font-weight:600; }
  .body-txt { font-size:25px; color:#1B2B6B; font-style:italic; font-weight:600; text-align:center; line-height:1.65; }
  .handle { position:absolute; bottom:52px; right:80px; font-size:22px; color:#E8651A; font-weight:700; text-decoration:underline; }
</style>
<div class="slide">
  <div class="blob b1"></div>
  <div class="blob b2"></div>
  <span class="sp" style="top:100px;left:220px;font-size:20px;opacity:0.6;">✦</span>
  <span class="sp" style="bottom:230px;right:100px;font-size:15px;opacity:0.5;">✦</span>
  <div class="logo">CLAUDE</div>

  <div class="num">1</div>
  <div class="title">Dale contexto</div>
  <div class="subtitle">antes de pedir</div>

  <div class="chat-area">
    <div class="bubble bad">
      <div class="tag tag-bad">Sin contexto</div>
      <div class="bubble-text">"escríbeme un email"</div>
    </div>
    <div class="bubble good">
      <div class="tag tag-good">Con contexto</div>
      <div class="bubble-text highlighted">"Soy fundador de startup SaaS. Escríbeme un email a un inversor seed, tono profesional pero cercano, 150 palabras max."</div>
    </div>
  </div>

  <p class="body-txt">no digas 'escríbeme un email'. di quién eres, a quién le escribes y qué tono quieres. el resultado cambia completamente.</p>
  <span class="handle">@tuusuario</span>
</div>""",
    },
    {
        "notes": "Slide 3 — Tip 2: Pídele que corrija",
        "html": """<style>
  @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;900&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  .slide { width:1080px; height:1350px; background:#F5F0E8; font-family:'Nunito',sans-serif; position:relative; overflow:hidden; display:flex; flex-direction:column; padding:80px; }
  .blob { position:absolute; border-radius:50%; }
  .b1 { width:340px; height:340px; background:radial-gradient(circle, rgba(27,43,107,0.09) 0%, transparent 70%); top:-80px; right:-80px; }
  .b2 { width:300px; height:300px; background:radial-gradient(circle, rgba(232,101,26,0.10) 0%, transparent 70%); bottom:-80px; left:-80px; }
  .sp { position:absolute; color:#E8651A; font-weight:900; }
  .logo { position:absolute; top:64px; right:80px; font-size:21px; color:#E8651A; font-weight:900; letter-spacing:2px; opacity:0.65; }
  .num { font-size:116px; color:#E8651A; font-weight:900; line-height:1; font-style:italic; margin-bottom:4px; }
  .title { font-size:62px; color:#E8651A; font-weight:900; line-height:1.05; margin-bottom:2px; }
  .subtitle { font-size:52px; color:#1B1B1B; font-weight:900; line-height:1.05; margin-bottom:48px; }
  .doc-wrap { flex:1; display:flex; align-items:center; justify-content:center; margin-bottom:44px; }
  .doc { background:white; border-radius:18px; padding:36px 40px; box-shadow:0 6px 28px rgba(0,0,0,0.08); border:2px solid rgba(27,43,107,0.10); width:100%; position:relative; }
  .line { height:13px; border-radius:6px; margin-bottom:13px; }
  .lg { background:rgba(0,0,0,0.07); }
  .lr { background:rgba(220,50,50,0.22); }
  .lo { background:rgba(232,101,26,0.28); }
  .lb { background:rgba(27,43,107,0.14); }
  .pencil-mark { position:absolute; right:24px; top:20px; width:8px; height:48px; background:#E8651A; border-radius:3px 3px 0 0; transform:rotate(20deg); }
  .pencil-tip { position:absolute; right:21px; top:66px; width:0; height:0; border-left:7px solid transparent; border-right:7px solid transparent; border-top:12px solid #E8651A; transform:rotate(20deg); }
  .quote { margin-top:20px; background:rgba(232,101,26,0.08); border-left:5px solid #E8651A; padding:18px 22px; border-radius:0 12px 12px 0; font-size:22px; color:#1B2B6B; font-weight:700; line-height:1.5; }
  .body-txt { font-size:25px; color:#1B2B6B; font-style:italic; font-weight:600; text-align:center; line-height:1.65; }
  .handle { position:absolute; bottom:52px; right:80px; font-size:22px; color:#E8651A; font-weight:700; text-decoration:underline; }
</style>
<div class="slide">
  <div class="blob b1"></div>
  <div class="blob b2"></div>
  <span class="sp" style="top:88px;left:200px;font-size:19px;opacity:0.6;">✦</span>
  <span class="sp" style="bottom:250px;right:88px;font-size:23px;opacity:0.55;">✦</span>
  <span class="sp" style="top:520px;left:60px;font-size:15px;opacity:0.5;">✦</span>
  <div class="logo">CLAUDE</div>

  <div class="num">2</div>
  <div class="title">Pídele que corrija</div>
  <div class="subtitle">no que reescriba</div>

  <div class="doc-wrap">
    <div style="width:100%;">
      <div class="doc">
        <div class="line lg" style="width:88%;"></div>
        <div class="line lr" style="width:74%;"></div>
        <div class="line lo" style="width:81%;"></div>
        <div class="line lg" style="width:58%;"></div>
        <div class="line lb" style="width:86%;"></div>
        <div class="line lg" style="width:68%; margin-bottom:0;"></div>
        <div class="pencil-mark"></div>
        <div class="pencil-tip"></div>
      </div>
      <div class="quote">"dime qué está mal y por qué, no lo arregles tú"</div>
    </div>
  </div>

  <p class="body-txt">así aprendes y mantienes tu voz. Claude como editor, no como ghostwriter.</p>
  <span class="handle">@tuusuario</span>
</div>""",
    },
    {
        "notes": "Slide 4 — Tip 3: Úsalo para pensar",
        "html": """<style>
  @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;900&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  .slide { width:1080px; height:1350px; background:#F5F0E8; font-family:'Nunito',sans-serif; position:relative; overflow:hidden; display:flex; flex-direction:column; padding:80px; }
  .blob { position:absolute; border-radius:50%; }
  .b1 { width:380px; height:380px; background:radial-gradient(circle, rgba(232,101,26,0.11) 0%, transparent 70%); bottom:-100px; right:-100px; }
  .b2 { width:260px; height:260px; background:radial-gradient(circle, rgba(27,43,107,0.09) 0%, transparent 70%); top:-60px; left:-60px; }
  .sp { position:absolute; color:#E8651A; font-weight:900; }
  .logo { position:absolute; top:64px; right:80px; font-size:21px; color:#E8651A; font-weight:900; letter-spacing:2px; opacity:0.65; }
  .num { font-size:116px; color:#E8651A; font-weight:900; line-height:1; font-style:italic; margin-bottom:4px; }
  .title { font-size:62px; color:#E8651A; font-weight:900; line-height:1.05; margin-bottom:2px; }
  .subtitle { font-size:52px; color:#1B1B1B; font-weight:900; line-height:1.05; margin-bottom:48px; }
  .center-area { flex:1; display:flex; align-items:center; justify-content:center; gap:36px; margin-bottom:44px; }
  .brain-box { width:160px; height:160px; border-radius:50%; border:4px solid #E8651A; display:flex; align-items:center; justify-content:center; position:relative; flex-shrink:0; }
  .brain-inner { width:80px; height:70px; border:3px solid #E8651A; border-radius:50% 50% 40% 40%; position:relative; }
  .brain-inner::before { content:''; position:absolute; width:36px; height:36px; border:3px solid #E8651A; border-radius:50%; right:-10px; top:16px; }
  .arrows-col { display:flex; flex-direction:column; gap:20px; align-items:center; }
  .arr { font-size:36px; color:#E8651A; font-weight:900; line-height:1; }
  .screen-box { width:220px; height:160px; border:4px solid #1B2B6B; border-radius:10px; background:white; display:flex; align-items:center; justify-content:center; position:relative; flex-shrink:0; }
  .screen-line { position:absolute; background:rgba(27,43,107,0.15); height:12px; border-radius:5px; }
  .sliders { flex:1; display:flex; flex-direction:column; gap:22px; }
  .s-row { display:flex; align-items:center; gap:18px; }
  .s-lbl { font-size:21px; color:#1B2B6B; font-weight:700; width:130px; text-align:right; }
  .s-track { flex:1; height:10px; background:rgba(27,43,107,0.12); border-radius:5px; position:relative; }
  .s-fill { height:100%; border-radius:5px; background:#E8651A; }
  .s-dot { width:22px; height:22px; border-radius:50%; background:#E8651A; position:absolute; right:-4px; top:-6px; border:3px solid #F5F0E8; box-shadow:0 2px 6px rgba(232,101,26,0.35); }
  .body-txt { font-size:25px; color:#1B2B6B; font-style:italic; font-weight:600; text-align:center; line-height:1.65; }
  .handle { position:absolute; bottom:52px; right:80px; font-size:22px; color:#E8651A; font-weight:700; text-decoration:underline; }
</style>
<div class="slide">
  <div class="blob b1"></div>
  <div class="blob b2"></div>
  <span class="sp" style="top:76px;left:190px;font-size:22px;opacity:0.6;">✦</span>
  <span class="sp" style="top:370px;right:64px;font-size:17px;opacity:0.5;">✦</span>
  <span class="sp" style="bottom:290px;left:64px;font-size:21px;opacity:0.55;">✦</span>
  <div class="logo">CLAUDE</div>

  <div class="num">3</div>
  <div class="title">Úsalo para pensar</div>
  <div class="subtitle">no solo para producir</div>

  <div class="center-area">
    <div class="brain-box">
      <div class="brain-inner"></div>
    </div>
    <div class="arrows-col">
      <span class="arr">→</span>
      <span class="arr">←</span>
    </div>
    <div class="screen-box">
      <div class="screen-line" style="width:140px;top:44px;left:40px;"></div>
      <div class="screen-line" style="width:100px;top:64px;left:40px;"></div>
      <div class="screen-line" style="width:120px;top:84px;left:40px;"></div>
    </div>
    <div class="sliders">
      <div class="s-row">
        <span class="s-lbl">claridad</span>
        <div class="s-track"><div class="s-fill" style="width:80%;"></div><div class="s-dot" style="right:calc(20% - 11px);"></div></div>
      </div>
      <div class="s-row">
        <span class="s-lbl">profundidad</span>
        <div class="s-track"><div class="s-fill" style="width:88%;"></div><div class="s-dot" style="right:calc(12% - 11px);"></div></div>
      </div>
      <div class="s-row">
        <span class="s-lbl">perspectiva</span>
        <div class="s-track"><div class="s-fill" style="width:68%;"></div><div class="s-dot" style="right:calc(32% - 11px);"></div></div>
      </div>
    </div>
  </div>

  <p class="body-txt">pregúntale "¿qué se me está escapando?" o "dame el contraargumento más fuerte". ahí es cuando se vuelve poderoso.</p>
  <span class="handle">@tuusuario</span>
</div>""",
    },
    {
        "notes": "Slide 5 — CTA: El que lo usa bien gana",
        "html": """<style>
  @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;900&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  .slide { width:1080px; height:1350px; background:#F5F0E8; font-family:'Nunito',sans-serif; position:relative; overflow:hidden; display:flex; flex-direction:column; padding:80px; align-items:center; }
  .blob { position:absolute; border-radius:50%; }
  .b1 { width:420px; height:420px; background:radial-gradient(circle, rgba(232,101,26,0.12) 0%, transparent 70%); top:-110px; left:-110px; }
  .b2 { width:300px; height:300px; background:radial-gradient(circle, rgba(27,43,107,0.09) 0%, transparent 70%); bottom:-80px; right:-80px; }
  .sp { position:absolute; color:#E8651A; font-weight:900; }
  .logo { position:absolute; top:64px; right:80px; font-size:21px; color:#E8651A; font-weight:900; letter-spacing:2px; opacity:0.65; }
  .num { font-size:116px; color:#E8651A; font-weight:900; line-height:1; font-style:italic; align-self:flex-start; margin-bottom:4px; }
  .title { font-size:72px; color:#E8651A; font-weight:900; line-height:1.05; text-align:center; margin-bottom:2px; }
  .subtitle { font-size:60px; color:#1B1B1B; font-weight:900; text-align:center; margin-bottom:52px; }
  .compare { flex:1; display:flex; align-items:center; gap:28px; width:100%; margin-bottom:48px; max-height:340px; }
  .bad-card { flex:1; background:white; border-radius:18px; padding:36px 28px; text-align:center; border:2.5px solid rgba(220,50,50,0.18); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; height:100%; }
  .x-cross { width:48px; height:48px; position:relative; }
  .x-cross::before, .x-cross::after { content:''; position:absolute; width:48px; height:5px; background:rgba(220,50,50,0.6); border-radius:3px; top:22px; left:0; }
  .x-cross::before { transform:rotate(45deg); }
  .x-cross::after { transform:rotate(-45deg); }
  .bad-lbl { font-size:24px; color:#999; font-weight:700; }
  .arr-mid { font-size:52px; color:#E8651A; font-weight:900; flex-shrink:0; }
  .good-card { flex:1.2; background:linear-gradient(140deg,#E8651A,#cf5812); border-radius:18px; padding:36px 28px; text-align:center; box-shadow:0 8px 28px rgba(232,101,26,0.28); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; height:100%; }
  .spark-deco { font-size:36px; color:rgba(255,255,255,0.8); font-weight:900; line-height:1; }
  .good-lbl { font-size:24px; color:white; font-weight:700; line-height:1.3; }
  .body-txt { font-size:25px; color:#1B2B6B; font-style:italic; font-weight:600; text-align:center; line-height:1.65; }
  .handle { position:absolute; bottom:52px; font-size:22px; color:#E8651A; font-weight:700; text-decoration:underline; }
</style>
<div class="slide">
  <div class="blob b1"></div>
  <div class="blob b2"></div>
  <span class="sp" style="top:76px;left:210px;font-size:22px;opacity:0.6;">✦</span>
  <span class="sp" style="top:210px;right:150px;font-size:17px;opacity:0.5;">✦</span>
  <span class="sp" style="bottom:210px;left:104px;font-size:19px;opacity:0.55;">✦</span>
  <span class="sp" style="bottom:130px;right:190px;font-size:14px;opacity:0.5;">✦</span>
  <div class="logo">CLAUDE</div>

  <div class="num">4</div>
  <div class="title">El que lo usa bien</div>
  <div class="subtitle">gana.</div>

  <div class="compare">
    <div class="bad-card">
      <div class="x-cross"></div>
      <div class="bad-lbl">prompt genérico</div>
    </div>
    <div class="arr-mid">→</div>
    <div class="good-card">
      <div class="spark-deco">✦</div>
      <div class="good-lbl">Claude bien usado</div>
    </div>
  </div>

  <p class="body-txt">guarda esto. ponlo en práctica hoy. ¿cuál vas a usar primero?</p>
  <span class="handle">@tuusuario</span>
</div>""",
    },
]


def api(path, method="GET", body=None):
    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(
        f"{BASE}{path}", data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {}
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode("utf-8"))


carousel = api(f"/api/carousels/{CAROUSEL_ID}")
current_slides = carousel["slides"]
print(f"Updating {len(current_slides)} slides...")

for i, (slide_def, current) in enumerate(zip(SLIDES, current_slides)):
    result = api(
        f"/api/carousels/{CAROUSEL_ID}/slides/{current['id']}",
        method="PUT",
        body={"html": slide_def["html"], "notes": slide_def["notes"]}
    )
    print(f"  Slide {i+1}: {slide_def['notes'][:40]} -> OK")

print("\nDone! All slides updated.")
