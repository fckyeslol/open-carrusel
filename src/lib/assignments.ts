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
  | "claiming" // reclamando el job en Prewave (pending → processing)
  | "ingesting" // bajando el referente + creando el carrusel
  | "generating" // Claude generando las láminas
  | "rendering" // exportando a PNG
  | "done" // generado y renderizado, listo para QA
  | "delivered" // la diseñadora hizo QA y entregó (job cerrado en Prewave)
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
  item: AgentJob
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
      deliveryId: null,
      event: "pull",
      avatarSlug: item.avatarSlug,
      avatarName: item.avatarName,
      referenceUrl: item.referenceUrl,
      designerId: null,
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

/** Sube el contador de intentos (para backoff / diagnóstico). */
export async function incrementAttempts(jobId: string): Promise<void> {
  await updateData<Store>(FILE, EMPTY, (store) => ({
    assignments: store.assignments.map((a) =>
      a.jobId === jobId ? { ...a, attempts: a.attempts + 1, updatedAt: now() } : a
    ),
  }));
}
