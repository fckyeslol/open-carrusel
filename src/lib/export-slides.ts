import { readFile } from "fs/promises";
import path from "path";
import { wrapSlideHtml, extractFontFamilies, usesItalic } from "./slide-html";
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
 * Referencias a imágenes en una lámina: la ruta root-relative (`/uploads/x.png`) y
 * también la URL ABSOLUTA (`https://carruseles.30x.com/uploads/x.png`).
 *
 * Las comillas pueden venir escapadas como entidad: al serializar un
 * style="background: url('/uploads/x.jpg')" el navegador lo guarda como
 * url(&quot;/uploads/x.jpg&quot;).
 */
const RE_IMG =
  /(?:src=|url\()\s*(?:["']|&quot;|&#0?39;|&apos;)?((?:https?:\/\/[^"'\s)&]+|\/[^"'\s)&]+)\.(?:png|jpe?g|webp|avif|gif|svg))/gi;

/**
 * A qué archivo de `public/` apunta una referencia, o `null` si no apunta a ninguno.
 *
 * Acepta la ruta root-relative y **la URL absoluta a nuestro propio sitio**, que es como
 * el editor guarda las fotos: 258 láminas en producción dicen
 * `<img src="https://carruseles.30x.com/uploads/…">`. Ese caso no se contemplaba —el regex
 * exigía que la ruta empezara con `/`— y era el bug: la foto no se inlineaba, y como la
 * captura tampoco espera a la red, el PNG salía sin ella o con ella a medio pintar. En el
 * editor se veía bien, porque ahí el navegador sí espera.
 *
 * El host NO se valida a propósito: lo que decide es si el archivo está en `public/`. Así
 * funciona igual en el dominio de producción, en localhost y en cualquier dominio futuro,
 * sin configuración que se pueda olvidar de actualizar.
 */
function rutaEnPublic(ref: string, publicDir: string): string | null {
  let pathname = ref;
  if (/^https?:\/\//i.test(ref)) {
    try {
      pathname = new URL(ref).pathname;
    } catch {
      return null;
    }
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return null; // %-encoding roto: no apunta a nada que podamos leer
  }
  const full = path.resolve(publicDir, `.${pathname}`);
  // Contención: una referencia con ../ no puede leer fuera de public/.
  return full === publicDir || full.startsWith(publicDir + path.sep) ? full : null;
}

/**
 * Inlinea como data: URI todas las imágenes de una lámina que vivan en `public/`.
 *
 * Es lo que sostiene TODO el seam de render: se renderiza con `setContent` y SIN base URL,
 * en un proceso que además puede ser otro contenedor. Una referencia que no se inlinee acá
 * no es "una imagen que carga más lento": es una imagen que el render puede no tener cuando
 * dispara la captura. Y falla en silencio, así que la lámina sale sin ella.
 *
 * Se cubren las dos formas en las que una lámina nombra sus imágenes (ruta y URL absoluta)
 * y cualquier carpeta de `public/`, no solo `/uploads` — `/30x` (los logos), `/textures`,
 * `/30x-slides`. Lo que queda afuera es lo genuinamente externo, y para eso está la espera
 * de imágenes del render (ver `imagesReadyPredicate` en slide-render-contract.mjs).
 */
export async function inlineImages(html: string): Promise<string> {
  const publicDir = path.resolve(process.cwd(), "public");
  const refs = new Set([...html.matchAll(RE_IMG)].map((m) => m[1]));

  const dataUriPorRef = new Map<string, string>();
  for (const ref of refs) {
    const archivo = rutaEnPublic(ref, publicDir);
    if (!archivo) continue;
    try {
      const buffer = await readFile(archivo);
      const mime = MIME_POR_EXT[path.extname(archivo).toLowerCase()] || "image/png";
      dataUriPorRef.set(ref, `data:${mime};base64,${buffer.toString("base64")}`);
    } catch {
      // No está en disco. Se deja la referencia como vino: si es absoluta el navegador la
      // baja por red y la espera de imágenes la aguanta; si es relativa no hay forma de
      // resolverla sin base URL y esa lámina sale sin la imagen.
    }
  }
  if (dataUriPorRef.size === 0) return html;

  // Se reemplaza SOLO donde la imagen se carga de verdad (`src=`, `url(`), no en todo el
  // documento como antes: el editor guarda su historial de imágenes en `data-oc-imghist`, y
  // meterle un base64 de 1MB a un atributo que nadie pinta infla el HTML que cruza el seam.
  return html.replace(RE_IMG, (todo, ref: string) => {
    const dataUri = dataUriPorRef.get(ref);
    return dataUri ? todo.replace(ref, dataUri) : todo;
  });
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
  // `usesItalic` se evalúa sobre el HTML CRUDO, antes de inlinear las imágenes: los data:
  // URI en base64 son megas de texto donde la palabra "italic" podría aparecer por azar.
  const inlinedFontCss = await getInlinedFontCSS(fontFamilies, usesItalic(slideHtml));
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
