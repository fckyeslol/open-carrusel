"use client";

import { useCallback, useRef, useState } from "react";
import { readSseStream } from "@/lib/sse";
import type { IngestEvent, IngestStageId } from "@/types/ingest-progress";
import type { StageMap } from "@/components/thirtyx/IngestProgress";

export interface IngestDone {
  carouselId: string;
  generationMessage: string;
  referenceCount: number;
}

export interface IngestError {
  stage: IngestStageId | null;
  message: string;
  recovery?: string;
}

export interface IngestState {
  /** Qué ingesta corre ("manual" o el id del job); null si no hay ninguna. */
  runningKey: string | null;
  stages: StageMap;
  startedAt: number | null;
  error: IngestError | null;
  finished: boolean;
}

const IDLE: IngestState = {
  runningKey: null,
  stages: {},
  startedAt: null,
  error: null,
  finished: false,
};

/**
 * Corre una ingesta 30x consumiendo el stream SSE de la ruta y exponiendo el
 * estado etapa por etapa.
 *
 * `start` recibe el `key` (para saber qué botón está ocupado) y la request ya
 * armada, así sirve tanto para la entrada manual como para un job de la cola.
 */
export function useIngest(onDone: (result: IngestDone) => void) {
  const [state, setState] = useState<IngestState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(IDLE);
  }, []);

  const start = useCallback(
    async (key: string, request: (signal: AbortSignal) => Promise<Response>) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState({
        runningKey: key,
        stages: {},
        startedAt: Date.now(),
        error: null,
        finished: false,
      });

      try {
        const res = await request(controller.signal);

        // Errores de validación llegan como JSON con status 4xx, antes del stream.
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setState((s) => ({
            ...s,
            error: { stage: null, message: data.error || `Error ${res.status}` },
          }));
          return;
        }

        // Holder mutable: TypeScript no sigue asignaciones hechas dentro del closure.
        const done: { value: IngestDone | null } = { value: null };

        await readSseStream<IngestEvent>(res, (event) => {
          if (event.type === "stage") {
            setState((s) => ({
              ...s,
              stages: {
                ...s.stages,
                [event.id]: {
                  status: event.status,
                  detail: event.detail,
                  progress: event.progress,
                },
              },
            }));
            return;
          }

          if (event.type === "error") {
            setState((s) => ({
              ...s,
              error: {
                stage: event.stage,
                message: event.message,
                recovery: event.recovery,
              },
            }));
            return;
          }

          done.value = {
            carouselId: event.carouselId,
            generationMessage: event.generationMessage,
            referenceCount: event.referenceCount,
          };
          setState((s) => ({ ...s, finished: true }));
        });

        if (done.value) onDone(done.value);
      } catch (e) {
        // Un abort es una cancelación pedida por la usuaria, no un fallo.
        if (controller.signal.aborted) return;
        setState((s) => ({
          ...s,
          error: {
            stage: null,
            message: (e as Error).message || "Se cortó la conexión con el servidor",
            recovery: "Revisá que el servidor siga corriendo y probá de nuevo.",
          },
        }));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [onDone]
  );

  return { ...state, start, reset };
}
