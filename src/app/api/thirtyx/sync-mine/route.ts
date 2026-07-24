import { NextRequest, NextResponse } from "next/server";
import { listPendingJobs, PrewaveError } from "@/lib/prewave";
import { upsertFromAgentJob, listAssignmentsForDesigner, pruneDesignOrphans } from "@/lib/assignments";
import { getRunner } from "@/lib/thirtyx-runner";
import { getSessionUser } from "@/lib/auth";
import { getPrewaveToken } from "@/lib/users";
import { isHostedMode } from "@/lib/hosted";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PULL per-diseñadora (modo hosteado): trae los jobs pendientes de la cola de la
 * usuaria logueada con SU token de Prewave, los encola para generar el BORRADOR
 * (token de Claude compartido) y devuelve solo SUS asignaciones. La UI hace poll
 * a esto en intervalo — cada diseñadora ve y drena su propia cola.
 */
export async function POST(request: NextRequest) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: "Solo en modo hosteado", assignments: [] }, { status: 404 });
  }
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "No autenticada", assignments: [] }, { status: 401 });
  }
  const token = await getPrewaveToken(user.id);
  if (!token) {
    return NextResponse.json(
      { error: "Tu cuenta de Prewave no está conectada. Avisá a un admin.", assignments: [] },
      { status: 409 }
    );
  }

  // Limpia huérfanos de Diseño que quedaron guardados de antes (ya no se ingieren).
  await pruneDesignOrphans();

  let pulled = 0;
  let enqueued = 0;
  try {
    const items = await listPendingJobs(token);
    pulled = items.length;
    for (const item of items) {
      const { isNew } = await upsertFromAgentJob(item, user.id);
      if (isNew) {
        getRunner().enqueue(item.jobId);
        enqueued++;
      }
    }
    // Auto-recuperación: re-encolá los `blocked` (avatar sin preset local). Si su ADN
    // ya se importó — o el bloqueo fue una lectura transitoria de GCS FUSE — el runner
    // los reintenta solo, sin que la diseñadora toque "Reintentar". preflightBlockReason
    // es barato e idempotente: si el preset sigue faltando, se re-bloquea sin reclamar
    // ni tocar Prewave. Los `failed` (fallos reales) NO se re-encolan: se reintentan a mano.
    for (const a of await listAssignmentsForDesigner(user.id)) {
      if (a.status === "blocked") getRunner().enqueue(a.jobId);
    }
  } catch (e) {
    const status = e instanceof PrewaveError ? e.status : 500;
    return NextResponse.json(
      { error: (e as Error).message, assignments: await listAssignmentsForDesigner(user.id) },
      { status }
    );
  }

  return NextResponse.json({
    ok: true,
    pulled,
    enqueued,
    assignments: await listAssignmentsForDesigner(user.id),
  });
}
