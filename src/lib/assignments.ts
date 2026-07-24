/**
 * Store durable de las asignaciones que llegan por webhook (data/thirtyx-assignments.json).
 *
 * Es la fuente de verdad LOCAL de la cola: el webhook escribe acá y el runner y la
 * UI leen de acá. Usa `updateData` (mutex + escritura atómica de data.ts) para que
 * los reintentos concurrentes de Prewave no se pisen.
 *
 * La UI hace poll a ESTE archivo (nuestra base local), no a Prewave — eso no es el
 * scraping que se quería evitar; la ingesta desde Prewave es 100% push.
 */
import { readDataSafe, updateData } from "./data";
import { now } from "./utils";
import type { AgentJob } from "./prewave";

const FILE = "thirtyx-assignments.json";

export type AssignmentStatus =
  | "received" // llegó el webhook, en cola
  | "blocked" // no se puede generar acá (avatar sin preset local / sin resolver): NO se reclama ni se toca Prewave
  | "claiming" // reclamando el job en Prewave (pending → processing)
  | "ingesting" // bajando el referente + creando el carrusel
  | "generating" // Claude generando las láminas
  | "rendering" // exportando a PNG
  | "pending_review" // (hosteado) borrador listo — espera que la diseñadora apruebe antes del writeback
  | "done" // generado y renderizado, listo para QA (modo local: ya se hizo writeback)
  | "delivered" // aprobado/entregado: job cerrado en Prewave
  | "failed"; // reventó en alguna etapa

/** Etapas "en vuelo": si el proceso se reinicia, hay que re-encolarlas. */
export const IN_FLIGHT: readonly AssignmentStatus[] = [
  "received",
  "claiming",
  "ingesting",
  "generating",
  "rendering",
];

export interface Assignment {
  jobId: string;
  briefId: string | null; // curated_briefs.id — dedup del design-queue + writeback
  avatarId: string | null; // para el checklist custom del avatar en el writeback
  deliveryId: string | null;
  event: string;
  avatarSlug: string;
  avatarName: string | null;
  referenceUrl: string;
  designerId: string | null;
  status: AssignmentStatus;
  carouselId: string | null;
  resultUrl: string | null;
  error: string | null;
  attempts: number;
  receivedAt: string;
  updatedAt: string;
}

interface Store {
  assignments: Assignment[];
}

const EMPTY: Store = { assignments: [] };

/** Campos que `setStatus` puede parchear junto con el status. */
type StatusPatch = Partial<
  Pick<Assignment, "carouselId" | "resultUrl" | "error">
>;

export async function listAssignments(): Promise<Assignment[]> {
  const store = await readDataSafe<Store>(FILE, EMPTY);
  return [...store.assignments].sort((a, b) =>
    b.receivedAt.localeCompare(a.receivedAt)
  );
}

export async function getAssignment(jobId: string): Promise<Assignment | null> {
  const store = await readDataSafe<Store>(FILE, EMPTY);
  return store.assignments.find((a) => a.jobId === jobId) ?? null;
}

/** Asignaciones de UNA diseñadora (modo hosteado: cada una ve solo lo suyo). */
export async function listAssignmentsForDesigner(designerId: string): Promise<Assignment[]> {
  return (await listAssignments()).filter((a) => a.designerId === designerId);
}

/** Asignaciones que quedaron a medias (para reconciliar al bootear). */
export async function listReprocessable(): Promise<Assignment[]> {
  const store = await readDataSafe<Store>(FILE, EMPTY);
  return store.assignments.filter((a) => IN_FLIGHT.includes(a.status));
}

/**
 * Inserta la asignación si es nueva, a partir de un job de la cola `agent_jobs`
 * traído de Prewave con el token de la diseñadora (pull). Idempotente por `jobId`:
 * si ya existe (re-pull en el próximo ciclo), NO lo reinicia ni lo re-encola —
 * devuelve el existente con `isNew: false`. El avenger sale de `avatarSlug`; la
 * generación local resuelve su preset y falla con mensaje claro si no calza.
 */
export async function upsertFromAgentJob(
  item: AgentJob,
  designerId: string | null = null
): Promise<{ assignment: Assignment; isNew: boolean }> {
  const ts = now();
  let isNew = false;
  let result!: Assignment;

  await updateData<Store>(FILE, EMPTY, (store) => {
    const existing = store.assignments.find((a) => a.jobId === item.jobId);
    if (existing) {
      result = existing;
      return store;
    }
    isNew = true;
    const created: Assignment = {
      jobId: item.jobId,
      briefId: item.briefId,
      avatarId: item.avatarId,
      deliveryId: null,
      event: "pull",
      avatarSlug: item.avatarSlug,
      avatarName: item.avatarName,
      referenceUrl: item.referenceUrl,
      designerId,
      status: "received",
      carouselId: null,
      resultUrl: null,
      error: null,
      attempts: 0,
      receivedAt: ts,
      updatedAt: ts,
    };
    result = created;
    return { assignments: [...store.assignments, created] };
  });

  return { assignment: result, isNew };
}

/** Actualiza status (+ campos opcionales) de forma serializada. */
export async function setStatus(
  jobId: string,
  status: AssignmentStatus,
  patch: StatusPatch = {}
): Promise<void> {
  await updateData<Store>(FILE, EMPTY, (store) => ({
    assignments: store.assignments.map((a) =>
      a.jobId === jobId
        ? {
            ...a,
            status,
            carouselId: patch.carouselId ?? a.carouselId,
            resultUrl: patch.resultUrl ?? a.resultUrl,
            // error se limpia al avanzar y se setea explícito al fallar
            error: patch.error !== undefined ? patch.error : status === "failed" ? a.error : null,
            updatedAt: now(),
          }
        : a
    ),
  }));
}

/**
 * Descarta los huérfanos de Diseño: TODO assignment SIN avatar resuelto (`avatarSlug`
 * vacío), sin importar el estado. Son los jobs de origen Diseño ("El job no trae
 * avatar (origen Diseño sin resolver)"): Producción SIEMPRE trae el avatar resuelto
 * por FK, así que un slug vacío ⇒ no es Producción. Ahora que la ingesta solo trae
 * Producción (ver isProduccionJob en prewave.ts) ya no vuelven a entrar; esto limpia
 * los que quedaron guardados de antes (blocked, failed, etc.). NO toca los que tienen
 * avatar aunque estén `blocked`/`failed` (p.ej. "Cora Bilbao", sin preset local, o
 * "crece30x", que falló generando): esos son Producción y se resuelven aparte. Nunca
 * se reclamaron en Prewave, así que borrarlos localmente es seguro. Devuelve cuántos
 * se quitaron.
 */
export async function pruneDesignOrphans(): Promise<number> {
  let removed = 0;
  await updateData<Store>(FILE, EMPTY, (store) => {
    const kept = store.assignments.filter((a) => Boolean(a.avatarSlug));
    removed = store.assignments.length - kept.length;
    return { assignments: kept };
  });
  return removed;
}

/** Sube el contador de intentos (para backoff / diagnóstico). */
export async function incrementAttempts(jobId: string): Promise<void> {
  await updateData<Store>(FILE, EMPTY, (store) => ({
    assignments: store.assignments.map((a) =>
      a.jobId === jobId ? { ...a, attempts: a.attempts + 1, updatedAt: now() } : a
    ),
  }));
}
