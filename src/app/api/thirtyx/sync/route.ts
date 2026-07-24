import { NextResponse } from "next/server";
import { listPendingJobs, getPrewaveConfig, isConfigured, PrewaveError } from "@/lib/prewave";
import { upsertFromAgentJob, listAssignments, pruneDesignOrphans } from "@/lib/assignments";
import { getRunner } from "@/lib/thirtyx-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sincroniza la cola local con Prewave (PULL): trae los jobs PENDIENTES de la
 * cola `agent_jobs` de la diseñadora (las solicitudes de "Generar 30x", scope por
 * su token), encola los nuevos para generación automática local y devuelve el
 * estado de todas sus asignaciones para pintar el panel.
 *
 * La UI llama a esto en intervalo. Es la parte "se llena solo" del modelo local:
 * no hay webhook — la app le pregunta a Prewave con el usuario de la diseñadora.
 * El claim (pending → processing) y el writeback lo hace el runner al procesar.
 */
export async function POST() {
  const cfg = await getPrewaveConfig();
  if (!isConfigured(cfg)) {
    return NextResponse.json(
      { error: "Prewave sin configurar: cargá tu token en la conexión de arriba", assignments: [] },
      { status: 401 }
    );
  }

  // Limpia huérfanos de Diseño que quedaron guardados de antes (ya no se ingieren).
  await pruneDesignOrphans();

  let pulled = 0;
  let enqueued = 0;
  try {
    const items = await listPendingJobs();
    pulled = items.length;
    for (const item of items) {
      const { isNew } = await upsertFromAgentJob(item);
      if (isNew) {
        getRunner().enqueue(item.jobId);
        enqueued++;
      }
    }
    // Auto-recuperación: re-encolá los `blocked` (avatar sin preset local). Si su ADN
    // ya se importó — o el bloqueo fue una lectura transitoria de GCS FUSE — el runner
    // los reintenta solo. preflightBlockReason es barato e idempotente: si el preset
    // sigue faltando, se re-bloquea sin reclamar ni tocar Prewave. Los `failed` (fallos
    // reales) NO se re-encolan: se reintentan a mano.
    for (const a of await listAssignments()) {
      if (a.status === "blocked") getRunner().enqueue(a.jobId);
    }
  } catch (e) {
    const status = e instanceof PrewaveError ? e.status : 500;
    return NextResponse.json(
      { error: (e as Error).message, assignments: await listAssignments() },
      { status }
    );
  }

  const assignments = await listAssignments();
  return NextResponse.json({ ok: true, pulled, enqueued, assignments });
}
