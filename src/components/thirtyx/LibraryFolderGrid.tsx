"use client";

import { ChevronRight, Folder } from "lucide-react";
import { AssignmentThumb } from "@/components/thirtyx/AssignmentThumb";
import { plural, shortDate, type AvengerFolder } from "@/lib/library-folders";

interface LibraryFolderGridProps {
  folders: AvengerFolder[];
  /** false mientras el primer fetch está en vuelo: cambia el mensaje del vacío. */
  loaded: boolean;
  totalEntregados: number;
  totalEliminados: number;
  onOpen: (key: string) => void;
}

/** La reja de carpetas de la Biblioteca: una por avenger. */
export function LibraryFolderGrid({
  folders,
  loaded,
  totalEntregados,
  totalEliminados,
  onOpen,
}: LibraryFolderGridProps) {
  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Biblioteca</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tu historial en carpetas, una por avenger: lo que ya entregaste y lo que eliminaste del
          tablero.
        </p>
        {folders.length > 0 && (
          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
            <Contador n={folders.length} singular="carpeta" muchos="carpetas" />
            <span aria-hidden="true">·</span>
            <Contador n={totalEntregados} singular="entregado" muchos="entregados" />
            <span aria-hidden="true">·</span>
            <Contador n={totalEliminados} singular="eliminado" muchos="eliminados" />
          </p>
        )}
      </div>

      {folders.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          {loaded
            ? "Todavía no hay nada guardado. Cuando entregues un carrusel —o elimines un pedido del tablero— aparece acá, en la carpeta de su avenger."
            : "Cargando…"}
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {folders.map((folder) => (
            <li key={folder.key}>
              <button
                onClick={() => onOpen(folder.key)}
                className="group flex w-full items-center gap-3 rounded-xl border border-border bg-background p-4 text-left transition-all hover:border-accent-strong/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <AssignmentThumb carouselId={folder.coverCarouselId} isActive={false} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
                    <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-accent-strong" />
                    {folder.name}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {plural(folder.entregados.length, "entregado", "entregados")}
                    {folder.eliminados.length > 0 &&
                      ` · ${plural(folder.eliminados.length, "eliminado", "eliminados")}`}
                  </p>
                  {folder.lastActivityAt && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                      Último: {shortDate(folder.lastActivityAt)}
                    </p>
                  )}
                </div>
                {/* Afordancia de "entrar": el total ya está desglosado arriba, así que una
                    píldora con el número no agregaba nada. */}
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-accent-strong" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Contador({ n, singular, muchos }: { n: number; singular: string; muchos: string }) {
  return (
    <span>
      <strong className="text-foreground">{n}</strong> {n === 1 ? singular : muchos}
    </span>
  );
}
