/**
 * EL SEAM DE RENDER — la única puerta por la que se rasteriza una lámina.
 *
 * El render es una función pura de datos serializables:
 *
 *     { html, width, height, scale, transparent } → PNG/PDF
 *
 * y eso no es casualidad del diseño nuevo: ya era así. `prepareRenderableHtml`
 * (export-slides.ts) inlinea el CSS de las fuentes y TODAS las imágenes como data: URIs,
 * y acá se usa `setContent` SIN base URL. El HTML que llega a Chrome no depende del
 * filesystem ni de la red.
 *
 * Por eso la firma es de DATOS y no de callback. Una API tipo `withPage(fn)` que le pasa
 * una `Page` viva al que llama no se puede mover a otro proceso —no se serializa un
 * closure—, y ese es exactamente el movimiento que queremos habilitar: sacar Chrome de la
 * instancia de la app a un servicio aparte. Con esta firma, el servicio remoto es un
 * cliente HTTP detrás de estas dos funciones y ningún call site cambia.
 *
 * Lo que NO vive acá: armar el HTML (eso es dominio — `prepareRenderableHtml`,
 * `wrapSlideHtml`, `getInlinedFontCSS`). Este módulo recibe HTML y devuelve bytes.
 */
import sharp from "sharp";
import { type Page } from "puppeteer";
import { withPage } from "./browser-pool";
import { renderFallo, renderOk } from "./telemetry";
import {
  CONTRACT_VERSION,
  FONTS_READY_TIMEOUT_MS,
  IMAGES_READY_TIMEOUT_MS,
  SET_CONTENT_TIMEOUT_PDF_MS,
  SET_CONTENT_TIMEOUT_PNG_MS,
  decodeImagesInPage,
  fontsReadyPredicate,
  imagesReadyPredicate,
  stripBackgroundInPage,
} from "./slide-render-contract.mjs";

/** Todo lo que Chrome necesita para rasterizar. Serializable a propósito. */
export interface RenderInput {
  /** Documento completo y autocontenido: fuentes inlineadas, imágenes en data: URI. */
  html: string;
  width: number;
  height: number;
  /** `deviceScaleFactor`. 2 = supersampling para que el texto salga nítido. */
  scale: number;
  /** PNG con canal alfa: neutraliza la capa de fondo del editor antes de capturar. */
  transparent?: boolean;
}

export interface RenderOptions {
  /** Permite que un job preemptado suelte su lugar en la fila en vez de esperar. */
  signal?: AbortSignal;
}

/**
 * Espera a que la página esté lista para capturar: fuentes resueltas e imágenes cargadas.
 *
 * Si algo expira se captura con lo que haya, pero AVISANDO: es mejor una lámina con la
 * fuente de fallback que ninguna lámina, y el silencio es exactamente lo que dejó pasar
 * meses de PNGs sin foto. El aviso es la única traza de que la lámina salió incompleta.
 */
async function waitForAssets(page: Page): Promise<void> {
  await page
    .waitForFunction(fontsReadyPredicate, { timeout: FONTS_READY_TIMEOUT_MS })
    .catch(() => {
      console.warn("[render] las fuentes no resolvieron a tiempo; capturo con el fallback");
    });
  await page
    .waitForFunction(imagesReadyPredicate, { timeout: IMAGES_READY_TIMEOUT_MS })
    .catch(() => {
      console.warn("[render] alguna imagen quedó en vuelo; la lámina puede salir sin ella");
    });
  // Los bytes ya llegaron; esto espera a que esté lista para PINTARSE.
  await page.evaluate(decodeImagesInPage).catch(() => {});
}

/**
 * URL del servicio de render. Seteada → el render sale por HTTP y Chrome NO se abre en
 * este proceso. Sin setear → render local con browser-pool.
 *
 * Es también el kill switch: vaciar el env var vuelve al render en proceso sin revertir
 * código. Y es lo que hace que el modo local de las diseñadoras (Windows, sin Docker)
 * siga funcionando igual que siempre.
 */
function renderServiceUrl(): string | undefined {
  const raw = process.env.RENDER_SERVICE_URL;
  return raw && raw.trim() ? raw.trim().replace(/\/+$/, "") : undefined;
}

