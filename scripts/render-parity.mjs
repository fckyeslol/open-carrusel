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

async function renderRemote() {
  const res = await fetch(`${SERVICE}/render`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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

async function main() {
  const health = await fetch(`${SERVICE}/healthz`).then((r) => r.json());
  console.log(`contrato — app v${CONTRACT_VERSION} · servicio v${health.contractVersion}`);
  if (health.contractVersion !== CONTRACT_VERSION) {
    console.error(
      `\nDIVERGENCIA DE CONTRATO. Redesplegá las dos partes antes de confiar en la paridad.`
    );
    process.exitCode = 2;
    return;
  }

  console.log("renderizando el fixture en los dos lados...");
  const [local, remote] = await Promise.all([renderLocal(), renderRemote()]);

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

  console.error(`\nDIVERGENCIA: ${distintos} de ${total} píxeles (${pct}%)`);
  console.error(`  ${fLocal}`);
  console.error(`  ${fRemote}`);
  console.error(
    total === -1
      ? "\nLas dimensiones no coinciden — revisá width/height/scale."
      : distintos / total > 0.01
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
