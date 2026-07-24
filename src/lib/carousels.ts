import { readDataSafe, writeData } from "./data";
import { generateId, now } from "./utils";
import type { Carousel, CarouselsData, Slide, AspectRatio, ReferenceImage } from "@/types/carousel";
import { MAX_SLIDES, MAX_VERSIONS } from "@/types/carousel";

const FILE = "carousels.json";

async function load(): Promise<CarouselsData> {
  return readDataSafe<CarouselsData>(FILE, { carousels: [] });
}

async function save(data: CarouselsData): Promise<void> {
  await writeData(FILE, data);
}

export async function listCarousels(): Promise<Carousel[]> {
  const data = await load();
  return data.carousels.filter((c) => !c.isTemplate);
}

export async function getCarousel(id: string): Promise<Carousel | null> {
  const data = await load();
  return data.carousels.find((c) => c.id === id) ?? null;
}

export async function createCarousel(
  name: string,
  aspectRatio: AspectRatio,
  extra?: Partial<Pick<Carousel, "stylePresetId" | "avatarSlug" | "prewaveJobId" | "source" | "referenceUrl" | "tags">>
): Promise<Carousel> {
  const data = await load();
  const carousel: Carousel = {
    id: generateId(),
    name,
    aspectRatio,
    slides: [],
    referenceImages: [],
    chatSessionId: null,
    isTemplate: false,
    tags: extra?.tags ?? [],
    stylePresetId: extra?.stylePresetId,
    avatarSlug: extra?.avatarSlug,
    prewaveJobId: extra?.prewaveJobId,
    source: extra?.source,
    referenceUrl: extra?.referenceUrl,
    createdAt: now(),
    updatedAt: now(),
  };
  data.carousels.push(carousel);
  await save(data);
  return carousel;
}

export async function updateCarousel(
  id: string,
  updates: Partial<
    Pick<
      Carousel,
      | "name"
      | "aspectRatio"
      | "tags"
      | "chatSessionId"
      | "caption"
      | "hashtags"
      | "stylePresetId"
      | "avatarSlug"
      | "prewaveJobId"
      | "source"
      | "referenceUrl"
    >
  >
): Promise<Carousel | null> {
  const data = await load();
  const idx = data.carousels.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  Object.assign(data.carousels[idx], updates, { updatedAt: now() });
  await save(data);
  return data.carousels[idx];
}

export async function duplicateCarousel(id: string): Promise<Carousel | null> {
  const data = await load();
  const source = data.carousels.find((c) => c.id === id);
  if (!source) return null;

  const duplicate: Carousel = {
    ...source,
    id: generateId(),
    name: `${source.name} (copy)`,
    slides: source.slides.map((s) => ({
      ...s,
      id: generateId(),
      previousVersions: [],
    })),
    referenceImages: [...(source.referenceImages || [])],
    chatSessionId: null,
    isTemplate: false,
    createdAt: now(),
    updatedAt: now(),
  };

  data.carousels.push(duplicate);
  await save(data);
  return duplicate;
}

/** Quita un sufijo de formato tipo " (9:16)" del nombre, para no encadenarlos. */
function stripRatioSuffix(name: string): string {
  return name.replace(/\s*\((?:1:1|4:5|9:16)\)\s*$/, "").trim();
}

/**
 * Crea un carrusel HERMANO de `sourceId` en otro formato. Copia el contenido
 * verbatim (mismo HTML de láminas, referencias, identidad y caption) pero con el
 * `aspectRatio` destino, para que si la re-maquetación con IA falla igual quede
 * algo utilizable. El re-flow del layout al lienzo nuevo lo hace después el
 * runner de resize (IA). Enlaza al original con `resizedFrom`.
 */
