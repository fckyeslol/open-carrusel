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
import sharp from "sharp";
import { stripBackgroundInPage } from "../src/lib/strip-slide-background.mjs";

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
  // Un backtick suelto (típico: en un comentario) CIERRA el template string y
  // rompe la compilación del .ts, aunque el JS del runtime siga siendo válido y
  // las pruebas de acá pasen igual. Se detecta explícitamente.
  if (body.includes("`")) {
    const line = src.slice(0, from + body.indexOf("`")).split("\n").length;
    throw new Error(
      `Backtick suelto dentro de EDITOR_RUNTIME (línea ${line} de slide-editor.ts): ` +
        "cierra el template string. Sacalo del comentario o del código."
    );
  }
  // La única interpolación del runtime es la lista de grosores de Google Fonts.
  const rest = body.replace(/\$\{GF_ITAL_WGHT\}/g, "wght@400");
  if (rest.includes("${")) {
    throw new Error("Interpolación inesperada en EDITOR_RUNTIME: " + rest.match(/\$\{[^}]*\}/)[0]);
  }
  return rest;
}

/**
 * Lámina que reproduce los casos que rompían el posicionamiento de imágenes:
 * transform declarado en un <style> (no inline), left/top declarados en un <style>,
 * y un elemento rotado. Un PNG de 2x1 en data: URI evita depender de la red.
 */
const PIX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFUlEQVR4nGP8z8DAwMTAwMDAwMAAABQYAd8kRJIAAAAASUVORK5CYII=";
const SLIDE_IMG = `
<style>
  #centrada { position:absolute; left:540px; top:400px; transform:translate(-50%,-50%); width:300px; height:200px; }
  #porhoja  { position:absolute; left:200px; top:900px; width:240px; height:160px; }
  /* inline + relative con desplazamiento de hoja: va por left/top, no por transform */
  #enflujo  { position:relative; left:60px; top:24px; font-size:40px; font-family:Inter; }
</style>
<div id="root" style="position:relative;width:${W}px;height:${H}px;background:#f6f5f0">
  <img id="centrada" src="${PIX}">
  <img id="porhoja" src="${PIX}">
  <div id="girado" data-oc-shape="1" style="position:absolute;left:700px;top:150px;width:200px;height:120px;background:#4f7cff;rotate:30deg"></div>
  <span id="enflujo">Texto en flujo</span>
</div>`;

/**
 * Lámina de prueba con coordenadas conocidas. #barra es un <div> decorativo tal
 * como lo escribe el agente: sin texto y sin data-oc-shape (ese atributo lo pone
 * solo la librería de formas del editor).
 */
const SLIDE = `
<div id="root" style="position:relative;width:${W}px;height:${H}px;background:#f6f5f0">
  <div id="t1" style="position:absolute;left:100px;top:200px;width:320px;font-size:52px;font-family:Inter;color:#111">Titulo uno</div>
  <div id="t2" style="position:absolute;left:100px;top:640px;width:320px;font-size:38px;font-family:Inter;color:#111">Segundo texto</div>
  <div id="barra" style="position:absolute;left:100px;top:800px;width:180px;height:8px;background:#ff3b7f"></div>
  <div id="sq" data-oc-shape="1" style="position:absolute;left:700px;top:200px;width:200px;height:200px;background:#4f7cff"></div>
  <div id="nested" style="position:absolute;left:600px;top:900px;width:360px;height:300px;background:#ffffff">
    <div id="deep" data-oc-shape="1" style="position:absolute;left:40px;top:40px;width:120px;height:120px;background:#ff3b7f"></div>
  </div>
</div>`;

/**
 * El caso del velo: una foto a sangre, el degradado que la oscurece para que el
 * titular se lea, y un titular encima. Medido sobre las 276 láminas guardadas, 77
 * (28%) tienen un velo así y NINGUNO se podía tomar — "una sombra que NO es
 * editable". `#fondo` es el otro lado de la moneda: un color plano y opaco a lámina
 * completa que debe seguir SIN tomarse, para que clicar en un vacío deseleccione.
 */
