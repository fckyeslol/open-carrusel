/**
 * UN solo Chrome por proceso, con tope de páginas concurrentes.
 *
 * Antes había tres dueños de Chrome y ninguno se coordinaba: el singleton de render
 * (export-slides.ts), un launch nuevo por cada ingesta de Instagram (instagram.ts) y
 * el detector de calidad. Con 4 jobs en paralelo eso eran ~5 Chrome vivos a la vez, y
 * de ahí venía el problema de memoria.
 *
 * Tres bugs concretos que arregla, además de unificar:
 *
 *  1. CARRERA EN EL LAUNCH. El código anterior guardaba el `Browser`, así que dos
 *     llamadas concurrentes con `browser === null` hacían DOS `puppeteer.launch()` y la
 *     segunda pisaba el handle de la primera: un Chrome huérfano que nadie cerraba
 *     nunca. Acá se guarda la PROMESA del launch, así que todos esperan el mismo.
 *
 *  2. HUÉRFANO EN SHUTDOWN. No había ningún handler, así que cada redeploy de Cloud Run
 *     dejaba Chrome colgado. Ver `hookShutdown` — el detalle de las señales importa.
 *
 *  3. RECICLADO QUE NO CONTABA. `MAX_EXPORTS_BEFORE_RESTART` solo se incrementaba tras
 *     un screenshot EXITOSO y `exportPdf` no lo tocaba nunca. Acá se cuenta toda página
 *     abierta, y el reciclado solo ocurre con 0 páginas activas (antes podía cerrar el
 *     browser abajo de un render en vuelo).
 *
 * El registro vive en `globalThis`, NO en el scope del módulo, por el mismo motivo que
 * documenta src/lib/data.ts para sus mutexes: una instancia duplicada del módulo (HMR de
 * dev, bundles distintos por ruta) tendría su propio Chrome y el tope no serviría.
 *
 * En modo hosteado esto casi no se usa: el render sale por HTTP al servicio aparte (ver
 * src/lib/render.ts). Sigue siendo el camino de las máquinas de las diseñadoras, que
 * corren la app local sin Docker, y el de la ingesta de Instagram siempre.
 */
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer";
import { existsSync } from "fs";

/**
 * Cuántas páginas de Chrome pueden estar abiertas a la vez. Default 1: un render a
 * 2160×2700 es caro, y `exportAllSlides` ya documentaba que capturas concurrentes en un
 * mismo browser pueden deadlockear (el cuelgue de `Page.captureScreenshot` en Windows).
 */
const DEFAULT_MAX_PAGES = 1;

function maxPages(): number {
  const raw = process.env.BROWSER_MAX_PAGES;
  const n = raw ? parseInt(raw, 10) : DEFAULT_MAX_PAGES;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_PAGES;
  return n;
}

/** Páginas tras las cuales se recicla Chrome (fuga lenta de Chromium en procesos largos). */
const MAX_PAGES_BEFORE_RECYCLE = 50;

/**
 * Tras cuánto tiempo sin usarse se cierra Chrome. Libera ~150-300 MB cuando nadie está
 * generando, que en una instancia de 4Gi compartida con un subproceso Claude importa.
 * El costo es un launch (~1s) en el próximo render.
 */
const IDLE_CLOSE_MS = 5 * 60_000;

/**
 * `protocolTimeout` del launch. Se toma el mayor de los dos valores que había antes
 * (120s del render, 60s de Instagram) porque ahora un mismo Chrome sirve a los dos. No
 * afloja nada real: las operaciones de Instagram tienen sus propios timeouts explícitos
 * (`page.goto` a 30s, etc.).
 */
const PROTOCOL_TIMEOUT_MS = 120_000;

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

interface Pool {
  /** La PROMESA del launch en curso — no el Browser. Ver bug 1 en el encabezado. */
  launching: Promise<Browser> | null;
  browser: Browser | null;
  pagesOpened: number;
  activePages: number;
  waiters: Waiter[];
  idleTimer: ReturnType<typeof setTimeout> | null;
  shutdownHooked: boolean;
}

const g = globalThis as unknown as { __ocBrowserPool?: Pool };

function pool(): Pool {
  if (!g.__ocBrowserPool) {
    g.__ocBrowserPool = {
      launching: null,
      browser: null,
      pagesOpened: 0,
      activePages: 0,
      waiters: [],
      idleTimer: null,
      shutdownHooked: false,
    };
  }
  return g.__ocBrowserPool;
}

