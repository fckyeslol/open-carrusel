import { readDataSafe, updateData, writeData, SKIP_WRITE } from "./data";
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

/**
 * Deja el historial de deshacer en MAX_VERSIONS, saque lo que haya que sacar.
 *
 * Antes esto era `if (length > MAX) shift()`: UN elemento por push. Mientras MAX no
 * cambiara daba lo mismo, pero al bajarlo las pilas ya guardadas NO convergían nunca —
 * una de 30 subía a 31 con el push, el shift la devolvía a 30, y ahí se quedaba para
 * siempre. Es decir que bajar la constante no compactaba nada, y una compactación de
 * una vez se habría vuelto a llenar hasta 30. `splice` saca el excedente completo.
 */
function recortarHistorial(slide: Slide): void {
  const excedente = slide.previousVersions.length - MAX_VERSIONS;
  if (excedente > 0) slide.previousVersions.splice(0, excedente);
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
      recortarHistorial(slide);
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
    recortarHistorial(slide);

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

export interface CompactacionResultado {
  laminas: number;
  laminasRecortadas: number;
  versionesDescartadas: number;
  bytesAntes: number;
  bytesDespues: number;
  conservar: number;
  aplicado: boolean;
  respaldo: string | null;
}

/**
 * Recorta el historial de deshacer de TODAS las láminas guardadas.
 *
 * Por qué existe como operación aparte y no como script que edita el archivo: los datos
 * están vivos y la app escribe el store más de 1600 veces por día. Bajar el JSON,
 * editarlo y subirlo pisaría todo lo que se hubiera escrito en el medio. Acá la
 * compactación entra por `updateData`, o sea una sola pasada leer-modificar-escribir
 * dentro del mismo mutex que usa cualquier otra escritura: se serializa con ellas y la
 * escritura es atómica.
 *
 * `conservar` no usa MAX_VERSIONS por defecto a propósito: quien compacta decide cuánto
 * corta, y así el número queda en el registro de la corrida en vez de depender de qué
 * valor tenía la constante ese día.
 *
 * Con `aplicar: false` (el default) no escribe nada: mide y devuelve. `SKIP_WRITE`
 * garantiza que ni siquiera se toque el archivo.
 */
export async function compactarHistorial(
  conservar: number,
  aplicar = false
): Promise<CompactacionResultado> {
  if (!Number.isInteger(conservar) || conservar < 0) {
    throw new Error(`conservar debe ser un entero >= 0, recibí ${conservar}`);
  }

  /*
   * Con la MISMA indentación que usa `atomicWrite`, o el informe miente: medido compacto
   * daba 15.5 MB para un archivo que en disco queda en 16.1 MB, y ese número es lo único
   * con lo que se decide si vale la pena compactar.
   */
  const pesar = (v: unknown) => Buffer.byteLength(JSON.stringify(v, null, 2), "utf-8");
  let resultado: CompactacionResultado | null = null;

  /*
   * Respaldo antes de tocar nada, con el mismo nombre que ya usa el bucket
   * (`carousels.pre-restore-2026-07-27.json`). El historial descartado no se puede
   * reconstruir de ninguna otra parte, así que esto es la única vuelta atrás.
   *
   * Queda una ventana de milisegundos entre el respaldo y la compactación en la que
   * podría entrar otra escritura, porque son dos tomas del mutex y no una. Es inofensivo:
   * el respaldo sale apenas viejo, y la compactación en sí sigue siendo atómica.
   */
  let respaldo: string | null = null;
  if (aplicar) {
    respaldo = `carousels.pre-compact-${now().slice(0, 10)}.json`;
    await writeData(respaldo, await readDataSafe<CarouselsData>(FILE, EMPTY));
  }

  await updateData<CarouselsData>(FILE, EMPTY, (data) => {
    const bytesAntes = pesar(data);
    let laminas = 0;
    let laminasRecortadas = 0;
    let versionesDescartadas = 0;

    // Se cuenta sobre una proyección y no mutando `data`, así el dry-run mide lo mismo
    // que escribiría el modo real sin haber tocado nada.
    const compactado: CarouselsData = {
      ...data,
      carousels: data.carousels.map((c) => ({
        ...c,
        slides: (c.slides ?? []).map((s) => {
          laminas++;
          const previas = s.previousVersions ?? [];
          const rehacer = s.redoVersions ?? [];
          // Cada pila por separado y con piso en 0: una lámina con 2 versiones y un
          // tope de 5 no descarta -3, descarta 0. Sumarlo crudo restaba de lo que
          // descartaba la otra pila y el informe salía por debajo de lo real.
          const sobran =
            Math.max(0, previas.length - conservar) +
            Math.max(0, rehacer.length - conservar);
          if (sobran > 0) {
            laminasRecortadas++;
            versionesDescartadas += sobran;
          }
          return {
            ...s,
            // OJO: slice(-0) devuelve el array ENTERO, no vacío.
            previousVersions: conservar === 0 ? [] : previas.slice(-conservar),
            redoVersions: conservar === 0 ? [] : rehacer.slice(-conservar),
          };
        }),
      })),
    };

    resultado = {
      laminas,
      laminasRecortadas,
      versionesDescartadas,
      bytesAntes,
      bytesDespues: pesar(compactado),
      conservar,
      aplicado: aplicar,
      respaldo,
    };

    return aplicar ? compactado : SKIP_WRITE;
  });

  if (!resultado) throw new Error("la compactación no pudo leer el store");
  return resultado;
}
