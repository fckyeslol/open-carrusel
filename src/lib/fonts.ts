import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { createHash } from "crypto";
import path from "path";
import { googleFontAxes } from "./slide-html";

const FONT_CACHE_DIR = path.resolve(process.cwd(), "data", ".font-cache");

// In-memory cache (survives across requests, lost on restart)
const memoryCache = new Map<string, string>();

/**
 * Nombre del archivo de cache: familia + huella de los EJES con los que se pidió.
 *
 * La huella no es decorativa. La cache anterior se llamaba solo `<familia>.css`, así que al
 * cambiar la forma del pedido —agregar el eje `ital`, ampliar los grosores— el archivo viejo
 * seguía sirviendo el CSS anterior para siempre y el arreglo no llegaba a ninguna máquina
 * que ya tuviera cache. Eso es exactamente lo que dejó láminas exportando con itálica
 * falseada y con `Inter` sin el peso 900. Con los ejes en el nombre, cualquier cambio de
 * pedido estrena archivo y se re-descarga solo.
 */
function cacheFileName(family: string, axes: string): string {
  const huella = createHash("sha1").update(axes).digest("hex").slice(0, 8);
  return `${family.replace(/\s/g, "-")}.${huella}.css`;
}

/**
 * Cómo tiene que venir el archivo de fuente.
 *
 * - `variable`: lo que sirve Google a un navegador moderno. Un archivo cubre todos los
 *   grosores. Es lo mejor para RASTERIZAR (PNG, preview): menos bytes, mismo dibujo.
 * - `static`: una instancia por grosor. Es lo único que Chromium sabe EMBEBER en un PDF.
 *
 * Esto no es una preferencia de estilo: con la fuente variable, `page.pdf()` no puede
 * embeber el programa de la fuente y degrada el texto a una **fuente Type 3**, o sea los
 * glifos como procedimientos de trazo. El PDF se ve bien —los contornos son los correctos,
 * por eso nadie lo notó— pero no hay tipografía adentro: no tiene `/FontFile` ni `/BaseFont`,
 * el texto no se puede copiar, y al importarlo Canva o Illustrator reciben curvas en vez de
 * texto con su fuente. Con instancias estáticas, el mismo PDF sale con `Inter-Bold` embebida.
 */
export type FontEmbedding = "variable" | "static";

/**
 * User-Agent con el que se le pide el CSS a Google Fonts. Google decide el FORMATO por UA,
 * y de ahí sale la diferencia: un Chrome moderno recibe la variable; un Chrome viejo, que no
 * las soportaba, recibe las instancias estáticas (igual en woff2, así que no se paga en
 * formato). No hay parámetro de la API para pedirlas: el UA es la única palanca.
 */
const UA_VARIABLE =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const UA_ESTATICA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/50.0.2661.102 Safari/537.36";

/**
 * Fetch Google Fonts CSS with inlined base64 woff2 data URIs.
 * This creates a fully self-contained CSS string that works without network access.
 *
 * `italic` agrega las caras en itálica. Sin ellas Chrome inclina la recta y el texto sale
 * más ancho que en el preview — ver `googleFontAxes` en slide-html.ts.
 *
 * `embedding` elige entre la fuente variable (rasterizado) y las instancias estáticas
 * (PDF). Ver `FontEmbedding`.
 */
export async function getInlinedFontCSS(
  families: string[],
  italic = false,
  embedding: FontEmbedding = "variable"
): Promise<string> {
  if (families.length === 0) return "";

  // El formato entra en la huella de la cache: si no, el CSS variable ya cacheado se
  // seguiría sirviendo al PDF para siempre y el arreglo no llegaría a ninguna máquina que
  // ya tenga cache — el mismo pozo del que salió la huella de los ejes.
  const axes = `${googleFontAxes(italic)}${embedding === "static" ? "|static" : ""}`;
  const parts: string[] = [];

  for (const family of families) {
    const cached = await getCachedFont(family, axes);
    if (cached) {
      parts.push(cached);
      continue;
    }

    try {
      const css = await fetchAndInlineFont(family, googleFontAxes(italic), embedding);
      if (css) {
        await cacheFont(family, axes, css);
        parts.push(css);
      }
    } catch {
      // Font not available — skip silently, system font fallback will be used
    }
  }

  return parts.join("\n");
}

