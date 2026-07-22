#!/usr/bin/env node
// Verifica la conexión con Prewave para el modelo local: lee PREWAVE_TOKEN de
// .env.local (o del entorno) y pega a GET /production/design-queue. Distingue los
// fallos típicos (token vencido vs endpoint no desplegado) para que el setup sea
// obvio. Uso: npm run prewave:check

import fs from "node:fs";
import path from "node:path";

function readEnvLocal() {
  const env = {};
  const p = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, "utf-8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  return env;
}

const env = readEnvLocal();
const token = process.env.PREWAVE_TOKEN || env.PREWAVE_TOKEN;
const base = (
  process.env.PREWAVE_API_BASE ||
  env.PREWAVE_API_BASE ||
  "https://api.prewave.oracle30x.co/api/v1"
).replace(/\/$/, "");

if (!token) {
  console.error("❌ Falta PREWAVE_TOKEN en .env.local. Pegá tu token de Prewave ahí y reintentá.");
  process.exit(1);
}

const url = `${base}/production/design-queue`;
console.log(`→ GET ${url}`);

try {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (res.status === 200 && body && Array.isArray(body.items)) {
    console.log(`✅ Conectado. ${body.items.length} carrusel(es) asignado(s) a vos por diseñar.`);
    for (const it of body.items.slice(0, 10)) {
      const ref =
        it.scored_post?.raw_post?.canonical_url ||
        it.scored_post?.raw_post?.post_url ||
        "(sin referente)";
      console.log(`   • ${it.avatar?.slug ?? "?"} — ${ref}`);
    }
    process.exit(0);
  }
  if (res.status === 401) {
    console.error("❌ 401: token inválido o vencido. Renová tu token de Prewave (dura 30 días).");
    process.exit(1);
  }
  if (res.status === 404) {
    console.error(
      "❌ 404: el endpoint /production/design-queue NO existe en el Prewave desplegado.\n" +
        "   ¿Ya se desplegó a producción (main)? Ver docs/GUIA-CARRUSELES-30X.md §3."
    );
    process.exit(1);
  }
  console.error(
    `❌ HTTP ${res.status}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`
  );
  process.exit(1);
} catch (e) {
  console.error("❌ Error de red al contactar Prewave:", e.message);
  process.exit(1);
}
