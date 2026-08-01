"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, FolderOpen } from "lucide-react";
import { BoardHeader } from "@/components/thirtyx/BoardHeader";
import { LibraryFolderGrid } from "@/components/thirtyx/LibraryFolderGrid";
import { LibraryRow } from "@/components/thirtyx/LibraryRow";
import {
  buildAvengerFolders,
  folderTotal,
  plural,
  type AvengerFolder,
  type LibraryItem,
} from "@/lib/library-folders";

/**
 * Biblioteca: el historial en carpetas por avenger.
 *
 * Lee GET /api/thirtyx/library, que arma las piezas a partir de los CARRUSELES y no de las
 * asignaciones. Antes leía el mismo `mine` que el tablero y solo mostraba lo que tuviera un
 * pedido detrás: todo lo hecho a mano quedaba invisible acá aunque el home lo listara (ver
 * `src/lib/library.ts`). Sin poll: es historial, no cambia solo mientras se mira.
 *
 * La carpeta abierta vive en la URL (`?avenger=slug`, que llega como prop desde el server)
 * y no en un useState, para que el botón "atrás" del navegador vuelva a la reja de carpetas
 * en vez de salir de la Biblioteca, y para que una carpeta se pueda mandar por link.
 */
export function Library({ openKey }: { openKey: string | null }) {
  const router = useRouter();

  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/thirtyx/library");
      let data: { error?: string; items?: LibraryItem[] } = {};
      try {
        data = await res.json();
      } catch {
        /* cuerpo no-JSON (p. ej. página de error del proxy) */
      }
      if (!res.ok) {
        setError(data.error || "No se pudo cargar la biblioteca");
        return;
      }
      setError(null);
      setItems(data.items || []);
    } catch {
      setError("Error de red al cargar");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const restore = useCallback(
    async (jobId: string) => {
      if (busyRef.current.has(jobId)) return;
      busyRef.current.add(jobId);
      setError(null);
      try {
        const res = await fetch(`/api/thirtyx/assignments/${jobId}/restore`, { method: "POST" });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          setError(d.error || "No se pudo restaurar el pedido");
        }
        await load();
      } finally {
        busyRef.current.delete(jobId);
      }
    },
    [load]
  );

  const folders = useMemo(() => buildAvengerFolders(items), [items]);
  const open = openKey ? folders.find((f) => f.key === openKey) : undefined;

  const totalEntregados = folders.reduce((n, f) => n + f.entregados.length, 0);
  const totalEliminados = folders.reduce((n, f) => n + f.eliminados.length, 0);
  const totalSueltos = folders.reduce((n, f) => n + f.sueltos.length, 0);

  return (
    <main className="min-h-screen bg-muted/20">
      <BoardHeader active="biblioteca" />

      <div className="mx-auto max-w-4xl px-6 py-8">
        {error && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Una carpeta pedida por URL puede ya no existir (link viejo, o el último pedido
            de ese avenger volvió al tablero): se avisa en vez de mostrar la vista vacía. */}
        {openKey && !open ? (
          <FolderMissing loaded={loaded} onBack={() => router.push("/biblioteca")} />
        ) : open ? (
          <FolderView folder={open} onBack={() => router.push("/biblioteca")} onRestore={restore} />
        ) : (
          <LibraryFolderGrid
            folders={folders}
            loaded={loaded}
            totalEntregados={totalEntregados}
            totalEliminados={totalEliminados}
            totalSueltos={totalSueltos}
            onOpen={(key) => router.push(`/biblioteca?avenger=${encodeURIComponent(key)}`)}
          />
        )}
      </div>
    </main>
  );
}

/** Adentro de una carpeta: lo entregado primero, lo eliminado después. */
function FolderView({
  folder,
  onBack,
  onRestore,
}: {
  folder: AvengerFolder;
  onBack: () => void;
  onRestore: (jobId: string) => void;
}) {
  return (
    <>
      <button
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Biblioteca
      </button>

      <div className="mb-6 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 truncate text-2xl font-semibold tracking-tight">
            <FolderOpen className="h-5 w-5 shrink-0 text-accent-strong" />
            {folder.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {plural(folderTotal(folder), "pieza", "piezas")} de este avenger.
          </p>
        </div>
      </div>

      <Section
        title="Entregados"
        count={folder.entregados.length}
        empty="Todavía no entregaste ningún carrusel de este avenger."
      >
        {folder.entregados.map((a) => (
          <LibraryRow key={a.key} item={a} kind="entregado" />
        ))}
      </Section>

      {/* Las piezas sin pedido van después de los entregados y antes de los eliminados:
          son trabajo vivo, pero nadie las está esperando del otro lado. */}
      <Section
        title="Hechos a mano"
        count={folder.sueltos.length}
        empty="No hay carruseles de este avenger creados por fuera de la cola."
      >
        {folder.sueltos.map((a) => (
          <LibraryRow key={a.key} item={a} kind="suelto" />
        ))}
      </Section>

      <Section
        title="Eliminados"
        count={folder.eliminados.length}
        empty="No eliminaste ningún pedido de este avenger."
      >
        {folder.eliminados.map((a) => (
          <LibraryRow
            key={a.key}
            item={a}
            kind="eliminado"
            onRestore={a.jobId && a.canRestore ? () => onRestore(a.jobId!) : undefined}
          />
        ))}
      </Section>
    </>
  );
}

function FolderMissing({ loaded, onBack }: { loaded: boolean; onBack: () => void }) {
  return (
    <>
      <button
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Biblioteca
      </button>
      <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
        {loaded ? "Esa carpeta ya no tiene nada guardado." : "Cargando…"}
      </p>
    </>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  const isEmpty = Array.isArray(children) && children.length === 0;
  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {count}
        </span>
      </div>
      {isEmpty ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className="space-y-3">{children}</ul>
      )}
    </section>
  );
}
