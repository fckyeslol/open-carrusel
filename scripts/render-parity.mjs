/**
 * PARIDAD DE RENDER — el entorno local vs el del servicio de render, byte a byte.
 *
 * Es el test más importante del servicio aparte, y ataca un fallo silencioso y caro: si la
 * imagen del servicio no tiene EXACTAMENTE las mismas fuentes que la app
 * (fonts-liberation, fonts-noto-core, fonts-noto-color-emoji), los textos caen a otro
 * fallback y los exports dejan de coincidir con el preview. Nadie se entera hasta que hay
 * láminas entregadas con la tipografía mal.
 *
 * QUÉ COMPARA: no una lámina real, sino un fixture diseñado para ser sensible al entorno
 * —familias genéricas (sans/serif/mono), una familia inexistente que fuerza el fallback del
 * sistema, acentos del español y emoji—. Una lámina real es peor test: sus fuentes viajan
 * inlineadas en base64 dentro del HTML, así que taparían justo la diferencia que buscamos.
 *
 * ⚠️ DÓNDE CORRERLO IMPORTA, y es fácil sacar la conclusión equivocada.
 *
 * El lado "local" es ESTA máquina. La pregunta que de verdad importa no es "¿mi máquina
 * coincide con el servicio?" sino "¿el contenedor del RENDER coincide con el de la APP?",
 * porque eso es lo que decide si los exports se siguen viendo igual que antes del cambio.
 *
 * Corrido desde Windows o macOS, una divergencia del 3-6% es NORMAL y no dice nada de
 * producción: son fuentes de sistema distintas (la monoespaciada genérica y los emoji son
 * los que más se notan). Por eso, fuera de Linux, este script informa la diferencia pero NO
 * la trata como fallo.
 *
 * Para el chequeo que sí es un gate, corré el fixture DENTRO de la imagen de la app y
 * comparalo contra el servicio — las dos son node:20-bookworm-slim con la misma lista de
 * paquetes de fuentes, así que ahí sí se espera igualdad byte a byte.
 *
 * Los dos lados renderizan el MISMO html con los MISMOS args de Chrome y el mismo
 * post-proceso de sharp, así que cualquier diferencia de bytes es diferencia de ENTORNO:
 * fuentes, versión de Chrome o versión de sharp.
 *
 * Uso:
 *   RENDER_SERVICE_URL=https://... node scripts/render-parity.mjs
 *
 * Exit 0 = paridad OK. Exit 2 = divergencia (mira .quality/parity/ para ver los dos PNG).
 */
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { createHash } from "crypto";
import puppeteer from "puppeteer";
import sharp from "sharp";
import {
  CONTRACT_VERSION,
  FONTS_READY_TIMEOUT_MS,
  SET_CONTENT_TIMEOUT_PNG_MS,
  fontsReadyPredicate,
} from "../src/lib/slide-render-contract.mjs";

const SERVICE = process.env.RENDER_SERVICE_URL?.replace(/\/+$/, "");
const TOKEN = process.env.INTERNAL_API_TOKEN;
const OUT_DIR = path.resolve(process.cwd(), ".quality", "parity");
const WIDTH = 1080;
const HEIGHT = 1350;
const SCALE = 2;

if (!SERVICE) {
  console.error("Falta RENDER_SERVICE_URL — sin servicio no hay nada que comparar.");
  process.exit(1);
}

/**
 * Fixture sensible al entorno. Cada bloque puede romper distinto:
 *  - familias genéricas: mapean a las fuentes del sistema (Liberation/Noto acá)
 *  - "NoExisteEstaFuente": fuerza la cadena de fallback completa
 *  - acentos y ñ: cobertura de glifos de la fuente elegida
 *  - emoji: depende de fonts-noto-color-emoji, que es fácil de olvidar en una imagen
 *  - pesos 300/700: si falta una variante, Chrome sintetiza y el raster cambia
 */
