"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  INGEST_STAGES,
  type IngestStageId,
  type IngestStageProgress,
  type IngestStageStatus,
} from "@/types/ingest-progress";

export interface StageState {
  status: IngestStageStatus;
  detail?: string;
  progress?: IngestStageProgress;
}

export type StageMap = Partial<Record<IngestStageId, StageState>>;

interface IngestProgressProps {
  stages: StageMap;
  /** Momento (Date.now()) en que arrancó la ingesta, para el cronómetro. */
  startedAt: number;
  /** Se detiene el cronómetro y se congela el estado. */
  finished?: boolean;
  error?: { stage: IngestStageId | null; message: string; recovery?: string } | null;
  onRetry?: () => void;
  onCancel?: () => void;
}

/** mm:ss con cifras tabulares — así el ancho no baila mientras corre. */
function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function useElapsed(startedAt: number, frozen: boolean): number {
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);

  useEffect(() => {
    if (frozen) return;
    // 1s basta: es un cronómetro, no una animación.
    const tick = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(tick);
  }, [startedAt, frozen]);

  return frozen ? elapsed : Math.max(0, elapsed);
}

function StageIcon({ status }: { status: IngestStageStatus }) {
  if (status === "done") {
    return (
      <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5 text-foreground" aria-hidden="true">
        <circle cx="10" cy="10" r="9" className="fill-foreground/10" />
        <path
          d="M6 10.5l2.5 2.5L14 7.5"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (status === "failed") {
    return (
      <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5 text-destructive" aria-hidden="true">
        <circle cx="10" cy="10" r="9" className="fill-destructive/10" />
        <path
          d="M7 7l6 6M13 7l-6 6"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (status === "active") {
    return (
      <span className="relative flex h-5 w-5 items-center justify-center" aria-hidden="true">
        {/* Pulso de fondo: comunica "esto está vivo" sin girar nada. */}
        <span className="oc-ping absolute h-5 w-5 rounded-full bg-accent/25" />
        <span className="relative h-2.5 w-2.5 rounded-full bg-accent" />
      </span>
    );
  }

  return (
    <span className="flex h-5 w-5 items-center justify-center" aria-hidden="true">
      <span className="h-2 w-2 rounded-full border border-border bg-transparent" />
    </span>
  );
}

export function IngestProgress({
  stages,
  startedAt,
  finished = false,
  error = null,
  onRetry,
  onCancel,
}: IngestProgressProps) {
  const elapsed = useElapsed(startedAt, finished || !!error);

  const activeStage = INGEST_STAGES.find((s) => stages[s.id]?.status === "active");
  const doneCount = INGEST_STAGES.filter((s) => stages[s.id]?.status === "done").length;

  // La etapa que falló se pinta en rojo; si el error no trae etapa, se marca la activa.
  const failedStageId = error ? (error.stage ?? activeStage?.id ?? null) : null;

  return (
    <div
      className={cn(
        "rounded-xl border bg-surface p-5",
        error ? "border-destructive/40" : "border-border"
      )}
    >
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-sm font-semibold">
          {error
            ? "La ingesta se detuvo"
            : finished
              ? "Referente listo"
              : "Bajando el referente…"}
        </h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground tabular-nums">
            {doneCount}/{INGEST_STAGES.length} · {formatElapsed(elapsed)}
          </span>
          {!finished && !error && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground cursor-pointer"
            >
              Cancelar
            </button>
          )}
        </div>
      </div>

      {/* Anuncio para lectores de pantalla: solo la etapa actual, sin ruido. */}
      <p aria-live="polite" className="sr-only">
        {error
          ? `Error: ${error.message}`
          : activeStage
            ? `Paso ${doneCount + 1} de ${INGEST_STAGES.length}: ${activeStage.label}`
            : ""}
      </p>

      <ol className="mt-4 space-y-0.5">
        {INGEST_STAGES.map((stage, index) => {
          const state = stages[stage.id];
          const status: IngestStageStatus =
            failedStageId === stage.id ? "failed" : (state?.status ?? "pending");
          const isLast = index === INGEST_STAGES.length - 1;
          const pct =
            state?.progress && state.progress.total > 0
              ? state.progress.current / state.progress.total
              : null;

          return (
            <li key={stage.id} className="flex gap-3">
              {/* Riel: icono + línea conectora, para que se lea como un camino. */}
              <div className="flex flex-col items-center">
                <StageIcon status={status} />
                {!isLast && (
                  <span
                    className={cn(
                      "w-px flex-1 transition-colors duration-300",
                      status === "done" ? "bg-foreground/20" : "bg-border"
                    )}
                  />
                )}
              </div>

              <div className={cn("min-w-0 flex-1 pb-3", isLast && "pb-0")}>
                <div className="flex items-baseline justify-between gap-3">
                  <span
                    className={cn(
                      "text-sm transition-colors duration-300",
                      status === "active" && "font-medium text-foreground",
                      status === "done" && "text-muted-foreground",
                      status === "failed" && "font-medium text-destructive",
                      status === "pending" && "text-muted-foreground/50"
                    )}
                  >
                    {stage.label}
                  </span>
                  {state?.detail && status !== "failed" && (
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {state.detail}
                    </span>
                  )}
                </div>

                {/* El hint solo aparece en la etapa viva: contexto cuando sirve, no siempre. */}
                {status === "active" && !state?.detail && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{stage.hint}</p>
                )}

                {/* Barra determinada solo cuando sabemos el total (descarga). */}
                {status === "active" && pct !== null && (
                  <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="oc-bar h-full rounded-full bg-accent"
                      style={{ transform: `scaleX(${pct})` }}
                    />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {error && (
        <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <p className="text-sm text-destructive">{error.message}</p>
          {error.recovery && (
            <p className="mt-1 text-xs text-muted-foreground">{error.recovery}</p>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 inline-flex h-8 cursor-pointer items-center rounded-md border border-border bg-surface px-3 text-xs font-medium hover:bg-muted"
            >
              Reintentar
            </button>
          )}
        </div>
      )}
    </div>
  );
}
