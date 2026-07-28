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
import path from "path";
import { type Page } from "puppeteer";
import { withContext } from "./browser-pool";
import { normalizeInstagramUrl, hasCarouselHint } from "./instagram-url";
import {
  type ProxyConfig,
  markProxyDown,
  markProxyUp,
  proxyTryOrder,
} from "./ig-proxies";

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

/**
 * Los proxies residenciales para scrapear Instagram desde el server viven en
 * ig-proxies.ts (pool + cooldown). IG bloquea las IPs de datacenter (Cloud Run) pero
 * sirve el post completo a IPs residenciales — que es la condición exacta que funciona
 * en la compu de una diseñadora, SIN cookie ni login. Un proxy residencial hace que la
 * request salga por una IP de casa, así que resuelve el problema sin el riesgo de que
 * IG trabe una cuenta (que sí tiene la cookie IG_SESSIONID).
 */

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
 * Estrategia: fetch directo de Node PRIMERO (no pasa por el proxy — el CDN no
 * bloquea IPs de datacenter, así que ahorramos banda del proxy residencial), y si
 * ese falla, navegación del navegador como fallback (que sí sale por el proxy).
 */
async function downloadImageBytes(imgPage: Page, src: string): Promise<Buffer | null> {
  // 1) PRIMARIO: fetch directo de Node — NO pasa por el proxy. Las imágenes de las
  //    láminas viven en el CDN de Instagram (fbcdn/cdninstagram), que sirve a
  //    cualquier IP (incluida la de datacenter de Cloud Run); solo el HTML del post
  //    está bloqueado. Bajarlas directas ahorra la banda (metered) del proxy
  //    residencial. Validamos magic bytes antes de aceptar: si el CDN devolviera un
  //    200 que no es imagen, cae al navegador en vez de guardar basura.
  try {
    const res = await fetch(src, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Referer: "https://www.instagram.com/",
        Accept: "image/avif,image/webp,image/png,image/jpeg,*/*",
      },
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 0 && detectImageExt(buf)) return buf;
    }
  } catch {
    // fetch caído; seguimos con el fallback del navegador
  }

  // 2) FALLBACK: navegación del navegador (que SÍ sale por el proxy si está
  //    configurado). Como navegación de nivel superior no aplica CORS y el CDN la
  //    sirve sin el 403 que a veces daba un fetch pelado. Solo se usa si el fetch
  //    directo falló, así que el proxy casi nunca toca las imágenes.
  try {
    const resp = await imgPage.goto(src, { waitUntil: "networkidle2", timeout: 30000 });
    if (resp?.ok()) {
      const buf = await resp.buffer();
      if (buf.length > 0) return buf;
    }
  } catch {
    // navegación caída
  }
  return null;
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
 * Códigos de red de Chrome que significan "falló EL PROXY", no "falló Instagram".
 *
 * Distinguirlos importa porque el mensaje que ve la diseñadora es distinto: un
 * ERR_TUNNEL_CONNECTION_FAILED no se arregla revisando si el post es público (que
 * es lo que decía la UI antes, mandando a buscar donde no era) — se arregla en el
 * panel del proveedor del proxy. Caso real 2026-07-28: Litport aceptaba el TCP y
 * el Basic auth pero devolvía `500 / X-Proxy-Error-Code: 2` a TODO CONNECT, y
 * Chrome lo traduce a ERR_TUNNEL_CONNECTION_FAILED.
 */
const PROXY_NET_ERRORS = [
  "ERR_TUNNEL_CONNECTION_FAILED",
  "ERR_PROXY_CONNECTION_FAILED",
  "ERR_PROXY_AUTH_REQUESTED",
  "ERR_PROXY_AUTH_UNSUPPORTED",
  "ERR_PROXY_CERTIFICATE_INVALID",
  "ERR_NO_SUPPORTED_PROXIES",
  "ERR_SOCKS_CONNECTION_FAILED",
  "ERR_MANDATORY_PROXY_CONFIGURATION_FAILED",
];

function isProxyFailure(err: unknown): boolean {
  const msg = (err as Error)?.message || "";
  return PROXY_NET_ERRORS.some((code) => msg.includes(code));
}

/**
 * El proxy residencial no abrió el túnel Y el reintento por la IP directa tampoco
 * alcanzó. Es un tipo aparte para que la UI pueda decir "el proxy está caído" en vez
 * de la pista genérica de "¿el post es público?" — ver RECOVERY_BY_STAGE en thirtyx.ts.
 */
export class ProxyUnavailableError extends Error {
  // Campos declarados a mano (no parameter properties): `node --test` corre los .mts
  // en modo strip-only, que no soporta `constructor(readonly x)`. Ver instagram-proxy.test.mts.
  /** Etiquetas (host:puerto#hash) de los proxies que fallaron, en orden de intento. */
  readonly failedProxies: string[];
  readonly directError: Error;

