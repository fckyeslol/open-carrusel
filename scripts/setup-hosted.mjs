#!/usr/bin/env node
/**
 * Prepara el .env.hosted del modo hosteado en un solo paso:
 *   - genera AUTH_SECRET e INTERNAL_API_TOKEN (aleatorios, fuertes)
 *   - deja HOSTED_MODE=1
 *   - pide el dominio como argumento (o lo deja en blanco para completar a mano)
 *
 * Uso:
 *   node scripts/setup-hosted.mjs carruseles.30x.com
 *
 * NO pisa un .env.hosted existente (para no borrar secretos en uso): si ya
 * existe, avisa y sale. Borralo a mano si querés regenerarlo — OJO: cambiar
 * AUTH_SECRET obliga a TODAS las usuarias a volver a pegar su token.
 */
import { readFile, writeFile } from "fs/promises";
import { randomBytes } from "crypto";
import path from "path";

const ENV_PATH = path.resolve(process.cwd(), ".env.hosted");
const dominio = process.argv[2] || "";

async function existe(p) {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

if (await existe(ENV_PATH)) {
  console.error(
    "\n⚠  Ya existe .env.hosted — no lo toco para no borrar secretos en uso.\n" +
      "   Si de verdad querés regenerarlo, borralo a mano primero.\n"
  );
  process.exit(1);
}

const secreto = () => randomBytes(48).toString("base64url");

const contenido = `# Open Carrusel — modo hosteado. Generado por scripts/setup-hosted.mjs.
HOSTED_MODE=1

# Dominio público (lo usa Caddy para el certificado TLS).
DOMAIN=${dominio}

# Secreto raíz: firma sesiones y cifra los tokens de Claude en reposo.
# ⚠ Si lo cambiás, TODAS las usuarias tienen que volver a pegar su token.
AUTH_SECRET=${secreto()}

# Token interno con el que el subproceso de Claude le pega a la API por loopback.
INTERNAL_API_TOKEN=${secreto()}

# Opcional: token de worker para la cola 30x (jobs sin usuaria logueada).
# Un \`claude setup-token\` de la cuenta que deba pagar esas generaciones.
# CLAUDE_RUNNER_OAUTH_TOKEN=

# Opcional: presupuesto máximo por generación (default 8.00).
# CLAUDE_MAX_BUDGET_USD=8.00
`;

await writeFile(ENV_PATH, contenido, "utf-8");

console.log("\n✓ .env.hosted creado con secretos frescos.");
if (!dominio) {
  console.log("\n  ⚠ Falta el DOMAIN — editá .env.hosted y poné tu dominio público.");
  console.log("    (o corré de nuevo: node scripts/setup-hosted.mjs tu-dominio.com)");
}
console.log("\n  Siguiente paso:");
console.log("    docker compose -f docker-compose.hosted.yml up -d --build\n");
