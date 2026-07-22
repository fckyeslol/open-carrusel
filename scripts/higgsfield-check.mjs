#!/usr/bin/env node
/**
 * Valida la integración con Higgsfield end-to-end SIN levantar la app.
 *
 *   node scripts/higgsfield-check.mjs            → chequea credenciales y hace
 *                                                  un smoke test (genera 1 imagen)
 *   node scripts/higgsfield-check.mjs --dry      → solo chequea credenciales
 *
 * Lee HF_API_KEY / HF_API_SECRET de .env.local (o del entorno). Útil para
 * confirmar que las claves andan y ver el costo/latencia real antes de usarlo
 * desde el chat.
 */
import fs from "node:fs";
import path from "node:path";

// --- Cargar .env.local a mano (sin dependencias) ---
function loadEnv() {
  const file = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (process.env[key]) continue; // el entorno gana
    const val = rawVal.replace(/^["']|["']$/g, "");
    if (val) process.env[key] = val;
  }
}

loadEnv();

const configured = Boolean(
  (process.env.HF_API_KEY && process.env.HF_API_SECRET) ||
    process.env.HF_CREDENTIALS ||
    process.env.HF_KEY
);

if (!configured) {
  console.error("✗ Higgsfield NO está configurado.");
  console.error("  Agregá HF_API_KEY y HF_API_SECRET en .env.local");
  console.error("  (claves en https://cloud.higgsfield.ai/api-keys).");
  process.exit(1);
}
console.log("✓ Credenciales presentes en el entorno.");

if (process.argv.includes("--dry")) {
  console.log("  (--dry: no se generó ninguna imagen).");
  process.exit(0);
}

// --- Smoke test: generar 1 imagen ---
const { HiggsfieldClient, SoulQuality, SoulSize, BatchSize, seed } =
  await import("@higgsfield/client");

const client = new HiggsfieldClient({
  apiKey: process.env.HF_API_KEY,
  apiSecret: process.env.HF_API_SECRET,
});

const prompt =
  "minimal abstract editorial background, soft studio gradient, muted tones, no text";
console.log(`\n▸ Generando imagen de prueba…`);
console.log(`  prompt: "${prompt}"`);

const t0 = Date.now();
try {
  const jobSet = await client.generate(
    "/v1/text2image/soul",
    {
      prompt,
      width_and_height: SoulSize.PORTRAIT_1536x2048,
      quality: SoulQuality.HD,
      batch_size: BatchSize.SINGLE,
      seed: seed(null),
    },
    { withPolling: true }
  );

  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (jobSet.isNsfw) {
    console.error(`✗ El resultado fue marcado NSFW (raro para este prompt).`);
    process.exit(1);
  }
  if (!jobSet.isCompleted) {
    console.error(`✗ La generación no se completó (estado inesperado).`);
    process.exit(1);
  }

  const url = jobSet.jobs.find((j) => j.results?.raw?.url)?.results?.raw?.url;
  console.log(`\n✓ Imagen generada en ${secs}s.`);
  console.log(`  URL: ${url}`);
  console.log(`\nLa integración funciona end-to-end. 🎉`);
  process.exit(0);
} catch (err) {
  const name = err?.name || "Error";
  console.error(`\n✗ Falló la generación [${name}]: ${err?.message || err}`);
  if (name === "AuthenticationError") {
    console.error("  → Revisá que HF_API_KEY / HF_API_SECRET sean correctas.");
  } else if (name === "NotEnoughCreditsError") {
    console.error("  → La cuenta no tiene créditos suficientes.");
  }
  process.exit(1);
}
