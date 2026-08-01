import { inlineImages } from "./export-slides";
import { getInlinedFontCSS } from "./fonts";
import { renderPdf, type RenderOptions } from "./render";
import { extractFontFamilies, usesItalic } from "./slide-html";
import { toPageBody } from "./slide-scope";
import type { Slide, AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";

/**
 * Exports "editables" — más allá del PNG por lámina.
 *
 * PDF y HTML comparten un mismo documento multi-lámina: cada lámina es un
 * bloque del tamaño exacto de Instagram. En el PDF el texto queda como TEXTO
 * (Puppeteer `page.pdf()` no rasteriza), así que Acrobat/Illustrator/Canva lo
 * pueden re-editar. El SVG envuelve la lámina en un `<foreignObject>` — abre
 * en cualquier navegador; en Figma/Illustrator el soporte de foreignObject es
 * limitado (puede no respetar layout/tipografías).
 *
 * Todo se sirve autocontenido: imágenes y fuentes van inlineadas en base64
 * (mismo criterio que el export PNG), sin depender de ninguna URL externa.
 */

/**
 * Recolecta e inlinea, una sola vez, el CSS de todas las fuentes usadas.
 *
 * Alcanza con que UNA lámina use itálica para traer sus caras: el CSS es compartido por
 * todo el documento, así que decidirlo lámina por lámina no serviría de nada.
 *
 * Pide las fuentes en instancias ESTÁTICAS, y eso no es un detalle: con la fuente variable
 * —lo que sirve Google a un navegador moderno, y lo que sigue usando el PNG— `page.pdf()`
 * no puede embeber el programa de la fuente y degrada el texto a una fuente Type 3 (los
 * glifos como trazos). El PDF se veía bien pero no llevaba tipografía adentro: ni
 * `/FontFile` ni `/BaseFont`, texto que no se puede copiar, y Canva/Illustrator recibiendo
 * curvas en vez de texto. Ver `FontEmbedding` en fonts.ts.
 */
async function collectInlineFontCss(slides: Slide[]): Promise<string> {
  const families = new Set<string>();
  for (const slide of slides) {
    for (const family of extractFontFamilies(slide.html)) families.add(family);
  }
  const italic = slides.some((slide) => usesItalic(slide.html));
  return getInlinedFontCSS(Array.from(families), italic, "static");
}

type DocMode = "pdf" | "view";

/**
 * Documento HTML con una lámina por "página". En modo `pdf` cada bloque fuerza
 * un salto de página al tamaño exacto; en modo `view` se apilan con separación
 * y sombra para revisarlas de un vistazo al abrir el archivo en el navegador.
 */
async function buildMultiSlideDocument(
  slides: Slide[],
  aspectRatio: AspectRatio,
  mode: DocMode
): Promise<string> {
  const { width, height } = DIMENSIONS[aspectRatio];
  const inlineFontCss = await collectInlineFontCss(slides);

  // Cada lámina se acota a SU página antes de entrar al documento. Sin esto, dos cosas se
  // rompían en silencio: el `html,body{overflow:hidden}` de una lámina guardada como
  // documento completo recortaba el documento entero (7 láminas → 1 página), y las clases
  // repetidas entre láminas (`.s`, `.top`) se pisaban por cascada, dejando todas las
  // páginas del color de la última. Ver src/lib/slide-scope.ts.
  const pages: string[] = [];
  for (const [i, slide] of slides.entries()) {
    const pageId = `oc-p${i + 1}`;
    const acotada = toPageBody(slide.html, `#${pageId}`);
    const inlined = await inlineImages(acotada);
    pages.push(`<div class="oc-page" id="${pageId}">${inlined}</div>`);
  }

  const bodyStyle =
    mode === "view"
      ? `background:#e6e6e9;display:flex;flex-direction:column;align-items:center;gap:24px;padding:24px;`
      : `background:#fff;`;
  const pageExtra =
    mode === "view"
      ? `box-shadow:0 8px 28px rgba(0,0,0,.18);border-radius:4px;`
      : ``;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>${inlineFontCss}</style>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { ${bodyStyle} }
    .oc-page {
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
      position: relative;
      ${pageExtra}
      page-break-after: always;
      break-after: page;
    }
    .oc-page:last-child { page-break-after: auto; break-after: auto; }
  </style>
</head>
<body>
${pages.join("\n")}
</body>
</html>`;
}

/**
 * Exporta láminas a un único PDF, una lámina por página, al tamaño exacto de
 * Instagram. El texto se preserva como texto editable.
 *
 * La espera de fuentes vive ahora en el seam (`render.ts` + el contrato compartido);
 * antes estaba duplicada acá y en export-slides.ts con timeouts distintos.
 */
export async function exportPdf(
  slides: Slide[],
  aspectRatio: AspectRatio,
  renderOpts: RenderOptions = {}
): Promise<Buffer> {
  const { width, height } = DIMENSIONS[aspectRatio];
  const html = await buildMultiSlideDocument(slides, aspectRatio, "pdf");

  return renderPdf({ html, width, height, scale: 1 }, renderOpts);
}

/**
 * Exporta el carrusel como un único HTML autocontenido y editable. Abre en
 * cualquier navegador mostrando todas las láminas apiladas; el markup es el
 * fuente real de cada lámina, con imágenes y fuentes embebidas.
 */
export async function exportHtml(
  slides: Slide[],
  aspectRatio: AspectRatio
): Promise<string> {
  return buildMultiSlideDocument(slides, aspectRatio, "view");
}

/**
 * Exporta UNA lámina como SVG autocontenido (HTML dentro de `<foreignObject>`).
 * Abre en navegadores; edición vectorial en Figma/Illustrator es limitada.
 */
export async function exportSvg(
  slide: Slide,
  aspectRatio: AspectRatio
): Promise<string> {
  const { width, height } = DIMENSIONS[aspectRatio];
  const inlineFontCss = await getInlinedFontCSS(
    extractFontFamilies(slide.html),
    usesItalic(slide.html)
  );
  // Igual que en el PDF: una lámina guardada como documento completo no puede entrar cruda
  // acá — un `<!DOCTYPE html>` dentro de un `<foreignObject>` es SVG inválido.
  const acotada = toPageBody(slide.html, "#oc-p1");
  const inlined = await inlineImages(acotada);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <foreignObject x="0" y="0" width="${width}" height="${height}">
    <div xmlns="http://www.w3.org/1999/xhtml" id="oc-p1" style="width:${width}px;height:${height}px;overflow:hidden;position:relative;">
      <style>#oc-p1, #oc-p1 * { margin: 0; padding: 0; box-sizing: border-box; } ${inlineFontCss}</style>
      ${inlined}
    </div>
  </foreignObject>
</svg>`;
}
