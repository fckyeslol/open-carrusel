// Generate a Sembradores de Fe branded carousel (photo-led) via the local API.
// Uses real SDF photos (/uploads/sdf-N.jpg) with navy/gold overlays + panels.
// Usage: node scripts/generate-sdf-carousel.cjs [baseUrl]
const BASE = process.argv[2] || "http://localhost:3000";

const NAVY = "#1C3F7C", DEEP = "#14305C", GOLD = "#C9A227", GOLDS = "#E7C24B";
const IVORY = "#FAF6EE", WHITE = "#FFFFFF";
const LOGO = "/uploads/sembradores-logo.png";
const HANDLE = "@sembradoresdefe";
// Fonts loaded by the app (preview <link> / inlined export). No @import (it render-blocks export).
const reset = `*{margin:0;padding:0;box-sizing:border-box}`;
const sbase = (bg) => `${reset}.s{width:1080px;height:1350px;background:${bg};font-family:'Mulish',sans-serif;position:relative;overflow:hidden}`;
const sp = (pos, s, c, o) => `<span style="position:absolute;${pos};font-size:${s}px;color:${c};opacity:${o};font-weight:900">${"✦"}</span>`;

// ---- full-bleed hero (hook / CTA) ----
function hero(img, inner) {
  return `<style>${sbase(NAVY)}</style>
<div class="s">
  <img src="${img}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">
  <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(20,48,92,.42) 0%,rgba(20,48,92,.20) 30%,rgba(20,48,92,.86) 72%,rgba(20,48,92,.97) 100%)"></div>
  ${inner}
</div>`;
}

const s1 = hero("/uploads/sdf-1.jpg", `
  <img src="${LOGO}" style="position:absolute;top:54px;left:50%;transform:translateX(-50%);width:120px;height:auto;filter:drop-shadow(0 4px 14px rgba(0,0,0,.45))">
  ${sp("top:150px;left:90px", 22, GOLDS, .8)} ${sp("top:230px;right:110px", 15, GOLDS, .6)}
  <div style="position:absolute;left:80px;right:80px;bottom:430px;text-align:center;font-family:'Montserrat';font-weight:700;font-size:34px;letter-spacing:10px;color:${WHITE};text-shadow:0 2px 14px rgba(0,0,0,.5)">EL AYUNO DE</div>
  <div style="position:absolute;left:0;right:0;bottom:230px;text-align:center;font-family:'Montserrat';font-weight:900;font-size:150px;line-height:.95;color:${GOLDS};text-shadow:0 6px 28px rgba(0,0,0,.45)">21 DÍAS</div>
  <div style="position:absolute;left:130px;right:130px;bottom:140px;text-align:center;font-size:32px;font-style:italic;font-weight:600;color:${IVORY};line-height:1.5;text-shadow:0 2px 12px rgba(0,0,0,.5)">4 claves para vivirlo de verdad,<br>y no solo dejar de comer.</div>
  <div style="position:absolute;bottom:60px;left:0;right:0;text-align:center;font-size:22px;font-weight:700;color:${GOLDS}">desliza para empezar ${"→"}</div>
`);

// ---- photo-band + navy-panel (keys) ----
function keyPhoto(num, title, body, line2, img) {
  return `<style>${sbase(NAVY)}</style>
<div class="s">
  <img src="${img}" style="position:absolute;top:0;left:0;width:100%;height:600px;object-fit:cover">
  <div style="position:absolute;top:430px;left:0;right:0;height:200px;background:linear-gradient(180deg,rgba(20,48,92,0),rgba(20,48,92,1))"></div>
  <img src="${LOGO}" style="position:absolute;top:34px;right:40px;width:74px;height:auto;filter:drop-shadow(0 3px 10px rgba(0,0,0,.4))">
  <div style="position:absolute;top:600px;left:0;right:0;bottom:0;padding:30px 80px 0">
    <div style="font-family:'Montserrat';font-weight:900;font-size:122px;line-height:1;color:${GOLDS}">${num}</div>
    <div style="width:104px;height:7px;background:${GOLD};border-radius:4px;margin:10px 0 30px"></div>
    <div style="font-family:'Montserrat';font-weight:900;font-size:66px;line-height:1.04;color:${WHITE};max-width:840px">${title}</div>
    <div style="margin-top:40px;background:rgba(255,255,255,.08);border-left:8px solid ${GOLD};border-radius:0 16px 16px 0;padding:34px 40px;max-width:880px">
      <div style="font-size:31px;line-height:1.5;color:${IVORY};font-weight:600">${body}</div>
      ${line2 ? `<div style="margin-top:16px;font-size:26px;line-height:1.45;color:${GOLDS};font-style:italic">${line2}</div>` : ""}
    </div>
  </div>
  <div style="position:absolute;bottom:52px;right:80px;font-size:21px;font-weight:700;color:${GOLDS}">${"→"}</div>
  <div style="position:absolute;bottom:52px;left:80px;font-size:20px;font-weight:700;letter-spacing:.5px;color:rgba(250,246,238,.75)">${HANDLE}</div>
</div>`;
}

