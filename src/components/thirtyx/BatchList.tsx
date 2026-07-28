"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Progress {
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
}

interface Batch {
  id: string;
  filename: string;
  uploadedByName: string | null;
  status: "scheduled" | "running" | "done" | "cancelled";
  scheduledFor: string;
  startedAt: string | null;
  rowCount: number;
  skipped: { line: number; reason: string }[];
  createdAt: string;
  progress: Progress;
}

/** Cada cuánto se refresca mientras hay un lote corriendo. */
const POLL_MS = 10_000;

const STATUS: Record<Batch["status"], { label: string; className: string }> = {
  scheduled: { label: "Programado", className: "border-border text-muted-foreground" },
  running: { label: "Generando", className: "border-accent/40 text-accent-strong" },
  done: { label: "Terminado", className: "border-emerald-500/40 text-emerald-600" },
  cancelled: { label: "Cancelado", className: "border-border text-muted-foreground" },
};

/** "esta noche a las 20:00" / "mañana a las 20:00" — no un timestamp ISO. */
function scheduleLabel(iso: string): string {
  const when = new Date(iso);
  const now = new Date();
  const hhmm = when.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  const sameDay = when.toDateString() === now.toDateString();
  if (sameDay) return `hoy ${hhmm}`;

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (when.toDateString() === tomorrow.toDateString()) return `mañana ${hhmm}`;

  return `${when.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "short" })} ${hhmm}`;
}

export interface BatchListProps {
  /** Cambia cuando se crea un lote nuevo, para recargar sin hacer poll siempre. */
  refreshKey?: number;
}

/**
 * Lista de lotes con su progreso.
 *
 * Solo hace poll cuando hay alguno corriendo: un tablero que pregunta cada 10 segundos
 * toda la tarde, para mostrar un lote que recién arranca a las 20:00, es puro ruido.
 */
export function BatchList({ refreshKey = 0 }: BatchListProps) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/thirtyx/batches");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "No se pudieron cargar los lotes");
      setBatches(data.batches || []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const anyRunning = batches.some((b) => b.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [anyRunning, load]);

  const act = useCallback(
    async (id: string, method: "POST" | "DELETE") => {
      setActing(id);
      try {
        const res = await fetch(`/api/thirtyx/batches/${id}`, { method });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "No se pudo completar la acción");
        setError(null);
        await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setActing(null);
      }
    },
    [load]
  );

  if (batches.length === 0 && !error) return null;

  return (
    <div className="mt-5 space-y-3">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {batches.map((b) => {
        const info = STATUS[b.status];
        const p = b.progress;
        const finished = p.done + p.failed;
        const pct = p.total > 0 ? Math.round((finished / p.total) * 100) : 0;

        return (
          <div key={b.id} className="rounded-lg border border-border bg-background p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                  info.className
                )}
              >
                {b.status === "running" && (
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-current"
                  />
                )}
                {info.label}
              </span>

              <span className="min-w-0 flex-1 truncate text-sm font-medium">{b.filename}</span>

              <span className="shrink-0 text-xs text-muted-foreground">
                {b.status === "scheduled"
                  ? `arranca ${scheduleLabel(b.scheduledFor)}`
                  : `${p.total} ${p.total === 1 ? "carrusel" : "carruseles"}`}
              </span>

              {b.status === "scheduled" && (
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={acting === b.id}
                    onClick={() => act(b.id, "POST")}
                  >
                    Correr ahora
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={acting === b.id}
                    onClick={() => act(b.id, "DELETE")}
                  >
                    Cancelar
                  </Button>
                </div>
              )}
            </div>

            {/* Barra de avance: solo tiene sentido una vez que arrancó. */}
            {b.status !== "scheduled" && b.status !== "cancelled" && (
              <div className="mt-3">
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full bg-border"
                  role="progressbar"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Avance del lote ${b.filename}`}
                >
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {p.done} listos
                  {p.failed > 0 && <span className="text-destructive"> · {p.failed} fallaron</span>}
                  {p.running > 0 && <span> · {p.running} generando</span>}
                  {p.pending > 0 && <span> · {p.pending} en espera</span>}
                </p>
              </div>
            )}

            {b.skipped.length > 0 && (
              <p className="mt-2 text-xs text-amber-600">
                {b.skipped.length} {b.skipped.length === 1 ? "fila descartada" : "filas descartadas"}{" "}
                al subir el archivo
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
