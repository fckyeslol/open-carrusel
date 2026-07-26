#!/usr/bin/env node
/**
 * Prueba de humo del runtime del editor visual.
 *
 * EDITOR_RUNTIME (src/lib/slide-editor.ts) es ~1300 líneas de JS que viven dentro
 * de un template string: TypeScript no lo compila ni lo revisa, así que un typo o
 * una regresión de comportamiento solo aparecen abriendo el editor a mano. Este
 * script carga el runtime real en Chromium sobre una lámina de prueba y maneja el
 * mouse de verdad (seleccionar, arrastrar, redimensionar) verificando el resultado.
 *
 *   node scripts/check-editor.mjs
 *
 * Extrae el runtime del .ts por texto (es un String.raw plano) para no depender de
 * un paso de compilación.
 */
import { readFile } from "fs/promises";
import path from "path";
import puppeteer from "puppeteer";

const ROOT = process.cwd();
const W = 1080;
const H = 1350;

/** Saca EDITOR_RUNTIME del fuente TS y resuelve su única interpolación. */
async function loadRuntime() {
  const src = await readFile(path.join(ROOT, "src/lib/slide-editor.ts"), "utf8");
  const start = src.indexOf("export const EDITOR_RUNTIME = String.raw`");
  if (start < 0) throw new Error("No se encontró EDITOR_RUNTIME en slide-editor.ts");
  const from = src.indexOf("`", start) + 1;
  const end = src.indexOf("\n`;", from);
  if (end < 0) throw new Error("No se encontró el cierre de EDITOR_RUNTIME");
  const body = src.slice(from, end);
  // La única interpolación del runtime es la lista de grosores de Google Fonts.
  const rest = body.replace(/\$\{GF_ITAL_WGHT\}/g, "wght@400");
  if (rest.includes("${")) {
    throw new Error("Interpolación inesperada en EDITOR_RUNTIME: " + rest.match(/\$\{[^}]*\}/)[0]);
  }
  return rest;
}

