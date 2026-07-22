/**
 * Descarga las slides de un carrusel/post de Instagram para usarlas como REFERENTE.
 *
 * Portado del Paso 1 de 30x-carousel-pipeline/AGENT.md (mecanismo ya probado):
 *  - Se navega al post con un browser headless (Puppeteer).
 *  - Se leen las URLs reales del JSON embebido (`image_versions2.candidates[0].url`),
 *    NO del DOM (scrapear <img> agarra miniaturas de OTROS posts — bug real ya visto).
 *  - Se bajan las imágenes (fetch directo; para posts públicos no hace falta login).
 *
 * Fallback si el JSON no aparece: og:image + imgs del artículo.
 */
import { writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { normalizeInstagramUrl } from "./instagram-url";

function findChrome(): string | undefined {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const local = process.env.LOCALAPPDATA || "";
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          `${local}\\Google\\Chrome\\Application\\chrome.exe`,
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
  return candidates.find((p) => p && existsSync(p));
}

export interface DownloadedSlide {
  url: string; // ruta pública, p.ej. /uploads/<uuid>.jpg
  absPath: string; // ruta absoluta en disco
  name: string; // "referente 1/N"
}

/**
 * Avisos de avance durante la descarga. Son opcionales: sin ellos la función se
 * comporta igual que antes, pero la UI se queda ciega durante ~30-60s.
 */
export interface DownloadProgressHooks {
  /** Chrome headless arrancó. */
  onBrowserReady?: () => void;
  /** Se está navegando al post para leer las URLs reales. */
  onExtractStart?: () => void;
  /** Se supo cuántas láminas tiene el referente. */
  onExtracted?: (imageCount: number) => void;
  /** Se guardó la lámina `current` de `total`. */
  onSlideDownloaded?: (current: number, total: number) => void;
}

// Las funciones de URL viven en instagram-url.ts (sin deps de Node) para que
// también las pueda usar el form del cliente. Se re-exportan acá por comodidad.
export { normalizeInstagramUrl, isInstagramUrl } from "./instagram-url";

/** Busca recursivamente en un JSON todas las URLs de imagen de mejor resolución. */
function collectImageUrls(node: unknown, out: string[], seen: Set<object>): void {
  if (!node || typeof node !== "object") return;
  if (seen.has(node as object)) return;
  seen.add(node as object);

  if (Array.isArray(node)) {
    for (const item of node) collectImageUrls(item, out, seen);
    return;
  }

  const obj = node as Record<string, unknown>;

  // Caso 1: nodo con image_versions2.candidates → el candidato [0] es el de mayor res.
  const iv2 = obj["image_versions2"] as { candidates?: Array<{ url?: string }> } | undefined;
  if (iv2?.candidates?.length && typeof iv2.candidates[0]?.url === "string") {
    out.push(iv2.candidates[0].url as string);
  }
  // Caso 2: display_url / display_src sueltos (posts de una sola imagen).
  for (const key of ["display_url", "display_src"]) {
    if (typeof obj[key] === "string") out.push(obj[key] as string);
  }

  // carousel_media primero para preservar el orden de las láminas.
  if (Array.isArray(obj["carousel_media"])) {
    for (const item of obj["carousel_media"]) collectImageUrls(item, out, seen);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === "carousel_media") continue;
    collectImageUrls(v, out, seen);
  }
}

/**
 * Navega al post y lee las URLs reales. Deja la página ABIERTA a propósito: el
 * caller la reutiliza para bajar las imágenes desde el mismo origen instagram.com
 * (con Referer/cookies), que es lo que evita el 403 del CDN. El caller cierra.
 */
