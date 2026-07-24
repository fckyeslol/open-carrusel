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
import sharp from "sharp";
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

/**
 * `tokenOverride`: en modo hosteado cada request se hace con el JWT de UNA
 * diseñadora (scope por persona), no con el token global. Se mezcla sobre el
 * apiBase de la config global.
 */
async function req<T>(path: string, init?: RequestInit, tokenOverride?: string): Promise<T> {
  const cfg = tokenOverride
    ? { ...(await getPrewaveConfig()), token: tokenOverride }
    : await getPrewaveConfig();
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
export async function listPendingJobs(token?: string): Promise<AgentJob[]> {
  const data = await req<{ items: ApiAgentJob[] }>(`/agent-jobs?status=pending`, undefined, token);
  return (data.items || []).map(mapAgentJob);
}

/** Reclama un job (pending → processing) para que otro worker no lo tome. */
export async function claimJob(jobId: string, token?: string): Promise<void> {
  await req(
    `/agent-jobs/${jobId}`,
    { method: "PATCH", body: JSON.stringify({ status: "processing" }) },
    token
  );
}

/**
 * Cierra un job OK (→ done) con el link del resultado. El endpoint espera
 * `resultUrl` en camelCase (snake_case se ignora — verificado en el pipeline).
 */
export async function completeJob(jobId: string, resultUrl: string, token?: string): Promise<void> {
  await req(
    `/agent-jobs/${jobId}`,
    { method: "PATCH", body: JSON.stringify({ status: "done", resultUrl }) },
    token
  );
}

/** Marca un job como fallido (→ failed) con el motivo (máx 1000 chars). */
export async function failJob(jobId: string, error: string, token?: string): Promise<void> {
  await req(
    `/agent-jobs/${jobId}`,
    { method: "PATCH", body: JSON.stringify({ status: "failed", error: error.slice(0, 1000) }) },
    token
  );
}

/** Una lámina exportada lista para subir. */
export interface CarouselSlideFile {
  name: string;
  buffer: Uint8Array;
}

/**
 * El endpoint de worker limita el body multipart a 1MB. Las PNG a 1080×1350 pesan
 * ~1MB CADA UNA, así que subir los PNG crudos revienta con 413 (verificado). Se
 * re-codifican a JPEG antes de subir: a q88, 4 láminas dan ~0.3MB y una foto a
 * sangre ~0.2MB, muy por debajo del tope. Presupuesto un poco bajo el 1MB real para
 * dejar aire al boundary del multipart y a los nombres de campo.
 */
const UPLOAD_BUDGET_BYTES = 950_000;
/**
 * Escalones de calidad JPEG: se baja hasta entrar en el presupuesto. El último
 * (45) existe porque los fondos con grano/textura comprimen pésimo: un carrusel
 * de 10 láminas granuladas mide ~1.1MB aún a q55 (verificado con "10 Hábitos").
 */
const JPEG_QUALITY_STEPS = [88, 80, 72, 64, 55, 45] as const;

/**
 * Tope del endpoint de Prewave (MAX_SLIDES): más de 10 devuelve 422. Coincide con
 * el máximo de Instagram, así que ante un referente más largo subimos 10.
 */
const MAX_UPLOAD_SLIDES = 10;

/**
 * Si el carrusel excede el tope, se suben las primeras 9 + la ÚLTIMA lámina: en
 * los carruseles 30x la última es el cierre/CTA (workshop, DM) y perderla deja el
 * carrusel sin remate. Las del medio son las menos costosas de sacrificar.
 */
function capSlidesForUpload(
  files: readonly CarouselSlideFile[]
): readonly CarouselSlideFile[] {
  if (files.length <= MAX_UPLOAD_SLIDES) return files;
  return [...files.slice(0, MAX_UPLOAD_SLIDES - 1), files[files.length - 1]];
}

/**
 * Re-codifica las láminas a JPEG y baja la calidad hasta que el total entra en
 * UPLOAD_BUDGET_BYTES. JPEG (no WebP) porque es el formato que el flujo de
 * publicación (Metricool/Instagram) consume sin fricción. Devuelve las láminas
 * renombradas `slide-0001.jpg`… para que el backend las ordene por nombre.
 */
async function compressSlidesForUpload(
  files: readonly CarouselSlideFile[]
): Promise<CarouselSlideFile[]> {
  const capped = capSlidesForUpload(files);
  let last: CarouselSlideFile[] = [];
  for (const quality of JPEG_QUALITY_STEPS) {
    last = await Promise.all(
      capped.map(async (f, i) => ({
        name: `slide-${String(i + 1).padStart(4, "0")}.jpg`,
        buffer: new Uint8Array(
          await sharp(Buffer.from(f.buffer)).jpeg({ quality }).toBuffer()
        ),
      }))
    );
    const total = last.reduce((n, f) => n + f.buffer.length, 0);
    if (total <= UPLOAD_BUDGET_BYTES) return last;
  }
  // Ni al mínimo entra (carrusel enorme): subimos igual la mejor aproximación —
  // que el endpoint decida (413) es más informativo que no intentar.
  return last;
}

/**
 * Sube las láminas del carrusel al endpoint de worker de Prewave
 * (POST /agent-jobs/:id/carousel), que las guarda en GCS, las siembra como media
 * del brief (publish_media_urls, en orden) y cierra el job (done). Reemplaza al
 * completeJob para jobs con brief. Se manda multipart con un `file` por lámina,
 * comprimida a JPEG (ver compressSlidesForUpload: el body tope es 1MB) y renombrada
 * `slide-0001.jpg`… para que el backend las ordene por nombre.
 *
 * Lanza PrewaveError si el endpoint no está (404 = aún no desplegado) o el job no
 * tiene brief (422): el runner cae a completeJob con un link local en ese caso.
 */
export async function uploadCarousel(
  jobId: string,
  files: readonly CarouselSlideFile[],
  token?: string
): Promise<void> {
  const cfg = token
    ? { ...(await getPrewaveConfig()), token }
    : await getPrewaveConfig();
  if (!isConfigured(cfg)) {
    throw new PrewaveError(401, "Prewave sin configurar: falta token o API key");
  }

  const compressed = await compressSlidesForUpload(files);
  const form = new FormData();
  compressed.forEach((f) => {
    form.append("file", new Blob([f.buffer as unknown as BlobPart], { type: "image/jpeg" }), f.name);
  });

  // No seteamos Content-Type: undici pone el multipart boundary solo.
  const headers: Record<string, string> = {};
  if (cfg.token) headers["Authorization"] = `Bearer ${cfg.token}`;
  else if (cfg.apiKey) headers["X-API-Key"] = cfg.apiKey;

  const res = await fetch(`${cfg.apiBase}/agent-jobs/${jobId}/carousel`, {
    method: "POST",
    headers,
    body: form,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new PrewaveError(res.status, `carousel upload HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}
