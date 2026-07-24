import { NextRequest, NextResponse } from "next/server";
import { listDesignQueue, enqueue30x, PrewaveError } from "@/lib/prewave";
import {
  upsertFromAgentJob,
  listAssignmentsForDesigner,
  pruneDesignOrphans,
} from "@/lib/assignments";
import { getRunner } from "@/lib/thirtyx-runner";
import { getSessionUser } from "@/lib/auth";
import { getPrewaveToken } from "@/lib/users";
import { isHostedMode } from "@/lib/hosted";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Cuántos briefs NUEVOS se encolan por sync. Evita disparar todo el backlog (una
 * diseñadora puede tener 45+) de golpe: se rampea a lo largo de varios ciclos de
 * poll, y el runner igual procesa de a maxConcurrent.
 */
const MAX_ENQUEUE_PER_SYNC = 8;

/**
 * PULL per-diseñadora (modo hosteado). Fuente = design-queue (su backlog real de
 * carruseles por diseñar: content_format='carrusel', status por_editar/por_corregir,
 * assigned_editor_id = ella, con post scrapeado). Por cada brief que aún no tiene
 * asignación local, encola "Generar 30x" en Prewave (POST enqueue-30x; idempotente:
 * 409 devuelve el job existente; 422 = sin referente → saltar), crea la asignación
 * local y la manda a generar con el token de Claude compartido. La UI hace poll acá.
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

  let enqueued = 0;
  let skipped = 0;
  try {
    const briefs = await listDesignQueue(token);
    const mine = await listAssignmentsForDesigner(user.id);
    const known = new Set(mine.map((a) => a.briefId).filter(Boolean));

    for (const brief of briefs) {
      if (brief.briefId && known.has(brief.briefId)) continue; // ya encolado antes
      if (enqueued >= MAX_ENQUEUE_PER_SYNC) break; // rampa gradual del backlog

      try {
        const res = await enqueue30x(brief.briefId, token);
        if (!res) {
          skipped++; // 422/404: sin referente o no-carrusel
          continue;
        }
        // El agent_job de enqueue-30x NO serializa el avatar (viene null); lo
        // tomamos del brief del design-queue, que sí lo trae resuelto.
        const job = {
          ...res.job,
          avatarId: res.job.avatarId ?? brief.avatarId,
          avatarSlug: res.job.avatarSlug || brief.avatarSlug,
          avatarName: res.job.avatarName ?? brief.avatarName,
        };
        const { isNew } = await upsertFromAgentJob(job, user.id);
        if (brief.briefId) known.add(brief.briefId);
        if (isNew) {
          getRunner().enqueue(res.job.jobId);
          enqueued++;
        }
      } catch {
        // un brief que falla no debe tumbar el sync entero
        skipped++;
      }
    }

    // Auto-recuperación: re-encolá los `blocked` (avatar sin preset local). Si su ADN
    // ya se importó — o el bloqueo fue una lectura transitoria de GCS FUSE — el runner
    // los reintenta solo. preflightBlockReason es barato e idempotente: si el preset
    // sigue faltando, se re-bloquea sin reclamar ni tocar Prewave. Los `failed` NO.
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
    enqueued,
    skipped,
    assignments: await listAssignmentsForDesigner(user.id),
  });
}
