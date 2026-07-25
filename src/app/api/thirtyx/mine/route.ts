import { NextRequest, NextResponse } from "next/server";
import { listAssignmentsForDesigner } from "@/lib/assignments";
import { getSessionUser } from "@/lib/auth";
import { isHostedMode } from "@/lib/hosted";

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
 */
export async function GET(request: NextRequest) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: "Solo en modo hosteado", assignments: [] }, { status: 404 });
  }
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "No autenticada", assignments: [] }, { status: 401 });
  }
  return NextResponse.json({ assignments: await listAssignmentsForDesigner(user.id) });
}
