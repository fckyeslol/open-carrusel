import { NextRequest, NextResponse } from "next/server";
import { getAssignment, setStatus } from "@/lib/assignments";
import { getRunner } from "@/lib/thirtyx-runner";
import { isHostedMode } from "@/lib/hosted";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reintenta una asignación (failed/blocked): la vuelve a `received` y la re-encola.
 * Útil cuando lo que la bloqueaba se resolvió (ej. se cargó el ADN del avatar).
 * En modo hosteado solo la dueña del pedido puede reintentarlo.
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
  await setStatus(jobId, "received", { error: null });
  getRunner().enqueue(jobId, { force: true });
  return NextResponse.json({ ok: true, jobId });
}
