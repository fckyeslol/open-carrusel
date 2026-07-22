import { NextRequest, NextResponse } from "next/server";
import { ingestReference, buildGenerationMessage, toIngestErrorEvent } from "@/lib/thirtyx";
import { isInstagramUrl } from "@/lib/instagram";
import { sseResponse } from "@/lib/sse";
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
  let body: { referenceUrl?: string; avatarSlug?: string; name?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const referenceUrl = body.referenceUrl?.trim();
  const avatarSlug = body.avatarSlug?.trim();

  if (!referenceUrl || !isInstagramUrl(referenceUrl)) {
    return NextResponse.json(
      { error: "Pegá una URL válida de un post o reel de Instagram" },
      { status: 400 }
    );
  }
  if (!avatarSlug) {
    return NextResponse.json({ error: "Elegí un avatar" }, { status: 400 });
  }

  return sseResponse<IngestEvent>(
    async ({ send }) => {
      const result = await ingestReference({
        referenceUrl,
        avatarSlug,
        name: body.name,
        source: "manual",
        onProgress: send,
      });

      send({
        type: "done",
        carouselId: result.carousel.id,
        stylePresetId: result.preset.id,
        referenceCount: result.referenceCount,
        generationMessage: buildGenerationMessage(result.referenceCount),
      });
    },
    toIngestErrorEvent
  );
}
