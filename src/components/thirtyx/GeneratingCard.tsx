"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AssignmentThumb } from "@/components/thirtyx/AssignmentThumb";
import type { Carousel } from "@/types/carousel";

/**
 * Card de un pedido EN GENERACIÓN. Además de la miniatura viva, hace poll al
 * carrusel para mostrar el avance real en tiempo real (N de M láminas + barra) y
 * es clickeable: abre el editor para ver las láminas que el agente va escribiendo.
 */

/** Refresco del contador de láminas mientras el agente trabaja. */
const PROGRESS_POLL_MS = 4000;

const STAGE_LABEL: Record<string, string> = {
  received: "En cola",
  ingesting: "Bajando referente",
  generating: "Generando",
  rendering: "Renderizando",
};

interface GeneratingCardProps {
  carouselId: string | null;
  title: string;
  status: string;
}

interface Progress {
  produced: number;
  target: number;
}

export function GeneratingCard({ carouselId, title, status }: GeneratingCardProps) {
  const [progress, setProgress] = useState<Progress | null>(null);

  // Poll al carrusel: las láminas crecen a medida que el agente las crea, así que
  // re-leemos el conteo cada pocos segundos mientras la card está montada.
  useEffect(() => {
    // Sin carrusel todavía (En cola / ingesta): no hay nada que pollear. El estado
    // arranca en null y una card de generación nunca vuelve de tener carouselId a null.
    if (!carouselId) return;
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(`/api/carousels/${carouselId}`);
        if (!res.ok) return;
        const c: Carousel = await res.json();
        if (!cancelled) {
          setProgress({
            produced: c.slides?.length ?? 0,
            target: c.referenceImages?.length ?? 0,
          });
        }
      } catch {
        // Sin conteo la card sigue mostrando la etapa; no rompemos nada.
      }
    };

    load();
    const id = setInterval(load, PROGRESS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [carouselId]);

  const label = STAGE_LABEL[status] ?? "En proceso";
  const produced = progress?.produced ?? 0;
  const target = progress?.target ?? 0;
  const pct = target > 0 ? Math.min(100, Math.round((produced / target) * 100)) : 0;

  const counter =
    target > 0
      ? ` · ${produced}/${target} láminas`
      : produced > 0
        ? ` · ${produced} ${produced === 1 ? "lámina" : "láminas"}`
        : "";

  const inner = (
    <div className="flex items-center gap-3 rounded-lg border border-border border-l-4 border-l-info bg-surface p-3 transition-shadow hover:shadow-md">
      <AssignmentThumb carouselId={carouselId} isActive />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{title}</p>
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-info-strong">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info" />
          {label}
          <span className="tabular-nums">{counter}</span>
        </p>
        {target > 0 && (
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-info transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>
      {carouselId && (
        <span className="shrink-0 self-start text-[11px] font-medium text-accent-strong">Ver →</span>
      )}
    </div>
  );

  // Clickeable solo cuando ya existe el carrusel (durante "En cola" todavía no hay).
  return carouselId ? (
    <Link href={`/carousel/${carouselId}`} className="block">
      {inner}
    </Link>
  ) : (
    inner
  );
}