/** Timeout por render. Generoso: cubre el cold start de Cloud Run (~5-10s) + el render. */
function renderTimeoutMs(): number {
  const raw = process.env.RENDER_SERVICE_TIMEOUT_MS;
  const n = raw ? parseInt(raw, 10) : 60_000;
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

const MAX_ATTEMPTS = 3;

/** Ya avisamos de una divergencia de contrato; no repetir en cada render. */
let contractMismatchWarned = false;

/** ID token cacheado por audiencia, con su vencimiento. */
const idTokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Pide un ID token a la metadata server de GCP para llamar al servicio de render.
 *
 * El servicio se deploya con `--no-allow-unauthenticated`, así que Cloud Run valida este
 * token ANTES de que la request llegue al contenedor. Es la barrera principal;
 * X-Internal-Token es la segunda.
 *
 * Fuera de GCP (la máquina de una diseñadora, o un servicio de render local) no hay
 * metadata server: devuelve undefined y se llama sin Authorization, que es correcto porque
 * un servicio local no exige IAM.
 *
 * Se cachea hasta 5 min antes del vencimiento: los tokens duran ~1h y pedir uno por render
 * (30-70 por carrusel) sería una llamada de red al metadata server por lámina.
 */
async function gcpIdToken(audience: string): Promise<string | undefined> {
  const cached = idTokenCache.get(audience);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  try {
    const res = await fetch(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3_000) }
    );
    if (!res.ok) return undefined;
    const token = (await res.text()).trim();
    if (!token) return undefined;

    // Vencimiento real del JWT, menos 5 min de colchón. Si no se puede leer, 45 min.
    let ttlMs = 45 * 60_000;
    const payload = token.split(".")[1];
    if (payload) {
      try {
        const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
        if (typeof exp === "number") ttlMs = Math.max(60_000, exp * 1000 - Date.now() - 300_000);
      } catch {
        /* JWT raro: nos quedamos con el default */
      }
    }
    idTokenCache.set(audience, { token, expiresAt: Date.now() + ttlMs });
    return token;
  } catch {
    // No estamos en GCP (modo local): sin IAM, y está bien.
    return undefined;
  }
}

/**
 * Pide un render al servicio.
 *
 * Reintenta SOLO ante fallos de conexión y 503 (una instancia de Cloud Run escalando o
 * reciclándose). Un 4xx/500 NO se reintenta: significa que el HTML o el input están mal, y
 * reintentar tres veces el mismo payload roto solo demora el error real.
 *
 * No hay fallback a render local a propósito: reintroduciría Chrome en la instancia de la
 * app justo cuando algo ya está mal. El fallo se propaga, y la ruta de review lo maneja
 * con gracia (devuelve los hallazgos estáticos con `errorRender`).
 */
async function renderRemote(
  base: string,
  input: RenderInput & { format: "png" | "pdf" },
  opts: RenderOptions
): Promise<Buffer> {
  const token = process.env.INTERNAL_API_TOKEN;
  const idToken = await gcpIdToken(base);
  const body = JSON.stringify(input);
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Un AbortSignal propio para el timeout, combinado con el del llamador (preempción).
    const timeout = AbortSignal.timeout(renderTimeoutMs());
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    try {
      const res = await fetch(`${base}/render`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          ...(token ? { "X-Internal-Token": token } : {}),
        },
        body,
        signal,
      });

      if (res.ok) {
        // Deploy a medias: la app y el servicio con distinta versión del contrato
        // renderizan distinto. No se corta el render (sería peor), pero se avisa fuerte.
        const remote = res.headers.get("X-Contract-Version");
        if (remote && Number(remote) !== CONTRACT_VERSION && !contractMismatchWarned) {
          contractMismatchWarned = true;
          console.warn(
            `[render] DIVERGENCIA DE CONTRATO: la app usa v${CONTRACT_VERSION} y el servicio de render v${remote}. ` +
              `Redesplegá las dos partes — el render puede no coincidir con el preview.`
          );
        }
        return Buffer.from(await res.arrayBuffer());
      }

      const detail = await res.text().catch(() => "");
      lastErr = new Error(`servicio de render devolvió ${res.status}: ${detail.slice(0, 300)}`);
      // Solo 503 es transitorio (instancia escalando). El resto es determinista.
      if (res.status !== 503) throw lastErr;
    } catch (e) {
      const err = e as Error;
      // Si lo canceló el llamador (preempción), no reintentar: es intencional.
      if (opts.signal?.aborted) throw new Error("Render cancelado");
      lastErr = err;
      // Un error no-transitorio ya lanzado arriba no debe reintentarse.
      if (/devolvió (4\d\d|500)/.test(err.message)) throw err;
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }

  throw new Error(
    `No se pudo renderizar en el servicio de render (${MAX_ATTEMPTS} intentos): ${lastErr?.message ?? "error desconocido"}`
  );
}

