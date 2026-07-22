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
import puppeteer, { type Browser } from "puppeteer";
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

async function extractImageUrls(browser: Browser, postUrl: string): Promise<string[]> {
  const page = await browser.newPage();
  try {
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
  } finally {
    await page.close().catch(() => {});
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

  try {
    hooks.onExtractStart?.();
    const imageUrls = await extractImageUrls(browser, postUrl);
    if (imageUrls.length === 0) {
      throw new Error(
        "No se pudieron extraer imágenes del post (¿privado, borrado, o Instagram pide login?). Probá subir capturas del referente a mano."
      );
    }
    hooks.onExtracted?.(imageUrls.length);

    const slides: DownloadedSlide[] = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const src = imageUrls[i];
      let buffer: Buffer;
      try {
        const res = await fetch(src, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          },
        });
        if (!res.ok) continue;
        buffer = Buffer.from(await res.arrayBuffer());
      } catch {
        continue;
      }
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
    await browser.close().catch(() => {});
  }
}
