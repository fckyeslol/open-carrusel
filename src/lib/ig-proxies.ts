/**
 * Pool de proxies residenciales para el scraping de Instagram + fallback por caída.
 *
 * Antes había UN solo proxy (`IG_PROXY`). Problema real, 2026-07-28: el proveedor
 * (Litport) empezó a rechazar todo CONNECT con `500 / X-Proxy-Error-Code: 2` y la
 * ingesta del referente se cayó entera en el hosteado — un proveedor caído dejaba sin
 * servicio a todo el flujo. Este módulo permite configurar VARIOS proxies: cuando uno
 * no abre el túnel se marca en cooldown y el sistema rota al siguiente solo.
 *
 * Config (las formas se combinan y de-duplican EN ORDEN; el primero es el primario):
 *   - IG_PROXY                  → un proxy, o varios separados por coma/espacio/línea
 *   - IG_PROXY_1..N             → numerados (uno por variable)
 *   - IG_PROXY_COOLDOWN_MIN     → minutos de cooldown al caerse (default 30)
 *
 * Formato de cada uno: `http://usuario:pass@host:puerto`.
 *
 * El último recurso NO vive acá: si todos los proxies fallan, la ingesta reintenta por
 * la IP directa (ver withProxyFallback en instagram.ts). Desde una IP residencial eso
 * alcanza solo; desde datacenter Instagram sirve el HTML recortado y cae en el guard
 * anti-basura, pero entonces el error nombra a los proxies caídos, que es la causa.
 *
 * El estado de cooldown vive en memoria del proceso (sobrevive al HMR de dev vía
 * globalThis), igual que en claude-tokens.ts: al reiniciar se reevalúa todo desde
 * cero, que es el comportamiento correcto para una caída de proveedor.
 *
 * NUNCA se loguean las credenciales: para logs se usa `label`, que es host:puerto más
 * un hash corto. El hash importa porque dos proxies del mismo proveedor comparten
 * host:puerto y se distinguen solo por usuario (es exactamente nuestro caso).
 */
import crypto from "crypto";

/** Cuánto se espera antes de volver a intentar un proxy que falló. */
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
/** Tope de variables numeradas que escaneamos (IG_PROXY_1..N). */
const MAX_NUMBERED = 20;

export interface ProxyConfig {
  /** http://host:puerto — SIN credenciales (Chrome no las acepta en --proxy-server). */
  server: string;
  username?: string;
  password?: string;
  /** Identificador seguro para logs y cooldown: host:puerto#hash. Sin credenciales. */
  label: string;
}

function cooldownMs(): number {
  const raw = process.env.IG_PROXY_COOLDOWN_MIN;
  const min = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(min) && min > 0) return min * 60 * 1000;
  return DEFAULT_COOLDOWN_MS;
}

/**
 * Parsea `http://user:pass@host:puerto`. Devuelve null si no es una URL válida, para
 * que un env mal escrito degrade a "sin proxy" en vez de reventar la ingesta.
 */
export function parseProxy(raw: string): ProxyConfig | null {
  try {
    const u = new URL(raw.trim());
    if (!u.hostname) return null;
    const server = `${u.protocol}//${u.host}`;
    // El hash distingue dos credenciales sobre el MISMO host:puerto (caso real: dos
    // usuarios del mismo proveedor). Es de la URL completa, así que no la revela.
    const hash = crypto.createHash("sha256").update(raw.trim()).digest("hex").slice(0, 6);
    return {
      server,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      label: `${u.host}#${hash}`,
    };
  } catch {
    return null;
  }
}

/** Parte una var de entorno con posibles múltiples proxies (coma/espacio/línea). */
function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Lista ordenada y de-duplicada de TODOS los proxies configurados.
 * El orden importa: es el orden en que se intentan (el primero es el primario).
 */
export function getInstagramProxies(): ProxyConfig[] {
  const raws: string[] = [];
  raws.push(...splitList(process.env.IG_PROXY));
  for (let i = 1; i <= MAX_NUMBERED; i++) {
    raws.push(...splitList(process.env[`IG_PROXY_${i}`]));
  }
  const seen = new Set<string>();
  const proxies: ProxyConfig[] = [];
  for (const raw of [...new Set(raws)]) {
    const parsed = parseProxy(raw);
    if (!parsed || seen.has(parsed.label)) continue;
    seen.add(parsed.label);
    proxies.push(parsed);
  }
  return proxies;
}

interface CooldownState {
  map: Map<string, number>;
}

const g = globalThis as unknown as { __igProxyCooldown?: CooldownState };

function cooldown(): CooldownState {
  if (!g.__igProxyCooldown) g.__igProxyCooldown = { map: new Map() };
  return g.__igProxyCooldown;
}

/** ¿Este proxy está en cooldown ahora mismo (se cayó hace poco)? */
export function isProxyCoolingDown(proxy: ProxyConfig, now = Date.now()): boolean {
  const until = cooldown().map.get(proxy.label);
  return until !== undefined && until > now;
}

/** Marca un proxy como caído: entra en cooldown y se saltea en los próximos intentos. */
export function markProxyDown(proxy: ProxyConfig, why: string): void {
  const until = Date.now() + cooldownMs();
  cooldown().map.set(proxy.label, until);
  console.warn(
    `[ig-proxies] proxy ${proxy.label} no abrió el túnel (${why}); en cooldown hasta ${new Date(
      until
    ).toISOString()}`
  );
}

/** Borra el cooldown de un proxy que volvió a funcionar. */
export function markProxyUp(proxy: ProxyConfig): void {
  cooldown().map.delete(proxy.label);
}

/** Proxies disponibles AHORA (no en cooldown), en orden de preferencia. */
export function availableProxies(now = Date.now()): ProxyConfig[] {
  return getInstagramProxies().filter((p) => !isProxyCoolingDown(p, now));
}

/**
 * Orden en que se deben intentar los proxies en UNA ingesta.
 *
 * Si todos están en cooldown devuelve UNO solo: el que resetea antes. Mejor eso que
 * la lista entera (serían N túneles muertos, ~1s cada uno, antes de llegar a la IP
 * directa) y mejor que ninguno (el cooldown puede estar siendo conservador y el
 * proveedor ya haber vuelto). Mismo criterio que nextCentralToken() en claude-tokens.ts.
 */
export function proxyTryOrder(now = Date.now()): ProxyConfig[] {
  const all = getInstagramProxies();
  if (all.length === 0) return [];
  const available = availableProxies(now);
  if (available.length > 0) return available;
  const map = cooldown().map;
  const soonest = [...all].sort(
    (a, b) => (map.get(a.label) ?? 0) - (map.get(b.label) ?? 0)
  )[0];
  return [soonest];
}

/** Estado del pool, para el diagnóstico de la UI y los tests. */
export function proxyPoolStats(now = Date.now()): {
  total: number;
  available: number;
  coolingDown: Array<{ label: string; until: string }>;
} {
  const map = cooldown().map;
  const all = getInstagramProxies();
  return {
    total: all.length,
    available: availableProxies(now).length,
    coolingDown: all
      .filter((p) => isProxyCoolingDown(p, now))
      .map((p) => ({ label: p.label, until: new Date(map.get(p.label) ?? 0).toISOString() })),
  };
}

/** Resetea el cooldown de todos los proxies. Solo para tests. */
export function __resetProxyCooldownForTests(): void {
  cooldown().map.clear();
}
