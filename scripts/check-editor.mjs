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
        const sh = id && document.querySelector(`[data-oc-shadow-for="${id}"]`);
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
        return document.querySelector(`[data-oc-shadow-for="${id}"]`).style.rotate;
      })).indexOf("20") === 0
    );
    // Cambiar de preset no acumula capas.
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "shadow", value: "dots" }, "*"));
    await new Promise((r) => setTimeout(r, 120));
    check(
      "volver a aplicar 'puntos' no apila capas",
      (await page.evaluate(() => document.querySelectorAll("[data-oc-shadow-for]").length)) === 1
    );
    await page.evaluate(() => window.postMessage({ oc: "apply", prop: "shadow", value: "soft" }, "*"));
    await new Promise((r) => setTimeout(r, 120));
    check(
      "cambiar a otra sombra saca la capa de puntos",
      (await page.evaluate(() => document.querySelectorAll("[data-oc-shadow-for]").length)) === 0
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
      shadows: document.querySelectorAll("[data-oc-shadow-for]").length,
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
