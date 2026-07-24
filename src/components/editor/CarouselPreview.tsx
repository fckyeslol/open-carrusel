"use client";

import { useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SlideRenderer } from "./SlideRenderer";
import { SafeZoneOverlay } from "./SafeZoneOverlay";
import type { Slide, AspectRatio } from "@/types/carousel";

/** Estado de una generación en curso (job de la cola 30x), para mostrar avance. */
export interface GenerationStatus {
  /** El job está trabajando ahora (ingesta/generando/renderizando). */
  active: boolean;
  /** El job falló o quedó bloqueado. */
  failed?: boolean;
  error?: string | null;
  /** Láminas ya creadas / total esperado (del referente). */
  produced: number;
  target: number;
}

interface CarouselPreviewProps {
  slides: Slide[];
  aspectRatio: AspectRatio;
  activeIndex: number;
  onActiveChange: (index: number) => void;
  showSafeZones?: boolean;
  /** Si el carrusel viene de la cola, refleja el avance de la generación. */
  generation?: GenerationStatus | null;
}

export function CarouselPreview({
  slides,
  aspectRatio,
  activeIndex,
  onActiveChange,
  showSafeZones = false,
  generation = null,
}: CarouselPreviewProps) {
  const slide = slides[activeIndex];

  // Dirección de entrada de la lámina (adelante = entra desde la derecha).
  // Se ajusta durante el render en vez de leer un ref: leer ref.current en render
  // rompe con StrictMode/render concurrente, y calcularlo en un efecto llegaba
  // tarde — la primera pintura usaba la dirección anterior y el movimiento se
  // veía invertido al saltar rápido entre láminas.
  const [prevIndex, setPrevIndex] = useState(activeIndex);
  const [direction, setDirection] = useState(12);
  if (prevIndex !== activeIndex) {
    setDirection(activeIndex > prevIndex ? 12 : -12);
    setPrevIndex(activeIndex);
  }

  if (!slide) {
    return (
      <div className="oc-canvas flex-1 flex items-center justify-center">
        <div className="text-center text-muted-foreground p-8">
          {generation?.active ? (
            <>
              <div
                className="h-8 w-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4"
                aria-hidden="true"
              />
              <p className="text-sm font-medium text-foreground">
                Generando el carrusel…
                {generation.target > 0 ? ` ${generation.produced}/${generation.target} láminas` : ""}
              </p>
              <p className="text-xs mt-1 max-w-[250px] leading-relaxed">
                Las láminas van apareciendo a medida que se crean. Puede tardar unos
                minutos — no hace falta que hagas nada ni que recargues.
              </p>
            </>
          ) : generation?.failed ? (
            <>
              <div className="w-16 h-20 border-2 border-dashed border-destructive/40 rounded-lg mx-auto mb-4 flex items-center justify-center">
                <Plus className="h-5 w-5 opacity-40 rotate-45" aria-hidden="true" />
              </div>
              <p className="text-sm font-medium text-foreground">La generación falló</p>
              <p className="text-xs mt-1 max-w-[260px] leading-relaxed">
                {generation.error || "Reintentá el job desde el board."}
              </p>
            </>
          ) : (
            <>
              <div className="w-16 h-20 border-2 border-dashed border-muted-foreground/30 rounded-lg mx-auto mb-4 flex items-center justify-center">
                <Plus className="h-5 w-5 opacity-40" aria-hidden="true" />
              </div>
              <p className="text-sm font-medium text-foreground">Todavía no hay láminas</p>
              <p className="text-xs mt-1 max-w-[220px] leading-relaxed">
                Pedile al chat que genere el carrusel y las láminas aparecen acá.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="oc-canvas flex-1 flex flex-col min-h-0 min-w-0">
      {/* Banner de generación en curso: el agente sigue agregando láminas. */}
      {generation?.active && (
        <div className="shrink-0 flex items-center justify-center gap-2 py-1.5 text-xs text-muted-foreground border-b border-border bg-surface/60">
          <span
            className="h-3 w-3 border-2 border-accent border-t-transparent rounded-full animate-spin"
            aria-hidden="true"
          />
          Generando…
          {generation.target > 0 ? ` ${generation.produced}/${generation.target} láminas` : ""}
        </div>
      )}
      {/* Preview area with padding for arrows */}
      <div className="flex-1 relative min-h-0 p-8 px-14">
        {/* Left arrow */}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onActiveChange(activeIndex - 1)}
          disabled={activeIndex <= 0}
          className="absolute left-2 top-1/2 -translate-y-1/2 z-10 h-9 w-9 rounded-full border border-border bg-surface/90 shadow-sm backdrop-blur-sm transition-colors hover:bg-surface disabled:opacity-0"
          aria-label="Lámina anterior"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        {/* Slide fills the padded inner area */}
        <div
          key={slide.id}
          className="oc-slide-in relative w-full h-full"
          style={{ "--oc-slide-from": `${direction}px` } as CSSProperties}
        >
          <SlideRenderer
            html={slide.html}
            aspectRatio={aspectRatio}
            style={{ width: "100%", height: "100%" }}
            overlay={<SafeZoneOverlay aspectRatio={aspectRatio} visible={showSafeZones} />}
          />
        </div>

        {/* Right arrow */}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onActiveChange(activeIndex + 1)}
          disabled={activeIndex >= slides.length - 1}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-10 h-9 w-9 rounded-full border border-border bg-surface/90 shadow-sm backdrop-blur-sm transition-colors hover:bg-surface disabled:opacity-0"
          aria-label="Lámina siguiente"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Slide counter dots */}
      {slides.length > 1 && (
        <div className="flex items-center justify-center gap-1.5 pb-3 shrink-0">
          {slides.map((_, i) => (
            <button
              key={i}
              onClick={() => onActiveChange(i)}
              // Área táctil de 24px alrededor de un punto de 8px: el punto sigue
              // siendo discreto pero deja de exigir puntería.
              className="group grid h-6 place-items-center px-0.5 cursor-pointer"
              aria-label={`Ir a la lámina ${i + 1}`}
              aria-current={i === activeIndex ? "true" : undefined}
            >
              <span
                className={`h-2 rounded-full transition-[width,background-color] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] ${
                  i === activeIndex
                    ? "w-6 bg-foreground"
                    : "w-2 bg-foreground/25 group-hover:bg-foreground/50"
                }`}
              />
            </button>
          ))}
          <span className="ml-2 text-xs tabular-nums text-muted-foreground">
            {activeIndex + 1}/{slides.length}
          </span>
        </div>
      )}
    </div>
  );
}
