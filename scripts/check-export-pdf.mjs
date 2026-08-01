#!/usr/bin/env node
/**
 * Prueba de humo de los exports multi-lámina (PDF / HTML / SVG).
 *
 * Los tres defectos que motivaron este script eran SILENCIOSOS: el PDF salía, pesaba,
 * abría — y estaba mal. Una lámina guardada como documento completo colapsaba las 7
 * láminas en 1 página, y la tipografía del avatar no llegaba nunca (caía a Arial/Times).
 * Nadie se enteró porque nada fallaba: solo el archivo estaba mal.
 *
 *   node scripts/check-export-pdf.mjs
 *
 * Por eso acá NO se mira que el export "no tire error": se abre el PDF y se cuentan
 * páginas, operadores de texto y fuentes embebidas.
 *
 * Las láminas son fixtures sintéticas, no `data/carousels.json`: así el check es
 * determinista y corre igual en la máquina de cualquier diseñadora, que tiene otros
 * carruseles. Cubre las DOS formas que existen en la práctica — nivel body (lo que pide
 * el system prompt) y documento completo (lo que el agente generó igual, 110 láminas).
 */
import zlib from "node:zlib";

import "../src/lib/test-resolve.mts";

const { exportPdf, exportHtml } = await import("../src/lib/export-formats.ts");

const FAMILIAS = ["Inter", "Open Sans"];

/** PNG de 2x1 en data: URI — una imagen real sin depender de la red. */
const PIX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFUlEQVR4nGP8z8DAwMTAwMDAwMAAABQYAd8kRJIAAAAASUVORK5CYII=";

/**
 * Cuerpo de una lámina a nivel body. Cada lámina usa DELIBERADAMENTE las mismas clases
 * (`.s`, `.t`) y un fondo distinto: si el aislamiento entre láminas se rompe, la última
 * pisa a las anteriores y todas terminan del mismo color.
 */
function cuerpo(n, fondo) {
  return `<style>
  .s { width:100%; height:100%; background:${fondo}; padding:80px; }
  .t { font-family:'Inter',sans-serif; font-weight:700; font-size:96px; color:#242424; }
  .b { font-family:'Open Sans',serif; font-size:44px; color:#555; }
</style>
<div class="s">
  <div class="t">Lamina ${n}</div>
  <div class="b">Cuerpo de la lamina numero ${n} con texto suficiente para medir.</div>
  <img src="${PIX}" width="200" height="100" alt="">
</div>`;
}