/**
 * Precalienta el servicio de render (lanza Chrome sin renderizar nada).
 *
 * Con `min-instances=0` el primer render de una ráfaga paga ~5-10s de cold start. Llamar
 * a esto al reclamar un job lo hace en paralelo con la ingesta, así no lo paga la primera
 * lámina. Best-effort: si falla, no pasa nada, el render lo reintenta.
 */
export async function warmupRenderer(): Promise<void> {
  const base = renderServiceUrl();
  if (!base) return;
  const token = process.env.INTERNAL_API_TOKEN;
  try {
    const idToken = await gcpIdToken(base);
    await fetch(`${base}/warmup`, {
      method: "POST",
      headers: {
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        ...(token ? { "X-Internal-Token": token } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Envuelve un render para medirlo y registrarlo.
 *
 * Va acá y no en cada call site porque este es el único punto por el que pasa TODO render
 * —local y remoto, PNG y PDF—, así que las métricas salen completas por construcción. Un
 * render cancelado por preempción no cuenta como fallo: no es un problema del render.
 */
async function medido(
  remoto: boolean,
  fn: () => Promise<Buffer>,
  opts: RenderOptions
): Promise<Buffer> {
  const t0 = Date.now();
  try {
    const buf = await fn();
    renderOk(Date.now() - t0, remoto, buf.length);
    return buf;
  } catch (e) {
    if (!opts.signal?.aborted) {
      renderFallo((e as Error).message || String(e), remoto, remoto ? MAX_ATTEMPTS : 1);
    }
    throw e;
  }
}

/** Rasteriza una lámina a PNG. */
export async function renderPng(input: RenderInput, opts: RenderOptions = {}): Promise<Buffer> {
  const base = renderServiceUrl();
  if (base) {
    return medido(true, () => renderRemote(base, { ...input, format: "png" }, opts), opts);
  }

  const { html, width, height, scale, transparent } = input;

  return medido(false, () => withPage(async (page) => {
    await page.setViewport({ width, height, deviceScaleFactor: scale });
    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: SET_CONTENT_TIMEOUT_PNG_MS,
    });
    await waitForAssets(page);

    if (transparent) await page.evaluate(stripBackgroundInPage);

    const shot = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width, height },
      // `captureBeyondViewport` arranca en true cuando hay `clip`, y esa ruta pasa por
      // Emulation, que es la que cuelga captureScreenshot en este combo Windows/Chromium.
      // El viewport es igual al clip, así que apagarlo es equivalente y confiable.
      captureBeyondViewport: false,
      omitBackground: transparent === true,
    });

    // sharp fuerza sRGB. Corre del lado del renderer a propósito: así el buffer crudo de
    // 2160×2700 nunca cruza el seam ni vive en la memoria de quien pide el render.
    return sharp(shot).toColorspace("srgb").png().toBuffer();
  }, opts), opts);
}

/**
 * Rasteriza un documento multi-lámina a PDF. El texto queda como TEXTO (`page.pdf()` no
 * rasteriza), así que Acrobat/Illustrator lo pueden re-editar.
 */
export async function renderPdf(input: RenderInput, opts: RenderOptions = {}): Promise<Buffer> {
  const base = renderServiceUrl();
  if (base) {
    return medido(true, () => renderRemote(base, { ...input, format: "pdf" }, opts), opts);
  }

  const { html, width, height, scale } = input;

  return medido(false, () => withPage(async (page) => {
    await page.setViewport({ width, height, deviceScaleFactor: scale });
    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: SET_CONTENT_TIMEOUT_PDF_MS,
    });
    await waitForAssets(page);

    const pdf = await page.pdf({
      width: `${width}px`,
      height: `${height}px`,
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
      preferCSSPageSize: false,
    });
    return Buffer.from(pdf);
  }, opts), opts);
}
