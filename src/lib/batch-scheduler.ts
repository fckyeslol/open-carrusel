/**
 * El DESPERTADOR del lote nocturno.
 *
 * Un solo timer que cada minuto se pregunta "¿hay algún lote cuya hora ya pasó?" y, si
 * lo hay, despacha sus filas al carril de trabajos. Nada más. La generación en sí es la
 * de siempre (thirtyx-runner), que ya corre sin preguntar nada.
 *
 * Por qué un tick de un minuto y no un `setTimeout` a la hora exacta de cada lote:
 *  - un timeout de 6 horas no sobrevive a un redeploy ni a un reinicio, y el lote se
 *    perdería en silencio — el peor fallo posible acá, porque nadie está mirando;
 *  - el tick relee del disco, así que un lote programado por OTRO proceso (o antes del
 *    reinicio) igual arranca;
 *  - un minuto de imprecisión sobre una ventana nocturna no le importa a nadie.
 *
 * Singleton en `globalThis` como el resto de los registros vivos (carril, runner): sin
 * eso, el HMR de dev dejaría un timer nuevo por recarga y el lote se despacharía varias
 * veces.
 */
import { listBatches, listDueBatches, markRunning, type Batch } from "./batches";
import { listAssignmentsForBatch, setStatus } from "./assignments";
import { loteDespachado } from "./telemetry";

/** Cada cuánto se pregunta si hay lotes vencidos. */
const TICK_MS = 60_000;

/**
 * Hora a la que arranca la ventana nocturna, 0-23 (hora local del servidor).
 * Configurable con BATCH_NIGHT_HOUR; default 20:00.
 */
export function nightHour(): number {
  const raw = process.env.BATCH_NIGHT_HOUR;
  const n = raw ? parseInt(raw, 10) : 20;
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 20;
}

/** Minuto de arranque dentro de esa hora (default 0). */
function nightMinute(): number {
  const raw = process.env.BATCH_NIGHT_MINUTE;
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n >= 0 && n <= 59 ? n : 0;
}

/**
 * Próxima ventana nocturna a partir de `from`.
 *
 * Si todavía no dieron las 20:00 de hoy, es hoy; si ya pasaron, es mañana. El caso
 * "suben el CSV a las 21:00" es real y frecuente (se acuerdan tarde), y lo correcto es
 * la noche siguiente y no "dentro de un minuto": el lote existe justamente para NO
 * correr mientras la gente trabaja.
 */
