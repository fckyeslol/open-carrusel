"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Frame, Loader2, Check, AlertCircle, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AspectRatio } from "@/types/carousel";

type ResizeStatus = "pending" | "running" | "done" | "failed";

interface SiblingState {
  ratio: AspectRatio;
  carouselId: string;
  status: ResizeStatus;
  total: number;
  completed: number;
  error?: string;
}

interface JobState {
  sourceId: string;
  startedAt: string;
  siblings: SiblingState[];
}

interface ResizeButtonProps {
  carouselId: string;
  aspectRatio: AspectRatio;
  slideCount: number;
}

const POLL_MS = 2500;

function isActive(job: JobState | null): boolean {
  return !!job?.siblings.some((s) => s.status === "pending" || s.status === "running");
}

/**
 * "Generar otros tamaños": crea copias del carrusel en los otros dos formatos y las
 * re-maqueta con IA en background. El panel muestra el progreso por formato y linkea
 * a cada hermano cuando termina.
 */
export function ResizeButton({ carouselId, aspectRatio, slideCount }: ResizeButtonProps) {
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState<JobState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = isActive(job);

  // Al montar, recuperá una re-maquetación en curso (si volviste a la página).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/carousels/${carouselId}/resize`);
      if (!res.ok || cancelled) return;
      const data: JobState = await res.json();
      setJob(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [carouselId]);

  // Mientras haya hermanos en curso, poll del estado. Depende solo de `active`:
  // arranca al activarse, y el cleanup corta el intervalo cuando todos terminan.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/carousels/${carouselId}/resize`);
      if (!res.ok) return;
      const data: JobState = await res.json();
      setJob(data);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, carouselId]);

  const handleStart = async () => {
    if (starting || slideCount === 0 || active) return;
    setStarting(true);
    setError(null);
    setOpen(true);
    try {
      const res = await fetch(`/api/carousels/${carouselId}/resize`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "No se pudo iniciar");
      setJob(data as JobState);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const allDone = !!job && job.siblings.length > 0 && job.siblings.every((s) => s.status === "done");

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          // Si nunca se disparó (o ya terminó), un click arranca; si hay algo, togglea el panel.
          if (job) setOpen((v) => !v);
          else handleStart();
        }}
        disabled={slideCount === 0}
        title={`Generar este carrusel en los otros formatos (además de ${aspectRatio})`}
      >
        {active ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : allDone ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Frame className="h-3.5 w-3.5" />
        )}
        Otros tamaños
      </Button>

      {open && (
        <div className="oc-fade absolute left-0 top-full z-30 mt-2 w-72 rounded-xl border border-border bg-surface p-3 shadow-lg">
          {!job && (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                Crea copias de este carrusel en los otros dos formatos y las re-maqueta con IA para
                que se vean bien en cada lienzo.
              </p>
              <Button
                variant="accent"
                size="sm"
                className="w-full"
                onClick={handleStart}
                disabled={starting || slideCount === 0}
              >
                {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Frame className="h-3.5 w-3.5" />}
                Generar otros tamaños
              </Button>
            </>
          )}

          {job && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">
                {allDone ? "Listos" : active ? "Re-maquetando con IA…" : "Formatos"}
              </p>
              {job.siblings.map((s) => (
                <SiblingRow key={s.carouselId} sibling={s} />
              ))}
              {active && (
                <p className="mt-1 text-[11px] leading-tight text-muted-foreground">
                  Podés cerrar esto y seguir trabajando; continúa en segundo plano.
                </p>
              )}
            </div>
          )}

          {error && (
            <p className="mt-2 flex items-center gap-1 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5" /> {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SiblingRow({ sibling }: { sibling: SiblingState }) {
  const pct = sibling.total > 0 ? Math.round((sibling.completed / sibling.total) * 100) : 0;
  return (
    <div className="rounded-lg border border-border/60 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-semibold">{sibling.ratio}</span>
        {sibling.status === "done" ? (
          <Link
            href={`/carousel/${sibling.carouselId}`}
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
          >
            Abrir <ArrowUpRight className="h-3 w-3" />
          </Link>
        ) : sibling.status === "failed" ? (
          <span className="inline-flex items-center gap-1 text-xs text-destructive">
            <AlertCircle className="h-3 w-3" /> Falló
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {sibling.completed}/{sibling.total}
          </span>
        )}
      </div>
      {sibling.status !== "failed" && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${sibling.status === "done" ? 100 : pct}%` }}
          />
        </div>
      )}
      {sibling.status === "failed" && sibling.error && (
        <p className="mt-1 text-[11px] leading-tight text-muted-foreground">{sibling.error}</p>
      )}
    </div>
  );
}
