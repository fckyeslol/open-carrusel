/**
 * Lotes nocturnos: subir el CSV (POST) y listar los lotes con su progreso (GET).
 *
 * El POST tiene dos modos, y el de vista previa es el que hace que esto sea usable:
 * `preview: true` parsea y resuelve TODO sin escribir nada, así la diseñadora ve qué se
 * va a generar y qué se descartó antes de confirmar. Sin eso, un CSV con la columna
 * Avenger mal escrita se descubriría recién a la mañana siguiente, con 40 carruseles
 * sin generar.
 */
import { NextRequest, NextResponse } from "next/server";
import { intakeCsv, previewCsv } from "@/lib/batch-intake";
import { listBatches, batchProgress } from "@/lib/batches";
import { listAssignmentsForBatch } from "@/lib/assignments";
import { runDueBatches } from "@/lib/batch-scheduler";
import { getSessionUser } from "@/lib/auth";
import { isHostedMode } from "@/lib/hosted";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tope del archivo. Un CSV de 500 filas no llega ni a 100 KB. */
const MAX_BYTES = 1_000_000;

/** Lee el CSV venga como multipart (input file) o como texto plano en el body. */
async function readCsv(
  request: NextRequest
): Promise<{ text: string; filename: string } | { error: string }> {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return { error: "Subí un archivo .csv" };
    if (file.size > MAX_BYTES) return { error: "El archivo es demasiado grande (máx. 1 MB)." };
    return { text: await file.text(), filename: file.name || "lote.csv" };
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body.csv !== "string") {
    return { error: "Mandá el CSV como archivo o en el campo `csv`." };
  }
  if (body.csv.length > MAX_BYTES) {
    return { error: "El archivo es demasiado grande (máx. 1 MB)." };
  }
  return { text: body.csv, filename: typeof body.filename === "string" ? body.filename : "lote.csv" };
}

export async function POST(request: NextRequest) {
  // El modo se lee de la query para no tener que consumir el body dos veces (el body
  // puede ser un stream multipart, que solo se puede leer una vez).
  const url = new URL(request.url);
  const isPreview = url.searchParams.get("preview") === "1";
  const runNow = url.searchParams.get("run") === "now";

  const read = await readCsv(request).catch((e) => ({ error: (e as Error).message }));
  if ("error" in read) return NextResponse.json({ error: read.error }, { status: 400 });

  if (isPreview) {
    return NextResponse.json({ ok: true, preview: await previewCsv(read.text) });
  }

  const user = isHostedMode() ? await getSessionUser(request) : null;
  if (isHostedMode() && !user) {
    return NextResponse.json({ error: "No autenticada" }, { status: 401 });
  }

  const { batch, preview } = await intakeCsv(read.text, {
    filename: read.filename,
    uploadedBy: user?.id ?? null,
    uploadedByName: user?.displayName ?? null,
    runNow,
  });

  if (preview.rows.length === 0) {
    return NextResponse.json(
      {
        error:
          "Ninguna fila del archivo se pudo usar. Revisá las columnas URL y Avenger.",
        batch,
        preview,
      },
      { status: 422 }
    );
  }

  // "Correr ahora" despacha por el MISMO camino que el scheduler (el lote quedó
  // programado en el pasado), así no hay una segunda vía que pueda comportarse distinto.
  if (runNow) await runDueBatches();

  return NextResponse.json({ ok: true, batch, preview });
}

export async function GET(request: NextRequest) {
  const all = await listBatches();

  // En hosteado cada diseñadora ve los lotes que ELLA subió. El trabajo en sí ya está
  // scopeado por `designerId` en el tablero; esto es solo la bitácora de subidas.
  const user = isHostedMode() ? await getSessionUser(request) : null;
  const visible = user ? all.filter((b) => b.uploadedBy === user.id) : all;

  const batches = await Promise.all(
    visible.map(async (b) => ({
      ...b,
      progress: batchProgress(await listAssignmentsForBatch(b.id)),
    }))
  );

  return NextResponse.json({ ok: true, batches });
}
