/**
 * Un lote: ver su detalle (GET), forzar el arranque (POST) o cancelarlo (DELETE).
 *
 * "Forzar el arranque" no es una vía paralela: adelanta la hora del lote y llama al
 * mismo despachador que usa el scheduler, para que no puedan divergir.
 */
import { NextRequest, NextResponse } from "next/server";
import { getBatch, cancelBatch, batchProgress, dispatchNow } from "@/lib/batches";
import { listAssignmentsForBatch } from "@/lib/assignments";
import { runDueBatches } from "@/lib/batch-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const batch = await getBatch(id);
  if (!batch) return NextResponse.json({ error: "Lote no encontrado" }, { status: 404 });

  const rows = await listAssignmentsForBatch(id);
  return NextResponse.json({
    ok: true,
    batch,
    progress: batchProgress(rows),
    rows: rows.map((r) => ({
      jobId: r.jobId,
      referenceUrl: r.referenceUrl,
      avatarName: r.avatarName,
      status: r.status,
      carouselId: r.carouselId,
      error: r.error,
      higgsfield: r.higgsfield ?? null,
    })),
  });
}

/** Corre el lote AHORA, sin esperar la ventana nocturna. */
export async function POST(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const batch = await getBatch(id);
  if (!batch) return NextResponse.json({ error: "Lote no encontrado" }, { status: 404 });
  if (batch.status !== "scheduled") {
    return NextResponse.json(
      { error: `El lote ya está en estado "${batch.status}".` },
      { status: 409 }
    );
  }

  // Adelantar la hora y despachar por el MISMO camino que el scheduler, en vez de tener
  // una segunda vía que pueda comportarse distinto. Además deja el store consistente: si
  // el proceso muere entre una cosa y la otra, el lote queda vencido en disco y el
  // próximo tick lo levanta solo.
  await dispatchNow(id);
  const dispatched = await runDueBatches();

  return NextResponse.json({ ok: true, dispatched });
}

/** Cancela un lote que todavía no arrancó. */
export async function DELETE(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const batch = await getBatch(id);
  if (!batch) return NextResponse.json({ error: "Lote no encontrado" }, { status: 404 });

  const cancelled = await cancelBatch(id);
  if (!cancelled) {
    return NextResponse.json(
      {
        error:
          "El lote ya arrancó. Cancelá los pedidos que siguen en curso desde el tablero.",
      },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}
