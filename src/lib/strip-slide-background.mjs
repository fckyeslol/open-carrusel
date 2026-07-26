/**
 * Neutraliza la capa de fondo de una lámina ya renderizada, para exportarla "sin
 * fondo" (PNG transparente).
 *
 * Vive en un .mjs suelto y sin dependencias porque corre DENTRO de la página de
 * Puppeteer (`page.evaluate`): tiene que ser autocontenida. Estar acá afuera —y no
 * inline en export-slides.ts— es lo que permite probarla contra una lámina real.
 *
 * Qué considera "fondo":
 *
 * - el `background` de `<html>` y `<body>`
 * - la capa de textura del editor (`[data-oc-tex]`)
 * - el `background` de CUALQUIER contenedor a lámina completa, esté donde esté en
 *   el árbol. Antes solo se limpiaba el primer hijo del body, así que un fondo
 *   pintado en un wrapper anidado —muy común en las láminas generadas— sobrevivía
 *   al export y el PNG salía con fondo igual.
 *
 * Qué NO toca: el contenido. Textos, formas e imágenes quedan intactos; a un
 * `<img>` a lámina completa no se le limpia nada, porque su píxel es contenido, no
 * fondo. Sí se limpia el `background-image` de un div a lámina completa: eso es,
 * por definición, un fondo.
 */
export function stripBackgroundInPage() {
  // !important: la lámina puede pintar su fondo desde una regla con !important, y
  // ahí un style inline normal no alcanza.
  const clear = (el) => {
    el.style.setProperty("background", "transparent", "important");
    el.style.setProperty("background-color", "transparent", "important");
    el.style.setProperty("background-image", "none", "important");
  };

  clear(document.documentElement);
  clear(document.body);

  // Capa de textura a lámina completa: se apaga entera.
  document
    .querySelectorAll("[data-oc-tex]")
    .forEach((el) => el.style.setProperty("display", "none", "important"));

  const W = document.documentElement.clientWidth || window.innerWidth;
  const H = document.documentElement.clientHeight || window.innerHeight;
  if (!W || !H) return;

  // Tags cuyo píxel es contenido, no fondo.
  const CONTENIDO = new Set(["IMG", "SVG", "VIDEO", "CANVAS", "PICTURE"]);
  const SALTAR = new Set(["SCRIPT", "STYLE", "LINK"]);

  for (const el of Array.from(document.querySelectorAll("body *"))) {
    const tag = el.tagName.toUpperCase();
    if (SALTAR.has(tag) || CONTENIDO.has(tag)) continue;
    if (el.hasAttribute("data-oc-ui")) continue;
    const r = el.getBoundingClientRect();
    // A lámina completa (con un poco de tolerancia por bordes y redondeos).
    if (r.width < W * 0.95 || r.height < H * 0.95) continue;
    clear(el);
  }
}
