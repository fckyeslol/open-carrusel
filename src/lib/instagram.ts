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
import puppeteer, { type Page } from "puppeteer";
import { normalizeInstagramUrl, hasCarouselHint } from "./instagram-url";

/**
 * Cookie de sesión de Instagram para pasar el muro de login cuando se scrapea
 * desde un servidor (Cloud Run y demás IPs de datacenter, que Instagram sirve
 * con un HTML recortado SIN el JSON del post → solo se rescata la portada). En
 * la compu de una diseñadora (IP residencial) no hace falta: el JSON llega igual.
 *
 * Es el valor de la cookie `sessionid` de una cuenta de Instagram logueada
 * (DevTools → Application → Cookies → instagram.com → sessionid). Se inyecta como
 * secreto en el server; sin ella, el scraping desde datacenter cae al fallback.
 */
function instagramSessionId(): string | undefined {
  const raw = process.env.IG_SESSIONID || process.env.INSTAGRAM_SESSIONID;
  return raw && raw.trim() ? raw.trim() : undefined;
}

/** Setea la cookie `sessionid` en una página antes de navegar a instagram.com. */
async function applyInstagramSession(page: Page): Promise<void> {
  const sessionId = instagramSessionId();
  if (!sessionId) return;
  await page.setCookie({
    name: "sessionid",
    value: sessionId,
    domain: ".instagram.com",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "None",
  });
}

interface ProxyConfig {
  /** http://host:port — SIN credenciales (Chrome no las acepta en --proxy-server). */
  server: string;
  username?: string;
  password?: string;
}

/**
 * Proxy residencial para scrapear Instagram desde el server. IG bloquea las IPs
 * de datacenter (Cloud Run) pero sirve el post completo a IPs residenciales — que
 * es la condición exacta que funciona en la compu de una diseñadora, SIN cookie ni
 * login. Un proxy residencial hace que la request salga por una IP de casa, así
 * que suele resolver el problema sin el riesgo de que IG trabe una cuenta (que sí
 * tiene [[instagram cookie]]). Formato del env: http://usuario:pass@host:puerto.
 */
