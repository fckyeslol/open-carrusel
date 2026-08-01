"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, UserRound } from "lucide-react";
import { BoardHeader } from "@/components/thirtyx/BoardHeader";
import { AssignmentThumb } from "@/components/thirtyx/AssignmentThumb";
import { shortDate } from "@/lib/library-folders";
import type { TeamMember, TeamRoster as Roster } from "@/lib/team";

/**
 * Los perfiles del equipo de diseño: una tarjeta por diseñadora, para entrar a su trabajo.
 *
 * El permiso lo aplica GET /api/thirtyx/team, así que quien entre sin acceso ve el mensaje
 * del 403 y ningún dato — mismo criterio que /revisiones.
 *
 * Sin poll: el reparto del equipo no cambia mientras se lo mira, y la vista lee el archivo
 * de carruseles entero.
 */
export function TeamRoster() {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/thirtyx/team")
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error || "No se pudieron cargar los perfiles");
          return;
        }
        setRoster(data);
      })
      .catch(() => setError("Error de red al cargar"))
      .finally(() => setLoaded(true));
  }, []);

  const conTrabajo = roster?.members.filter((m) => m.total > 0) ?? [];
  const sinTrabajo = roster?.members.filter((m) => m.total === 0) ?? [];

  return (
    <main className="min-h-screen bg-muted/20">
      <BoardHeader active="equipo" />

      <div className="mx-auto max-w-4xl px-6 py-8">
        {error && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Equipo de diseño</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Entrá al perfil de una diseñadora para ver y editar sus carruseles. Las acciones del
            pedido —aprobar, reintentar, eliminar— siguen siendo de ella.
          </p>
        </div>

        {!roster ? (
          <Vacio>{loaded ? "No hay nada para mostrar." : "Cargando…"}</Vacio>
        ) : roster.members.length === 0 ? (
          <Vacio>Todavía no hay diseñadoras dadas de alta.</Vacio>
        ) : (
          <>
            <ul className="grid gap-3 sm:grid-cols-2">
              {conTrabajo.map((m) => (
                <li key={m.id}>
                  <Tarjeta member={m} />
                </li>
              ))}
            </ul>

            {sinTrabajo.length > 0 && (
              <section className="mt-8">
                <h2 className="mb-2 text-sm font-semibold tracking-tight">Sin trabajo atribuido</h2>
                <ul className="grid gap-3 sm:grid-cols-2">
                  {sinTrabajo.map((m) => (
                    <li key={m.id}>
                      <Tarjeta member={m} />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* El faltante se dice en voz alta: el carrusel no guarda dueño, así que las
                piezas creadas desde el home o los otros tamaños no son de nadie. Callarlo
                haría que los totales de los perfiles parecieran el inventario completo. */}
            {roster.sinDueno > 0 && (
              <p className="mt-8 rounded-xl border border-dashed border-border px-4 py-3 text-[13px] text-muted-foreground">
                <strong className="text-foreground">{roster.sinDueno}</strong>{" "}
                {roster.sinDueno === 1 ? "pieza no aparece" : "piezas no aparecen"} en ningún
                perfil: se crearon sin pedido ni entrada manual (desde el home, o como otro
                tamaño), y el carrusel no guarda quién lo hizo.{" "}
                <Link href="/biblioteca" className="text-accent-strong underline-offset-2 hover:underline">
                  Están en la Biblioteca
                </Link>
                , que no filtra por diseñadora.
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function Tarjeta({ member }: { member: TeamMember }) {
  const partes = [
    member.entregados > 0 && `${member.entregados} entregados`,
    member.aMano > 0 && `${member.aMano} a mano`,
    member.enCurso > 0 && `${member.enCurso} en curso`,
    member.eliminados > 0 && `${member.eliminados} eliminados`,
  ].filter(Boolean) as string[];

  return (
    <Link
      href={`/equipo/${member.id}`}
      className="group flex w-full items-center gap-3 rounded-xl border border-border bg-background p-4 text-left transition-all hover:border-accent-strong/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <AssignmentThumb carouselId={member.coverCarouselId} isActive={false} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
          <UserRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-accent-strong" />
          {member.displayName}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {partes.length > 0 ? partes.join(" · ") : "Sin carruseles atribuidos"}
        </p>
        {member.lastActivityAt && (
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">
            Último: {shortDate(member.lastActivityAt)}
          </p>
        )}
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-accent-strong" />
    </Link>
  );
}

function Vacio({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}
