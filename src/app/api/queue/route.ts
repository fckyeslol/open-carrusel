import { NextRequest, NextResponse } from "next/server";
import { snapshot, LANE_TUNING } from "@/lib/job-queue";
import { resumen } from "@/lib/telemetry";
import { poolStats } from "@/lib/browser-pool";
import { isHostedMode } from "@/lib/hosted";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Estado del carril de trabajos: qué está corriendo y qué espera, con su puesto.
 *
 * Es la ventana a la serialización. Antes no había forma de saber por qué un pedido "no
 * arrancaba": el modelo no podía expresar "esperando" (el estado `received` se pintaba
 * como trabajo activo), así que una cola de 4 parecía 4 generaciones en curso.
 *
 * Se devuelve la política además del estado para que la UI pueda explicar por qué algo es
 * o no preemptable, sin duplicar esos números en el cliente.
 */
export async function GET(request: NextRequest) {
  if (isHostedMode()) {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "No autenticada" }, { status: 401 });
  }

  return NextResponse.json({
    ...snapshot(),
    tuning: {
      minQuantumMs: LANE_TUNING.MIN_QUANTUM_MS,
      maxPreemptions: LANE_TUNING.MAX_PREEMPTIONS,
      stickyHoldMs: LANE_TUNING.STICKY_HOLD_MS,
      preemptiblePhases: [...LANE_TUNING.PREEMPTIBLE_PHASES],
    },
    // Contadores desde que arrancó el proceso: cuánto se espera en la cola, cuántas
    // preempciones hubo, y si los renders están fallando (con los últimos motivos). Es lo
    // que permite responder "¿anda bien?" sin abrir Cloud Logging.
    metricas: resumen(),
    // Chrome de ESTA instancia. En hosteado debería estar abajo salvo durante una ingesta
    // de Instagram, que es lo único que todavía abre navegador acá.
    navegador: poolStats(),
  });
}
