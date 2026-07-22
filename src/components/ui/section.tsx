"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

interface SectionProps {
  title: string;
  /** Estado inicial abierto/cerrado. El usuario puede togglearlo después. */
  defaultOpen?: boolean;
  /** Contenido opcional a la derecha del título (contador, botón, etc.). */
  right?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Sección desplegable liviana (acordeón). Controlada por estado propio para que
 * el abierto/cerrado sea estable entre re-renders del padre. Se usa para no
 * apilar todos los controles a la vez en paneles densos (editor, assets).
 */
export function Section({ title, defaultOpen = false, right, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="border-b border-border/70 last:border-b-0"
    >
      <summary className="flex items-center gap-1.5 cursor-pointer list-none select-none py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span className="flex-1">{title}</span>
        {right}
      </summary>
      <div className="space-y-3 pb-3">{children}</div>
    </details>
  );
}
