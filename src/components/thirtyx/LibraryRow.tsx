"use client";

import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AssignmentThumb } from "@/components/thirtyx/AssignmentThumb";
import { cn } from "@/lib/utils";
import { itemDate, refHost, shortDate, type LibraryItem } from "@/lib/library-folders";

interface LibraryRowProps {
  item: LibraryItem;
  kind: "entregado" | "eliminado";
  /** Solo para los eliminados: los devuelve al tablero. */
  onRestore?: () => void;
}

/**
 * Una pieza dentro de una carpeta de la Biblioteca.
 *
 * El nombre del avenger NO va acá: adentro de la carpeta ya es el título de la vista, y
 * repetirlo en cada fila deja al referente —lo único que distingue una pieza de otra— en
 * letra chica. Así que el referente es el renglón principal.
 */
export function LibraryRow({ item, kind, onRestore }: LibraryRowProps) {
  const entregado = kind === "entregado";
  const fecha = shortDate(itemDate(item));

  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-xl border bg-background p-4 transition-colors",
        entregado ? "border-emerald-500/25 hover:border-emerald-500/50" : "border-border hover:border-foreground/20"
      )}
    >
      <AssignmentThumb carouselId={item.carouselId} isActive={false} />
      <div className="min-w-0 flex-1">
        <a
          href={item.referenceUrl || "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate font-mono text-xs font-medium text-foreground underline-offset-2 hover:text-accent-strong hover:underline"
        >
          {refHost(item.referenceUrl) || "Sin referente"}
        </a>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {fecha ? `${entregado ? "Entregado" : "Eliminado"} el ${fecha}` : entregado ? "Entregado" : "Eliminado"}
        </p>
      </div>
      {item.carouselId && (
        <Link
          href={`/carousel/${item.carouselId}`}
          className="shrink-0 text-xs font-medium text-accent-strong underline-offset-2 hover:underline"
        >
          {entregado ? "Ver →" : "Abrir →"}
        </Link>
      )}
      {entregado ? (
        <span className="shrink-0 text-[11px] font-medium text-emerald-600">✓ Entregado</span>
      ) : (
        onRestore && (
          <Button size="sm" variant="outline" className="shrink-0" onClick={onRestore}>
            <RotateCcw className="h-3.5 w-3.5" />
            Restaurar
          </Button>
        )
      )}
    </li>
  );
}