  constructor(failed: Array<{ label: string; error: Error }>, directError: Error) {
    const detail = failed.map((f) => `${f.label} [${f.error.message}]`).join("; ");
    const count =
      failed.length === 1
        ? "El proxy residencial no abrió el túnel"
        : `Ninguno de los ${failed.length} proxies residenciales abrió el túnel`;
    super(
      `${count} a Instagram (${detail}), y el reintento por la IP directa tampoco funcionó: ${directError.message}`
    );
    this.name = "ProxyUnavailableError";
    this.failedProxies = failed.map((f) => f.label);
    this.directError = directError;
  }
}

/**
 * Descarga las slides del referente a public/uploads/ y devuelve sus rutas.
 *
 * El proxy residencial es una OPTIMIZACIÓN, no una dependencia dura: si el túnel
 * falla se reintenta por la IP directa antes de rendirse. En una máquina con IP
 * residencial (la laptop de una diseñadora) ese reintento alcanza solo, así que un
 * proxy muerto ya no tumba una ingesta que habría funcionado igual sin él. Desde
 * datacenter el reintento casi siempre cae en el guard anti-basura — pero entonces
 * el error dice que el proxy está caído, que es la causa accionable.
 *
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

  return withProxyFallback(proxyTryOrder(), (p) =>
    attemptDownload(postUrl, rawUrl, uploadDir, makeId, hooks, p)
  );
}

/**
 * Corre `run` con cada proxy del pool en orden y, si NINGUNO abre el túnel, reintenta
 * por la IP directa. Un proxy que falla se marca en cooldown para que las próximas
 * ingestas lo salteen en vez de volver a pagar el intento muerto.
 *
 * Vive aparte de `downloadInstagramReference` para poder testear la política de
 * reintento sin levantar Chrome ni salir a la red (ver instagram-proxy.test.mts).
 *
 * Un error que NO es del proxy (post privado, borrado, guard anti-basura) se propaga
 * tal cual y corta la cadena: fallaría igual con cualquier proxy, así que seguir
 * rotando solo multiplicaría la espera para dar el mismo error.
 */
export async function withProxyFallback<T>(
  proxies: ProxyConfig[],
  run: (proxy: ProxyConfig | undefined) => Promise<T>
): Promise<T> {
  const failed: Array<{ label: string; error: Error }> = [];

  for (const proxy of proxies) {
    try {
      const result = await run(proxy);
      // Funcionó: si venía marcado como caído, se lo saca del cooldown.
      markProxyUp(proxy);
      return result;
    } catch (err) {
      if (!isProxyFailure(err)) throw err;
      const error = err as Error;
      markProxyDown(proxy, error.message);
      failed.push({ label: proxy.label, error });
    }
  }

  // Último recurso: la IP directa. Es la única opción cuando no hay proxies
  // configurados, y el rescate real en máquinas con IP residencial.
  try {
    return await run(undefined);
  } catch (directErr) {
    if (failed.length === 0) throw directErr;
    throw new ProxyUnavailableError(failed, directErr as Error);
  }
}

/** Un intento de descarga, con o sin proxy. Ver downloadInstagramReference. */
async function attemptDownload(
  postUrl: string,
  rawUrl: string,
  uploadDir: string,
  makeId: () => string,
  hooks: DownloadProgressHooks,
  proxy: ProxyConfig | undefined
): Promise<DownloadedSlide[]> {
  // Un CONTEXTO aislado del Chrome compartido, en vez de un Chrome propio. El proxy
  // residencial y la cookie de sesión aplican solo a este contexto, así que el render
  // sigue saliendo por la IP normal — que es lo que queremos (las imágenes se bajan con
  // un fetch de Node, fuera del proxy metered; ver downloadImageBytes).
  //
  // Antes esto lanzaba su propio browser con `--proxy-server`, y con 4 jobs en paralelo
  // eran 4 Chrome completos navegando Instagram: la mayor fuente de consumo de memoria.
  return withContext(
    async (context) => {
      const page = await context.newPage();
      const imgPage = await context.newPage();
      hooks.onBrowserReady?.();
      await applyProxyAuth(page, proxy);
      await applyProxyAuth(imgPage, proxy);
      // Con proxy (metered) la página de extracción no baja imágenes/CSS: solo el JSON.
      if (proxy) await blockHeavyRequests(page);

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
      // Sin `finally`: withContext cierra el contexto (y con él sus dos páginas) pase lo
      // que pase, y libera el permiso del semáforo.
    },
    { proxyServer: proxy?.server }
  );
}
