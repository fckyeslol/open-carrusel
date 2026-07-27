import { NextRequest, NextResponse } from "next/server";
import { getAssignment, setStatus, clearCheckpoint } from "@/lib/assignments";
import { getRunner } from "@/lib/thirtyx-runner";
import { isHostedMode } from "@/lib/hosted";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reintenta una asignación (failed/blocked): la vuelve a `received` y la re-encola.
 * Útil cuando lo que la bloqueaba se resolvió (ej. se cargó el ADN del avatar).
 * En modo hosteado solo la dueña del pedido puede reintentarlo.
 *
 * Por defecto BORRA el checkpoint de generación, porque este endpoint es el que respalda
 * el botón "Regenerar desde 0" y ese nombre es una promesa: sin borrarlo, el runner
 * retomaría el carrusel y la sesión de Claude anteriores y la diseñadora vería continuar
 * lo mismo que quiso descartar.
 *
 * Con `{ resume: true }` se conserva el checkpoint, para retomar un job que quedó a medias
 * sin repetir la ingesta ni el contexto de visión ya pagado.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const a = await getAssignment(jobId);
  if (!a) {
    return NextResponse.json({ error: "Asignación no encontrada" }, { status: 404 });
  }
  if (isHostedMode()) {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "No autenticada" }, { status: 401 });
    if (a.designerId !== user.id) {
      return NextResponse.json({ error: "Este pedido no es tuyo" }, { status: 403 });
    }
  }

  const body = await request.json().catch(() => ({}) as { resume?: boolean });
  const resume = body?.resume === true;
  if (!resume) await clearCheckpoint(jobId);

  await setStatus(jobId, "received", { error: null });
  getRunner().enqueue(jobId, { force: true });
  return NextResponse.json({ ok: true, jobId, resumed: resume });
}
