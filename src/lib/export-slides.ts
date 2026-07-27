import { readFile } from "fs/promises";
import path from "path";
import { wrapSlideHtml, extractFontFamilies } from "./slide-html";
import { getInlinedFontCSS } from "./fonts";
import { renderPng, type RenderOptions } from "./render";
import type { Slide, AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";

/**
 * El ciclo de vida de Chrome NO vive más acá. Este módulo se quedó con el dominio
 * —armar el HTML autocontenido de una lámina— y delega el rasterizado en el seam
 * `renderPng` (src/lib/render.ts), que corre local o en el servicio de render.
 *
 * Lo que había antes (un singleton `Browser` de módulo, `getBrowser`, `findChrome` y un
 * contador de reciclado) se movió a src/lib/browser-pool.ts, donde además se arreglaron
 * la carrera del launch, el huérfano en shutdown y el contador que no contaba.
 */

const MIME_POR_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/**
 * Inline all image references in slide HTML as data: URIs.
 *
 * Puppeteer renderiza con setContent y SIN base URL, así que cualquier ruta
 * root-relative (/uploads, /textures, /30x-slides, …) que no se inlinee acá
 * simplemente no carga en el PNG — falla en silencio y la lámina se exporta sin
 * esa imagen. (Fue exactamente el bug de las texturas: /textures/carton.png
 * cargaba en el preview por CDN pero desaparecía en el export.)
 *
 * Por eso se matchea cualquier ruta absoluta con extensión de imagen, no solo
 * /uploads. La extensión acota el match para no agarrar URLs que no son imágenes;
 * los http(s):// no empiezan con "/" y quedan afuera (las fuentes van por otro lado).
 */
export async function inlineImages(html: string): Promise<string> {
  const publicDir = path.resolve(process.cwd(), "public");
  // Las comillas pueden venir escapadas como entidad: al serializar un
  // style="background: url('/uploads/x.jpg')" el navegador lo guarda como
  // url(&quot;/uploads/x.jpg&quot;).
  const imgRegex =
    /(?:src=|url\()\s*(?:["']|&quot;|&#0?39;|&apos;)?(\/[^"'\s)&]+\.(?:png|jpe?g|webp|avif|gif|svg))/gi;
  const matches = [...html.matchAll(imgRegex)];

  let result = html;
  const inlinadas = new Set<string>();
  for (const match of matches) {
    const imgPath = match[1];
    if (inlinadas.has(imgPath)) continue; // una textura se usa en varias láminas
    inlinadas.add(imgPath);
    try {
      const fullPath = path.join(publicDir, imgPath);
      const buffer = await readFile(fullPath);
      const mime = MIME_POR_EXT[path.extname(imgPath).toLowerCase()] || "image/png";
      const base64 = buffer.toString("base64");
      // replaceAll: el mismo path puede aparecer más de una vez en la lámina.
      result = result.replaceAll(imgPath, `data:${mime};base64,${base64}`);
    } catch {
      // Keep original path — Puppeteer can fetch from localhost
    }
  }

  return result;
}

/**
 * Build the self-contained HTML for a slide, ready to render in Puppeteer.
 *
 * Es el paso compartido por TODOS los exports: inlina las imágenes
 * y el CSS de fuentes en base64 y envuelve con `wrapSlideHtml`, de modo que la
 * página no depende de ninguna URL externa ni base URL al hacer `setContent`.
 */
export async function prepareRenderableHtml(
  slideHtml: string,
  aspectRatio: AspectRatio
): Promise<string> {
  const fontFamilies = extractFontFamilies(slideHtml);
  const inlinedFontCss = await getInlinedFontCSS(fontFamilies);
  const inlinedHtml = await inlineImages(slideHtml);
  return wrapSlideHtml(inlinedHtml, aspectRatio, {
    inlineFontCss: inlinedFontCss,
  });
}

/**
 * Escala de render de los exports. 2 = supersampling: Chrome rasteriza a 2160×2700
 * (4:5), así el texto y los bordes salen nítidos. Instagram acepta hasta 2160px de
 * ancho y reduce mejor que si le mandáramos un original de 1080px.
 */
const EXPORT_SCALE = 2;

/**
 * Exporta UNA lámina a PNG.
 *
 * El "sin fondo" ya no se aplica acá: `stripBackgroundInPage`
 * (src/lib/strip-slide-background.mjs) corre DENTRO de la página, y la página ahora vive
 * del otro lado del seam de render — puede ser este proceso o el servicio de render. Se
 * pasa como el flag `transparent` y lo aplica quien tenga el navegador.
 */
export async function exportSlide(
  slide: Slide,
  aspectRatio: AspectRatio,
  options: { transparent?: boolean } = {},
  renderOpts: RenderOptions = {}
): Promise<Buffer> {
  const { width, height } = DIMENSIONS[aspectRatio];
  const html = await prepareRenderableHtml(slide.html, aspectRatio);

  return renderPng(
    { html, width, height, scale: EXPORT_SCALE, transparent: options.transparent },
    renderOpts
  );
}

/**
 * Exporta todas las láminas del carrusel a PNG, UNA POR VEZ.
 *
 * La serialización ya no se decide acá: el tope real lo pone el semáforo de
 * browser-pool (o `--concurrency=1` del servicio de render). Antes este loop tenía un
 * andamiaje de batches con `Promise.all` y `CONCURRENCY = 1`, más un comentario que
 * decía "hasta 3 láminas en paralelo" y hacía años que era mentira.
 */
export async function exportAllSlides(
  slides: Slide[],
  aspectRatio: AspectRatio,
  onProgress?: (current: number, total: number) => void,
  renderOpts: RenderOptions = {}
): Promise<{ name: string; buffer: Buffer }[]> {
  const results: { name: string; buffer: Buffer }[] = [];

  for (let i = 0; i < slides.length; i++) {
    const buffer = await exportSlide(slides[i], aspectRatio, {}, renderOpts);
    results.push({ name: `slide-${i + 1}.png`, buffer });
    onProgress?.(i + 1, slides.length);
  }

  return results;
}
