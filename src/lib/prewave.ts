/**
 * Cliente de Prewave para el modelo LOCAL por diseñadora.
 *
 * La app corre en la máquina de cada diseñadora y jala SU bandeja de diseño con
 * SU token (scope por JWT), vía el endpoint de Prewave:
 *
 *   GET /production/design-queue  → los carruseles asignados a ella que necesitan
 *                                   diseño (ver listDesignQueue()).
 *
 * Auth: Authorization: Bearer <token>  (el JWT de 30 días de su sesión de Prewave).
 *
 * Config por env o por data/prewave.json (que el panel /30x puede escribir):
 *   PREWAVE_API_BASE  (default https://api.prewave.oracle30x.co/api/v1)
 *   PREWAVE_TOKEN     (JWT de la diseñadora)
 *   PREWAVE_API_KEY   (opcional, solo ops)
 */
import { readDataSafe, writeData } from "./data";

const CONFIG_FILE = "prewave.json";
const DEFAULT_BASE = "https://api.prewave.oracle30x.co/api/v1";

export interface PrewaveConfig {
  apiBase: string;
  token: string | null; // JWT de la diseñadora
  apiKey: string | null; // pipeline API key (ops)
  updatedAt: string;
}

const EMPTY_CONFIG: PrewaveConfig = {
  apiBase: DEFAULT_BASE,
  token: null,
  apiKey: null,
  updatedAt: "",
};

export async function getPrewaveConfig(): Promise<PrewaveConfig> {
  const stored = await readDataSafe<PrewaveConfig>(CONFIG_FILE, EMPTY_CONFIG);
  // env pisa al archivo (útil para correr headless / CI)
  return {
    apiBase: (process.env.PREWAVE_API_BASE || stored.apiBase || DEFAULT_BASE).replace(/\/$/, ""),
    token: process.env.PREWAVE_TOKEN || stored.token || null,
    apiKey: process.env.PREWAVE_API_KEY || stored.apiKey || null,
    updatedAt: stored.updatedAt,
  };
}

export async function setPrewaveConfig(
  updates: Partial<Pick<PrewaveConfig, "apiBase" | "token" | "apiKey">>
): Promise<PrewaveConfig> {
  const current = await readDataSafe<PrewaveConfig>(CONFIG_FILE, EMPTY_CONFIG);
  const next: PrewaveConfig = {
    apiBase: updates.apiBase ?? current.apiBase ?? DEFAULT_BASE,
    token: updates.token !== undefined ? updates.token : current.token,
    apiKey: updates.apiKey !== undefined ? updates.apiKey : current.apiKey,
    updatedAt: new Date().toISOString(),
  };
  await writeData(CONFIG_FILE, next);
  return next;
}

export function isConfigured(cfg: PrewaveConfig): boolean {
  return Boolean(cfg.token || cfg.apiKey);
}

function authHeaders(cfg: PrewaveConfig): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  // La bandeja de diseño scopea por el JWT de la diseñadora (Bearer). Si no hay
  // token pero sí una API key de ops, se manda como fallback (no scopea por persona).
  if (cfg.token) h["Authorization"] = `Bearer ${cfg.token}`;
  else if (cfg.apiKey) h["X-API-Key"] = cfg.apiKey;
  return h;
}

export class PrewaveError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "PrewaveError";
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const cfg = await getPrewaveConfig();
  if (!isConfigured(cfg)) {
    throw new PrewaveError(401, "Prewave sin configurar: falta token o API key");
  }
  const res = await fetch(`${cfg.apiBase}${path}`, {
    ...init,
    headers: { ...authHeaders(cfg), ...(init?.headers as Record<string, string>) },
    cache: "no-store",
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    if (body && typeof body === "object" && "error" in body) {
      msg = String((body as { error: unknown }).error);
    }
    throw new PrewaveError(res.status, msg);
  }
  return body as T;
}

/**
 * Un item de la BANDEJA DE DISEÑO de la diseñadora: un carrusel asignado a ella
 * que necesita diseño. Es la fuente del modelo local (pull con SU token). Lo
 * devuelve GET /production/design-queue, normalizado desde el `toApiBrief` de Prewave.
 */
export interface DesignQueueItem {
  jobId: string; // curated_brief.id
  avatarSlug: string; // el avenger (avatars.slug)
  avatarName: string | null;
  referenceUrl: string; // el post de IG a calcar (raw_post.canonical_url)
  title: string | null;
}

/** Forma (parcial) del ApiBrief de Prewave que nos interesa. */
interface ApiBriefLite {
  id: string;
  avatar?: { slug?: string | null; name?: string | null } | null;
  scored_post?: {
    raw_post?: { canonical_url?: string | null; post_url?: string | null } | null;
  } | null;
  video_title?: string | null;
  angle_30x?: string | null;
}

function mapDesignItem(b: ApiBriefLite): DesignQueueItem {
  const raw = b.scored_post?.raw_post;
  return {
    jobId: b.id,
    avatarSlug: b.avatar?.slug ?? "",
    avatarName: b.avatar?.name ?? null,
    referenceUrl: raw?.canonical_url || raw?.post_url || "",
    title: b.video_title || b.angle_30x || null,
  };
}

/**
 * Trae la bandeja de diseño de la diseñadora (scope por SU token JWT): solo SUS
 * carruseles asignados que necesitan diseño.
 */
export async function listDesignQueue(): Promise<DesignQueueItem[]> {
  const data = await req<{ items: ApiBriefLite[] }>(`/production/design-queue`);
  return (data.items || []).map(mapDesignItem);
}
