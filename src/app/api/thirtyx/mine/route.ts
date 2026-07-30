import { NextRequest, NextResponse } from "next/server";
import { listAssignmentsForDesigner } from "@/lib/assignments";
import { getSessionUser } from "@/lib/auth";
import { isHostedMode } from "@/lib/hosted";
import { listReviewedOn } from "@/lib/reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lectura RÁPIDA de las asignaciones de la diseñadora: solo lee la base local
 * (data/thirtyx-assignments.json), sin tocar Prewave. Es lo que la UI pollea para
 * pintar y refrescar el estado en vivo — instantáneo.
 *
 * El trabajo pesado (pull del design-queue + enqueue-30x de briefs nuevos) vive en
 * POST /api/thirtyx/sync-mine, que la UI dispara aparte y en background con menor
 * frecuencia, para no atar el render a los round-trips de Prewave.
 *
 * Las revisiones del día viajan en ESTA misma respuesta y no en un endpoint aparte: el
 * tablero las necesita en cada pintada (para el contador y para saber qué botón ya está
 * marcado) y son una lista de strings. Un segundo request al mismo ritmo del poll sería
 * duplicar el tráfico contra Cloud Run para traer unos pocos bytes.
 */
export async function GET(request: NextRequest) {
  if (!isHostedMode()) {
    return NextResponse.json(
      { error: "Solo en modo hosteado", assignments: [], reviewedToday: [] },
      { status: 404 }
    );
  }
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json(
      { error: "No autenticada", assignments: [], reviewedToday: [] },
      { status: 401 }
    );
  }
  const [assignments, reviewedToday] = await Promise.all([
    listAssignmentsForDesigner(user.id),
    listReviewedOn(user.id),
  ]);
  return NextResponse.json({ assignments, reviewedToday });
}