/**
 * Busca un Chrome/Edge del sistema en vez del Chromium que trae Puppeteer.
 *
 * En algunas instalaciones de Windows el Chromium bundleado se cuelga en
 * `Page.captureScreenshot`; el Chrome completo renderiza confiable. Se sobreescribe con
 * PUPPETEER_EXECUTABLE_PATH. Devolver `undefined` deja que Puppeteer use el bundleado.
 *
 * Esta era la tercera copia de la misma función (estaba en export-slides.ts, en
 * instagram.ts y en scripts/render-test.mjs — y esa última ignoraba el env var).
 */
export function findChrome(): string | undefined {
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

/**
 * Mata el proceso de Chrome de forma SÍNCRONA. Es lo único que se puede hacer desde un
 * handler de señal o de `exit`, donde no hay chance de esperar un `await`.
 */
function killChromeSync(): void {
  const p = pool();
  const proc = p.browser?.process();
  p.browser = null;
  p.launching = null;
  try {
    proc?.kill("SIGKILL");
  } catch {
    /* ya muerto */
  }
}

/**
 * Registra el cierre de Chrome al terminar el proceso.
 *
 * ⚠️ El detalle de las señales no es cosmético: en Node, agregar un listener de SIGTERM
 * REEMPLAZA la terminación por defecto. Un handler ingenuo dejaría el proceso colgado en
 * cada redeploy de Cloud Run — peor que el bug que vinimos a arreglar. Por eso el handler
 * hace su limpieza síncrona, se DESREGISTRA y REENVÍA la señal, para que el
 * comportamiento por defecto (o el handler de Next) siga su curso.
 *
 * `exit` no cubre este caso: no se emite cuando el proceso muere por una señal con
 * manejo por defecto.
 */
function hookShutdown(): void {
  const p = pool();
  if (p.shutdownHooked) return;
  p.shutdownHooked = true;

  const onSignal = (sig: NodeJS.Signals) => {
    killChromeSync();
    process.removeListener(sig, onSignal);
    process.kill(process.pid, sig);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  // Salida normal (process.exit, event loop vacío): red de seguridad síncrona.
  process.on("exit", killChromeSync);
}

function clearIdleTimer(): void {
  const p = pool();
  if (p.idleTimer) {
    clearTimeout(p.idleTimer);
    p.idleTimer = null;
  }
}

/** Programa el cierre por inactividad. Solo corre si sigue sin haber trabajo. */
function scheduleIdleClose(): void {
  const p = pool();
  clearIdleTimer();
  if (!p.browser) return;
  p.idleTimer = setTimeout(() => {
    const cur = pool();
    cur.idleTimer = null;
    if (cur.activePages === 0 && cur.waiters.length === 0) void closeBrowser();
  }, IDLE_CLOSE_MS);
  // No mantener vivo el proceso solo por este timer.
  p.idleTimer.unref?.();
}

async function launch(): Promise<Browser> {
  const executablePath = findChrome();
  return puppeteer.launch({
    headless: true,
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      // /dev/shm es chico en contenedores; sin esto Chrome crashea o infla memoria.
      // Faltaba en los cinco launch sites que había.
      "--disable-dev-shm-usage",
    ],
  });
}

/**
 * Devuelve el Chrome del proceso, lanzándolo si hace falta. Interno: el acceso público
 * es `withPage` / `withContext`, que además respetan el tope de páginas.
 */
async function getBrowser(): Promise<Browser> {
  const p = pool();
  hookShutdown();
  clearIdleTimer();

  if (p.browser?.isConnected()) return p.browser;
  // Chrome murió por su cuenta (crash, OOM): el handle viejo no sirve.
  if (p.browser) p.browser = null;

  // Bug 1: guardar la promesa, no el browser. Los concurrentes esperan este mismo launch.
  if (!p.launching) {
    p.launching = launch()
      .then((b) => {
        p.browser = b;
        p.pagesOpened = 0;
        // Si Chrome se cae solo, no dejar un handle muerto en el registro.
        b.on("disconnected", () => {
          const cur = pool();
          if (cur.browser === b) cur.browser = null;
        });
        return b;
      })
      .finally(() => {
        p.launching = null;
      });
  }
  return p.launching;
}

/** Cierra Chrome si no hay páginas activas. Idempotente. */
export async function closeBrowser(): Promise<void> {
  const p = pool();
  clearIdleTimer();
  const b = p.browser;
  if (!b) return;
  p.browser = null;
  p.pagesOpened = 0;
  await b.close().catch(() => {});
}

/** Toma un permiso del semáforo de páginas. FIFO, y cancelable por `signal`. */
function acquire(signal?: AbortSignal): Promise<void> {
  const p = pool();
  if (signal?.aborted) return Promise.reject(new Error("Render cancelado"));

  if (p.activePages < maxPages()) {
    p.activePages++;
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      resolve: () => {
        p.activePages++;
        resolve();
      },
      reject,
      cleanup: () => signal?.removeEventListener("abort", onAbort),
    };
    function onAbort() {
      const i = p.waiters.indexOf(waiter);
      if (i >= 0) p.waiters.splice(i, 1);
      waiter.cleanup();
      reject(new Error("Render cancelado"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    p.waiters.push(waiter);
  });
}

/** Devuelve un permiso y le da el turno al siguiente en la fila. */
function release(): void {
  const p = pool();
  p.activePages = Math.max(0, p.activePages - 1);
  const next = p.waiters.shift();
  if (next) {
    next.cleanup();
    next.resolve();
    return;
  }
  if (p.activePages === 0) scheduleIdleClose();
}

/**
 * Recicla Chrome si ya abrió demasiadas páginas. Solo con 0 páginas activas: el código
 * anterior podía cerrar el browser abajo de un render en vuelo.
 */
async function recycleIfNeeded(): Promise<void> {
  const p = pool();
  if (p.activePages === 1 && p.pagesOpened >= MAX_PAGES_BEFORE_RECYCLE) {
    // activePages === 1 es el permiso de ESTE llamador, todavía sin página abierta.
    await closeBrowser();
  }
}

/**
 * Corre `fn` con una página nueva, respetando el tope de concurrencia.
 *
 * La página se cierra y el permiso se libera SIEMPRE, incluso si `fn` explota. `signal`
 * permite que un job preemptado suelte su lugar en la fila en vez de seguir esperando.
 */
export async function withPage<T>(
  fn: (page: Page) => Promise<T>,
  opts: { signal?: AbortSignal } = {}
): Promise<T> {
  await acquire(opts.signal);
  let page: Page | null = null;
  try {
    await recycleIfNeeded();
    const browser = await getBrowser();
    page = await browser.newPage();
    pool().pagesOpened++;
    return await fn(page);
  } finally {
    if (page) await page.close().catch(() => {});
    release();
  }
}

/**
 * Corre `fn` con un contexto de navegación AISLADO (cookies y caché propios) y, si se
 * pasa, con su propio proxy.
 *
 * Es lo que necesita la ingesta de Instagram: el proxy residencial (IG_PROXY) y la
 * cookie de sesión deben aplicar SOLO a ella, no al render. Antes eso se conseguía
 * lanzando un Chrome aparte con `--proxy-server`; con el proxy por contexto se logra lo
 * mismo con un solo Chrome, y las imágenes siguen bajando fuera del proxy porque eso lo
 * hace un `fetch` de Node (ver downloadImageBytes).
 *
 * Cuenta como UN permiso aunque `fn` abra varias páginas dentro del contexto (la ingesta
 * abre dos), porque el trabajo es uno.
 */
export async function withContext<T>(
  fn: (context: BrowserContext) => Promise<T>,
  opts: { proxyServer?: string; signal?: AbortSignal } = {}
): Promise<T> {
  await acquire(opts.signal);
  let context: BrowserContext | null = null;
  try {
    await recycleIfNeeded();
    const browser = await getBrowser();
    context = await browser.createBrowserContext(
      opts.proxyServer ? { proxyServer: opts.proxyServer } : {}
    );
    pool().pagesOpened++;
    return await fn(context);
  } finally {
    if (context) await context.close().catch(() => {});
    release();
  }
}

/** Estado del pool, para diagnóstico y para los tests. */
export function poolStats(): {
  chromeUp: boolean;
  activePages: number;
  waiting: number;
  pagesOpened: number;
  maxPages: number;
} {
  const p = pool();
  return {
    chromeUp: !!p.browser?.isConnected(),
    activePages: p.activePages,
    waiting: p.waiters.length,
    pagesOpened: p.pagesOpened,
    maxPages: maxPages(),
  };
}