function instagramProxy(): ProxyConfig | undefined {
  const raw = process.env.IG_PROXY;
  if (!raw || !raw.trim()) return undefined;
  try {
    const u = new URL(raw.trim());
    return {
      server: `${u.protocol}//${u.host}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Autentica el proxy (si trae credenciales) — debe correr antes de navegar. */
async function applyProxyAuth(page: Page, proxy: ProxyConfig | undefined): Promise<void> {
  if (proxy?.username) {
    await page.authenticate({ username: proxy.username, password: proxy.password ?? "" });
  }
}

/**
 * Bloquea recursos pesados (imágenes, media, fuentes, CSS) en la página de
 * extracción. El JSON del post viene en el HTML + los <script>, así que no hace
 * falta bajar nada más — y sobre un proxy residencial (que se paga por banda),
 * evitar los MB de thumbnails del feed recorta el gasto y acelera la carga.
 */
async function blockHeavyRequests(page: Page): Promise<void> {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (type === "image" || type === "media" || type === "font" || type === "stylesheet") {
      req.abort().catch(() => {});
    } else {
      req.continue().catch(() => {});
    }
  });
}

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
interface ExtractResult {
  /** URLs de imagen, en orden, dedup. */
  urls: string[];
  /**
   * true si NO se pudo leer el JSON del post y hubo que caer al `og:image`
   * (solo la portada). Señal de scraping degradado: Instagram sirvió una página
   * recortada (muro de login / bloqueo de IP) y el referente quedó incompleto.
   */
  usedFallback: boolean;
}

/** Lee los <script type="application/json"> y junta las URLs de imagen. */
async function readJsonImageUrls(page: Page): Promise<string[]> {
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
  return urls;
}

async function extractImageUrls(page: Page, postUrl: string): Promise<ExtractResult> {
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
  );
  // La cookie de sesión (si está) hace que Instagram sirva el HTML completo con
  // el JSON del post también desde IPs de datacenter — sin ella, un server suele
  // recibir solo la portada.
  await applyInstagramSession(page);
  await page.goto(postUrl, { waitUntil: "networkidle2", timeout: 30000 });

  // El JSON de hidratación a veces llega después de networkidle2. Si el primer
  // intento no trae nada, esperamos a que aparezca el script y releemos una vez.
  let urls = await readJsonImageUrls(page);
  if (urls.length === 0) {
    await page
      .waitForSelector('script[type="application/json"]', { timeout: 5000 })
      .catch(() => {});
    urls = await readJsonImageUrls(page);
  }

  if (urls.length > 0) {
    // Dedup preservando orden.
    return { urls: [...new Set(urls)], usedFallback: false };
  }

  // Fallback DOM: og:image (al menos la portada). Marca ingesta degradada.
  const og = await page
    .$eval('meta[property="og:image"]', (el) => el.getAttribute("content") || "")
    .catch(() => "");
  return { urls: og ? [og] : [], usedFallback: true };
}

/**
 * Baja una imagen del CDN de Instagram y devuelve sus bytes, o null si falla.
 *
 * Estrategia: navegar el navegador DIRECTO a la URL de la imagen (page.goto) y
 * tomar el buffer de la respuesta. Al ser una navegación de nivel superior no
 * aplica CORS (un fetch a fbcdn.net desde el origen instagram.com lo bloquea) y
 * el CDN sirve la imagen sin el 403 que devolvía el fetch pelado de Node. Si la
 * navegación falla, se intenta un fetch de Node con Referer como último recurso.
 */
async function downloadImageBytes(imgPage: Page, src: string): Promise<Buffer | null> {
  // 1) Navegación directa a la imagen (sin CORS, con red del navegador).
  try {
    const resp = await imgPage.goto(src, { waitUntil: "networkidle2", timeout: 30000 });
    if (resp?.ok()) {
      const buf = await resp.buffer();
      if (buf.length > 0) return buf;
    }
  } catch {
    // navegación caída; seguimos con el fallback
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

/** Detecta el formato por magic bytes. Instagram sirve WebP casi siempre hoy. */
function detectImageExt(b: Buffer): "jpg" | "png" | "webp" | null {
  if (b[0] === 0xff && b[1] === 0xd8) return "jpg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // "WEBP"
  ) {
    return "webp";
  }
  return null;
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
  const proxy = instagramProxy();
  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 60000,
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      ...(proxy ? [`--proxy-server=${proxy.server}`] : []),
    ],
  });
  hooks.onBrowserReady?.();

  const page = await browser.newPage();
  const imgPage = await browser.newPage();
  await applyProxyAuth(page, proxy);
  await applyProxyAuth(imgPage, proxy);
  // Con proxy (metered) la página de extracción no baja imágenes/CSS: solo el JSON.
  if (proxy) await blockHeavyRequests(page);
  try {
    hooks.onExtractStart?.();
    const { urls: imageUrls, usedFallback } = await extractImageUrls(page, postUrl);
    if (imageUrls.length === 0) {
      throw new Error(
        "No se pudieron extraer imágenes del post (¿privado, borrado, o Instagram pide login?). Probá subir capturas del referente a mano."
      );
    }

    // GUARD anti-basura: si Instagram no dio el JSON del post y hubo que caer a
    // la portada (usedFallback), o si la URL apunta a un carrusel pero solo se
    // recuperó 1 lámina, el referente está INCOMPLETO. Antes se seguía de largo
    // y el agente generaba un carrusel de 1 lámina inventada (institucional) que
    // se marcaba como válido — el peor resultado posible. Mejor fallar claro:
    // así el job queda failed con una causa accionable en vez de entregar basura.
    const looksLikeCarousel = hasCarouselHint(rawUrl);
    if (usedFallback || (looksLikeCarousel && imageUrls.length < 2)) {
      const sessionHint = instagramSessionId()
        ? "La cookie IG_SESSIONID quizás venció — renovala."
        : "Configurá IG_SESSIONID en el server (cookie de sesión de Instagram) para scrapear posts completos desde la nube, o subí las capturas del referente a mano.";
      throw new Error(
        `Instagram no devolvió el carrusel completo desde el servidor: solo se pudo leer ${imageUrls.length} ${imageUrls.length === 1 ? "imagen (la portada)" : "imágenes"}. ${sessionHint}`
      );
    }

    hooks.onExtracted?.(imageUrls.length);

    const slides: DownloadedSlide[] = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const buffer = await downloadImageBytes(imgPage, imageUrls[i]);
      if (!buffer) continue;
      const ext = detectImageExt(buffer);
      if (!ext) continue; // no es una imagen que reconozcamos
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
    await imgPage.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
