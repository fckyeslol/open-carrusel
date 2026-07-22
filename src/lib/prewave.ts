/**
 * Cliente de Prewave para el modelo LOCAL por diseñadora.
 *
 * La app corre en la máquina de cada diseñadora y drena SU cola de generación 30x
 * (tabla `agent_jobs` de Prewave, scope por JWT), vía los endpoints:
 *
 *   GET   /agent-jobs?status=pending  → sus jobs "Generar 30x" (ver listPendingJobs()).
 *   PATCH /agent-jobs/:id             → claim (processing) / done / failed.
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
 * Un job de la cola `agent_jobs` de Prewave (kind `carousel_30x`): una solicitud
 * de "Generar 30x" con SU referente de Instagram. Es la ingesta del worker local
 * (pull con SU token JWT, scope por diseñadora). Lo devuelve GET /agent-jobs.
 *
 * ⚠️ NO es `/production/design-queue` (esos son briefs de producción, mayormente
 * contenido propio "manual" SIN referente). La cola real de generación es esta:
 * cada job trae `reference_url`. Ver docs/PLAN-MIGRACION-CARRUSELES.md §3.
 */
export interface AgentJob {
  jobId: string; // agent_jobs.id
  referenceUrl: string; // el post de IG a calcar (reference_url)
  avatarSlug: string; // avatar_slug (origen Producción) → avatar_hint (origen Diseño)
  avatarName: string | null;
}

/**
 * Forma (parcial) del agent_job de Prewave. Exactamente uno de brief_id /
 * design_request_id viene no-null; con brief_id (origen Producción) el avatar viene
 * resuelto por FK en avatar_slug. Ver queue_client.py del pipeline.
 */
interface ApiAgentJob {
  id: string;
  reference_url?: string | null;
  avatar_slug?: string | null;
  avatar_name?: string | null;
  avatar_hint?: string | null;
  status?: string | null;
}

function mapAgentJob(j: ApiAgentJob): AgentJob {
  return {
    jobId: j.id,
    referenceUrl: j.reference_url || "",
    // Producción trae avatar_slug directo; Diseño (legacy) solo avatar_hint.
    avatarSlug: j.avatar_slug || j.avatar_hint || "",
    avatarName: j.avatar_name ?? null,
  };
}

/**
 * Trae los jobs PENDIENTES de la diseñadora (scope por SU token JWT): las
 * solicitudes de "Generar 30x" que todavía nadie reclamó.
 */
export async function listPendingJobs(): Promise<AgentJob[]> {
  const data = await req<{ items: ApiAgentJob[] }>(`/agent-jobs?status=pending`);
  return (data.items || []).map(mapAgentJob);
}

/** Reclama un job (pending → processing) para que otro worker no lo tome. */
export async function claimJob(jobId: string): Promise<void> {
  await req(`/agent-jobs/${jobId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "processing" }),
  });
}

/**
 * Cierra un job OK (→ done) con el link del resultado. El endpoint espera
 * `resultUrl` en camelCase (snake_case se ignora — verificado en el pipeline).
 */
export async function completeJob(jobId: string, resultUrl: string): Promise<void> {
  await req(`/agent-jobs/${jobId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "done", resultUrl }),
  });
}

/** Marca un job como fallido (→ failed) con el motivo (máx 1000 chars). */
export async function failJob(jobId: string, error: string): Promise<void> {
  await req(`/agent-jobs/${jobId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "failed", error: error.slice(0, 1000) }),
  });
}
