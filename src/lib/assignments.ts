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
  | "received" // llegó el webhook, sin encolar todavía
  | "queued" // ESPERANDO su turno en el carril (ver job-queue.ts) — no está trabajando
  | "blocked" // no se puede generar acá (avatar sin preset local / sin resolver): NO se reclama ni se toca Prewave
  | "claiming" // reclamando el job en Prewave (pending → processing)
  | "ingesting" // bajando el referente + creando el carrusel
  | "generating" // Claude generando las láminas
  | "rendering" // exportando a PNG
  | "preempted" // cedió el carril a algo más urgente; retoma desde su checkpoint
  | "pending_review" // (hosteado) borrador listo — espera que la diseñadora apruebe antes del writeback
  | "done" // generado y renderizado, listo para QA (modo local: ya se hizo writeback)
  | "delivered" // aprobado/entregado: job cerrado en Prewave
  | "failed"; // reventó en alguna etapa

/**
 * Etapas "en vuelo": si el proceso se reinicia, hay que re-encolarlas.
 *
 * `queued` y `preempted` están acá a propósito: son trabajo pendiente que todavía no
 * terminó. Si faltaran, un reinicio dejaría esos jobs colgados para siempre — nadie los
 * volvería a encolar y no aparecerían como fallidos.
 */
export const IN_FLIGHT: readonly AssignmentStatus[] = [
  "received",
  "queued",
  "claiming",
  "ingesting",
  "generating",
  "rendering",
  "preempted",
];

/**
 * Checkpoint de una generación, para poder RETOMARLA tras una preempción o un reinicio.
 *
 * Existe porque el carril puede quitarle el turno a una generación en curso. Sin esto,
 * retomar significaría empezar de cero: volver a bajar el referente, volver a leer las
 * imágenes con visión (el gasto caro) y volver a escribir láminas que ya existían.
 */
export interface GenerationCheckpoint {
  /** El carrusel ya creado. Su presencia es la señal de "no repitas claim ni ingesta". */
  carouselId: string;
  /**
   * Sesión de Claude para `--resume`. Llega en el evento `system/init`, a los segundos
   * del spawn, así que un corte en cualquier momento es recuperable.
   */
  claudeSessionId?: string;
  /**
   * ETIQUETA de la cuenta central usada (no el token).
   *
   * Se guarda la etiqueta y NUNCA el token: este archivo va a disco (y en hosteado a un
   * bucket), y un token de OAuth en disco es un secreto filtrado. La etiqueta alcanza
   * porque una sesión de Claude solo se puede reanudar en la cuenta que la creó, y
   * `tokenTryOrder` sabe volver de la etiqueta al token.
   */
  claudeTokenLabel?: string;
  /** Pasadas de generación ya consumidas (tope MAX_GENERATION_PASSES). */
  passesDone: number;
  /** Pasadas seguidas sin producir láminas. NO se toca en una preempción. */
  stalls: number;
  /** Cuántas veces fue preemptado. Al llegar al tope se vuelve inpreemptable. */
  preemptions: number;
}

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
  /** Prioridad en el carril. Ausente = PRIORITY.NORMAL. */
  priority?: number;
  /** Estado para retomar una generación cortada. Ausente = arrancar de cero. */
  generation?: GenerationCheckpoint;
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

/**
 * Guarda (o mezcla) el checkpoint de generación.
 *
 * Se mergea en vez de reemplazar: cada etapa conoce solo su parte (la ingesta sabe el
 * `carouselId`, el loop de pasadas sabe el `sessionId` y los `stalls`), y perder un campo
 * al guardar otro haría que el retomar empiece de cero.
 */
export async function saveCheckpoint(
  jobId: string,
  patch: Partial<GenerationCheckpoint> & { carouselId: string }
): Promise<void> {
  await updateData<Store>(FILE, EMPTY, (store) => ({
    assignments: store.assignments.map((a) =>
      a.jobId === jobId
        ? {
            ...a,
            generation: {
              passesDone: 0,
              stalls: 0,
              preemptions: 0,
              ...a.generation,
              ...patch,
            },
            updatedAt: now(),
          }
        : a
    ),
  }));
}

/**
 * Borra el checkpoint. Se llama al terminar bien y al "Regenerar desde 0" — si no, un
 * retry reusaría el carrusel viejo y la sesión vieja en vez de arrancar limpio.
 */
export async function clearCheckpoint(jobId: string): Promise<void> {
  await updateData<Store>(FILE, EMPTY, (store) => ({
    assignments: store.assignments.map((a) => {
      if (a.jobId !== jobId) return a;
      const { generation: _drop, ...rest } = a;
      return { ...rest, updatedAt: now() };
    }),
  }));
}

/** Fija la prioridad en el carril (la persiste para que sobreviva a un reinicio). */
export async function setPriority(jobId: string, priority: number): Promise<void> {
  await updateData<Store>(FILE, EMPTY, (store) => ({
    assignments: store.assignments.map((a) =>
      a.jobId === jobId ? { ...a, priority, updatedAt: now() } : a
    ),
  }));
}