const FIXTURE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${WIDTH}px; height:${HEIGHT}px; background:#fff; }
  .b { padding:18px 28px; border-bottom:1px solid #eee; }
  .s  { font-family: sans-serif; font-size:44px; }
  .r  { font-family: serif; font-size:44px; }
  .m  { font-family: monospace; font-size:38px; }
  .fb { font-family: "NoExisteEstaFuente", "TampocoEsta"; font-size:44px; }
  .l  { font-family: sans-serif; font-weight:300; font-size:40px; }
  .h  { font-family: sans-serif; font-weight:700; font-size:40px; }
  .e  { font-size:56px; }
  .k  { font-family: sans-serif; font-size:34px; letter-spacing:-0.02em; }
</style></head><body>
  <div class="b s">Sans — Ñandú, ácido, güiro, ¿qué?</div>
  <div class="b r">Serif — Ñandú, ácido, güiro, ¡sí!</div>
  <div class="b m">Mono — 0O1lI |{}[]#@ 123</div>
  <div class="b fb">Fallback — texto sin fuente declarada</div>
  <div class="b l">Peso 300 — interlínea y métricas</div>
  <div class="b h">Peso 700 — interlínea y métricas</div>
  <div class="b e">Emoji — 🎯 📊 ✅ 🔥 💡</div>
  <div class="b k">Kerning apretado AVWA To. Ty. LT WA</div>
</body></html>`;

const PAYLOAD = {
  html: FIXTURE_HTML,
  width: WIDTH,
  height: HEIGHT,
  scale: SCALE,
  format: "png",
};

/** Mismo findChrome que browser-pool.ts / render-test.mjs. */
function findChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const local = process.env.LOCALAPPDATA || "";
  const cands =
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
  return cands.find((p) => p && existsSync(p));
}

async function renderLocal() {
  const exe = findChrome();
  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 120_000,
    ...(exe ? { executablePath: exe } : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE });
    await page.setContent(FIXTURE_HTML, {
      waitUntil: "domcontentloaded",
      timeout: SET_CONTENT_TIMEOUT_PNG_MS,
    });
    await page
      .waitForFunction(fontsReadyPredicate, { timeout: FONTS_READY_TIMEOUT_MS })
      .catch(() => {});
    const shot = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      captureBeyondViewport: false,
    });
    return sharp(shot).toColorspace("srgb").png().toBuffer();
  } finally {
    await browser.close().catch(() => {});
  }
}

async function renderRemote(auth) {
  const res = await fetch(`${SERVICE}/render`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...auth,
      ...(TOKEN ? { "X-Internal-Token": TOKEN } : {}),
    },
    body: JSON.stringify(PAYLOAD),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    throw new Error(`servicio devolvió ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const remoteVersion = res.headers.get("X-Contract-Version");
  return { buf: Buffer.from(await res.arrayBuffer()), remoteVersion };
}

/** Cuántos píxeles difieren, para distinguir "otra fuente" de "un pelo de antialiasing". */
async function diffPixels(a, b) {
  const [ra, rb] = await Promise.all([
    sharp(a).ensureAlpha().raw().toBuffer(),
    sharp(b).ensureAlpha().raw().toBuffer(),
  ]);
  if (ra.length !== rb.length) return { distintos: -1, total: -1 };
  let distintos = 0;
  for (let i = 0; i < ra.length; i += 4) {
    if (ra[i] !== rb[i] || ra[i + 1] !== rb[i + 1] || ra[i + 2] !== rb[i + 2]) distintos++;
  }
  return { distintos, total: ra.length / 4 };
}

const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

/**
 * Header `Authorization` para el servicio de render.
 *
 * El servicio se deploya con `--no-allow-unauthenticated`, así que Cloud Run exige un ID
 * token con el audience = la URL del servicio. Sin esto el script recibe 403 y no puede
 * comparar nada. En producción la app lo saca de la metadata server; desde una máquina se
 * saca con gcloud.
 *
 * Orden: RENDER_ID_TOKEN del env (útil en CI) → gcloud. Si no hay ninguno, se avisa con la
 * instrucción exacta en vez de fallar con un 403 pelado.
 */
