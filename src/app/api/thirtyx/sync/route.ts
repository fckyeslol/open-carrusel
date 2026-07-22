import { NextResponse } from "next/server";
import { listDesignQueue, getPrewaveConfig, isConfigured, PrewaveError } from "@/lib/prewave";
import { upsertFromDesignItem, listAssignments } from "@/lib/assignments";
import { getRunner } from "@/lib/thirtyx-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sincroniza la cola local con Prewave (PULL): trae la BANDEJA DE DISEÑO de la
 * diseñadora (sus carruseles en `por_disenar`, scope por su token), encola los
 * nuevos para generación automática local y devuelve el estado de todas sus
 * asignaciones para pintar el panel.
 *
 * La UI llama a esto en intervalo. Es la parte "se llena solo" del modelo local:
 * no hay webhook — la app le pregunta a Prewave con el usuario de la diseñadora.
 */
export async function POST() {
  const cfg = await getPrewaveConfig();
  if (!isConfigured(cfg)) {
    return NextResponse.json(
      { error: "Prewave sin configurar: cargá tu token en la conexión de arriba", assignments: [] },
      { status: 401 }
    );
  }

  let pulled = 0;
  let enqueued = 0;
  try {
    const items = await listDesignQueue();
    pulled = items.length;
    for (const item of items) {
      const { isNew } = await upsertFromDesignItem(item);
      if (isNew) {
        getRunner().enqueue(item.jobId);
        enqueued++;
      }
    }
  } catch (e) {
    const status = e instanceof PrewaveError ? e.status : 500;
    return NextResponse.json(
      { error: (e as Error).message, assignments: await listAssignments() },
      { status }
    );
  }

  const assignments = await listAssignments();
  return NextResponse.json({ ok: true, pulled, enqueued, assignments });
}
