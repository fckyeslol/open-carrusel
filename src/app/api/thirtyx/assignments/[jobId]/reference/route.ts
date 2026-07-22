import { NextResponse } from "next/server";
import { getAssignment, setReference } from "@/lib/assignments";
import { getRunner } from "@/lib/thirtyx-runner";
import { normalizeInstagramUrl } from "@/lib/instagram-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Asigna un referente de Instagram a mano a un job `needs_reference` (producción
 * manual de Prewave, que llega sin URL) y lo encola para generación.
 * Lo usa el campo "pegar referente" de la cola en /30x.
 */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;

  let body: { referenceUrl?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const normalized = normalizeInstagramUrl(body.referenceUrl?.trim() || "");
  if (!normalized) {
    return NextResponse.json(
      { error: "Pegá una URL de post o reel público de Instagram" },
      { status: 400 }
    );
  }

  const a = await getAssignment(jobId);
  if (!a) {
    return NextResponse.json({ error: "Asignación no encontrada" }, { status: 404 });
  }

  await setReference(jobId, normalized);
  getRunner().enqueue(jobId, { force: true });
  return NextResponse.json({ ok: true, jobId, referenceUrl: normalized });
}
