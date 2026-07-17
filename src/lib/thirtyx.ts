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

const UPLOAD_DIR = path.resolve(process.cwd(), "public", "uploads");

export interface IngestParams {
  referenceUrl: string;
  avatarSlug: string;
  name?: string;
  prewaveJobId?: string;
  source: "manual" | "queue";
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
  const { referenceUrl, avatarSlug, prewaveJobId, source } = params;

  const preset = await getPresetByAvatarSlug(avatarSlug);
  if (!preset) {
    throw new Error(
      `No hay un preset para el avatar "${avatarSlug}". Corré: node scripts/import-avatars.mjs`
    );
  }
  if (preset.avatarStatus && preset.avatarStatus !== "ready") {
    throw new Error(
      `El avatar "${avatarSlug}" no está listo (status=${preset.avatarStatus}): falta completar su ADN o sus formatos.`
    );
  }

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

  await mkdir(UPLOAD_DIR, { recursive: true });
  const slides = await downloadInstagramReference(referenceUrl, UPLOAD_DIR, generateId);

  for (const s of slides) {
    await addReferenceImage(carousel.id, {
      id: generateId(),
      url: s.url,
      absPath: s.absPath,
      name: s.name,
      addedAt: now(),
    });
  }

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
    "",
    "Aplicá los cambios creando las láminas ahora. No pidas permiso.",
  ].join("\n");
}
