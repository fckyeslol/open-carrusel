import { NextResponse } from "next/server";
import { listJobs, PrewaveError, getPrewaveConfig, isConfigured } from "@/lib/prewave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bandeja de trabajos: lista los jobs `pending` de la cola de Prewave.
 * Con el JWT de la diseñadora devuelve SOLO los suyos (scope del backend).
 */
export async function GET() {
  const cfg = await getPrewaveConfig();
  if (!isConfigured(cfg)) {
    return NextResponse.json(
      { error: "Prewave sin configurar: cargá tu token en Ajustes 30x", jobs: [] },
      { status: 401 }
    );
  }
  try {
    const jobs = await listJobs("pending", "carousel_30x");
    return NextResponse.json({ jobs });
  } catch (e) {
    const status = e instanceof PrewaveError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message, jobs: [] }, { status });
  }
}
