import { NextRequest, NextResponse } from "next/server";
import { getAssignment } from "@/lib/assignments";
import { getSessionUser } from "@/lib/auth";
import { isHostedMode } from "@/lib/hosted";
import { listReviewedOn, markReviewed } from "@/lib/reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Marca un pedido como REVISADO por la diseñadora logueada. No cambia el estado del
 * pedido ni toca Prewave: lo único que hace es sumar al contador del día.
 *
 * Es idempotente (ver reviews.ts), así que la UI puede reintentar sin miedo a inflar el
 * número. Devuelve la lista completa de lo revisado hoy para que el tablero se actualice
 * en el acto en vez de esperar al próximo poll.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  if (!isHostedMode()) {
    return NextResponse.json({ error: "Solo en modo hosteado" }, { status: 404 });
  }
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "No autenticada" }, { status: 401 });

  const { jobId } = await params;
  const a = await getAssignment(jobId);
  if (!a) return NextResponse.json({ error: "Pedido no encontrado" }, { status: 404 });
  // Mismo criterio que aprobar: solo la dueña del pedido puede marcarlo. Sin esto el
  // contador de otra diseñadora sería editable desde afuera.
  if (a.designerId !== user.id) {
    return NextResponse.json({ error: "Este pedido no es tuyo" }, { status: 403 });
  }

  const { counted, day } = await markReviewed(user.id, jobId);
  return NextResponse.json({
    ok: true,
    counted,
    day,
    reviewedToday: await listReviewedOn(user.id, day),
  });
}
