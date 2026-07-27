import { readDataSafe, updateData, SKIP_WRITE } from "./data";
import { generateId, now } from "./utils";
import type { Carousel, CarouselsData, Slide, AspectRatio, ReferenceImage } from "@/types/carousel";
import { MAX_SLIDES, MAX_VERSIONS } from "@/types/carousel";

const FILE = "carousels.json";

const EMPTY: CarouselsData = { carousels: [] };

/**
 * Lectura pura. Cae al store vacío si el archivo no se puede leer, y eso es
 * inofensivo PORQUE NO ESCRIBE: la próxima lectura se auto-cura.
 *
 * Ninguna mutación puede usar esto. Toda escritura va por `updateData`, que hace
 * leer→modificar→escribir dentro de un solo lock. Con el par `load()` + `save()`
 * que había antes, una lectura fallida (ESTALE/EIO del volumen GCS FUSE en Cloud
 * Run, o el archivo pillado a medio renombrar) devolvía `{ carousels: [] }` en
 * silencio y el `save()` siguiente persistía ese store VACÍO encima de los datos
 * vivos: se perdían todos los carruseles de golpe. `updateData` aborta la
 * escritura cuando la lectura falla por algo que no sea "el archivo no existe".
 */
async function load(): Promise<CarouselsData> {
  return readDataSafe<CarouselsData>(FILE, EMPTY);
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
  await updateData<CarouselsData>(FILE, EMPTY, (data) => {
    data.carousels.push(carousel);
    return data;
  });
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
  let updated: Carousel | null = null;
  await updateData<CarouselsData>(FILE, EMPTY, (data) => {
    const idx = data.carousels.findIndex((c) => c.id === id);
    if (idx === -1) return SKIP_WRITE;
    Object.assign(data.carousels[idx], updates, { updatedAt: now() });
    updated = data.carousels[idx];
    return data;
  });
  return updated;
}

export async function duplicateCarousel(id: string): Promise<Carousel | null> {
  let duplicate: Carousel | null = null;
  await updateData<CarouselsData>(FILE, EMPTY, (data) => {
    const source = data.carousels.find((c) => c.id === id);
    if (!source) return SKIP_WRITE;

    duplicate = {
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
    return data;
  });
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
  let sibling: Carousel | null = null;
  await updateData<CarouselsData>(FILE, EMPTY, (data) => {
    const source = data.carousels.find((c) => c.id === sourceId);
    if (!source) return SKIP_WRITE;

    sibling = {
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
    return data;
  });
  return sibling;
}

export async function deleteCarousel(id: string): Promise<boolean> {
  let deleted = false;
  await updateData<CarouselsData>(FILE, EMPTY, (data) => {
    const idx = data.carousels.findIndex((c) => c.id === id);
    if (idx === -1) return SKIP_WRITE;
    data.carousels.splice(idx, 1);
    deleted = true;
    return data;
  });
  return deleted;
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
  let slide: Slide | null = null;
  await updateData<CarouselsData>(FILE, EMPTY, (data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel) return SKIP_WRITE;
    if (carousel.slides.length >= MAX_SLIDES) return SKIP_WRITE;

    slide = {
      id: generateId(),
      html,
      previousVersions: [],
      order: carousel.slides.length,
      notes,
    };
    carousel.slides.push(slide);
    carousel.updatedAt = now();
    return data;
  });
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
  let copy: Slide | null = null;
  await updateData<CarouselsData>(FILE, EMPTY, (data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel) return SKIP_WRITE;
    if (carousel.slides.length >= MAX_SLIDES) return SKIP_WRITE;

    const idx = carousel.slides.findIndex((s) => s.id === slideId);
    if (idx === -1) return SKIP_WRITE;

    const source = carousel.slides[idx];
    copy = {
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
    return data;
  });
  return copy;
}

export async function updateSlide(
  carouselId: string,
  slideId: string,
  updates: Partial<Pick<Slide, "html" | "notes">>
): Promise<Slide | null> {
  let updated: Slide | null = null;
  await updateData<CarouselsData>(FILE, EMPTY, (data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel) return SKIP_WRITE;
    const slide = carousel.slides.find((s) => s.id === slideId);
    if (!slide) return SKIP_WRITE;

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
    updated = slide;
    return data;
  });
  return updated;
}