export function nextNightWindow(from: Date = new Date()): Date {
  const target = new Date(from);
  target.setHours(nightHour(), nightMinute(), 0, 0);
  if (target.getTime() <= from.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

/**
 * Despacha las filas de un lote al carril.
 *
 * `markRunning` es el que decide quién despacha: devuelve true a UNA sola llamada, así
 * que el tick del scheduler y un "Correr ahora" simultáneos no pueden encolar las filas
 * dos veces. Devuelve cuántas encoló.
 */
export async function dispatchBatch(batch: Batch): Promise<number> {
  if (!(await markRunning(batch.id))) return 0;

  const rows = await listAssignmentsForBatch(batch.id);
  // Import perezoso: el runner arrastra Puppeteer y el subproceso de Claude. Traerlo de
  // forma estática obligaría a cargar todo eso a cualquiera que solo quiera calcular la
  // hora de la ventana nocturna (incluidos los tests de este archivo).
  const { getRunner } = await import("./thirtyx-runner");
  const runner = getRunner();
  for (const row of rows) {
    // El runner ignora lo que ya está en el carril, así que esto es idempotente.
    // Una fila que falle al encolarse NO puede frenar a las demás: es la regla del lote.
    try {
      runner.enqueue(row.jobId);
    } catch (err) {
      console.error(`[lote] no se pudo encolar la fila ${row.jobId}:`, err);
    }
  }
  loteDespachado(batch.id, rows.length);
  return rows.length;
}

/**
 * Cuántas veces se reintenta SOLA una fila del lote antes de dejarla quieta.
 *
 * Existe el tope porque un referente roto (post borrado, privado) falla siempre: sin
 * límite, el lote giraría toda la noche quemando presupuesto en la misma URL.
 */
const MAX_AUTO_RETRIES = 3;

/** Cuánto se espera antes de reintentar, para no reintentar sobre un fallo recién escrito. */
const RETRY_COOLDOWN_MS = 3 * 60_000;

/**
 * Reintenta SOLAS las filas fallidas de los lotes en curso.
 *
 * El lote corre de madrugada sin nadie mirando: si una fila se cae por algo transitorio
 * (el server se reinició y se perdió la sesión de Claude, el proxy de Instagram parpadeó,
 * una cuenta llegó a su límite), esperar a que alguien apriete "Reintentar" a la mañana
 * desperdicia toda la noche.
 *
 * ⚠️ NO borra el checkpoint, a diferencia del botón del tablero. Es la diferencia entre
 * retomar y regenerar: una fila que ya tiene su carrusel completo y solo falló al
 * renderizar vuelve directo al render, sin gastar otra vez los ~40 min de Claude.
 */
export async function retryFailedBatchRows(atMs: number = Date.now()): Promise<number> {
  const activos = (await listBatches()).filter((b) => b.status === "running");
  if (activos.length === 0) return 0;

  const { getRunner } = await import("./thirtyx-runner");
  const runner = getRunner();
  let reintentadas = 0;

  for (const batch of activos) {
    for (const fila of await listAssignmentsForBatch(batch.id)) {
      if (fila.status !== "failed") continue;
      if (fila.attempts >= MAX_AUTO_RETRIES) continue;
      if (atMs - Date.parse(fila.updatedAt) < RETRY_COOLDOWN_MS) continue;

      try {
        await setStatus(fila.jobId, "received", { error: null });
        runner.enqueue(fila.jobId, { force: true });
        reintentadas++;
        console.warn(
          `[lote] reintento automático de ${fila.jobId} (intento ${fila.attempts + 1}/${MAX_AUTO_RETRIES})`
        );
      } catch (err) {
        // Una fila que no se puede re-encolar no puede frenar a las demás.
        console.error(`[lote] no se pudo reintentar ${fila.jobId}:`, err);
      }
    }
  }
  return reintentadas;
}

/** Revisa si hay lotes vencidos y los despacha. Seguro de llamar en cualquier momento. */
export async function runDueBatches(atMs: number = Date.now()): Promise<number> {
  const due = await listDueBatches(atMs);
  let dispatched = 0;
  for (const batch of due) {
    try {
      dispatched += await dispatchBatch(batch);
    } catch (err) {
      // Un lote que revienta no puede impedir que arranquen los otros.
      console.error(`[lote] falló el despacho del lote ${batch.id}:`, err);
    }
  }
  return dispatched;
}

interface Scheduler {
  timer: NodeJS.Timeout;
}

const g = globalThis as unknown as { __ocBatchScheduler?: Scheduler };

/**
 * Arranca el despertador (idempotente). Lo llama `instrumentation.ts` al bootear.
 *
 * El tick se dispara UNA vez al arrancar además del intervalo: si el server estuvo
 * caído a las 20:00 y vuelve a las 20:30, el lote de esa noche tiene que salir ya, no
 * esperar al minuto siguiente ni perderse.
 */
export function startBatchScheduler(): void {
  if (g.__ocBatchScheduler) return;

  const tick = () => {
    void runDueBatches().catch((err) => {
      console.error("[lote] error en el ciclo del scheduler:", err);
    });
    // Auto-reparación: las filas que se cayeron por algo transitorio vuelven a la fila
    // solas. Va en su propio catch para que un fallo acá no impida despachar lotes nuevos.
    void retryFailedBatchRows().catch((err) => {
      console.error("[lote] error reintentando filas fallidas:", err);
    });
  };

  const timer = setInterval(tick, TICK_MS);
  // No mantiene vivo el proceso solo por este timer.
  timer.unref?.();
  g.__ocBatchScheduler = { timer };
  tick();
}

/** Detiene el despertador. Para tests y para un shutdown limpio. */
export function stopBatchScheduler(): void {
  if (!g.__ocBatchScheduler) return;
  clearInterval(g.__ocBatchScheduler.timer);
  delete g.__ocBatchScheduler;
}
