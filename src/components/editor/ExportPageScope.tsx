"use client";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { PageSelection } from "@/lib/page-selection";

/** Todas las láminas, solo la que está en pantalla, o las que escriba la diseñadora. */
export type PageScope = "all" | "current" | "custom";

interface ExportPageScopeProps {
  scope: PageScope;
  onScopeChange: (scope: PageScope) => void;
  /** Lo escrito en "Personalizado" — ej. "1, 3, 5-7". */
  customInput: string;
  onCustomInputChange: (value: string) => void;
  slideCount: number;
  activeSlideNumber: number;
  /** La selección ya parseada: alimenta el resumen y el mensaje de error. */
  selection: PageSelection;
}

const OPCIONES: { id: PageScope; label: string }[] = [
  { id: "all", label: "Todas" },
  { id: "current", label: "Esta lámina" },
  { id: "custom", label: "Elegir" },
];

/**
 * Selector de láminas del menú de exportación, como el de Canva: la selección es una
 * sola y vale para TODOS los formatos, en vez de un ítem de menú por combinación.
 */
export function ExportPageScope({
  scope,
  onScopeChange,
  customInput,
  onCustomInputChange,
  slideCount,
  activeSlideNumber,
  selection,
}: ExportPageScopeProps) {
  // Campo vacío no es un error todavía: la diseñadora recién eligió "Elegir" y no escribió
  // nada. Se pinta como pista, no en rojo — aunque igual bloquee la exportación.
  const vacio = scope === "custom" && customInput.trim() === "";
  const invalido = !selection.ok && !vacio;

  return (
    <div className="border-b border-border px-3 pb-3 pt-2">
      <p
        id="oc-export-scope-label"
        className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
      >
        Láminas
      </p>

      <div
        role="radiogroup"
        aria-labelledby="oc-export-scope-label"
        className="flex gap-1 rounded-lg bg-muted p-1"
      >
        {OPCIONES.map((opcion) => (
          <button
            key={opcion.id}
            type="button"
            role="radio"
            aria-checked={scope === opcion.id}
            onClick={() => onScopeChange(opcion.id)}
            className={cn(
              "oc-press flex-1 cursor-pointer rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              scope === opcion.id
                ? "bg-surface text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {opcion.label}
          </button>
        ))}
      </div>

      {scope === "custom" && (
        <Input
          value={customInput}
          onChange={(e) => onCustomInputChange(e.target.value)}
          placeholder={slideCount > 2 ? `1, 3, 5-${slideCount}` : "1, 2"}
          inputMode="numeric"
          aria-label="Láminas a exportar"
          aria-invalid={invalido}
          className="mt-2 h-8 text-xs"
          autoFocus
        />
      )}

      <p
        className={cn(
          "mt-2 text-[11px] leading-snug",
          invalido ? "text-destructive" : "text-muted-foreground"
        )}
        role={invalido ? "alert" : undefined}
      >
        {vacio
          ? "Números y rangos: 1, 3, 5-7"
          : resumen(scope, selection, slideCount, activeSlideNumber)}
      </p>
    </div>
  );
}

/**
 * Qué se va a exportar, en palabras. Con "Elegir" lista las láminas resueltas: ver
 * "5, 6, 7" tras escribir "5-7" es la confirmación de que se entendió el rango.
 */
function resumen(
  scope: PageScope,
  selection: PageSelection,
  slideCount: number,
  activeSlideNumber: number
): string {
  if (!selection.ok) return selection.error;
  if (scope === "all") {
    return slideCount === 1
      ? "1 lámina"
      : `Las ${slideCount} láminas del carrusel`;
  }
  if (scope === "current") return `Solo la lámina ${activeSlideNumber}`;
  const { pages } = selection;
  return pages.length === 1
    ? `Lámina ${pages[0]}`
    : `${pages.length} láminas: ${pages.join(", ")}`;
}
