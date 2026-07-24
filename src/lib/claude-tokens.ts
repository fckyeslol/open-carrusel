/**
 * Pool de tokens centrales de Claude (modo hosteado) + fallback por límite.
 *
 * Antes había UN solo token central (la cuenta Team/Max dueña del despliegue que
 * paga la cola y el fallback del editor). Problema: cuando ESA cuenta llega a su
 * límite de uso, TODO el modo hosteado se cae hasta que resetea la ventana. Este
 * módulo permite configurar VARIAS cuentas: cuando una hitea el límite se marca
 * en cooldown y el sistema rota a la siguiente sola.
 *
 * Config (cualquiera de estas formas, se combinan y de-duplican en orden):
 *   - CLAUDE_TEAM_OAUTH_TOKEN            → un token, o varios separados por coma/espacio/línea
 *   - CLAUDE_TEAM_OAUTH_TOKEN_1..N       → numerados (una cuenta por variable)
 *   - CLAUDE_RUNNER_OAUTH_TOKEN(_1..N)   → nombres legacy, mismo tratamiento
 *   - CLAUDE_TOKEN_COOLDOWN_MIN          → minutos de cooldown al hitear límite (default 300 = 5h)
 *
 * El estado de cooldown vive en memoria del proceso (sobrevive al HMR de dev vía
 * globalThis). No se persiste a disco a propósito: al reiniciar el server se
 * reevalúan todas las cuentas desde cero, que es el comportamiento correcto.
 *
 * NUNCA se loguea el token en claro: para logs/paths usamos `tokenLabel()`, un
 * hash corto estable.
 */
import path from "path";
import { mkdirSync } from "fs";
import crypto from "crypto";

/** Ventana de uso de Max/Team resetea ~5h; ese es el cooldown por defecto. */
const DEFAULT_COOLDOWN_MS = 5 * 60 * 60 * 1000;
/** Tope de variables numeradas que escaneamos (CLAUDE_TEAM_OAUTH_TOKEN_1..N). */
const MAX_NUMBERED = 20;

function cooldownMs(): number {
  const raw = process.env.CLAUDE_TOKEN_COOLDOWN_MIN;
  const min = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(min) && min > 0) return min * 60 * 1000;
  return DEFAULT_COOLDOWN_MS;
}

/**
 * Etiqueta estable y NO reversible de un token, para logs y nombres de carpeta.
 * Nunca exponemos el token en claro.
 */
export function tokenLabel(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/** Parte una var de entorno con posibles múltiples tokens (coma/espacio/línea). */
function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Lista ordenada y de-duplicada de TODOS los tokens centrales configurados.
 * El orden importa: es el orden en que se intentan (la primera es la primaria).
 */
export function getCentralClaudeTokens(): string[] {
  const tokens: string[] = [];
  tokens.push(...splitList(process.env.CLAUDE_TEAM_OAUTH_TOKEN));
  for (let i = 1; i <= MAX_NUMBERED; i++) {
    tokens.push(...splitList(process.env[`CLAUDE_TEAM_OAUTH_TOKEN_${i}`]));
  }
  tokens.push(...splitList(process.env.CLAUDE_RUNNER_OAUTH_TOKEN));
  for (let i = 1; i <= MAX_NUMBERED; i++) {
    tokens.push(...splitList(process.env[`CLAUDE_RUNNER_OAUTH_TOKEN_${i}`]));
  }
  return [...new Set(tokens)];
}

interface CooldownState {
  map: Map<string, number>;
}

const g = globalThis as unknown as { __claudeTokenCooldown?: CooldownState };

function cooldown(): CooldownState {
  if (!g.__claudeTokenCooldown) g.__claudeTokenCooldown = { map: new Map() };
  return g.__claudeTokenCooldown;
}

/** ¿Este token está en cooldown ahora mismo (llegó a su límite hace poco)? */
export function isTokenCoolingDown(token: string, now = Date.now()): boolean {
  const until = cooldown().map.get(tokenLabel(token));
  return until !== undefined && until > now;
}

/** Marca un token como agotado (hiteó el límite): entra en cooldown. */
export function markTokenExhausted(token: string): void {
  const until = Date.now() + cooldownMs();
  cooldown().map.set(tokenLabel(token), until);
  console.warn(
    `[claude-tokens] cuenta ${tokenLabel(token)} llegó al límite; en cooldown hasta ${new Date(
      until
    ).toISOString()}`
  );
}

/** Tokens disponibles AHORA (no en cooldown), en orden de preferencia. */
export function availableCentralTokens(now = Date.now()): string[] {
  return getCentralClaudeTokens().filter((t) => !isTokenCoolingDown(t, now));
}

/**
 * El próximo token central a usar: el primero disponible. Si TODOS están en
 * cooldown, devuelve el que resetea antes (mejor intentar que fallar en seco —
 * puede que la ventana ya haya reseteado y el cooldown esté siendo conservador).
 * Devuelve null solo si no hay ningún token central configurado.
 */
export function nextCentralToken(): string | null {
  const all = getCentralClaudeTokens();
  if (all.length === 0) return null;
  const available = availableCentralTokens();
  if (available.length > 0) return available[0];
  const map = cooldown().map;
  return [...all].sort(
    (a, b) => (map.get(tokenLabel(a)) ?? 0) - (map.get(tokenLabel(b)) ?? 0)
  )[0];
}

/**
 * Orden en que un runner debe intentar los tokens en UNA operación con fallback.
 * Pone `preferred` (el token que venía usando esta operación, p. ej. para --resume)
 * primero SI sigue disponible; luego el resto de disponibles. Si no hay ninguno
 * disponible, cae al `nextCentralToken()` (soonest-reset).
 */
export function tokenTryOrder(preferred?: string): string[] {
  const available = availableCentralTokens();
  let order = available.length
    ? available
    : (() => {
        const next = nextCentralToken();
        return next ? [next] : [];
      })();
  if (preferred && order.includes(preferred)) {
    order = [preferred, ...order.filter((t) => t !== preferred)];
  }
  return order;
}

/**
 * Carpeta de config aislada POR token. Cada cuenta necesita su propio
 * CLAUDE_CONFIG_DIR: si dos tokens compartieran carpeta, las credenciales
 * cacheadas de la primera cuenta podrían pisar el token que inyectamos por env
 * para la segunda (el CLI prefiere credenciales guardadas sobre el env). Base
 * configurable (CLAUDE_CONFIG_BASE) para apuntar a disco local efímero en Cloud Run.
 */
export function configDirForToken(token: string, scope: string): string {
  const configBase =
    process.env.CLAUDE_CONFIG_BASE || path.resolve(process.cwd(), "data", "claude-config");
  const dir = path.join(configBase, `_${scope}_${tokenLabel(token)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
