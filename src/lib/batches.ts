/**
 * Store de los LOTES nocturnos (data/thirtyx-batches.json).
 *
 * Un lote es "este CSV que subió Fulana el martes a las 18:40, programado para las
 * 20:00". Guarda el encabezado del trabajo: quién lo subió, cuándo arranca, cuántas
 * filas entraron y cuáles se descartaron al parsear, y en qué estado está.
 *
 * ⚠️ Lo que NO guarda son las filas que sí se van a generar: esas viven en
 * `assignments.ts` como asignaciones normales con `origin: "csv"` y `batchId`. Duplicar
 * su estado acá sería tener dos versiones de la verdad sobre el mismo trabajo, y la que
 * mira la UI (el tablero) es la de assignments. El progreso del lote se DERIVA contando
 * sus asignaciones (ver `batchProgress`).
 *
 * Escribe con `updateData` (mutex + escritura atómica) igual que el resto de los stores.
 */
import { readDataSafe, updateData } from "./data";
import { listAssignmentsForBatch, type Assignment } from "./assignments";
import { generateId, now } from "./utils";
import type { InvalidRow } from "./csv-batch";

const FILE = "thirtyx-batches.json";

/** Cuántos lotes se conservan. Es bitácora de trabajo, no auditoría. */
const MAX_BATCHES = 40;

export type BatchStatus =
  | "scheduled" // esperando la ventana nocturna
  | "running" // sus filas ya se despacharon al carril
  | "done" // todas las filas terminaron (bien o mal)
  | "cancelled"; // la cancelaron antes de que arrancara

/** Una fila que NO se va a generar, con el motivo, para el reporte de la UI. */
export interface BatchSkip {
  line: number;
  raw: string;
  reason: string;
}

export interface Batch {
  id: string;
  /** Nombre del archivo subido, para reconocerlo en la lista. */
  filename: string;
  /** Usuaria que lo subió (modo hosteado). Null en local. */
  uploadedBy: string | null;
  uploadedByName: string | null;
  status: BatchStatus;
  /** Cuándo arranca (ISO). Es la ventana nocturna calculada al subir. */
  scheduledFor: string;
  /** Cuándo se despacharon efectivamente sus filas al carril. */
  startedAt: string | null;
  finishedAt: string | null;
  /** Cuántas filas válidas entraron como asignaciones. */
  rowCount: number;
  /** Filas descartadas al parsear o al resolver el avenger, con su motivo. */
  skipped: BatchSkip[];
  createdAt: string;
  updatedAt: string;
}

interface Store {
  batches: Batch[];
}

const EMPTY: Store = { batches: [] };

function byNewest(a: Batch, b: Batch): number {
  return b.createdAt.localeCompare(a.createdAt);
}

export async function listBatches(): Promise<Batch[]> {
  const store = await readDataSafe<Store>(FILE, EMPTY);
  return [...store.batches].sort(byNewest);
}

export async function getBatch(id: string): Promise<Batch | null> {
  const store = await readDataSafe<Store>(FILE, EMPTY);
  return store.batches.find((b) => b.id === id) ?? null;
}

export interface NewBatch {
  filename: string;
  uploadedBy: string | null;
  uploadedByName: string | null;
  scheduledFor: string;
  rowCount: number;
  skipped: readonly (InvalidRow | BatchSkip)[];
}

export async function createBatch(input: NewBatch): Promise<Batch> {
  const ts = now();
  const batch: Batch = {
    id: generateId(),
    filename: input.filename,
    uploadedBy: input.uploadedBy,
    uploadedByName: input.uploadedByName,
    status: "scheduled",
    scheduledFor: input.scheduledFor,
    startedAt: null,
    finishedAt: null,
    rowCount: input.rowCount,
    skipped: input.skipped.map((s) => ({ line: s.line, raw: s.raw, reason: s.reason })),
    createdAt: ts,
    updatedAt: ts,
  };

  await updateData<Store>(FILE, EMPTY, (store) => ({
    batches: [...store.batches, batch].sort(byNewest).slice(0, MAX_BATCHES),
  }));
  return batch;
}