const s2 = keyPhoto("01", "Define tu<br>propósito", "Antes de empezar, escribe POR QUÉ ayunas. Un ayuno sin intención es solo una dieta.", "¿Qué le estás pidiendo a Dios en estos 21 días?", "/uploads/sdf-2.jpg");
const s3 = keyPhoto("02", "Empieza<br>gradual", "No lo hagas todo de golpe. Ajusta horarios y comidas poco a poco para sostenerlo hasta el final.", "La constancia pesa más que la intensidad.", "/uploads/sdf-3.jpg");
const s4 = keyPhoto("03", "Llénate de<br>Palabra", "El tiempo que dejas de comer, dáselo a la oración y a la Biblia. Ahí está la fuerza del ayuno.", "Vacías el estómago para llenar el espíritu.", "/uploads/sdf-4.jpg");
const s5 = keyPhoto("04", "No camines<br>solo", "Hazlo en comunidad. Cuéntale a alguien, oren juntos, anímense. El ayuno compartido se sostiene.", "Donde dos o tres se reúnen, Él está en medio.", "/uploads/sdf-5.jpg");

const s6 = hero("/uploads/sdf-6.jpg", `
  <img src="${LOGO}" style="position:absolute;top:60px;left:50%;transform:translateX(-50%);width:130px;height:auto;filter:drop-shadow(0 4px 14px rgba(0,0,0,.45))">
  <div style="position:absolute;left:110px;right:110px;bottom:540px;text-align:center;font-family:'Montserrat';font-weight:900;font-size:64px;line-height:1.1;color:${WHITE};text-shadow:0 3px 18px rgba(0,0,0,.5)">21 días pueden<br>cambiarlo todo.</div>
  <div style="position:absolute;left:140px;right:140px;bottom:430px;text-align:center;font-size:29px;font-weight:600;color:${IVORY};text-shadow:0 2px 12px rgba(0,0,0,.5)">Guarda este carrusel y empieza hoy.</div>
  <div style="position:absolute;left:50%;bottom:250px;transform:translateX(-50%);background:${GOLD};border-radius:16px;padding:28px 56px;box-shadow:0 12px 36px rgba(0,0,0,.4)">
    <div style="font-family:'Montserrat';font-weight:900;font-size:38px;color:${DEEP};letter-spacing:1px;white-space:nowrap">SIGUE ${HANDLE}</div>
  </div>
  <div style="position:absolute;left:0;right:0;bottom:120px;text-align:center;font-size:29px;font-style:italic;font-weight:600;color:${WHITE};text-shadow:0 2px 12px rgba(0,0,0,.5)">¿Por qué vas a ayunar tú?<br><span style="color:${GOLDS}">Cuéntanos en los comentarios ${"↓"}</span></div>
`);

const SLIDES = [
  { html: s1, notes: "Slide 1 — Hook (foto adoración)" },
  { html: s2, notes: "Slide 2 — Clave 1: Define tu propósito" },
  { html: s3, notes: "Slide 3 — Clave 2: Empieza gradual" },
  { html: s4, notes: "Slide 4 — Clave 3: Llénate de Palabra" },
  { html: s5, notes: "Slide 5 — Clave 4: No camines solo" },
  { html: s6, notes: "Slide 6 — CTA (foto adoración)" },
];

async function main() {
  const cRes = await fetch(`${BASE}/api/carousels`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Ayuno de 21 días — 4 claves (con fotos)", aspectRatio: "4:5" }),
  });
  const cText = await cRes.text();
  let c; try { c = JSON.parse(cText); } catch { throw new Error("create carousel failed: " + cText.slice(0, 300)); }
  const id = c.id || c.carousel?.id || c.data?.id;
  if (!id) throw new Error("no carousel id: " + cText.slice(0, 300));
  console.log("carousel id:", id);
  for (const s of SLIDES) {
    const r = await fetch(`${BASE}/api/carousels/${id}/slides`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s),
    });
    console.log("  " + s.notes + " -> " + (r.ok ? "OK" : "FAIL " + r.status));
  }
  console.log("CAROUSEL_ID=" + id);
  console.log("Open: " + BASE + "/carousel/" + id);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
