/**
 * Modo hosteado: la app corre en un servidor central y varias diseñadoras se
 * conectan por navegador, cada una autenticada y con SU token de Claude
 * (generado con `claude setup-token` desde su seat del plan Team).
 *
 * Con HOSTED_MODE apagado (default) NADA de esto aplica: la app se comporta
 * exactamente como hoy en localhost — sin login, sin tokens, sin middleware.
 * Eso mantiene intacto el flujo actual de las diseñadoras con repo local
 * mientras migramos.
 */
import { nextCentralToken } from "./claude-tokens";

export function isHostedMode(): boolean {
  return process.env.HOSTED_MODE === "1" || process.env.HOSTED_MODE === "true";
}

/**
 * Secreto raíz del modo hosteado. De acá se derivan (vía HKDF, ver
 * token-crypto.ts) las claves de firma de sesión y de cifrado de tokens.
 * Obligatorio en modo hosteado; mínimo 32 caracteres.
 */
export function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "AUTH_SECRET no configurado (mínimo 32 caracteres). En modo hosteado es obligatorio — generalo con: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\""
    );
  }
  return secret;
}

/**
 * Token central de Claude: un `claude setup-token` de la cuenta Team dueña del
 * despliegue, que paga TODO el consumo hosteado cuando se centraliza en un solo
 * seat en vez de pedirle a cada usuaria el suyo. Lo usan:
 *   - la cola 30x (worker sin usuaria logueada) — siempre, si está seteado;
 *   - el editor interactivo (/api/chat) — como FALLBACK cuando la usuaria no
 *     conectó su propio token.
 *
 * Preferimos CLAUDE_TEAM_OAUTH_TOKEN (nombre nuevo, describe qué hace) pero
 * aceptamos CLAUDE_RUNNER_OAUTH_TOKEN por compatibilidad con los deploys que ya
 * lo tienen seteado (secrets de GCP, .env.hosted existentes). Devuelve null si
 * ninguno está: en ese caso cada usuaria sigue necesitando su token propio.
 *
 * Se pueden configurar VARIAS cuentas (ver claude-tokens.ts): esta función
 * devuelve la próxima cuenta DISPONIBLE (salta las que están en cooldown por haber
 * llegado a su límite). El fallback dentro de una misma generación lo maneja
 * `spawnClaudeWithCentralFallback`.
 */
export function getCentralClaudeToken(): string | null {
  return nextCentralToken();
}

/**
 * Token interno para que el SUBPROCESO de Claude (que corre en el mismo server
 * y le pega a la API por loopback) pase el middleware de auth sin cookie de
 * sesión. Se inyecta como instrucción en el system prompt en modo hosteado.
 */
export function getInternalApiToken(): string {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token || token.length < 24) {
    throw new Error(
      "INTERNAL_API_TOKEN no configurado (mínimo 24 caracteres). En modo hosteado es obligatorio."
    );
  }
  return token;
}

/** Header que el subproceso agrega a cada request loopback contra la API. */
export const INTERNAL_TOKEN_HEADER = "x-internal-token";

/** Nombre de la cookie de sesión. */
export const SESSION_COOKIE = "oc_session";
