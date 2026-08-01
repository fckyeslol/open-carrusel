/**
 * SERVICIO DE RENDER — Chrome vive acá, no en la app.
 *
 * Existe por memoria: la app corre en una instancia pineada a min=max=1 (la "DB" son
 * archivos JSON con lock por proceso) y ahí compiten Node, un subproceso Claude por
 * generación y Chrome. Chrome era el que hacía picos de cientos de MB por lámina a
 * 2160×2700. Acá tiene su propio contenedor y su propio límite.
 *
 * Es DELIBERADAMENTE TONTO: no conoce el dominio, no lee el store, no sabe qué es un
 * carrusel. Recibe un HTML autocontenido y devuelve bytes. Todo lo de dominio (armar el
 * HTML, inlinear fuentes e imágenes) se queda en la app — ver src/lib/render.ts.
 *
 * El ciclo de vida de Chrome lo maneja Cloud Run: `--concurrency=1` significa una request
 * por instancia, así que no hace falta semáforo, ni reaper por inactividad, ni reciclado
 * cada N páginas. Si Chrome se degrada, la instancia se recicla sola.
 *
 * Un solo Chrome por instancia igual, reutilizado entre requests: con concurrency=1 nunca
 * hay dos renders simultáneos, y relanzarlo por request costaría ~1s de más cada vez.
 */
import http from "http";
import puppeteer from "puppeteer";
import sharp from "sharp";
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

const PORT = parseInt(process.env.PORT || "8080", 10);
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || "";
/** Tope del payload. Una lámina con foto a sangre lleva la imagen en base64. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const PROTOCOL_TIMEOUT_MS = 120_000;

let browserPromise = null;

/** Un Chrome por instancia. Se guarda la PROMESA para que no haya doble launch. */
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: true,
        protocolTimeout: PROTOCOL_TIMEOUT_MS,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-gpu",
          // /dev/shm es chico en contenedores; sin esto Chrome crashea o infla memoria.
          "--disable-dev-shm-usage",
        ],
      })
      .then((b) => {
        // Si Chrome muere (OOM, crash), soltar el handle para relanzar en la próxima.
        b.on("disconnected", () => {
          browserPromise = null;
        });
        return b;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

async function withPage(fn) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Espera a que la página esté lista para capturar: fuentes resueltas e imágenes cargadas.
 * Si algo expira se captura igual, pero avisando — un PNG incompleto en silencio es el
 * fallo que este servicio ya tuvo (ver `imagesReadyPredicate` en el contrato).
 */
async function waitForAssets(page) {
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
  await page.evaluate(decodeImagesInPage).catch(() => {});
}

async function renderPng({ html, width, height, scale, transparent }) {
  return withPage(async (page) => {
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
      // Con `clip`, captureBeyondViewport arranca en true y esa ruta (Emulation) es la
      // que cuelga captureScreenshot en algunos Chromium. Viewport == clip acá.
      captureBeyondViewport: false,
      omitBackground: transparent === true,
    });

    return sharp(shot).toColorspace("srgb").png().toBuffer();
  });
}

async function renderPdf({ html, width, height, scale }) {
  return withPage(async (page) => {
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
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Payload demasiado grande (> ${MAX_BODY_BYTES} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": payload.length,
  });
  res.end(payload);
}

/**
 * Valida el input ANTES de tocar Chrome. Un `width` que no es número haría que
 * setViewport falle raro y el error real quedaría enterrado; mejor un 400 claro.
 */
function validate(input) {
  const errs = [];
  if (typeof input.html !== "string" || !input.html) errs.push("html debe ser un string no vacío");
  for (const k of ["width", "height"]) {
    if (!Number.isInteger(input[k]) || input[k] < 1 || input[k] > 10000) {
      errs.push(`${k} debe ser un entero entre 1 y 10000`);
    }
  }
  const scale = input.scale ?? 1;
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) errs.push("scale debe estar entre 1 y 4");
  if (input.format && !["png", "pdf"].includes(input.format)) errs.push('format debe ser "png" o "pdf"');
  return errs;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // ⚠️ `/_health` y NO `/healthz`: en Cloud Run `/healthz` está RESERVADO y lo intercepta la
  // infra de Google antes de llegar al contenedor. Verificado contra el servicio desplegado:
  // `/healthz` devuelve un 404 propio (sin el header `server: Google Frontend`), mientras que
  // `/health`, `/_health`, `/readyz`, `/status`, `/livez` y `/version` devuelven el 403 de IAM
  // que corresponde. No lo renombres a `/healthz`.
  if (url.pathname === "/_health" && req.method === "GET") {
    // contractVersion permite que el cliente detecte un deploy a medias (la app y el
    // servicio con versiones distintas del contrato renderizarían distinto en silencio).
    return json(res, 200, {
      ok: true,
      contractVersion: CONTRACT_VERSION,
      chromeUp: !!browserPromise,
    });
  }

  // Auth: el servicio corre con --ingress=internal, así que solo se alcanza desde el
  // proyecto; el token es la segunda barrera. Se compara en tiempo constante-ish.
  if (INTERNAL_TOKEN && req.headers["x-internal-token"] !== INTERNAL_TOKEN) {
    return json(res, 401, { error: "token interno inválido o ausente" });
  }

  if (url.pathname === "/warmup" && req.method === "POST") {
    try {
      await getBrowser();
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 503, { error: `no se pudo abrir Chrome: ${e.message}` });
    }
  }

  if (url.pathname === "/render" && req.method === "POST") {
    let input;
    try {
      input = JSON.parse((await readBody(req)).toString("utf-8"));
    } catch (e) {
      return json(res, 400, { error: `body inválido: ${e.message}` });
    }

    const errs = validate(input);
    if (errs.length) return json(res, 400, { error: errs.join("; ") });

    const format = input.format || "png";
    try {
      const buf =
        format === "pdf"
          ? await renderPdf({ ...input, scale: input.scale ?? 1 })
          : await renderPng({ ...input, scale: input.scale ?? 1 });
      res.writeHead(200, {
        "Content-Type": format === "pdf" ? "application/pdf" : "image/png",
        "Content-Length": buf.length,
        "X-Contract-Version": String(CONTRACT_VERSION),
      });
      return res.end(buf);
    } catch (e) {
      // 500 y no 503: un fallo de render es del contenido, no de capacidad. El cliente
      // solo reintenta 503/conexión, así que un HTML roto no se reintenta 3 veces.
      console.error("[render] falló:", e?.message);
      return json(res, 500, { error: `render falló: ${e?.message || e}` });
    }
  }

  return json(res, 404, { error: "ruta desconocida" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[render-service] escuchando en :${PORT} (contrato v${CONTRACT_VERSION})`);
});

/**
 * Cierre limpio. Ojo: agregar un listener de SIGTERM REEMPLAZA la terminación por
 * defecto de Node, así que hay que salir a mano o Cloud Run se queda esperando el
 * tiempo de gracia completo en cada redeploy.
 */
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close();
    const kill = async () => {
      try {
        const b = browserPromise ? await browserPromise : null;
        await b?.close();
      } catch {
        /* ya muerto */
      }
      process.exit(0);
    };
    void kill();
  });
}