async function getCachedFont(family: string, axes: string): Promise<string | null> {
  const clave = `${family}|${axes}`;
  // Check memory first
  if (memoryCache.has(clave)) {
    return memoryCache.get(clave)!;
  }

  // Check disk
  try {
    const diskPath = path.join(FONT_CACHE_DIR, cacheFileName(family, axes));
    const css = await readFile(diskPath, "utf-8");
    memoryCache.set(clave, css);
    return css;
  } catch {
    return null;
  }
}

async function cacheFont(family: string, axes: string, css: string): Promise<void> {
  memoryCache.set(`${family}|${axes}`, css);
  try {
    await mkdir(FONT_CACHE_DIR, { recursive: true });
    await writeFile(path.join(FONT_CACHE_DIR, cacheFileName(family, axes)), css, "utf-8");
    // El archivo sin huella es de la cache vieja y ya no lo lee nadie: son ~1-2MB por
    // familia que además PARECEN la cache activa. Borrarlo evita el rato perdido en
    // "¿cuál de los dos está usando el export?" la próxima vez que algo salga distinto.
    await unlink(path.join(FONT_CACHE_DIR, `${family.replace(/\s/g, "-")}.css`)).catch(
      () => {}
    );
  } catch {
    // Disk cache write failed — not critical
  }
}

async function fetchAndInlineFont(
  family: string,
  axes: string,
  embedding: FontEmbedding = "variable"
): Promise<string | null> {
  // Fetch CSS from Google Fonts (with woff2-capable user agent).
  // Pedimos el rango completo de grosores: la lista explícita es tolerante, así
  // que Google solo inlinea los pesos que la fuente tiene (ver googleFontAxes).
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:${axes}&display=block`;
  const response = await fetch(url, {
    headers: {
      // El UA elige el formato: variable o instancias estáticas. Ver FontEmbedding.
      "User-Agent": embedding === "static" ? UA_ESTATICA : UA_VARIABLE,
    },
  });

  if (!response.ok) return null;
  let css = await response.text();

  // Find all url() references to woff2 files and inline them.
  //
  // En paralelo con un tope, no en serie: pedir el eje `ital` DUPLICA la cantidad de
  // archivos (Inter pasa de 63 subsets a 126) y bajarlos de a uno son minutos la primera
  // vez que una máquina —o un contenedor recién levantado— tiene la cache vacía. El tope
  // está para no abrir 126 conexiones a gstatic de golpe: no acelera más y es la clase de
  // ráfaga que se gana un 429.
  // No solo `.woff2`: si Google sirviera otro formato para algún UA y el regex no lo
  // matcheara, la URL quedaría remota y el "documento autocontenido" dependería de la red
  // en pleno render — que falla en silencio y sale la fuente de sistema.
  const urlRegex = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.(?:woff2|woff|ttf|otf))\)/g;
  const fontUrls = [...new Set([...css.matchAll(urlRegex)].map((m) => m[1]))];
  const inlined = new Map<string, string>();
  const CONCURRENCIA = 8;

  // `pendiente++` es atómico entre estos workers (un solo hilo, sin await en el medio),
  // así que cada URL la toma exactamente uno.
  let pendiente = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCIA, fontUrls.length) }, async () => {
      while (pendiente < fontUrls.length) {
        const fontUrl = fontUrls[pendiente++];
        try {
          const fontResponse = await fetch(fontUrl);
          if (!fontResponse.ok) continue;
          const buffer = await fontResponse.arrayBuffer();
          inlined.set(fontUrl, Buffer.from(buffer).toString("base64"));
        } catch {
          // Keep the original URL — Puppeteer can still fetch it
        }
      }
    })
  );

  const MIME: Record<string, string> = {
    woff2: "font/woff2",
    woff: "font/woff",
    ttf: "font/ttf",
    otf: "font/otf",
  };
  for (const [fontUrl, base64] of inlined) {
    const ext = fontUrl.match(/\.(woff2|woff|ttf|otf)$/)?.[1] ?? "woff2";
    css = css.replaceAll(fontUrl, `data:${MIME[ext]};base64,${base64}`);
  }

  // Ensure font-display: block for deterministic rendering
  css = css.replace(/font-display:\s*swap/g, "font-display: block");

  return css;
}
