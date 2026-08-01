"use client";

import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AssignmentThumb } from "@/components/thirtyx/AssignmentThumb";
import { cn } from "@/lib/utils";
import { itemDate, refHost, shortDate, type LibraryItem } from "@/lib/library-folders";

interface LibraryRowProps {
  item: LibraryItem;
  kind: "entregado" | "eliminado" | "suelto";
  /** Solo para los eliminados propios: los devuelve al tablero. */
  onRestore?: () => void;
}

/** El verbo de la fecha, por sección. */
const VERBO = { entregado: "Entregado", eliminado: "Eliminado", suelto: "Creado" } as const;

/**
 * Una pieza dentro de una carpeta de la Biblioteca.
 *
 * El nombre del avenger NO va acá: adentro de la carpeta ya es el título de la vista, y
 * repetirlo en cada fila deja al referente —lo único que distingue una pieza de otra— en
 * letra chica. Así que el referente es el renglón principal, y cuando no hay referente
 * (una pieza arrancada desde el home) el renglón lo ocupa el nombre del carrusel: sin eso
 * la fila quedaría en "Sin referente" y no habría forma de distinguir una de otra.
 */
export function LibraryRow({ item, kind, onRestore }: LibraryRowProps) {
  const entregado = kind === "entregado";
  const fecha = shortDate(itemDate(item));
  const ref = refHost(item.referenceUrl);

  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-xl border bg-background p-4 transition-colors",
        entregado
          ? "border-emerald-500/25 hover:border-emerald-500/50"
          : "border-border hover:border-foreground/20"
      )}
    >
      <AssignmentThumb carouselId={item.carouselId} isActive={false} />
      <div className="min-w-0 flex-1">
        {ref ? (
          <a
            href={item.referenceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate font-mono text-xs font-medium text-foreground underline-offset-2 hover:text-accent-strong hover:underline"
          >
            {ref}
          </a>
        ) : (
          <p className="truncate text-xs font-medium text-foreground">
            {item.title || "Sin referente"}
          </p>
        )}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
          <span>{fecha ? `${VERBO[kind]} el ${fecha}` : VERBO[kind]}</span>
          {/* El formato solo se muestra en los hermanos de resize, que son la única razón
              por la que dos filas de la misma carpeta pueden parecer la misma pieza. */}
          {item.resizedFrom && item.aspectRatio && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-medium">
              otro tamaño · {item.aspectRatio}
            </span>
          )}
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
      {entregado && (
        <span className="shrink-0 text-[11px] font-medium text-emerald-600">✓ Entregado</span>
      )}
      {onRestore && (
        <Button size="sm" variant="outline" className="shrink-0" onClick={onRestore}>
          <RotateCcw className="h-3.5 w-3.5" />
          Restaurar
        </Button>
      )}
    </li>
  );
}
