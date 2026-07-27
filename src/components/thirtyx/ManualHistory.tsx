"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/thirtyx/SectionLabel";
import { AssignmentThumb } from "@/components/thirtyx/AssignmentThumb";
import { cn } from "@/lib/utils";

/** Entrada del historial tal como la expone GET /api/thirtyx/manual-entries. */
export interface ManualEntry {
  id: string;
  referenceUrl: string;
  avatarSlug: string;
  avatarName: string | null;
  note: string | null;
  status: "ingesting" | "ready" | "failed";
  carouselId: string | null;
  referenceCount: number | null;
  stage: string | null;
  error: string | null;
  createdAt: string;
  /**
   * Entrada sin dueña, del fondo común del equipo: viene de un carrusel que ya
   * existía antes de que hubiera historial, así que no se sabe quién lo hizo.
   * Solo llega en modo hosteado — en local no hay dueñas que distinguir.
   */
  shared?: boolean;
}

/** Cuántas entradas se muestran antes de tener que desplegar el resto. */
const COLLAPSED_COUNT = 4;

const STATUS: Record<ManualEntry["status"], { label: string; className: string }> = {
  ingesting: { label: "Bajando referente", className: "border-accent/40 text-accent-strong" },
  ready: { label: "Referente listo", className: "border-emerald-500/40 text-emerald-600" },
  failed: { label: "Falló", className: "border-destructive/40 text-destructive" },
};

/** "30X — Andrés Bilbao" → "Andrés Bilbao": el prefijo se repite en todos. */
function shortAvatarName(name: string): string {
  return name.replace(/^30X\s*[—–-]\s*/i, "").trim() || name;
}

/**
 * Fecha en lenguaje de todos los días. El historial se lee para ubicarse ("esto
 * fue ayer"), no para auditar: un timestamp exacto ahí es ruido.
 */
function whenLabel(iso: string): string {
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return "recién";
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return "ayer";
  if (days < 7) return `hace ${days} días`;
  return then.toLocaleDateString();
}

function StatusBadge({ status }: { status: ManualEntry["status"] }) {
  const info = STATUS[status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
        info.className
      )}
    >
      {status === "ingesting" && (
        <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {info.label}
    </span>
  );
}

export interface ManualHistoryProps {
  /**
   * Cambia de valor cuando termina (o falla) una ingesta manual, para que el
   * historial se refresque sin tener que hacer poll todo el tiempo.
   */
  refreshKey?: number;
  /** Recarga el formulario de arriba con los datos de una entrada. */
  onReuse?: (entry: ManualEntry) => void;
}

/**
 * Historial de las entradas MANUALES de /30x: qué URL se pegó, con qué avatar y
 * cómo terminó. Es lo que antes se perdía — si la ingesta fallaba o se cerraba la
 * pestaña, había que volver a buscar el post en Instagram. Ahora queda acá, con
 * "Volver a usar" para reintentar sin retipear nada.
 */
export function ManualHistory({ refreshKey = 0, onReuse }: ManualHistoryProps) {
  const [entries, setEntries] = useState<ManualEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/thirtyx/manual-entries");
      const data = await res.json();
      setEntries(data.entries || []);
    } catch {
      // Sin historial la página sigue funcionando igual; no rompemos la vista.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const remove = useCallback(async (id: string) => {
    // Optimista: quitar una fila del historial no destruye nada (el carrusel
    // sigue vivo), así que no vale la pena bloquear la UI esperando al server.
    setEntries((list) => list.filter((e) => e.id !== id));
    await fetch(`/api/thirtyx/manual-entries/${id}`, { method: "DELETE" }).catch(() => {});
  }, []);

  if (loaded && entries.length === 0) return null;

  const visible = expanded ? entries : entries.slice(0, COLLAPSED_COUNT);
  const hidden = entries.length - visible.length;

  return (
    <section className="mt-12">
      <SectionLabel
        index="02"
        aside={entries.length > 0 ? `${entries.length} en total` : undefined}
      >
        Historial manual
      </SectionLabel>

      <ul className="space-y-3">
        {visible.map((entry) => (
          <li
            key={entry.id}
            className={cn(
              "rounded-xl border bg-surface p-4 transition-colors",
              entry.status === "ingesting" ? "border-accent/40" : "border-border"
            )}
          >
            <div className="flex gap-3">
              <AssignmentThumb
                carouselId={entry.carouselId}
                isActive={entry.status === "ingesting"}
              />

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <a
                    href={entry.referenceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-accent-strong hover:underline"
                  >
                    {entry.referenceUrl.replace(/^https?:\/\/(www\.)?/, "")}
                  </a>
                  <StatusBadge status={entry.status} />
                </div>

                <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground/70">
                    {entry.avatarName ? shortAvatarName(entry.avatarName) : entry.avatarSlug}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{whenLabel(entry.createdAt)}</span>
                  {entry.shared && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span
                        title="De antes del historial: no quedó registrado quién lo generó"
                        className="rounded-full border border-border px-1.5 py-px text-[10px]"
                      >
                        del equipo
                      </span>
                    </>
                  )}
                  {entry.referenceCount !== null && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>
                        {entry.referenceCount}{" "}
                        {entry.referenceCount === 1 ? "lámina" : "láminas"}
                      </span>
                    </>
                  )}
                </p>

                {entry.note && (
                  <p className="mt-2 line-clamp-2 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
                    {entry.note}
                  </p>
                )}

                {entry.status === "failed" && entry.error && (
                  <p className="mt-2 line-clamp-3 text-xs text-destructive">{entry.error}</p>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {entry.carouselId && (
                    <Link
                      href={`/carousel/${entry.carouselId}`}
                      className="text-xs font-medium text-accent-strong underline-offset-2 hover:underline"
                    >
                      Abrir carrusel →
                    </Link>
                  )}
                  {onReuse && entry.status !== "ingesting" && (
                    <Button size="sm" variant="outline" onClick={() => onReuse(entry)}>
                      Volver a usar
                    </Button>
                  )}
                  <button
                    type="button"
                    onClick={() => remove(entry.id)}
                    className="ml-auto cursor-pointer text-[11px] text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
                  >
                    Quitar del historial
                  </button>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-3 cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Ver {hidden} {hidden === 1 ? "entrada anterior" : "entradas anteriores"}
        </button>
      )}
    </section>
  );
}
