import { NextRequest, NextResponse } from "next/server";
import { ingestReference, buildGenerationMessage, toIngestErrorEvent } from "@/lib/thirtyx";
import { isInstagramUrl } from "@/lib/instagram";
import { sseResponse } from "@/lib/sse";
import { getPresetByAvatarSlug } from "@/lib/style-presets";
import {
  createManualEntry,
  completeManualEntry,
  failManualEntry,
} from "@/lib/manual-entries";
import { getSessionUser } from "@/lib/auth";
import { isHostedMode } from "@/lib/hosted";
import type { IngestEvent } from "@/types/ingest-progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * ENTRADA MANUAL: la diseñadora pega una URL de Instagram + elige avatar.
 * Descarga el referente, crea el carrusel con el preset del avatar y devuelve el
 * id + el mensaje de generación (que la UI dispara contra el chat / Claude local).
 *
 * Responde en dos modos:
 *  - Errores de validación (antes de empezar) → JSON con status 4xx.
 *  - Ingesta en curso → stream SSE de `IngestEvent`, porque el trabajo tarda
 *    hasta 2 minutos y la UI necesita mostrar en qué etapa va.
 */
export async function POST(request: NextRequest) {
  let body: { referenceUrl?: string; avatarSlug?: string; name?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const referenceUrl = body.referenceUrl?.trim();
  const avatarSlug = body.avatarSlug?.trim();
  // Anotación libre de la diseñadora; se recorta para no inflar el mensaje de
  // generación con un pegado accidental de miles de caracteres.
  const note =
    typeof body.note === "string" ? body.note.trim().slice(0, 2000) || undefined : undefined;

  if (!referenceUrl || !isInstagramUrl(referenceUrl)) {
    return NextResponse.json(
      { error: "Pegá una URL válida de un post o reel de Instagram" },
      { status: 400 }
    );
  }
  if (!avatarSlug) {
    return NextResponse.json({ error: "Elegí un avatar" }, { status: 400 });
  }

  // El historial se anota ANTES de empezar: si la ingesta revienta (o se cierra
  // la pestaña), la URL y el avatar quedan guardados igual y se puede reintentar
  // sin volver a buscar el post en Instagram.
  const designerId = isHostedMode() ? (await getSessionUser(request))?.id ?? null : null;
  const entry = await createManualEntry({
    referenceUrl,
    avatarSlug,
    avatarName: (await getPresetByAvatarSlug(avatarSlug))?.name ?? null,
    note,
    designerId,
  });

  return sseResponse<IngestEvent>(
    async ({ send }) => {
      // Se recuerda por si la ingesta falla DESPUÉS de crear el carrusel: el
      // historial igual puede enlazarlo (queda a medias, pero se puede abrir).
      let carouselId: string | null = null;

      let result;
      try {
        result = await ingestReference({
          referenceUrl,
          avatarSlug,
          name: body.name,
          source: "manual",
          onProgress: send,
          onCarouselCreated: (c) => {
            carouselId = c.id;
          },
        });
      } catch (error) {
        const event = toIngestErrorEvent(error);
        await failManualEntry(entry.id, {
          stage: event.stage,
          message: event.message,
          carouselId,
        });
        throw error; // sseResponse lo convierte en el evento final para la UI
      }

      await completeManualEntry(entry.id, {
        carouselId: result.carousel.id,
        referenceCount: result.referenceCount,
        avatarName: result.preset.name,
      });

      send({
        type: "done",
        carouselId: result.carousel.id,
        stylePresetId: result.preset.id,
        referenceCount: result.referenceCount,
        generationMessage: buildGenerationMessage(result.referenceCount, note),
      });
    },
    toIngestErrorEvent
  );
}