async function patch(id: string, changes: Partial<Batch>): Promise<void> {
  await updateData<Store>(FILE, EMPTY, (store) => ({
    batches: store.batches.map((b) =>
      b.id === id ? { ...b, ...changes, updatedAt: now() } : b
    ),
  }));
}

/**
 * Marca el lote como despachado. Idempotente y con guard de estado: el scheduler
 * corre cada minuto y "Correr ahora" puede pisarlo, así que sin el guard un lote ya
 * corriendo se re-despacharía y encolaría sus filas dos veces.
 *
 * Devuelve true solo si ESTA llamada fue la que lo pasó a `running` — quien la reciba
 * es el único autorizado a despachar las filas.
 */
export async function markRunning(id: string): Promise<boolean> {
  let won = false;
  await updateData<Store>(FILE, EMPTY, (store) => ({
    batches: store.batches.map((b) => {
      if (b.id !== id || b.status !== "scheduled") return b;
      won = true;
      return { ...b, status: "running", startedAt: now(), updatedAt: now() };
    }),
  }));
  return won;
}

export async function markDone(id: string): Promise<void> {
  await patch(id, { status: "done", finishedAt: now() });
}

/**
 * Adelanta la hora del lote a AHORA, para "Correr ahora".
 *
 * Se escribe antes de despachar a propósito: si el proceso muere entre esta escritura y
 * el despacho, el lote queda vencido en disco y el siguiente tick del scheduler lo
 * levanta solo. Al revés (despachar y después escribir) un corte lo dejaría programado
 * para la noche con las filas ya encoladas.
 */
export async function dispatchNow(id: string): Promise<void> {
  await patch(id, { scheduledFor: now() });
}

/**
 * Cancela un lote que todavía no arrancó. No toca lo que ya está en el carril: para
 * cortar algo en vuelo está el botón de cancelar del tablero, que sí aborta el job.
 */
export async function cancelBatch(id: string): Promise<boolean> {
  let cancelled = false;
  await updateData<Store>(FILE, EMPTY, (store) => ({
    batches: store.batches.map((b) => {
      if (b.id !== id || b.status !== "scheduled") return b;
      cancelled = true;
      return { ...b, status: "cancelled", updatedAt: now() };
    }),
  }));
  return cancelled;
}

/** Lotes que ya deberían haber arrancado (su hora pasó y siguen esperando). */
export async function listDueBatches(atMs: number = Date.now()): Promise<Batch[]> {
  return (await listBatches()).filter(
    (b) => b.status === "scheduled" && Date.parse(b.scheduledFor) <= atMs
  );
}

export interface BatchProgress {
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
}

/** Estados de una asignación que cuentan como "ya terminó, para bien o para mal". */
const TERMINAL_OK = new Set(["done", "delivered", "pending_review", "archived"]);
const TERMINAL_BAD = new Set(["failed", "blocked"]);

/**
 * Progreso del lote, DERIVADO de sus asignaciones — nunca de un contador propio.
 *
 * Un contador que se incrementa a mano se desincroniza en cuanto un job se reintenta,
 * se archiva o lo cancelan desde el tablero; contar sobre la fuente de verdad no puede
 * mentir.
 */
export function batchProgress(assignments: readonly Assignment[]): BatchProgress {
  let done = 0;
  let failed = 0;
  let running = 0;
  for (const a of assignments) {
    if (TERMINAL_OK.has(a.status)) done++;
    else if (TERMINAL_BAD.has(a.status)) failed++;
    else if (a.status !== "queued" && a.status !== "received") running++;
  }
  return {
    total: assignments.length,
    pending: assignments.length - done - failed - running,
    running,
    done,
    failed,
  };
}

/**
 * Cierra el lote si ya no le queda nada por hacer. Se llama después de cada job del
 * lote; es barato (una lectura) e idempotente.
 */
export async function closeBatchIfFinished(batchId: string): Promise<void> {
  const batch = await getBatch(batchId);
  if (!batch || batch.status !== "running") return;
  const progress = batchProgress(await listAssignmentsForBatch(batchId));
  if (progress.pending === 0 && progress.running === 0) {
    await markDone(batchId);
  }
}