/** ¿El destino es local? Entonces no hay IAM de Cloud Run en el medio. */
function esLocal() {
  try {
    const h = new URL(SERVICE).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

/**
 * Header `Authorization` para el servicio de render, o `null` si no se pudo conseguir.
 *
 * ⚠️ Con una cuenta de USUARIO no hay forma de emitir el token: `gcloud auth
 * print-identity-token --audiences=<url>` falla con "Invalid account type for
 * `--audiences`. Requires valid service account." Y sin `--audiences` el token sale con el
 * audience del client de gcloud, que Cloud Run rechaza. O sea: estar logueado con
 * `gcloud auth login` NO alcanza, y volver a loguearse tampoco cambia nada.
 *
 * Las tres vías que sí funcionan, en orden de practicidad:
 *
 *  1. `gcloud run services proxy` — levanta un proxy local que inyecta la auth con tus
 *     credenciales de usuario. Apuntás RENDER_SERVICE_URL a localhost y este script no
 *     manda ningún token (ver esLocal). Es la vía recomendada para una persona.
 *  2. Impersonar la service account, si tenés roles/iam.serviceAccountTokenCreator sobre
 *     ella (se intenta abajo).
 *  3. RENDER_ID_TOKEN en el env, para CI (ahí la identidad ya es una service account).
 */
async function bearer() {
  if (esLocal()) return {}; // proxy local o servicio local: sin IAM en el medio
  if (process.env.RENDER_ID_TOKEN) {
    return { Authorization: `Bearer ${process.env.RENDER_ID_TOKEN}` };
  }

  const { execFileSync } = await import("child_process");
  const cmd = process.platform === "win32" ? "gcloud.cmd" : "gcloud";
  // ⚠️ `shell: true` es OBLIGATORIO en Windows: desde la mitigación de CVE-2024-27980, Node
  // se NIEGA a ejecutar un .cmd/.bat con execFile sin shell y tira EINVAL. Sin esto, los dos
  // intentos de gcloud fallan al instante y parece "no hay credenciales" cuando en realidad
  // nunca se llegó a ejecutar gcloud. Los argumentos no llevan espacios, así que unirlos para
  // la shell es seguro acá.
  const run = (args) =>
    execFileSync(cmd, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    }).trim();

  // Los fallos se ACUMULAN y se reportan: tragárselos en silencio fue justo lo que escondió
  // el EINVAL de arriba durante la verificación en producción.
  const fallos = [];
  const intentar = (etiqueta, args) => {
    try {
      const t = run(args);
      const jwt = t.split(/\r?\n/).find((l) => l.startsWith("ey"));
      if (jwt) return jwt;
      fallos.push(`${etiqueta}: gcloud no devolvió un token`);
    } catch (e) {
      const detalle = (e.stderr || e.message || String(e)).trim().split(/\r?\n/)[0];
      fallos.push(`${etiqueta}: ${detalle}`);
    }
    return null;
  };

  // Directo (sirve si la credencial activa YA es una service account).
  const directo = intentar("directo", [
    "auth",
    "print-identity-token",
    `--audiences=${SERVICE}`,
  ]);
  if (directo) return { Authorization: `Bearer ${directo}` };

  // Impersonación de la service account de runtime.
  const sa = process.env.RENDER_IMPERSONATE_SA;
  if (sa) {
    const imp = intentar(`impersonando ${sa}`, [
      "auth",
      "print-identity-token",
      `--impersonate-service-account=${sa}`,
      `--audiences=${SERVICE}`,
      "--include-email",
    ]);
    if (imp) return { Authorization: `Bearer ${imp}` };
  } else {
    fallos.push("impersonación: RENDER_IMPERSONATE_SA no está seteada");
  }

  // null y NO {}: sin token el servicio devuelve una página HTML de 403 y seguir adelante
  // termina en "Unexpected token '<'", que esconde la causa real.
  bearer.fallos = fallos;
  return null;
}

/** Cómo alcanzar el servicio, en la sintaxis de la shell que corresponde. */
function comoAutenticarse() {
  const psh = process.platform === "win32";
  const set = (v) => (psh ? `$env:${v.split("=")[0]} = "${v.split("=").slice(1).join("=")}"` : v);
  return (
    `  A) Proxy local (recomendado). En OTRA terminal, dejá corriendo:\n` +
    `       gcloud run services proxy open-carrusel-render --region=us-east1 --port=8099\n` +
    `     y en esta:\n` +
    `       ${set("RENDER_SERVICE_URL=http://localhost:8099")}\n` +
    `       node scripts/render-parity.mjs\n\n` +
    `  B) Impersonando la service account (si tenés serviceAccountTokenCreator):\n` +
    `       ${set("RENDER_IMPERSONATE_SA=oc-runtime@prewave-prod.iam.gserviceaccount.com")}\n` +
    `       node scripts/render-parity.mjs\n`
  );
}

async function main() {
  // Se resuelve el token UNA vez y se corta acá si no hay: sin él, todo lo que sigue
  // devuelve HTML de 403 y el error real queda enterrado.
  const auth = await bearer();
  if (!auth) {
    console.error(
      `No se pudo obtener un ID token para\n  ${SERVICE}\n\n` +
        `El servicio de render exige auth de IAM (se deploya con --no-allow-unauthenticated),\n` +
        `así que sin token Cloud Run rechaza el request antes de que llegue al contenedor.\n\n` +
        `Qué se intentó:\n` +
        (bearer.fallos ?? []).map((f) => `  - ${f}\n`).join("") +
        `\nCorré esto:\n${comoAutenticarse()}`
    );
    process.exitCode = 1;
    return;
  }

  const headers = { ...auth, ...(TOKEN ? { "X-Internal-Token": TOKEN } : {}) };

  // `/_health`, no `/healthz`: ese path está reservado en Cloud Run (ver server.mjs).
  const healthRes = await fetch(`${SERVICE}/_health`, { headers });
  if (!healthRes.ok) {
    throw new Error(
      `/_health devolvió ${healthRes.status}. ${
        healthRes.status === 403
          ? "El token no es válido para este audience, o a la cuenta le falta roles/run.invoker."
          : (await healthRes.text()).slice(0, 200)
      }`
    );
  }
  const health = await healthRes.json();
  console.log(`contrato — app v${CONTRACT_VERSION} · servicio v${health.contractVersion}`);
  if (health.contractVersion !== CONTRACT_VERSION) {
    console.error(
      `\nDIVERGENCIA DE CONTRATO. Redesplegá las dos partes antes de confiar en la paridad.`
    );
    process.exitCode = 2;
    return;
  }

  console.log("renderizando el fixture en los dos lados...");
  const [local, remote] = await Promise.all([renderLocal(), renderRemote(headers)]);

  console.log(`  local  → ${local.length} bytes  sha=${sha(local)}`);
  console.log(`  remoto → ${remote.buf.length} bytes  sha=${sha(remote.buf)}`);

  if (local.equals(remote.buf)) {
    console.log("\nPARIDAD OK — bytes idénticos.");
    process.exitCode = 0;
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  const fLocal = path.join(OUT_DIR, "fixture-local.png");
  const fRemote = path.join(OUT_DIR, "fixture-remoto.png");
  await writeFile(fLocal, local);
  await writeFile(fRemote, remote.buf);

  const { distintos, total } = await diffPixels(local, remote.buf);
  const pct = total > 0 ? ((distintos / total) * 100).toFixed(2) : "?";

  console.log(`\nDIFERENCIA: ${distintos} de ${total} píxeles (${pct}%)`);
  console.log(`  ${fLocal}`);
  console.log(`  ${fRemote}`);

  if (total === -1) {
    console.error("\nLas dimensiones no coinciden — revisá width/height/scale.");
    process.exitCode = 2;
    return;
  }

  // Fuera de Linux, "local" no es el entorno de la app: la diferencia es esperable y no es
  // un fallo. Tratarla como fallo daba un falso negativo — el caso real que lo motivó: desde
  // Windows dio 4.93% solo porque la monoespaciada genérica y los emoji son otros.
  if (process.platform !== "linux") {
    console.log(
      `\nEsto NO es un fallo: estás en ${process.platform}, así que compararse contra un\n` +
        `contenedor Debian siempre difiere (la monoespaciada genérica y los emoji son los que\n` +
        `más se notan). Mirá los dos PNG: si Sans, Serif, el fallback y los pesos se ven\n` +
        `iguales, el entorno del servicio está bien.\n\n` +
        `El gate de verdad es imagen-de-app vs imagen-de-render, las dos Debian con la misma\n` +
        `lista de fuentes. Para correrlo así:\n` +
        `  docker build -t oc-app .\n` +
        `  docker run --rm -e RENDER_SERVICE_URL -e RENDER_ID_TOKEN -e INTERNAL_API_TOKEN \\\n` +
        `    oc-app node scripts/render-parity.mjs`
    );
    process.exitCode = 0;
    return;
  }

  console.error(
    distintos / total > 0.01
      ? "\nDiferencia grande: casi seguro FUENTES. Compará los paquetes de fuentes de\n" +
        "render-service/Dockerfile con los del Dockerfile de la app (deben ser idénticos)."
      : "\nDiferencia chica: probablemente versión de Chrome o de sharp. Compará las\n" +
        "versiones de render-service/package.json con las de package.json."
  );
  process.exitCode = 2;
}

// process.exit() con un fetch abierto aborta libuv en Windows: se usa exitCode.
main().catch((e) => {
  console.error(`\nFALLÓ: ${e.message}`);
  process.exitCode = 1;
});
