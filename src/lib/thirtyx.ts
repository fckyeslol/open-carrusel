/**
 * Lógica de ingesta 30x: convertir un REFERENTE de Instagram (+ un avatar) en un
 * carrusel editable de Open Carrusel, listo para que el Claude local lo genere.
 *
 * Compartida por los dos orígenes:
 *   - URL manual  (POST /api/thirtyx/from-reference)
 *   - Cola Prewave (POST /api/thirtyx/jobs/[id]/start) — la ingesta ACTUAL
 */
import path from "path";
import { mkdir } from "fs/promises";
import { createCarousel, addReferenceImage } from "./carousels";
import { getPresetByAvatarSlug } from "./style-presets";
import { downloadInstagramReference } from "./instagram";
import { generateId, now } from "./utils";
import type { Carousel } from "@/types/carousel";
import type { StylePreset } from "@/types/style-preset";
import type {
  IngestEvent,
  IngestProgressReporter,
  IngestStageId,
} from "@/types/ingest-progress";

const UPLOAD_DIR = path.resolve(process.cwd(), "public", "uploads");

export interface IngestParams {
  referenceUrl: string;
  avatarSlug: string;
  name?: string;
  prewaveJobId?: string;
  source: "manual" | "queue";
  /** Opcional: reporta el avance etapa por etapa (la UI lo consume vía SSE). */
  onProgress?: IngestProgressReporter;
}

/** Error de ingesta que recuerda EN QUÉ etapa reventó y cómo salir del paso. */
export class IngestError extends Error {
  constructor(
    message: string,
    readonly stage: IngestStageId,
    readonly recovery?: string
  ) {
    super(message);
    this.name = "IngestError";
  }
}

/** Qué puede hacer la usuaria cuando se cae cada etapa. */
const RECOVERY_BY_STAGE: Partial<Record<IngestStageId, string>> = {
  browser:
    "No se pudo abrir Chrome. Instalá Google Chrome o definí PUPPETEER_EXECUTABLE_PATH.",
  extract:
    "Verificá que el post sea público y que la URL abra en el navegador. Si Instagram pide login, subí capturas del referente a mano.",
  download:
    "Instagram devolvió las imágenes pero no se pudieron guardar. Probá de nuevo o subí capturas a mano.",
};

/** Traduce cualquier fallo de la ingesta al evento que la UI sabe pintar. */
export function toIngestErrorEvent(
  error: unknown
): Extract<IngestEvent, { type: "error" }> {
  if (error instanceof IngestError) {
    return {
      type: "error",
      stage: error.stage,
      message: error.message,
      recovery: error.recovery,
    };
  }
  return {
    type: "error",
    stage: null,
    message: (error as Error)?.message || "Falló la ingesta del referente",
  };
}

export interface IngestResult {
  carousel: Carousel;
  preset: StylePreset;
  referenceCount: number;
}

/**
 * Crea el carrusel: resuelve el preset del avatar, descarga las slides del
 * referente y las adjunta. NO genera todavía — eso lo dispara el chat (Claude local).
 */
export async function ingestReference(params: IngestParams): Promise<IngestResult> {
  const { referenceUrl, avatarSlug, prewaveJobId, source, onProgress } = params;

  // Se recuerda la última etapa arrancada para poder atribuirle un fallo con
  // precisión: si Chrome no abre, el error es de "browser", no de "download".
  let currentStage: IngestStageId = "preset";

  const begin = (id: IngestStageId, detail?: string) => {
    currentStage = id;
    onProgress?.({ type: "stage", id, status: "active", detail });
  };
  const finish = (id: IngestStageId, detail?: string) =>
    onProgress?.({ type: "stage", id, status: "done", detail });

  // 1. Preset del avatar ------------------------------------------------------
  begin("preset");
  const preset = await getPresetByAvatarSlug(avatarSlug);
  if (!preset) {
    throw new IngestError(
      `No hay un preset para el avatar "${avatarSlug}".`,
      "preset",
      "Corré `node scripts/import-avatars.mjs` para importar los avatares."
    );
  }
  if (preset.avatarStatus && preset.avatarStatus !== "ready") {
    throw new IngestError(
      `El avatar "${avatarSlug}" no está listo (status=${preset.avatarStatus}).`,
      "preset",
      "Falta completar su ADN o sus formatos antes de poder generar con él."
    );
  }
  finish("preset", preset.name);

  // 2. Carrusel vacío ---------------------------------------------------------
  begin("carousel");
  const name =
    params.name?.trim() ||
    `${preset.name} — ${new Date().toISOString().slice(0, 10)}`;

  const carousel = await createCarousel(name, preset.aspectRatio, {
    stylePresetId: preset.id,
    avatarSlug: preset.avatarSlug || avatarSlug,
    prewaveJobId,
    source,
    referenceUrl,
    tags: ["30x", `avatar:${avatarSlug}`],
  });
  finish("carousel", preset.aspectRatio);

  // 3-5. Navegador + lectura del post + descarga de láminas -------------------
  await mkdir(UPLOAD_DIR, { recursive: true });
  begin("browser");

  let slides;
  try {
    slides = await downloadInstagramReference(referenceUrl, UPLOAD_DIR, generateId, {
      onBrowserReady: () => finish("browser"),
      onExtractStart: () => begin("extract"),
      onExtracted: (count) => {
        finish("extract", `${count} ${count === 1 ? "lámina" : "láminas"}`);
        begin("download", `0 de ${count}`);
      },
      onSlideDownloaded: (current, total) =>
        onProgress?.({
          type: "stage",
          id: "download",
          status: "active",
          detail: `${current} de ${total}`,
          progress: { current, total },
        }),
    });
  } catch (e) {
    // El mensaje de instagram.ts ya explica la causa probable; acá se le adjunta
    // la etapa REAL en la que se cortó. Atribuirlo siempre a "download" dejaría
    // "browser" o "extract" pulsando como activas para siempre.
    throw new IngestError((e as Error).message, currentStage, RECOVERY_BY_STAGE[currentStage]);
  }
  finish("download", `${slides.length} ${slides.length === 1 ? "lámina" : "láminas"}`);

  // 6. Adjuntar al carrusel ---------------------------------------------------
  begin("attach");
  for (const s of slides) {
    await addReferenceImage(carousel.id, {
      id: generateId(),
      url: s.url,
      absPath: s.absPath,
      name: s.name,
      addedAt: now(),
    });
  }
  finish("attach");

  return { carousel, preset, referenceCount: slides.length };
}

