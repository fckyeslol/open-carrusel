/**
 * Contrato de progreso de la ingesta 30x.
 *
 * La ingesta (referente de Instagram → carrusel) tarda hasta 2 minutos y hace
 * varias cosas muy distintas por dentro. Este tipo es lo que viaja por SSE para
 * que la UI pueda decir EN QUÉ va y, si falla, EN QUÉ ETAPA falló.
 */

export type IngestStageId =
  | "preset" // resolver el avatar y su preset de estilo
  | "carousel" // crear el carrusel vacío
  | "browser" // abrir el navegador headless
  | "extract" // leer el post y sacar las URLs reales de las imágenes
  | "download" // bajar las láminas del referente
  | "attach"; // adjuntar las láminas al carrusel

export type IngestStageStatus = "pending" | "active" | "done" | "failed";

/** Orden y etiquetas de las etapas. La UI lo usa para pintar la lista completa
 *  desde el principio: así se ve el camino entero, no solo el paso actual. */
export const INGEST_STAGES: ReadonlyArray<{
  id: IngestStageId;
  label: string;
  /** Qué esperar, en lenguaje de la diseñadora — no de la implementación. */
  hint: string;
}> = [
  { id: "preset", label: "Buscando el ADN del avatar", hint: "Tipografía, paleta y logo" },
  { id: "carousel", label: "Creando el carrusel", hint: "Formato y preset de estilo" },
  { id: "browser", label: "Abriendo el navegador", hint: "Chrome en segundo plano" },
  { id: "extract", label: "Leyendo el post de Instagram", hint: "Suele ser lo más lento" },
  { id: "download", label: "Bajando las láminas", hint: "Una imagen por lámina" },
  { id: "attach", label: "Adjuntando el referente", hint: "Listo para generar" },
] as const;

/** Progreso contable dentro de una etapa (p. ej. imagen 3 de 8). */
export interface IngestStageProgress {
  current: number;
  total: number;
}

export type IngestEvent =
  | {
      type: "stage";
      id: IngestStageId;
      status: Extract<IngestStageStatus, "active" | "done">;
      /** Detalle opcional que reemplaza al hint mientras la etapa corre. */
      detail?: string;
      progress?: IngestStageProgress;
    }
  | {
      type: "done";
      carouselId: string;
      stylePresetId: string;
      referenceCount: number;
      generationMessage: string;
    }
  | {
      type: "error";
      /** Etapa donde reventó, para que la UI marque ESE paso en rojo. */
      stage: IngestStageId | null;
      message: string;
      /** Qué puede hacer la usuaria para salir del problema. */
      recovery?: string;
    };

/** Callback que `ingestReference` usa para reportar avance hacia afuera. */
export type IngestProgressReporter = (
  event: Extract<IngestEvent, { type: "stage" }>
) => void;