export async function createResizedSibling(
  sourceId: string,
  targetRatio: AspectRatio
): Promise<Carousel | null> {
  const data = await load();
  const source = data.carousels.find((c) => c.id === sourceId);
  if (!source) return null;

  const sibling: Carousel = {
    ...source,
    id: generateId(),
    name: `${stripRatioSuffix(source.name)} (${targetRatio})`,
    aspectRatio: targetRatio,
    slides: source.slides.map((s) => ({
      ...s,
      id: generateId(),
      previousVersions: [],
      redoVersions: [],
    })),
    referenceImages: [...(source.referenceImages || [])],
    chatSessionId: null,
    isTemplate: false,
    resizedFrom: sourceId,
    // Un hermano de resize nunca hereda el vínculo con la cola: es un derivado local.
    prewaveJobId: undefined,
    createdAt: now(),
    updatedAt: now(),
  };

  data.carousels.push(sibling);
  await save(data);
  return sibling;
}

export async function deleteCarousel(id: string): Promise<boolean> {
  const data = await load();
  const idx = data.carousels.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  data.carousels.splice(idx, 1);
  await save(data);
  return true;
}

// --- Slide operations ---

/**
 * HTML de una lámina en blanco: un lienzo blanco a sangre. El diseñador (o la IA)
 * la rellena después. Se usa para el botón "+" de la tira, sobre todo para armar
 * el CTA final, que normalmente se agrega aparte del contenido generado.
 */
export const BLANK_SLIDE_HTML =
  '<div style="width:100%;height:100%;background:#ffffff;"></div>';

export async function addSlide(
  carouselId: string,
  html: string,
  notes = ""
): Promise<Slide | null> {
  const data = await load();
  const carousel = data.carousels.find((c) => c.id === carouselId);
  if (!carousel) return null;
  if (carousel.slides.length >= MAX_SLIDES) return null;

  const slide: Slide = {
    id: generateId(),
    html,
    previousVersions: [],
    order: carousel.slides.length,
    notes,
  };
  carousel.slides.push(slide);
  carousel.updatedAt = now();
  await save(data);
  return slide;
}

/** Agrega una lámina en blanco al final del carrusel. */
export async function addBlankSlide(
  carouselId: string,
  notes = ""
): Promise<Slide | null> {
  return addSlide(carouselId, BLANK_SLIDE_HTML, notes);
}

/**
 * Duplica una lámina insertando la copia JUSTO DESPUÉS del original. El historial
 * (deshacer/rehacer) arranca vacío en la copia: es una lámina nueva, no comparte
 * pasado con la original.
 */
export async function duplicateSlide(
  carouselId: string,
  slideId: string
): Promise<Slide | null> {
  const data = await load();
  const carousel = data.carousels.find((c) => c.id === carouselId);
  if (!carousel) return null;
  if (carousel.slides.length >= MAX_SLIDES) return null;

  const idx = carousel.slides.findIndex((s) => s.id === slideId);
  if (idx === -1) return null;

  const source = carousel.slides[idx];
  const copy: Slide = {
    id: generateId(),
    html: source.html,
    previousVersions: [],
    redoVersions: [],
    order: 0, // se recalcula abajo
    notes: source.notes,
  };

  carousel.slides.splice(idx + 1, 0, copy);
  carousel.slides.forEach((s, i) => {
    s.order = i;
  });
  carousel.updatedAt = now();
  await save(data);
  return copy;
}

export async function updateSlide(
  carouselId: string,
  slideId: string,
  updates: Partial<Pick<Slide, "html" | "notes">>
): Promise<Slide | null> {
  const data = await load();
  const carousel = data.carousels.find((c) => c.id === carouselId);
  if (!carousel) return null;
  const slide = carousel.slides.find((s) => s.id === slideId);
  if (!slide) return null;

  // Save current HTML to version history before overwriting
  if (updates.html && updates.html !== slide.html) {
    slide.previousVersions.push(slide.html);
    if (slide.previousVersions.length > MAX_VERSIONS) {
      slide.previousVersions.shift();
    }
    // Una edición nueva invalida el futuro: se descarta lo que se pudiera rehacer.
    slide.redoVersions = [];
  }

  Object.assign(slide, updates);
  carousel.updatedAt = now();
  await save(data);
  return slide;
}

