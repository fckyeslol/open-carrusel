import { NextResponse } from "next/server";
import { listDesignQueue, getPrewaveConfig, isConfigured, PrewaveError } from "@/lib/prewave";
import { upsertFromDesignItem, setStatus, listAssignments } from "@/lib/assignments";
import { getRunner } from "@/lib/thirtyx-runner";
import { isInstagramUrl } from "@/lib/instagram-url";

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
      const { assignment, isNew } = await upsertFromDesignItem(item);
      // Briefs de producción manual (source_type "manual") llegan sin URL de post:
      // no son referentes de IG para calcar. No los encolamos ni los fallamos: los
      // dejamos en `needs_reference` para que la diseñadora pegue un referente a
      // mano. Chequeamos el referente GUARDADO (no el del item) para no pisar una
      // URL que ella ya haya cargado aunque Prewave siga mandando el brief vacío.
      if (!isInstagramUrl(assignment.referenceUrl)) {
        // Sanea también los que quedaron en `failed`/`received` vacíos de versiones
        // previas; nunca toca los ya generados/entregados a mano.
        if (
          assignment.status !== "needs_reference" &&
          assignment.status !== "done" &&
          assignment.status !== "delivered"
        ) {
          await setStatus(item.jobId, "needs_reference", { error: null });
        }
        continue;
      }
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
