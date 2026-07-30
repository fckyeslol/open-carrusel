"use client";

import { useCallback, useEffect, useState } from "react";
import { BoardHeader } from "@/components/thirtyx/BoardHeader";
import { SectionLabel } from "@/components/thirtyx/SectionLabel";
import { cn } from "@/lib/utils";

interface DesignerStats {
  id: string;
  displayName: string;
  username: string;
  counts: number[];
  today: number;
  total: number;
}

interface StatsResponse {
  days: string[];
  today: string;
  rangeDays: number;
  ranges: number[];
  designers: DesignerStats[];
  totals: { today: number; range: number; activeToday: number };
}

/**
 * Refresco del panel. Más lento que el tablero (8s) a propósito: acá nadie está esperando
 * un cambio puntual, se mira para tener el pulso del día. Un poll agresivo sobre un
 * endpoint que lee la lista completa de usuarias no compra nada.
 */
const POLL_MS = 60000;

/** Día en "mié 29 jul" a partir de un YYYY-MM-DD, sin arrastrar una librería de fechas. */
function labelDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("es", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * Dashboard de revisiones del equipo (/revisiones).
 *
 * Responde una sola pregunta: cuántos carruseles está revisando cada diseñadora. El número
 * de HOY es el protagonista — es el que se mira a media tarde — y la serie de días al lado
 * está para dar contexto: un 3 puede ser poco o mucho según cómo venga la semana.
 */
export function ReviewStats() {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [days, setDays] = useState(14);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (rango: number) => {
    try {
      const res = await fetch(`/api/thirtyx/reviews?days=${rango}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "No se pudieron cargar las revisiones");
        return;
      }
      setError(null);
      setData(body as StatsResponse);
    } catch {
      setError("Error de red al cargar las revisiones");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      await load(days);
      if (cancelled) return;
      timer = setTimeout(tick, POLL_MS);
    };
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load, days]);

  // La escala de las barras es COMPARTIDA entre diseñadoras: si cada fila se normalizara
  // contra su propio máximo, quien revisó 2 y quien revisó 20 dibujarían la misma barra.
  const pico = Math.max(1, ...(data?.designers.flatMap((d) => d.counts) ?? [1]));

  return (
    <main className="min-h-screen bg-muted/20">
      <BoardHeader active="revisiones" />

      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Revisiones del equipo</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Cuántos carruseles revisó cada diseñadora. Un carrusel cuenta una vez por día.
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-background p-1">
            {(data?.ranges ?? [7, 14, 30]).map((r) => (
              <button
                key={r}
                onClick={() => setDays(r)}
                aria-pressed={days === r}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  days === r
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {r} días
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {!error && data && (
          <>
            {/* Los tres números de arriba: hoy manda, el rango da contexto. */}
            <div className="mb-8 grid gap-3 sm:grid-cols-3">
              <Stat
                value={data.totals.today}
                label="revisados hoy"
                hint={labelDay(data.today)}
                strong
              />
              <Stat
                value={data.totals.range}
                label={`en ${data.rangeDays} días`}
                hint={`promedio ${(data.totals.range / data.rangeDays).toFixed(1)} por día`}
              />
              <Stat
                value={data.totals.activeToday}
                label="diseñadoras activas hoy"
                hint={`de ${data.designers.length}`}
              />
            </div>

            <SectionLabel index="01" aside={`${data.rangeDays} días`}>
              Por diseñadora
            </SectionLabel>

            {data.designers.length === 0 ? (
              <p className="rounded-xl border border-border bg-background p-6 text-sm text-muted-foreground">
                Todavía no hay diseñadoras cargadas.
              </p>
            ) : (
              <ul className="space-y-2">
                {data.designers.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-center gap-4 rounded-xl border border-border bg-background px-4 py-3"
                  >
                    <span
                      aria-hidden="true"
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground"
                    >
                      {initials(d.displayName)}
                    </span>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{d.displayName}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {d.username}
                      </p>
                    </div>

                    <Sparkline counts={d.counts} days={data.days} peak={pico} />

                    <div className="w-14 shrink-0 text-right">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        {data.rangeDays}d
                      </p>
                      <p className="text-sm font-medium tabular-nums">{d.total}</p>
                    </div>

                    <div className="w-14 shrink-0 text-right">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Hoy
                      </p>
                      <p
                        className={cn(
                          "text-xl font-semibold tabular-nums",
                          d.today > 0 ? "text-foreground" : "text-muted-foreground/40"
                        )}
                      >
                        {d.today}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {!loaded && !error && <p className="text-sm text-muted-foreground">Cargando…</p>}
      </div>
    </main>
  );
}

function Stat({
  value,
  label,
  hint,
  strong,
}: {
  value: number;
  label: string;
  hint: string;
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        strong ? "border-accent/30 bg-accent/5" : "border-border bg-background"
      )}
    >
      <p
        className={cn(
          "text-3xl font-semibold tabular-nums leading-none",
          strong && "text-accent-strong"
        )}
      >
        {value}
      </p>
      <p className="mt-2 text-[13px] font-medium">{label}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * Barras de la ventana. El último día (hoy) va destacado porque es el que se está
 * mirando; los anteriores quedan en gris para leerse como contexto y no competir.
 *
 * Se oculta en pantallas chicas: en un teléfono compiten con el número de hoy, que es lo
 * que de verdad hace falta ver.
 */
function Sparkline({
  counts,
  days,
  peak,
}: {
  counts: number[];
  days: string[];
  peak: number;
}) {
  return (
    <div className="hidden h-9 shrink-0 items-end gap-[3px] sm:flex" aria-hidden="true">
      {counts.map((n, i) => {
        const esHoy = i === counts.length - 1;
        return (
          <span
            key={days[i] ?? i}
            title={`${labelDay(days[i])}: ${n}`}
            style={{ height: `${Math.max(2, (n / peak) * 100)}%` }}
            className={cn(
              "w-[6px] rounded-sm",
              n === 0
                ? "bg-border"
                : esHoy
                  ? "bg-accent-strong"
                  : "bg-foreground/25"
            )}
          />
        );
      })}
    </div>
  );
}
