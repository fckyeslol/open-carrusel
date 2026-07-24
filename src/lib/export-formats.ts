import { getBrowser, inlineImages } from "./export-slides";
import { getInlinedFontCSS } from "./fonts";
import { extractFontFamilies } from "./slide-html";
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

/** Recolecta e inlinea, una sola vez, el CSS de todas las fuentes usadas. */
async function collectInlineFontCss(slides: Slide[]): Promise<string> {
  const families = new Set<string>();
  for (const slide of slides) {
    for (const family of extractFontFamilies(slide.html)) families.add(family);
  }
  return getInlinedFontCSS(Array.from(families));
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

  const pages: string[] = [];
  for (const slide of slides) {
    const inlined = await inlineImages(slide.html);
    pages.push(`<div class="oc-page">${inlined}</div>`);
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

/** Espera a que las fuentes carguen antes de capturar (mismo criterio que PNG). */
async function waitForFonts(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof getBrowser>>["newPage"]>>
): Promise<void> {
  await page
    .waitForFunction(
      () =>
        document.fonts.ready.then(() =>
          [...document.fonts].every((f) => f.status === "loaded")
        ),
      { timeout: 10000 }
    )
    .catch(() => {
      // Font loading timeout — seguimos con lo que haya cargado.
    });
}

/**
 * Exporta láminas a un único PDF, una lámina por página, al tamaño exacto de
 * Instagram. El texto se preserva como texto editable.
 */
export async function exportPdf(
  slides: Slide[],
  aspectRatio: AspectRatio
): Promise<Buffer> {
  const { width, height } = DIMENSIONS[aspectRatio];
  const html = await buildMultiSlideDocument(slides, aspectRatio, "pdf");

  const br = await getBrowser();
  const page = await br.newPage();

  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitForFonts(page);

    const pdf = await page.pdf({
      width: `${width}px`,
      height: `${height}px`,
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
      preferCSSPageSize: false,
    });

    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
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
  const inlineFontCss = await getInlinedFontCSS(extractFontFamilies(slide.html));
  const inlined = await inlineImages(slide.html);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <foreignObject x="0" y="0" width="${width}" height="${height}">
    <div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;overflow:hidden;position:relative;">
      <style>* { margin: 0; padding: 0; box-sizing: border-box; } ${inlineFontCss}</style>
      ${inlined}
    </div>
  </foreignObject>
</svg>`;
}