/**
 * Mensaje que se le manda al Claude local para GENERAR el carrusel a partir del
 * referente ya adjunto. El system prompt (buildSystemPrompt) ya inyecta la
 * identidad del avatar (brand del preset), sus reglas de diseño, su formato de
 * ejemplo y las rutas de las imágenes de referencia (para Read).
 */
export function buildGenerationMessage(referenceCount: number): string {
  return [
    `Generá el carrusel COMPLETO copiando el referente de Instagram adjunto (${referenceCount} imágenes de referencia) al 100%.`,
    "",
    "REGLA #1: el LAYOUT lo manda el referente, SIEMPRE. Lo ÚNICO que cambia es NUESTRA identidad (tipografía, paleta, logo del avatar activo).",
    "",
    "Proceso:",
    "1. Leé CADA imagen de referencia con Read y describí su LAYOUT exacto: qué elementos hay, dónde está cada uno (arriba/centro/abajo, izq/der), tamaños relativos, jerarquía, si es foto a sangre / número gigante / cita / lista / comparación.",
    "2. Una lámina de output por cada lámina del referente — mismo conteo, mismo orden.",
    "3. Reproducí ESE layout en HTML, cada bloque donde está en el referente, llenando el lienzo como lo llena el referente. NO improvises una estructura propia ni la fuerces dentro de un formato de ejemplo.",
    "4. Aplicá SOLO la identidad del avatar: su tipografía en titulares, su paleta en fondos/texto/acento, su logo 30X, su firma. Los formatos de ejemplo (public/30x-slides/<avatar>/) son solo la muestra de esos VALORES de identidad — copiá de ahí la fuente/hex/logo/tratamiento, NUNCA el layout.",
    "5. FIDELIDAD ESTRICTA de contenido: cada cifra, dato, prompt y fuente del referente sobrevive EXACTO. No inventes.",
    "6. VERIFICÁ CADA LÁMINA antes de pasar a la siguiente: corré slide-check, leé el PNG con Read y corregí. Mirá especialmente las derivas del ADN (~): al calcar es fácil quedarse con los colores del referente en vez de aplicar la paleta del avatar, y eso no se ve escribiendo el HTML.",
    "",
    `CONTRATO DE COMPLETITUD (no negociable): el trabajo NO está terminado hasta que existan las ${referenceCount} láminas. Después de verificar una lámina, seguí INMEDIATAMENTE con la siguiente — no cierres tu turno, no resumas, no pidas permiso ni confirmación entre láminas. Recién cuando el carrusel tenga las ${referenceCount} láminas generás el caption y terminás.`,
    "",
    "Aplicá los cambios creando las láminas ahora. No pidas permiso.",
  ].join("\n");
}

/**
 * Mensaje para REANUDAR una generación que se cortó antes de completar todas las
 * láminas. El runner lo dispara sobre la misma sesión de Claude (--resume) cuando
 * detecta que faltan láminas: el agente conserva el contexto (las imágenes que ya
 * leyó, las láminas que ya creó) y solo tiene que seguir desde donde quedó.
 */
export function buildContinuationMessage(existing: number, total: number): string {
  const missing = total - existing;
  return [
    `El carrusel quedó INCOMPLETO: hay ${existing} de ${total} láminas. Faltan ${missing}.`,
    "",
    `Continuá AHORA generando las láminas ${existing + 1} a ${total} del referente, en orden, sin rehacer las que ya existen.`,
    "1. Leé el carrusel (GET) para ver qué láminas ya están y con qué orden.",
    "2. Reproducí el layout de la lámina equivalente del referente para cada una que falte, con la identidad del avatar y fidelidad estricta al contenido.",
    "3. Verificá cada lámina con slide-check + Read del PNG antes de seguir con la próxima.",
    "",
    `No cierres tu turno hasta que existan las ${total} láminas. No pidas permiso.`,
  ].join("\n");
}
