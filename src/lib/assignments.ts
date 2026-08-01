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
  | "archived" // la diseñadora lo sacó del tablero: vive en la Biblioteca, se puede restaurar
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

/**
 * De dónde salió este trabajo.
 *
 * `prewave` es el de siempre (webhook/pull de la cola `agent_jobs`): tiene un job real
 * del otro lado, así que se reclama y se hace writeback. `csv` es el lote nocturno que
 * carga una diseñadora: NO existe en Prewave, así que tocar la API con su `jobId`
 * sintético daría 404 en cada llamada. Ausente = `prewave` (todo lo guardado antes de
 * que existiera el lote).
 */
export type AssignmentOrigin = "prewave" | "csv";

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
  /** Ausente = "prewave" (compatibilidad con lo guardado antes del lote CSV). */
  origin?: AssignmentOrigin;
  /** Lote CSV que lo creó. Solo en `origin: "csv"`. */
  batchId?: string;
  /**
   * ¿Esta fila usa Higgsfield? Viene de la columna Si/No del CSV y decide, por job, si
   * el prompt del agente habilita la generación de imágenes con IA. Ausente = se usa la
   * config global (comportamiento de siempre para los jobs de Prewave).
   */
  higgsfield?: boolean;
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
  /**
   * Cuántas veces un ARRANQUE del servidor volvió a encolar este job sin que llegara
   * a terminar. Vive afuera de `generation` a propósito: los jobs que se re-encolaban
   * más caro son justamente los que NO tienen checkpoint, y `clearCheckpoint` borra
   * ese objeto entero. Se pone en cero al terminar (ver `setStatus`).
   */
  reconciles?: number;
  /** Cuándo pasó a la Biblioteca. Solo en `archived`. */
  archivedAt?: string;
  /** Estado que tenía antes de archivarse, para poder devolverlo ahí. Solo en `archived`. */
  archivedFrom?: AssignmentStatus;
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
 * Cuántos arranques seguidos puede sobrevivir un job sin terminar antes de que se
 * deje de re-encolar solo.
 *
 * Tres es "un par de reinicios y algo anda mal": una caída aislada se recupera sola,
 * un job que no termina nunca deja de repetirse.
 */
export const MAX_RECONCILES = 3;

export type ReconcileAction = "resume" | "restart" | "block";

export interface ReconcileDecision {
  jobId: string;
  action: ReconcileAction;
  /** Mensaje para la diseñadora cuando la acción es `block`. */
  reason: string;
}

/**
 * Qué hacer, al arrancar el servidor, con cada job que quedó en vuelo.
 *
 * Antes esto no existía: se re-encolaba TODO lo que estuviera en un estado en vuelo, en
 * cada arranque, para siempre. Un job sin checkpoint vuelve a bajar el referente y a
 * leer las imágenes con visión — el gasto caro — así que en hosteado, donde el
 * contenedor se reinicia solo, el mismo carrusel se regeneraba una y otra vez. Es el
 * "hay carruseles que se regeneran gastando créditos y enredando a las diseñadoras"
 * del reporte. El tope por job (MAX_REQUEUES) no ayudaba: la cola vive en memoria, así
 * que cada arranque empezaba a contar de cero.
 *
 * Es una función PURA para poder probar la política sin runner, sin cola y sin
 * Puppeteer — que es lo que hacía que nadie la mirara.
 */
export function reconcilePlan(
  assignments: readonly Assignment[],
  maxReconciles: number = MAX_RECONCILES
): ReconcileDecision[] {
  const out: ReconcileDecision[] = [];
  for (const a of assignments) {
    if (!IN_FLIGHT.includes(a.status)) continue;
    const n = a.reconciles ?? 0;
    if (n >= maxReconciles) {
      out.push({
        jobId: a.jobId,
        action: "block",
        reason:
          `El servidor se reinició ${n} veces con este pedido a medias y no llegó a ` +
          `terminar. Se dejó de reintentar solo para no seguir gastando créditos: ` +
          `dale a Reintentar cuando quieras volver a correrlo.`,
      });
      continue;
    }
    // Con checkpoint retoma donde iba (mismo carrusel, misma sesión de Claude): es
    // barato y es justo para lo que existe el checkpoint. Sin checkpoint arranca de
    // cero, así que se permite pero se cuenta — el tope de arriba es el que frena.
    out.push({
      jobId: a.jobId,
      action: a.generation?.carouselId ? "resume" : "restart",
      reason: "",
    });
  }
  return out;
}

