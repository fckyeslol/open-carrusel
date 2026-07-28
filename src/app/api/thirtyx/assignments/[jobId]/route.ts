import { NextRequest, NextResponse } from "next/server";
import {
  getAssignment,
  archiveAssignment,
  archiveCancelled,
  isArchivable,
} from "@/lib/assignments";
import { cancel } from "@/lib/job-queue";
import { isHostedMode } from "@/lib/hosted";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Motivo que queda guardado cuando se elimina algo que se estaba generando. */
const CANCEL_REASON = "Cancelado desde el tablero mientras se generaba.";

/**
 * "Eliminar" un pedido del tablero: lo manda a la Biblioteca (status `archived`).
 *
 * No borra el registro a propósito — ver `archiveAssignment`: el pull de Prewave
 * re-encolaría el brief si desapareciera de la base local. Desde /biblioteca se puede
 * devolver al tablero con POST .../restore.
 *
 * Si el pedido está EN VUELO (en cola o generándose) primero se lo saca del carril: la
 * columna "Generando" es justo la que más necesita un "eliminar" —una cola de pedidos que
 * ya no interesan bloquea el único carril— y hacer esperar a que termine algo que se
 * quiere descartar no tiene sentido.
 *
 * Tampoco toca Prewave: el brief sigue igual allá (queda `processing` si ya se había
 * reclamado). Es una acción sobre EL TABLERO de la diseñadora, no sobre la asignación de
 * Prewave — igual que la cancelación desde la cola, que tampoco hace writeback.
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

  if (isArchivable(a.status)) {
    await archiveAssignment(jobId);
    return NextResponse.json({ ok: true, jobId, archived: true, cancelled: false });
  }

  // En vuelo: cortar primero, archivar después. `cancel` saca de la fila lo que espera y
  // aborta lo que está corriendo (el AbortSignal mata el subproceso de Claude). Devuelve
  // false si el carril no lo conoce —un `received` que todavía no se encoló, o un job que
  // corre en otra instancia—; se archiva igual, porque `processAssignment` no procesa
  // pedidos archivados y el guard de `setStatus` bloquea los estados que llegan tarde.
  const cutFromLane = cancel(jobId);
  await archiveCancelled(jobId, CANCEL_REASON);
  return NextResponse.json({ ok: true, jobId, archived: true, cancelled: true, cutFromLane });
}