export async function deleteSlide(
  carouselId: string,
  slideId: string
): Promise<boolean> {
  const data = await load();
  const carousel = data.carousels.find((c) => c.id === carouselId);
  if (!carousel) return false;
  const idx = carousel.slides.findIndex((s) => s.id === slideId);
  if (idx === -1) return false;

  carousel.slides.splice(idx, 1);
  // Re-order remaining slides
  carousel.slides.forEach((s, i) => {
    s.order = i;
  });
  carousel.updatedAt = now();
  await save(data);
  return true;
}

export async function reorderSlides(
  carouselId: string,
  slideIds: string[]
): Promise<boolean> {
  const data = await load();
  const carousel = data.carousels.find((c) => c.id === carouselId);
  if (!carousel) return false;

  const slideMap = new Map(carousel.slides.map((s) => [s.id, s]));
  const reordered: Slide[] = [];
  for (const id of slideIds) {
    const slide = slideMap.get(id);
    if (!slide) return false;
    slide.order = reordered.length;
    reordered.push(slide);
  }
  carousel.slides = reordered;
  carousel.updatedAt = now();
  await save(data);
  return true;
}

export async function undoSlide(
  carouselId: string,
  slideId: string
): Promise<Slide | null> {
  const data = await load();
  const carousel = data.carousels.find((c) => c.id === carouselId);
  if (!carousel) return null;
  const slide = carousel.slides.find((s) => s.id === slideId);
  if (!slide || slide.previousVersions.length === 0) return null;

  // El HTML actual se guarda en la pila de rehacer antes de retroceder.
  if (!slide.redoVersions) slide.redoVersions = [];
  slide.redoVersions.push(slide.html);
  if (slide.redoVersions.length > MAX_VERSIONS) slide.redoVersions.shift();

  const previousHtml = slide.previousVersions.pop()!;
  slide.html = previousHtml;
  carousel.updatedAt = now();
  await save(data);
  return slide;
}

export async function redoSlide(
  carouselId: string,
  slideId: string
): Promise<Slide | null> {
  const data = await load();
  const carousel = data.carousels.find((c) => c.id === carouselId);
  if (!carousel) return null;
  const slide = carousel.slides.find((s) => s.id === slideId);
  if (!slide || !slide.redoVersions || slide.redoVersions.length === 0) return null;

  // El HTML actual vuelve a la pila de deshacer antes de reponer el siguiente.
  slide.previousVersions.push(slide.html);
  if (slide.previousVersions.length > MAX_VERSIONS) slide.previousVersions.shift();

  const nextHtml = slide.redoVersions.pop()!;
  slide.html = nextHtml;
  carousel.updatedAt = now();
  await save(data);
  return slide;
}

// --- Reference images ---

export async function addReferenceImage(
  carouselId: string,
  image: ReferenceImage
): Promise<ReferenceImage | null> {
  const data = await load();
  const carousel = data.carousels.find((c) => c.id === carouselId);
  if (!carousel) return null;

  if (!carousel.referenceImages) carousel.referenceImages = [];
  carousel.referenceImages.push(image);
  carousel.updatedAt = now();
  await save(data);
  return image;
}

export async function removeReferenceImage(
  carouselId: string,
  imageId: string
): Promise<boolean> {
  const data = await load();
  const carousel = data.carousels.find((c) => c.id === carouselId);
  if (!carousel || !carousel.referenceImages) return false;

  const idx = carousel.referenceImages.findIndex((img) => img.id === imageId);
  if (idx === -1) return false;

  carousel.referenceImages.splice(idx, 1);
  carousel.updatedAt = now();
  await save(data);
  return true;
}
