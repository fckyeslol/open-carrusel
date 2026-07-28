"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AssignmentThumb } from "@/components/thirtyx/AssignmentThumb";
import { BoardHeader } from "@/components/thirtyx/BoardHeader";

interface Assignment {
  jobId: string;
  avatarSlug: string;
  avatarName: string | null;
  referenceUrl: string;
  status: string;
  carouselId: string | null;
  archivedAt?: string;
  updatedAt: string;
}

function shortAvatar(name: string | null, slug: string): string {
  return (name || slug || "Sin avatar").replace(/^30X\s*[—–-]\s*/i, "").trim();
}

function refHost(url: string): string {
  return (url || "").replace(/^https?:\/\/(www\.)?/, "").slice(0, 40);
}

/** "27 jul, 14:32" — corto, porque la fecha acá es solo para ordenarse mentalmente. */
function shortDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("es-CO", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Biblioteca: el historial de la diseñadora. Lo que eliminó del tablero (y puede
 * restaurar) y lo que ya entregó a Prewave.
 *
 * Lee el mismo GET /api/thirtyx/mine que el tablero y filtra por estado — la Biblioteca
 * no es otra base de datos, es otra vista de la misma. Sin poll: es historial, no cambia
 * solo mientras se mira.
 */
export function Library() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/thirtyx/mine");
      let data: { error?: string; assignments?: Assignment[] } = {};
      try {
        data = await res.json();
      } catch {
        /* cuerpo no-JSON (p. ej. página de error del proxy) */
      }
      if (!res.ok) {
        setError(data.error || "No se pudo cargar la biblioteca");
        return;
      }
      setError(null);
      setAssignments(data.assignments || []);
    } catch {
      setError("Error de red al cargar");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const restore = useCallback(
    async (jobId: string) => {
      if (busyRef.current.has(jobId)) return;
      busyRef.current.add(jobId);
      setError(null);
      try {
        const res = await fetch(`/api/thirtyx/assignments/${jobId}/restore`, { method: "POST" });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setError(d.error || "No se pudo restaurar el pedido");
        }
        await load();
      } finally {
        busyRef.current.delete(jobId);
      }
    },
    [load]
  );

  const eliminados = assignments.filter((a) => a.status === "archived");
  const entregados = assignments.filter((a) => a.status === "delivered" || a.status === "done");

  return (
    <main className="min-h-screen bg-muted/20">
      <BoardHeader active="biblioteca" />

      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Biblioteca</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            El historial de tus pedidos: los que eliminaste del tablero y los que ya entregaste.
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <Section
          title="Eliminados"
          count={eliminados.length}
          empty={
            loaded
              ? "Todavía no eliminaste ningún pedido. Los que elimines del tablero aparecen acá."
              : "Cargando…"
          }
        >
          {eliminados.map((a) => (
            <li
              key={a.jobId}
              className="flex items-center gap-3 rounded-xl border border-border bg-background p-4"
            >
              <AssignmentThumb carouselId={a.carouselId} isActive={false} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {shortAvatar(a.avatarName, a.avatarSlug)}
                </p>
                <a
                  href={a.referenceUrl || "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block truncate font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-accent-strong hover:underline"
                >
                  {refHost(a.referenceUrl)}
                </a>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Eliminado el {shortDate(a.archivedAt || a.updatedAt)}
                </p>
              </div>
              {a.carouselId && (
                <Link
                  href={`/carousel/${a.carouselId}`}
                  className="text-xs font-medium text-accent-strong underline-offset-2 hover:underline"
                >
                  Abrir →
                </Link>
              )}
              <Button size="sm" variant="outline" onClick={() => restore(a.jobId)}>
                <RotateCcw className="h-3.5 w-3.5" />
                Restaurar
              </Button>
            </li>
          ))}
        </Section>

        <Section
          title="Entregados"
          count={entregados.length}
          empty={loaded ? "Todavía no entregaste ningún carrusel." : "Cargando…"}
        >
          {entregados.map((a) => (
            <li
              key={a.jobId}
              className="flex items-center gap-3 rounded-xl border border-emerald-500/25 bg-background p-4"
            >
              <AssignmentThumb carouselId={a.carouselId} isActive={false} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {shortAvatar(a.avatarName, a.avatarSlug)}
                </p>
                <a
                  href={a.referenceUrl || "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block truncate font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-accent-strong hover:underline"
                >
                  {refHost(a.referenceUrl)}
                </a>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {shortDate(a.updatedAt)}
                </p>
              </div>
              {a.carouselId && (
                <Link
                  href={`/carousel/${a.carouselId}`}
                  className="text-xs font-medium text-accent-strong underline-offset-2 hover:underline"
                >
                  Ver →
                </Link>
              )}
              <span className="text-[11px] font-medium text-emerald-600">✓ Entregado</span>
            </li>
          ))}
        </Section>
      </div>
    </main>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  const isEmpty = Array.isArray(children) && children.length === 0;
  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {count}
        </span>
      </div>
      {isEmpty ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className="space-y-3">{children}</ul>
      )}
    </section>
  );
}
