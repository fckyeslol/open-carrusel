import puppeteer, { type Browser } from "puppeteer";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import sharp from "sharp";
import { wrapSlideHtml, extractFontFamilies } from "./slide-html";
import { getInlinedFontCSS } from "./fonts";
import type { Slide, AspectRatio } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";

// Singleton browser with lifecycle management
let browser: Browser | null = null;
let exportCount = 0;
const MAX_EXPORTS_BEFORE_RESTART = 50;

/**
 * Find a system Chrome/Edge to use instead of Puppeteer's bundled Chromium.
 * On some Windows setups the bundled Chromium hangs at Page.captureScreenshot;
 * the full system Chrome renders reliably. Override with PUPPETEER_EXECUTABLE_PATH.
 */
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

export async function getBrowser(): Promise<Browser> {
  if (browser && exportCount >= MAX_EXPORTS_BEFORE_RESTART) {
    await browser.close().catch(() => {});
    browser = null;
    exportCount = 0;
  }
  if (!browser || !browser.isConnected()) {
    const executablePath = findChrome();
    browser = await puppeteer.launch({
      headless: true,
      protocolTimeout: 120000,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });
    exportCount = 0;
  }
  return browser;
}

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
async function inlineImages(html: string): Promise<string> {
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
 * Es el paso compartido por TODOS los exports (PNG, PPTX, …): inlina las imágenes
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
 * Export a single slide to PNG buffer.
 */
export async function exportSlide(
  slide: Slide,
  aspectRatio: AspectRatio
): Promise<Buffer> {
  const { width, height } = DIMENSIONS[aspectRatio];

  const fullHtml = await prepareRenderableHtml(slide.html, aspectRatio);

  const br = await getBrowser();
  const page = await br.newPage();

  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(fullHtml, { waitUntil: "domcontentloaded", timeout: 15000 });

    // Wait for fonts to be ready
    await page
      .waitForFunction(
        () =>
          document.fonts.ready.then(() =>
            [...document.fonts].every((f) => f.status === "loaded")
          ),
        { timeout: 10000 }
      )
      .catch(() => {
        // Font loading timeout — proceed with whatever loaded
      });

    const screenshotBuffer = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width, height },
      // captureBeyondViewport defaults to true when `clip` is set, which routes
      // through an Emulation path that hangs captureScreenshot on this Windows/
      // Chromium combo. Viewport == clip here, so disabling it is equivalent + reliable.
      captureBeyondViewport: false,
    });

    exportCount++;

    // Post-process with Sharp: enforce sRGB
    const processed = await sharp(screenshotBuffer)
      .toColorspace("srgb")
      .png()
      .toBuffer();

    return processed;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Export all slides of a carousel to PNG buffers.
 * Processes up to 3 slides concurrently.
 */
export async function exportAllSlides(
  slides: Slide[],
  aspectRatio: AspectRatio,
  onProgress?: (current: number, total: number) => void
): Promise<{ name: string; buffer: Buffer }[]> {
  const results: { name: string; buffer: Buffer }[] = [];
  // Serialize: concurrent Page.captureScreenshot calls on one browser can deadlock
  // (the screenshot hang seen on Windows). One page at a time is reliable.
  const CONCURRENCY = 1;

  for (let i = 0; i < slides.length; i += CONCURRENCY) {
    const batch = slides.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (slide, batchIdx) => {
        const idx = i + batchIdx;
        const buffer = await exportSlide(slide, aspectRatio);
        onProgress?.(idx + 1, slides.length);
        return { name: `slide-${idx + 1}.png`, buffer };
      })
    );
    results.push(...batchResults);
  }

  return results;
}
