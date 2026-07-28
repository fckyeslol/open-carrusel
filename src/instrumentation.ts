/**
 * Hook de arranque de Next.js (`register`). Hace dos cosas al bootear:
 *
 *  1. Re-encola las asignaciones que quedaron "en vuelo" (received/claiming/ingesting/
 *     generating/rendering) por un reinicio a mitad de proceso — la cola es en memoria,
 *     pero el store en disco recuerda qué faltaba terminar.
 *  2. Arranca el despertador de los lotes nocturnos, que despacha los CSV programados
 *     cuando llega su hora.
 *
 * Los dos van en try/catch por separado: que falle la reconciliación no puede dejar sin
 * despertador a los lotes de esta noche, ni al revés.
 */
export async function register() {
  // Solo en el runtime Node (no en Edge): el runner usa Puppeteer + subprocess.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { getRunner } = await import("./lib/thirtyx-runner");
    await getRunner().reconcile();
  } catch (err) {
    console.error("[instrumentation] no se pudo reconciliar la cola 30x:", err);
  }
  try {
    const { startBatchScheduler } = await import("./lib/batch-scheduler");
    startBatchScheduler();
  } catch (err) {
    console.error("[instrumentation] no se pudo arrancar el scheduler de lotes:", err);
  }
}
