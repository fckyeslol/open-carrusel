"use client";

import { useEffect, useState } from "react";
import { SlideRenderer } from "@/components/editor/SlideRenderer";
import { cn } from "@/lib/utils";
import type { AspectRatio, Carousel } from "@/types/carousel";
import { DIMENSIONS } from "@/types/carousel";

/** Ancho fijo de la miniatura; el alto sale del aspect ratio del carrusel. */
const THUMB_WIDTH = 56;

/** Mientras el trabajo está activo, re-busca la primera lámina cada tanto. */
const REFRESH_MS = 10000;

interface ThumbData {
  html: string;
  aspectRatio: AspectRatio;
}

interface AssignmentThumbProps {
  carouselId: string | null;
  /** true mientras se está generando: el thumbnail se refresca solo. */
  isActive: boolean;
}

function thumbHeight(aspectRatio: AspectRatio): number {
  const { width, height } = DIMENSIONS[aspectRatio];
  return Math.round((THUMB_WIDTH * height) / width);
}

/**
 * Miniatura de la primera lámina del carrusel de una asignación.
 * Antes de que exista la primera lámina muestra un placeholder; apenas el
 * agente la crea, aparece acá (sin recargar la página).
 */
export function AssignmentThumb({ carouselId, isActive }: AssignmentThumbProps) {
  const [thumb, setThumb] = useState<ThumbData | null>(null);

  useEffect(() => {
    if (!carouselId) {
      setThumb(null);
      return;
    }
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(`/api/carousels/${carouselId}`);
        if (!res.ok) return;
        const carousel: Carousel = await res.json();
        const first = [...(carousel.slides ?? [])].sort((a, b) => a.order - b.order)[0];
        if (!cancelled && first) {
          setThumb({ html: first.html, aspectRatio: carousel.aspectRatio });
        }
      } catch {
        // Sin thumbnail la tarjeta sigue funcionando igual; no rompemos nada.
      }
    };

    load();
    if (!isActive) {
      return () => {
        cancelled = true;
      };
    }
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [carouselId, isActive]);

  // Placeholder: aún no hay carrusel o no existe la primera lámina.
  if (!thumb) {
    return (
      <div
        aria-hidden="true"
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md border border-dashed border-border bg-muted/30",
          isActive && "animate-pulse"
        )}
        style={{ width: THUMB_WIDTH, height: thumbHeight("4:5") }}
      >
        <span className="text-[14px] leading-none text-muted-foreground/50">
          {isActive ? "…" : "—"}
        </span>
      </div>
    );
  }

  return (
    <SlideRenderer
      html={thumb.html}
      aspectRatio={thumb.aspectRatio}
      className="shrink-0"
      style={{ width: THUMB_WIDTH, height: thumbHeight(thumb.aspectRatio) }}
    />
  );
}