async function extractImageUrls(page: Page, postUrl: string): Promise<string[]> {
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
  );
  await page.goto(postUrl, { waitUntil: "networkidle2", timeout: 30000 });

  // Textos crudos de todos los <script type="application/json">.
  const jsonBlobs: string[] = await page.$$eval('script[type="application/json"]', (nodes) =>
    nodes.map((n) => n.textContent || "").filter((t) => t.includes("image_versions2") || t.includes("carousel_media") || t.includes("display_url"))
  );

  const urls: string[] = [];
  const seen = new Set<object>();
  for (const blob of jsonBlobs) {
    try {
      collectImageUrls(JSON.parse(blob), urls, seen);
    } catch {
      // blob no-JSON o parcial: ignorar
    }
  }

  if (urls.length === 0) {
    // Fallback DOM: og:image (al menos la portada).
    const og = await page
      .$eval('meta[property="og:image"]', (el) => el.getAttribute("content") || "")
      .catch(() => "");
    if (og) urls.push(og);
  }

  // Dedup preservando orden.
  return [...new Set(urls)];
}

/**
 * Baja una imagen del CDN de Instagram y devuelve sus bytes, o null si falla.
 *
 * Estrategia: primero el fetch corre DENTRO de la página (origen instagram.com),
 * así lleva Referer + cookies de sesión y el CDN (fbcdn.net) no responde 403 —
 * que es el motivo por el que el fetch pelado de Node fallaba. Si eso no da un
 * buffer usable, se intenta un fetch de Node con Referer como último recurso.
 */
async function downloadImageBytes(page: Page, src: string): Promise<Buffer | null> {
  // 1) Fetch en contexto de navegador (mismo origen que el post).
  try {
    const dataUrl: string | null = await page.evaluate(async (url) => {
      try {
        const resp = await fetch(url, { credentials: "include", referrerPolicy: "no-referrer-when-downgrade" });
        if (!resp.ok) return null;
        const blob = await resp.blob();
        return await new Promise<string | null>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch {
        return null;
      }
    }, src);
    if (dataUrl) {
      const comma = dataUrl.indexOf(",");
      if (comma !== -1) {
        const buf = Buffer.from(dataUrl.slice(comma + 1), "base64");
        if (buf.length > 0) return buf;
      }
    }
  } catch {
    // el contexto de la página puede caerse; seguimos con el fallback
  }

  // 2) Fallback: fetch de Node con Referer de instagram.com.
  try {
    const res = await fetch(src, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Referer: "https://www.instagram.com/",
        Accept: "image/avif,image/webp,image/png,image/jpeg,*/*",
      },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Descarga las slides del referente a public/uploads/ y devuelve sus rutas.
 * @param uploadDir directorio absoluto de public/uploads
 */
export async function downloadInstagramReference(
  rawUrl: string,
  uploadDir: string,
  makeId: () => string,
  hooks: DownloadProgressHooks = {}
): Promise<DownloadedSlide[]> {
  const postUrl = normalizeInstagramUrl(rawUrl);
  if (!postUrl) throw new Error("URL de Instagram inválida");

  const executablePath = findChrome();
  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 60000,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });
  hooks.onBrowserReady?.();

  const page = await browser.newPage();
  try {
    hooks.onExtractStart?.();
    const imageUrls = await extractImageUrls(page, postUrl);
    if (imageUrls.length === 0) {
      throw new Error(
        "No se pudieron extraer imágenes del post (¿privado, borrado, o Instagram pide login?). Probá subir capturas del referente a mano."
      );
    }
    hooks.onExtracted?.(imageUrls.length);

    const slides: DownloadedSlide[] = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const buffer = await downloadImageBytes(page, imageUrls[i]);
      if (!buffer) continue;
      // Verificar magic JPEG/PNG antes de guardar.
      const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
      const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
      if (!isJpeg && !isPng) continue;
      const ext = isPng ? "png" : "jpg";
      const fileName = `${makeId()}.${ext}`;
      const absPath = path.join(uploadDir, fileName);
      await writeFile(absPath, buffer);
      slides.push({
        url: `/uploads/${fileName}`,
        absPath,
        name: `Referente ${i + 1}`,
      });
      hooks.onSlideDownloaded?.(slides.length, imageUrls.length);
    }

    if (slides.length === 0) {
      throw new Error("Se encontraron URLs pero ninguna imagen se pudo descargar (403 o formato inesperado).");
    }
    return slides;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
