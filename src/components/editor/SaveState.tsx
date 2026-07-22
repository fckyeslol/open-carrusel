"use client";

import { Check, Loader2, AlertTriangle, RotateCw } from "lucide-react";

export type SaveStateValue = "idle" | "saving" | "saved" | "error" | "stale";

/**
 * Estado de guardado del editor visual.
 *
 * Reemplaza los "✓" y "⚠" tipográficos por iconos SVG: los emoji/glifos cambian
 * de forma según la fuente y el sistema, y no se pueden alinear ni colorear con
 * los tokens. Además el estado ya no depende SOLO del color (icono + texto),
 * que es lo que pide WCAG para no excluir a quien no distingue el rojo.
 */
export function SaveState({ state }: { state: SaveStateValue }) {
  if (state === "idle") return null;

  if (state === "saving") {
    return (
      <span
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        aria-live="polite"
      >
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        Guardando…
      </span>
    );
  }

  if (state === "saved") {
    return (
      <span
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        aria-live="polite"
      >
        <Check className="h-3 w-3" aria-hidden="true" />
        Guardado
      </span>
    );
  }

  if (state === "error") {
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-destructive" role="alert">
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        No se pudo guardar
      </span>
    );
  }

  // stale: otra pestaña o el chat cambiaron la lámina bajo los pies del editor.
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-destructive underline-offset-2 hover:bg-destructive/5 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <RotateCw className="h-3 w-3" aria-hidden="true" />
      La lámina cambió — recargar
    </button>
  );
}
