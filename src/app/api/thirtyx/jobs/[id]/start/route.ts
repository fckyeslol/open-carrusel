import { NextResponse } from "next/server";
import { claimJob, failJob, PrewaveError, listJobs } from "@/lib/prewave";
import { ingestReference, buildGenerationMessage, toIngestErrorEvent } from "@/lib/thirtyx";
import { isInstagramUrl } from "@/lib/instagram";
import { sseResponse } from "@/lib/sse";
import type { IngestEvent } from "@/types/ingest-progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * INGESTA DESDE LA COLA (la actual): reclama el job (pending → processing), baja
 * el referente y crea el carrusel con el avatar que el backend ya resolvió
 * (avatar_slug por FK). Reusa exactamente la misma cola que drenaba el worker de
 * Canva — no se toca el backend de Prewave.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Recuperar el job de la cola pending para tener su reference_url + avatar_slug.
  let job;
  try {
    const jobs = await listJobs("pending", "carousel_30x");
    job = jobs.find((j) => j.id === id);
    // También puede estar ya en processing si se reintenta; buscarlo ahí.
    if (!job) {
      const processing = await listJobs("processing", "carousel_30x");
      job = processing.find((j) => j.id === id);
    }
  } catch (e) {
    const status = e instanceof PrewaveError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
  if (!job) {
    return NextResponse.json({ error: "Job no encontrado en tu cola" }, { status: 404 });
  }

  const referenceUrl = job.reference_url;
  const avatarSlug = job.avatar_slug;

  if (!referenceUrl || !isInstagramUrl(referenceUrl)) {
    return NextResponse.json(
      { error: `El job no tiene un referente de Instagram válido (${referenceUrl ?? "vacío"})` },
      { status: 422 }
    );
  }
  if (!avatarSlug) {
    return NextResponse.json(
      { error: "El job no trae avatar_slug resuelto (¿job legacy de Diseño?). Usá la entrada manual." },
      { status: 422 }
    );
  }

  // Claim: pending → processing (con el mismo token; el backend valida ownership).
  try {
    await claimJob(id);
  } catch (e) {
    const status = e instanceof PrewaveError ? e.status : 500;
    return NextResponse.json(
      { error: `No se pudo reclamar el job: ${(e as Error).message}` },
      { status }
    );
  }

  return sseResponse<IngestEvent>(
    async ({ send }) => {
      try {
        const result = await ingestReference({
          referenceUrl,
          avatarSlug,
          name: job.avatar_name ? `${job.avatar_name} — job ${id.slice(0, 8)}` : undefined,
          prewaveJobId: id,
          source: "queue",
          onProgress: send,
        });
        send({
          type: "done",
          carouselId: result.carousel.id,
          stylePresetId: result.preset.id,
          referenceCount: result.referenceCount,
          generationMessage: buildGenerationMessage(result.referenceCount),
        });
      } catch (e) {
        // Si la ingesta falla, devolver el job a failed para no dejarlo colgado
        // en processing. Se re-lanza para que sseResponse emita el evento error.
        await failJob(id, (e as Error).message).catch(() => {});
        throw e;
      }
    },
    toIngestErrorEvent
  );
}
