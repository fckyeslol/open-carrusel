import { NextRequest, NextResponse } from "next/server";
import { getAssignment, restoreAssignment } from "@/lib/assignments";
import { isHostedMode } from "@/lib/hosted";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Saca un pedido de la Biblioteca y lo devuelve al tablero, al estado que tenía cuando
 * se eliminó (normalmente `pending_review`). No re-genera nada: el borrador y su
 * checkpoint quedaron intactos al archivar.
 */
export async function POST(
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

  if (a.status !== "archived") {
    return NextResponse.json({ error: "El pedido no está en la Biblioteca" }, { status: 409 });
  }

  const status = await restoreAssignment(jobId);
  return NextResponse.json({ ok: true, jobId, status });
}