export async function deleteSlide(
  carouselId: string,
  slideId: string
): Promise<boolean> {
  let deleted = false;
  await updateData<CarouselsData>(FILE, EMPTY, (data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel) return SKIP_WRITE;
    const idx = carousel.slides.findIndex((s) => s.id === slideId);
    if (idx === -1) return SKIP_WRITE;

    carousel.slides.splice(idx, 1);
    // Re-order remaining slides
    carousel.slides.forEach((s, i) => {
      s.order = i;
    });
    carousel.updatedAt = now();
    deleted = true;
    return data;
  });
  return deleted;
}

export async function reorderSlides(
  carouselId: string,
  slideIds: string[]
): Promise<boolean> {
  let reorderedOk = false;
  await updateData<CarouselsData>(FILE, EMPTY, (data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel) return SKIP_WRITE;

    const slideMap = new Map(carousel.slides.map((s) => [s.id, s]));
    const reordered: Slide[] = [];
    for (const id of slideIds) {
      const slide = slideMap.get(id);
      if (!slide) return SKIP_WRITE;
      slide.order = reordered.length;
      reordered.push(slide);
    }
    carousel.slides = reordered;
    carousel.updatedAt = now();
    reorderedOk = true;
    return data;
  });
  return reorderedOk;
}

export async function undoSlide(
  carouselId: string,
  slideId: string
): Promise<Slide | null> {
  let updated: Slide | null = null;
  await updateData<CarouselsData>(FILE, EMPTY, (data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel) return SKIP_WRITE;
    const slide = carousel.slides.find((s) => s.id === slideId);
    if (!slide || slide.previousVersions.length === 0) return SKIP_WRITE;

    // El HTML actual se guarda en la pila de rehacer antes de retroceder.
    if (!slide.redoVersions) slide.redoVersions = [];
    slide.redoVersions.push(slide.html);
    if (slide.redoVersions.length > MAX_VERSIONS) slide.redoVersions.shift();

    const previousHtml = slide.previousVersions.pop()!;
    slide.html = previousHtml;
    carousel.updatedAt = now();
    updated = slide;
    return data;
  });
  return updated;
}

export async function redoSlide(
  carouselId: string,
  slideId: string
): Promise<Slide | null> {
  let updated: Slide | null = null;
  await updateData<CarouselsData>(FILE, EMPTY, (data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel) return SKIP_WRITE;
    const slide = carousel.slides.find((s) => s.id === slideId);
    if (!slide || !slide.redoVersions || slide.redoVersions.length === 0) return SKIP_WRITE;

    // El HTML actual vuelve a la pila de deshacer antes de reponer el siguiente.
    slide.previousVersions.push(slide.html);
    if (slide.previousVersions.length > MAX_VERSIONS) slide.previousVersions.shift();

    const nextHtml = slide.redoVersions.pop()!;
    slide.html = nextHtml;
    carousel.updatedAt = now();
    updated = slide;
    return data;
  });
  return updated;
}

// --- Reference images ---

export async function addReferenceImage(
  carouselId: string,
  image: ReferenceImage
): Promise<ReferenceImage | null> {
  let added: ReferenceImage | null = null;
  await updateData<CarouselsData>(FILE, EMPTY, (data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel) return SKIP_WRITE;

    if (!carousel.referenceImages) carousel.referenceImages = [];
    carousel.referenceImages.push(image);
    carousel.updatedAt = now();
    added = image;
    return data;
  });
  return added;
}

export async function removeReferenceImage(
  carouselId: string,
  imageId: string
): Promise<boolean> {
  let removed = false;
  await updateData<CarouselsData>(FILE, EMPTY, (data) => {
    const carousel = data.carousels.find((c) => c.id === carouselId);
    if (!carousel || !carousel.referenceImages) return SKIP_WRITE;

    const idx = carousel.referenceImages.findIndex((img) => img.id === imageId);
    if (idx === -1) return SKIP_WRITE;

    carousel.referenceImages.splice(idx, 1);
    carousel.updatedAt = now();
    removed = true;
    return data;
  });
  return removed;
}
