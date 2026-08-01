"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, UserRound } from "lucide-react";
import { BoardHeader } from "@/components/thirtyx/BoardHeader";
import { LibraryRow } from "@/components/thirtyx/LibraryRow";
import { bucketOf, plural, shortDate, itemDate, type LibraryItem } from "@/lib/library-folders";
import type { PublicUser } from "@/lib/users";

/**
 * El perfil de una diseñadora: sus carruseles, para entrar y editarlos.
 *
 * La lista es PLANA y no en carpetas por avenger como la Biblioteca: acá el eje ya es la
 * persona, y anidar avenger adentro de diseñadora daría dos niveles de carpeta para llegar
 * a una pieza. El avenger viaja en cada fila (`showAvatar`).
 *
 * Es de solo lectura sobre el PEDIDO: no hay aprobar, reintentar, eliminar ni restaurar —
 * esas acciones son de su dueña y sus rutas responden 403. El link de cada fila sí abre el
 * editor, que nunca estuvo scopeado.
 */
export function DesignerProfile({ designerId }: { designerId: string }) {
  const [designer, setDesigner] = useState<PublicUser | null>(null);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch(`/api/thirtyx/team/${encodeURIComponent(designerId)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error || "No se pudo cargar el perfil");
          return;
        }
        setDesigner(data.designer ?? null);
        setItems(data.items || []);
      })
      .catch(() => setError("Error de red al cargar"))
      .finally(() => setLoaded(true));
  }, [designerId]);

  const grupos = useMemo(() => {
    const entregados: LibraryItem[] = [];
    const sueltos: LibraryItem[] = [];
    const eliminados: LibraryItem[] = [];
    const enCurso: LibraryItem[] = [];
    for (const item of items) {
      const bucket = bucketOf(item);
      if (bucket === "entregado") entregados.push(item);
      else if (bucket === "suelto") sueltos.push(item);
      else if (bucket === "eliminado") eliminados.push(item);
      else enCurso.push(item);
    }
    const reciente = (a: LibraryItem, b: LibraryItem) => itemDate(b).localeCompare(itemDate(a));
    return {
      entregados: entregados.sort(reciente),
      sueltos: sueltos.sort(reciente),
      eliminados: eliminados.sort(reciente),
      enCurso: enCurso.sort(reciente),
    };
  }, [items]);

  return (
    <main className="min-h-screen bg-muted/20">
      <BoardHeader active="equipo" />

      <div className="mx-auto max-w-4xl px-6 py-8">
        <Link
          href="/equipo"
          className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Equipo
        </Link>

        {error && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {!error && (
          <>
            <div className="mb-6">
              <h1 className="flex items-center gap-2 truncate text-2xl font-semibold tracking-tight">
                <UserRound className="h-5 w-5 shrink-0 text-accent-strong" />
                {designer?.displayName || (loaded ? "Diseñadora" : "…")}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {designer?.username}
                {items.length > 0 && ` · ${plural(items.length, "pieza", "piezas")}`}
              </p>
            </div>

            {loaded && items.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                No hay carruseles atribuidos a esta diseñadora. Las piezas creadas desde el home o
                como otro tamaño no guardan quién las hizo, así que viven solo en la{" "}
                <Link href="/biblioteca" className="text-accent-strong underline-offset-2 hover:underline">
                  Biblioteca
                </Link>
                .
              </p>
            ) : !loaded ? (
              <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                Cargando…
              </p>
            ) : (
              <>
                {/* Lo que sigue en su tablero se muestra pero no se acciona: la fila no
                    tiene botones, así que no hay forma de aprobar ni reintentar desde acá. */}
                {grupos.enCurso.length > 0 && (
                  <Seccion
                    title="En su tablero"
                    count={grupos.enCurso.length}
                    nota="Todavía en curso. Se ven acá, pero aprobar o reintentar es de ella."
                  >
                    {grupos.enCurso.map((i) => (
                      <EnCurso key={i.key} item={i} />
                    ))}
                  </Seccion>
                )}

                <Seccion title="Entregados" count={grupos.entregados.length}>
                  {grupos.entregados.map((i) => (
                    <LibraryRow key={i.key} item={i} kind="entregado" showAvatar />
                  ))}
                </Seccion>

                <Seccion title="Hechos a mano" count={grupos.sueltos.length}>
                  {grupos.sueltos.map((i) => (
                    <LibraryRow key={i.key} item={i} kind="suelto" showAvatar />
                  ))}
                </Seccion>

                <Seccion title="Eliminados" count={grupos.eliminados.length}>
                  {grupos.eliminados.map((i) => (
                    <LibraryRow key={i.key} item={i} kind="eliminado" showAvatar />
                  ))}
                </Seccion>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}

/** Una pieza que sigue en el tablero de su dueña: estado y link, sin acciones. */
function EnCurso({ item }: { item: LibraryItem }) {
  const fecha = shortDate(itemDate(item));
  return (
    <li className="flex items-center gap-3 rounded-xl border border-border bg-background p-4">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">
          {item.title || item.referenceUrl || "Sin referente"}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {ESTADO[item.status] || item.status}
          {fecha && ` · ${fecha}`}
        </p>
      </div>
      {item.carouselId && (
        <Link
          href={`/carousel/${item.carouselId}`}
          className="shrink-0 text-xs font-medium text-accent-strong underline-offset-2 hover:underline"
        >
          Abrir →
        </Link>
      )}
    </li>
  );
}

/** Los estados del pedido en palabras, iguales a las del tablero. */
const ESTADO: Record<string, string> = {
  received: "Recién llegado",
  queued: "En la fila",
  blocked: "Bloqueado",
  claiming: "Reclamando",
  ingesting: "Bajando el referente",
  generating: "Generando",
  rendering: "Renderizando",
  preempted: "Cedió el turno",
  pending_review: "Por revisar",
  failed: "Con problemas",
};

function Seccion({
  title,
  count,
  nota,
  children,
}: {
  title: string;
  count: number;
  nota?: string;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {count}
        </span>
      </div>
      {nota && <p className="mb-2 text-[11px] text-muted-foreground">{nota}</p>}
      <ul className="space-y-3">{children}</ul>
    </section>
  );
}
