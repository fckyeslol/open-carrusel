import { NextRequest, NextResponse } from "next/server";
import { getAssignment, archiveAssignment, isArchivable } from "@/lib/assignments";
import { isHostedMode } from "@/lib/hosted";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Eliminar" un pedido del tablero: lo manda a la Biblioteca (status `archived`).
 *
 * No borra el registro a propósito — ver `archiveAssignment`: el pull de Prewave
 * re-encolaría el brief si desapareciera de la base local. Desde /biblioteca se puede
 * devolver al tablero con POST .../restore.
 *
 * Tampoco toca Prewave: el brief sigue igual allá. Es una acción sobre EL TABLERO de la
 * diseñadora, no sobre la asignación de Prewave.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const a = await getAssignment(jobId);
  if (!a) return NextResponse.json({ error: "Pedido no encontrado" }, { status: 404 });

  if (isHostedMode()) {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "No autenticada" }, { status: 401 });
    if (a.designerId !== user.id) {
      return NextResponse.json({ error: "Este pedido no es tuyo" }, { status: 403 });
    }
  }

  if (!isArchivable(a.status)) {
    return NextResponse.json(
      { error: "El pedido se está generando; esperá a que termine para eliminarlo" },
      { status: 409 }
    );
  }

  await archiveAssignment(jobId);
  return NextResponse.json({ ok: true, jobId, archived: true });
}
