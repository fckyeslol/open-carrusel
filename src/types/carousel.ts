export type AspectRatio = "1:1" | "4:5" | "9:16";

export interface Slide {
  id: string;
  html: string;
  previousVersions: string[]; // pila de deshacer (Ctrl+Z): versiones anteriores
  redoVersions?: string[]; // pila de rehacer (Ctrl+Y): versiones deshechas por reponer
  order: number;
  notes: string;
}

/**
 * Lo que devuelve `GET /api/carousels/{id}/summary`: lo que las tarjetas del tablero
 * necesitan sin arrastrar el carrusel completo (ni su historial de undo).
 */
export interface CarouselSummary {
  aspectRatio: AspectRatio;
  slideCount: number;
  referenceCount: number;
  firstSlideHtml: string | null;
}

export interface ReferenceImage {
  id: string;
  url: string;       // e.g. "/uploads/abc.png"
  absPath: string;    // absolute path for Claude to Read
  name: string;       // original filename or description
  addedAt: string;
}

export interface Carousel {
  id: string;
  name: string;
  aspectRatio: AspectRatio;
  slides: Slide[];
  referenceImages: ReferenceImage[];
  caption?: string;
  hashtags?: string[];
  chatSessionId: string | null;
  isTemplate: boolean;
  tags: string[];
  // ── Integración 30x ──────────────────────────────────────────────────────────
  stylePresetId?: string; // preset del avatar (identidad) activo para este carrusel
  avatarSlug?: string; // avatar destino (cinthya, guillermo, …)
  prewaveJobId?: string; // job de la cola agent_jobs del que nació (si vino de la cola)
  source?: "manual" | "queue"; // origen de la ingesta
  referenceUrl?: string; // URL del referente de Instagram
  resizedFrom?: string; // id del carrusel original si este nació de "Generar otros tamaños"
  createdAt: string;
  updatedAt: string;
}

export interface CarouselsData {
  carousels: Carousel[];
}

export const DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "9:16": { width: 1080, height: 1920 },
};

export const ASPECT_RATIOS: AspectRatio[] = ["1:1", "4:5", "9:16"];

/** Los otros dos formatos, distintos al dado (para "Generar otros tamaños"). */
export function otherAspectRatios(ratio: AspectRatio): AspectRatio[] {
  return ASPECT_RATIOS.filter((r) => r !== ratio);
}

export const MAX_SLIDES = 20;
/**
 * Versiones de deshacer que se guardan por lámina.
 *
 * Cada versión es una copia COMPLETA del HTML de la lámina, así que esto multiplica
 * el peso del store: con 30, el historial era el 75% de `carousels.json` (20.9 MB de
 * 28 MB, con 475 carruseles y 2347 láminas) y cada lectura del store tenía que
 * parsearlo entero. Cinco cubre una sesión de edición real; treinta era guardar para
 * siempre algo que nadie deshace.
 */
export const MAX_VERSIONS = 5;
