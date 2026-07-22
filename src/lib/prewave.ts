/**
 * Cliente de la cola de trabajos de Prewave (`agent_jobs`) — la INGESTA ACTUAL.
 *
 * No se toca el backend de Prewave: se reusan los mismos endpoints que drenaba el
 * worker de Canva (ver 30x-carousel-pipeline/scripts/queue_client.py y
 * api/src/routers/agent-jobs.ts):
 *
 *   GET   /agent-jobs?status=pending   → SUS jobs (scope por JWT) o toda la cola (API key)
 *   PATCH /agent-jobs/:id  {status: processing|done|failed, resultUrl?, error?}
 *
 * Auth (dos modos, el backend acepta cualquiera):
 *   - JWT de la diseñadora  → header Authorization: Bearer <token>  (scope: SUS jobs)
 *   - Pipeline API key (ops) → header X-API-Key <key>               (scope: toda la cola)
 *
 * Config por env o por data/prewave.json (que la UI puede escribir):
 *   PREWAVE_API_BASE  (default https://api.prewave.oracle30x.co/api/v1)
 *   PREWAVE_TOKEN     (JWT de la diseñadora)
 *   PREWAVE_API_KEY   (solo ops)
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

export interface PrewaveJob {
  id: string;
  kind: string;
  status: string;
  reference_url: string | null;
  brief_id: string | null;
  design_request_id: string | null;
  avatar_id: string | null;
  avatar_slug: string | null;
  avatar_name: string | null;
  content_format: string | null;
  avatar_hint: string | null;
  result_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
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
  // X-API-Key tiene precedencia en el backend; preferimos el JWT de la diseñadora
  // cuando existe (scope acotado a lo suyo), y caemos a la API key si no.
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

/** Lista los jobs de la cola. Con JWT devuelve SOLO los de la diseñadora. */
export async function listJobs(
  status = "pending",
  kind = "carousel_30x"
): Promise<PrewaveJob[]> {
  const qs = new URLSearchParams({ status });
  if (kind) qs.set("kind", kind);
  const data = await req<{ items: PrewaveJob[] }>(`/agent-jobs?${qs.toString()}`);
  return data.items || [];
}

/**
 * Un item de la BANDEJA DE DISEÑO de la diseñadora: un carrusel en `por_disenar`
 * de un avatar del que ella es la diseñadora. Es la fuente del modelo local (pull
 * con SU token). Lo devuelve GET /production/design-queue, ya normalizado desde el
 * `toApiBrief` de Prewave.
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
 * Trae la bandeja de diseño de la diseñadora (scope por SU token JWT). Solo trae
 * SUS carruseles en `por_disenar` — es el reemplazo por-persona de `listJobs`, que
 * pega a la cola compartida `/agent-jobs`.
 */
export async function listDesignQueue(): Promise<DesignQueueItem[]> {
  const data = await req<{ items: ApiBriefLite[] }>(`/production/design-queue`);
  return (data.items || []).map(mapDesignItem);
}

/** Reclama un job (pending → processing). Sube el contador de intentos en el backend. */
export async function claimJob(id: string): Promise<PrewaveJob> {
  const data = await req<{ ok: boolean; job: PrewaveJob }>(`/agent-jobs/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "processing" }),
  });
  return data.job;
}

/** Cierra un job OK con el link/assets del carrusel final. */
export async function completeJob(id: string, resultUrl: string): Promise<PrewaveJob> {
  const data = await req<{ ok: boolean; job: PrewaveJob }>(`/agent-jobs/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "done", resultUrl }),
  });
  return data.job;
}

/** Marca un job como fallido. */
export async function failJob(id: string, error: string): Promise<PrewaveJob> {
  const data = await req<{ ok: boolean; job: PrewaveJob }>(`/agent-jobs/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "failed", error: error.slice(0, 1000) }),
  });
  return data.job;
}
