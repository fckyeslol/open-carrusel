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
    `Generá el carrusel COMPLETO replicando el referente de Instagram que ya está adjunto (${referenceCount} imágenes de referencia).`,
    "",
    "Proceso:",
    "1. Leé cada imagen de referencia con Read para entender su ESTRUCTURA (qué bloques hay, jerarquía, rol de cada lámina: gancho, dato, cita, paso, cierre).",
    "2. Creá UNA lámina por cada slide del referente, respetando su conteo y su estructura.",
    "3. Reescribí el contenido en español con la voz del avatar activo. FIDELIDAD ESTRICTA: cada cifra, dato y fuente del referente sobrevive EXACTO. No inventes nada.",
    "4. Usá la identidad visual del avatar (su tipografía, su paleta, sus formatos de ejemplo). NUNCA la de otro avatar.",
    "5. La última lámina cierra con la firma del avatar.",
    "",
    "Aplicá los cambios creando las láminas ahora. No pidas permiso.",
  ].join("\n");
}
