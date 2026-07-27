import { NextRequest, NextResponse } from "next/server";
import { getManualEntry, deleteManualEntry } from "@/lib/manual-entries";
import { getSessionUser } from "@/lib/auth";
import { isHostedMode } from "@/lib/hosted";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Saca una entrada del historial manual. NO borra el carrusel que haya creado:
 * el historial es una bitácora de pedidos, no el dueño del entregable — para
 * borrar el carrusel está DELETE /api/carousels/[id].
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const entry = await getManualEntry(id);
  if (!entry) {
    return NextResponse.json({ error: "Entrada no encontrada" }, { status: 404 });
  }
  if (isHostedMode()) {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "No autenticada" }, { status: 401 });
    // Las entradas sin dueña son del equipo (sembradas de carruseles viejos):
    // cualquiera puede limpiarlas. Las de otra diseñadora, no.
    if (entry.designerId !== null && entry.designerId !== user.id) {
      return NextResponse.json({ error: "Esta entrada no es tuya" }, { status: 403 });
    }
  }
  await deleteManualEntry(id);
  return NextResponse.json({ ok: true, id });
}