/** Lámina de prueba: tres elementos con coordenadas conocidas. */
const SLIDE = `
<div id="root" style="position:relative;width:${W}px;height:${H}px;background:#f6f5f0">
  <div id="t1" style="position:absolute;left:100px;top:200px;width:320px;font-size:52px;font-family:Inter;color:#111">Titulo uno</div>
  <div id="t2" style="position:absolute;left:100px;top:640px;width:320px;font-size:38px;font-family:Inter;color:#111">Segundo texto</div>
  <div id="sq" data-oc-shape="1" style="position:absolute;left:700px;top:200px;width:200px;height:200px;background:#4f7cff"></div>
  <div id="nested" style="position:absolute;left:600px;top:900px;width:360px;height:300px;background:#ffffff">
    <div id="deep" data-oc-shape="1" style="position:absolute;left:40px;top:40px;width:120px;height:120px;background:#ff3b7f"></div>
  </div>
</div>`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const mark = ok ? "[32m✓[0m" : "[31m✗[0m";
  console.log(`  ${mark} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

/** Arrastra desde (x0,y0) a (x1,y1) en pasos, devolviendo las guías visibles al final. */
async function drag(page, x0, y0, x1, y1, opts = {}) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  // Alt se aprieta DESPUÉS del mousedown: con Alt ya apretado, el mousedown es
  // "tomar un miembro suelto del grupo", no un arrastre.
  if (opts.altDuring) await page.keyboard.down("Alt");
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
  }
  // El runtime pinta en requestAnimationFrame: hay que dejar pasar un frame.
  await new Promise((r) => setTimeout(r, 80));
  const guides = await page.evaluate(() =>
    [...document.querySelectorAll(".oc-gl")]
      .filter((d) => d.style.display !== "none")
      .map((d) => ({ w: d.style.width, h: d.style.height, tf: d.style.transform }))
  );
  if (!opts.keepDown) await page.mouse.up();
  if (opts.altDuring) await page.keyboard.up("Alt");
  await new Promise((r) => setTimeout(r, 60));
  return guides;
}

const rectOf = (page, id) =>
  page.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  }, `#${id}`);

/** Cuenta de elementos seleccionados según el overlay del runtime. */
const selCount = (page) => page.evaluate(() => document.querySelectorAll(".oc-box").length);

async function main() {
  const runtime = await loadRuntime();
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}html,body{width:${W}px;height:${H}px;overflow:hidden;position:relative}
</style></head><body>${SLIDE}<script>${runtime}<\/script></body></html>`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  try {
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 150));

    console.log("\nRuntime del editor");
    check("el runtime carga sin errores de JS", errors.length === 0, errors.join(" | "));
    const booted = await page.evaluate(() => !!document.querySelector("[data-oc-ui]"));
    check("monta el overlay de UI", booted);

    console.log("\nSelección");
    await page.mouse.click(800, 300); // centro de #sq
    await new Promise((r) => setTimeout(r, 60));
    let selInfo = await page.evaluate(() => document.querySelectorAll(".oc-box").length);
    check("clic selecciona un elemento (dibuja su caja)", selInfo === 1, `cajas=${selInfo}`);

    console.log("\nGuías inteligentes");
    // #sq (left 700) hacia x tal que su borde izquierdo caiga a 103 → debe imantar
    // al borde izquierdo de #t1/#t2, que están en 100.
    let guides = await drag(page, 800, 300, 800 - 597, 300);
    let sq = await rectOf(page, "sq");
    check(
      "imanta el borde izquierdo al de otro elemento (100px)",
      Math.abs(sq.left - 100) < 0.6,
      `left=${sq.left}`
    );
    check("pinta al menos una guía durante el arrastre", guides.length > 0, `guías=${guides.length}`);
    const vertical = guides.filter((g) => g.w === "1px");
    check("la guía del eje X es una línea vertical", vertical.length > 0);

    // Centro del lienzo: llevar #sq a que su centro caiga cerca de (540, 675).
    sq = await rectOf(page, "sq");
    const cx = sq.left + sq.width / 2;
    const cy = sq.top + sq.height / 2;
    guides = await drag(page, cx, cy, W / 2 + 4, H / 2 - 4);
    sq = await rectOf(page, "sq");
    check(
      "imanta al centro del lienzo en ambos ejes",
      Math.abs(sq.left + sq.width / 2 - W / 2) < 0.6 && Math.abs(sq.top + sq.height / 2 - H / 2) < 0.6,
      `centro=(${sq.left + sq.width / 2}, ${sq.top + sq.height / 2})`
    );
    check("muestra guía de lienzo en rosa", guides.length >= 2, `guías=${guides.length}`);

    // Alt apretado DURANTE el arrastre desactiva el imán: movimiento exacto.
    sq = await rectOf(page, "sq");
    const beforeAlt = sq.left;
    await drag(
      page,
      sq.left + sq.width / 2,
      sq.top + sq.height / 2,
      sq.left + sq.width / 2 - 137,
      sq.top + sq.height / 2,
      { altDuring: true }
    );
    sq = await rectOf(page, "sq");
    check(
      "Alt desactiva el imán (movimiento exacto)",
      Math.abs(sq.left - (beforeAlt - 137)) < 1.5,
      `esperado=${beforeAlt - 137} real=${sq.left}`
    );

    console.log("\nGuías al redimensionar");
    // Seleccionar #t1 y estirar su lateral derecho hasta cerca del borde izq de #sq.
    await page.mouse.click(150, 225);
    await new Promise((r) => setTimeout(r, 60));
    const t1 = await rectOf(page, "t1");
    const target = (await rectOf(page, "sq")).left;
    guides = await drag(page, t1.right, (t1.top + t1.bottom) / 2, target - 4, (t1.top + t1.bottom) / 2);
    const t1b = await rectOf(page, "t1");
    check(
      "el borde que se arrastra imanta al de otro elemento",
      Math.abs(t1b.right - target) < 1.2,
      `right=${t1b.right} objetivo=${target}`
    );

    // ── Fase 2: selección múltiple y grupos. Se recarga la lámina para volver a
    //    geometría conocida (los arrastres anteriores movieron #sq). ────────────
    const reset = async () => {
      await page.setContent(html, { waitUntil: "domcontentloaded" });
      await new Promise((r) => setTimeout(r, 150));
    };

    console.log("\nSelección por arrastre (marquee)");
    await reset();
    await drag(page, 50, 120, 520, 780);
    check("la banda selecciona los elementos que toca", (await selCount(page)) === 2, `sel=${await selCount(page)}`);
    const bandGone = await page.evaluate(
      () => document.querySelector(".oc-band").style.display === "none"
    );
    check("la banda se oculta al soltar", bandGone);
    check(
      "la banda no toca los elementos fuera de su área",
      Math.abs((await rectOf(page, "sq")).left - 700) < 0.6
    );

    console.log("\nSelección aditiva y toggle");
    await reset();
    await page.mouse.click(150, 225); // #t1
    await page.keyboard.down("Shift");
    await page.mouse.click(800, 300); // #sq
    await page.keyboard.up("Shift");
    check("Shift+clic suma a la selección", (await selCount(page)) === 2, `sel=${await selCount(page)}`);
    await page.keyboard.down("Control");
    await page.mouse.click(800, 300); // #sq otra vez
    await page.keyboard.up("Control");
    check("Ctrl+clic sobre lo ya seleccionado lo descarta", (await selCount(page)) === 1, `sel=${await selCount(page)}`);
    await page.keyboard.down("Control");
    await page.mouse.click(650, 1000); // #deep (anidado)
    await page.keyboard.up("Control");
    check("Ctrl+clic suma un elemento anidado", (await selCount(page)) === 2, `sel=${await selCount(page)}`);

    await reset();
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    check(
      "Ctrl+A selecciona todos los elementos reales (no contenedores)",
      (await selCount(page)) === 4,
      `sel=${await selCount(page)}`
    );

    console.log("\nEscala proporcional del conjunto");
    await reset();
    await drag(page, 50, 120, 520, 780); // #t1 + #t2
    const bb = await page.evaluate(() => {
      const a = document.querySelector("#t1").getBoundingClientRect();
      const b = document.querySelector("#t2").getBoundingClientRect();
      return {
        left: Math.min(a.left, b.left),
        top: Math.min(a.top, b.top),
        right: Math.max(a.right, b.right),
        bottom: Math.max(a.bottom, b.bottom),
      };
    });
    const hasGbox = await page.evaluate(() => !!document.querySelector(".oc-gbox"));
    check("la multi-selección dibuja su caja envolvente", hasGbox);
    const gHandles = await page.evaluate(
      () => [...document.querySelectorAll(".oc-h")].length
    );
    check("ofrece 4 esquinas para escalar el conjunto", gHandles === 4, `handles=${gHandles}`);
    // k = 1.5 arrastrando la esquina SE 160px a la derecha sobre un ancho de 320.
    const bw = bb.right - bb.left;
    await drag(page, bb.right, bb.bottom, bb.right + bw * 0.5, bb.bottom);
    const t1s = await page.evaluate(() => ({
      fs: parseFloat(getComputedStyle(document.querySelector("#t1")).fontSize),
      left: document.querySelector("#t1").getBoundingClientRect().left,
      top: document.querySelector("#t1").getBoundingClientRect().top,
    }));
    const t2s = await rectOf(page, "t2");
    check("escala la tipografía del conjunto (52px → 78px)", Math.abs(t1s.fs - 78) < 1.5, `fs=${t1s.fs}`);
    check("la esquina opuesta queda fija", Math.abs(t1s.left - 100) < 1.5 && Math.abs(t1s.top - 200) < 1.5,
      `t1=(${t1s.left},${t1s.top})`);
    check(
      "reposiciona los miembros con el mismo factor",
      Math.abs(t2s.top - (200 + (640 - 200) * 1.5)) < 3,
      `t2.top=${t2s.top} esperado=${200 + (640 - 200) * 1.5}`
    );

    console.log("\nDuplicar un grupo");
    await reset();
    await drag(page, 50, 120, 520, 780);
    await page.evaluate(() => window.postMessage({ oc: "group" }, "*"));
    await new Promise((r) => setTimeout(r, 60));
    await page.evaluate(() => window.postMessage({ oc: "duplicate" }, "*"));
    await new Promise((r) => setTimeout(r, 120));
    const groups = await page.evaluate(() => {
      const els = [...document.querySelectorAll("[data-oc-g]")];
      const ids = [...new Set(els.map((e) => e.getAttribute("data-oc-g")))];
      return { count: els.length, ids: ids.length };
    });
    check("la copia sigue siendo un grupo", groups.ids === 2, `grupos=${groups.ids}`);
    check("con los mismos miembros que el original", groups.count === 4, `miembros=${groups.count}`);
    const dupIds = await page.evaluate(() => {
      const ids = [...document.querySelectorAll("[data-oc-id]")].map((e) =>
        e.getAttribute("data-oc-id")
      );
      return { total: ids.length, unique: new Set(ids).size };
    });
    check("no hay ids de capa duplicados", dupIds.total === dupIds.unique, `${dupIds.unique}/${dupIds.total}`);

    console.log("\nSerialización");
    await reset();
    const serialized = await page.evaluate(() => {
      return new Promise((resolve) => {
        const onMsg = (e) => {
          if (e.data && e.data.oc === "html") {
            window.removeEventListener("message", onMsg);
            resolve(e.data.html);
          }
        };
        window.addEventListener("message", onMsg);
        window.postMessage({ oc: "serialize" }, "*");
      });
    });
    check("serializa sin la UI del editor", !/data-oc-ui/.test(serialized));
    check("serializa sin las guías", !/oc-gl/.test(serialized));
    check("conserva el contenido de la lámina", /Titulo uno/.test(serialized) && /id="sq"/.test(serialized));

    check("no hubo errores de JS en toda la corrida", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} verificaciones OK` +
      (failed.length ? ` — ${failed.length} fallaron\n` : "\n")
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