/** La MISMA lámina, pero guardada como documento completo: la forma que rompía el PDF. */
function documentoCompleto(n, fondo, w, h) {
  const params = FAMILIAS.map((f) => `family=${f.replace(/ /g, "+")}:wght@400;700`).join("&");
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?${params}&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${w}px;height:${h}px;overflow:hidden;background:${fondo}}</style>
</head><body>${cuerpo(n, fondo)}</body></html>`;
}

const FONDOS = ["#F6F5F0", "#FFD400", "#242424"];

function fixtures(aspectRatio) {
  const [w, h] = aspectRatio === "1:1" ? [1080, 1080] : [1080, 1350];
  return {
    body: FONDOS.map((fondo, i) => ({ id: `b${i}`, html: cuerpo(i + 1, fondo) })),
    documento: FONDOS.map((fondo, i) => ({
      id: `d${i}`,
      html: documentoCompleto(i + 1, fondo, w, h),
    })),
  };
}

/**
 * Abre el PDF y mide lo que importa.
 *
 * Ojo con las fuentes: Chromium guarda los diccionarios en OBJECT STREAMS comprimidos,
 * así que buscar `/BaseFont` sobre los bytes crudos se pierde la mitad. Hay que inflar
 * todos los streams y buscar también adentro.
 */
function auditar(pdf) {
  const raw = pdf.toString("latin1");
  const paginas = (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  const fuentes = new Set();
  let opsTexto = 0;
  let type3 = (raw.match(/\/Type3\b/g) ?? []).length;
  let programasEmbebidos = (raw.match(/\/FontFile2|\/FontFile3|\/FontFile\b/g) ?? []).length;

  for (const m of raw.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+#,\-_]+)/g)) {
    fuentes.add(m[1].split("+").pop());
  }

  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const desde = m.index + m[0].length;
    const hasta = raw.indexOf("endstream", desde);
    if (hasta < 0) continue;
    let texto;
    try {
      texto = zlib.inflateSync(Buffer.from(raw.slice(desde, hasta), "latin1")).toString("latin1");
    } catch {
      continue; // imagen o programa de fuente: no infla
    }
    opsTexto += (texto.match(/\bT[jJ]\b/g) ?? []).length;
    type3 += (texto.match(/\/Type3\b/g) ?? []).length;
    programasEmbebidos += (texto.match(/\/FontFile2|\/FontFile3|\/FontFile\b/g) ?? []).length;
    for (const f of texto.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+#,\-_]+)/g)) {
      fuentes.add(f[1].split("+").pop());
    }
  }

  return { paginas, opsTexto, type3, programasEmbebidos, fuentes: [...fuentes] };
}

/** ¿La familia declarada aparece entre las fuentes embebidas? "Open Sans" → "OpenSans-Bold". */
function familiaPresente(familia, fuentes) {
  const sinEspacios = familia.replace(/\s+/g, "").toLowerCase();
  return fuentes.some((f) => f.replace(/[\s-]/g, "").toLowerCase().includes(sinEspacios));
}

const fallos = [];
function chequear(condicion, mensaje) {
  if (condicion) {
    console.log(`  ✓ ${mensaje}`);
  } else {
    console.log(`  ✗ ${mensaje}`);
    fallos.push(mensaje);
  }
}

for (const aspectRatio of ["4:5", "1:1"]) {
  const fx = fixtures(aspectRatio);
  for (const [forma, slides] of Object.entries(fx)) {
    console.log(`\n== PDF · ${aspectRatio} · láminas guardadas como ${forma} (${slides.length})`);
    const pdf = await exportPdf(slides, aspectRatio);
    const a = auditar(pdf);
    console.log(
      `   páginas: ${a.paginas} · ops texto: ${a.opsTexto} · programas de fuente: ${a.programasEmbebidos} · Type3: ${a.type3}`
    );
    console.log(`   fuentes: ${a.fuentes.join(", ") || "(ninguna)"}`);

    chequear(
      a.paginas === slides.length,
      `${aspectRatio}/${forma}: una página por lámina (esperado ${slides.length}, salieron ${a.paginas})`
    );
    chequear(
      a.opsTexto > 0,
      `${aspectRatio}/${forma}: el texto va como TEXTO, no rasterizado (${a.opsTexto} operadores)`
    );
    // El guardián directo de la regresión: con la fuente VARIABLE, Chromium no puede
    // embeber el programa y degrada el texto a una fuente Type 3 (glifos como trazos). Se
    // ve bien y no lleva tipografía adentro. Las láminas de acá usan solo las familias
    // declaradas, así que un solo Type 3 ya es señal de que volvió el bug.
    chequear(
      a.type3 === 0,
      `${aspectRatio}/${forma}: ninguna fuente degradada a Type 3 (hay ${a.type3})`
    );
    for (const familia of FAMILIAS) {
      chequear(
        familiaPresente(familia, a.fuentes),
        `${aspectRatio}/${forma}: "${familia}" viaja embebida en el PDF`
      );
    }
  }
}

/**
 * El HTML comparte `buildMultiSlideDocument` con el PDF, así que hereda el mismo fix.
 * Acá se verifica lo que el PDF no puede mostrar: que las reglas de una lámina no se
 * escapen a las otras.
 */
console.log(`\n== HTML · aislamiento entre láminas`);
const fx = fixtures("4:5");
const html = await exportHtml(fx.documento, "4:5");
chequear(
  (html.match(/class="oc-page"/g) ?? []).length === fx.documento.length,
  `HTML: un bloque .oc-page por lámina`
);
chequear(
  !/html\s*,\s*body\s*\{[^}]*overflow\s*:\s*hidden[^}]*\}[\s\S]*<body/i.test(html) ||
    (html.match(/html\s*,\s*body\s*\{/g) ?? []).length === 1,
  `HTML: no quedan reglas html,body de las láminas (solo la del documento)`
);
for (const fondo of FONDOS) {
  chequear(html.includes(fondo), `HTML: sobrevive el fondo ${fondo} de su lámina`);
}

console.log("");
if (fallos.length > 0) {
  console.error(`FALLÓ: ${fallos.length} comprobación(es)`);
  for (const f of fallos) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("Todo en verde.");
process.exit(0);