/** Suma uno al contador de reconciliaciones. Devuelve el valor nuevo. */
export async function bumpReconcile(jobId: string): Promise<number> {
  let n = 0;
  await updateData<Store>(FILE, EMPTY, (store) => ({
    assignments: store.assignments.map((a) => {
      if (a.jobId !== jobId) return a;
      n = (a.reconciles ?? 0) + 1;
      return { ...a, reconciles: n, updatedAt: now() };
    }),
  }));
  return n;
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

/** Una fila del lote CSV, ya resuelta contra los avatares y las diseñadoras locales. */
export interface NewCsvAssignment {
  jobId: string;
  batchId: string;
  avatarSlug: string;
  avatarName: string | null;
  referenceUrl: string;
  designerId: string | null;
  higgsfield: boolean;
}

/**
 * Crea la asignación de una fila del lote CSV, ya en `queued`.
 *
 * Arranca en `queued` y no en `received` para que el reconcile del arranque la vuelva a
 * encolar sola si el server se reinicia a mitad de la noche — que es exactamente el
 * escenario para el que existe el lote: nadie mirando.
 *
 * `briefId`/`avatarId`/`deliveryId` van en null: no hay brief de Prewave detrás. Eso es
 * lo que hace que `sync-mine` no la confunda con un brief ya encolado.
 */
export async function createCsvAssignment(input: NewCsvAssignment): Promise<Assignment> {
  const ts = now();
  const created: Assignment = {
    jobId: input.jobId,
    briefId: null,
    avatarId: null,
    deliveryId: null,
    event: "csv",
    avatarSlug: input.avatarSlug,
    avatarName: input.avatarName,
    referenceUrl: input.referenceUrl,
    designerId: input.designerId,
    status: "queued",
    origin: "csv",
    batchId: input.batchId,
    higgsfield: input.higgsfield,
    carouselId: null,
    resultUrl: null,
    error: null,
    attempts: 0,
    receivedAt: ts,
    updatedAt: ts,
  };

  await updateData<Store>(FILE, EMPTY, (store) =>
    store.assignments.some((a) => a.jobId === created.jobId)
      ? store // idempotente: no duplicar si se reenvía el lote
      : { assignments: [...store.assignments, created] }
  );
  return created;
}

/**
 * Crea TODAS las filas del lote en UNA sola escritura.
 *
 * No es una optimización cosmética: en el server hosteado este store vive en un bucket
 * montado por FUSE, y GCS limita las mutaciones a ~1 por segundo POR OBJETO. Llamar a
 * `createCsvAssignment` en un for de 30 filas reescribía el archivo entero 30 veces
 * seguidas y disparaba una tormenta de 429 (`rateLimitExceeded`) que además arrastraba a
 * otros writers del mismo bucket. FUSE reintenta y no se pierde nada, pero la subida
 * queda lenta y a un reintento de distancia de perder una fila.
 *
 * Una escritura para todo el lote: el costo es O(1) en mutaciones, no O(filas).
 */
export async function createCsvAssignments(
  inputs: readonly NewCsvAssignment[]
): Promise<Assignment[]> {
  if (inputs.length === 0) return [];
  const ts = now();
  const nuevas: Assignment[] = inputs.map((input) => ({
    jobId: input.jobId,
    briefId: null,
    avatarId: null,
    deliveryId: null,
    event: "csv",
    avatarSlug: input.avatarSlug,
    avatarName: input.avatarName,
    referenceUrl: input.referenceUrl,
    designerId: input.designerId,
    status: "queued",
    origin: "csv",
    batchId: input.batchId,
    higgsfield: input.higgsfield,
    carouselId: null,
    resultUrl: null,
    error: null,
    attempts: 0,
    receivedAt: ts,
    updatedAt: ts,
  }));

  await updateData<Store>(FILE, EMPTY, (store) => {
    const conocidos = new Set(store.assignments.map((a) => a.jobId));
    const faltantes = nuevas.filter((a) => !conocidos.has(a.jobId));
    if (faltantes.length === 0) return store; // idempotente
    return { assignments: [...store.assignments, ...faltantes] };
  });
  return nuevas;
}

/** Todas las asignaciones de un lote CSV, en el orden en que entraron. */
export async function listAssignmentsForBatch(batchId: string): Promise<Assignment[]> {
  const store = await readDataSafe<Store>(FILE, EMPTY);
  return store.assignments
    .filter((a) => a.batchId === batchId)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

/** Actualiza status (+ campos opcionales) de forma serializada. */
export async function setStatus(
  jobId: string,
  status: AssignmentStatus,
  patch: StatusPatch = {}
): Promise<void> {
  await updateData<Store>(FILE, EMPTY, (store) => ({
    assignments: store.assignments.map((a) => {
      if (a.jobId !== jobId) return a;
      // `archived` GANA sobre cualquier estado que llegue después.
      //
      // Cancelar un pedido en vuelo no lo mata al instante: el AbortSignal viaja hasta el
      // subproceso de Claude y la generación agonizante todavía escribe su `preempted` /
      // `failed` unos segundos más tarde. Sin este guard, ese estado tardío devolvería al
      // tablero un pedido que la diseñadora ya eliminó. Solo `restoreAssignment` saca de
      // `archived`.
      if (a.status === "archived") return a;
      return {
        ...a,
        status,
        carouselId: patch.carouselId ?? a.carouselId,
        resultUrl: patch.resultUrl ?? a.resultUrl,
        // error se limpia al avanzar y se setea explícito al fallar
        error: patch.error !== undefined ? patch.error : status === "failed" ? a.error : null,
        // El contador de reconciliaciones solo cuenta mientras el job está en vuelo:
        // en cuanto se asienta (terminó, falló, quedó bloqueado) se pone en cero, para
        // que un "Reintentar" arranque con presupuesto limpio en vez de chocar con el
        // tope que dejó una racha vieja de reinicios.
        reconciles: IN_FLIGHT.includes(status) ? a.reconciles : 0,
        updatedAt: now(),
      };
    }),
  }));
}

/**
 * ¿Se puede mandar este estado a la Biblioteca TAL CUAL, sin cortar nada?
 *
 * Todo menos las etapas en vuelo: si el runner está trabajando en el job, archivarlo a
 * secas no lo detendría. Para eliminar algo en vuelo hay que cancelarlo primero en el
 * carril y archivarlo con `archiveCancelled` — ver el DELETE de
 * /api/thirtyx/assignments/[jobId].
 */
export function isArchivable(status: AssignmentStatus): boolean {
  return !IN_FLIGHT.includes(status);
}

/**
 * Manda la asignación a la Biblioteca: sale del tablero pero NO se borra del store.
 *
 * Archivar en vez de borrar es lo que hace que "eliminar" sea durable: el pull de
 * Prewave (sync-mine) decide qué encolar comparando los `briefId` que YA existen
 * localmente, así que un registro borrado de verdad volvería a entrar en el próximo
 * ciclo de poll y la diseñadora lo vería reaparecer. Guarda el estado anterior para
 * poder restaurarlo tal cual.
 */
export async function archiveAssignment(jobId: string): Promise<void> {
  await archive(jobId);
}

/**
 * Archiva un pedido que estaba EN VUELO y la diseñadora canceló desde el tablero.
 *
 * Existe aparte de `archiveAssignment` por el `archivedFrom`: guardar la etapa real
 * ("generating", "queued") haría que al restaurarlo volviera a la columna "Generando"
 * cuando ya no hay nadie generándolo — un pedido fantasma que solo se destraba
 * reiniciando el server. Guardando `failed` + el motivo, restaurarlo lo deja en "Con
 * problemas" con su botón Reintentar, que es lo accionable.
 *
 * Quien llama tiene que haber cortado el trabajo en el carril (`cancel` de job-queue)
 * antes; del estado tardío de la generación moribunda se encarga el guard de `setStatus`.
 */
export async function archiveCancelled(jobId: string, reason: string): Promise<void> {
  await archive(jobId, { archivedFrom: "failed", error: reason });
}

/** Escritura común de los dos "archivar". Idempotente: no re-archiva lo ya archivado. */
async function archive(
  jobId: string,
  patch: Partial<Pick<Assignment, "archivedFrom" | "error">> = {}
): Promise<void> {
  const ts = now();
  await updateData<Store>(FILE, EMPTY, (store) => ({
    assignments: store.assignments.map((a) =>
      a.jobId === jobId && a.status !== "archived"
        ? {
            ...a,
            ...patch,
            status: "archived",
            archivedFrom: patch.archivedFrom ?? a.status,
            archivedAt: ts,
            updatedAt: ts,
          }
        : a
    ),
  }));
}

/**
 * Saca la asignación de la Biblioteca y la devuelve al estado que tenía antes.
 * Devuelve ese estado, o null si el job no existía o no estaba archivado.
 */
export async function restoreAssignment(jobId: string): Promise<AssignmentStatus | null> {
  let restored: AssignmentStatus | null = null;
  await updateData<Store>(FILE, EMPTY, (store) => ({
    assignments: store.assignments.map((a) => {
      if (a.jobId !== jobId || a.status !== "archived") return a;
      // El fallback solo aplica a datos editados a mano: `archiveAssignment` siempre
      // guarda `archivedFrom`.
      const target: AssignmentStatus = a.archivedFrom ?? (a.carouselId ? "pending_review" : "failed");
      restored = target;
      const { archivedFrom: _from, archivedAt: _at, ...rest } = a;
      return { ...rest, status: target, updatedAt: now() };
    }),
  }));
  return restored;
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
