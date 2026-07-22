import { NextResponse } from "next/server";
import { getAssignment, setStatus } from "@/lib/assignments";
import { getRunner } from "@/lib/thirtyx-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reintenta una asignación fallida: la vuelve a `received` y la re-encola.
 * Usado por el botón "Reintentar" de la cola cuando un job quedó en `failed`.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const a = await getAssignment(jobId);
  if (!a) {
    return NextResponse.json({ error: "Asignación no encontrada" }, { status: 404 });
  }
  await setStatus(jobId, "received", { error: null });
  getRunner().enqueue(jobId, { force: true });
  return NextResponse.json({ ok: true, jobId });
}