const SLIDE_VELO = `
<div id="root" style="position:relative;width:${W}px;height:${H}px;background:#f6f5f0">
  <div id="fondo" style="position:absolute;inset:0;background:#242424"></div>
  <img id="foto" src="${PIX}" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;object-fit:cover">
  <div id="velo" style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 35%,rgba(0,0,0,.85) 100%)"></div>
  <div id="titulo" style="position:absolute;left:100px;top:1100px;width:700px;font-size:56px;font-family:Inter;color:#fff">Titular sobre el velo</div>
  <div id="chip" data-oc-shape="1" style="position:absolute;left:760px;top:120px;width:180px;height:80px;background:#ff3b7f"></div>
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
      (await selCount(page)) === 5,
      `sel=${await selCount(page)}`
    );

    // Un bloque decorativo (barra, tarjeta, bloque de color) no es texto, ni IMG,
    // ni lleva data-oc-shape — pero el clic SÍ lo toma. Si la banda y Ctrl+A no lo
    // ven, escalar el conjunto deja la barra en su tamaño viejo y rompe la
    // composición en silencio.
    console.log("\nBloques decorativos");
    await reset();
    await page.mouse.click(150, 804); // dentro de #barra
    await new Promise((r) => setTimeout(r, 60));
    check("el clic toma un div decorativo", (await selCount(page)) === 1, `sel=${await selCount(page)}`);
    await reset();
    await drag(page, 50, 560, 520, 900); // toca #t2 y #barra
    check("la banda también lo toma", (await selCount(page)) === 2, `sel=${await selCount(page)}`);
    const barInAll = await page.evaluate(() => {
      window.postMessage({ oc: "deselect" }, "*");
      return true;
    });
    void barInAll;
    await reset();
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    const barSelected = await page.evaluate(() => {
      const b = document.querySelector("#barra").getBoundingClientRect();
      return [...document.querySelectorAll(".oc-box")].some((x) => {
        const r = x.getBoundingClientRect();
        return Math.abs(r.left - b.left) < 2 && Math.abs(r.top - b.top) < 2;
      });
    });
    check("Ctrl+A también lo toma", barSelected);

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

    // El overlay se REPOSICIONA durante el gesto, no se reconstruye: si la escala
    // llamara paint() por frame, tiraría abajo cajas, envolvente y listeners 60
    // veces por segundo. Se comprueba marcando el nodo y viendo que sobreviva.
    await reset();
    await drag(page, 50, 120, 520, 780);
    const gboxBefore = await page.evaluate(() => {
      const g = document.querySelector(".oc-gbox");
      g.setAttribute("data-probe", "1");
      const q = ["#t1", "#t2"].map((s) => document.querySelector(s).getBoundingClientRect());
      return {
        w: g.getBoundingClientRect().width,
        right: Math.max(...q.map((r) => r.right)),
        bottom: Math.max(...q.map((r) => r.bottom)),
      };
    });
    // Agarrar la esquina SE de verdad y quedarse apretado a mitad del gesto.
    await drag(page, gboxBefore.right, gboxBefore.bottom, gboxBefore.right + 120, gboxBefore.bottom,
      { keepDown: true });
    const surviving = await page.evaluate(() => {
      const g = document.querySelector(".oc-gbox");
      return { probe: g && g.getAttribute("data-probe"), w: g && g.getBoundingClientRect().width };
    });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 60));
    check("la envolvente sigue el gesto", surviving.w > gboxBefore.w + 40,
      `${gboxBefore.w} → ${surviving.w}`);
    check("no reconstruye el overlay durante la escala", surviving.probe === "1",
      `probe=${surviving.probe}`);

    // Un miembro que vive DENTRO de otro miembro: el padre ya se lo lleva puesto.
    // Si además se le suma el desplazamiento absoluto, se mueve el doble y sale
    // volando fuera de su contenedor.
    // Cruce de las dos features: la sombra de puntos es un elemento aparte y la
    // multi-selección la excluye a propósito, así que hay que sincronizarla a mano
    // durante el gesto. Al soltar siempre queda bien (serialize la recalza); lo que
    // se verifica acá es que no vaya atrasada EN VIVO.
    console.log("\nSombra durante la escala de un conjunto");
    await reset();
    await page.mouse.click(800, 300); // #sq
    await new Promise((r) => setTimeout(r, 60));
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "shadow", value: "dots" }, "*"));
    await new Promise((r) => setTimeout(r, 140));
    await page.evaluate(() => window.postMessage({ oc: "deselect" }, "*"));
    await new Promise((r) => setTimeout(r, 60));
    // La banda tiene que tomar DOS elementos: con uno solo no hay escala de
    // conjunto sino un resize normal, que ya sincroniza por otro camino.
    await drag(page, 50, 120, 980, 480); // #t1 + #sq (la sombra queda afuera)
    const scaled = await selCount(page);
    check("la banda arma un conjunto de 2 (no un resize suelto)", scaled === 2, `sel=${scaled}`);
    if (scaled === 2) {
      const bbS = await page.evaluate(() => {
        const q = ["#t1", "#sq"].map((s) => document.querySelector(s).getBoundingClientRect());
        return {
          right: Math.max(...q.map((r) => r.right)),
          bottom: Math.max(...q.map((r) => r.bottom)),
        };
      });
      await drag(page, bbS.right, bbS.bottom, bbS.right + 100, bbS.bottom, { keepDown: true });
      const live = await page.evaluate(() => {
        const sh = document.querySelector('[data-oc-role="dots"]');
        const own = document.querySelector("#sq").getBoundingClientRect();
        return { sh: sh ? sh.getBoundingClientRect().width : -1, own: own.width };
      });
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 80));
      check("la sombra acompaña el gesto en vivo, no recién al soltar",
        live.sh > 0 && Math.abs(live.sh - live.own) < 4, `sombra=${live.sh} dueño=${live.own}`);
    }

    console.log("\nMiembro anidado dentro de otro miembro");
    await reset();
    await page.mouse.click(900, 1150); // #nested, lejos de #deep
    await new Promise((r) => setTimeout(r, 60));
    await page.keyboard.down("Shift");
    await page.mouse.click(700, 1000); // #deep
    await page.keyboard.up("Shift");
    await new Promise((r) => setTimeout(r, 60));
    check("selecciona contenedor + hijo", (await selCount(page)) === 2, `sel=${await selCount(page)}`);
    // Esquina NW → el ancla es la esquina opuesta, así que el contenedor SE MUEVE.
    await drag(page, 600, 900, 420, 900);
    const nestedAfter = await rectOf(page, "nested");
    const deepAfter = await rectOf(page, "deep");
    check("el contenedor escala x1.5 desde el ancla opuesta",
      Math.abs(nestedAfter.left - 420) < 2 && Math.abs(nestedAfter.width - 540) < 2,
      `nested=(${nestedAfter.left}, w=${nestedAfter.width})`);
    check("el hijo escala una sola vez (no se va afuera)",
      Math.abs(deepAfter.left - nestedAfter.left - 60) < 3 &&
        Math.abs(deepAfter.top - nestedAfter.top - 60) < 3,
      `offset=(${deepAfter.left - nestedAfter.left}, ${deepAfter.top - nestedAfter.top}) esperado=(60, 60)`);
    check("y su tamaño sí escala (120 → 180)", Math.abs(deepAfter.width - 180) < 3, `w=${deepAfter.width}`);

    // Lo mismo al arrastrar: el hijo hereda el transform del padre.
    await reset();
    await page.mouse.click(900, 1150);
    await new Promise((r) => setTimeout(r, 60));
    await page.keyboard.down("Shift");
    await page.mouse.click(700, 1000);
    await page.keyboard.up("Shift");
    await new Promise((r) => setTimeout(r, 60));
    const preDrag = { nested: await rectOf(page, "nested"), deep: await rectOf(page, "deep") };
    await drag(page, 900, 1150, 780, 1150, { altDuring: true }); // Alt = sin imán
    const postDrag = { nested: await rectOf(page, "nested"), deep: await rectOf(page, "deep") };
    check("arrastrar contenedor + hijo mueve al hijo una sola vez",
      Math.abs(postDrag.deep.left - preDrag.deep.left - (postDrag.nested.left - preDrag.nested.left)) < 2,
      `padre movió ${postDrag.nested.left - preDrag.nested.left}, hijo ${postDrag.deep.left - preDrag.deep.left}`);

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

    // Las capas vinculadas (sombra de puntos, superficies) son HERMANOS del
    // elemento, no hijos, así que outerHTML no las arrastra: sin meterlas en el
    // clip, duplicar devolvía la copia pelada. Mismo caso que los grupos.
    console.log("\nDuplicar con capas vinculadas");
    for (const [nombre, msg] of [
      ["sombra de puntos", { oc: "apply", prop: "shadow", value: "dots" }],
      ["superficie", { oc: "apply", prop: "fxLayer", value: { kind: "crt", value: 60 } }],
    ]) {
      await reset();
      await page.mouse.click(800, 300); // #sq
      await new Promise((r) => setTimeout(r, 60));
      await page.evaluate((m) => window.postMessage(m, "*"), msg);
      await new Promise((r) => setTimeout(r, 140));
      const antes = await page.evaluate(() => document.querySelectorAll("[data-oc-owner]").length);
      await page.evaluate(() => window.postMessage({ oc: "duplicate" }, "*"));
      await new Promise((r) => setTimeout(r, 200));
      const desp = await page.evaluate(() => ({
        capas: document.querySelectorAll("[data-oc-owner]").length,
        huerfanas: [...document.querySelectorAll("[data-oc-owner]")].filter(
          (l) => !document.querySelector(`[data-oc-id="${l.getAttribute("data-oc-owner")}"]`)
        ).length,
      }));
      check(`la copia conserva su ${nombre}`, antes === 1 && desp.capas === 2 && desp.huerfanas === 0,
        `capas ${antes}→${desp.capas}, huérfanas=${desp.huerfanas}`);
    }

    // ── Fase 3: capas ──────────────────────────────────────────────────────────
    /** Árbol de capas actual: deseleccionar provoca el report que lo emite. */
    const tree = () =>
      page.evaluate(
        () =>
          new Promise((resolve) => {
            const onMsg = (e) => {
              if (e.data && e.data.oc === "layers") {
                window.removeEventListener("message", onMsg);
                resolve(e.data.items);
              }
            };
            window.addEventListener("message", onMsg);
            window.postMessage({ oc: "deselect" }, "*");
          })
      );

    console.log("\nÁrbol de capas");
    await reset();
    let t = await tree();
    // Contra el DOM, no contra un número fijo: el fixture crece cada vez que se
    // suma un caso y una constante acá se rompe sin que haya bug.
    const rootKids = await page.evaluate(() => document.querySelector("#root").children.length);
    check("reporta las capas de la raíz", Array.isArray(t) && t.length === rootKids,
      `filas=${t && t.length} hijos de #root=${rootKids}`);
    const nestedRow = t.find((r) => (r.children || []).length > 0);
    check("expande los contenedores (capas anidadas visibles)", !!nestedRow, "ningún contenedor con hijos");
    check(
      "la capa anidada aparece dentro de su contenedor",
      !!nestedRow && nestedRow.children.length === 1,
      `hijos=${nestedRow && nestedRow.children.length}`
    );
    const textRow = t.find((r) => r.kind === "text");
    check("etiqueta los textos con su contenido", !!textRow && /Titulo|Segundo/.test(textRow.label), textRow?.label);
    check("primera fila = frente", t[0].id !== undefined);

    console.log("\nGrupos en el panel");
    await reset();
    const rowsBeforeGroup = (await tree()).length;
    await drag(page, 50, 120, 520, 780);
    await page.evaluate(() => window.postMessage({ oc: "group" }, "*"));
    await new Promise((r) => setTimeout(r, 80));
    t = await tree();
    const groupRow = t.find((r) => r.kind === "group");
    check("el grupo se reporta como una sola fila", !!groupRow, "no hay fila de grupo");
    check(
      "con sus miembros adentro para expandir",
      !!groupRow && groupRow.children.length === 2,
      `miembros=${groupRow && groupRow.children.length}`
    );
    // Dos miembros colapsan en una sola fila de grupo → una fila menos que antes.
    check("y no vuelve a listar los miembros como sueltos", t.length === rowsBeforeGroup - 1,
      `filas=${t.length} esperado=${rowsBeforeGroup - 1}`);

    console.log("\nAl frente / al fondo entre contenedores");
    await reset();
    // #deep vive dentro de #nested. Traerlo al frente tiene que dejarlo sobre TODO,
    // no solo sobre sus hermanos dentro de #nested (el bug reportado).
    await page.mouse.click(650, 1000);
    await new Promise((r) => setTimeout(r, 60));
    const selIsDeep = await page.evaluate(
      () => document.querySelectorAll(".oc-box").length === 1
    );
    check("selecciona el elemento anidado", selIsDeep);
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "front", value: true }, "*"));
    await new Promise((r) => setTimeout(r, 100));
    // El punto (650,1000) está sobre #deep y también sobre #nested y #sq si se
    // solaparan: comprobamos que #deep sea lo más alto en ese punto.
    const topAt = await page.evaluate(() => {
      const list = document.elementsFromPoint(650, 1000).filter((el) => !el.closest("[data-oc-ui]"));
      return list[0] ? list[0].id : null;
    });
    check("'al frente' saca el elemento anidado por encima de todo", topAt === "deep", `arriba=${topAt}`);
    const zChain = await page.evaluate(() => ({
      deep: getComputedStyle(document.querySelector("#deep")).zIndex,
      nested: getComputedStyle(document.querySelector("#nested")).zIndex,
    }));
    check(
      "sube también el contenedor (cadena de ancestros)",
      Number(zChain.nested) > 0,
      `z(nested)=${zChain.nested} z(deep)=${zChain.deep}`
    );

    console.log("\nBloquear y ocultar");
    await reset();
    t = await tree();
    const sqRow = t.find((r) => r.kind === "shape" && !r.children.length);
    await page.evaluate(
      (id) => window.postMessage({ oc: "layerFlag", id, flag: "lock", value: true }, "*"),
      sqRow.id
    );
    await new Promise((r) => setTimeout(r, 80));
    const lockedId = await page.evaluate((id) => {
      const el = document.querySelector(`[data-oc-id="${id}"]`);
      return el ? el.getAttribute("data-oc-lock") : null;
    }, sqRow.id);
    check("bloquear marca la capa", lockedId === "1");
    // Clic sobre una capa bloqueada no la selecciona.
    const lockedRect = await page.evaluate((id) => {
      const r = document.querySelector(`[data-oc-id="${id}"]`).getBoundingClientRect();
      return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, left: r.left };
    }, sqRow.id);
    await page.mouse.click(lockedRect.x, lockedRect.y);
    await new Promise((r) => setTimeout(r, 60));
    check("una capa bloqueada no se selecciona con el clic", (await selCount(page)) === 0, `sel=${await selCount(page)}`);
    // Seleccionada desde el panel, tampoco se arrastra.
    await page.evaluate((id) => window.postMessage({ oc: "selectLayer", id }, "*"), sqRow.id);
    await new Promise((r) => setTimeout(r, 60));
    check("desde el panel sí se puede tomar (para desbloquear)", (await selCount(page)) === 1);
    const noHandles = await page.evaluate(() => document.querySelectorAll(".oc-h").length === 0);
    check("una capa bloqueada no muestra handles", noHandles);
    await drag(page, lockedRect.x, lockedRect.y, lockedRect.x - 200, lockedRect.y);
    const afterLockDrag = await page.evaluate((id) => {
      return document.querySelector(`[data-oc-id="${id}"]`).getBoundingClientRect().left;
    }, sqRow.id);
    check("una capa bloqueada no se mueve al arrastrar", Math.abs(afterLockDrag - lockedRect.left) < 0.6,
      `left=${afterLockDrag} antes=${lockedRect.left}`);
    // Borrar tampoco la toca.
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "remove", value: true }, "*"));
    await new Promise((r) => setTimeout(r, 80));
    const stillThere = await page.evaluate((id) => !!document.querySelector(`[data-oc-id="${id}"]`), sqRow.id);
    check("ni se borra", stillThere);

    await reset();
    t = await tree();
    const hideRow = t.find((r) => r.kind === "shape" && !r.children.length);
    await page.evaluate(
      (id) => window.postMessage({ oc: "layerFlag", id, flag: "hide", value: true }, "*"),
      hideRow.id
    );
    await new Promise((r) => setTimeout(r, 80));
    const hiddenState = await page.evaluate((id) => {
      const el = document.querySelector(`[data-oc-id="${id}"]`);
      return { attr: el.getAttribute("data-oc-hide"), display: el.style.display };
    }, hideRow.id);
    check("ocultar apaga el elemento", hiddenState.attr === "1" && hiddenState.display === "none");
    await page.evaluate(
      (id) => window.postMessage({ oc: "layerFlag", id, flag: "hide", value: false }, "*"),
      hideRow.id
    );
    await new Promise((r) => setTimeout(r, 80));
    const shownAgain = await page.evaluate((id) => {
      const el = document.querySelector(`[data-oc-id="${id}"]`);
      return { attr: el.getAttribute("data-oc-hide"), display: el.style.display };
    }, hideRow.id);
    check("y volver a mostrarlo lo restituye", !shownAgain.attr && shownAgain.display !== "none");

    console.log("\nRenombrar y reordenar");
    await reset();
    t = await tree();
    await page.evaluate(
      (id) => window.postMessage({ oc: "layerName", id, name: "Marco principal" }, "*"),
      t[0].id
    );
    await new Promise((r) => setTimeout(r, 80));
    t = await tree();
    check("renombrar persiste en la capa", t[0].label === "Marco principal", `label=${t[0].label}`);

    await reset();
    t = await tree();
    const orig = t.map((r) => r.id);
    // Mandar la primera fila (frente) al final (fondo).
    const moved = [...orig.slice(1), orig[0]];
    await page.evaluate((ids) => window.postMessage({ oc: "reorderLayers", ids }, "*"), moved);
    await new Promise((r) => setTimeout(r, 100));
    t = await tree();
    check(
      "arrastrar en el panel reordena de verdad",
      t.map((r) => r.id).join() === moved.join(),
      `orden=${t.map((r) => r.id).join()}`
    );

    // ── Fase 4: posicionamiento y reemplazo de imágenes ───────────────────────
    const pageFor = async (body) => {
      await page.setContent(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}html,body{width:${W}px;height:${H}px;overflow:hidden;position:relative}
</style></head><body>${body}<script>${runtime}<\/script></body></html>`,
        { waitUntil: "domcontentloaded" }
      );
      await new Promise((r) => setTimeout(r, 200));
    };

    console.log("\nArrastre de imágenes (transform y left/top de hoja de estilos)");
    await pageFor(SLIDE_IMG);
    // #centrada se centra con transform:translate(-50%,-50%) desde el <style>.
    // Arrastrarla 100px a la derecha tiene que moverla EXACTAMENTE 100px, no
    // saltar media caja por perder el translate de la hoja.
    let before = await rectOf(page, "centrada");
    await page.mouse.click(before.left + 20, before.top + 20);
    await new Promise((r) => setTimeout(r, 60));
    await drag(
      page,
      before.left + 20,
      before.top + 20,
      before.left + 120,
      before.top + 20,
      { altDuring: true }
    );
    let after = await rectOf(page, "centrada");
    check(
      "una imagen centrada con transform de <style> se mueve lo que se arrastra",
      Math.abs(after.left - (before.left + 100)) < 2 && Math.abs(after.top - before.top) < 2,
      `movió (${(after.left - before.left).toFixed(1)}, ${(after.top - before.top).toFixed(1)}) esperado (100, 0)`
    );

    // #porhoja está posicionada en absoluto desde el <style> (sin nada inline):
    // el arrastre tiene que sumar sobre su posición real.
    before = await rectOf(page, "porhoja");
    await page.mouse.click(before.left + 20, before.top + 20);
    await new Promise((r) => setTimeout(r, 60));
    await drag(
      page,
      before.left + 20,
      before.top + 20,
      before.left + 20 - 80,
      before.top + 20 + 40,
      { altDuring: true }
    );
    after = await rectOf(page, "porhoja");
    check(
      "una imagen posicionada desde <style> no salta al origen",
      Math.abs(after.left - (before.left - 80)) < 2 && Math.abs(after.top - (before.top + 40)) < 2,
      `movió (${(after.left - before.left).toFixed(1)}, ${(after.top - before.top).toFixed(1)}) esperado (-80, 40)`
    );

    // Elemento inline con position:relative y left/top de hoja: se mueve por
    // left/top (no por transform), y su base tiene que ser la de la hoja.
    before = await rectOf(page, "enflujo");
    await page.mouse.click(before.left + 10, before.top + 20);
    await new Promise((r) => setTimeout(r, 60));
    await drag(
      page,
      before.left + 10,
      before.top + 20,
      before.left + 10 + 70,
      before.top + 20 + 30,
      { altDuring: true }
    );
    after = await rectOf(page, "enflujo");
    check(
      "un inline desplazado desde <style> se mueve lo que se arrastra",
      Math.abs(after.left - (before.left + 70)) < 2 && Math.abs(after.top - (before.top + 30)) < 2,
      `movió (${(after.left - before.left).toFixed(1)}, ${(after.top - before.top).toFixed(1)}) esperado (70, 30)`
    );

    console.log("\nElemento rotado");
    await pageFor(SLIDE_IMG);
    // Al tocar un elemento rotado (posicionarlo por panel) no debe crecer: su caja
    // de layout es 200x120, no la envolvente del giro.
    const gBefore = await page.evaluate(() => {
      const el = document.querySelector("#girado");
      const prev = el.style.rotate;
      el.style.rotate = "none";
      const r = el.getBoundingClientRect();
      el.style.rotate = prev;
      return { w: r.width, h: r.height, left: r.left, top: r.top };
    });
    await page.mouse.click(800, 210);
    await new Promise((r) => setTimeout(r, 60));
    const reported = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const onMsg = (e) => {
            if (e.data && e.data.oc === "sel" && !e.data.none) {
              window.removeEventListener("message", onMsg);
              resolve(e.data);
            }
          };
          window.addEventListener("message", onMsg);
          window.postMessage({ oc: "apply", prop: "opacity", value: 100 }, "*");
        })
    );
    check(
      "el panel reporta la caja de layout, no la envolvente del giro",
      Math.abs(reported.w - gBefore.w) < 2 && Math.abs(reported.h - gBefore.h) < 2,
      `reportó ${reported.w}x${reported.h}, layout ${gBefore.w}x${gBefore.h}`
    );
    // Fijar X por panel: no debe cambiar el tamaño.
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "x", value: 300 }, "*"));
    await new Promise((r) => setTimeout(r, 100));
    const gAfter = await page.evaluate(() => {
      const el = document.querySelector("#girado");
      const prev = el.style.rotate;
      el.style.rotate = "none";
      const r = el.getBoundingClientRect();
      el.style.rotate = prev;
      return { w: r.width, h: r.height, left: r.left };
    });
    check(
      "posicionar un elemento rotado no lo agranda",
      Math.abs(gAfter.w - gBefore.w) < 2 && Math.abs(gAfter.h - gBefore.h) < 2,
      `${gAfter.w}x${gAfter.h} vs ${gBefore.w}x${gBefore.h}`
    );
    check("y lo lleva a la X pedida", Math.abs(gAfter.left - 300) < 2, `left=${gAfter.left}`);
    check("conserva la rotación", (await page.evaluate(
      () => document.querySelector("#girado").style.rotate
    )).indexOf("30") === 0);

    console.log("\nReemplazar imagen conservando la caja");
    await pageFor(SLIDE_IMG);
    const boxBefore = await rectOf(page, "porhoja");
    await page.mouse.click(boxBefore.left + 20, boxBefore.top + 20);
    await new Promise((r) => setTimeout(r, 60));
    // Imagen nueva con OTRA proporción (2x1 → 1x3): sin keepBox el alto cambiaba.
    const TALL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAADCAYAAABS3WWCAAAAFUlEQVR4nGP8z8DAwMTAwMDAwMAAABQYAd8kRJIAAAAASUVORK5CYII=";
    await page.evaluate(
      (url) => window.postMessage({ oc: "setImgSrc", url, keepBox: true }, "*"),
      TALL
    );
    await new Promise((r) => setTimeout(r, 200));
    const boxAfter = await rectOf(page, "porhoja");
    check(
      "la imagen nueva ocupa la misma caja",
      Math.abs(boxAfter.width - boxBefore.width) < 2 &&
        Math.abs(boxAfter.height - boxBefore.height) < 2 &&
        Math.abs(boxAfter.left - boxBefore.left) < 2 &&
        Math.abs(boxAfter.top - boxBefore.top) < 2,
      `${boxAfter.width}x${boxAfter.height} en (${boxAfter.left},${boxAfter.top}) vs ${boxBefore.width}x${boxBefore.height} en (${boxBefore.left},${boxBefore.top})`
    );
    check(
      "y no se deforma (object-fit: cover)",
      (await page.evaluate(() => getComputedStyle(document.querySelector("#porhoja")).objectFit)) ===
        "cover"
    );
    check(
      "el reemplazo queda en el historial de versiones",
      (await page.evaluate(() =>
        JSON.parse(document.querySelector("#porhoja").getAttribute("data-oc-imghist") || "[]")
      )).length === 2
    );

    console.log("\nEncaje de la imagen");
    await pageFor(SLIDE_IMG);
    const fitBox = await rectOf(page, "centrada");
    await page.mouse.click(fitBox.left + 20, fitBox.top + 20);
    await new Promise((r) => setTimeout(r, 60));
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "fit", value: "contain" }, "*"));
    await new Promise((r) => setTimeout(r, 100));
    check(
      "'contener' respeta la caja",
      (await page.evaluate(() => getComputedStyle(document.querySelector("#centrada")).objectFit)) ===
        "contain"
    );
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "fit", value: "auto" }, "*"));
    await new Promise((r) => setTimeout(r, 150));
    const autoFit = await page.evaluate(() => ({
      of: document.querySelector("#centrada").style.objectFit,
      h: document.querySelector("#centrada").style.height,
    }));
    check("'alto natural' suelta la caja", !autoFit.of && autoFit.h === "auto", JSON.stringify(autoFit));

    // ── Fase 5: edición de texto ──────────────────────────────────────────────
    const SLIDE_TEXT = `
<div id="root" style="position:relative;width:${W}px;height:${H}px;background:#f6f5f0">
  <div id="mix" style="position:absolute;left:80px;top:200px;width:600px;font-size:48px;font-family:Inter;color:#111">Hola <strong id="fuerte" style="font-weight:800;color:#ff3b7f">mundo</strong> lindo</div>
  <div id="caja" style="position:absolute;left:80px;top:600px;padding:24px;background:#ffe08a">
    <div id="dentro" style="font-size:40px;font-family:Inter;color:#111">Texto con caja</div>
  </div>
</div>`;

    console.log("\nFormato parcial del texto");
    await pageFor(SLIDE_TEXT);
    const fmtBefore = await page.evaluate(() => ({
      html: document.querySelector("#mix").innerHTML,
      weight: getComputedStyle(document.querySelector("#fuerte")).fontWeight,
    }));
    check("la lámina arranca con un tramo en negrita", fmtBefore.weight === "800");
    await page.mouse.click(120, 225);
    await new Promise((r) => setTimeout(r, 60));
    // Editar el texto desde el panel: cambiar "lindo" por "lindisimo".
    await page.evaluate(() =>
      window.postMessage({ oc: "apply", prop: "text", value: "Hola mundo lindisimo" }, "*")
    );
    await new Promise((r) => setTimeout(r, 120));
    const fmtAfter = await page.evaluate(() => {
      const el = document.querySelector("#mix");
      const st = document.querySelector("#fuerte");
      return {
        text: el.textContent,
        stillBold: st ? getComputedStyle(st).fontWeight : null,
        boldText: st ? st.textContent : null,
      };
    });
    check("editar el texto conserva el tramo con formato", fmtAfter.stillBold === "800",
      `negrita=${fmtAfter.stillBold}`);
    check("el tramo conserva su contenido", fmtAfter.boldText === "mundo", `tramo="${fmtAfter.boldText}"`);
    check("y el texto queda como se pidió", fmtAfter.text === "Hola mundo lindisimo", `"${fmtAfter.text}"`);

    // Borrar dentro del tramo con formato.
    await page.evaluate(() =>
      window.postMessage({ oc: "apply", prop: "text", value: "Hola mun lindisimo" }, "*")
    );
    await new Promise((r) => setTimeout(r, 120));
    const shrunk = await page.evaluate(() => {
      const el = document.querySelector("#mix");
      const st = document.querySelector("#fuerte");
      return { text: el.textContent, boldText: st ? st.textContent : null };
    });
    check("borrar dentro del tramo lo recorta sin perderlo", shrunk.boldText === "mun",
      `tramo="${shrunk.boldText}"`);
    check("y el texto completo es el pedido", shrunk.text === "Hola mun lindisimo", `"${shrunk.text}"`);

    // Reemplazo total: sin prefijo ni sufijo común, cae a texto plano.
    await page.evaluate(() =>
      window.postMessage({ oc: "apply", prop: "text", value: "Otro titular" }, "*")
    );
    await new Promise((r) => setTimeout(r, 120));
    check(
      "un reemplazo total reescribe el texto",
      (await page.evaluate(() => document.querySelector("#mix").textContent)) === "Otro titular"
    );

    console.log("\nQuitar formato");
    await pageFor(SLIDE_TEXT);
    await page.mouse.click(120, 225);
    await new Promise((r) => setTimeout(r, 60));
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "clearFormat", value: true }, "*"));
    await new Promise((r) => setTimeout(r, 120));
    const cleared = await page.evaluate(() => ({
      hasStrong: !!document.querySelector("#mix strong"),
      text: document.querySelector("#mix").textContent,
    }));
    check("quitar formato desarma los tramos", !cleared.hasStrong);
    check("sin perder el texto", cleared.text === "Hola mundo lindo", `"${cleared.text}"`);

    console.log("\nFondo de la caja de texto");
    await pageFor(SLIDE_TEXT);
    const inBox = await rectOf(page, "dentro");
    await page.mouse.click(inBox.left + 20, inBox.top + 20);
    const boxReport = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const onMsg = (e) => {
            if (e.data && e.data.oc === "sel" && !e.data.none) {
              window.removeEventListener("message", onMsg);
              resolve(e.data);
            }
          };
          window.addEventListener("message", onMsg);
          window.postMessage({ oc: "apply", prop: "opacity", value: 100 }, "*");
        })
    );
    check("detecta que el color viene del contenedor", boxReport.boxBg === "#ffe08a", `boxBg=${boxReport.boxBg}`);
    check("y que el texto mismo no tiene fondo", !boxReport.bg, `bg=${boxReport.bg}`);
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "boxBg", value: "transparent" }, "*"));
    await new Promise((r) => setTimeout(r, 120));
    check(
      "'sin fondo' de la caja limpia el contenedor",
      (await page.evaluate(() => getComputedStyle(document.querySelector("#caja")).backgroundColor)) ===
        "rgba(0, 0, 0, 0)"
    );

    // ── Fotos dentro de marcos ────────────────────────────────────────────────
    // El medallón del formato de cierre: contenedor redondo con overflow:hidden y
    // la foto a width/height:100% + object-fit:cover. #libre es la misma foto pero
    // suelta sobre la lámina: el borde del lienzo NO debe contar como marco.
    // PIX es de 2x1, así que en una caja cuadrada con 'cover' sobra ancho (el eje X
    // tiene juego) y el alto calza justo (el eje Y no se mueve).
    const SLIDE_FRAME = `
<div id="root" style="position:relative;width:${W}px;height:${H}px;background:#f6f5f0;overflow:hidden">
  <div id="medallon" style="position:absolute;left:417px;top:150px;width:246px;height:246px;border-radius:50%;overflow:hidden;border:6px solid #FFD400">
    <img id="foto" src="${PIX}" style="width:100%;height:100%;object-fit:cover;object-position:50% 50%">
  </div>
  <img id="libre" src="${PIX}" style="position:absolute;left:100px;top:800px;width:200px;height:120px;object-fit:cover">
  <div id="tarjeta" style="position:absolute;left:100px;top:1000px;width:400px;height:260px;overflow:hidden;background:#fff">
    <img id="chica" src="${PIX}" style="position:absolute;left:20px;top:20px;width:120px;height:80px;object-fit:cover">
  </div>
</div>`;
    const reportFor = (p) =>
      p.evaluate(
        () =>
          new Promise((resolve) => {
            const onMsg = (e) => {
              if (e.data && e.data.oc === "sel" && !e.data.none) {
                window.removeEventListener("message", onMsg);
                resolve(e.data);
              }
            };
            window.addEventListener("message", onMsg);
            window.postMessage({ oc: "apply", prop: "opacity", value: 100 }, "*");
          })
      );

    console.log("\nFotos dentro de un marco");
    await pageFor(SLIDE_FRAME);
    const fotoAntes = await rectOf(page, "foto");
    await page.mouse.click(fotoAntes.left + 40, fotoAntes.top + 40);
    await new Promise((r) => setTimeout(r, 60));
    const framed = await reportFor(page);
    check("detecta que la foto está dentro de un marco", framed.framed === true);
    check("y que la llena, así que el arrastre reencuadra", framed.panning === true);
    check("y reporta su encuadre actual", framed.panX === 50 && framed.panY === 50, `${framed.panX}/${framed.panY}`);
    // PIX es 2x1 en una caja cuadrada: sobra ancho, el alto calza justo.
    check(
      "reporta en qué eje hay juego para reencuadrar",
      framed.panFree[0] === true && framed.panFree[1] === false,
      `panFree=${framed.panFree}`
    );

    // Arrastrarla NO la saca del marco (que es lo que la cortaba): reencuadra.
    await drag(page, fotoAntes.left + 40, fotoAntes.top + 40, fotoAntes.left + 140, fotoAntes.top + 40);
    const fotoDespues = await rectOf(page, "foto");
    check(
      "arrastrarla no mueve el elemento: se queda en el marco",
      Math.abs(fotoDespues.left - fotoAntes.left) < 1 && Math.abs(fotoDespues.top - fotoAntes.top) < 1,
      `left ${fotoAntes.left} → ${fotoDespues.left}`
    );
    const op1 = await page.evaluate(() => document.querySelector("#foto").style.objectPosition);
    check("y en cambio corre el encuadre", /^\d/.test(op1) && op1 !== "50% 50%", `objectPosition=${op1}`);
    check("el eje sin juego se queda quieto", / 50%$/.test(op1), `objectPosition=${op1}`);

    // Por más que se arrastre, el encuadre no se sale del rango válido.
    const f2 = await rectOf(page, "foto");
    await drag(page, f2.left + 40, f2.top + 40, f2.left + 2000, f2.top + 40);
    const op2 = await page.evaluate(() => document.querySelector("#foto").style.objectPosition);
    check("el encuadre se queda entre 0 y 100%", op2.startsWith("0%") || op2.startsWith("100%"), `objectPosition=${op2}`);

    // El borde del lienzo no es un marco: una foto suelta se sigue moviendo.
    await pageFor(SLIDE_FRAME);
    const libreAntes = await rectOf(page, "libre");
    await page.mouse.click(libreAntes.left + 20, libreAntes.top + 20);
    await new Promise((r) => setTimeout(r, 60));
    const libreRep = await reportFor(page);
    check("el borde del lienzo no cuenta como marco", libreRep.framed === false);
    await drag(page, libreAntes.left + 20, libreAntes.top + 20, libreAntes.left + 140, libreAntes.top + 20, {
      altDuring: true,
    });
    const libreDespues = await rectOf(page, "libre");
    check(
      "una foto suelta se sigue moviendo normal",
      Math.abs(libreDespues.left - libreAntes.left - 120) < 2,
      `left ${libreAntes.left} → ${libreDespues.left}`
    );

    // Una foto CHICA dentro de una tarjeta que recorta: está enmarcada (tiene
    // "Sacar del marco"), pero no la llena, así que arrastrarla la mueve de verdad.
    await pageFor(SLIDE_FRAME);
    const chicaAntes = await rectOf(page, "chica");
    await page.mouse.click(chicaAntes.left + 20, chicaAntes.top + 20);
    await new Promise((r) => setTimeout(r, 60));
    const chicaRep = await reportFor(page);
    check("una foto chica en una tarjeta sigue contando como enmarcada", chicaRep.framed === true);
    check("pero no reencuadra: no llena el marco", chicaRep.panning === false);
    await drag(page, chicaAntes.left + 20, chicaAntes.top + 20, chicaAntes.left + 120, chicaAntes.top + 20, {
      altDuring: true,
    });
    const chicaDespues = await rectOf(page, "chica");
    check(
      "y se mueve de verdad dentro de la tarjeta",
      Math.abs(chicaDespues.left - chicaAntes.left - 100) < 2,
      `left ${chicaAntes.left} → ${chicaDespues.left}`
    );

    console.log("\nSacar una foto del marco");
    await pageFor(SLIDE_FRAME);
    const antesUf = await rectOf(page, "foto");
    await page.mouse.click(antesUf.left + 40, antesUf.top + 40);
    await new Promise((r) => setTimeout(r, 60));
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "unframe", value: true }, "*"));
    await new Promise((r) => setTimeout(r, 150));
    const despUf = await rectOf(page, "foto");
    check(
      "no salta de lugar ni de tamaño",
      Math.abs(despUf.left - antesUf.left) < 1.5 &&
        Math.abs(despUf.top - antesUf.top) < 1.5 &&
        Math.abs(despUf.width - antesUf.width) < 1.5,
      `${antesUf.left},${antesUf.top} ${antesUf.width}px → ${despUf.left},${despUf.top} ${despUf.width}px`
    );
    check(
      "sale del marco en el DOM",
      (await page.evaluate(() => document.querySelector("#foto").parentElement.id)) === "root"
    );
    check(
      "y hereda el redondeo del marco",
      (await page.evaluate(
        () => getComputedStyle(document.querySelector("#foto")).borderTopLeftRadius
      )) !== "0px"
    );
    const ufRep = await reportFor(page);
    check("ya no la reporta enmarcada", ufRep.framed === false);
    // Y desde ahí se mueve como cualquier otra foto.
    const sueltaAntes = await rectOf(page, "foto");
    await drag(page, sueltaAntes.left + 40, sueltaAntes.top + 40, sueltaAntes.left + 140, sueltaAntes.top + 40, {
      altDuring: true,
    });
    const sueltaDespues = await rectOf(page, "foto");
    check(
      "y ya se mueve libre por la lámina",
      Math.abs(sueltaDespues.left - sueltaAntes.left - 100) < 2,
      `left ${sueltaAntes.left} → ${sueltaDespues.left}`
    );

    console.log("\nMárgenes (relleno interno y margen externo)");
    await pageFor(SLIDE_TEXT);
    const padsOf = (id) =>
      page.evaluate((sel) => {
        const s = getComputedStyle(document.querySelector(sel));
        return [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(",");
      }, `#${id}`);
    await page.mouse.click(120, 225); // #mix
    await new Promise((r) => setTimeout(r, 60));
    const padReport = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const onMsg = (e) => {
            if (e.data && e.data.oc === "sel" && !e.data.none) {
              window.removeEventListener("message", onMsg);
              resolve(e.data);
            }
          };
          window.addEventListener("message", onMsg);
          window.postMessage({ oc: "apply", prop: "padding", value: { side: "all", px: 40 } }, "*");
        })
    );
    check("el relleno se aplica a los cuatro lados", (await padsOf("mix")) === "40px,40px,40px,40px");
    check(
      "y el panel lo recibe de vuelta",
      padReport.padT === 40 && padReport.padL === 40,
      `padT=${padReport.padT} padL=${padReport.padL}`
    );
    check("reporta que el elemento está posicionado libre", padReport.abs === true);

    // Un lado suelto no puede pisar los otros tres: por eso se escriben los
    // longhand (paddingLeft) y no el shorthand.
    await page.evaluate(() =>
      window.postMessage({ oc: "apply", prop: "padding", value: { side: "left", px: 8 } }, "*")
    );
    await new Promise((r) => setTimeout(r, 120));
    check("tocar un lado no borra los otros tres", (await padsOf("mix")) === "40px,40px,40px,8px");

    // El relleno negativo no existe en CSS: se recorta a 0 en vez de quedar inválido.
    await page.evaluate(() =>
      window.postMessage({ oc: "apply", prop: "padding", value: { side: "top", px: -20 } }, "*")
    );
    await new Promise((r) => setTimeout(r, 120));
    check(
      "el relleno negativo se recorta a 0",
      (await page.evaluate(() => getComputedStyle(document.querySelector("#mix")).paddingTop)) ===
        "0px"
    );

    // Margen externo sobre un elemento EN FLUJO: es el caso donde sirve de verdad
    // (en uno posicionado libre haría lo mismo que X/Y).
    await pageFor(SLIDE_TEXT);
    const dentroAntes = await rectOf(page, "dentro");
    await page.mouse.click(dentroAntes.left + 20, dentroAntes.top + 20);
    await new Promise((r) => setTimeout(r, 60));
    await page.evaluate(() =>
      window.postMessage({ oc: "apply", prop: "margin", value: { side: "top", px: 30 } }, "*")
    );
    await new Promise((r) => setTimeout(r, 120));
    const dentroDespues = await rectOf(page, "dentro");
    check(
      "el margen externo corre un elemento en flujo",
      Math.abs(dentroDespues.top - dentroAntes.top - 30) < 1.5,
      `top ${dentroAntes.top} → ${dentroDespues.top}`
    );
    // El margen tiene que sobrevivir a la serialización, o se pierde al guardar.
    const conMargen = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const onMsg = (e) => {
            if (e.data && e.data.oc === "html") {
              window.removeEventListener("message", onMsg);
              resolve(e.data.html);
            }
          };
          window.addEventListener("message", onMsg);
          window.postMessage({ oc: "serialize" }, "*");
        })
    );
    check("el margen queda guardado en el HTML", /margin-top:\s*30px/.test(conMargen));

    console.log("\nEntrar a editar texto");
    await pageFor(SLIDE_TEXT);
    await page.mouse.click(120, 225);
    await new Promise((r) => setTimeout(r, 60));
    await page.evaluate(() => window.postMessage({ oc: "editText" }, "*"));
    await new Promise((r) => setTimeout(r, 80));
    check(
      "el panel puede entrar a la edición inline",
      (await page.evaluate(
        () => document.querySelector('[contenteditable="true"]')?.id
      )) === "mix"
    );
    // ── Escribir de verdad en el lienzo ──────────────────────────────────────
    // El bug: los handles de redimensionar viven ENCIMA del texto y tienen
    // pointer-events:auto. Hacer clic al final de la palabra para corregirla caía
    // en el handle 'e' → resize → al texto le quedaba un width fijo ("se convirtió
    // en una caja") y la edición moría. Sumado a eso, el caret arrancaba siempre al
    // principio del texto, así que lo tecleado entraba delante de todo.
    console.log("\nEscribir en el lienzo (doble clic)");
    await pageFor(SLIDE_TEXT);
    const mixR = await rectOf(page, "mix");
    // Doble clic al FINAL del texto (última palabra), no en el medio.
    const finX = Math.round(mixR.left + 320);
    const finY = Math.round(mixR.top + mixR.height / 2);
    await page.mouse.click(finX, finY);
    await new Promise((r) => setTimeout(r, 60));
    await page.mouse.click(finX, finY, { clickCount: 2 });
    await new Promise((r) => setTimeout(r, 120));
    const enEdicion = await page.evaluate(() => ({
      editable: document.querySelector('[contenteditable="true"]')?.id ?? null,
      // Con algo en edición el overlay NO puede mostrar handles: se comen el clic.
      handlesVisibles: [...document.querySelectorAll(".oc-h")].filter(
        (h) => h.style.display !== "none"
      ).length,
      modo: document.body.classList.contains("oc-editing"),
    }));
    check("el doble clic entra a editar", enEdicion.editable === "mix", enEdicion.editable);
    check("y esconde los handles (si no, se comen el clic del caret)",
      enEdicion.handlesVisibles === 0, `visibles=${enEdicion.handlesVisibles}`);
    check("y marca el modo edición en el body", enEdicion.modo);

    await page.keyboard.type("ZZ");
    await new Promise((r) => setTimeout(r, 120));
    const tecleado = await page.evaluate(() => document.querySelector("#mix").textContent);
    check("lo tecleado NO cae al principio del texto", !tecleado.startsWith("ZZ"), `"${tecleado}"`);
    check("cae donde se hizo el doble clic", /ZZ/.test(tecleado) && !tecleado.startsWith("ZZ"),
      `"${tecleado}"`);

    // Arrastrar sobre el borde derecho del texto MIENTRAS se edita: antes esto era
    // un resize y le horneaba un width al elemento.
    const anchoAntes = await page.evaluate(() => document.querySelector("#mix").style.width);
    await drag(page, Math.round(mixR.right), finY, Math.round(mixR.right) - 60, finY);
    const trasArrastre = await page.evaluate(() => ({
      width: document.querySelector("#mix").style.width,
      texto: document.querySelector("#mix").textContent,
    }));
    check("arrastrar sobre el texto en edición no le fija un ancho",
      trasArrastre.width === anchoAntes, `${anchoAntes || "(sin width)"} → ${trasArrastre.width}`);
    check("y no se pierde lo tecleado", /ZZ/.test(trasArrastre.texto), `"${trasArrastre.texto}"`);

    // Una acción del panel (serializa) no puede expulsar de la edición: el flujo que
    // el panel recomienda es entrar a editar, marcar un tramo y darle formato.
    await pageFor(SLIDE_TEXT);
    await page.mouse.click(120, 225);
    await new Promise((r) => setTimeout(r, 60));
    await page.evaluate(() => window.postMessage({ oc: "editText" }, "*"));
    await new Promise((r) => setTimeout(r, 80));
    await page.evaluate(() =>
      window.postMessage({ oc: "apply", prop: "color", value: "#123456" }, "*")
    );
    await new Promise((r) => setTimeout(r, 120));
    check(
      "una acción del panel no expulsa de la edición",
      (await page.evaluate(() => document.querySelector('[contenteditable="true"]')?.id)) === "mix"
    );
    // Pero el HTML guardado nunca lleva contenteditable, ni editando.
    const serEditando = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const onMsg = (e) => {
            if (e.data && e.data.oc === "html") {
              window.removeEventListener("message", onMsg);
              resolve(e.data.html);
            }
          };
          window.addEventListener("message", onMsg);
          window.postMessage({ oc: "serialize" }, "*");
        })
    );
    check("el HTML serializado no lleva contenteditable", !/contenteditable/i.test(serEditando));

    // Escape cierra la edición (y guarda) sin tener que clicar afuera.
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 120));
    const trasEscape = await page.evaluate(() => ({
      editable: document.querySelector('[contenteditable="true"]')?.id ?? null,
      handles: [...document.querySelectorAll(".oc-h")].filter((h) => h.style.display !== "none").length,
      modo: document.body.classList.contains("oc-editing"),
    }));
    check("Escape sale de la edición", trasEscape.editable === null, trasEscape.editable);
    check("y devuelve los handles", trasEscape.handles > 0, `visibles=${trasEscape.handles}`);
    check("y limpia el modo del body", !trasEscape.modo);

    // Clic en zona vacía: el mousedown llama preventDefault (banda de selección), que
    // cancela el blur nativo. Sin cerrar la edición a mano, el texto quedaba editable
    // para siempre — con los atajos muertos y sin serializar lo tecleado.
    await pageFor(SLIDE_TEXT);
    await page.mouse.click(120, 225);
    await new Promise((r) => setTimeout(r, 60));
    await page.evaluate(() => window.postMessage({ oc: "editText" }, "*"));
    await new Promise((r) => setTimeout(r, 80));
    await page.keyboard.type("QQ");
    await new Promise((r) => setTimeout(r, 80));
    const guardado = await new Promise(async (resolve) => {
      const p = page.evaluate(
        () =>
          new Promise((res) => {
            const onMsg = (e) => {
              if (e.data && e.data.oc === "html") {
                window.removeEventListener("message", onMsg);
                res(e.data.html);
              }
            };
            window.addEventListener("message", onMsg);
          })
      );
      await page.mouse.click(1000, 1250); // zona vacía del lienzo
      resolve(await p);
    });
    check("clicar afuera cierra la edición",
      (await page.evaluate(() => document.querySelector('[contenteditable="true"]'))) === null);
    check("y guarda lo tecleado", /QQ/.test(guardado));

    // Y una caja de texto nueva no pinta nada.
    await pageFor(SLIDE_TEXT);
    await page.evaluate(() => window.postMessage({ oc: "addText" }, "*"));
    await new Promise((r) => setTimeout(r, 100));
    check(
      "un texto nuevo nace sin fondo",
      (await page.evaluate(() => {
        const els = [...document.querySelectorAll("#root > div")];
        const nuevo = els.find((e) => e.textContent === "Texto nuevo");
        return nuevo && getComputedStyle(nuevo).backgroundColor === "rgba(0, 0, 0, 0)";
      })) === true
    );

    // ── Un texto es UN objeto (modelo de Canva) ───────────────────────────────
    // El editor trataba cada tramo de formato como un objeto aparte: al clicar la
    // palabra en negrita se agarraba el <strong>, no la frase, así que cambiarle el
    // tamaño al texto se lo cambiaba a media frase y el párrafo entero era
    // imposible de tomar desde ahí. Y un renglón que comparte caja con el logo 30x
    // en SVG (la regla del proyecto: la marca nunca se tipea) no contaba como texto:
    // no se podía editar NUNCA y el panel ni mostraba la sección "Texto". Las
    // diseñadoras lo describían como "ciertos textos se agrupan dentro de una caja".
    const SLIDE_CANVA = `
<div id="root" style="position:relative;width:${W}px;height:${H}px;background:#f6f5f0">
  <!-- párrafo con una palabra resaltada: un solo objeto -->
  <div id="parr" style="position:absolute;left:80px;top:160px;width:800px;font-size:56px;font-family:Inter;color:#111">El margen pasó de <b id="neg" style="background:#ffe08a">30%</b> a 70%</div>
  <!-- título flex: el navegador "blockifica" al hijo, y aun así es énfasis -->
  <div id="flex" style="position:absolute;left:80px;top:360px;width:800px;display:flex;align-items:center;gap:14px;font-size:56px;font-family:Inter;color:#111">El lenguaje de los <i id="ital" style="font-style:italic;color:#f68f6e">fractales</i></div>
  <!-- renglón del logo: SVG atómico + palabras en la misma caja -->
  <div id="lock" style="position:absolute;left:80px;top:520px;font-size:32px;font-family:Inter;color:#111"><svg id="marca" viewBox="0 0 100 40" style="height:.8em;width:2em;vertical-align:baseline"><rect width="100" height="40" fill="#111"></rect></svg> · Executive Education</div>
  <!-- texto adentro de una tarjeta: el doble clic tiene que entrar -->
  <div id="tarj" style="position:absolute;left:80px;top:640px;width:520px;padding:40px;background:#ffffff">
    <div id="hijo" style="font-size:40px;font-family:Inter;color:#111">Texto en la tarjeta</div>
  </div>
  <!-- objeto decorativo pintado ADENTRO de un texto: sigue siendo suyo -->
  <div id="conbarra" style="position:absolute;left:80px;top:900px;width:600px;padding-top:40px;font-size:44px;font-family:Inter;color:#111"><span id="barrita" style="position:absolute;left:0;top:0;width:120px;height:10px;background:#ff3b7f"></span>Con barrita arriba</div>
</div>`;

    /** Qué elemento quedó seleccionado, por id (usa la caja del overlay). */
    const selectedId = () =>
      page.evaluate(() => {
        const box = document.querySelector(".oc-box");
        if (!box) return null;
        const b = box.getBoundingClientRect();
        const hit = [...document.querySelectorAll("#root *, #root")].filter((el) => {
          if (el.closest("[data-oc-ui]")) return false;
          const r = el.getBoundingClientRect();
          return (
            Math.abs(r.left - b.left) < 1.5 &&
            Math.abs(r.top - b.top) < 1.5 &&
            Math.abs(r.width - b.width) < 1.5 &&
            Math.abs(r.height - b.height) < 1.5
          );
        });
        // El más externo de los que calzan: es el que pinta la caja.
        return (hit.find((el) => !hit.some((o) => o !== el && o.contains(el))) || {}).id ?? "(sin id)";
      });

    /** Centro de las letras de un elemento (no de su caja: puede tener aire). */
    const glyphPoint = (sel) =>
      page.evaluate((s) => {
        const el = document.querySelector(s);
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let n;
        while ((n = w.nextNode())) {
          if (!n.nodeValue.trim()) continue;
          const rg = document.createRange();
          rg.selectNodeContents(n);
          const r = [...rg.getClientRects()].find((q) => q.width > 3 && q.height > 3);
          if (r) return [Math.round(r.left + Math.min(r.width / 2, 12)), Math.round(r.top + r.height / 2)];
        }
        return null;
      }, sel);

    console.log("\nUn texto es un objeto, no un montón de tramos");
    await pageFor(SLIDE_CANVA);
    let pt = await glyphPoint("#neg");
    await page.mouse.click(pt[0], pt[1]);
    await new Promise((r) => setTimeout(r, 80));
    check("clicar la palabra en negrita selecciona el párrafo", (await selectedId()) === "parr");

    pt = await glyphPoint("#ital");
    await page.mouse.click(pt[0], pt[1]);
    await new Promise((r) => setTimeout(r, 80));
    check(
      "y dentro de un título flex también (el display no manda)",
      (await selectedId()) === "flex"
    );

    // Alt+clic sigue siendo la vía para agarrar el tramo suelto, igual que agarra
    // un miembro suelto de un grupo.
    pt = await glyphPoint("#neg");
    await page.keyboard.down("Alt");
    await page.mouse.click(pt[0], pt[1]);
    await page.keyboard.up("Alt");
    await new Promise((r) => setTimeout(r, 80));
    check("Alt+clic sí toma el tramo suelto", (await selectedId()) === "neg");

    // El panel decide con isText si muestra la sección "Texto": sin eso, no hay ni
    // campo de texto ni botón de editar.
    const selMsg = async (x, y) => {
      const p = page.evaluate(
        () =>
          new Promise((res) => {
            const onMsg = (e) => {
              if (e.data && e.data.oc === "sel") {
                window.removeEventListener("message", onMsg);
                res(e.data);
              }
            };
            window.addEventListener("message", onMsg);
          })
      );
      await page.mouse.click(x, y);
      return p;
    };
    await pageFor(SLIDE_CANVA);
    pt = await glyphPoint("#lock");
    let msg = await selMsg(pt[0], pt[1]);
    check("el renglón que comparte caja con el logo cuenta como texto", msg.isText === true);
    check("y el panel recibe su contenido", /Executive Education/.test(msg.text || ""), msg.text);

    // Doble clic sobre él entra a editar (antes no hacía nada) y el logo aguanta.
    await page.mouse.click(pt[0], pt[1], { clickCount: 2 });
    await new Promise((r) => setTimeout(r, 140));
    check(
      "el doble clic entra a editarlo",
      (await page.evaluate(() => document.querySelector('[contenteditable="true"]')?.id)) === "lock"
    );
    check(
      "y el logo queda fuera del caret (no se desarma al escribir)",
      (await page.evaluate(() => document.querySelector("#marca").getAttribute("contenteditable"))) ===
        "false"
    );
    await page.keyboard.type("XY");
    await new Promise((r) => setTimeout(r, 140));
    check(
      "escribir en el renglón no se lleva el logo",
      (await page.evaluate(() => !!document.querySelector("#marca")))
    );

    // Reescribir el renglón desde el campo del panel tampoco puede borrarlo.
    await pageFor(SLIDE_CANVA);
    pt = await glyphPoint("#lock");
    await page.mouse.click(pt[0], pt[1]);
    await new Promise((r) => setTimeout(r, 60));
    await page.evaluate(() =>
      window.postMessage({ oc: "apply", prop: "text", value: " · Executive MBA" }, "*")
    );
    await new Promise((r) => setTimeout(r, 140));
    const trasTexto = await page.evaluate(() => ({
      logo: !!document.querySelector("#marca"),
      texto: document.querySelector("#lock").textContent.trim(),
    }));
    check("reescribir el texto desde el panel conserva el logo", trasTexto.logo);
    check("y aplica el texto nuevo", /Executive MBA/.test(trasTexto.texto), trasTexto.texto);

    console.log("\nEntrar al grupo con el doble clic (como Canva)");
    await pageFor(SLIDE_CANVA);
    // Clic en el relleno de la tarjeta: se selecciona la tarjeta (es una caja).
    const tarjR = await rectOf(page, "tarj");
    await page.mouse.click(Math.round(tarjR.left + 12), Math.round(tarjR.top + 12));
    await new Promise((r) => setTimeout(r, 80));
    check("clicar el borde de la tarjeta selecciona la tarjeta", (await selectedId()) === "tarj");
    // Doble clic sobre el texto de adentro: entra a editar ESE texto.
    pt = await glyphPoint("#hijo");
    await page.mouse.click(pt[0], pt[1], { clickCount: 2 });
    await new Promise((r) => setTimeout(r, 140));
    check(
      "el doble clic sobre el texto de adentro entra a editarlo",
      (await page.evaluate(() => document.querySelector('[contenteditable="true"]')?.id)) === "hijo"
    );
    check("y el seleccionado pasa a ser ese texto", (await selectedId()) === "hijo");

    console.log("\nUn decorativo dentro de un texto sigue siendo suyo");
    await pageFor(SLIDE_CANVA);
    const barR = await rectOf(page, "barrita");
    await page.mouse.click(Math.round(barR.left + barR.width / 2), Math.round(barR.top + barR.height / 2));
    await new Promise((r) => setTimeout(r, 80));
    check("clicar la barrita la selecciona a ella", (await selectedId()) === "barrita");
    pt = await glyphPoint("#conbarra");
    await page.mouse.click(pt[0], pt[1]);
    await new Promise((r) => setTimeout(r, 80));
    check("y clicar las letras selecciona el texto", (await selectedId()) === "conbarra");

    console.log("\nLa banda de selección agarra el párrafo, no el tramo");
    await pageFor(SLIDE_CANVA);
    const parrR = await rectOf(page, "parr");
    await drag(
      page,
      Math.round(parrR.left - 20),
      Math.round(parrR.top - 20),
      Math.round(parrR.right + 20),
      Math.round(parrR.bottom + 20)
    );
    await new Promise((r) => setTimeout(r, 80));
    const trasBanda = await page.evaluate(() => {
      const b = document.querySelector("#neg").getBoundingClientRect();
      // Ninguna caja del overlay puede calzar con el tramo en negrita.
      return [...document.querySelectorAll(".oc-box")].some((box) => {
        const r = box.getBoundingClientRect();
        return Math.abs(r.left - b.left) < 1.5 && Math.abs(r.width - b.width) < 1.5;
      });
    });
    check("la banda no se queda con la palabra en negrita", trasBanda === false);
    check("y sí selecciona algo", (await selCount(page)) > 0);

    // ── Fase 6: sombras ───────────────────────────────────────────────────────
    const SLIDE_SHADOW = `
<style>
  /* top declarado en la hoja: en static no hace nada, en relative sí. Poner una
     sombra no debe pasar el elemento a relative y hacerlo saltar 40px. */
  #enflujo2 { top:40px; left:25px; }
</style>
<div id="root" style="position:relative;width:${W}px;height:${H}px;background:#f6f5f0">
  <div id="tarjeta" data-oc-shape="1" style="position:absolute;left:300px;top:300px;width:280px;height:200px;background:#4f7cff"></div>
  <div id="enflujo2" data-oc-shape="1" style="width:200px;height:80px;background:#ffe08a"></div>
</div>`;

    /** Rect de la capa de sombra vinculada a un elemento (o null). */
    const dotsRect = (ownerSel) =>
      page.evaluate((sel) => {
        const own = document.querySelector(sel);
        const id = own.getAttribute("data-oc-id");
        const sh = id && document.querySelector(`[data-oc-owner="${id}"][data-oc-role="dots"]`);
        if (!sh) return null;
        const r = sh.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      }, ownerSel);

    console.log("\nSombra de puntos vinculada al objeto");
    await pageFor(SLIDE_SHADOW);
    await page.mouse.click(400, 380);
    await new Promise((r) => setTimeout(r, 60));
    const cardBefore = await rectOf(page, "tarjeta");
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "shadow", value: "dots" }, "*"));
    await new Promise((r) => setTimeout(r, 150));
    let sh = await dotsRect("#tarjeta");
    check("crea la capa de puntos", !!sh);
    check(
      "con el tamaño del elemento y el desplazamiento diagonal",
      !!sh &&
        Math.abs(sh.width - cardBefore.width) < 2 &&
        Math.abs(sh.left - (cardBefore.left + 18)) < 2 &&
        Math.abs(sh.top - (cardBefore.top + 18)) < 2,
      sh && `${sh.width}x${sh.height} en (${sh.left},${sh.top})`
    );
    check(
      "aplicar la sombra no mueve el elemento",
      Math.abs((await rectOf(page, "tarjeta")).left - cardBefore.left) < 0.6 &&
        Math.abs((await rectOf(page, "tarjeta")).top - cardBefore.top) < 0.6
    );
    // Mover: la sombra tiene que seguirlo.
    await drag(page, 400, 380, 400 + 150, 380 + 90, { altDuring: true });
    let card = await rectOf(page, "tarjeta");
    sh = await dotsRect("#tarjeta");
    check(
      "la sombra sigue al elemento al moverlo",
      !!sh && Math.abs(sh.left - (card.left + 18)) < 2 && Math.abs(sh.top - (card.top + 18)) < 2,
      sh && `sombra=(${sh.left},${sh.top}) elemento=(${card.left},${card.top})`
    );
    // Redimensionar por panel: la sombra acompaña el tamaño.
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "w", value: 420 }, "*"));
    await new Promise((r) => setTimeout(r, 150));
    card = await rectOf(page, "tarjeta");
    sh = await dotsRect("#tarjeta");
    check(
      "y acompaña el tamaño al redimensionar",
      !!sh && Math.abs(sh.width - card.width) < 2,
      sh && `sombra=${sh.width} elemento=${card.width}`
    );
    // Rotar: la sombra rota igual.
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "rotate", value: 20 }, "*"));
    await new Promise((r) => setTimeout(r, 150));
    check(
      "y rota con él",
      (await page.evaluate(() => {
        const id = document.querySelector("#tarjeta").getAttribute("data-oc-id");
        return document.querySelector(`[data-oc-owner="${id}"][data-oc-role="dots"]`).style.rotate;
      })).indexOf("20") === 0
    );
    // Cambiar de preset no acumula capas.
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "shadow", value: "dots" }, "*"));
    await new Promise((r) => setTimeout(r, 120));
    check(
      "volver a aplicar 'puntos' no apila capas",
      (await page.evaluate(() => document.querySelectorAll('[data-oc-owner][data-oc-role="dots"]').length)) === 1
    );
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "shadow", value: "soft" }, "*"));
    await new Promise((r) => setTimeout(r, 120));
    check(
      "cambiar a otra sombra saca la capa de puntos",
      (await page.evaluate(() => document.querySelectorAll('[data-oc-owner][data-oc-role="dots"]').length)) === 0
    );

    console.log("\nLa sombra de puntos no es un objeto aparte");
    await pageFor(SLIDE_SHADOW);
    await page.mouse.click(400, 380);
    await new Promise((r) => setTimeout(r, 60));
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "shadow", value: "dots" }, "*"));
    await new Promise((r) => setTimeout(r, 150));
    const layerCount = (await tree()).length;
    check("no aparece como capa en el panel", layerCount === 2, `filas=${layerCount}`);
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await new Promise((r) => setTimeout(r, 80));
    check(
      "no entra en 'seleccionar todo'",
      (await selCount(page)) === 2,
      `sel=${await selCount(page)}`
    );
    // Y al borrar el elemento, la sombra se va con él.
    await page.evaluate(() => window.postMessage({ oc: "deselect" }, "*"));
    await new Promise((r) => setTimeout(r, 80));
    await page.mouse.click(400, 380);
    await new Promise((r) => setTimeout(r, 80));
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "remove", value: true }, "*"));
    await new Promise((r) => setTimeout(r, 150));
    const afterDel = await page.evaluate(() => ({
      shadows: document.querySelectorAll('[data-oc-owner][data-oc-role="dots"]').length,
      owner: !!document.querySelector("#tarjeta"),
    }));
    check(
      "borrar el elemento se lleva su sombra",
      afterDel.shadows === 0,
      `sombras=${afterDel.shadows} dueño=${afterDel.owner}`
    );

    console.log("\nLa sombra no mueve un elemento en flujo");
    await pageFor(SLIDE_SHADOW);
    const flowBefore = await rectOf(page, "enflujo2");
    await page.mouse.click(flowBefore.left + 20, flowBefore.top + 20);
    await new Promise((r) => setTimeout(r, 60));
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "shadow", value: "dots" }, "*"));
    await new Promise((r) => setTimeout(r, 150));
    const flowAfter = await rectOf(page, "enflujo2");
    check(
      "pasar a relative no aplica el top/left de la hoja",
      Math.abs(flowAfter.left - flowBefore.left) < 0.6 && Math.abs(flowAfter.top - flowBefore.top) < 0.6,
      `antes=(${flowBefore.left},${flowBefore.top}) después=(${flowAfter.left},${flowAfter.top})`
    );

    console.log("\nSombra a medida y brillos");
    await pageFor(SLIDE_SHADOW);
    await page.mouse.click(400, 380);
    await new Promise((r) => setTimeout(r, 60));
    await page.evaluate(() =>
      window.postMessage(
        { oc: "apply", prop: "shadowCustom", value: { x: 12, y: 20, blur: 30, spread: 4, color: "#ff3b7f" } },
        "*"
      )
    );
    await new Promise((r) => setTimeout(r, 120));
    let boxShadow = await page.evaluate(() => document.querySelector("#tarjeta").style.boxShadow);
    check(
      "la sombra a medida usa los cuatro valores",
      /12px 20px 30px 4px/.test(boxShadow),
      boxShadow
    );
    await page.evaluate(() =>
      window.postMessage(
        { oc: "apply", prop: "shadowCustom", value: { x: 0, y: 0, blur: 22, spread: 0, color: "#ff3b7f", inner: true } },
        "*"
      )
    );
    await new Promise((r) => setTimeout(r, 120));
    boxShadow = await page.evaluate(() => document.querySelector("#tarjeta").style.boxShadow);
    check("el brillo interior va por inset", /inset/.test(boxShadow), boxShadow);
    // Sobre una imagen la sombra exterior sigue la silueta (drop-shadow).
    await pageFor(SLIDE_IMG);
    const ip = await rectOf(page, "porhoja");
    await page.mouse.click(ip.left + 20, ip.top + 20);
    await new Promise((r) => setTimeout(r, 60));
    await page.evaluate(() =>
      window.postMessage(
        { oc: "apply", prop: "shadowCustom", value: { x: 6, y: 10, blur: 20, spread: 0, color: "#000000" } },
        "*"
      )
    );
    await new Promise((r) => setTimeout(r, 120));
    check(
      "en una imagen va por drop-shadow (respeta la transparencia)",
      /drop-shadow/.test(await page.evaluate(() => document.querySelector("#porhoja").style.filter))
    );
    // Y conserva el desenfoque, que comparte la propiedad 'filter'.
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "blur", value: 6 }, "*"));
    await new Promise((r) => setTimeout(r, 120));
    const filt = await page.evaluate(() => document.querySelector("#porhoja").style.filter);
    check("sombra y desenfoque conviven en 'filter'", /drop-shadow/.test(filt) && /blur\(6px\)/.test(filt), filt);

    // ── Fase 7: exportar sin fondo ────────────────────────────────────────────
    // El fondo pintado en un wrapper ANIDADO es el caso que sobrevivía al export.
    const SLIDE_EXPORT = `
<div id="lienzo" style="position:relative;width:${W}px;height:${H}px">
  <div id="wrapper" style="position:absolute;inset:0;background:linear-gradient(135deg,#2A2320,#C77E97)">
    <div id="capa" style="position:absolute;inset:0;background:#15142B">
      <div data-oc-tex="1" style="position:absolute;inset:0;background-image:radial-gradient(#fff 2px,transparent 3px);mix-blend-mode:overlay;opacity:.8"></div>
      <div id="titulo" style="position:absolute;left:100px;top:400px;font-size:80px;font-family:Inter;color:#EBFF6F;font-weight:800">Titular</div>
      <div id="pastilla" data-oc-shape="1" style="position:absolute;left:100px;top:600px;width:300px;height:120px;background:#EBFF6F;border-radius:60px"></div>
    </div>
  </div>
</div>`;

    console.log("\nExportar sin fondo");
    await page.setContent(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}html,body{width:${W}px;height:${H}px;overflow:hidden;background:#f6f5f0}
</style></head><body>${SLIDE_EXPORT}</body></html>`,
      { waitUntil: "domcontentloaded" }
    );
    await new Promise((r) => setTimeout(r, 120));
    // Se ejecuta la MISMA función que usa el export real.
    await page.evaluate(stripBackgroundInPage);
    const stripped = await page.evaluate(() => {
      const bg = (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor;
      const bgi = (sel) => getComputedStyle(document.querySelector(sel)).backgroundImage;
      return {
        body: bg("body"),
        lienzo: bg("#lienzo"),
        wrapperImg: bgi("#wrapper"),
        capa: bg("#capa"),
        textura: getComputedStyle(document.querySelector("[data-oc-tex]")).display,
        titulo: getComputedStyle(document.querySelector("#titulo")).color,
        pastilla: bg("#pastilla"),
      };
    });
    const transp = (v) => v === "rgba(0, 0, 0, 0)" || v === "transparent";
    check("limpia el fondo del body", transp(stripped.body), stripped.body);
    check("limpia el degradado del wrapper anidado", stripped.wrapperImg === "none", stripped.wrapperImg);
    check("limpia el color de la capa anidada", transp(stripped.capa), stripped.capa);
    check("apaga la textura", stripped.textura === "none", stripped.textura);
    check("no toca el color del texto", stripped.titulo === "rgb(235, 255, 111)", stripped.titulo);
    check("no toca el relleno de las formas", stripped.pastilla === "rgb(235, 255, 111)", stripped.pastilla);

    // Y el PNG real: la esquina tiene que quedar transparente y la forma opaca.
    const shot = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: W, height: H },
      captureBeyondViewport: false,
      omitBackground: true,
    });
    const png = sharp(shot).ensureAlpha();
    const corner = await png.clone().extract({ left: 4, top: 4, width: 1, height: 1 }).raw().toBuffer();
    const onShape = await sharp(shot)
      .ensureAlpha()
      .extract({ left: 200, top: 650, width: 1, height: 1 })
      .raw()
      .toBuffer();
    check("el PNG exportado tiene la esquina transparente", corner[3] === 0, `alfa=${corner[3]}`);
    check(
      "y el contenido opaco con su color",
      onShape[3] === 255 && onShape[0] > 200 && onShape[1] > 240,
      `rgba=${[...onShape].join(",")}`
    );

    // ── Fase 8: biblioteca de efectos ─────────────────────────────────────────
    console.log("\nEfectos de filtro");
    await pageFor(SLIDE_SHADOW);
    await page.mouse.click(400, 380);
    await new Promise((r) => setTimeout(r, 60));

    const FILTROS = [
      ["grain", "feTurbulence"],
      ["noise", "feTurbulence"],
      ["duotone", "feComponentTransfer"],
      ["chromatic", "feOffset"],
      ["emboss", "feConvolveMatrix"],
      ["bevel", "feSpecularLighting"],
      ["motion", "feGaussianBlur"],
      ["distort", "feDisplacementMap"],
    ];
    for (const [kind, primitiva] of FILTROS) {
      await page.evaluate(
        (k) => window.postMessage({ oc: "apply", prop: "fx", value: { kind: k, value: 60 } }, "*"),
        kind
      );
      await new Promise((r) => setTimeout(r, 90));
      const st = await page.evaluate(
        (k) => {
          const el = document.querySelector("#tarjeta");
          const f = document.querySelector(`filter[id$="-${k}"]`);
          return {
            filter: el.style.filter,
            tienePrimitiva: f ? f.innerHTML : "",
            enConfig: !!JSON.parse(el.getAttribute("data-oc-fx") || "{}")[k],
          };
        },
        kind
      );
      check(
        `${kind}: crea su filtro y lo aplica`,
        new RegExp(`url\\(["']?#ocfx-[^)"']+-${kind}["']?\\)`).test(st.filter) &&
          st.tienePrimitiva.includes(primitiva) &&
          st.enConfig,
        `filter="${st.filter}"`
      );
      // Apagarlo lo saca del filter Y borra su <filter> de las defs.
      await page.evaluate(
        (k) => window.postMessage({ oc: "apply", prop: "fx", value: { kind: k, value: null } }, "*"),
        kind
      );
      await new Promise((r) => setTimeout(r, 90));
    }
    const limpio = await page.evaluate(() => ({
      filter: document.querySelector("#tarjeta").style.filter,
      defs: document.querySelectorAll('filter[id^="ocfx-"]').length,
      attr: document.querySelector("#tarjeta").getAttribute("data-oc-fx"),
    }));
    check("apagar un efecto lo borra de las defs", limpio.defs === 0, `defs=${limpio.defs}`);
    check("y deja el filter vacío", limpio.filter === "", `filter="${limpio.filter}"`);
    check("sin dejar rastro en data-oc-fx", limpio.attr === null, `attr=${limpio.attr}`);

    console.log("\nEfectos, sombra y desenfoque comparten 'filter' sin pisarse");
    await pageFor(SLIDE_SHADOW);
    await page.mouse.click(400, 380);
    await new Promise((r) => setTimeout(r, 60));
    await page.evaluate(() =>
      window.postMessage({ oc: "apply", prop: "fx", value: { kind: "grain", value: 50 } }, "*")
    );
    await new Promise((r) => setTimeout(r, 90));
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "blur", value: 5 }, "*"));
    await new Promise((r) => setTimeout(r, 90));
    await page.evaluate(() =>
      window.postMessage(
        { oc: "apply", prop: "shadowCustom", value: { x: 4, y: 8, blur: 16, spread: 0, color: "#000000" } },
        "*"
      )
    );
    await new Promise((r) => setTimeout(r, 90));
    const combinado = await page.evaluate(() => document.querySelector("#tarjeta").style.filter);
    check(
      "conviven desenfoque y efecto",
      /blur\(5px\)/.test(combinado) && /url\(["']?#ocfx-.*-grain["']?\)/.test(combinado),
      combinado
    );
    // La tarjeta no es imagen: la sombra va por box-shadow, no por filter.
    check(
      "la sombra de una caja no se mete en el filter",
      !/drop-shadow/.test(combinado) &&
        /4px 8px 16px/.test(await page.evaluate(() => document.querySelector("#tarjeta").style.boxShadow))
    );
    // En una imagen, los tres juntos.
    await pageFor(SLIDE_IMG);
    const ir = await rectOf(page, "porhoja");
    await page.mouse.click(ir.left + 20, ir.top + 20);
    await new Promise((r) => setTimeout(r, 60));
    for (const msg of [
      { oc: "apply", prop: "fx", value: { kind: "duotone", value: { i: 80, a: "#15142B", b: "#EBFF6F" } } },
      { oc: "apply", prop: "blur", value: 3 },
      { oc: "apply", prop: "shadowCustom", value: { x: 0, y: 12, blur: 20, spread: 0, color: "#000000" } },
    ]) {
      await page.evaluate((m) => window.postMessage(m, "*"), msg);
      await new Promise((r) => setTimeout(r, 90));
    }
    const tres = await page.evaluate(() => document.querySelector("#porhoja").style.filter);
    check(
      "en una imagen: sombra + desenfoque + duotono a la vez",
      /drop-shadow/.test(tres) && /blur\(3px\)/.test(tres) && /url\(["']?#ocfx-/.test(tres),
      tres
    );

    console.log("\nSuperficies (capas vinculadas)");
    await pageFor(SLIDE_SHADOW);
    await page.mouse.click(400, 380);
    await new Promise((r) => setTimeout(r, 60));
    for (const [kind, marca] of [
      ["frost", "backdrop-filter"],
      ["radial", "mask-image"],
      ["crt", "repeating-linear-gradient"],
    ]) {
      await page.evaluate(
        (k) => window.postMessage({ oc: "apply", prop: "fxLayer", value: { kind: k, value: 60 } }, "*"),
        kind
      );
      await new Promise((r) => setTimeout(r, 110));
      const lay = await page.evaluate((k) => {
        const el = document.querySelector("#tarjeta");
        const id = el.getAttribute("data-oc-id");
        const l = document.querySelector(`[data-oc-owner="${id}"][data-oc-fxkind="${k}"]`);
        if (!l) return null;
        const lr = l.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        return {
          css: l.getAttribute("style") || "",
          calza: Math.abs(lr.left - er.left) < 2 && Math.abs(lr.width - er.width) < 2,
          encima: l.compareDocumentPosition(el) === Node.DOCUMENT_POSITION_PRECEDING,
        };
      }, kind);
      check(`${kind}: crea la capa y calza con el elemento`, !!lay && lay.calza, lay ? "no calza" : "sin capa");
      check(`${kind}: usa su técnica CSS`, !!lay && lay.css.includes(marca), lay?.css.slice(0, 60));
      check(`${kind}: la capa va encima del elemento`, !!lay && lay.encima);
      await page.evaluate(
        (k) => window.postMessage({ oc: "apply", prop: "fxLayer", value: { kind: k, value: null } }, "*"),
        kind
      );
      await new Promise((r) => setTimeout(r, 90));
    }
    check(
      "apagarlas las quita",
      (await page.evaluate(() => document.querySelectorAll("[data-oc-fxkind]").length)) === 0
    );

    // Material: usa el PNG horneado y sigue al elemento al moverlo.
    await page.evaluate(() =>
      window.postMessage(
        { oc: "apply", prop: "fxLayer", value: { kind: "material", value: { i: 70, slug: "papel-arrugado", base: "" } } },
        "*"
      )
    );
    await new Promise((r) => setTimeout(r, 120));
    check(
      "el material apunta al PNG horneado",
      (await page.evaluate(() => {
        const id = document.querySelector("#tarjeta").getAttribute("data-oc-id");
        const l = document.querySelector(`[data-oc-owner="${id}"][data-oc-fxkind="material"]`);
        return l ? l.style.backgroundImage : "";
      })).includes("/textures/papel-arrugado.png")
    );
    await drag(page, 400, 380, 400 + 120, 380 + 60, { altDuring: true });
    const matSigue = await page.evaluate(() => {
      const el = document.querySelector("#tarjeta");
      const id = el.getAttribute("data-oc-id");
      const l = document.querySelector(`[data-oc-owner="${id}"][data-oc-fxkind="material"]`);
      const a = l.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      return Math.abs(a.left - b.left) < 2 && Math.abs(a.top - b.top) < 2;
    });
    check("y sigue al elemento al moverlo", matSigue);

    console.log("\nLos efectos viajan al export");
    // Lo que se serializa tiene que llevar las defs del filtro y la capa: si no, el
    // preview mostraría el efecto y el PNG saldría sin él.
    const conFx = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const onMsg = (e) => {
            if (e.data && e.data.oc === "html") {
              window.removeEventListener("message", onMsg);
              resolve(e.data.html);
            }
          };
          window.addEventListener("message", onMsg);
          window.postMessage({ oc: "apply", prop: "fx", value: { kind: "emboss", value: 55 } }, "*");
        })
    );
    check("serializa el <filter> del efecto", /<filter[^>]*ocfx-/.test(conFx), "sin filter en el HTML");
    check(
      "serializa la referencia url(#…) en el elemento",
      /url\((?:&quot;|["'])?#ocfx-/.test(conFx),
      (conFx.match(/filter:[^;"]*/) || [""])[0]
    );
    check("serializa la capa de material", /data-oc-fxkind="material"/.test(conFx));
    check("y no serializa la UI del editor", !/data-oc-ui/.test(conFx));
    // Render real del HTML serializado: el efecto tiene que aplicarse de nuevo.
    await page.setContent(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}html,body{width:${W}px;height:${H}px;overflow:hidden}
</style></head><body>${conFx}</body></html>`,
      { waitUntil: "domcontentloaded" }
    );
    await new Promise((r) => setTimeout(r, 150));
    const reHidratado = await page.evaluate(() => {
      const el = document.querySelector("#tarjeta");
      const m = /url\(["']?#(ocfx-[^)"']+)["']?\)/.exec(el.style.filter || "");
      return { filtro: el.style.filter, existeDef: m ? !!document.getElementById(m[1]) : false };
    });
    check(
      "el HTML exportado resuelve el filtro (la def viaja con él)",
      reHidratado.existeDef,
      reHidratado.filtro
    );

    // Los filtros SVG podrían no aplicarse y nadie se daría cuenta hasta ver el
    // PNG. Se renderiza de verdad y se miran los píxeles.
    console.log("\nLos efectos se ven en el PNG");
    /**
     * Screenshot SIN la UI del editor: los handles (círculos blancos) y la caja de
     * selección se dibujan justo sobre los bordes del elemento y contaminarían la
     * medición. El export real tampoco los tiene.
     */
    const limpiar = async () => {
      await page.evaluate(() => window.postMessage({ oc: "deselect" }, "*"));
      await new Promise((r) => setTimeout(r, 120));
    };
    /** Color RGB del píxel (x,y) de un screenshot de la página actual. */
    const pixelAt = async (x, y) => {
      await limpiar();
      const shot = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: W, height: H },
        captureBeyondViewport: false,
      });
      const raw = await sharp(shot)
        .ensureAlpha()
        .extract({ left: x, top: y, width: 1, height: 1 })
        .raw()
        .toBuffer();
      return [raw[0], raw[1], raw[2]];
    };
    /** Desvío estándar del canal rojo en un recorte: mide el grano. */
    const rugosidad = async (x, y, n) => {
      await limpiar();
      const shot = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: W, height: H },
        captureBeyondViewport: false,
      });
      const raw = await sharp(shot)
        .ensureAlpha()
        .extract({ left: x, top: y, width: n, height: n })
        .raw()
        .toBuffer();
      const vals = [];
      for (let i = 0; i < raw.length; i += 4) vals.push(raw[i]);
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
    };

    const GRIS = `
<div id="root" style="position:relative;width:${W}px;height:${H}px;background:#ffffff">
  <div id="plano" data-oc-shape="1" style="position:absolute;left:200px;top:200px;width:400px;height:400px;background:#808080"></div>
</div>`;
    await pageFor(GRIS);
    const grisBase = await pixelAt(400, 400);
    check(
      "el cuadro arranca gris plano",
      Math.abs(grisBase[0] - 128) < 4 && Math.abs(grisBase[0] - grisBase[2]) < 4,
      grisBase.join(",")
    );
    const planoLiso = await rugosidad(300, 300, 40);
    check("y sin grano", planoLiso < 1.5, `desvío=${planoLiso.toFixed(2)}`);

    const seleccionarPlano = async () => {
      await page.mouse.click(400, 400);
      await new Promise((r) => setTimeout(r, 80));
    };
    await seleccionarPlano();
    await page.evaluate(() =>
      window.postMessage(
        { oc: "apply", prop: "fx", value: { kind: "duotone", value: { i: 100, a: "#000080", b: "#ffff00" } } },
        "*"
      )
    );
    await new Promise((r) => setTimeout(r, 200));
    const duoPix = await pixelAt(400, 400);
    // Gris medio con duotono navy→amarillo cae en la mitad de la rampa: R y G
    // suben mucho y B baja. Lo importante es que YA NO es gris.
    check(
      "el duotono cambia el color de verdad en el PNG",
      Math.abs(duoPix[0] - duoPix[2]) > 40,
      `rgb=${duoPix.join(",")}`
    );
    await seleccionarPlano();
    await page.evaluate(() =>
      window.postMessage({ oc: "apply", prop: "fx", value: { kind: "duotone", value: null } }, "*")
    );
    await new Promise((r) => setTimeout(r, 150));

    await seleccionarPlano();
    await page.evaluate(() =>
      window.postMessage({ oc: "apply", prop: "fx", value: { kind: "grain", value: 90 } }, "*")
    );
    await new Promise((r) => setTimeout(r, 200));
    const conGrano = await rugosidad(300, 300, 40);
    check(
      "el granulado agrega grano medible",
      conGrano > planoLiso + 3,
      `desvío ${planoLiso.toFixed(2)} → ${conGrano.toFixed(2)}`
    );
    // Y no se derrama fuera de la silueta del elemento.
    const afuera = await pixelAt(100, 100);
    check(
      "sin pintar fuera del elemento",
      afuera[0] > 250 && afuera[1] > 250 && afuera[2] > 250,
      afuera.join(",")
    );
    await seleccionarPlano();
    await page.evaluate(() =>
      window.postMessage({ oc: "apply", prop: "fx", value: { kind: "grain", value: null } }, "*")
    );
    await new Promise((r) => setTimeout(r, 150));

    // Motion blur: el borde duro tiene que quedar degradado.
    await seleccionarPlano();
    await page.evaluate(() =>
      window.postMessage({ oc: "apply", prop: "fx", value: { kind: "motion", value: 70 } }, "*")
    );
    await new Promise((r) => setTimeout(r, 200));
    const bordeIzq = await pixelAt(196, 400); // 4px afuera del borde original
    check(
      "el motion blur derrama el borde hacia afuera",
      bordeIzq[0] < 250,
      `rgb=${bordeIzq.join(",")}`
    );

    // ── El velo a lámina completa ────────────────────────────────────────────
    // `tooBig` descarta todo lo que ocupe >80% del lienzo y el único rescate era
    // para IMG/SVG, así que el degradado que oscurece una foto quedaba pegado a la
    // lámina: 110 velos en 77 de las 276 láminas guardadas, ni movibles ni
    // borrables. Es el "una sombra que NO es editable" del reporte.
    console.log("\nVelo a lámina completa");
    // El velo, la foto y el fondo comparten rect exacto (los tres son a sangre), así
    // que "cuál quedó seleccionado" no se puede leer de la caja del overlay: se lee
    // BORRÁNDOLO, que además es lo que las diseñadoras pedían poder hacer.
    const vivos = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("#root > *")].map((el) => el.id).filter(Boolean)
      );

    await pageFor(SLIDE_VELO);
    await page.mouse.click(540, 400); // zona alta: solo velo + foto + fondo debajo
    check("el velo se puede seleccionar", (await selCount(page)) === 1, `sel=${await selCount(page)}`);
    await page.keyboard.press("Delete");
    let quedan = await vivos();
    check(
      "el clic toma el velo (el de arriba) y se puede borrar",
      !quedan.includes("velo") && quedan.includes("foto"),
      `quedan=${quedan.join(",")}`
    );

    await pageFor(SLIDE_VELO);
    await page.keyboard.down("Alt");
    await page.mouse.click(540, 400);
    await page.keyboard.up("Alt");
    await page.keyboard.press("Delete");
    quedan = await vivos();
    check(
      "Alt+clic baja una capa y toma la foto",
      !quedan.includes("foto") && quedan.includes("velo"),
      `quedan=${quedan.join(",")}`
    );

    await pageFor(SLIDE_VELO);
    await page.mouse.click(300, 1130); // sobre el titular, que va encima del velo
    await page.keyboard.press("Delete");
    quedan = await vivos();
    check(
      "el velo no le roba el clic al texto que tiene encima",
      !quedan.includes("titulo") && quedan.includes("velo"),
      `quedan=${quedan.join(",")}`
    );

    await pageFor(SLIDE_VELO);
    await page.mouse.click(850, 160); // sobre el chip, una forma chica sobre el velo
    await page.keyboard.press("Delete");
    quedan = await vivos();
    check(
      "el velo no le roba el clic a una forma",
      !quedan.includes("chip") && quedan.includes("velo"),
      `quedan=${quedan.join(",")}`
    );

    // La otra mitad: un fondo plano y opaco NO es un velo. Si se volviera
    // seleccionable, clicar en un vacío elegiría el fondo en vez de deseleccionar.
    await pageFor(SLIDE_VELO);
    await page.evaluate(() => document.getElementById("velo").remove());
    await page.evaluate(() => document.getElementById("foto").remove());
    await page.mouse.click(540, 400);
    check(
      "un fondo plano y opaco sigue sin tomarse (clicar el vacío deselecciona)",
      (await selCount(page)) === 0,
      `sel=${await selCount(page)}`
    );

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
