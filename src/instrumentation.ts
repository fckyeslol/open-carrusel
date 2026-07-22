/**
 * Hook de arranque de Next.js (`register`). Al bootear el servidor, re-encola las
 * asignaciones que quedaron "en vuelo" (received/claiming/ingesting/generating/
 * rendering) por un reinicio a mitad de proceso — la cola es en memoria, pero el
 * store en disco recuerda qué faltaba terminar.
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
}
